import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const SEARCH_URLS=[
  ['Giza','https://www.dubizzle.com.eg/en/vehicles/cars-for-sale/giza/q-used-cars/'],
  ['Cairo','https://www.dubizzle.com.eg/en/vehicles/cars-for-sale/cairo/q-used-cars/'],
];
const TOKEN=process.env.TELEGRAM_BOT_TOKEN;
const CHAT=process.env.TELEGRAM_CHAT_ID;
const MAX=Number(process.env.MAX_ITEMS||150);
const DETAIL_LIMIT=Number(process.env.DUBIZZLE_DETAIL_LIMIT||4);
const MAX_AGE_HOURS=72;
if(!TOKEN||!CHAT) throw new Error('Telegram config missing');

const dir=path.resolve('data');
const seenPath=path.join(dir,'seen-dubizzle.json');
await fs.mkdir(dir,{recursive:true});
let seen=new Set();
try{seen=new Set(JSON.parse(await fs.readFile(seenPath,'utf8')))}catch{}

const norm=s=>(s||'').toLowerCase().replace(/[\-_]/g,' ').replace(/\s+/g,' ').trim();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const jitter=(min,max)=>Math.floor(min+Math.random()*(max-min));
const isGreaterCairo=t=>/giza|الجيزة|جيزة|cairo|القاهرة|haram|هرم|dokki|دقي|mohandessin|مهندسين|agouza|عجوزة|6 october|october|اكتوبر|أكتوبر|zayed|زايد|faisal|فيصل|imbaba|امبابة|إمبابة|hadayek october|حدائق اكتوبر|حدائق أكتوبر|sheikh zayed|الشيخ زايد|maryotaya|مريوطية|moneeb|منيب|warraq|وراق|boulaq dakrour|بولاق الدكرور|omraneyah|العمرانية|nasr city|مدينة نصر|heliopolis|مصر الجديدة|maadi|المعادي|new cairo|القاهرة الجديدة|fifth settlement|التجمع|tagamoa|mokattam|المقطم|shorouk|الشروق|badr|بدر|obour|العبور|ain shams|عين شمس|matariya|المطرية|shubra|شبرا|downtown|وسط البلد|sayeda zeinab|السيدة زينب|zamalek|الزمالك|garden city|جاردن سيتي/i.test(norm(t));
const explicitUsed=t=>/\bused\b|مستعمل|مستعملة|condition\s*:?\s*used|الحالة\s*:?\s*مستعمل|itemcondition[^\n]{0,80}usedcondition|vehiclecondition[^\n]{0,80}used/i.test(norm(t));
const explicitNew=t=>/brand new|zero km|0\s*km|زيرو|condition\s*:?\s*new|الحالة\s*:?\s*جديد|itemcondition[^\n]{0,80}newcondition|vehiclecondition[^\n]{0,80}new/i.test(norm(t));

function ageHours(t=''){
  t=norm(t);
  if(/just now|moments ago|الآن|الان/.test(t)) return 0;
  let m=t.match(/(?:listed\s*)?(\d+)\s*(?:min|mins|minute|minutes|دقيقة|دقائق)\s*(?:ago|منذ)?/); if(m) return +m[1]/60;
  m=t.match(/(?:listed\s*)?(\d+)\s*(?:hr|hrs|hour|hours|ساعة|ساعات)\s*(?:ago|منذ)?/); if(m) return +m[1];
  if(/(?:listed\s*)?today|اليوم/.test(t)) return 0;
  if(/yesterday|أمس|امس/.test(t)) return 24;
  m=t.match(/(?:listed\s*)?(\d+)\s*(?:day|days|يوم|أيام|ايام)\s*(?:ago|منذ)?/); return m?+m[1]*24:null;
}
const heat=a=>a<8?'🔥 HOT':a<24?'🟠 WARM':'🔵 COLD';
function pickLine(lines,re){return lines.find(x=>re.test(x))||''}
function extractLabelValue(body,labelRe){
  const lines=body.split('\n').map(x=>x.trim()).filter(Boolean);
  for(let i=0;i<lines.length;i++){
    if(labelRe.test(lines[i])){
      const same=lines[i].split(':').slice(1).join(':').trim();
      if(same) return same;
      if(lines[i+1]) return lines[i+1];
    }
  }
  return '';
}
function mileageKm(t=''){
  const s=norm(t).replace(/,/g,'');
  const m=s.match(/(\d+(?:\.\d+)?)\s*(?:km|كيلو|كم)\b/i);
  return m?Number(m[1]):null;
}
function usedEvidenceFromCard(card=''){
  if(explicitNew(card)) return {used:false,source:'card-new-marker'};
  if(explicitUsed(card)) return {used:true,source:'card-used-marker'};
  const km=mileageKm(card);
  if(km!==null&&km>0) return {used:true,source:'card-mileage'};
  return {used:false,source:'needs-detail'};
}
function usedEvidenceDetail({body,structured,condition,title}){
  const newScope=`${condition}\n${structured}\n${title}`;
  if(explicitNew(newScope)) return {used:false,source:'new-marker'};
  if(explicitUsed(condition)) return {used:true,source:'condition-label'};
  if(explicitUsed(structured)) return {used:true,source:'structured-data'};
  if(explicitUsed(body)) return {used:true,source:'page-text'};
  return {used:false,source:'missing'};
}
async function send(i){
  const text=['🚗 إعلان سيارة مستعملة جديد',`⚡ التصنيف: ${heat(i.age)}`,'🌐 المصدر: Dubizzle','',`📌 ${i.title}`,i.year?`📅 السنة: ${i.year}`:'',`💰 السعر: ${i.price||'غير ظاهر'}`,`🕐 نازل من: ${i.ago}`,`📍 المكان: ${i.loc}`,`✅ تحقق المستعمل: ${i.usedSource}`,`🔗 رابط الإعلان: ${i.url}`].filter(Boolean).join('\n');
  const r=await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:CHAT,text,disable_web_page_preview:false})});
  if(!r.ok) throw new Error(`Telegram ${r.status}: ${await r.text()}`);
}

