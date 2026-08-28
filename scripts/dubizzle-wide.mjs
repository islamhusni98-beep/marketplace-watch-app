import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

// Final user-interest filter. Each target also has a Dubizzle search slug so
// we search the model directly instead of scanning only the first generic page.
const TARGETS=[
  {name:'Nissan Sunny',slug:'nissan-sunny',minYear:2016,re:/\bnissan\s+sunny\b|\bsunny\b|نيسان\s+صني|صني/i},
  {name:'Chevrolet Aveo',slug:'chevrolet-aveo',minYear:2016,re:/\bchevrolet\s+aveo\b|\baveo\b|شيفروليه\s+افيو|افيو/i},
  {name:'Chevrolet New Optra',slug:'chevrolet-optra',minYear:2016,re:/\bchevrolet\s+(?:new\s+)?optra\b|\b(?:new\s+)?optra\b|شيفروليه\s+(?:نيو\s+)?اوبترا|اوبترا/i},
  {name:'Hyundai Accent RB',slug:'hyundai-accent-rb',minYear:2016,re:/\bhyundai\s+accent\s*rb\b|\baccent\s*rb\b|هيونداي\s+اكسنت\s*rb|اكسنت\s*rb/i},
  {name:'BYD F3',slug:'byd-f3',minYear:2021,re:/\bbyd\s*f3\b|\bf3\b|بي\s*واي\s*دي\s*f3/i},
  {name:'Hyundai Elantra HD',slug:'hyundai-elantra-hd',minYear:2017,re:/\bhyundai\s+elantra\s*hd\b|\belantra\s*hd\b|هيونداي\s+النترا\s*hd|النترا\s*hd/i},
  {name:'Hyundai Verna',slug:'hyundai-verna',minYear:2016,re:/\bhyundai\s+verna\b|\bverna\b|هيونداي\s+فيرنا|فيرنا/i},
  {name:'Chevrolet Lanos',slug:'chevrolet-lanos',minYear:2016,re:/\bchevrolet\s+lanos\b|\blanos\b|شيفروليه\s+لانوس|لانوس/i},
  {name:'Chery Arrizo 5',slug:'chery-arrizo-5',minYear:2019,manualOnly:true,re:/\bchery\s+arrizo\s*5\b|\barrizo\s*5\b|شيري\s+اريزو\s*5|اريزو\s*5/i},
  {name:'Dayun Lanos',slug:'dayun-lanos',minYear:2016,re:/\bdayun\s+lanos\b|دايون\s+لانوس/i},
];

const AREAS=[['Giza','giza'],['Cairo','cairo']];
const SEARCHES=TARGETS.flatMap(target=>AREAS.map(([area,areaSlug])=>({
  area,
  target,
  url:`https://www.dubizzle.com.eg/en/vehicles/cars-for-sale/used/${areaSlug}/q-${target.slug}/`,
})));

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

function numericMileage(t=''){
  const s=String(t).replace(/,/g,'').trim();
  if(/\bnew\b|زيرو|جديد/i.test(s)) return 0;
  const m=s.match(/([\d.]+)/);
  return m?Number(m[1]):null;
}
function extractAgo(lines){
  return lines.find(x=>/(?:\d+\s*(?:minutes?|hours?|days?|mins?|hrs?)\s*ago|today|yesterday|منذ|اليوم|أمس|امس)/i.test(x))||'';
}
function valueAfterLabel(lines,re){
  const i=lines.findIndex(x=>re.test(x));
  return i>=0 ? (lines[i+1]||'') : '';
}
function extractLocation(lines,ago){
  const i=lines.indexOf(ago);
  if(i<1) return '';
  for(let j=i-1;j>=0&&j>=i-6;j--){
    const x=(lines[j]||'').trim();
    if(!x||/^[•·|]$/.test(x)) continue;
    if(/^(benzine|electric|natural gas|diesel|hybrid|automatic|manual|fuel type|transmission|kilometers|mileage|year|condition|used)$/i.test(x)) continue;
    return x;
  }
  return '';
}
function matchTarget(title,year,transmission,cardText,preferredTarget){
  const y=Number(year);
  const text=`${title||''} ${cardText||''}`;
  const ordered=preferredTarget?[preferredTarget,...TARGETS.filter(t=>t!==preferredTarget)]:TARGETS;
  for(const target of ordered){
    target.re.lastIndex=0;
    if(!target.re.test(text)) continue;
    if(!Number.isFinite(y)||y<target.minYear) return {ok:false,reason:'year',target};
    if(target.manualOnly&&!/\bmanual\b|مانيوال|يدوي/i.test(transmission||cardText||'')) return {ok:false,reason:'manual',target};
    return {ok:true,target};
  }
  return {ok:false,reason:'model',target:null};
}
async function send(i){
  const text=['🚗 إعلان سيارة مستعملة جديد',`🎯 السيارة: ${i.targetName}`,`⚡ التصنيف: ${heat(i.age)}`,'🌐 المصدر: Dubizzle','',`📌 ${i.title}`,i.year?`📅 السنة: ${i.year}`:'',i.km?`🛣️ الكيلومترات: ${i.km}`:'',i.transmission?`⚙️ الفتيس: ${i.transmission}`:'',`💰 السعر: ${i.price||'غير ظاهر'}`,`🕐 نازل من: ${i.ago}`,`📍 المكان: ${i.loc}`,'✅ التحقق: بحث مباشر للموديل + Used + القاهرة الكبرى + آخر 3 أيام',`🔗 رابط الإعلان: ${i.url}`].filter(Boolean).join('\n');
  const r=await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:CHAT,text,disable_web_page_preview:false})});
  if(!r.ok) throw new Error(`Telegram ${r.status}: ${await r.text()}`);
}

