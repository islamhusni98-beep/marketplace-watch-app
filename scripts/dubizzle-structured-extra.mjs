import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const TOKEN=process.env.TELEGRAM_BOT_TOKEN;
const CHAT=process.env.TELEGRAM_CHAT_ID;
if(!TOKEN||!CHAT) throw new Error('Telegram config missing');

const TARGETS=[
  {name:'BYD F3',minYear:2021,manualOnly:false,url:'https://www.dubizzle.com.eg/en/vehicles/cars-for-sale/used/byd/model-f3/',re:/\bbyd\s*f3\b|\bf3\b|بى\s*واى\s*دى\s*اف\s*3|بي\s*واي\s*دي\s*f3/i},
  {name:'Hyundai Elantra HD',minYear:2017,manualOnly:false,url:'https://www.dubizzle.com.eg/en/vehicles/cars-for-sale/used/hyundai/q-elantra-hd/',re:/\b(?:hyundai\s+)?elantra\s*hd\b|\belentra\s*hd\b|النترا\s*(?:hd|اتش\s*دي)|إلينترا\s*(?:hd|اتش\s*دي)/i},
  {name:'Hyundai Verna',minYear:2016,manualOnly:false,url:'https://www.dubizzle.com.eg/en/vehicles/cars-for-sale/used/hyundai/model-verna/',re:/\bhyundai\s+verna\b|\bverna\b|هيونداي\s+فيرنا|فيرنا/i},
  {name:'Chevrolet Lanos',minYear:2016,manualOnly:false,url:'https://www.dubizzle.com.eg/en/vehicles/cars-for-sale/used/chevrolet/model-lanos/',re:/\bchevrolet\s+lanos\b|\blanos\b|شيفروليه\s+لانوس|لانوس/i},
  {name:'Chery Arrizo 5',minYear:2019,manualOnly:true,url:'https://www.dubizzle.com.eg/en/vehicles/cars-for-sale/used/chery/model-arrizo-5/',re:/\bchery\s+arrizo\s*5\b|\barrizo\s*5\b|شيري\s+اريزو\s*5|شيرى\s+أ?ريزو\s*5|اريزو\s*5/i},
];

const norm=s=>(s||'').toLowerCase().replace(/[\-_]/g,' ').replace(/\s+/g,' ').trim();
function ageHours(t=''){
  t=norm(t);
  if(/just now|moments ago|الآن|الان/.test(t)) return 0;
  let m=t.match(/(\d+)\s*(?:min|mins|minute|minutes|دقيقة|دقائق)/); if(m) return +m[1]/60;
  m=t.match(/(\d+)\s*(?:hr|hrs|hour|hours|ساعة|ساعات)/); if(m) return +m[1];
  if(/today|اليوم/.test(t)) return 0;
  if(/yesterday|أمس|امس/.test(t)) return 24;
  m=t.match(/(\d+)\s*(?:day|days|يوم|أيام|ايام)/); return m?+m[1]*24:null;
}
function after(lines,re){const i=lines.findIndex(x=>re.test(x));return i>=0?(lines[i+1]||''):''}
function agoLine(lines){return lines.find(x=>/(?:\d+\s*(?:minutes?|hours?|days?|mins?|hrs?)\s*ago|today|yesterday|منذ|اليوم|أمس|امس)/i.test(x))||''}
function location(lines,ago){const i=lines.indexOf(ago);if(i<1)return '';for(let j=i-1;j>=0&&j>=i-7;j--){const x=(lines[j]||'').trim();if(!x||/^[•·|]$/.test(x))continue;if(/^(benzine|diesel|electric|hybrid|natural gas|automatic|manual|fuel type|transmission|kilometers|mileage|year|condition|used)$/i.test(x))continue;return x;}return ''}
const isGreaterCairo=t=>/giza|الجيزة|جيزة|cairo|القاهرة|haram|هرم|dokki|دقي|mohandessin|مهندسين|agouza|عجوزة|6th? of october|6 october|october|اكتوبر|أكتوبر|zayed|زايد|faisal|فيصل|imbaba|امبابة|إمبابة|hadayek|حدائق|maryotaya|مريوطية|moneeb|منيب|warraq|وراق|boulaq|بولاق|omraneyah|العمرانية|nasr city|مدينة نصر|heliopolis|مصر الجديدة|maadi|المعادي|new cairo|القاهرة الجديدة|settlement|التجمع|tagamoa|mokattam|المقطم|shorouk|الشروق|badr|بدر|obour|العبور|ain shams|عين شمس|matariya|المطرية|shubra|شبرا|downtown|وسط|sayeda zeinab|السيدة زينب|zamalek|الزمالك|garden city|جاردن سيتي|madinaty|مدينتي|helwan|حلوان|sheraton|شيراتون|ramses|رمسيس|new nozha|النزهة/i.test(norm(t));

const seenPath=path.resolve('data/seen-dubizzle.json');
await fs.mkdir(path.dirname(seenPath),{recursive:true});
let seen=new Set();try{seen=new Set(JSON.parse(await fs.readFile(seenPath,'utf8')))}catch{}

