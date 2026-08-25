import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const SEARCH_URL = process.env.HATLA2EE_URL || 'https://eg.hatla2ee.com/en/car/city/giza';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const MAX_ITEMS = Number(process.env.MAX_ITEMS || 30);

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) throw new Error('Telegram config missing');

const dataDir = path.resolve('data');
const seenPath = path.join(dataDir, 'seen.json');
await fs.mkdir(dataDir, { recursive: true });
let seen = new Set();
try { seen = new Set(JSON.parse(await fs.readFile(seenPath, 'utf8'))); } catch {}

const cairoToday = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit'
}).format(new Date());

function cleanUrl(url='') { return url.split('?')[0].split('#')[0]; }
function idFromUrl(url='') { return cleanUrl(url).match(/\/(\d+)\/?$/)?.[1] || cleanUrl(url); }
function isGiza(text='') { return /giza|sheikh zayed|zayed|6 october|october|haram|dokki|mohandessin|agouza|faisal|imbaba|pyramids gardens|hadayek october/i.test(text); }
function parsePrice(text='') { const m=text.replace(/,/g,'').match(/([0-9][0-9.]*)\s*EGP/i); return m ? Number(m[1]) : null; }

async function sendTelegram(item) {
  const text = [
    '🚗 إعلان سيارة مستعملة جديد',
    '🟣 التصنيف: TODAY (هتلاقي لا يعرض ساعة النشر)',
    '🌐 المصدر: Hatla2ee',
    '',
    `📌 ${item.title}`,
    `💰 السعر: ${item.priceText || 'غير ظاهر'}`,
    `📅 تاريخ النشر: ${item.postedOn}`,
    `📍 المكان: ${item.location}`,
    `🔗 رابط الإعلان: ${item.url}`,
  ].join('\n');
  const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST', headers: {'content-type':'application/json'},
    body: JSON.stringify({chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview:false})
  });
  if (!r.ok) throw new Error(`Telegram send failed: ${r.status} ${await r.text()}`);
}

const browser = await chromium.launch({headless:true});
const context = await browser.newContext({locale:'en-US', userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36'});
const search = await context.newPage();
await search.goto(SEARCH_URL, {waitUntil:'domcontentloaded', timeout:60000});
await search.waitForTimeout(3000);
for (let i=0;i<5;i++){ await search.mouse.wheel(0,2200); await search.waitForTimeout(700); }

const candidates = await search.locator('a[href*="/en/car/"]').evaluateAll((links) => {
  const out=[], seen=new Set();
  for (const a of links) {
    const href=a.href||'';
    if (!/\/en\/car\/[^/]+\/[^/]+\/\d+\/?(?:\?.*)?$/i.test(href)) continue;
    const clean=href.split('?')[0].split('#')[0];
    const id=clean.match(/\/(\d+)\/?$/)?.[1];
    if (!id || seen.has(id)) continue;
    seen.add(id); out.push({id, href:clean});
  }
  return out;
});
await search.close();

const unseen = candidates.filter(c => !seen.has(`Hatla2ee:${c.id}`)).slice(0, MAX_ITEMS);
console.log(`Hatla2ee: ${candidates.length} IDs collected; ${unseen.length} unseen to inspect`);

let sent=0, todayCount=0, usedCount=0;
for (const c of unseen) {
  const page = await context.newPage();
  try {
    await page.goto(c.href, {waitUntil:'domcontentloaded', timeout:60000});
    await page.waitForTimeout(1200);
    const body = (await page.locator('body').innerText().catch(()=>'')) || '';
    const title = (await page.locator('h1').first().innerText().catch(()=>'')) || 'Hatla2ee listing';
    const condition = body.match(/Condition\s*\n\s*([^\n]+)/i)?.[1]?.trim() || '';
    const postedOn = body.match(/Posted On\s*\n\s*(\d{4}-\d{2}-\d{2})/i)?.[1] || '';
    const location = body.match(/Location\s*\n\s*([^\n]+)/i)?.[1]?.trim() || '';
    const priceText = body.match(/[0-9][0-9,]*\s*EGP/i)?.[0] || '';
    if (!/^used$/i.test(condition)) continue;
    usedCount++;
    if (postedOn !== cairoToday) continue;
    todayCount++;
    if (!isGiza(location)) continue;
    const item={id:`Hatla2ee:${c.id}`,url:c.href,title,postedOn,location,priceText,price:parsePrice(priceText)};
    await sendTelegram(item);
    seen.add(item.id); sent++;
  } catch (e) {
    console.warn(`Hatla2ee ${c.id} skipped: ${e.message}`);
  } finally { await page.close(); }
}

await fs.writeFile(seenPath, JSON.stringify([...seen].slice(-5000), null, 2));
console.log(`Hatla2ee details: used=${usedCount}, postedToday=${todayCount}, sent=${sent}`);
await browser.close();
