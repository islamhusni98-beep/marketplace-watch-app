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
if(!TOKEN||!CHAT) throw new Error('Telegram config missing');

const dataDir=path.resolve('data');
const statePath=path.join(dataDir,'seen-hatla2ee.json');
await fs.mkdir(dataDir,{recursive:true});
let initialized=false;
let known=new Set();
let searchState={};
try{
  const raw=JSON.parse(await fs.readFile(statePath,'utf8'));
  if(Array.isArray(raw)) known=new Set(raw);
  else if(raw&&typeof raw==='object'){
    initialized=Boolean(raw.initialized);
    known=new Set(Array.isArray(raw.ids)?raw.ids:[]);
    searchState=raw.searchState&&typeof raw.searchState==='object'?raw.searchState:{};
  }
}catch{}

function latinDigits(s=''){return String(s).replace(/[٠-٩]/g,d=>'٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/[۰-۹]/g,d=>'۰۱۲۳۴۵۶۷۸۹'.indexOf(d))}
function norm(s=''){return latinDigits(s).toLowerCase().replace(/[\-_]/g,' ').replace(/\s+/g,' ').trim()}
function extractYear(text=''){const ys=(latinDigits(text).match(/(?:19|20)\d{2}/g)||[]).map(Number);return ys.find(v=>v>=1990&&v<=2030)||null}
function isManual(text=''){return /\bmanual\b|man\.?|مانيوال|يدوي|عادي/i.test(norm(text))}
const cairoFmt=new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Cairo',year:'numeric',month:'2-digit',day:'2-digit'});
const now=new Date();
const acceptedDates=new Set([0,1,2].map(days=>cairoFmt.format(new Date(now.getTime()-days*86400000))));
const isGreaterCairo=t=>/giza|الجيزة|جيزة|cairo|القاهرة|haram|هرم|dokki|دقي|mohandessin|مهندسين|agouza|عجوزة|6th? of october|6 october|october|اكتوبر|أكتوبر|zayed|زايد|faisal|فيصل|imbaba|امبابة|إمبابة|hadayek|حدائق|maryotaya|مريوطية|moneeb|منيب|warraq|وراق|boulaq|بولاق|omraneyah|العمرانية|nasr city|مدينة نصر|heliopolis|مصر الجديدة|maadi|المعادي|new cairo|القاهرة الجديدة|settlement|التجمع|tagamoa|mokattam|المقطم|shorouk|الشروق|badr|بدر|obour|العبور|ain shams|عين شمس|matariya|المطرية|shubra|شبرا|downtown|وسط|sayeda zeinab|السيدة زينب|zamalek|الزمالك|garden city|جاردن سيتي|madinaty|مدينتي|helwan|حلوان|sheraton|شيراتون|ramses|رمسيس|new nozha|النزهة/i.test(norm(t));
function extractCondition(title='',body=''){
  if(/^\s*Used\b/i.test(title)||/^\s*مستعمل\b/i.test(title)) return 'Used';
  if(/^\s*New\b/i.test(title)||/^\s*جديد\b/i.test(title)) return 'New';
  return body.match(/(?:^|\n)\s*(?:Condition|الحالة)\s*(?:\n|[:：-]\s*)\s*(Used|New|مستعمل|جديد)\b/im)?.[1]?.trim()||'';
}
function extractPostedOn(body=''){return body.match(/(?:Posted\s+On|تاريخ\s+النشر)\s*(?:\n|[:：-]\s*)\s*(\d{4}-\d{2}-\d{2})/i)?.[1]||''}
function extractLocation(body=''){return body.match(/(?:^|\n)\s*(?:Location|الموقع)\s*(?:\n|[:：-]\s*)\s*([^\n]+)/im)?.[1]?.trim()||''}
function extractTransmission(body=''){return body.match(/(?:^|\n)\s*(?:Transmission|ناقل الحركة|الفتيس)\s*(?:\n|[:：-]\s*)\s*([^\n]+)/im)?.[1]?.trim()||''}
function extractPrice(body=''){return body.match(/[0-9٠-٩][0-9٠-٩,٬.]*\s*(?:EGP|ج\.م)/i)?.[0]||''}
function parseCard(c,targetLabel,area){
  const lines=(c.cardText||'').split('\n').map(x=>x.trim()).filter(Boolean);
  const title=lines.find(x=>/(?:19|20)\d{2}/.test(x)&&/[A-Za-zأ-ي]/.test(x))||c.anchorText||targetLabel;
  const year=extractYear(title)||extractYear(c.cardText);
  const mileage=lines.find(x=>/\b[\d,.]+\s*KM\b/i.test(x))||'';
  const transmission=lines.find(x=>/^(Automatic|Manual|A\/T|M\/T|اوتوماتيك|أوتوماتيك|مانيوال|يدوي)$/i.test(x))||'';
  const price=lines.find(x=>/[\d,.]+\s*EGP$/i.test(x))||'';
  const city=lines.find(x=>/(Cairo|Giza|القاهرة|الجيزة|جيزة)/i.test(x))||area;
  return {title,year,mileage,transmission,price,city};
}
function fingerprint(target,p){return norm([target,p.title,p.year,p.mileage,p.transmission,p.price,p.city].join('|'))}
async function send(i){
  const text=['🚗 إعلان سيارة مستعملة جديد','🟣 التصنيف: NEWLY LISTED','🌐 المصدر: Hatla2ee','',`🎯 ${i.target} ${i.year}`,`📌 ${i.title}`,`💰 السعر: ${i.price}`,i.mileage?`🛣️ الكيلومترات: ${i.mileage}`:'',`⚙️ الفتيس: ${i.transmission}`,`📍 المكان: ${i.city}`,'✅ التحقق: مستعمل مؤكد + القاهرة الكبرى + آخر 3 أيام + بيانات أساسية كاملة',`🔗 رابط الإعلان: ${i.url}`].filter(Boolean).join('\n');
  const r=await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:CHAT,text,disable_web_page_preview:false})});
  if(!r.ok) throw new Error(`Telegram ${r.status}: ${await r.text()}`);
}