const browser=await chromium.launch({headless:true});
const ctx=await browser.newContext({locale:'ar-EG',userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36'});
const candidateMap=new Map();
for(const [area,url] of SEARCH_URLS){
  const search=await ctx.newPage();
  try{
    await search.goto(url,{waitUntil:'domcontentloaded',timeout:60000});
    await search.waitForTimeout(1500);
    for(let i=0;i<8;i++){await search.mouse.wheel(0,2200);await search.waitForTimeout(250)}
    const found=await search.locator('a[href*="/ad/"]').evaluateAll((links,max)=>{
      const out=[],ids=new Set();
      for(const a of links){
        if(!/ID\d+\.html/i.test(a.href||'')) continue;
        const clean=a.href.split('?')[0].split('#')[0];
        const id=clean.match(/ID(\d+)\.html/i)?.[1];
        if(!id||ids.has(id)) continue;
        ids.add(id);
        let node=a,cardText=(a.innerText||'').trim();
        for(let depth=0;depth<6&&node?.parentElement;depth++){
          node=node.parentElement;
          const txt=(node.innerText||'').trim();
          if(txt.length>=40&&txt.length<=1400){
            cardText=txt;
            if(/EGP|ج\.م|ago|today|yesterday|منذ|اليوم|أمس|امس/i.test(txt)) break;
          }
        }
        out.push({id,url:clean,cardText});
        if(out.length>=max) break;
      }
      return out;
    },MAX);
    for(const a of found){
      if(!candidateMap.has(a.id)) candidateMap.set(a.id,{...a,searchArea:area});
      else {
        const old=candidateMap.get(a.id);
        if((a.cardText||'').length>(old.cardText||'').length) candidateMap.set(a.id,{...a,searchArea:old.searchArea});
      }
    }
    console.log(`Dubizzle ${area} search=${found.length}`);
  }catch(e){console.warn(`Dubizzle ${area} search failed: ${e.message}`)}finally{await search.close()}
}
const ads=[...candidateMap.values()];

let sent=0,duplicates=0,cardAccepted=0,cardRejectedNew=0,cardAgeMissing=0,cardOlder=0,detailFallback=0,detailAccepted=0,detailMissing=0,notUsed=0,locationMissing=0,outsideGreaterCairo=0,detailErrors=0,rateLimited=0,retryRecovered=0,detailBudgetUsed=0,stoppedForRateLimit=false;
let consecutiveRateLimitFailures=0;
const rejectSamples=[];
const page=await ctx.newPage();
for(const a of ads){
  const key=`Dubizzle:${a.id}`;
  if(seen.has(key)){duplicates++;continue}

  const cardLines=(a.cardText||'').split('\n').map(x=>x.trim()).filter(Boolean);
  const cardTitle=cardLines.find(x=>x.length>4&&!/EGP|ج\.م|ago|today|yesterday|منذ|اليوم|أمس|امس/i.test(x))||'سيارة مستعملة';
  const cardPrice=pickLine(cardLines,/EGP|ج\.م/i);
  const cardAgo=pickLine(cardLines,/ago|today|yesterday|منذ|اليوم|أمس|امس|\d+\s*(?:day|days|hour|hours|hr|hrs|يوم|أيام|ايام|ساعة|ساعات)/i);
  const cardLoc=pickLine(cardLines,/giza|الجيزة|cairo|القاهرة|haram|هرم|dokki|دقي|mohandessin|مهندسين|agouza|عجوزة|october|اكتوبر|أكتوبر|zayed|زايد|faisal|فيصل|nasr city|مدينة نصر|heliopolis|مصر الجديدة|maadi|المعادي|new cairo|القاهرة الجديدة|التجمع|mokattam|المقطم|shorouk|الشروق|obour|العبور/i)||a.searchArea;
  const cardYear=((a.cardText||'').match(/\b(19|20)\d{2}\b/)||[])[0]||'';
  const cardAge=ageHours(cardAgo);
  const cardUsed=usedEvidenceFromCard(a.cardText||'');

  if(cardUsed.source==='card-new-marker'){
    cardRejectedNew++;
    if(rejectSamples.length<6) rejectSamples.push({id:a.id,reason:'card-new',title:cardTitle,ago:cardAgo,loc:cardLoc});
    continue;
  }
  if(cardAge!==null&&cardAge>MAX_AGE_HOURS){cardOlder++;continue}
  if(cardAge===null) cardAgeMissing++;

  if(cardUsed.used&&cardAge!==null&&isGreaterCairo(cardLoc)){
    await send({url:a.url,title:cardTitle,price:cardPrice,year:cardYear,ago:cardAgo,loc:cardLoc,age:cardAge,usedSource:cardUsed.source});
    seen.add(key); sent++; cardAccepted++;
    continue;
  }

  if(detailBudgetUsed>=DETAIL_LIMIT) continue;
  detailBudgetUsed++; detailFallback++;
  try{
    await sleep(jitter(3200,4800));
    let body='',structured='',title='';
    for(let attempt=1;attempt<=2;attempt++){
      await page.goto(a.url,{waitUntil:'domcontentloaded',timeout:45000});
      await page.waitForTimeout(700);
      body=(await page.locator('body').innerText().catch(()=>''))||'';
      title=(await page.locator('h1').first().innerText().catch(()=>''))||'';
      const blocked=/error\s*1015|rate limited|you are being rate limited/i.test(`${title}\n${body}`);
      if(!blocked){if(attempt===2) retryRecovered++;break}
      rateLimited++;
      if(attempt===1) await sleep(jitter(9000,12000));
    }
    if(/error\s*1015|rate limited|you are being rate limited/i.test(`${title}\n${body}`)){
      detailErrors++; consecutiveRateLimitFailures++;
      console.warn(`Dubizzle ${a.id}: Cloudflare 1015 after retry; not marked seen`);
      if(consecutiveRateLimitFailures>=2){stoppedForRateLimit=true;break}
      continue;
    }
    consecutiveRateLimitFailures=0;
    structured=(await page.locator('script[type="application/ld+json"],script#__NEXT_DATA__').allTextContents().catch(()=>[])).join('\n');
    const lines=body.split('\n').map(x=>x.trim()).filter(Boolean);
    title=title||cardTitle;
    const price=pickLine(lines,/EGP|ج\.م/i)||cardPrice;
    const year=extractLabelValue(body,/^(year|السنة|سنة الصنع)$/i)||((`${title}\n${body}`).match(/\b(19|20)\d{2}\b/)||[])[0]||cardYear;
    const condition=extractLabelValue(body,/^(condition|الحالة)$/i);
    const loc=extractLabelValue(body,/^(location|الموقع|المكان)$/i)||pickLine(lines,/giza|الجيزة|cairo|القاهرة|haram|هرم|dokki|دقي|mohandessin|مهندسين|agouza|عجوزة|october|اكتوبر|أكتوبر|zayed|زايد|faisal|فيصل|nasr city|مدينة نصر|heliopolis|مصر الجديدة|maadi|المعادي|new cairo|القاهرة الجديدة|التجمع|mokattam|المقطم|shorouk|الشروق|obour|العبور/i)||cardLoc;
    const ago=pickLine(lines,/listed.*ago|ago$|منذ|today|اليوم|yesterday|أمس|امس|\d+\s*(?:day|days|hour|hours|hr|hrs|يوم|أيام|ايام|ساعة|ساعات)/i)||cardAgo;
    const evidence=usedEvidenceDetail({body,structured,condition,title});
    if(evidence.source==='new-marker'){notUsed++;continue}
    if(!evidence.used){detailMissing++;continue}
    if(!loc){locationMissing++;continue}
    if(!isGreaterCairo(loc)){outsideGreaterCairo++;continue}
    const age=ageHours(ago);
    if(age===null||age>MAX_AGE_HOURS){continue}

    await send({url:a.url,title,price,year,ago,loc,age,usedSource:evidence.source});
    seen.add(key); sent++; detailAccepted++;
  }catch(e){detailErrors++;console.warn(`Dubizzle ${a.id}: ${e.message}`)}
}
await page.close();

await fs.writeFile(seenPath,JSON.stringify([...seen].slice(-5000),null,2));
console.log(`Dubizzle collected=${ads.length}, duplicates=${duplicates}, cardAccepted=${cardAccepted}, cardRejectedNew=${cardRejectedNew}, cardAgeMissing=${cardAgeMissing}, cardOlderThan72h=${cardOlder}, detailLimit=${DETAIL_LIMIT}, detailFallback=${detailFallback}, detailAccepted=${detailAccepted}, detailMissing=${detailMissing}, notUsed=${notUsed}, locationMissing=${locationMissing}, outsideGreaterCairo=${outsideGreaterCairo}, rateLimited=${rateLimited}, retryRecovered=${retryRecovered}, stoppedForRateLimit=${stoppedForRateLimit}, detailErrors=${detailErrors}, sent=${sent}`);
if(rejectSamples.length) console.log(`Dubizzle rejectSamples=${JSON.stringify(rejectSamples)}`);
await browser.close();