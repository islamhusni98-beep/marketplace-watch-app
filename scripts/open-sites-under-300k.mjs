import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  crossSourceFingerprint,
  latinDigits,
  parseMileageKm,
  parsePriceAmount,
} from './car-cross-source-dedupe.mjs';

const SOURCES = [
  {
    key: '3arabyat',
    label: 'عربيات',
    url: 'https://3arabyat.com/en/discover/latest',
    listingPath: /^\/en\/car\/[^/]+\/?$/i,
    detailPath: /^\/en\/car\/[^/]+\/?$/i,
    idPath: /^\/en\/car\/(?:.*?)(\d+)\/?$/i,
    assumedUsed: true,
  },
  {
    key: 'masrplace',
    label: 'مصر بلايس',
    url: 'https://masrplace.com/en/cars?sort=newest',
    listingPath: /^\/en\/cars\/\d+\/?$/i,
    detailPath: /^\/en\/cars\/\d+\/?$/i,
    idPath: /^\/en\/cars\/(\d+)\/?$/i,
    assumedUsed: false,
  },
];

const MAX_PRICE_EGP = 300000;
const MAX_AGE_MINUTES = 48 * 60;
const MAX_DETAILS_PER_SOURCE = Math.max(1, Number.parseInt(process.env.MAX_OPEN_DETAILS_PER_SOURCE || '3', 10));
const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT = process.env.TELEGRAM_CHAT_ID || '';
const PUBLISH = String(process.env.PUBLISH_TO_TELEGRAM || '').toLowerCase() === 'true';
const USER_AGENT = 'Mozilla/5.0 (compatible; MarketplaceWatchApp/1.0; public car listings)';
const MIN_REQUEST_INTERVAL_MS = 5000;
const ROBOTS_RECHECK_MS = 24 * 60 * 60 * 1000;
if (PUBLISH && (!TOKEN || !CHAT)) throw new Error('Telegram config missing for scheduled publishing');

const dataDir = path.resolve('data');
const statePath = path.join(dataDir, 'seen-open-sites-under-300k.json');
const hatlaSnapshotPath = path.join(dataDir, 'hatla2ee-current-fingerprints.json');
await fs.mkdir(dataDir, { recursive: true });

async function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new Error('Refusing to replace unreadable state file ' + path.basename(filePath) + ': ' + error.message);
  }
}

const savedState = await readJsonIfPresent(statePath);
const state = savedState && typeof savedState === 'object' && !Array.isArray(savedState)
  ? savedState
  : { version: 1, sources: {}, publishedFingerprints: [] };
state.version = 1;
state.sources = state.sources && typeof state.sources === 'object' ? state.sources : {};
const publishedFingerprints = new Set(Array.isArray(state.publishedFingerprints) ? state.publishedFingerprints : []);
const hatlaSnapshot = await readJsonIfPresent(hatlaSnapshotPath);
const hatlaFingerprints = new Set(Array.isArray(hatlaSnapshot?.fingerprints) ? hatlaSnapshot.fingerprints : []);
const crossSourceSeen = new Set([...publishedFingerprints, ...hatlaFingerprints]);

const browser = await chromium.launch({ headless: true });
const allowedOrigins = new Set(SOURCES.map(source => new URL(source.url).origin));
const context = await browser.newContext({
  userAgent: USER_AGENT,
  locale: 'en-US',
  timezoneId: 'Africa/Cairo',
});
await context.route('**/*', route => {
  const requestUrl = route.request().url();
  let origin = '';
  try { origin = new URL(requestUrl).origin; } catch {}
  if (!allowedOrigins.has(origin) || ['image', 'media', 'font'].includes(route.request().resourceType())) {
    return route.abort();
  }
  return route.continue();
});

let lastRequestAt = 0;
async function waitForRequestSlot(delayMs = MIN_REQUEST_INTERVAL_MS) {
  const wait = Math.max(delayMs, MIN_REQUEST_INTERVAL_MS) - (Date.now() - lastRequestAt);
  if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
  lastRequestAt = Date.now();
}

