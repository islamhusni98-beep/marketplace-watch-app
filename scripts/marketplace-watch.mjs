import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const SOURCES = [
  { name: 'Facebook Marketplace', url: process.env.MARKETPLACE_URL || 'https://www.facebook.com/marketplace/giza/vehicles?daysSinceListed=1&sortBy=creation_time_descend', type: 'facebook' },
  { name: 'Dubizzle', url: process.env.DUBIZZLE_URL || 'https://www.dubizzle.com.eg/vehicles/cars-for-sale/', type: 'dubizzle' },
  { name: 'Hatla2ee', url: process.env.HATLA2EE_URL || 'https://eg.hatla2ee.com/en/car/city/giza', type: 'hatla2ee' },
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
const dataDir = path.resolve('data'); const seenPath = path.join(dataDir, 'seen.json'); await fs.mkdir(dataDir,{recursive:true});
let seen=new Set(); try{seen=new Set(JSON.parse(await fs.readFile(seenPath,'utf8')))}catch{seen=new Set()}
function parsePrice(text=''){const m=text.replace(/,/g,'').match(/(?:EGP|ج\.?م\.?)?\s*([0-9][0-9.]*)/i);if(!m)return null;const n=Number(m[1]);return Number.isFinite(n)?n:null}
function cleanUrl(url=''){return url.split('?')[0].split('#')[0]}
function listingId(source,url=''){const c=cleanUrl(url);const fb=c.match(/\/marketplace\/item\/(\d+)/)?.[1];const d=c.match(/ID(\d+)/i)?.[1];const h=c.match(/\/(\d+)\/?$/)?.[1];return `${source}:${fb||d||h||c}`}
function isGiza(t=''){return /giza|الجيزة|جيزة|haram|هرم|dokki|دقي|mohandessin|مهندسين|agouza|عجوزة|6 october|october|اكتوبر|zayed|زايد|faisal|فيصل|imbaba|امبابة/i.test(t)}
function ageHours(text=''){if(!text)return null;const t=text.toLowerCase();if(/just now|الآن|today|اليوم/.test(t))return 0;let m=t.match(/(\d+)\s*(?:min|mins|minute|minutes|دقيقة|دقائق)/);if(m)return Number(m[1])/60;m=t.match(/(\d+)\s*(?:hr|hrs|hour|hours|ساعة|ساعات)/);if(m)return Number(m[1]);if(/yesterday|أمس/.test(t))return 24;m=t.match(/(\d+)\s*(?:day|days|يوم|أيام)/);if(m)return Number(m[1])*24;return null}
function heat(age){if(age===null)return null;if(age<8)return '🔥 HOT';if(age<16)return '🟠 WARM';if(age<=24)return '🔵 COLD';return null}
function looksNew(text=''){return /brand new|new car|zero km|0 km|زيرو|جديدة|جديد/i.test(text)}
function passesFilters(i){if(i.price!==null&&MIN_PRICE&&i.price<MIN_PRICE)return false;if(i.price!==null&&MAX_PRICE&&i.price>MAX_PRICE)return false;if(i.source!=='Facebook Marketplace'&&i.location&&!isGiza(i.location))return false;if(looksNew(`${i.title} ${i.rawText||''}`))return false;const a=ageHours(i.listedAgo);if(a===null||a>24)return false;i.ageHours=a;i.heat=heat(a);return true}
async function sendTelegram(i){const text=['🚗 إعلان سيارة مستعملة جديد',`⚡ التصنيف: ${i.heat}`,`🌐 المصدر: ${i.source}`,'',`📌 ${i.title||'بدون عنوان'}`,`💰 السعر: ${i.priceText||'غير ظاهر'}`,`🕐 نازل من: ${i.listedAgo}`,i.location?`📍 المكان: ${i.location}`:'',`🔗 رابط الإعلان: ${i.url}`].filter(Boolean).join('\n');if(DRY_RUN){console.log(text);return}const r=await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:TELEGRAM_CHAT_ID,text,disable_web_page_preview:false})});if(!r.ok)throw new Error(`Telegram send failed: ${r.status} ${await r.text()}`)}
async function scrapeGeneric(context,source){const p=await context.newPage();await p.goto(source.url,{waitUntil:'domcontentloaded',timeout:60000});await p.waitForTimeout(4000);for(let i=0;i<3;i++){await p.mouse.wheel(0,1800);await p.waitForTimeout(800)}let selector=source.type==='facebook'?'a[href*="/marketplace/item/"]':source.type==='dubizzle'?'a[href*="/ad/"]':'a[href*="/en/car/"]';const data=await p.locator(selector).evaluateAll((links,type)=>{const out=[],used=new Set();const time=/(?:just now|today|yesterday|\d+\s*(?:min|mins|minute|minutes|hr|hrs|hour|hours|day|days)\s*ago|\d+\s*(?:دقيقة|دقائق|ساعة|ساعات|يوم|أيام)|الآن|اليوم|أمس)/i;for(const a of links){if(!a.href||used.has(a.href))continue;if(type==='dubizzle'&&!/ID\d+\.html/i.test(a.href))continue;if(type==='hatla2ee'&&!/\/en\/car\/[^/]+\/[^/]+\/\d+\/?$/i.test(a.href))continue;used.add(a.href);let node=a,txt='';for(let i=0;i<6&&node;i++,node=node.parentElement){const c=(node.innerText||'').trim();if(c.length>5&&c.length<1500){txt=c;if(/EGP|ج\.م/i.test(c))break}}const lines=txt.split('\n').map(x=>x.trim()).filter(Boolean);const priceText=lines.find(x=>/EGP|ج\.م|[$€£]/i.test(x))||'';const listedAgo=lines.find(x=>time.test(x))||'';const location=lines.find(x=>/giza|haram|dokki|mohandessin|agouza|october|zayed|faisal|imbaba|الجيزة|هرم|دقي|مهندسين|عجوزة|اكتوبر|زايد|فيصل|امبابة/i.test(x))||'';const title=lines.find(x=>x!==priceText&&x!==listedAgo&&x!==location&&x.length>3)||a.innerText||`${type} listing`;out.push({href:a.href,title,priceText,listedAgo,location,rawText:txt})}return out},source.type);await p.close();return data}
const browser=await chromium.launch({headless:true});const context=await browser.newContext({locale:'en-US',userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36'});
if(HAS_FB_SESSION){
  await context.addCookies([
    {name:'c_user',value:FB_C_USER,domain:'.facebook.com',path:'/',httpOnly:false,secure:true,sameSite:'None'},
    {name:'xs',value:FB_XS,domain:'.facebook.com',path:'/',httpOnly:true,secure:true,sameSite:'None'},
  ]);
}
let allItems=[];for(const source of SOURCES){try{if(source.type==='facebook'){const p=await context.newPage();await p.goto(source.url,{waitUntil:'domcontentloaded',timeout:60000});await p.waitForTimeout(2500);const login=await p.locator('input[name="email"], input[name="pass"]').first().isVisible().catch(()=>false);await p.close();if(login)throw new Error(HAS_FB_SESSION?'Facebook session cookies were rejected or expired':'Facebook session secrets are missing')}const raw=await scrapeGeneric(context,source);const items=raw.map(x=>({id:listingId(source.name,x.href),source:source.name,url:cleanUrl(x.href),title:x.title,priceText:x.priceText,price:parsePrice(x.priceText),listedAgo:x.listedAgo,location:x.location,rawText:x.rawText})).filter(passesFilters).slice(0,MAX_ITEMS);console.log(`${source.name}: ${items.length} used <=24h candidate listings`);allItems.push(...items)}catch(e){console.warn(`${source.name} skipped: ${e.message}`)}}
allItems.sort((a,b)=>a.ageHours-b.ageHours);let sentCount=0;for(const item of allItems){if(seen.has(item.id))continue;await sendTelegram(item);seen.add(item.id);sentCount++}await fs.writeFile(seenPath,JSON.stringify([...seen].slice(-5000),null,2));console.log(`Total candidates ${allItems.length}; sent ${sentCount} new listings.`);await browser.close();