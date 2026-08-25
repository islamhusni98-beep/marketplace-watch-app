import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const SOURCES = [
  {
    name: 'Facebook Marketplace',
    url: process.env.MARKETPLACE_URL ||
      'https://www.facebook.com/marketplace/giza/vehicles?daysSinceListed=1&sortBy=creation_time_descend',
    type: 'facebook',
  },
  {
    name: 'Dubizzle',
    url: process.env.DUBIZZLE_URL || 'https://www.dubizzle.com.eg/vehicles/cars-for-sale/',
    type: 'dubizzle',
  },
  {
    name: 'Hatla2ee',
    url: process.env.HATLA2EE_URL || 'https://eg.hatla2ee.com/en/car/city/giza',
    type: 'hatla2ee',
  },
];

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const FB_COOKIES_JSON = process.env.FB_COOKIES_JSON || '';
const MAX_ITEMS = Number(process.env.MAX_ITEMS || 30);
const MIN_PRICE = Number(process.env.MIN_PRICE || 0);
const MAX_PRICE = Number(process.env.MAX_PRICE || 0);
const DRY_RUN = process.env.DRY_RUN === 'true';

if (!DRY_RUN && (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID)) {
  throw new Error('TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required');
}

const dataDir = path.resolve('data');
const seenPath = path.join(dataDir, 'seen.json');
await fs.mkdir(dataDir, { recursive: true });

let seen = new Set();
try {
  seen = new Set(JSON.parse(await fs.readFile(seenPath, 'utf8')));
} catch {
  seen = new Set();
}

function parsePrice(text = '') {
  const match = text.replace(/,/g, '').match(/(?:EGP|ج\.?م\.?)?\s*([0-9][0-9.]*)/i);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : null;
}

function cleanUrl(url = '') {
  return url.split('?')[0].split('#')[0];
}

function listingId(source, url = '') {
  const cleaned = cleanUrl(url);
  const fb = cleaned.match(/\/marketplace\/item\/(\d+)/)?.[1];
  const dubizzle = cleaned.match(/ID(\d+)/i)?.[1];
  const hatla2ee = cleaned.match(/\/(\d+)\/?$/)?.[1];
  return `${source}:${fb || dubizzle || hatla2ee || cleaned}`;
}

function isGiza(text = '') {
  return /giza|الجيزة|جيزة|haram|هرم|dokki|دقي|mohandessin|مهندسين|agouza|عجوزة|6 october|october|اكتوبر|zayed|زايد|faisal|فيصل|imbaba|امبابة/i.test(text);
}

function isWithin24Hours(text = '') {
  if (!text) return true;
  const t = text.toLowerCase();
  if (/just now|today|minute|min|hour|hr|yesterday|الآن|دقيقة|دقائق|ساعة|ساعات|أمس/.test(t)) return true;
  const dayMatch = t.match(/(\d+)\s*(?:day|days|يوم|أيام)/);
  return dayMatch ? Number(dayMatch[1]) <= 1 : true;
}

function passesFilters(item) {
  if (item.price !== null && MIN_PRICE && item.price < MIN_PRICE) return false;
  if (item.price !== null && MAX_PRICE && item.price > MAX_PRICE) return false;
  if (item.source !== 'Facebook Marketplace' && item.location && !isGiza(item.location)) return false;
  if (item.listedAgo && !isWithin24Hours(item.listedAgo)) return false;
  return true;
}

async function sendTelegram(item) {
  const text = [
    '🚗 إعلان سيارة جديد',
    `🌐 المصدر: ${item.source}`,
    '',
    `📌 ${item.title || 'بدون عنوان'}`,
    `💰 السعر: ${item.priceText || 'غير ظاهر'}`,
    `🕐 نازل من: ${item.listedAgo || 'غير ظاهر'}`,
    item.location ? `📍 المكان: ${item.location}` : '',
    `🔗 رابط الإعلان: ${item.url}`,
  ].filter(Boolean).join('\n');

  if (DRY_RUN) {
    console.log(text);
    return;
  }

  const endpoint = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: false }),
  });
  if (!response.ok) throw new Error(`Telegram send failed: ${response.status} ${await response.text()}`);
}

