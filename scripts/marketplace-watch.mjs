import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const SOURCES = [
  { name: 'Facebook Marketplace', url: process.env.MARKETPLACE_URL || 'https://www.facebook.com/marketplace/giza/vehicles?daysSinceListed=1&sortBy=creation_time_descend', type: 'facebook' },
  { name: 'Dubizzle', url: process.env.DUBIZZLE_URL || 'https://www.dubizzle.com.eg/vehicles/cars-for-sale/', type: 'dubizzle' },
];

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const FB_C_USER = process.env.FB_C_USER || '';
const FB_XS = process.env.FB_XS || '';
const HAS_FB_SESSION = Boolean(FB_C_USER && FB_XS);
const MAX_ITEMS = Number(process.env.MAX_ITEMS || 30);
const MIN_PRICE = Number(process.env.MIN_PRICE || 0);
const MAX_PRICE = Number(process.env.MAX_PRICE || 0);
const DRY_RUN = process.env.DRY_RUN === 'true';

if (!DRY_RUN && (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID)) throw new Error('TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required');

const dataDir = path.resolve('data');
const seenPath = path.join(dataDir, 'seen.json');
await fs.mkdir(dataDir, { recursive: true });
let seen = new Set();
try { seen = new Set(JSON.parse(await fs.readFile(seenPath, 'utf8'))); } catch { seen = new Set(); }

function parsePrice(text='') {
  const m = text.replace(/,/g, '').match(/(?:EGP|ج\.?م\.?)?\s*([0-9][0-9.]*)/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}
function cleanUrl(url='') { return url.split('?')[0].split('#')[0]; }
function listingId(source,url='') {
  const c = cleanUrl(url);
  const fb = c.match(/\/marketplace\/item\/(\d+)/)?.[1];
  const d = c.match(/ID(\d+)/i)?.[1];
  return `${source}:${fb || d || c}`;
}
function isGiza(t='') { return /giza|الجيزة|جيزة|haram|هرم|dokki|دقي|mohandessin|مهندسين|agouza|عجوزة|6 october|october|اكتوبر|zayed|زايد|faisal|فيصل|imbaba|امبابة/i.test(t); }
function ageHours(text='') {
  if (!text) return null;
  const t = text.toLowerCase();
  if (/just now|today|الآن|اليوم/.test(t)) return 0;
  if (/\b(?:a|an|one)\s+minute\b/.test(t)) return 1/60;
  if (/\b(?:a|an|one)\s+hour\b/.test(t)) return 1;
  if (/\b(?:a|an|one)\s+day\b|yesterday|أمس/.test(t)) return 24;
  let m = t.match(/(\d+)\s*(?:min|mins|minute|minutes|دقيقة|دقائق)/); if (m) return Number(m[1]) / 60;
  m = t.match(/(\d+)\s*(?:hr|hrs|hour|hours|ساعة|ساعات)/); if (m) return Number(m[1]);
  m = t.match(/(\d+)\s*(?:day|days|يوم|أيام)/); if (m) return Number(m[1]) * 24;
  return null;
}
function heat(age) { if (age < 8) return '🔥 HOT'; if (age < 16) return '🟠 WARM'; return '🔵 COLD'; }
function looksNew(text='') { return /brand new|new car|zero km|0 km|زيرو|جديدة|سيارة جديدة/i.test(text); }
function rejectionReason(i) {
  if (i.price !== null && MIN_PRICE && i.price < MIN_PRICE) return 'below_min_price';
  if (i.price !== null && MAX_PRICE && i.price > MAX_PRICE) return 'above_max_price';
  if (i.location && !isGiza(i.location)) return 'outside_giza';
  if (looksNew(`${i.title} ${i.rawText || ''}`)) return 'looks_new_not_used';
  const a = ageHours(i.listedAgo);
  if (a === null) return 'age_not_found';
  if (a > 24) return 'older_than_24h';
  i.ageHours = a;
  i.heat = heat(a);
  return null;
}
function passesFilters(i) { return rejectionReason(i) === null; }

async function sendTelegram(i) {
  const text = [
    '🚗 إعلان سيارة مستعملة جديد',
    `⚡ التصنيف: ${i.heat}`,
    `🌐 المصدر: ${i.source}`,
    '',
    `📌 ${i.title || 'بدون عنوان'}`,
    `💰 السعر: ${i.priceText || 'غير ظاهر'}`,
    `🕐 نازل من: ${i.listedAgo}`,
    i.location ? `📍 المكان: ${i.location}` : '',
    `🔗 رابط الإعلان: ${i.url}`,
  ].filter(Boolean).join('\n');
  if (DRY_RUN) { console.log(text); return; }
  const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: false }),
  });
  if (!r.ok) throw new Error(`Telegram send failed: ${r.status} ${await r.text()}`);
}

