import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { hasRequiredHatla2eeCardData } from './hatla2ee-policy.mjs';

const SEARCHES=[
  {label:'Cars under 300k - Egypt',url:'https://eg.hatla2ee.com/en/car/price-limit/300000',targetLabel:'سيارات حتى 300 ألف جنيه',minYear:1980,manualOnly:false,area:'Egypt'},
];

const TOKEN=process.env.TELEGRAM_BOT_TOKEN;
const CHAT=process.env.TELEGRAM_CHAT_ID;
const MAX_PRICE_EGP=300000;
if(!TOKEN||!CHAT) throw new Error('Telegram config missing');

const MIN_REQUEST_INTERVAL_MS=4000;
let lastSourceRequestAt=0;
async function gotoHatla2ee(page,url){
  let response=null;
  for(let attempt=0;attempt<3;attempt++){
    const wait=MIN_REQUEST_INTERVAL_MS-(Date.now()-lastSourceRequestAt);
    if(wait>0)await new Promise(resolve=>setTimeout(resolve,wait));
    response=await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000});
    lastSourceRequestAt=Date.now();
    if(response?.status()!==429)return response;
    if(attempt<2){
      const retryAfter=Number(response.headers()['retry-after']||0)*1000;
      const cooldown=Math.max(retryAfter,(attempt+1)*15000);
      console.warn(`Hatla2ee rate limited ${url}; retrying after ${cooldown}ms`);
      await new Promise(resolve=>setTimeout(resolve,cooldown));
    }
  }
  return response;
}

const dataDir=path.resolve('data');
const statePath=path.join(dataDir,'seen-hatla2ee-under-250k.json');
await fs.mkdir(dataDir,{recursive:true});
let initialized=false;
let known=new Set();
let searchState={};
let scopeMigrationVersion=1;
let scopeMigrationPending=null;
try{
  const raw=JSON.parse(await fs.readFile(statePath,'utf8'));
  if(Array.isArray(raw)) known=new Set(raw);
  else if(raw&&typeof raw==='object'){
    initialized=Boolean(raw.initialized);
    known=new Set(Array.isArray(raw.ids)?raw.ids:[]);
    searchState=raw.searchState&&typeof raw.searchState==='object'?raw.searchState:{};
    scopeMigrationVersion=Number(raw.scopeMigrationVersion||1);
    scopeMigrationPending=Array.isArray(raw.scopeMigrationPending)?new Set(raw.scopeMigrationPending):null;
  }
}catch{}
if(!scopeMigrationPending)scopeMigrationPending=new Set([...known]);