function normalText(value = '') {
  return latinDigits(value).toLowerCase()
    .replace(/[أإآ]/g, 'ا')
    .replace(/[ىي]/g, 'ي')
    .replace(/\s+/g, ' ')
    .trim();
}

function robotsPolicy(text, pathname, productToken = 'marketplacewatchapp') {
  const groups = [];
  let group = null;
  let hasRules = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split('#', 1)[0].trim();
    if (!line) continue;
    const match = line.match(/^(user-agent|allow|disallow|crawl-delay):\s*(.*)$/i);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = match[2].trim();
    if (key === 'user-agent') {
      if (!group || hasRules) {
        group = { agents: [], rules: [], crawlDelay: 0 };
        groups.push(group);
        hasRules = false;
      }
      group.agents.push(value.toLowerCase());
    } else if (group && key === 'crawl-delay') {
      group.crawlDelay = Math.max(group.crawlDelay, Number(value) || 0);
    } else if (group) {
      hasRules = true;
      if (value) group.rules.push({ allow: key === 'allow', path: value });
    }
  }
  const specific = groups.filter(item => item.agents.some(agent => agent !== '*' && productToken.includes(agent)));
  const applicable = specific.length ? specific : groups.filter(item => item.agents.includes('*'));
  const rules = applicable.flatMap(item => item.rules).filter(rule => {
    const prefix = rule.path.replace(/\*/g, '');
    return pathname.startsWith(prefix);
  });
  rules.sort((a, b) => b.path.length - a.path.length || Number(b.allow) - Number(a.allow));
  return {
    allowed: rules.length ? rules[0].allow : true,
    crawlDelayMs: Math.max(0, ...applicable.map(item => item.crawlDelay)) * 1000,
  };
}

function isChallenge(text = '') {
  return /captcha|verify you are human|access denied|unusual traffic|request blocked|robot check/i.test(text.slice(0, 6000));
}

class SourceBlockedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SourceBlockedError';
  }
}

async function fetchRobots(source, sourceState) {
  const checkedAt = Date.parse(sourceState.robotsCheckedAt || '');
  if (Number.isFinite(checkedAt) && Date.now() - checkedAt < ROBOTS_RECHECK_MS && sourceState.robotsAllowed !== undefined) {
    return { allowed: sourceState.robotsAllowed, crawlDelayMs: Number(sourceState.crawlDelayMs || 0) };
  }
  await waitForRequestSlot();
  const robotsUrl = new URL('/robots.txt', new URL(source.url).origin);
  const response = await fetch(robotsUrl, {
    headers: { 'user-agent': USER_AGENT },
    signal: AbortSignal.timeout(15000),
  });
  sourceState.robotsCheckedAt = new Date().toISOString();
  if (response.status === 403 || response.status === 429) {
    sourceState.paused = true;
    sourceState.pauseReason = 'robots_http_' + response.status;
    throw new SourceBlockedError('robots returned HTTP ' + response.status);
  }
  if (response.status !== 200) {
    sourceState.robotsAllowed = false;
    throw new Error('robots.txt could not be read (HTTP ' + response.status + '); skipping this source');
  }
  const policy = robotsPolicy(await response.text(), robotsUrl.pathname);
  sourceState.robotsAllowed = policy.allowed;
  sourceState.crawlDelayMs = policy.crawlDelayMs;
  if (!policy.allowed) {
    sourceState.paused = true;
    sourceState.pauseReason = 'robots_disallow';
    throw new SourceBlockedError('robots.txt disallows the listing path');
  }
  return policy;
}

async function gotoPage(page, url, delayMs) {
  await waitForRequestSlot(delayMs);
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(200);
  const body = await page.locator('body').innerText({ timeout: 8000 }).catch(() => '');
  if (response?.status() === 403 || response?.status() === 429 || isChallenge(body)) {
    throw new SourceBlockedError('listing request received HTTP ' + (response?.status() || 0) + ' or a challenge page');
  }
  return { response, body };
}

