import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const SEARCH_URLS=[
  ['Giza','https://www.dubizzle.com.eg/en/vehicles/cars-for-sale/giza/q-used-cars/'],
  ['Cairo','https://www.dubizzle.com.eg/en/vehicles/cars-for-sale/cairo/q-used-cars-for-sale/'],
];
const TOKEN=process.env.TELEGRAM_BOT_TOKEN;
const CHAT=process.env.TELEGRAM_CHAT_ID;
const MAX=Number(process.env.MAX_ITEMS||150);
const MAX_AGE_HOURS=72;
if(!TOKEN||!CHAT) throw new Error('Telegram config missing');

const dir=path.resolve('data');
const seenPath=path.join(dir,'seen-dubizzle.json');
await fs.mkdir(dir,{recursive:true});
let seen=new Set();
try{seen=new Set(JSON.parse(await fs.readFile(seenPath,'utf8')))}catch{}

const norm=s=>(s||'').toLowerCase().replace(/[\-_]/g,' ').replace(/\s+/g,' ').trim();
const isGreaterCairo=t=>/giza|الجيزة|جيزة|cairo|القاهرة|haram|هرم|dokki|دقي|mohandessin|مهندسين|agouza|عجوزة|6th? of october|6 october|october|اكتوبر|أكتوبر|zayed|زايد|faisal|فيصل|imbaba|امبابة|إمبابة|hadayek|حدائق|maryotaya|مريوطية|moneeb|منيب|warraq|وراق|boulaq|بولاق|omraneyah|العمرانية|nasr city|مدينة نصر|heliopolis|مصر الجديدة|maadi|المعادي|new cairo|القاهرة الجديدة|settlement|التجمع|tagamoa|mokattam|المقطم|shorouk|الشروق|badr|بدر|obour|العبور|ain shams|عين شمس|matariya|المطرية|shubra|شبرا|downtown|وسط|sayeda zeinab|السيدة زينب|zamalek|الزمالك|garden city|جاردن سيتي|madinaty|مدينتي|helwan|حلوان|sheraton|شيراتون/i.test(norm(t));
function ageHours(t=''){
  t=norm(t);
  if(/just now|moments ago|الآن|الان/.test(t)) return 0;
  let m=t.match(/(\d+)\s*(?:min|mins|minute|minutes|دقيقة|دقائق)/); if(m) return +m[1]/60;
  m=t.match(/(\d+)\s*(?:hr|hrs|hour|hours|ساعة|ساعات)/); if(m) return +m[1];
  if(/today|اليوم/.test(t)) return 0;
  if(/yesterday|أمس|امس/.test(t)) return 24;
  m=t.match(/(\d+)\s*(?:day|days|يوم|أيام|ايام)/); return m?+m[1]*24:null;
}
const heat=a=>a<8?'🔥 HOT':a<24?'🟠 WARM':'🔵 COLD';
function pickLine(lines,re){return lines.find(x=>re.test(x))||''}
function extractYear(text=''){return (text.match(/\b(?:19|20)\d{2}\b/)||[])[0]||''}
function extractKm(text=''){
  const lines=text.split('\n').map(x=>x.trim()).filter(Boolean);
  return pickLine(lines,/\b\d[\d,.]*\s*(?:km|kilometers?|كيلو|كم)\b/i)||'';
}
async function send(i){
  const text=['🚗 إعلان سيارة مستعملة جديد',`⚡ التصنيف: ${heat(i.age)}`,'🌐 المصدر: Dubizzle','',`📌 ${i.title}`,i.year?`📅 السنة: ${i.year}`:'',i.km?`🛣️ الكيلومترات: ${i.km}`:'',`💰 السعر: ${i.price||'غير ظاهر'}`,`🕐 نازل من: ${i.ago}`,`📍 المكان: ${i.loc}`,'✅ التحقق: نتائج بحث Dubizzle للمستعمل',`🔗 رابط الإعلان: ${i.url}`].filter(Boolean).join('\n');
  const r=await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:CHAT,text,disable_web_page_preview:false})});
  if(!r.ok) throw new Error(`Telegram ${r.status}: ${await r.text()}`);
}