const browser=await chromium.launch({headless:true});
const ctx=await browser.newContext({locale:'en-US',timezoneId:'Africa/Cairo',userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36'});
const resultsBySearch=new Map();
let pagesVisited=0,pagesWithCards=0,searchErrors=0;
const pageSamples=[];

for(const search of SEARCHES){
  const page=await ctx.newPage();
  try{
    await page.goto(search.url,{waitUntil:'domcontentloaded',timeout:60000});
    await page.waitForTimeout(350);
    pagesVisited++;
    const found=await page.locator('a[href*="/en/car/"]').evaluateAll(links=>{
      const out=[],ids=new Set();
      for(const a of links){
        const href=a.href||'';const id=href.match(/\/(\d+)\/?(?:\?.*)?$/)?.[1];
        if(!id||ids.has(id))continue;
        let node=a,txt='';
        for(let d=0;d<8&&node;d++,node=node.parentElement){
          const t=(node.innerText||'').trim();
          if(t.length>60&&/(?:19|20)\d{2}/.test(t)&&/EGP/i.test(t)){txt=t;break}
        }
        if(!txt)continue;
        ids.add(id);
        out.push({id,url:href.split('?')[0].split('#')[0],anchorText:(a.textContent||'').trim(),cardText:txt});
      }
      return out;
    });
    const healthy=found.length>0;
    if(healthy)pagesWithCards++;
    console.log(`Hatla2ee ${search.label}: ${found.length}`);
    if(pageSamples.length<8&&found.length)pageSamples.push({search:search.label,...found[0]});
    resultsBySearch.set(search.label,{search,found,healthy});
  }catch(e){
    searchErrors++;
    console.warn(`Hatla2ee ${search.label}: ${e.message}`);
    resultsBySearch.set(search.label,{search,found:[],healthy:false});
  }finally{await page.close()}
}

let eligible=0,baselineAdded=0,sent=0,alreadyKnown=0,wrongYear=0,manualRejected=0,parseRejected=0,rebaselineSearches=0,suppressedDuplicates=0,detailRejected=0,dateRejected=0,outside=0,notUsed=0;
const matches=[];
const runFingerprints=new Set();
const nextSearchState={...searchState};

for(const {search,found,healthy} of resultsBySearch.values()){
  const prev=searchState[search.label]||{healthy:false,ids:[]};
  const prevHealthy=Boolean(prev.healthy);
  const prevIds=new Set(Array.isArray(prev.ids)?prev.ids:[]);
  const currentEligibleIds=[];

  if(!healthy){
    nextSearchState[search.label]={healthy:false,ids:[],lastRun:new Date().toISOString()};
    continue;
  }

  const parsed=[];
  for(const c of found){
    const p=parseCard(c,search.targetLabel,search.area);
    if(!p.year||p.year<search.minYear||p.year>2026){wrongYear++;continue}
    if(!p.price||!p.city){parseRejected++;continue}
    if(search.manualOnly&&!isManual(`${p.transmission}\n${c.cardText}`)){manualRejected++;continue}
    eligible++;
    const key=`Hatla2ee:${c.id}`;
    currentEligibleIds.push(key);
    parsed.push({c,p,key});
  }

  const canDiff=initialized&&prevHealthy;
  if(!canDiff) rebaselineSearches++;

  for(const {c,p,key} of parsed){
    const fp=fingerprint(search.targetLabel,p);
    if(runFingerprints.has(fp)){suppressedDuplicates++;known.add(key);continue}
    runFingerprints.add(fp);

    if(known.has(key)){alreadyKnown++;continue}

    if(canDiff&& !prevIds.has(key)){
      const detail=await ctx.newPage();
      try{
        await detail.goto(c.url,{waitUntil:'domcontentloaded',timeout:60000});
        await detail.waitForTimeout(400);
        const body=(await detail.locator('body').innerText().catch(()=>''))||'';
        const title=(await detail.locator('h1').first().innerText().catch(()=>''))||p.title;
        const condition=extractCondition(title,body);
        const postedOn=extractPostedOn(body);
        const city=extractLocation(body);
        const transmission=extractTransmission(body)||p.transmission;
        const price=extractPrice(body)||p.price;
        if(!condition||!/used|مستعمل/i.test(condition)){notUsed++;continue}
        if(!postedOn||!acceptedDates.has(postedOn)){dateRejected++;continue}
        if(!city||!isGreaterCairo(city)){outside++;continue}
        if(!price||!transmission||!title||!c.url){detailRejected++;continue}
        if(search.manualOnly&&!isManual(transmission)){manualRejected++;continue}
        await send({url:c.url,target:search.targetLabel,area:search.area,...p,title,city,transmission,price});
        sent++;
        if(matches.length<12)matches.push({id:c.id,target:search.targetLabel,title,year:p.year,price,city,transmission,postedOn});
      }catch(e){
        detailRejected++;
        console.warn(`Hatla2ee detail ${c.id}: ${e.message}`);
      }finally{await detail.close()}
    }else{
      baselineAdded++;
    }
    known.add(key);
  }

  nextSearchState[search.label]={healthy:true,ids:currentEligibleIds.slice(-500),lastRun:new Date().toISOString()};
}

const state={initialized:true,ids:[...known].slice(-15000),searchState:nextSearchState,lastRun:new Date().toISOString()};
await fs.writeFile(statePath,JSON.stringify(state,null,2));
console.log(`Hatla2ee baselineMode=${!initialized}, searches=${SEARCHES.length}, pagesVisited=${pagesVisited}, pagesWithCards=${pagesWithCards}, searchErrors=${searchErrors}, eligible=${eligible}, alreadyKnown=${alreadyKnown}, baselineAdded=${baselineAdded}, rebaselineSearches=${rebaselineSearches}, wrongYear=${wrongYear}, manualRejected=${manualRejected}, parseRejected=${parseRejected}, suppressedDuplicates=${suppressedDuplicates}, notUsed=${notUsed}, dateRejected=${dateRejected}, outside=${outside}, detailRejected=${detailRejected}, sent=${sent}`);
if(pageSamples.length)console.log(`Hatla2ee pageSamples=${JSON.stringify(pageSamples)}`);
if(matches.length)console.log(`Hatla2ee newMatchSamples=${JSON.stringify(matches)}`);
await browser.close();