async function scrapeFacebook(context, source) {
  const page = await context.newPage();
  await page.goto(source.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(4_000);
  const login = await page.locator('input[name="email"], input[name="pass"]').first().isVisible().catch(() => false);
  if (login && !FB_COOKIES_JSON) {
    await page.close();
    throw new Error('Facebook requested login');
  }
  for (let i = 0; i < 3; i += 1) {
    await page.mouse.wheel(0, 1800);
    await page.waitForTimeout(900);
  }
  const data = await page.locator('a[href*="/marketplace/item/"]').evaluateAll((links) => {
    const out = [];
    const ago = /(?:listed\s*)?(?:just now|today|yesterday|\d+\s*(?:min|mins|minute|minutes|hr|hrs|hour|hours|day|days)\s*ago)/i;
    const used = new Set();
    for (const a of links) {
      if (!a.href || used.has(a.href)) continue;
      used.add(a.href);
      const txt = (a.innerText || a.parentElement?.innerText || '').trim();
      const lines = txt.split('\n').map(x => x.trim()).filter(Boolean);
      const priceText = lines.find(x => /EGP|ج\.م|[$€£]/i.test(x)) || '';
      const listedAgo = lines.find(x => ago.test(x)) || '';
      const title = lines.find(x => x !== priceText && x !== listedAgo) || lines[0] || 'Facebook listing';
      const location = lines.find(x => /giza|جيزة|cairo|القاهرة/i.test(x)) || '';
      out.push({ href: a.href, title, priceText, listedAgo, location });
    }
    return out;
  });
  await page.close();
  return data;
}

async function scrapeDubizzle(context, source) {
  const page = await context.newPage();
  await page.goto(source.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(4_000);
  for (let i = 0; i < 3; i += 1) {
    await page.mouse.wheel(0, 1800);
    await page.waitForTimeout(800);
  }
  const data = await page.locator('a[href*="/ad/"]').evaluateAll((links) => {
    const out = [];
    const used = new Set();
    for (const a of links) {
      const href = a.href;
      if (!href || used.has(href) || !/ID\d+\.html/i.test(href)) continue;
      used.add(href);
      let node = a;
      let txt = '';
      for (let i = 0; i < 6 && node; i += 1, node = node.parentElement) {
        const candidate = (node.innerText || '').trim();
        if (/EGP|ج\.م/i.test(candidate) && candidate.length < 1200) { txt = candidate; break; }
      }
      const lines = txt.split('\n').map(x => x.trim()).filter(Boolean);
      const priceText = lines.find(x => /EGP|ج\.م/i.test(x)) || '';
      const listedAgo = lines.find(x => /(?:minute|minutes|hour|hours|day|days|week|weeks|دقيقة|دقائق|ساعة|ساعات|يوم|أيام|أسبوع|أسابيع)\s*(?:ago|مضت|منذ)?/i.test(x)) || '';
      const location = lines.find(x => /giza|haram|dokki|mohandessin|agouza|october|zayed|faisal|imbaba|الجيزة|هرم|دقي|مهندسين|عجوزة|اكتوبر|زايد|فيصل|امبابة/i.test(x)) || '';
      const title = lines.find(x => x !== priceText && x !== listedAgo && x !== location && x.length > 3) || a.innerText || 'Dubizzle listing';
      out.push({ href, title, priceText, listedAgo, location });
    }
    return out;
  });
  await page.close();
  return data;
}

async function scrapeHatla2ee(context, source) {
  const page = await context.newPage();
  await page.goto(source.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(3_000);
  const data = await page.locator('a[href*="/en/car/"]').evaluateAll((links) => {
    const out = [];
    const used = new Set();
    for (const a of links) {
      const href = a.href;
      if (!href || used.has(href) || !/\/en\/car\/[^/]+\/[^/]+\/\d+\/?$/i.test(href)) continue;
      used.add(href);
      let node = a;
      let txt = '';
      for (let i = 0; i < 5 && node; i += 1, node = node.parentElement) {
        const candidate = (node.innerText || '').trim();
        if (/EGP/i.test(candidate) && candidate.length < 1000) { txt = candidate; break; }
      }
      const lines = txt.split('\n').map(x => x.trim()).filter(Boolean);
      const priceText = lines.find(x => /EGP/i.test(x)) || '';
      const location = lines.find(x => /giza|haram|dokki|mohandessin|agouza|october|zayed|faisal|imbaba/i.test(x)) || '';
      const title = lines.find(x => x !== priceText && x !== location && /[A-Za-z]/.test(x) && !/^view all/i.test(x)) || a.innerText || 'Hatla2ee listing';
      out.push({ href, title, priceText, listedAgo: '', location });
    }
    return out;
  });
  await page.close();
  return data;
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  locale: 'en-US',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
});

if (FB_COOKIES_JSON) {
  try { await context.addCookies(JSON.parse(FB_COOKIES_JSON)); }
  catch (error) { console.warn(`Invalid FB_COOKIES_JSON: ${error.message}`); }
}

let allItems = [];
for (const source of SOURCES) {
  try {
    let raw = [];
    if (source.type === 'facebook') raw = await scrapeFacebook(context, source);
    if (source.type === 'dubizzle') raw = await scrapeDubizzle(context, source);
    if (source.type === 'hatla2ee') raw = await scrapeHatla2ee(context, source);
    const items = raw.map(x => ({
      id: listingId(source.name, x.href),
      source: source.name,
      url: cleanUrl(x.href),
      title: x.title,
      priceText: x.priceText,
      price: parsePrice(x.priceText),
      listedAgo: x.listedAgo,
      location: x.location,
    })).filter(passesFilters).slice(0, MAX_ITEMS);
    console.log(`${source.name}: ${items.length} candidate listings`);
    allItems.push(...items);
  } catch (error) {
    console.warn(`${source.name} skipped: ${error.message}`);
  }
}

let sentCount = 0;
for (const item of allItems.reverse()) {
  if (seen.has(item.id)) continue;
  await sendTelegram(item);
  seen.add(item.id);
  sentCount += 1;
}

await fs.writeFile(seenPath, JSON.stringify([...seen].slice(-5000), null, 2));
console.log(`Total candidates ${allItems.length}; sent ${sentCount} new listings.`);
await browser.close();
