import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const TARGETS = [
  ['Nissan Sunny','nissan/sunny',2016,false],
  ['Chevrolet Aveo','chevrolet/aveo',2016,false],
  ['Chevrolet New Optra','chevrolet/optra',2016,false],
  ['Hyundai Accent RB','hyundai/Accent-RB',2016,false],
  ['BYD F3','byd/f3',2021,false],
  ['Hyundai Elantra HD','hyundai/Elantra-HD',2017,false],
  ['Hyundai Verna','hyundai/verna',2016,false],
  ['Chevrolet Lanos','chevrolet/lanos2',2016,false],
  ['Chery Arrizo 5','chery/Arrizo-5',2019,true],
];
const AREAS=[['Giza','giza'],['Cairo','cairo']];
const SEARCHES=[];
for(const [label,slug,minYear,manualOnly] of TARGETS){
  for(const [area,citySlug] of AREAS){
    SEARCHES.push({label:`${label} - ${area}`,url:`https://eg.hatla2ee.com/en/car/city/${citySlug}/${slug}`,targetLabel:label,minYear,manualOnly,area});
  }
}

const TOKEN=process.env.TELEGRAM_BOT_TOKEN;
const CHAT=process.env.TELEGRAM_CHAT_ID;
const PER_SEARCH_LIMIT=60;
if(!TOKEN||!CHAT) throw new Error('Telegram config missing');

const dataDir=path.resolve('data');
const seenPath=path.join(dataDir,'seen-hatla2ee.json');
await fs.mkdir(dataDir,{recursive:true});
let seen=new Set();
try{seen=new Set(JSON.parse(await fs.readFile(seenPath,'utf8')))}catch{}

const fmt=new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Cairo',year:'numeric',month:'2-digit',day:'2-digit'});
const now=new Date();
const today=fmt.format(now);
const yesterday=fmt.format(new Date(now.getTime()-86400000));
const twoDaysAgo=fmt.format(new Date(now.getTime()-172800000));
const acceptedDates=new Set([today,yesterday,twoDaysAgo]);

