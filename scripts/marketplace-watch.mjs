import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const MARKETPLACE_URL = process.env.MARKETPLACE_URL;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const FB_COOKIES_JSON = process.env.FB_COOKIES_JSON || '';
const MAX_ITEMS = Number(process.env.MAX_ITEMS || 30);
const MIN_PRICE = Number(process.env.MIN_PRICE || 0);
const MAX_PRICE = Number(process.env.MAX_PRICE || 0);
const INCLUDE_KEYWORDS = (process.env.INCLUDE_KEYWORDS || '')
  .split(',')
  .map((x) => x.trim().toLowerCase())
  .filter(Boolean);
const EXCLUDE_KEYWORDS = (process.env.EXCLUDE_KEYWORDS || '')
  .split(',')
  .map((x) => x.trim().toLowerCase())
  .filter(Boolean);
const DRY_RUN = process.env.DRY_RUN === 'true';

if (!MARKETPLACE_URL) throw new Error('MARKETPLACE_URL is required');
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
  const cleaned = text.replace(/[^0-9.,]/g, '').replace(/,/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function listingIdFromUrl(url = '') {
  const match = url.match(/\/marketplace\/item\/(\d+)/);
  return match?.[1] || url;
}

function passesFilters(item) {
  const haystack = `${item.title} ${item.location} ${item.priceText}`.toLowerCase();
  if (INCLUDE_KEYWORDS.length && !INCLUDE_KEYWORDS.some((k) => haystack.includes(k))) return false;
  if (EXCLUDE_KEYWORDS.some((k) => haystack.includes(k))) return false;
  if (item.price !== null && MIN_PRICE && item.price < MIN_PRICE) return false;
  if (item.price !== null && MAX_PRICE && item.price > MAX_PRICE) return false;
  return true;
}

async function sendTelegram(item) {
  const text = [
    '🚨 إعلان Marketplace جديد',
    '',
    `📌 ${item.title || 'بدون عنوان'}`,
    item.priceText ? `💰 ${item.priceText}` : '',
    item.location ? `📍 ${item.location}` : '',
    `🔗 ${item.url}`,
  ]
    .filter(Boolean)
    .join('\n');

  if (DRY_RUN) {
    console.log(text);
    return;
  }

  const endpoint = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      disable_web_page_preview: false,
    }),
  });

  if (!response.ok) {
    throw new Error(`Telegram send failed: ${response.status} ${await response.text()}`);
  }
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  locale: 'en-US',
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
});

if (FB_COOKIES_JSON) {
  try {
    const cookies = JSON.parse(FB_COOKIES_JSON);
    await context.addCookies(cookies);
  } catch (error) {
    throw new Error(`FB_COOKIES_JSON is invalid: ${error.message}`);
  }
}

const page = await context.newPage();
await page.goto(MARKETPLACE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
await page.waitForTimeout(5_000);

const loginDetected = await page
  .locator('input[name="email"], input[name="pass"]')
  .first()
  .isVisible()
  .catch(() => false);

if (loginDetected && !FB_COOKIES_JSON) {
  throw new Error('Facebook requested login. Add FB_COOKIES_JSON as a GitHub Actions secret.');
}

for (let i = 0; i < 4; i += 1) {
  await page.mouse.wheel(0, 1800);
  await page.waitForTimeout(1200);
}

const rawItems = await page.locator('a[href*="/marketplace/item/"]').evaluateAll((links) => {
  const unique = new Map();

  for (const link of links) {
    const href = link.href;
    if (!href || unique.has(href)) continue;

    const container = link.closest('div[role="main"] div') || link.parentElement;
    const text = (link.innerText || container?.innerText || '').trim();
    const lines = text
      .split('\n')
      .map((x) => x.trim())
      .filter(Boolean);

    const priceText = lines.find((line) => /[$€£]|EGP|ج\.م|ر\.س|AED|SAR|USD/i.test(line)) || '';
    const title = lines.find((line) => line !== priceText) || lines[0] || 'Facebook Marketplace listing';
    const location = lines.length > 2 ? lines.at(-1) : '';

    unique.set(href, { href, title, priceText, location });
  }

  return [...unique.values()];
});

const items = rawItems
  .map((x) => ({
    id: listingIdFromUrl(x.href),
    url: x.href.split('?')[0],
    title: x.title,
    priceText: x.priceText,
    price: parsePrice(x.priceText),
    location: x.location,
  }))
  .filter(passesFilters)
  .slice(0, MAX_ITEMS);

let sentCount = 0;
for (const item of items.reverse()) {
  if (seen.has(item.id)) continue;
  await sendTelegram(item);
  seen.add(item.id);
  sentCount += 1;
}

const compactSeen = [...seen].slice(-3000);
await fs.writeFile(seenPath, JSON.stringify(compactSeen, null, 2));

console.log(`Found ${items.length} filtered listings; sent ${sentCount} new listings.`);
await browser.close();
