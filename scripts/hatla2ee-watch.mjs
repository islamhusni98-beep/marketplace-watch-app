import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const TARGETS = [
  ['Nissan Sunny','nissan/sunny',2016,false],
  ['Chevrolet Aveo','chevrolet/aveo',2016,false],
  ['Chevrolet New Optra','chevrolet/optra',2016,false],
  ['Hyundai Accent RB','hyundai/accent-rb',2016,false],
  ['BYD F3','byd/f3',2021,false],
  ['Hyundai Elantra HD','hyundai/elantra-hd',2017,false],
  ['Hyundai Verna','hyundai/verna',2016,false],
  ['Chevrolet Lanos','chevrolet/lanos',2016,false],
  ['Chery Arrizo 5','chery/arrizo-5',2019,true],
  ['Dayun Lanos','dayun/lanos',2016,false],
];
const AREAS=[['Giza','giza'],['Cairo','cairo']];
const SEARCHES=[];
for(const [label,slug,minYear,manualOnly] of TARGETS){
  for(const [area,citySlug] of AREAS){
    SEARCHES.push([`${label} - ${area}`,`https://eg.hatla2ee.com/en/car/city/${citySlug}/${slug}`,label,minYear,manualOnly,area]);
  }
}

const TELEGRAM_BOT_TOKEN=process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID=process.env.TELEGRAM_CHAT_ID;
const MAX_ITEMS=Number(process.env.MAX_ITEMS||60);
const PER_SEARCH_LIMIT=20;
if(!TELEGRAM_BOT_TOKEN||!TELEGRAM_CHAT_ID) throw new Error('Telegram config missing');

const dataDir=path.resolve('data');
const seenPath=path.join(dataDir,'seen-hatla2ee.json');
await fs.mkdir(dataDir,{recursive:true});
let seen=new Set();
try{seen=new Set(JSON.parse(await fs.readFile(seenPath,'utf8')))}catch{}

const cairoFmt=new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Cairo',year:'numeric',month:'2-digit',day:'2-digit'});
const now=new Date();
const cairoToday=cairoFmt.format(now);
const cairoYesterday=cairoFmt.format(new Date(now.getTime()-24*60*60*1000));
const cairoTwoDaysAgo=cairoFmt.format(new Date(now.getTime()-48*60*60*1000));
const acceptedDates=new Set([cairoToday,cairoYesterday,cairoTwoDaysAgo]);

function latinDigits(s=''){return s.replace(/[٠-٩]/g,d=>'٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/[۰-۹]/g,d=>'۰۱۲۳۴۵۶۷۸۹'.indexOf(d))}
function norm(s=''){return latinDigits(s).toLowerCase().replace(/[\-_]/g,' ').replace(/\s+/g,' ').trim()}
function extractYear(text=''){const years=(latinDigits(text).match(/(?:19|20)\d{2}/g)||[]).map(Number);return years.find(v=>v>=1990&&v<=2030)||null}
function isManual(text=''){return /manual|man\.?|مانيوال|يدوي|عادي/i.test(norm(text))}

async function sendTelegram(i){
  const dayLabel=i.postedOn===cairoToday?'TODAY':i.postedOn===cairoYesterday?'YESTERDAY':'2 DAYS AGO';
  const text=['🚗 إعلان سيارة مستعملة جديد',`🟣 التصنيف: ${dayLabel}`,'🌐 المصدر: Hatla2ee','',`🎯 ${i.target.name} ${i.target.year}`,`📌 ${i.title}`,`💰 السعر: ${i.priceText||'غير ظاهر'}`,`📅 تاريخ النشر: ${i.postedOn}`,`📍 المكان: ${i.location||i.area}`,`🔗 رابط الإعلان: ${i.url}`].join('\n');
  const r=await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:TELEGRAM_CHAT_ID,text,disable_web_page_preview:false})});
  if(!r.ok) throw new Error(`Telegram ${r.status}: ${await r.text()}`);
}