const browser=await chromium.launch({headless:true});
const ctx=await browser.newContext({locale:'en-US',timezoneId:'Africa/Cairo',viewport:{width:1920,height:1080},userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36'});
const candidates=new Map();
let searchPages=0,searchPagesWithCards=0;

for(const search of SEARCHES){
  const page=await ctx.newPage();
  try{
    await page.goto(search.url,{waitUntil:'domcontentloaded',timeout:60000});
    await page.waitForTimeout(1400);
    for(let i=0;i<5;i++){await page.mouse.wheel(0,2200);await page.waitForTimeout(220)}
    const listingCount=await page.locator('li[aria-label="Listing"]').count();
    const anchorCount=await page.locator('a[href^="/en/ad/"]').count();
    searchPages++;
    let found=[];
    if(listingCount>0){
      found=await page.locator('li[aria-label="Listing"]').evaluateAll((cards,max)=>{
        const out=[],ids=new Set();
        const labelValue=(card,labelRe)=>{
          const lines=(card.innerText||'').split('\n').map(x=>x.trim()).filter(Boolean);
          const i=lines.findIndex(x=>labelRe.test(x));
          return i>=0 ? (lines[i+1]||'') : '';
        };
        for(const card of cards){
          const a=card.querySelector('a[href^="/en/ad/"]')||card.querySelector('a[href*="/ad/"]');
          const href=a?.href||'';
          const id=href.match(/ID(\d+)\.html/i)?.[1];
          if(!id||ids.has(id)) continue;
          const title=card.querySelector('a[title]')?.getAttribute('title')||'';
          const price=card.querySelector('div[aria-label="Price"] span')?.textContent?.trim()||'';
          let year=card.querySelector('span[aria-label="Year"] span')?.textContent?.trim()||'';
          let mileage=card.querySelector('span[aria-label="Mileage"] span')?.textContent?.trim()||card.querySelector('[aria-label="Kilometers"] span')?.textContent?.trim()||'';
          if(!/^\d{4}$/.test(year)) year=labelValue(card,/^Year$/i);
          if(!/[\d]/.test(mileage)||/^(Kilometers|Mileage)$/i.test(mileage)) mileage=labelValue(card,/^(Kilometers|Mileage)$/i);
          const transmission=labelValue(card,/^Transmission$/i);
          const cardText=(card.innerText||'').trim();
          ids.add(id);
          out.push({id,url:href.split('?')[0].split('#')[0],title,price,year,mileage,transmission,cardText});
          if(out.length>=max) break;
        }
        return out;
      },MAX);
    } else if(anchorCount>0){
      found=await page.locator('a[href^="/en/ad/"]').evaluateAll((links,max)=>{
        const out=[],ids=new Set();
        for(const a of links){
          const href=a.href||'';
          const id=href.match(/ID(\d+)\.html/i)?.[1];
          if(!id||ids.has(id)) continue;
          let node=a,cardText='';
          for(let d=0;d<8&&node;d++,node=node.parentElement){
            const txt=(node.innerText||'').trim();
            if(/EGP/i.test(txt)&&/(?:ago|today|yesterday)/i.test(txt)){cardText=txt;break}
          }
          if(!cardText) continue;
          ids.add(id);
          out.push({id,url:href.split('?')[0].split('#')[0],title:a.getAttribute('title')||'',price:'',year:'',mileage:'',transmission:'',cardText});
          if(out.length>=max) break;
        }
        return out;
      },MAX);
    }
    if(found.length) searchPagesWithCards++;
    for(const c of found){
      const old=candidates.get(c.id);
      const enriched={...c,searchArea:search.area,searchTarget:search.target.name,preferredTarget:search.target};
      if(!old||(c.cardText||'').length>(old.cardText||'').length)candidates.set(c.id,enriched);
    }
    console.log(`Dubizzle search ${search.target.name} - ${search.area}: listingNodes=${listingCount}, cards=${found.length}, finalUrl=${page.url()}`);
  }catch(e){
    console.warn(`Dubizzle search ${search.target.name} - ${search.area}: ${e.message}`);
  }finally{await page.close()}
}

let sent=0,duplicates=0,parseRejected=0,usedRejected=0,ageMissing=0,olderThan72h=0,locationMissing=0,outsideGreaterCairo=0,targetRejected=0,targetYearRejected=0,targetManualRejected=0,targetMatched=0;
const matchSamples=[];
for(const c of candidates.values()){
  const key=`Dubizzle:${c.id}`;
  if(seen.has(key)){duplicates++;continue}
  const lines=(c.cardText||'').split('\n').map(x=>x.trim()).filter(Boolean);
  const title=c.title||lines.find(x=>/^[A-Za-z0-9].*[A-Za-z]/.test(x)&&!/EGP|Year|Kilometers|Mileage|Transmission|Fuel Type|ago|today|yesterday/i.test(x)&&!/^\d+$/.test(x))||'سيارة مستعملة';
  const price=c.price||lines.find(x=>/^EGP\s/i.test(x))||'';
  let year=c.year||'';
  if(!/^\d{4}$/.test(year)) year=valueAfterLabel(lines,/^Year$/i)||((c.cardText.match(/\b(?:19|20)\d{2}\b/)||[])[0]||'');
  let km=c.mileage||'';
  if(!/[\d]/.test(km)||/^(Kilometers|Mileage)$/i.test(km)) km=valueAfterLabel(lines,/^(Kilometers|Mileage)$/i);
  const transmission=c.transmission||valueAfterLabel(lines,/^Transmission$/i)||'';
  const kmNumber=numericMileage(km);
  const ago=extractAgo(lines);
  const age=ageHours(ago);
  const loc=extractLocation(lines,ago);

  if(!title||!price||!year||!km){parseRejected++;continue}
  if(kmNumber===null||kmNumber<=0){usedRejected++;continue}
  if(age===null){ageMissing++;continue}
  if(age>MAX_AGE_HOURS){olderThan72h++;continue}
  if(!loc){locationMissing++;continue}
  if(!isGreaterCairo(loc)){outsideGreaterCairo++;continue}

  const targetMatch=matchTarget(title,year,transmission,c.cardText,c.preferredTarget);
  if(!targetMatch.ok){
    if(targetMatch.reason==='year') targetYearRejected++;
    else if(targetMatch.reason==='manual') targetManualRejected++;
    else targetRejected++;
    continue;
  }
  targetMatched++;
  if(matchSamples.length<8) matchSamples.push({id:c.id,target:targetMatch.target.name,title,year,transmission,ago,loc,price});

  try{
    await send({url:c.url,title,price,year,km,transmission,ago,loc,age,targetName:targetMatch.target.name});
    seen.add(key);sent++;
  }catch(e){console.warn(`Dubizzle ${c.id}: ${e.message}`)}
}

await fs.writeFile(seenPath,JSON.stringify([...seen].slice(-5000),null,2));
console.log(`Dubizzle directSearch pages=${searchPages}/${SEARCHES.length}, pagesWithCards=${searchPagesWithCards}, collected=${candidates.size}, duplicates=${duplicates}, parseRejected=${parseRejected}, usedRejected=${usedRejected}, ageMissing=${ageMissing}, olderThan72h=${olderThan72h}, locationMissing=${locationMissing}, outsideGreaterCairo=${outsideGreaterCairo}, targetRejected=${targetRejected}, targetYearRejected=${targetYearRejected}, targetManualRejected=${targetManualRejected}, targetMatched=${targetMatched}, sent=${sent}`);
if(matchSamples.length) console.log(`Dubizzle matchSamples=${JSON.stringify(matchSamples)}`);
await browser.close();