function extractListingId(source, href) {
  let pathname = '';
  try { pathname = new URL(href).pathname; } catch { return ''; }
  if (!source.listingPath.test(pathname)) return '';
  return pathname.match(source.idPath)?.[1] || '';
}

function findListingCards(source, links) {
  const out = [];
  const ids = new Set();
  for (const item of links) {
    const id = extractListingId(source, item.href);
    if (!id || ids.has(id)) continue;
    ids.add(id);
    out.push({ id, url: item.href.split('?')[0].split('#')[0], anchorText: item.anchorText || '', cardText: item.cardText || '' });
  }
  return out;
}

function extractAgeMinutes(text = '') {
  const normalized = latinDigits(text).toLowerCase();
  if (/just now|moments ago|now\b|منذ قليل|حالاً|الآن/.test(normalized)) return 0;
  const match = normalized.match(/(\d+)\s*(minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w|دقيقة|دقائق|دقيقه|دقايق|ساعة|ساعات|يوم|أيام|ايام)\s*(?:ago)?/i);
  if (!match) return null;
  const count = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (/^m$|min|دقيق/.test(unit)) return count;
  if (/^h$|hr|hour|ساع/.test(unit)) return count * 60;
  if (/^d$|day|يوم|ايام|أيام/.test(unit)) return count * 24 * 60;
  if (/^w$|week/.test(unit)) return count * 7 * 24 * 60;
  return null;
}

function parseCard(source, card) {
  const text = [card.anchorText, card.cardText].filter(Boolean).join('\n');
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const priceLine = text.match(/[0-9٠-٩][0-9٠-٩,٬.]*\s*(?:EGP|ج\.?م|جنيه(?:\s*مصري)?)/i)?.[0] || '';
  const priceAmount = parsePriceAmount(priceLine);
  const year = Number((latinDigits(text).match(/\b(?:19|20)\d{2}\b/) || [])[0] || 0) || null;
  const title = lines.find(line => /(?:19|20)\d{2}/.test(latinDigits(line)) && /[A-Za-zأ-ي]/.test(line)) ||
    lines.find(line => /[A-Za-zأ-ي]{3,}/.test(line) && !/\b(?:EGP|km|automatic|manual)\b/i.test(line)) ||
    card.anchorText || '';
  const ageMinutes = extractAgeMinutes(text);
  const ageText = text.match(/(?:\d+\s*(?:minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w)\s*ago|just now|moments ago|now|منذ\s*[\d٠-٩]+\s*(?:دقيقة|دقائق|ساعة|ساعات|يوم|أيام))/i)?.[0] || '';
  const mileageMatch =
    text.match(/(\d{1,3}(?:[,.]\d{3})?\s*k\s*km)/i) ||
    text.match(/(\d[\d,٬.]*\s*(?:km|kms|كم|كيلومتر))/i);
  const mileage = mileageMatch?.[1] || '';
  const transmission = (text.match(/\b(automatic|manual|a\/t|m\/t)\b/i) || [])[1] ||
    (text.match(/(اوتوماتيك|أوتوماتيك|مانيوال|يدوي)/i) || [])[1] || '';
  const cityLine = lines.map(line => line.replace(/(?:\d+\s*(?:minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w)\s*ago|just now|moments ago)\s*$/i, '').trim())
    .find(line => /\b(cairo|giza|alexandria|qalyubia|gharbia|monufia|dakahlia|sharqia|ismailia|beheira|damietta|suez|port said|faiyum|fayoum|asyut|minya|sohag|qena|aswan|matrouh|hurghada|sinai)\b/i.test(line) ||
      /القاهرة|الجيزة|الإسكندرية|الاسكندرية|القليوبية|الغربية|المنوفية|الدقهلية|الشرقية|الإسماعيلية|البحيرة|دمياط|السويس|بورسعيد|الفيوم|أسيوط|اسيوط|المنيا|سوهاج|قنا|أسوان|اسوان|مطروح|سيناء/.test(line)) || '';
  return {
    title: title.replace(/\s+/g, ' ').trim(),
    year,
    price: priceLine,
    priceAmount,
    mileage,
    transmission,
    city: cityLine,
    ageMinutes,
    ageText,
  };
}