const browser=await chromium.launch({headless:true});
const context=await browser.newContext({locale:'en-US',userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36'});
const candidates=new Map();

for(const [searchLabel,url,targetLabel,minYear,manualOnly,area] of SEARCHES){
  const p=await context.newPage();
  try{
    await p.goto(url,{waitUntil:'domcontentloaded',timeout:60000});
    await p.waitForTimeout(900);
    for(let i=0;i<2;i++){await p.mouse.wheel(0,1800);await p.waitForTimeout(250)}
    const found=await p.locator('a[href*="/en/car/"]').evaluateAll((links,limit)=>{
      const out=[],s=new Set();
      for(const a of links){
        const href=a.href||'';
        if(!/\/en\/car\/[^/]+\/[^/]+\/\d+\/?(?:\?.*)?$/i.test(href)) continue;
        const clean=href.split('?')[0].split('#')[0];
        const id=clean.match(/\/(\d+)\/?$/)?.[1];
        if(!id||s.has(id)) continue;
        s.add(id); out.push({id,href:clean,title:(a.innerText||'').trim()});
        if(out.length>=limit) break;
      }
      return out;
    },PER_SEARCH_LIMIT);
    for(const c of found){
      if(!candidates.has(c.id)) candidates.set(c.id,{...c,sourceSearch:targetLabel,minYear,manualOnly,area});
    }
    console.log(`Hatla2ee search ${searchLabel}: ${found.length}`);
  }catch(e){console.warn(`Hatla2ee search ${searchLabel} failed: ${e.message}`)}finally{await p.close()}
}

let sent=0,targeted=0,inspected=0,acceptedDateCount=0,todayCount=0,yesterdayCount=0,twoDaysCount=0,wrongYear=0,notUsed=0,manualRejected=0,duplicateSkipped=0;
const all=[...candidates.values()];
for(const c of all.slice(0,MAX_ITEMS*TARGETS.length)){
  const id=`Hatla2ee:${c.id}`;
  if(seen.has(id)){duplicateSkipped++;continue}
  const page=await context.newPage();
  try{
    await page.goto(c.href,{waitUntil:'domcontentloaded',timeout:60000});
    await page.waitForTimeout(400);
    inspected++;
    const body=(await page.locator('body').innerText().catch(()=>''))||'';
    const title=(await page.locator('h1').first().innerText().catch(()=>''))||c.title||c.sourceSearch;
    const year=extractYear(title)||extractYear(body);
    if(!year||year<c.minYear||year>2026){wrongYear++;continue}
    targeted++;
    if(c.manualOnly&&!isManual(`${title}\n${body}`)){manualRejected++;continue}
    const condition=body.match(/Condition\s*\n\s*([^\n]+)/i)?.[1]?.trim()||body.match(/الحالة\s*\n\s*([^\n]+)/i)?.[1]?.trim()||'';
    if(condition&&!/used|مستعمل/i.test(condition)){notUsed++;continue}
    const postedOn=body.match(/Posted On\s*\n\s*(\d{4}-\d{2}-\d{2})/i)?.[1]||body.match(/تاريخ النشر\s*\n\s*(\d{4}-\d{2}-\d{2})/i)?.[1]||'';
    if(!acceptedDates.has(postedOn)) continue;
    acceptedDateCount++;
    if(postedOn===cairoToday) todayCount++; else if(postedOn===cairoYesterday) yesterdayCount++; else twoDaysCount++;
    const location=body.match(/Location\s*\n\s*([^\n]+)/i)?.[1]?.trim()||body.match(/الموقع\s*\n\s*([^\n]+)/i)?.[1]?.trim()||c.area;
    const priceText=body.match(/[0-9٠-٩][0-9٠-٩,٬.]*\s*(?:EGP|ج\.م)/i)?.[0]||'';
    await sendTelegram({id,url:c.href,title,postedOn,location,priceText,area:c.area,target:{name:c.sourceSearch,year}});
    seen.add(id); sent++;
  }catch(e){console.warn(`Hatla2ee ${c.id}: ${e.message}`)}finally{await page.close()}
}

await fs.writeFile(seenPath,JSON.stringify([...seen].slice(-5000),null,2));
console.log(`Hatla2ee total=${candidates.size}, inspected=${inspected}, targetCars=${targeted}, acceptedDate=${acceptedDateCount}, today=${todayCount}, yesterday=${yesterdayCount}, twoDaysAgo=${twoDaysCount}, duplicates=${duplicateSkipped}, wrongYear=${wrongYear}, notUsed=${notUsed}, manualRejected=${manualRejected}, sent=${sent}`);
await browser.close();