function latinDigits(s=''){return String(s).replace(/[٠-٩]/g,d=>'٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/[۰-۹]/g,d=>'۰۱۲۳۴۵۶۷۸۹'.indexOf(d))}
function norm(s=''){return latinDigits(s).toLowerCase().replace(/[\-_]/g,' ').replace(/\s+/g,' ').trim()}
function extractYear(text=''){const ys=(latinDigits(text).match(/(?:19|20)\d{2}/g)||[]).map(Number);return ys.find(v=>v>=1990&&v<=2030)||null}
function isManual(text=''){return /\bmanual\b|man\.?|مانيوال|يدوي|عادي/i.test(norm(text))}
function normalizeDate(raw=''){
  const s=latinDigits(raw).trim();
  if(!s) return '';
  if(/today|اليوم/i.test(s)) return today;
  if(/yesterday|أمس|امس/i.test(s)) return yesterday;
  let m=s.match(/(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/);
  if(m) return `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
  m=s.match(/(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})/);
  if(m) return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  m=s.match(/(\d+)\s*days?\s*ago/i);
  if(m){const n=Number(m[1]); return fmt.format(new Date(now.getTime()-n*86400000));}
  return '';
}

async function send(i){
  const dayLabel=i.postedOn===today?'TODAY':i.postedOn===yesterday?'YESTERDAY':'2 DAYS AGO';
  const text=['🚗 إعلان سيارة مستعملة جديد',`🟣 التصنيف: ${dayLabel}`,'🌐 المصدر: Hatla2ee','',`🎯 ${i.target} ${i.year}`,`📌 ${i.title}`,`💰 السعر: ${i.price||'غير ظاهر'}`,i.mileage?`🛣️ الكيلومترات: ${i.mileage}`:'',`📅 تاريخ العرض: ${i.postedOn}`,`📍 المكان: ${i.city||i.area}`,'✅ التحقق: صفحة نتائج السيارات المستعملة + الموديل + السنة + آخر 3 أيام',`🔗 رابط الإعلان: ${i.url}`].filter(Boolean).join('\n');
  const r=await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:CHAT,text,disable_web_page_preview:false})});
  if(!r.ok) throw new Error(`Telegram ${r.status}: ${await r.text()}`);
}

const browser=await chromium.launch({headless:true});
const ctx=await browser.newContext({locale:'en-US',timezoneId:'Africa/Cairo',userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36'});
const candidates=new Map();
let pagesWithCards=0,searchErrors=0;
const cardSamples=[];

for(const search of SEARCHES){
  const page=await ctx.newPage();
  try{
    await page.goto(search.url,{waitUntil:'domcontentloaded',timeout:60000});
    await page.waitForTimeout(900);
    for(let i=0;i<5;i++){await page.mouse.wheel(0,2200);await page.waitForTimeout(180)}
    let found=await page.locator('div.newCarListUnit_contain').evaluateAll((cards,limit)=>{
      const out=[];
      for(const card of cards){
        const header=card.querySelector('div.newCarListUnit_header');
        const price=card.querySelector('div.main_price');
        const date=card.querySelector('div.otherData_Date span');
        const imgLink=card.querySelector('div.newMainImg a[href]')||card.querySelector('a[href*="/en/car/"]');
        const metas=[...card.querySelectorAll('span.newCarListUnit_metaLink')].map(x=>(x.textContent||'').trim()).filter(Boolean);
        const tags=[...card.querySelectorAll('span.newCarListUnit_metaTag')].map(x=>(x.textContent||'').trim()).filter(Boolean);
        const href=imgLink?.href||'';
        const id=href.match(/\/(\d+)\/?(?:\?.*)?$/)?.[1]||'';
        if(!id||!href) continue;
        out.push({id,href:href.split('?')[0].split('#')[0],title:(header?.textContent||'').trim(),price:(price?.textContent||'').trim(),dateText:(date?.textContent||'').trim(),metas,tags,cardText:(card.innerText||'').trim()});
        if(out.length>=limit) break;
      }
      return out;
    },PER_SEARCH_LIMIT);
    if(!found.length){
      // Fallback for layout variants: find listing links and walk up to the nearest result card.
      found=await page.locator('a[href*="/en/car/"]').evaluateAll((links,limit)=>{
        const out=[],ids=new Set();
        for(const a of links){
          const href=a.href||''; const id=href.match(/\/(\d+)\/?(?:\?.*)?$/)?.[1];
          if(!id||ids.has(id)) continue;
          let node=a,txt='';
          for(let d=0;d<7&&node;d++,node=node.parentElement){const t=(node.innerText||'').trim(); if(t.length>40){txt=t;break}}
          if(!txt) continue;
          ids.add(id); out.push({id,href:href.split('?')[0],title:(a.textContent||'').trim(),price:'',dateText:'',metas:[],tags:[],cardText:txt});
          if(out.length>=limit) break;
        }
        return out;
      },PER_SEARCH_LIMIT);
    }
    if(found.length) pagesWithCards++;
    for(const c of found){
      const enriched={...c,...search};
      const old=candidates.get(c.id);
      if(!old||(c.cardText||'').length>(old.cardText||'').length)candidates.set(c.id,enriched);
    }
    if(cardSamples.length<8&&found.length) cardSamples.push({search:search.label,...found[0]});
    console.log(`Hatla2ee cards ${search.label}: ${found.length}, finalUrl=${page.url()}`);
  }catch(e){searchErrors++;console.warn(`Hatla2ee search ${search.label}: ${e.message}`)}finally{await page.close()}
}

let sent=0,duplicates=0,wrongYear=0,dateMissing=0,dateRejected=0,manualRejected=0,accepted=0,modelRejected=0;
const matches=[],dateSamples=[];
for(const c of candidates.values()){
  const key=`Hatla2ee:${c.id}`;
  if(seen.has(key)){duplicates++;continue}
  const text=`${c.title}\n${c.cardText}\n${(c.metas||[]).join(' ')}`;
  const year=extractYear(c.title)||extractYear(c.cardText);
  if(!year||year<c.minYear||year>2026){wrongYear++;continue}
  // Model pages are the authoritative model filter. Extra title check catches obvious cross-model/sponsored cards.
  const titleNorm=norm(c.title||c.cardText);
  const targetTokens=norm(c.targetLabel).split(' ').filter(x=>x.length>1);
  if(targetTokens.length&&targetTokens.slice(-1).every(t=>!titleNorm.includes(t))){modelRejected++;continue}
  if(c.manualOnly&&!isManual(text)){manualRejected++;continue}
  const postedOn=normalizeDate(c.dateText);
  if(!postedOn){dateMissing++;if(dateSamples.length<8)dateSamples.push({id:c.id,target:c.targetLabel,dateText:c.dateText,title:c.title});continue}
  if(!acceptedDates.has(postedOn)){dateRejected++;if(dateSamples.length<8)dateSamples.push({id:c.id,target:c.targetLabel,dateText:c.dateText,postedOn,title:c.title});continue}
  accepted++;
  const city=(c.metas||[]).length?(c.metas||[])[(c.metas||[]).length-1]:c.area;
  const mileage=(c.tags||[]).find(x=>/km/i.test(x))||'';
  if(matches.length<12)matches.push({id:c.id,target:c.targetLabel,title:c.title,year,dateText:c.dateText,postedOn,city,price:c.price,mileage});
  await send({url:c.href,target:c.targetLabel,title:c.title||c.targetLabel,year,price:c.price,mileage,postedOn,city,area:c.area});
  seen.add(key); sent++;
}

await fs.writeFile(seenPath,JSON.stringify([...seen].slice(-5000),null,2));
console.log(`Hatla2ee cardOnly searches=${SEARCHES.length}, pagesWithCards=${pagesWithCards}, searchErrors=${searchErrors}, total=${candidates.size}, duplicates=${duplicates}, wrongYear=${wrongYear}, modelRejected=${modelRejected}, manualRejected=${manualRejected}, dateMissing=${dateMissing}, dateRejected=${dateRejected}, accepted=${accepted}, sent=${sent}`);
if(cardSamples.length) console.log(`Hatla2ee cardSamples=${JSON.stringify(cardSamples)}`);
if(dateSamples.length) console.log(`Hatla2ee dateSamples=${JSON.stringify(dateSamples)}`);
if(matches.length) console.log(`Hatla2ee matchSamples=${JSON.stringify(matches)}`);
await browser.close();