function readField(lines, names) {
  const labels = new Set(names.map(name => normalText(name)));
  for (let i = 0; i < lines.length; i++) {
    if (!labels.has(normalText(lines[i]))) continue;
    for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
      const value = lines[j].trim();
      if (value && !/^(specifications|details|description|features|seller|phone|contact|whatsapp|call)$/i.test(value)) return value;
    }
  }
  return '';
}

function extractDescription(lines) {
  const index = lines.findIndex(line => /^description$/i.test(line));
  if (index < 0) return '';
  const stop = new Set(['details', 'specifications', 'features', 'similar cars', 'similar listings', 'contact seller', 'report this ad']);
  const content = [];
  for (let i = index + 1; i < lines.length; i++) {
    if (stop.has(lines[i].toLowerCase())) break;
    content.push(lines[i]);
  }
  return content.join('\n').trim();
}

function cleanSellerDescription(value = '') {
  const text = latinDigits(value)
    .replace(/(?:\+?20[\s().-]*|0020[\s().-]*)?0?1[0125][\s().-]*\d{3,4}[\s().-]*\d{4,5}/g, ' ')
    .replace(/\b01[0125]\d{8}\b/g, ' ')
    .replace(/\bhttps?:\/\/\S+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, 1200);
}

function parseDetail(source, card, body, heading) {
  const lines = body.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const title = String(heading || card.title).replace(/\s+/g, ' ').trim();
  const priceLine = (body.match(/[0-9٠-٩][0-9٠-٩,٬.]*\s*(?:EGP|ج\.?م|جنيه(?:\s*مصري)?)/i) || [])[0] || card.price;
  const yearValue = readField(lines, ['Year', 'السنة', 'الموديل']) || '';
  const year = Number((latinDigits(yearValue + ' ' + title).match(/\b(?:19|20)\d{2}\b/) || [])[0] || card.year || 0) || null;
  const mileageValue = readField(lines, ['Mileage', 'Kilometers', 'العداد', 'الكيلومترات', 'عدد الكيلومترات']) || card.mileage;
  const mileageKm = parseMileageKm(mileageValue, { assumeThousands: source.key === 'masrplace' });
  const transmission = readField(lines, ['Transmission', 'ناقل الحركة', 'الفتيس']) || card.transmission;
  const location = readField(lines, ['Location', 'Governorate', 'الموقع', 'المحافظة']) || card.city;
  const condition = readField(lines, ['Condition', 'الحالة']) || (source.assumedUsed ? 'Used' : '');
  const used = source.assumedUsed || /used|مستعمل/i.test(condition);
  const description = cleanSellerDescription(extractDescription(lines));
  const detailAge = extractAgeMinutes(body);
  const ageMinutes = card.ageMinutes ?? detailAge;
  const priceAmount = parsePriceAmount(priceLine);
  return {
    id: card.id,
    url: card.url,
    source: source.label,
    title,
    year,
    priceAmount,
    mileageKm,
    transmission: transmission.trim(),
    city: location.trim(),
    condition: used ? 'مستعملة' : condition,
    description,
    ageMinutes,
    ageText: card.ageText,
  };
}

function formatAge(minutes) {
  if (minutes < 60) return 'منذ أقل من ساعة';
  if (minutes < 24 * 60) return 'منذ ' + Math.floor(minutes / 60) + ' ساعة';
  return 'منذ يوم تقريباً';
}

