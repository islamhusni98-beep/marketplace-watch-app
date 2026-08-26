import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const URL='https://www.dubizzle.com.eg/en/vehicles/cars-for-sale/giza/q-used-cars/';
const TOKEN=process.env.TELEGRAM_BOT_TOKEN, CHAT=process.env.TELEGRAM_CHAT_ID;
const MAX=Number(process.env.MAX_ITEMS||150);
if(!TOKEN||!CHAT) throw new Error('Telegram config missing');
const dir=path.resolve('data'), seenPath=path.join(dir,'seen-dubizzle.json'); await fs.mkdir(dir,{recursive:true});
let seen=new Set(); try{seen=new Set(JSON.parse(await fs.readFile(seenPath,'utf8')))}catch{}

const norm=s=>(s||'').toLowerCase().replace(/[\-_]/g,' ').replace(/\s+/g,' ').trim();
const isGiza=t=>/giza|الجيزة|جيزة|haram|هرم|dokki|دقي|mohandessin|مهندسين|agouza|عجوزة|6 october|october|اكتوبر|zayed|زايد|faisal|فيصل|imbaba|امبابة|hadayek|حدائق|sheikh zayed|الشيخ زايد|maryotaya|مريوطية|moneeb|منيب|warraq|وراق|boulaq dakrour|بولاق الدكرور|omraneyah|العمرانية/i.test(norm(t));
function ageHours(t=''){t=norm(t);if(/just now|today|الآن|الان|اليوم/.test(t))return 0;let m=t.match(/(\d+)\s*(?:min|mins|minute|minutes|دقيقة|دقائق)/);if(m)return +m[1]/60;m=t.match(/(\d+)\s*(?:hr|hrs|hour|hours|ساعة|ساعات)/);if(m)return +m[1];if(/yesterday|أمس|امس/.test(t))return 24;m=t.match(/(\d+)\s*(?:day|days|يوم|أيام|ايام)/);return m?+m[1]*24:null}
const heat=a=>a<8?'🔥 HOT':a<16?'🟠 WARM':'🔵 COLD';
const looksNew=t=>/brand new|new car|zero km|0 km|زيرو|جديدة|جديد/.test(norm(t));
async function send(i){const text=['🚗 إعلان سيارة مستعملة جديد',`⚡ التصنيف: ${heat(i.age)}`,'🌐 المصدر: Dubizzle','',`📌 ${i.title}`,`💰 السعر: ${i.price||'غير ظاهر'}`,`🕐 نازل من: ${i.ago}`,i.loc?`📍 المكان: ${i.loc}`:'',`🔗 رابط الإعلان: ${i.url}`].filter(Boolean).join('\n');const r=await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:CHAT,text,disable_web_page_preview:false})});if(!r.ok)throw new Error(`Telegram ${r.status}`)}

const browser=await chromium.launch({headless:true}); const ctx=await browser.newContext({locale:'ar-EG'}); const p=await ctx.newPage();
await p.goto(URL,{waitUntil:'domcontentloaded',timeout:60000}); await p.waitForTimeout(1500);
for(let i=0;i<8;i++){await p.mouse.wheel(0,2200);await p.waitForTimeout(250)}
const ads=await p.locator('a[href*="/ad/"]').evaluateAll((links,max)=>{const out=[],ids=new Set();for(const a of links){if(!/ID\d+\.html/i.test(a.href||''))continue;const url=a.href.split('?')[0],id=url.match(/ID(\d+)\.html/i)?.[1];if(!id||ids.has(id))continue;ids.add(id);let n=a,txt='';for(let i=0;i<7&&n;i++,n=n.parentElement){const c=(n.innerText||'').trim();if(c.length>5&&c.length<2400){txt=c;if(/EGP|ج\.م/i.test(c)&&/(ago|منذ|today|اليوم|yesterday|أمس|امس)/i.test(c))break}}out.push({id,url,txt});if(out.length>=max)break}return out},MAX);
await p.close();
let sent=0,dupe=0,ageMissing=0,old=0,outside=0,newCar=0;
for(const a of ads){const key=`Dubizzle:${a.id}`;if(seen.has(key)){dupe++;continue}const lines=a.txt.split('\n').map(x=>x.trim()).filter(Boolean),price=lines.find(x=>/EGP|ج\.م/i.test(x))||'',ago=lines.find(x=>/(ago|منذ|today|اليوم|yesterday|أمس|امس)/i.test(x))||'',loc=lines.find(isGiza)||'',title=lines.find(x=>x!==price&&x!==ago&&x!==loc&&x.length>3)||lines[0]||'سيارة مستعملة',age=ageHours(ago);if(age===null){ageMissing++;continue}if(age>24){old++;continue}if(!isGiza(a.txt)){outside++;continue}if(looksNew(a.txt)){newCar++;continue}await send({url:a.url,title,price,ago,loc,age});seen.add(key);sent++}
await fs.writeFile(seenPath,JSON.stringify([...seen].slice(-5000),null,2));
console.log(`Dubizzle total=${ads.length}, duplicates=${dupe}, ageMissing=${ageMissing}, olderThan24h=${old}, outsideGiza=${outside}, newRejected=${newCar}, sent=${sent}`); await browser.close();