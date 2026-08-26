import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const SEARCHES = [
  ['Nissan Sunny','https://www.dubizzle.com.eg/vehicles/cars-for-sale/used/q-nissan-sunny/'],
  ['Chevrolet Aveo','https://www.dubizzle.com.eg/vehicles/cars-for-sale/used/q-chevrolet-aveo/'],
  ['Chevrolet New Optra','https://www.dubizzle.com.eg/vehicles/cars-for-sale/used/q-chevrolet-optra/'],
  ['Hyundai Accent RB','https://www.dubizzle.com.eg/vehicles/cars-for-sale/used/q-hyundai-accent-rb/'],
  ['BYD F3','https://www.dubizzle.com.eg/vehicles/cars-for-sale/used/q-byd-f3/'],
  ['Hyundai Elantra HD','https://www.dubizzle.com.eg/vehicles/cars-for-sale/used/q-hyundai-elantra-hd/'],
  ['Hyundai Verna','https://www.dubizzle.com.eg/vehicles/cars-for-sale/used/q-hyundai-verna/'],
  ['Chevrolet Lanos','https://www.dubizzle.com.eg/vehicles/cars-for-sale/used/q-chevrolet-lanos/'],
  ['Chery Arrizo 5','https://www.dubizzle.com.eg/vehicles/cars-for-sale/used/q-chery-arrizo-5/'],
  ['Dayun Lanos','https://www.dubizzle.com.eg/vehicles/cars-for-sale/used/q-dayun-lanos/'],
];
const TELEGRAM_BOT_TOKEN=process.env.TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID=process.env.TELEGRAM_CHAT_ID;
const MAX_ITEMS=Number(process.env.MAX_ITEMS||60); if(!TELEGRAM_BOT_TOKEN||!TELEGRAM_CHAT_ID) throw new Error('Telegram config missing');
const dataDir=path.resolve('data'),seenPath=path.join(dataDir,'seen-dubizzle.json');await fs.mkdir(dataDir,{recursive:true});let seen=new Set();try{seen=new Set(JSON.parse(await fs.readFile(seenPath,'utf8')))}catch{}

function latinDigits(s=''){return s.replace(/[٠-٩]/g,d=>'٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/[۰-۹]/g,d=>'۰۱۲۳۴۵۶۷۸۹'.indexOf(d))}
function norm(s=''){return latinDigits(s).toLowerCase().replace(/[\-_]/g,' ').replace(/\s+/g,' ').trim()}
function targetCar(text=''){const t=norm(text),years=(t.match(/(?:19|20)\d{2}/g)||[]).map(Number),y=years.find(v=>v>=1990&&v<=2030);let name,min,max=2026,manual=false;
 if(/sunny|صني/.test(t)){name='Nissan Sunny';min=2016}
 else if(/aveo|افيو|أفيو/.test(t)){name='Chevrolet Aveo';min=2016}
 else if(/(?:new\s*)?optra|اوبترا|أوبترا/.test(t)){name='Chevrolet New Optra';min=2016}
 else if(/accent\s*rb|اكسنت\s*(?:ار\s*بي|آر\s*بي|rb)|أكسنت\s*(?:ار\s*بي|آر\s*بي|rb)/.test(t)){name='Hyundai Accent RB';min=2016}
 else if(/(?:\bbyd\b|بي\s*واي\s*دي|بى\s*واى\s*دى).*(?:\bf3\b|اف\s*3|إف\s*3)|(?:\bf3\b|اف\s*3|إف\s*3).*(?:\bbyd\b|بي\s*واي\s*دي|بى\s*واى\s*دى)/.test(t)){name='BYD F3';min=2021}
 else if(/elantra\s*hd|النترا\s*(?:اتش\s*دي|إتش\s*دي|hd)|إلنترا\s*(?:اتش\s*دي|إتش\s*دي|hd)/.test(t)){name='Hyundai Elantra HD';min=2017}
 else if(/verna|فيرنا/.test(t)){name='Hyundai Verna';min=2016}
 else if(/(?:dayun|دايون).*(?:lanos|لانوس)|(?:lanos|لانوس).*(?:dayun|دايون)/.test(t)){name='Dayun Lanos';min=2016}
 else if(/lanos|لانوس/.test(t)){name='Chevrolet Lanos';min=2016}
 else if(/arrizo\s*5|اريزو\s*(?:5|فايف)|أريزو\s*(?:5|فايف)/.test(t)){name='Chery Arrizo 5';min=2019;manual=true}
 if(!name||!y||y<min||y>max)return null;if(manual&&!/manual|man\.?|مانيوال|يدوي|عادي/.test(t))return null;return{name,year:y}}
function isGiza(t=''){return /giza|الجيزة|جيزة|haram|هرم|dokki|دقي|mohandessin|مهندسين|agouza|عجوزة|6 october|october|اكتوبر|أكتوبر|zayed|زايد|faisal|فيصل|imbaba|امبابة|إمبابة|hadayek october|حدائق اكتوبر|حدائق أكتوبر|sheikh zayed|الشيخ زايد/i.test(norm(t))}
function ageHours(text=''){const t=norm(text);if(/just now|today|الآن|الان|اليوم/.test(t))return 0;let m=t.match(/(\d+)\s*(?:min|mins|minute|minutes|دقيقة|دقائق)/);if(m)return +m[1]/60;m=t.match(/(\d+)\s*(?:hr|hrs|hour|hours|ساعة|ساعات)/);if(m)return +m[1];if(/yesterday|أمس|امس/.test(t))return 24;m=t.match(/(\d+)\s*(?:day|days|يوم|أيام|ايام)/);return m?+m[1]*24:null}
function heat(a){return a<8?'🔥 HOT':a<16?'🟠 WARM':'🔵 COLD'}
function looksNew(t=''){return /brand new|new car|zero km|0 km|زيرو|جديدة|جديد|الحالة\s*جديد/i.test(norm(t))}
async function sendTelegram(i){const text=['🚗 إعلان سيارة مستعملة جديد',`⚡ التصنيف: ${heat(i.age)}`,'🌐 المصدر: Dubizzle','',`🎯 ${i.target.name} ${i.target.year}`,`📌 ${i.title}`,`💰 السعر: ${i.priceText||'غير ظاهر'}`,`🕐 نازل من: ${i.listedAgo}`,i.location?`📍 المكان: ${i.location}`:'',`🔗 رابط الإعلان: ${i.url}`].filter(Boolean).join('\n');const r=await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:TELEGRAM_CHAT_ID,text,disable_web_page_preview:false})});if(!r.ok)throw new Error(`Telegram ${r.status}: ${await r.text()}`)}

