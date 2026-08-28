import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const SEARCH_URLS=[
  ['Giza','https://www.dubizzle.com.eg/en/vehicles/cars-for-sale/giza/'],
  ['Cairo','https://www.dubizzle.com.eg/en/vehicles/cars-for-sale/cairo/'],
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
const isGreaterCairo=t=>/giza|الجيزة|جيزة|cairo|القاهرة|haram|هرم|dokki|دقي|mohandessin|مهندسين|agouza|عجوزة|6 october|october|اكتوبر|أكتوبر|zayed|زايد|faisal|فيصل|imbaba|امبابة|إمبابة|hadayek october|حدائق اكتوبر|حدائق أكتوبر|sheikh zayed|الشيخ زايد|maryotaya|مريوطية|moneeb|منيب|warraq|وراق|boulaq dakrour|بولاق الدكرور|omraneyah|العمرانية|nasr city|مدينة نصر|heliopolis|مصر الجديدة|maadi|المعادي|new cairo|القاهرة الجديدة|fifth settlement|التجمع|tagamoa|mokattam|المقطم|shorouk|الشروق|badr|بدر|obour|العبور|ain shams|عين شمس|matariya|المطرية|shubra|شبرا|downtown|وسط البلد|sayeda zeinab|السيدة زينب|zamalek|الزمالك|garden city|جاردن سيتي/i.test(norm(t));

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
function fieldAfter(lines,label){
  const i=lines.findIndex(x=>new RegExp(`^${label}$`,'i').test(x));
  return i>=0?(lines[i+1]||''):'';
}
async function send(i){
  const text=['🚗 إعلان سيارة مستعملة جديد',`⚡ التصنيف: ${heat(i.age)}`,'🌐 المصدر: Dubizzle','',`📌 ${i.title}`,i.year?`📅 السنة: ${i.year}`:'',i.km?`🛣️ الكيلومترات: ${i.km}`:'',`💰 السعر: ${i.price||'غير ظاهر'}`,`🕐 نازل من: ${i.ago}`,`📍 المكان: ${i.loc}`,'✅ التحقق: فلتر Used الرسمي في Dubizzle',`🔗 رابط الإعلان: ${i.url}`].filter(Boolean).join('\n');
  const r=await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:CHAT,text,disable_web_page_preview:false})});
  if(!r.ok) throw new Error(`Telegram ${r.status}: ${await r.text()}`);
}

const browser=await chromium.launch({headless:true});
const ctx=await browser.newContext({locale:'en-US',userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36'});
const candidates=new Map();
let usedFilterApplied=0;

for(const [area,url] of SEARCH_URLS){
  const page=await ctx.newPage();
  try{
    await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000});
    await page.waitForTimeout(1200);

    const usedLink=page.getByText('Used',{exact:true}).last();
    if(await usedLink.count()){
      await Promise.all([
        page.waitForLoadState('domcontentloaded',{timeout:30000}).catch(()=>{}),
        usedLink.click({timeout:10000})
      ]);
      await page.waitForTimeout(1200);
      usedFilterApplied++;
    } else {
      console.warn(`Dubizzle ${area}: official Used filter not found; skipping area`);
      continue;
    }

    for(let i=0;i<10;i++){await page.mouse.wheel(0,2200);await page.waitForTimeout(250)}

    const found=await page.locator('a[href*="/ad/"]').evaluateAll((links,max)=>{
      const out=[],ids=new Set();
      for(const a of links){
        if(!/ID\d+\.html/i.test(a.href||'')) continue;
        const clean=a.href.split('?')[0].split('#')[0];
        const id=clean.match(/ID(\d+)\.html/i)?.[1];
        if(!id||ids.has(id)) continue;

        let node=a,cardText='';
        for(let depth=0;depth<10&&node;depth++,node=node.parentElement){
          const txt=(node.innerText||'').trim();
          if(/\bYear\b/i.test(txt)&&/\bKilometers\b/i.test(txt)&&/(?:ago|today|yesterday)/i.test(txt)&&/EGP/i.test(txt)){
            cardText=txt; break;
          }
        }
        if(!cardText) continue;
        ids.add(id);
        out.push({id,url:clean,cardText});
        if(out.length>=max) break;
      }
      return out;
    },MAX);

    for(const c of found){
      const old=candidates.get(c.id);
      if(!old||(c.cardText||'').length>(old.cardText||'').length) candidates.set(c.id,{...c,searchArea:area});
    }
    console.log(`Dubizzle ${area}: usedFilter=true, cards=${found.length}, finalUrl=${page.url()}`);
  }catch(e){
    console.warn(`Dubizzle ${area}: ${e.message}`);
  }finally{
    await page.close();
  }
}

let sent=0,duplicates=0,ageMissing=0,olderThan72h=0,locationMissing=0,outsideGreaterCairo=0,parseRejected=0;
const samples=[];
for(const c of candidates.values()){
  const key=`Dubizzle:${c.id}`;
  if(seen.has(key)){duplicates++;continue}

  const lines=c.cardText.split('\n').map(x=>x.trim()).filter(Boolean);
  const title=lines.find(x=>/\b(?:19|20)\d{2}\b/.test(x)&&!/^Year$/i.test(x))||lines.find(x=>x.length>6&&!/EGP|Year|Kilometers|Transmission|Fuel Type|ago|today|yesterday/i.test(x))||'سيارة مستعملة';
  const price=pickLine(lines,/EGP/i);
  const year=fieldAfter(lines,'Year')||((title.match(/\b(?:19|20)\d{2}\b/)||[])[0]||'');
  const km=fieldAfter(lines,'Kilometers');
  const ago=pickLine(lines,/(?:\d+\s*(?:minutes?|hours?|days?)\s*ago|today|yesterday)/i);
  const locIndex=lines.findIndex(x=>x===ago);
  const loc=locIndex>0?lines[locIndex-1]:pickLine(lines,/giza|cairo|haram|dokki|mohandessin|agouza|october|zayed|faisal|nasr city|heliopolis|maadi|new cairo|settlement|tagamoa|mokattam|shorouk|obour/i);
  const age=ageHours(ago);

  if(!year||!km||!title||!price){parseRejected++;continue}
  if(age===null){ageMissing++;continue}
  if(age>MAX_AGE_HOURS){olderThan72h++;continue}
  if(!loc){locationMissing++;continue}
  if(!isGreaterCairo(loc)){outsideGreaterCairo++;continue}

  try{
    await send({url:c.url,title,price,year,km,ago,loc,age});
    seen.add(key); sent++;
    if(samples.length<5) samples.push({id:c.id,title,year,km,ago,loc});
  }catch(e){
    console.warn(`Dubizzle ${c.id}: ${e.message}`);
  }
}

await fs.writeFile(seenPath,JSON.stringify([...seen].slice(-5000),null,2));
console.log(`Dubizzle usedFilterApplied=${usedFilterApplied}/${SEARCH_URLS.length}, collected=${candidates.size}, duplicates=${duplicates}, parseRejected=${parseRejected}, ageMissing=${ageMissing}, olderThan72h=${olderThan72h}, locationMissing=${locationMissing}, outsideGreaterCairo=${outsideGreaterCairo}, sent=${sent}`);
if(samples.length) console.log(`Dubizzle sentSamples=${JSON.stringify(samples)}`);
await browser.close();