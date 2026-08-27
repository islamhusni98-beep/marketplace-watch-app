import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const SEARCH_URL='https://www.dubizzle.com.eg/en/vehicles/cars-for-sale/giza/q-used-cars/';
const TOKEN=process.env.TELEGRAM_BOT_TOKEN;
const CHAT=process.env.TELEGRAM_CHAT_ID;
const MAX=Number(process.env.MAX_ITEMS||150);
if(!TOKEN||!CHAT) throw new Error('Telegram config missing');

const dir=path.resolve('data');
const seenPath=path.join(dir,'seen-dubizzle.json');
await fs.mkdir(dir,{recursive:true});
let seen=new Set();
try{seen=new Set(JSON.parse(await fs.readFile(seenPath,'utf8')))}catch{}

const norm=s=>(s||'').toLowerCase().replace(/[\-_]/g,' ').replace(/\s+/g,' ').trim();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const jitter=(min,max)=>Math.floor(min+Math.random()*(max-min));
const isGiza=t=>/giza|الجيزة|جيزة|haram|هرم|dokki|دقي|mohandessin|مهندسين|agouza|عجوزة|6 october|october|اكتوبر|أكتوبر|zayed|زايد|faisal|فيصل|imbaba|امبابة|إمبابة|hadayek october|حدائق اكتوبر|حدائق أكتوبر|sheikh zayed|الشيخ زايد|maryotaya|مريوطية|moneeb|منيب|warraq|وراق|boulaq dakrour|بولاق الدكرور|omraneyah|العمرانية/i.test(norm(t));
const explicitUsed=t=>/\bused\b|مستعمل|مستعملة|condition\s*:?\s*used|الحالة\s*:?\s*مستعمل|itemcondition[^\n]{0,80}usedcondition|vehiclecondition[^\n]{0,80}used/i.test(norm(t));
const looksNew=t=>/brand new|new car|zero km|0 km|زيرو|condition\s*:?\s*new|الحالة\s*:?\s*جديد|itemcondition[^\n]{0,80}newcondition|vehiclecondition[^\n]{0,80}new/i.test(norm(t));