const browser=await chromium.launch({headless:true}),context=await browser.newContext({locale:'ar-EG',userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36'});
const collected=new Map();
for(const [label,url] of SEARCHES){const page=await context.newPage();try{await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000});await page.waitForTimeout(1800);for(let i=0;i<3;i++){await page.mouse.wheel(0,1800);await page.waitForTimeout(350)}const raw=await page.locator('a[href*="/ad/"]').evaluateAll(links=>{const out=[],used=new Set();for(const a of links){if(!a.href||!/ID\d+\.html/i.test(a.href))continue;const href=a.href.split('?')[0].split('#')[0],id=href.match(/ID(\d+)\.html/i)?.[1];if(!id||used.has(id))continue;used.add(id);let node=a,txt='';for(let i=0;i<7&&node;i++,node=node.parentElement){const c=(node.innerText||'').trim();if(c.length>5&&c.length<2200){txt=c;if(/ج\.م|EGP/i.test(c)&&/(منذ|ago|today|اليوم)/i.test(c))break}}out.push({id,href,txt})}return out});for(const x of raw)if(!collected.has(x.id))collected.set(x.id,{...x,sourceSearch:label});console.log(`Dubizzle search ${label}: ${raw.length}`)}catch(e){console.warn(`Dubizzle search ${label} failed: ${e.message}`)}finally{await page.close()}}
let sent=0,targeted=0;for(const x of [...collected.values()].slice(0,MAX_ITEMS*SEARCHES.length)){const key=`Dubizzle:${x.id}`;if(seen.has(key))continue;const lines=x.txt.split('\n').map(s=>s.trim()).filter(Boolean),priceText=lines.find(s=>/ج\.م|EGP/i.test(s))||'',listedAgo=lines.find(s=>/(منذ|ago|today|اليوم|yesterday|أمس|امس)/i.test(s))||'',location=lines.find(isGiza)||'',title=lines.find(s=>/20[0-2]\d|٢٠[٠-٢][٠-٩]/.test(s)&&s!==listedAgo)||lines[0]||x.sourceSearch,target=targetCar(`${title}\n${x.txt}`);if(!target)continue;targeted++;const age=ageHours(listedAgo);if(age===null||age>24)continue;if(!isGiza(x.txt))continue;if(looksNew(x.txt))continue;await sendTelegram({url:x.href,title,priceText,listedAgo,location,age,target});seen.add(key);sent++}
await fs.writeFile(seenPath,JSON.stringify([...seen].slice(-5000),null,2));console.log(`Dubizzle total=${collected.size}, targetCars=${targeted}, sent=${sent}`);await browser.close();