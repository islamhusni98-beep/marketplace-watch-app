import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const TOKEN=process.env.TELEGRAM_BOT_TOKEN;
const CHAT=process.env.TELEGRAM_CHAT_ID;
const MAX_ITEMS=Number(process.env.MAX_ITEMS||150);
if(!TOKEN||!CHAT) throw new Error('Telegram config missing');

const TARGETS=[
  {name:'Nissan Sunny',minYear:2016,urls:['https://www.dubizzle.com.eg/en/vehicles/cars-for-sale/used/nissan/model-sunny/','https://www.dubizzle.com.eg/en/vehicles/cars-for-sale/used/q-nissan-sunny/'],re:/\bnissan\s+sunny\b|\bsunny\b|نيسان\s+صني|صني/i},
  {name:'Chevrolet Aveo',minYear:2016,urls:['https://www.dubizzle.com.eg/en/vehicles/cars-for-sale/used/chevrolet/model-aveo/','https://www.dubizzle.com.eg/en/vehicles/cars-for-sale/used/q-chevrolet-aveo/'],re:/\bchevrolet\s+aveo\b|\baveo\b|شيفروليه\s+افيو|شيفروليه\s+أفيو|افيو|أفيو/i},
  {name:'Chevrolet New Optra',minYear:2016,urls:['https://www.dubizzle.com.eg/en/vehicles/cars-for-sale/used/chevrolet/model-optra/','https://www.dubizzle.com.eg/en/vehicles/cars-for-sale/used/q-chevrolet-optra/'],re:/\bchevrolet\s+(?:new\s+)?optra\b|\b(?:new\s+)?optra\b|شيفروليه\s+(?:نيو\s+)?اوبترا|شيفروليه\s+أوبترا|اوبترا|أوبترا/i},
  {name:'Hyundai Accent RB',minYear:2016,urls:['https://www.dubizzle.com.eg/en/vehicles/cars-for-sale/used/hyundai/q-accent-rb/','https://www.dubizzle.com.eg/en/vehicles/cars-for-sale/used/q-hyundai-accent-rb/'],re:/\bhyundai\s+accent\s*rb\b|\baccent\s*rb\b|\brb\b|هيونداي\s+اكسنت\s*rb|اكسنت\s*rb|أكسنت\s*rb/i},
  {name:'BYD F3',minYear:2021,urls:['https://www.dubizzle.com.eg/en/vehicles/cars-for-sale/used/byd/model-f3/','https://www.dubizzle.com.eg/en/vehicles/cars-for-sale/used/q-byd-f3/'],re:/\bbyd\s*f3\b|\bf3\b|بى\s*واى\s*دى\s*اف\s*3|بي\s*واي\s*دي\s*f3/i},
  {name:'Hyundai Elantra HD',minYear:2017,urls:['https://www.dubizzle.com.eg/en/vehicles/cars-for-sale/used/hyundai/q-elantra-hd/','https://www.dubizzle.com.eg/en/vehicles/cars-for-sale/used/q-hyundai-elantra-hd/'],re:/\b(?:hyundai\s+)?elantra\s*hd\b|\belentra\s*hd\b|النترا\s*(?:hd|اتش\s*دي)|إلينترا\s*(?:hd|اتش\s*دي)/i},
  {name:'Hyundai Verna',minYear:2016,urls:['https://www.dubizzle.com.eg/en/vehicles/cars-for-sale/used/hyundai/model-verna/','https://www.dubizzle.com.eg/en/vehicles/cars-for-sale/used/q-hyundai-verna/'],re:/\bhyundai\s+verna\b|\bverna\b|هيونداي\s+فيرنا|فيرنا/i},
  {name:'Chevrolet Lanos',minYear:2016,urls:['https://www.dubizzle.com.eg/en/vehicles/cars-for-sale/used/q-chevrolet-lanos/','https://www.dubizzle.com.eg/en/vehicles/cars-for-sale/used/q-lanos/','https://www.dubizzle.com.eg/en/vehicles/cars-for-sale/used/chevrolet/model-lanos/'],re:/\bchevrolet\s+lanos\b|\blanos\b|شيفروليه\s+لانوس|لانوس/i},
  {name:'Chery Arrizo 5',minYear:1990,urls:['https://www.dubizzle.com.eg/en/vehicles/cars-for-sale/used/q-chery-arrizo-5/','https://www.dubizzle.com.eg/en/vehicles/cars-for-sale/used/q-arrizo-5/','https://www.dubizzle.com.eg/en/vehicles/cars-for-sale/used/chery/model-arrizo-5/','https://www.dubizzle.com.eg/en/vehicles/cars-for-sale/used/chery/'],re:/\bchery\s+arrizo\s*5\b|\barrizo\s*5\b|شيري\s+اريزو\s*5|أريزو\s*5|اريزو\s*5/i},
];