async function collectFacebookCandidates(context, source) {
  const page = await context.newPage();
  await page.goto(source.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4000);
  const login = await page.locator('input[name="email"], input[name="pass"]').first().isVisible().catch(() => false);
  if (login) { await page.close(); throw new Error(HAS_FB_SESSION ? 'Facebook session cookies were rejected or expired' : 'Facebook session secrets are missing'); }
  for (let i = 0; i < 5; i++) { await page.mouse.wheel(0, 2200); await page.waitForTimeout(700); }
  const links = await page.locator('a[href*="/marketplace/item/"]').evaluateAll((els) => {
    const map = new Map();
    for (const a of els) {
      const href = a.href || '';
      const id = href.match(/\/marketplace\/item\/(\d+)/)?.[1];
      if (!id || map.has(id)) continue;
      map.set(id, { id, href: `https://www.facebook.com/marketplace/item/${id}/` });
    }
    return [...map.values()];
  });
  await page.close();
  return links;
}

async function readFacebookDetail(context, candidate) {
  const page = await context.newPage();
  await page.goto(candidate.href, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2200);
  const body = (await page.locator('body').innerText().catch(() => '')) || '';
  const lines = body.split('\n').map(x => x.trim()).filter(Boolean);
  const title = (await page.locator('h1').first().innerText().catch(() => '')) || lines.find(x => /\b\d{4}\b/.test(x)) || 'Facebook listing';
  const priceText = body.match(/(?:EGP|ج\.م)\s*[0-9][0-9,.]*/i)?.[0] || body.match(/[0-9][0-9,.]*\s*(?:EGP|ج\.م)/i)?.[0] || '';
  const listedLine = lines.find(x => /\bListed\b/i.test(x) && /ago|today|yesterday|just now/i.test(x)) || '';
  const timeOnly = body.match(/(?:about\s+)?(?:just now|today|yesterday|(?:a|an|one)\s+(?:minute|hour|day)\s+ago|\d+\s*(?:min|mins|minute|minutes|hr|hrs|hour|hours|day|days)\s*ago)/i)?.[0] || '';
  const listedAgo = listedLine || timeOnly;
  const location = listedLine.match(/\bin\s+(.+)$/i)?.[1]?.trim() || lines.find(x => isGiza(x)) || '';
  await page.close();
  return {
    id: `Facebook Marketplace:${candidate.id}`,
    source: 'Facebook Marketplace',
    url: candidate.href,
    title,
    priceText,
    price: parsePrice(priceText),
    listedAgo,
    location,
    rawText: body.slice(0, 5000),
  };
}