const browser=await chromium.launch({headless:true});
const ctx=await browser.newContext({locale:'en-US',userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36'});
const candidates=new Map();
for(const [area,url] of SEARCH_URLS){
  const page=await ctx.newPage();
  try{
    await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000});
    await page.waitForTimeout(1500);
    for(let i=0;i<10;i++){await page.mouse.wheel(0,2200);await page.waitForTimeout(250)}
    const found=await page.locator('a').evaluateAll((links,max)=>{
      const out=[],ids=new Set();
      for(const a of links){
        const href=a.href||'';
        const m=href.match(/ID(\d+)\.html/i);
        if(!m||ids.has(m[1])) continue;
        const id=m[1],clean=href.split('?')[0].split('#')[0];
        let node=a,best=(a.innerText||'').trim();
        for(let depth=0;depth<9&&node?.parentElement;depth++){
          node=node.parentElement;
          const txt=(node.innerText||'').trim();
          if(txt.length>=best.length&&txt.length<=1800) best=txt;
          if(/EGP|ج\.م/i.test(txt)&&/(?:ago|today|yesterday|منذ|اليوم|أمس|امس)/i.test(txt)){best=txt;break}
        }
        if(!/EGP|ج\.م/i.test(best)) continue;
        ids.add(id);out.push({id,url:clean,cardText:best});
        if(out.length>=max) break;
      }
      return out;
    },MAX);
    for(const c of found){const old=candidates.get(c.id);if(!old||c.cardText.length>old.cardText.length)candidates.set(c.id,{...c,searchArea:area});}
    console.log(`Dubizzle ${area}: cards=${found.length}, finalUrl=${page.url()}`);
    if(found.length) console.log(`Dubizzle ${area} cardSample=${JSON.stringify(found.slice(0,2).map(x=>x.cardText.slice(0,500)))}`);
  }catch(e){console.warn(`Dubizzle ${area}: ${e.message}`)}finally{await page.close()}
}

let sent=0,duplicates=0,parseRejected=0,ageMissing=0,olderThan72h=0,locationMissing=0,outsideGreaterCairo=0;
const rejectSamples=[];
for(const c of candidates.values()){
  const key=`Dubizzle:${c.id}`;if(seen.has(key)){duplicates++;continue}
  const lines=c.cardText.split('\n').map(x=>x.trim()).filter(Boolean);
  const price=pickLine(lines,/EGP|ج\.م/i);
  const ago=pickLine(lines,/(?:\d+\s*(?:minutes?|hours?|days?|mins?|hrs?)\s*ago|today|yesterday|منذ|اليوم|أمس|امس)/i);
  const age=ageHours(ago);
  const year=extractYear(c.cardText);
  const km=extractKm(c.cardText);
  const title=lines.find(x=>x.length>5&&!/EGP|ج\.م|ago|today|yesterday|منذ|اليوم|أمس|امس/i.test(x)&&!/^\d+$/.test(x))||'سيارة مستعملة';
  const agoIndex=lines.indexOf(ago);
  const loc=agoIndex>0?lines[agoIndex-1]:pickLine(lines,/giza|cairo|haram|dokki|mohandessin|agouza|october|zayed|faisal|nasr city|heliopolis|maadi|new cairo|settlement|mokattam|shorouk|obour|madinaty|helwan|sheraton/i)||c.searchArea;
  if(!title||!price){parseRejected++;continue}
  if(age===null){ageMissing++;if(rejectSamples.length<5)rejectSamples.push({id:c.id,reason:'age',text:c.cardText.slice(0,350)});continue}
  if(age>MAX_AGE_HOURS){olderThan72h++;continue}
  if(!loc){locationMissing++;continue}
  if(!isGreaterCairo(loc)){outsideGreaterCairo++;continue}
  try{await send({url:c.url,title,price,year,km,ago,loc,age});seen.add(key);sent++}catch(e){console.warn(`Dubizzle ${c.id}: ${e.message}`)}
}
await fs.writeFile(seenPath,JSON.stringify([...seen].slice(-5000),null,2));
console.log(`Dubizzle collected=${candidates.size}, duplicates=${duplicates}, parseRejected=${parseRejected}, ageMissing=${ageMissing}, olderThan72h=${olderThan72h}, locationMissing=${locationMissing}, outsideGreaterCairo=${outsideGreaterCairo}, sent=${sent}`);
if(rejectSamples.length) console.log(`Dubizzle rejectSamples=${JSON.stringify(rejectSamples)}`);
await browser.close();