function latinDigits(s=''){return String(s).replace(/[٠-٩]/g,d=>'٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/[۰-۹]/g,d=>'۰۱۲۳۴۵۶۷۸۹'.indexOf(d))}
function norm(s=''){return latinDigits(s).toLowerCase().replace(/[\-_]/g,' ').replace(/\s+/g,' ').trim()}
function extractYear(text=''){const ys=(latinDigits(text).match(/(?:19|20)\d{2}/g)||[]).map(Number);return ys.find(v=>v>=1980&&v<=2030)||null}
function isManual(text=''){return /\bmanual\b|man\.?|مانيوال|يدوي|عادي/i.test(norm(text))}
const cairoFmt=new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Cairo',year:'numeric',month:'2-digit',day:'2-digit'});
const now=new Date();
// Hatla2ee exposes Posted On as a date without a time. Accept today and yesterday only,
// so published ads cannot exceed 48 hours; the source's date precision can omit part of the boundary day.
const acceptedDates=new Set([0,1].map(days=>cairoFmt.format(new Date(now.getTime()-days*86400000))));
const wasPreviouslyInCairoScope=t=>/giza|الجيزة|جيزة|cairo|القاهرة|haram|هرم|dokki|دقي|mohandessin|مهندسين|agouza|عجوزة|6th? of october|6 october|october|اكتوبر|أكتوبر|zayed|زايد|faisal|فيصل|imbaba|امبابة|إمبابة|hadayek|حدائق|maryotaya|مريوطية|moneeb|منيب|warraq|وراق|boulaq|بولاق|omraneyah|العمرانية|nasr city|مدينة نصر|heliopolis|مصر الجديدة|maadi|المعادي|new cairo|القاهرة الجديدة|settlement|التجمع|tagamoa|mokattam|المقطم|shorouk|الشروق|badr|بدر|obour|العبور|ain shams|عين شمس|matariya|المطرية|shubra|شبرا|downtown|وسط|sayeda zeinab|السيدة زينب|zamalek|الزمالك|garden city|جاردن سيتي|madinaty|مدينتي|helwan|حلوان|sheraton|شيراتون|ramses|رمسيس|new nozha|النزهة/i.test(norm(t));
function extractCondition(title='',body=''){
  if(/^\s*Used\b/i.test(title)||/^\s*مستعمل\b/i.test(title)) return 'Used';
  if(/^\s*New\b/i.test(title)||/^\s*جديد\b/i.test(title)) return 'New';
  return body.match(/(?:^|\n)\s*(?:Condition|الحالة)\s*(?:\n|[:：-]\s*)\s*(Used|New|مستعمل|جديد)\b/im)?.[1]?.trim()||'';
}
function extractPostedOn(body=''){return body.match(/(?:Posted\s+On|تاريخ\s+النشر)\s*(?:\n|[:：-]\s*)\s*(\d{4}-\d{2}-\d{2})/i)?.[1]||''}
function extractLocation(body=''){return body.match(/(?:^|\n)\s*(?:Location|الموقع)\s*(?:\n|[:：-]\s*)\s*([^\n]+)/im)?.[1]?.trim()||''}
function extractTransmission(body=''){return body.match(/(?:^|\n)\s*(?:Transmission|ناقل الحركة|الفتيس)\s*(?:\n|[:：-]\s*)\s*([^\n]+)/im)?.[1]?.trim()||''}
function extractPrice(body=''){return body.match(/[0-9٠-٩][0-9٠-٩,٬.]*\s*(?:EGP|ج\.م)/i)?.[0]?.replace(/\s+/g,' ').trim()||''}
function extractSellerDescription(body=''){
  const lines=String(body).replace(/\r/g,'').split('\n').map(line=>line.trim()).filter(Boolean);
  const locationIndex=lines.findIndex(line=>/^(?:Location|الموقع)$/i.test(line));
  if(locationIndex<0||locationIndex+2>=lines.length)return '';
  const start=locationIndex+2;
  const stopMarker=/^(?:Features|Car Features|مميزات|مواصفات السيارة|Contact Seller|تواصل مع البائع|Report this Ad|الإبلاغ عن الإعلان|Reviews|Market Insights|Premium Deals|Cars in same budget|Latest Car News)$/i;
  const end=lines.findIndex((line,index)=>index>=start&&stopMarker.test(line));
  return lines.slice(start,end<0?lines.length:end).join('\n').trim();
}
const ARABIC_BRANDS={
  daewoo:'دايو',hyundai:'هيونداي',suzuki:'سوزوكي',fiat:'فيات',skoda:'سكودا',kia:'كيا',nissan:'نيسان',
  toyota:'تويوتا',opel:'أوبل',chevrolet:'شيفروليه',renault:'رينو',peugeot:'بيجو',mitsubishi:'ميتسوبيشي',
  lada:'لادا',speranza:'سبيرانزا',volvo:'فولفو',honda:'هوندا',mazda:'مازدا',daihatsu:'دايهاتسو',
  'volks wagen':'فولكس فاجن',volkswagen:'فولكس فاجن','great wall':'جريت وول',mercedes:'مرسيدس',bmw:'بي إم دبليو',
  jac:'جاك',chery:'شيري',zotye:'زوتي',geely:'جيلي',changan:'شانجان',brilliance:'بريليانس',proton:'بروتون',
  mg:'إم جي',faw:'فاو',chrysler:'كرايسلر',ford:'فورد',isuzu:'إيسوزو',tata:'تاتا',seat:'سيات'
};
const ARABIC_MODELS={
  nubira:'نوبيرا',siena:'سينا',verna:'فيرنا',alto:'ألتو',lanos:'لانوس',punto:'بونتو',petra:'بترا',
  felicia:'فيليشيا',sunny:'صني',lancer:'لانسر',corolla:'كورولا',accent:'أكسنت',excel:'إكسيل',
  picanto:'بيكانتو',rio:'ريو',sephia:'سيفيا',mira:'ميرا',golf:'جولف',logan:'لوجان',optra:'أوبترا',
  aveo:'أفيو',cerato:'سيراتو',maruti:'ماروتي',tercel:'تيرسل',speranza:'سبيرانزا'
};
function formatCarTitle(url,fallbackTitle='',year=''){
  const match=String(url).match(/\/en\/car\/([^/]+)\/([^/]+)\/\d+\/?$/i);
  if(!match)return String(fallbackTitle||'سيارة').replace(/\s+/g,' ').trim()+' — موديل '+year;
  let brandSlug=match[1],modelSlug=match[2];
  try{brandSlug=decodeURIComponent(brandSlug);modelSlug=decodeURIComponent(modelSlug)}catch{}
  const brandKey=norm(brandSlug.replace(/[-_]/g,' '));
  const brand=ARABIC_BRANDS[brandKey]||brandSlug.replace(/[-_]/g,' ');
  const model=modelSlug.replace(/[-_]/g,' ').split(/\s+/).filter(Boolean)
    .map(part=>ARABIC_MODELS[norm(part)]||part).join(' ');
  return brand+' '+model+' — موديل '+year;
}
function formatLocation(value=''){
  const key=norm(String(value).replace(/[,،]/g,' ')).replace(/\s+/g,' ').trim();
  const locations={
    cairo:'القاهرة',giza:'الجيزة','el shorouk':'الشروق','6 october':'السادس من أكتوبر',
    downtown:'وسط البلد',maadi:'المعادي',helwan:'حلوان','nasr city':'مدينة نصر',
    'nasr city cairo':'مدينة نصر، القاهرة','new cairo':'القاهرة الجديدة',
    'ain shams':'عين شمس',heliopolis:'مصر الجديدة','boulak al dakror':'بولاق الدكرور',
    'tagamo3 new cairo':'التجمع الخامس','10th of ramadan':'العاشر من رمضان',
    'sheikh zayed city':'مدينة الشيخ زايد'
  };
  return locations[key]||String(value).trim();
}
function formatTransmission(value=''){
  if(/automatic|اوتوماتيك|أوتوماتيك/i.test(value))return 'أوتوماتيك';
  if(/manual|مانيوال|يدوي/i.test(value))return 'مانيوال';
  return String(value).trim();
}
function formatMileage(value=''){
  return String(value).replace(/\bKM\b/i,'كم').replace(/\s+/g,' ').trim();
}
function extractPriceAmount(value=''){
  const latin=String(value).replace(/[٠-٩]/g,d=>String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/[۰-۹]/g,d=>String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)));
  const match=latin.match(/[0-9][0-9,٬.]*/);
  if(!match)return null;
  const amount=Number(match[0].replace(/[^0-9]/g,''));
  return Number.isFinite(amount)?amount:null;
}
function parseCard(c,targetLabel,area){
  const lines=(c.cardText||'').split('\n').map(x=>x.trim()).filter(Boolean);
  const title=lines.find(x=>/(?:19|20)\d{2}/.test(x)&&/[A-Za-zأ-ي]/.test(x))||c.anchorText||targetLabel;
  const year=extractYear(title)||extractYear(c.cardText);
  const mileage=lines.find(x=>/\b[\d,.]+\s*KM\b/i.test(x))||'';
  const transmission=lines.find(x=>/^(Automatic|Manual|A\/T|M\/T|اوتوماتيك|أوتوماتيك|مانيوال|يدوي)$/i.test(x))||'';
  const price=lines.find(x=>/[\d,.]+\s*EGP$/i.test(x))||'';
  const priceIndex=lines.findIndex(x=>/[\d,.]+\s*EGP$/i.test(x));
  const city=priceIndex>=0?(lines[priceIndex+1]||area):area;
  return {title,year,mileage,transmission,price,city};
}
function fingerprint(target,p){return norm([target,p.title,p.year,p.mileage,p.transmission,p.price,p.city].join('|'))}
async function send(i){
  const price=String(i.price||'').replace(/\s+/g,' ').trim();
  const description=String(i.sellerDescription||'').trim();
  const text=[
    '🚗 '+(i.displayTitle||i.title),
    '🌐 المصدر: هتلاقي',
    '💰 السعر المعلن: '+price,
    '🛣️ العداد: '+formatMileage(i.mileage),
    '⚙️ الفتيس: '+formatTransmission(i.transmission),
    '📍 المكان: '+formatLocation(i.city)
  ].join('\n')+
    (description?'\n\n📝 وصف البائع:\n'+description:'')+
    '\n\n🔗 رابط الإعلان الأصلي: '+i.url;
  for(let attempt=0;attempt<3;attempt++){
    const r=await fetch('https://api.telegram.org/bot'+TOKEN+'/sendMessage',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:CHAT,text,disable_web_page_preview:false})});
    if(r.ok)return;
    const body=await r.text();
    let retryAfter=0;try{retryAfter=Number(JSON.parse(body)?.parameters?.retry_after||0)}catch{}
    if(r.status===429&&retryAfter&&attempt<2){console.warn('Telegram rate limited; retrying after '+retryAfter+'s');await new Promise(resolve=>setTimeout(resolve,(retryAfter+1)*1000));continue}
    throw new Error('Telegram '+r.status+': '+body);
  }
}