function ageHours(t=''){
  t=norm(t);
  if(/just now|moments ago|الآن|الان/.test(t)) return 0;
  let m=t.match(/(?:listed\s*)?(\d+)\s*(?:min|mins|minute|minutes|دقيقة|دقائق)\s*(?:ago|منذ)?/); if(m) return +m[1]/60;
  m=t.match(/(?:listed\s*)?(\d+)\s*(?:hr|hrs|hour|hours|ساعة|ساعات)\s*(?:ago|منذ)?/); if(m) return +m[1];
  if(/(?:listed\s*)?today|اليوم/.test(t)) return 0;
  if(/yesterday|أمس|امس/.test(t)) return null;
  m=t.match(/(?:listed\s*)?(\d+)\s*(?:day|days|يوم|أيام|ايام)\s*(?:ago|منذ)?/); return m?+m[1]*24:null;
}
const heat=a=>a<8?'🔥 HOT':a<16?'🟠 WARM':'🔵 COLD';
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
function usedEvidence({body,structured,condition}){
  const all=`${condition}\n${body}\n${structured}`;
  if(looksNew(all)) return {used:false,source:'new-marker'};
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
const search=await ctx.newPage();
await search.goto(SEARCH_URL,{waitUntil:'domcontentloaded',timeout:60000});
await search.waitForTimeout(1500);
for(let i=0;i<10;i++){await search.mouse.wheel(0,2200);await search.waitForTimeout(250)}
const ads=await search.locator('a[href*="/ad/"]').evaluateAll((links,max)=>{
  const out=[],ids=new Set();
  for(const a of links){
    if(!/ID\d+\.html/i.test(a.href||'')) continue;
    const url=a.href.split('?')[0].split('#')[0];
    const id=url.match(/ID(\d+)\.html/i)?.[1];
    if(!id||ids.has(id)) continue;
    ids.add(id); out.push({id,url});
    if(out.length>=max) break;
  }
  return out;
},MAX);
await search.close();

let sent=0,duplicates=0,inspected=0,conditionMissing=0,notUsed=0,locationMissing=0,outsideGiza=0,ageMissing=0,olderThan24h=0,detailErrors=0,rateLimited=0,retryRecovered=0;
const evidenceCounts={conditionLabel:0,structuredData:0,pageText:0};
const missingSamples=[];
const page=await ctx.newPage();
for(const a of ads){
  const key=`Dubizzle:${a.id}`;
  if(seen.has(key)){duplicates++;continue}
  try{
    await sleep(jitter(2800,4300));
    let body='',structured='',title='';
    for(let attempt=1;attempt<=2;attempt++){
      await page.goto(a.url,{waitUntil:'domcontentloaded',timeout:60000});
      await page.waitForTimeout(650);
      body=(await page.locator('body').innerText().catch(()=>''))||'';
      title=(await page.locator('h1').first().innerText().catch(()=>''))||'';
      const blocked=/error\s*1015|rate limited|you are being rate limited/i.test(`${title}\n${body}`);
      if(!blocked) {
        if(attempt===2) retryRecovered++;
        break;
      }
      rateLimited++;
      if(attempt===1) await sleep(jitter(9000,13000));
    }
    inspected++;
    if(/error\s*1015|rate limited|you are being rate limited/i.test(`${title}\n${body}`)){
      detailErrors++;
      console.warn(`Dubizzle ${a.id}: rate-limited after retry`);
      continue;
    }
    structured=(await page.locator('script[type="application/ld+json"],script#__NEXT_DATA__').allTextContents().catch(()=>[])).join('\n');
    const lines=body.split('\n').map(x=>x.trim()).filter(Boolean);
    title=title||lines[0]||'سيارة مستعملة';
    const price=pickLine(lines,/EGP|ج\.م/i);
    const year=extractLabelValue(body,/^(year|السنة|سنة الصنع)$/i)||((`${title}\n${body}`).match(/\b(19|20)\d{2}\b/)||[])[0]||'';
    const condition=extractLabelValue(body,/^(condition|الحالة)$/i);
    const loc=extractLabelValue(body,/^(location|الموقع|المكان)$/i)||pickLine(lines,/giza|الجيزة|جيزة|haram|هرم|dokki|دقي|mohandessin|مهندسين|agouza|عجوزة|october|اكتوبر|أكتوبر|zayed|زايد|faisal|فيصل|imbaba|امبابة|إمبابة|warraq|وراق|العمرانية/i);
    const ago=pickLine(lines,/listed.*ago|ago$|منذ|today|اليوم|yesterday|أمس|امس/i);

    const evidence=usedEvidence({body,structured,condition});
    if(evidence.source==='new-marker'){notUsed++;continue}
    if(!evidence.used){
      conditionMissing++;
      if(missingSamples.length<8) missingSamples.push({id:a.id,title:title.slice(0,100),condition:condition||'',hasStructured:structured.length>0,url:a.url});
      continue;
    }
    if(evidence.source==='condition-label') evidenceCounts.conditionLabel++;
    else if(evidence.source==='structured-data') evidenceCounts.structuredData++;
    else if(evidence.source==='page-text') evidenceCounts.pageText++;

    if(!loc){locationMissing++;continue}
    if(!isGiza(loc)){outsideGiza++;continue}
    const age=ageHours(ago);
    if(age===null){ageMissing++;continue}
    if(age>24){olderThan24h++;continue}

    await send({url:a.url,title,price,year,ago,loc,age,usedSource:evidence.source});
    seen.add(key); sent++;
  }catch(e){detailErrors++;console.warn(`Dubizzle ${a.id}: ${e.message}`)}
}
await page.close();

await fs.writeFile(seenPath,JSON.stringify([...seen].slice(-5000),null,2));
console.log(`Dubizzle collected=${ads.length}, duplicates=${duplicates}, inspected=${inspected}, conditionMissing=${conditionMissing}, notUsed=${notUsed}, locationMissing=${locationMissing}, outsideGiza=${outsideGiza}, ageMissing=${ageMissing}, olderThan24h=${olderThan24h}, rateLimited=${rateLimited}, retryRecovered=${retryRecovered}, detailErrors=${detailErrors}, sent=${sent}`);
console.log(`Dubizzle usedEvidence conditionLabel=${evidenceCounts.conditionLabel}, structuredData=${evidenceCounts.structuredData}, pageText=${evidenceCounts.pageText}`);
if(missingSamples.length) console.log(`Dubizzle conditionMissingSamples=${JSON.stringify(missingSamples)}`);
await browser.close();