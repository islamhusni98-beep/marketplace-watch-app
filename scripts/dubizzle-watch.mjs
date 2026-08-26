import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const SEARCH_URL = process.env.DUBIZZLE_URL || 'https://www.dubizzle.com.eg/vehicles/cars-for-sale/';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const MAX_ITEMS = Number(process.env.MAX_ITEMS || 30);
if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) throw new Error('Telegram config missing');

const dataDir = path.resolve('data');
const seenPath = path.join(dataDir, 'seen-dubizzle.json');
await fs.mkdir(dataDir, { recursive: true });
let seen = new Set();
try { seen = new Set(JSON.parse(await fs.readFile(seenPath, 'utf8'))); } catch {}

function cleanUrl(url='') { return url.split('?')[0].split('#')[0]; }
function idFromUrl(url='') { return cleanUrl(url).match(/ID(\d+)\.html/i)?.[1] || cleanUrl(url); }
function isGiza(t='') { return /giza|الجيزة|جيزة|haram|هرم|dokki|دقي|mohandessin|مهندسين|agouza|عجوزة|6 october|october|اكتوبر|zayed|زايد|faisal|فيصل|imbaba|امبابة/i.test(t); }
function ageHours(text='') {
  const t = text.toLowerCase();
  if (/just now|today|الآن|اليوم/.test(t)) return 0;
  let m=t.match(/(\d+)\s*(?:min|mins|minute|minutes|دقيقة|دقائق)/); if(m) return Number(m[1])/60;
  m=t.match(/(\d+)\s*(?:hr|hrs|hour|hours|ساعة|ساعات)/); if(m) return Number(m[1]);
  if (/yesterday|أمس/.test(t)) return 24;
  m=t.match(/(\d+)\s*(?:day|days|يوم|أيام)/); if(m) return Number(m[1])*24;
  return null;
}
function heat(age){ if(age<8) return '🔥 HOT'; if(age<16) return '🟠 WARM'; return '🔵 COLD'; }
function looksNew(text=''){ return /brand new|new car|zero km|0 km|زيرو|جديدة|جديد/i.test(text); }

async function sendTelegram(item){
  const text=['🚗 إعلان سيارة مستعملة جديد',`⚡ التصنيف: ${heat(item.age)}`,'🌐 المصدر: Dubizzle','',`📌 ${item.title}`,`💰 السعر: ${item.priceText||'غير ظاهر'}`,`🕐 نازل من: ${item.listedAgo}`,item.location?`📍 المكان: ${item.location}`:'',`🔗 رابط الإعلان: ${item.url}`].filter(Boolean).join('\n');
  const r=await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:TELEGRAM_CHAT_ID,text,disable_web_page_preview:false})});
  if(!r.ok) throw new Error(`Telegram send failed: ${r.status} ${await r.text()}`);
}

const browser=await chromium.launch({headless:true});
const context=await browser.newContext({locale:'en-US',userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36'});
const page=await context.newPage();
await page.goto(SEARCH_URL,{waitUntil:'domcontentloaded',timeout:60000});
await page.waitForTimeout(3500);
for(let i=0;i<4;i++){await page.mouse.wheel(0,2200);await page.waitForTimeout(700)}
const raw=await page.locator('a[href*="/ad/"]').evaluateAll((links)=>{
  const out=[], used=new Set();
  const time=/(?:just now|today|yesterday|\d+\s*(?:min|mins|minute|minutes|hr|hrs|hour|hours|day|days)\s*ago|\d+\s*(?:دقيقة|دقائق|ساعة|ساعات|يوم|أيام)|الآن|اليوم|أمس)/i;
  for(const a of links){
    if(!a.href || !/ID\d+\.html/i.test(a.href)) continue;
    const href=a.href.split('?')[0].split('#')[0];
    const id=href.match(/ID(\d+)\.html/i)?.[1];
    if(!id || used.has(id)) continue;
    used.add(id);
    let node=a, txt='';
    for(let i=0;i<6&&node;i++,node=node.parentElement){const c=(node.innerText||'').trim(); if(c.length>5&&c.length<1500){txt=c; if(/EGP|ج\.م/i.test(c)) break;}}
    const lines=txt.split('\n').map(x=>x.trim()).filter(Boolean);
    const priceText=lines.find(x=>/EGP|ج\.م/i.test(x))||'';
    const listedAgo=lines.find(x=>time.test(x))||'';
    const location=lines.find(x=>/giza|haram|dokki|mohandessin|agouza|october|zayed|faisal|imbaba|الجيزة|هرم|دقي|مهندسين|عجوزة|اكتوبر|زايد|فيصل|امبابة/i.test(x))||'';
    const title=lines.find(x=>x!==priceText&&x!==listedAgo&&x!==location&&x.length>3)||a.innerText||'Dubizzle listing';
    out.push({id,href,title,priceText,listedAgo,location,rawText:txt});
  }
  return out;
});
await page.close();

let sent=0, accepted=0;
for(const x of raw.slice(0,MAX_ITEMS)){
  const key=`Dubizzle:${x.id}`;
  if(seen.has(key)) continue;
  const age=ageHours(x.listedAgo);
  if(age===null || age>24) continue;
  if(x.location && !isGiza(x.location)) continue;
  if(looksNew(`${x.title} ${x.rawText}`)) continue;
  accepted++;
  await sendTelegram({url:x.href,title:x.title,priceText:x.priceText,listedAgo:x.listedAgo,location:x.location,age});
  seen.add(key); sent++;
}
await fs.writeFile(seenPath,JSON.stringify([...seen].slice(-5000),null,2));
console.log(`Dubizzle: collected=${raw.length}, accepted=${accepted}, sent=${sent}`);
await browser.close();