function telegramText(item) {
  const lines = [
    '🚗 ' + item.title,
    '🌐 المصدر: ' + item.source,
    '💰 السعر المعلن: ' + new Intl.NumberFormat('en-US').format(item.priceAmount) + ' جنيه',
    '📅 تاريخ الإعلان: ' + formatAge(item.ageMinutes),
    '🛠️ الحالة: ' + item.condition,
  ];
  if (item.mileageKm) lines.push('🛣️ العداد: ' + new Intl.NumberFormat('en-US').format(item.mileageKm) + ' كم');
  if (item.transmission) lines.push('⚙️ الفتيس: ' + item.transmission);
  if (item.city) lines.push('📍 المكان: ' + item.city);
  if (item.description) lines.push('\n📝 وصف البائع:\n' + item.description);
  lines.push('\n🔗 رابط الإعلان الأصلي: ' + item.url);
  return lines.join('\n');
}

async function sendToTelegram(item) {
  const response = await fetch('https://api.telegram.org/bot' + TOKEN + '/sendMessage', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT, text: telegramText(item), disable_web_page_preview: false }),
  });
  let payload = null;
  try { payload = await response.json(); } catch {}
  if (response.status === 429) {
    const retryAfter = Number(payload?.parameters?.retry_after || 0);
    throw Object.assign(new Error('Telegram rate limited'), { retryable: true, retryAfter });
  }
  if (!response.ok || payload?.ok !== true) {
    const uncertain = response.status >= 500;
    throw Object.assign(new Error('Telegram delivery returned HTTP ' + response.status), { uncertain });
  }
}

async function deliver(item) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await sendToTelegram(item);
      return { sent: true, uncertain: false };
    } catch (error) {
      if (error?.uncertain) return { sent: false, uncertain: true };
      if (!error?.retryable || attempt === 2) throw error;
      await new Promise(resolve => setTimeout(resolve, (error.retryAfter + 1) * 1000));
    }
  }
  return { sent: false, uncertain: false };
}

let freshOnPage = 0;
let detailValid = 0;
let detailRejected = 0;
let sent = 0;
let baselineAdded = 0;
let alreadyKnown = 0;
let crossDuplicates = 0;
let staleOrOverBudget = 0;
let sourceErrors = 0;
let pausedSources = 0;
let blockedDuringRun = false;
const previewMode = !PUBLISH;