async function send(i){
  const text=['🚗 إعلان سيارة مستعملة جديد',`🎯 السيارة: ${i.target}`,'🌐 المصدر: Dubizzle','',`📌 ${i.title}`,`📅 السنة: ${i.year}`,`🛣️ الكيلومترات: ${i.km}`,`⚙️ الفتيس: ${i.transmission||'غير ظاهر'}`,`💰 السعر: ${i.price}`,`🕐 نازل من: ${i.ago}`,`📍 المكان: ${i.loc}`,'✅ التحقق: صفحة موديل Used + القاهرة الكبرى + آخر 3 أيام',`🔗 رابط الإعلان: ${i.url}`].join('\n');
  const r=await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:CHAT,text,disable_web_page_preview:false})});
  if(!r.ok) throw new Error(`Telegram ${r.status}: ${await r.text()}`);
}

const browser=await chromium.launch({headless:true});
const ctx=await browser.newContext({locale:'en-US',timezoneId:'Africa/Cairo',viewport:{width:1920,height:1080},userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36'});
let pages=0,pagesWithCards=0,collected=0,sent=0,duplicates=0,old=0,wrongYear=0,manualRejected=0,parseRejected=0,outside=0,modelRejected=0;
const samples=[];

for(const target of TARGETS){
  const page=await ctx.newPage();
  try{
    await page.goto(target.url,{waitUntil:'domcontentloaded',timeout:60000});
    await page.waitForTimeout(1200);
    for(let i=0;i<6;i++){await page.mouse.wheel(0,2400);await page.waitForTimeout(200)}
    const cards=page.locator('li[aria-label="Listing"]');
    const count=await cards.count();pages++;if(count)pagesWithCards++;
    let found=[];
    if(count){
      found=await cards.evaluateAll(nodes=>nodes.map(card=>{
        const lines=(card.innerText||'').split('\n').map(x=>x.trim()).filter(Boolean);
        const a=card.querySelector('a[href^="/en/ad/"]')||card.querySelector('a[href*="/ad/"]');
        const href=a?.href||'';const id=href.match(/ID(\d+)\.html/i)?.[1]||'';
        const labelValue=re=>{const i=lines.findIndex(x=>re.test(x));return i>=0?(lines[i+1]||''):''};
        return {id,url:href.split('?')[0].split('#')[0],title:card.querySelector('a[title]')?.getAttribute('title')||'',price:card.querySelector('div[aria-label="Price"] span')?.textContent?.trim()||lines.find(x=>/^EGP\s/i.test(x))||'',year:labelValue(/^Year$/i),km:labelValue(/^(Kilometers|Mileage)$/i),transmission:labelValue(/^Transmission$/i),text:(card.innerText||'').trim()};
      }).filter(x=>x.id));
    }
    console.log(`Dubizzle structured ${target.name}: listingNodes=${count}, cards=${found.length}, finalUrl=${page.url()}`);
    collected+=found.length;
    for(const c of found){
      const key=`Dubizzle:${c.id}`;if(seen.has(key)){duplicates++;continue}
      const lines=c.text.split('\n').map(x=>x.trim()).filter(Boolean);
      const title=c.title||'';target.re.lastIndex=0;if(!target.re.test(`${title} ${c.text}`)){modelRejected++;continue}
      const year=Number(c.year||((c.text.match(/\b(?:19|20)\d{2}\b/)||[])[0]||0));if(!year||year<target.minYear){wrongYear++;continue}
      const km=c.km||after(lines,/^(Kilometers|Mileage)$/i);if(!km||!/\d/.test(km)){parseRejected++;continue}
      const transmission=c.transmission||after(lines,/^Transmission$/i);
      if(target.manualOnly&&!/manual|مانيوال|يدوي/i.test(transmission||c.text)){manualRejected++;continue}
      const ago=agoLine(lines);const age=ageHours(ago);if(age===null||age>72){old++;continue}
      const loc=location(lines,ago);if(!loc||!isGreaterCairo(loc)){outside++;continue}
      const price=c.price||lines.find(x=>/^EGP\s/i.test(x))||'';if(!price){parseRejected++;continue}
      await send({target:target.name,title,year,km,transmission,price,ago,loc,url:c.url});seen.add(key);sent++;
      if(samples.length<10)samples.push({id:c.id,target:target.name,title,year,transmission,ago,loc,price});
    }
  }catch(e){console.warn(`Dubizzle structured ${target.name}: ${e.message}`)}finally{await page.close()}
}
await fs.writeFile(seenPath,JSON.stringify([...seen].slice(-5000),null,2));
console.log(`Dubizzle structured pages=${pages}, pagesWithCards=${pagesWithCards}, collected=${collected}, duplicates=${duplicates}, modelRejected=${modelRejected}, wrongYear=${wrongYear}, manualRejected=${manualRejected}, oldOrAgeMissing=${old}, outside=${outside}, parseRejected=${parseRejected}, sent=${sent}`);
if(samples.length)console.log(`Dubizzle structured samples=${JSON.stringify(samples)}`);
await browser.close();