const norm=s=>(s||'').toLowerCase().replace(/[\-_]/g,' ').replace(/\s+/g,' ').trim();
function ageHours(t=''){
  t=norm(t);
  if(/just now|moments ago|الآن|الان|today|اليوم/.test(t)) return 0;
  let m=t.match(/(\d+)\s*(?:min|mins|minute|minutes|دقيقة|دقائق)/);if(m)return +m[1]/60;
  m=t.match(/(\d+)\s*(?:hr|hrs|hour|hours|ساعة|ساعات)/);if(m)return +m[1];
  if(/yesterday|أمس|امس/.test(t))return 24;
  m=t.match(/(\d+)\s*(?:day|days|يوم|أيام|ايام)/);return m?+m[1]*24:null;
}
function after(lines,re){const i=lines.findIndex(x=>re.test(x));return i>=0?(lines[i+1]||''):''}
function agoLine(lines){return lines.find(x=>/(?:\d+\s*(?:minutes?|hours?|days?|mins?|hrs?)\s*ago|today|yesterday|منذ\s*\d+\s*(?:دقائق|دقيقة|ساعات|ساعة|أيام|ايام|يوم)|اليوم|أمس|امس)/i.test(x))||''}
function location(lines,ago){const i=lines.indexOf(ago);if(i<1)return '';for(let j=i-1;j>=0&&j>=i-7;j--){const x=(lines[j]||'').trim();if(!x||/^[•·|]$/.test(x))continue;if(/^(benzine|diesel|electric|hybrid|natural gas|automatic|manual|fuel type|transmission|kilometers|mileage|year|condition|used|new)$/i.test(x))continue;return x;}return ''}
const isGreaterCairo=t=>/giza|الجيزة|جيزة|cairo|القاهرة|haram|هرم|dokki|دقي|mohandessin|مهندسين|agouza|عجوزة|6th? of october|6 october|october|اكتوبر|أكتوبر|zayed|زايد|faisal|فيصل|imbaba|امبابة|إمبابة|hadayek|حدائق|maryotaya|مريوطية|moneeb|منيب|warraq|وراق|boulaq|بولاق|omraneyah|العمرانية|nasr city|مدينة نصر|heliopolis|مصر الجديدة|maadi|المعادي|new cairo|القاهرة الجديدة|settlement|التجمع|tagamoa|mokattam|المقطم|shorouk|الشروق|badr|بدر|obour|العبور|ain shams|عين شمس|matariya|المطرية|shubra|شبرا|downtown|وسط|sayeda zeinab|السيدة زينب|zamalek|الزمالك|garden city|جاردن سيتي|madinaty|مدينتي|helwan|حلوان|sheraton|شيراتون|ramses|رمسيس|new nozha|النزهة/i.test(norm(t));

const seenPath=path.resolve('data/seen-dubizzle.json');
await fs.mkdir(path.dirname(seenPath),{recursive:true});
let seen=new Set();try{seen=new Set(JSON.parse(await fs.readFile(seenPath,'utf8')))}catch{}

async function send(i){
  const text=['🚗 إعلان سيارة مستعملة جديد',`🎯 السيارة: ${i.target}`,'🌐 المصدر: Dubizzle','',`📌 ${i.title}`,`📅 السنة: ${i.year}`,`🛣️ الكيلومترات: ${i.km}`,`⚙️ الفتيس: ${i.transmission}`,`💰 السعر: ${i.price}`,`🕐 نازل من: ${i.ago}`,`📍 المكان: ${i.loc}`,'✅ التحقق: مستعمل مؤكد + القاهرة الكبرى + آخر 3 أيام + بيانات أساسية كاملة',`🔗 رابط الإعلان: ${i.url}`].join('\n');
  const r=await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:CHAT,text,disable_web_page_preview:false})});
  if(!r.ok)throw new Error(`Telegram ${r.status}: ${await r.text()}`);
}