const browser=await chromium.launch({headless:true});
const ctx=await browser.newContext({locale:'en-US',timezoneId:'Africa/Cairo',userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36'});
const resultsBySearch=new Map();
let pagesVisited=0,pagesWithCards=0,searchErrors=0;
const pageSamples=[];

for(const search of SEARCHES){
  const page=await ctx.newPage();
  try{
    const response=await gotoHatla2ee(page,search.url);
    await page.waitForTimeout(350);
    pagesVisited++;
    const found=await page.locator('a[href*="/en/car/"]').evaluateAll(links=>{
      const out=[],ids=new Set();
      for(const a of links){
        const href=a.href||'';const id=href.match(/\/en\/car\/[^/]+\/[^/]+\/(\d+)\/?(?:\?.*)?$/)?.[1];
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
    const pageText=(await page.locator('body').innerText().catch(()=>''))||'';
    const blocked=/captcha|verify you are human|access denied|robot check|unusual traffic|request blocked/i.test(pageText.slice(0,4000));
    const healthy=Boolean(response&&response.status()>=200&&response.status()<400&&pageText.trim().length>20&&!blocked);
    if(found.length)pagesWithCards++;
    console.log(`Hatla2ee ${search.label}: ${found.length}`);
    if(pageSamples.length<8&&found.length)pageSamples.push({search:search.label,...found[0]});
    if(!healthy)console.warn(`Hatla2ee ${search.label}: page response ${response?.status()||'none'}; page may be empty or blocked`);
    resultsBySearch.set(search.label,{search,found,healthy});
  }catch(e){
    searchErrors++;
    console.warn(`Hatla2ee ${search.label}: ${e.message}`);
    resultsBySearch.set(search.label,{search,found:[],healthy:false});
  }finally{await page.close()}
}

const healthySearches=[...resultsBySearch.values()].filter(result=>result.healthy).length;
if(healthySearches===0){
  await browser.close();
  throw new Error('Hatla2ee returned no healthy search pages; refusing to update watcher state');
}

let eligible=0,baselineAdded=0,sent=0,alreadyKnown=0,wrongYear=0,manualRejected=0,parseRejected=0,rebaselineSearches=0,suppressedDuplicates=0,detailRejected=0,retryScheduled=0,deliveryErrors=0,dateRejected=0,scopeReactivated=0,notUsed=0,budgetRejected=0;
const matches=[];
const runFingerprints=new Set();
const nextSearchState={...searchState};

for(const {search,found,healthy} of resultsBySearch.values()){
  const currentEligibleIds=[];

  if(!healthy){
    nextSearchState[search.label]={healthy:false,ids:[],lastRun:new Date().toISOString()};
    continue;
  }

  const parsed=[];
  for(const c of found){
    const p=parseCard(c,search.targetLabel,search.area);
    if(!p.year||p.year<search.minYear||p.year>new Date().getFullYear()+1){wrongYear++;continue}
    if(!hasRequiredHatla2eeCardData(p)){parseRejected++;continue}
    if(search.manualOnly&&!isManual(`${p.transmission}\n${c.cardText}`)){manualRejected++;continue}
    eligible++;
    const key=`Hatla2ee:${c.id}`;
    currentEligibleIds.push(key);
    parsed.push({c,p,key});
  }

  const canDiff=initialized;
  if(!canDiff) rebaselineSearches++;

  for(const {c,p,key} of parsed){
    const fp=fingerprint(search.targetLabel,p);
    if(runFingerprints.has(fp)){suppressedDuplicates++;known.add(key);continue}
    runFingerprints.add(fp);

    const previouslyKnown=known.has(key);
    const needsLegacyScopeCheck=Boolean(scopeMigrationPending?.has(key));
    if(previouslyKnown&&!needsLegacyScopeCheck){alreadyKnown++;continue}
    if(previouslyKnown&&!canDiff){alreadyKnown++;continue}

    let rememberKey=true;
    const deferForRetry=()=>{
      if(rememberKey)retryScheduled++;
      rememberKey=false;
      const currentIndex=currentEligibleIds.indexOf(key);
      if(currentIndex>=0)currentEligibleIds.splice(currentIndex,1);
    };
    if(canDiff){
      const detail=await ctx.newPage();
      try{
        await gotoHatla2ee(detail,c.url);
        await detail.waitForTimeout(400);
        const body=(await detail.locator('body').innerText().catch(()=>''))||'';
        const title=(await detail.locator('h1').first().innerText().catch(()=>''))||p.title;
        const condition=extractCondition(title,body);
        const postedOn=extractPostedOn(body);
        const city=extractLocation(body);
        const transmission=extractTransmission(body)||p.transmission;
        const price=extractPrice(body)||p.price;
        if(!condition){detailRejected++;deferForRetry();console.warn(`Hatla2ee detail ${c.id}: condition missing; will retry on a later run`);continue}
        if(!/used|مستعمل/i.test(condition)){notUsed++;known.add(key);continue}
        if(!city){detailRejected++;deferForRetry();console.warn(`Hatla2ee detail ${c.id}: location missing; will retry on a later run`);continue}
        if(previouslyKnown){
          if(wasPreviouslyInCairoScope(city)){
            scopeMigrationPending?.delete(key);
            alreadyKnown++;
            continue;
          }
          known.delete(key);
          scopeMigrationPending?.delete(key);
          scopeReactivated++;
        }
        if(!postedOn){detailRejected++;deferForRetry();console.warn(`Hatla2ee detail ${c.id}: posted date missing; will retry on a later run`);continue}
        if(!acceptedDates.has(postedOn)){dateRejected++;known.add(key);continue}
        if(!price||!transmission||!title||!c.url){detailRejected++;deferForRetry();console.warn(`Hatla2ee detail ${c.id}: required detail missing; will retry on a later run`);continue}
        const priceAmount=extractPriceAmount(price);
        if(priceAmount===null){detailRejected++;deferForRetry();console.warn(`Hatla2ee detail ${c.id}: asking price could not be parsed; will retry on a later run`);continue}
        if(priceAmount>MAX_PRICE_EGP){budgetRejected++;known.add(key);continue}
        if(search.manualOnly&&!isManual(transmission)){manualRejected++;known.add(key);continue}
        const sellerDescription=extractSellerDescription(body);
        await send({url:c.url,displayTitle:formatCarTitle(c.url,p.title,p.year),...p,title,city,transmission,price,sellerDescription});
        sent++;
        if(matches.length<12)matches.push({id:c.id,target:search.targetLabel,title,year:p.year,price,city,transmission,postedOn});
      }catch(e){
        if(String(e.message).startsWith('Telegram '))deliveryErrors++;
        else detailRejected++;
        deferForRetry();
        console.warn(`Hatla2ee detail ${c.id}: ${e.message}; will retry on a later run`);
      }finally{await detail.close()}
    }else{
      baselineAdded++;
    }
    if(rememberKey)known.add(key);
  }

  nextSearchState[search.label]={healthy:true,ids:currentEligibleIds.slice(-500),lastRun:new Date().toISOString()};
}

const state={initialized:true,scopeMigrationVersion:2,scopeMigrationPending:[...(scopeMigrationPending||[])].slice(-15000),ids:[...known].slice(-15000),searchState:nextSearchState,lastRun:new Date().toISOString()};
await fs.writeFile(statePath,JSON.stringify(state,null,2));
console.log(`Hatla2ee baselineMode=${!initialized}, searches=${SEARCHES.length}, pagesVisited=${pagesVisited}, pagesWithCards=${pagesWithCards}, searchErrors=${searchErrors}, eligible=${eligible}, alreadyKnown=${alreadyKnown}, baselineAdded=${baselineAdded}, rebaselineSearches=${rebaselineSearches}, wrongYear=${wrongYear}, manualRejected=${manualRejected}, parseRejected=${parseRejected}, budgetRejected=${budgetRejected}, suppressedDuplicates=${suppressedDuplicates}, notUsed=${notUsed}, dateRejected=${dateRejected}, scopeReactivated=${scopeReactivated}, detailRejected=${detailRejected}, retryScheduled=${retryScheduled}, deliveryErrors=${deliveryErrors}, sent=${sent}`);
if(pageSamples.length)console.log(`Hatla2ee pageSamples=${JSON.stringify(pageSamples)}`);
if(matches.length)console.log(`Hatla2ee newMatchSamples=${JSON.stringify(matches)}`);
await browser.close();