async function scrapeDubizzle(context, source) {
  const p = await context.newPage();
  await p.goto(source.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await p.waitForTimeout(4000);
  for (let i = 0; i < 3; i++) { await p.mouse.wheel(0, 1800); await p.waitForTimeout(800); }
  const data = await p.locator('a[href*="/ad/"]').evaluateAll((links) => {
    const out = [], used = new Set();
    const time = /(?:just now|today|yesterday|\d+\s*(?:min|mins|minute|minutes|hr|hrs|hour|hours|day|days)\s*ago)/i;
    for (const a of links) {
      if (!a.href || used.has(a.href) || !/ID\d+\.html/i.test(a.href)) continue;
      used.add(a.href);
      let node = a, txt = '';
      for (let i = 0; i < 6 && node; i++, node = node.parentElement) {
        const c = (node.innerText || '').trim();
        if (c.length > 5 && c.length < 1500) { txt = c; if (/EGP|ج\.م/i.test(c)) break; }
      }
      const lines = txt.split('\n').map(x => x.trim()).filter(Boolean);
      const priceText = lines.find(x => /EGP|ج\.م/i.test(x)) || '';
      const listedAgo = lines.find(x => time.test(x)) || '';
      const location = lines.find(x => /giza|haram|dokki|mohandessin|agouza|october|zayed|faisal|imbaba|الجيزة|هرم|دقي|مهندسين|عجوزة|اكتوبر|زايد|فيصل|امبابة/i.test(x)) || '';
      const title = lines.find(x => x !== priceText && x !== listedAgo && x !== location && x.length > 3) || a.innerText || 'Dubizzle listing';
      out.push({ href: a.href, title, priceText, listedAgo, location, rawText: txt });
    }
    return out;
  });
  await p.close();
  return data;
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ locale: 'en-US', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36' });
if (HAS_FB_SESSION) {
  await context.addCookies([
    { name: 'c_user', value: FB_C_USER, domain: '.facebook.com', path: '/', httpOnly: false, secure: true, sameSite: 'None' },
    { name: 'xs', value: FB_XS, domain: '.facebook.com', path: '/', httpOnly: true, secure: true, sameSite: 'None' },
  ]);
}

let allItems = [];
for (const source of SOURCES) {
  try {
    if (source.type === 'facebook') {
      const candidates = await collectFacebookCandidates(context, source);
      const uniqueUnseen = candidates.filter(c => !seen.has(`Facebook Marketplace:${c.id}`)).slice(0, MAX_ITEMS);
      console.log(`Facebook Marketplace: ${candidates.length} IDs collected; ${uniqueUnseen.length} unseen IDs to inspect`);
      const accepted = [];
      const rejected = {};
      let sampleCount = 0;
      for (const candidate of uniqueUnseen) {
        try {
          const item = await readFacebookDetail(context, candidate);
          const reason = rejectionReason(item);
          if (!reason) accepted.push(item);
          else {
            rejected[reason] = (rejected[reason] || 0) + 1;
            if (sampleCount < 8) {
              console.log(`FB reject ${candidate.id}: reason=${reason}; age="${item.listedAgo || 'NONE'}"; location="${item.location || 'NONE'}"; title="${item.title.slice(0,80)}"`);
              sampleCount++;
            }
          }
        } catch (e) { console.warn(`Facebook item ${candidate.id} skipped: ${e.message}`); }
      }
      console.log(`Facebook Marketplace rejection summary: ${JSON.stringify(rejected)}`);
      console.log(`Facebook Marketplace: ${accepted.length} accepted used <=24h listings`);
      allItems.push(...accepted);
      continue;
    }

    const raw = await scrapeDubizzle(context, source);
    const items = raw.map(x => ({
      id: listingId(source.name, x.href), source: source.name, url: cleanUrl(x.href), title: x.title,
      priceText: x.priceText, price: parsePrice(x.priceText), listedAgo: x.listedAgo, location: x.location, rawText: x.rawText,
    })).filter(passesFilters).slice(0, MAX_ITEMS);
    console.log(`${source.name}: ${items.length} used <=24h candidate listings`);
    allItems.push(...items);
  } catch (e) { console.warn(`${source.name} skipped: ${e.message}`); }
}

allItems.sort((a, b) => a.ageHours - b.ageHours);
let sentCount = 0;
for (const item of allItems) {
  if (seen.has(item.id)) continue;
  await sendTelegram(item);
  seen.add(item.id);
  sentCount++;
}
await fs.writeFile(seenPath, JSON.stringify([...seen].slice(-5000), null, 2));
console.log(`Total candidates ${allItems.length}; sent ${sentCount} new listings.`);
await browser.close();