async function scrape(page,url){
  await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000});
  await page.waitForTimeout(1200);
  for(let i=0;i<5;i++){await page.mouse.wheel(0,2300);await page.waitForTimeout(180)}
  const cards=page.locator('li[aria-label="Listing"]');
  const count=await cards.count();
  const found=count?await cards.evaluateAll((nodes,max)=>nodes.slice(0,max).map(card=>{
    const lines=(card.innerText||'').split('\n').map(x=>x.trim()).filter(Boolean);
    const a=card.querySelector('a[href^="/en/ad/"]')||card.querySelector('a[href*="/ad/"]');
    const href=a?.href||'';const id=href.match(/ID(\d+)\.html/i)?.[1]||'';
    const labelValue=re=>{const i=lines.findIndex(x=>re.test(x));return i>=0?(lines[i+1]||''):''};
    return {id,url:href.split('?')[0].split('#')[0],title:card.querySelector('a[title]')?.getAttribute('title')||'',price:card.querySelector('div[aria-label="Price"] span')?.textContent?.trim()||lines.find(x=>/^EGP\s/i.test(x))||'',year:labelValue(/^Year$/i),km:labelValue(/^(Kilometers|Mileage)$/i),transmission:labelValue(/^Transmission$/i),condition:labelValue(/^Condition$/i),text:(card.innerText||'').trim()};
  }).filter(x=>x.id),MAX_ITEMS):[];
  return {count,found,finalUrl:page.url()};
}

const browser=await chromium.launch({headless:true});
const ctx=await browser.newContext({locale:'en-US',timezoneId:'Africa/Cairo',viewport:{width:1920,height:1080},userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36'});
let pagesWithCards=0,collected=0,sent=0,duplicates=0,old=0,wrongYear=0,parseRejected=0,outside=0,modelRejected=0,conditionRejected=0,fallbackUsed=0;
const samples=[];

for(const target of TARGETS){
  const page=await ctx.newPage();
  try{
    let result={count:0,found:[],finalUrl:''},usedUrl='';
    for(let i=0;i<target.urls.length;i++){
      try{result=await scrape(page,target.urls[i]);usedUrl=target.urls[i];}catch(e){console.warn(`Dubizzle model ${target.name} source ${i+1}: ${e.message}`);result={count:0,found:[],finalUrl:''};}
      if(result.found.length){if(i>0)fallbackUsed++;break;}
    }
    if(result.found.length)pagesWithCards++;
    console.log(`Dubizzle model ${target.name}: listingNodes=${result.count}, cards=${result.found.length}, source=${usedUrl}, finalUrl=${result.finalUrl}`);
    collected+=result.found.length;
    for(const c of result.found){
      const key=`Dubizzle:${c.id}`;if(seen.has(key)){duplicates++;continue}
      const lines=c.text.split('\n').map(x=>x.trim()).filter(Boolean);
      target.re.lastIndex=0;if(!target.re.test(`${c.title} ${c.text}`)){modelRejected++;continue}
      const condition=c.condition||after(lines,/^Condition$/i);if(!condition||!/\bused\b|مستعمل/i.test(condition)){conditionRejected++;continue}
      const year=Number(c.year||((c.text.match(/\b(?:19|20)\d{2}\b/)||[])[0]||0));if(!year||year<target.minYear||year>2026){wrongYear++;continue}
      const km=c.km||after(lines,/^(Kilometers|Mileage)$/i);if(!km||!/\d/.test(km)){parseRejected++;continue}
      const transmission=c.transmission||after(lines,/^Transmission$/i);if(!transmission||!/automatic|manual|a\/t|m\/t|اوتوماتيك|أوتوماتيك|مانيوال|يدوي/i.test(transmission)){parseRejected++;continue}
      const ago=agoLine(lines),age=ageHours(ago);if(age===null||age>72){old++;continue}
      const loc=location(lines,ago);if(!loc||!isGreaterCairo(loc)){outside++;continue}
      const price=c.price||lines.find(x=>/^EGP\s/i.test(x))||'';if(!price||!/\d/.test(price)){parseRejected++;continue}
      if(!c.title||!c.url){parseRejected++;continue}
      await send({target:target.name,title:c.title,year,km,transmission,price,ago,loc,url:c.url});
      seen.add(key);sent++;
      if(samples.length<12)samples.push({id:c.id,target:target.name,year,ago,loc,price,condition,transmission});
    }
  }finally{await page.close()}
}

await fs.writeFile(seenPath,JSON.stringify([...seen].slice(-5000),null,2));
console.log(`Dubizzle flex searches=${TARGETS.length}, pagesWithCards=${pagesWithCards}, collected=${collected}, duplicates=${duplicates}, modelRejected=${modelRejected}, conditionRejected=${conditionRejected}, wrongYear=${wrongYear}, oldOrAgeMissing=${old}, outside=${outside}, parseRejected=${parseRejected}, fallbackUsed=${fallbackUsed}, sent=${sent}`);
if(samples.length)console.log(`Dubizzle flex samples=${JSON.stringify(samples)}`);
await browser.close();