try {
  for (const source of SOURCES) {
    const sourceState = state.sources[source.key] && typeof state.sources[source.key] === 'object'
      ? state.sources[source.key]
      : { initialized: false, ids: [], paused: false };
    sourceState.ids = Array.isArray(sourceState.ids) ? sourceState.ids : [];
    const known = new Set(sourceState.ids);
    if (sourceState.paused) {
      pausedSources++;
      console.log(source.key + ' skipped: source remains paused (' + (sourceState.pauseReason || 'previous block') + ')');
      state.sources[source.key] = sourceState;
      continue;
    }

    let policy;
    try {
      policy = await fetchRobots(source, sourceState);
      if (!policy.allowed) throw new Error('robots.txt did not positively allow this path; skipping it');
    } catch (error) {
      sourceErrors++;
      if (error instanceof SourceBlockedError) {
        sourceState.paused = true;
        sourceState.pauseReason = error.message;
        pausedSources++;
        blockedDuringRun = true;
      }
      console.warn(source.key + ' skipped: ' + error.message);
      state.sources[source.key] = sourceState;
      continue;
    }

    let page;
    try {
      page = await context.newPage();
      const { response, body } = await gotoPage(page, source.url, policy.crawlDelayMs);
      const status = response?.status() || 0;
      if (status < 200 || status >= 400) throw new Error('listing page returned HTTP ' + status);
      const finalUrl = new URL(page.url());
      if (finalUrl.origin !== new URL(source.url).origin) throw new SourceBlockedError('listing page redirected off-site');
      const links = await page.locator('a[href]').evaluateAll((anchors, data) => {
        const rows = [];
        for (const anchor of anchors) {
          const href = anchor.href || '';
          let node = anchor;
          let cardText = '';
          for (let depth = 0; depth < 9 && node; depth++, node = node.parentElement) {
            const text = (node.innerText || '').trim();
            if (text.length > 30 && text.length < 1200 && /(?:19|20)\d{2}/.test(text) && /(?:EGP|ج\.?م|جنيه)/i.test(text)) {
              cardText = text;
              break;
            }
          }
          if (cardText) rows.push({ href, anchorText: (anchor.innerText || anchor.textContent || '').trim(), cardText });
        }
        return rows;
      });
      const cards = findListingCards(source, links);
      if (!cards.length) throw new Error('no matching public listing cards found; refusing to initialize source cache');
      const parsed = cards.map(card => ({ ...card, ...parseCard(source, card) }))
        .filter(card => card.priceAmount !== null && card.priceAmount <= MAX_PRICE_EGP && (card.ageMinutes === null || card.ageMinutes <= MAX_AGE_MINUTES));
      freshOnPage += parsed.filter(card => card.ageMinutes !== null && card.ageMinutes <= MAX_AGE_MINUTES).length;
      const sourceWasInitialized = Boolean(sourceState.initialized);

      if (!PUBLISH) {
        let checked = 0;
        for (const card of parsed) {
          if (known.has(card.id)) { alreadyKnown++; continue; }
          if (checked >= MAX_DETAILS_PER_SOURCE) break;
          checked++;
          const detailPage = await context.newPage();
          try {
            const detailResult = await gotoPage(detailPage, card.url, policy.crawlDelayMs);
            const detailHeading = await detailPage.locator('h1').first().innerText().catch(() => '');
            const item = parseDetail(source, card, detailResult.body, detailHeading);
            const missing = [];
            if (!item.used) missing.push('used');
            if (item.priceAmount === null || item.priceAmount > MAX_PRICE_EGP) missing.push('price');
            if (!item.year) missing.push('year');
            if (item.mileageKm === null) missing.push('mileage');
            if (!item.city) missing.push('city');
            if (item.ageMinutes === null || item.ageMinutes > MAX_AGE_MINUTES) missing.push('age');
            const complete = missing.length === 0;
            if (complete) detailValid++;
            else {
              detailRejected++;
              console.log(source.key + ' preview_detail_missing=' + missing.join(','));
            }
          } catch (error) {
            if (error instanceof SourceBlockedError) {
              sourceState.paused = true;
              sourceState.pauseReason = error.message;
              pausedSources++;
              blockedDuringRun = true;
              break;
            }
            detailRejected++;
          } finally {
            await detailPage.close();
          }
        }
        console.log(source.key + ' preview: status=' + status + ', cards=' + cards.length + ', under300k_recent=' + freshOnPage + ', detail_valid=' + detailValid + ', detail_rejected=' + detailRejected);
        sourceState.lastPreview = new Date().toISOString();
        state.sources[source.key] = sourceState;
        continue;
      }

      if (!sourceWasInitialized) {
        for (const card of parsed) {
          if (card.ageMinutes === null || card.ageMinutes > MAX_AGE_MINUTES) continue;
          known.add(card.id);
          baselineAdded++;
        }
        sourceState.initialized = true;
        sourceState.lastBaseline = new Date().toISOString();
        sourceState.ids = [...known].slice(-5000);
        state.sources[source.key] = sourceState;
        console.log(source.key + ' baseline: cards=' + cards.length + ', under300k_recent=' + parsed.length + ', cached=' + (sourceState.ids.length));
        continue;
      }

      let detailCount = 0;
      for (const card of parsed) {
        if (known.has(card.id)) { alreadyKnown++; continue; }
        if (card.ageMinutes !== null && card.ageMinutes > MAX_AGE_MINUTES) {
          known.add(card.id);
          staleOrOverBudget++;
          continue;
        }
        if (detailCount >= MAX_DETAILS_PER_SOURCE) continue;

        const listingFingerprint = crossSourceFingerprint({
          price: card.price,
          year: card.year,
          mileage: card.mileage,
          city: card.city,
        });
        if (listingFingerprint && crossSourceSeen.has(listingFingerprint)) {
          known.add(card.id);
          crossDuplicates++;
          continue;
        }

        detailCount++;
        const detailPage = await context.newPage();
        try {
          const detailResult = await gotoPage(detailPage, card.url, policy.crawlDelayMs);
          const detailHeading = await detailPage.locator('h1').first().innerText().catch(() => '');
          const item = parseDetail(source, card, detailResult.body, detailHeading);
          if (!item.used || item.priceAmount === null || item.priceAmount > MAX_PRICE_EGP) {
            known.add(card.id);
            staleOrOverBudget++;
            continue;
          }
          if (!item.year || item.mileageKm === null || !item.city || item.ageMinutes === null || item.ageMinutes > MAX_AGE_MINUTES) {
            detailRejected++;
            console.warn(source.key + ' detail missing a required field; leaving it unseen for retry');
            continue;
          }

          const fingerprint = crossSourceFingerprint({
            price: item.priceAmount,
            year: item.year,
            mileage: item.mileageKm,
            city: item.city,
          });
          if (fingerprint && crossSourceSeen.has(fingerprint)) {
            known.add(card.id);
            crossDuplicates++;
            continue;
          }

          detailValid++;
          const result = await deliver(item);
          if (result.sent) {
            sent++;
            known.add(card.id);
            if (fingerprint) {
              crossSourceSeen.add(fingerprint);
              publishedFingerprints.add(fingerprint);
            }
          } else if (result.uncertain) {
            known.add(card.id);
            console.warn(source.key + ' Telegram result uncertain; listing suppressed to prevent a duplicate');
          } else {
            console.warn(source.key + ' Telegram delivery failed; listing left unseen for retry');
          }
        } catch (error) {
          if (error instanceof SourceBlockedError) {
            sourceState.paused = true;
            sourceState.pauseReason = error.message;
            pausedSources++;
            console.warn(source.key + ' paused after access block; no more requests will be made to it');
            break;
          }
          detailRejected++;
          console.warn(source.key + ' detail read failed; leaving listing unseen for retry: ' + String(error?.message || error).slice(0, 160));
        } finally {
          await detailPage.close();
        }
      }

      sourceState.initialized = true;
      sourceState.ids = [...known].slice(-5000);
      sourceState.lastSuccessfulScan = new Date().toISOString();
      state.sources[source.key] = sourceState;
      console.log(source.key + ' scan: cards=' + cards.length + ', under300k_recent=' + parsed.length + ', already_seen=' + alreadyKnown + ', cross_duplicates=' + crossDuplicates + ', detail_valid=' + detailValid + ', sent=' + sent);
    } catch (error) {
      sourceErrors++;
      if (error instanceof SourceBlockedError) {
        sourceState.paused = true;
        sourceState.pauseReason = error.message;
        pausedSources++;
        blockedDuringRun = true;
        console.warn(source.key + ' paused after access block; no more requests will be made to it');
      } else {
        console.warn(source.key + ' scan failed; seen state left unchanged: ' + String(error?.message || error).slice(0, 180));
      }
      state.sources[source.key] = sourceState;
    } finally {
      if (page) await page.close();
    }
  }
} finally {
  await browser.close();
}

if (PUBLISH || blockedDuringRun) {
  state.publishedFingerprints = [...publishedFingerprints].slice(-5000);
  state.lastRun = new Date().toISOString();
  await fs.writeFile(statePath, JSON.stringify(state, null, 2));
}
console.log('Open sites mode=' + (PUBLISH ? 'publish' : 'preview') +
  ', fresh_on_page=' + freshOnPage +
  ', valid_details=' + detailValid +
  ', rejected_details=' + detailRejected +
  ', baseline_added=' + baselineAdded +
  ', already_known=' + alreadyKnown +
  ', cross_duplicates=' + crossDuplicates +
  ', stale_or_over_budget=' + staleOrOverBudget +
  ', sent=' + sent +
  ', source_errors=' + sourceErrors +
  ', paused_sources=' + pausedSources);
