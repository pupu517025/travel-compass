#!/usr/bin/env node
// Collect event candidates from curated official county and city calendars.
// New candidates stay Pending; matching records gain provenance without being duplicated.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EVENTS_PATH = resolve(ROOT, 'data/tourism-events.json');
const SOURCES_PATH = resolve(ROOT, 'data/county-event-sources.json');
const REPORT_PATH = resolve(ROOT, 'data/county-source-status.json');
const PREVIEW_PATH = resolve(ROOT, 'data/tourism-events-preview.js');
const ADMIN_DATA_PATH = resolve(ROOT, 'data/admin-events.js');
const TODAY = new Date().toLocaleDateString('sv-SE', { timeZone:'Asia/Taipei' });
const USER_AGENT = 'TravelCompassEventCollector/1.0 (+official public calendar aggregation)';

const taiwanContext = { window:{} };
vm.runInNewContext(await readFile(resolve(ROOT, 'data/taiwan.js'), 'utf8'), taiwanContext);
const TAIWAN = taiwanContext.window.TaiwanData;
const COUNTY_CENTERS = TAIWAN.countyCenter;
const DISTRICTS = Object.fromEntries(Object.entries(TAIWAN.countyData).map(([city, names]) => [city, names.split(' ')]));
const stripTags = value => decodeHtml(String(value || '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
const decodeHtml = value => String(value || '').replace(/&nbsp;|&#160;/gi,' ').replace(/&amp;/gi,'&').replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'").replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n))).replace(/&#x([\da-f]+);/gi,(_,n)=>String.fromCodePoint(parseInt(n,16)));
const normalTitle = value => stripTags(value).normalize('NFKC').replace(/20\d{2}/g,'').replace(/民國\s*\d{2,3}\s*年/g,'').toLowerCase().replace(/[\s\p{P}\p{S}]/gu,'');
const hash = value => createHash('sha1').update(value).digest('hex').slice(0,18);
const absoluteUrl = (href, base) => { try { const url = new URL(decodeHtml(href), base); return /^https?:$/.test(url.protocol) ? url.href : ''; } catch { return ''; } };

function fromDateParts(year, month, day) {
  let y = Number(year); if (y < 1900) y += 1911;
  const m = Number(month), d = Number(day);
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return '';
  const result = `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  return Number.isNaN(Date.parse(`${result}T00:00:00Z`)) ? '' : result;
}
function parseDates(text, defaultYear) {
  const found = [];
  const full = /((?:20\d{2}|1\d{2})\s*(?:[-/.年])\s*\d{1,2}\s*(?:[-/.月])\s*\d{1,2}\s*日?)/g;
  for (const match of text.matchAll(full)) {
    const nums = match[1].match(/\d+/g) || [];
    const value = fromDateParts(nums[0], nums[1], nums[2]);
    if (value) found.push({ value, index:match.index, end:match.index + match[0].length });
  }
  if (defaultYear) {
    const short = /(?<!\d)(\d{1,2})\s*[/.月]\s*(\d{1,2})\s*日?/g;
    for (const match of text.matchAll(short)) {
      if (found.some(item => match.index >= item.index && match.index < item.end)) continue;
      const value = fromDateParts(defaultYear, match[1], match[2]);
      if (value) found.push({ value, index:match.index, end:match.index + match[0].length });
    }
  }
  return [...new Map(found.sort((a,b)=>a.index-b.index).map(item=>[item.value,item])).values()];
}
function eventDateSpan(text, defaultYear) {
  const dates=parseDates(text,defaultYear);
  if(!dates.length)return null;
  const abbreviated=text.match(/((?:20\d{2}|1\d{2})\s*[-/.年]\s*\d{1,2}\s*[-/.月]\s*\d{1,2})\s*(?:~|～|〜|至|到|–|—|-)\s*(\d{1,2})\s*日?/);
  if(abbreviated){
    const first=abbreviated[1].match(/\d+/g)||[];
    const start=fromDateParts(first[0],first[1],first[2]);
    const end=fromDateParts(first[0],first[1],abbreviated[2]);
    if(start&&end&&end>=start)return {start,end};
  }
  for(let i=0;i<dates.length-1;i++){
    const between=text.slice(dates[i].end,dates[i+1].index);
    if(between.length<=18&&/[~～〜至到–—-]/.test(between)&&dates[i+1].value>=dates[i].value)return {start:dates[i].value,end:dates[i+1].value};
  }
  return {start:dates[0].value,end:dates[0].value};
}
function pageYear(url) {
  const match = url.match(/[?&](?:year|y)=(\d{4}|1\d{2})/i);
  return match ? Number(match[1]) : Number(TODAY.slice(0,4));
}
function extractLocation(text, city, markup='') {
  let district = '';
  for (const item of DISTRICTS[city] || []) if (text.includes(item)) { district = item; break; }
  const lat = Number(markup.match(/(?:data-lat|latitude|lat)["'\s:=]+(-?\d{1,2}\.\d+)/i)?.[1]);
  const lng = Number(markup.match(/(?:data-lng|longitude|lon|lng)["'\s:=]+(-?\d{2,3}\.\d+)/i)?.[1]);
  const center = COUNTY_CENTERS[city] || [0,0];
  return { district, lat:Number.isFinite(lat)&&lat!==0?lat:center[0], lng:Number.isFinite(lng)&&lng!==0?lng:center[1], location_precision:lat&&lng?'event':'county' };
}
function classify(text) {
  return /自然|生態|戶外|賞花|健行|步道|山海|森林|親水/.test(text) ? '大自然' : /展覽|博物館|美術館|室內|劇場|藝文/.test(text) ? '室內' : '市區';
}
function cleanText(html) { return stripTags(html).replace(/\u200b/g,'').trim(); }

function makeEvent({title, description='', start, end=start, url, source, city, raw=''}) {
  title = cleanText(title).replace(/\s+/g,' ').trim();
  description = cleanText(description).slice(0,240);
  if (!title || title.length < 3 || title.length > 180 || !start || !end || end < TODAY || !city) return null;
  const place = extractLocation(`${title} ${description} ${cleanText(raw)}`, city, raw);
  return {
    id:`county_${hash(`${city}|${normalTitle(title)}|${start}|${end}`)}`,
    source_id:`${source.name}:${hash(`${normalTitle(title)}|${start}|${end}`)}`,
    source_hash:hash(`${normalTitle(title)}|${description}|${start}|${end}|${url}`),
    status:'Pending', title:/^20\d{2}/.test(title)?title:`${start.slice(0,4)} ${title}`,
    city, district:place.district, start_date:start, end_date:end,
    kid_friendly:/親子|兒童|家庭|小朋友|幼兒/.test(`${title} ${description}`),
    category:classify(`${title} ${description}`), summary:description.slice(0,50),
    lat:place.lat, lng:place.lng, location_precision:place.location_precision,
    source_url:url || source.url, source_name:source.name,
    source_refs:[{name:source.name,url:url || source.url}]
  };
}

function eventJsonLd(html, source) {
  const result=[];
  for (const match of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const root=JSON.parse(match[1].replace(/^\uFEFF/,''));
      const visit=value=>{
        if (!value || typeof value!=='object') return;
        const type=Array.isArray(value['@type'])?value['@type']:[value['@type']];
        if (type.some(item=>String(item).toLowerCase()==='event')) {
          const start=toIsoDate(value.startDate), end=toIsoDate(value.endDate)||start;
          const location=value.location||{};
          const city=source.city;
          const event=makeEvent({title:value.name,description:value.description,start,end,url:absoluteUrl(value.url||location.url||'',source.url),source,city,raw:JSON.stringify(location)});
          if(event) result.push(event);
        }
        if(Array.isArray(value)) value.forEach(visit); else Object.values(value).forEach(visit);
      };
      visit(root);
    } catch {}
  }
  return result;
}
function toIsoDate(value) {
  if (!value) return '';
  const match=String(value).match(/(20\d{2})[-/](\d{1,2})[-/](\d{1,2})/);
  return match?fromDateParts(match[1],match[2],match[3]):'';
}
function extractHtmlCandidates(html, source) {
  const found=[];
  const defaultYear=pageYear(source.url);
  const genericTitle=/^(?:首頁|更多|more|搜尋|search|查看詳情|看活動與周邊票卡|新聞訊息|教育訓練|主管會報|相關機關連結|施政報告|縣政相片|資訊安全宣告|登革熱防治專區|活動資訊|活動快訊|活動行事曆|活動年曆|好康報報)$/i;
  const nonEvent=/轉知|受理申請|補助作業|延長受理|報名至|截止|道路管制|交通管制|防治專區|政策宣導|招標|徵才|職缺|公告周知|施工|停班停課|消費者保護|防災宣導|申請須知|法規|活動報名系統|舉辦.*基金會|永續獎.*參與/;
  const eventSignal=/活動|節|祭|展|市集|音樂|表演|演出|路跑|馬拉松|競賽|藝術|觀光|體驗|講座|工作坊|嘉年華|燈節|花季|選拔|文化|走讀|健行|自行車|書展|親子|跨年|廟會|祭典|煙火|野餐|生活節|博覽會|音樂會|巡演|賞花|運動會|球賽|運動賽|創作|影展|戲劇|戲曲|手作|市民日|嘉年華|節慶|節日/;
  for (const link of html.matchAll(/<a\b([^>]*?)href\s*=\s*(["'])(.*?)\2([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    const href=absoluteUrl(link[3],source.url);
    let title=cleanText(link[5]).replace(/(?:20\d{2}\s*)?\d{1,2}[./]\d{1,2}\s*(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat|日|一|二|三|四|五|六)?/gi,' ').replace(/\b20\d{2}[./]\d{1,2}[./]\d{1,2}\s*\d{1,2}:\d{2}\b/g,' ').replace(/\b20\s*\.\s*\d{1,2}\s*\d{1,2}:\d{2}\b/g,' ').replace(/(?:開始報名|我要報名|尚未開放|報名截止)[\s\S]*$/,' ').replace(/\s+/g,' ').trim();
    title=title.slice(0,140);
    const urlHost=(()=>{try{return new URL(href).hostname}catch{return ''}})();
    if (!href || href===source.url || /facebook\.com|twitter\.com|x\.com|line\.me|instagram\.com/.test(urlHost) || title.length<4 || title.length>140 || genericTitle.test(title) || nonEvent.test(title) || !eventSignal.test(title)) continue;
    const otherCity=Object.keys(COUNTY_CENTERS).find(city=>city!==source.city&&title.includes(city));
    if(otherCity) continue;
    const index=link.index, left=Math.max(0,index-520), right=Math.min(html.length,index+link[0].length+520);
    let block=html.slice(left,right);
    const nearby=cleanText(block);
    const dateSpan=eventDateSpan(nearby,defaultYear);
    if(!dateSpan) continue;
    const {start,end}=dateSpan;
    if(start<TODAY&&end<TODAY) continue;
    let description=nearby.replace(title,'').replace(/20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}日?/g,' ').replace(/\s+/g,' ').trim();
    description=description.slice(0,160);
    const event=makeEvent({title,description,start,end,url:href,source,city:source.city,raw:block});
    if(event) found.push(event);
  }
  return found;
}
function parseEvents(html, source) {
  const structured=eventJsonLd(html,source);
  return structured.length ? structured : extractHtmlCandidates(html,source);
}
const EVENT_SIGNAL=/活動|節|祭|展|市集|音樂|表演|演出|路跑|馬拉松|競賽|藝術|觀光|體驗|講座|工作坊|嘉年華|燈節|燈會|花季|文化|走讀|健行|自行車|親子|跨年|耶誕|聖誕|祭典|煙火|野餐|生活節|博覽會|音樂會|賞花|手作|節慶|節日|舞展|舞台|交換|巡迴|晚會|演奏|放映|閱讀/;
async function fetchArticleListEvents(html, source) {
  const links=[];
  for(const match of html.matchAll(/<a\b[^>]*href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a\s*>/gi)){
    const url=absoluteUrl(match[2],source.url), title=cleanText(match[3]);
    const articleUrl=/[?&]sNo=04\d+/i.test(url)||/\/News_Content(?:2)?\.aspx\?/i.test(url);
    if(!url||!title||!EVENT_SIGNAL.test(title)||!articleUrl||links.some(item=>item.url===url))continue;
    links.push({url,title});
  }
  const found=[];
  for(const item of links.slice(0,15)){
    try{
      const response=await fetch(item.url,{headers:{'user-agent':USER_AGENT,accept:'text/html,application/xhtml+xml'},signal:AbortSignal.timeout(12000)});
      if(!response.ok)continue;
      const article=await response.text();
      const ogTitleTag=article.match(/<meta\b(?=[^>]*property=["']og:title["'])[^>]*>/i)?.[0]||'';
      const ogTitle=ogTitleTag.match(/content=["']([^"']*)["']/i)?.[1]||'';
      const heading=article.match(/<h3\b[^>]*>([\s\S]*?)<\/h3>/i)?.[1]||article.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
      const title=cleanText(ogTitle||heading||item.title).replace(/\s+/g,' ').trim();
      if(!EVENT_SIGNAL.test(title))continue;
      const rawText=cleanText(article);
      const titleAt=rawText.lastIndexOf(title);
      const content=(titleAt>=0?rawText.slice(titleAt+title.length):rawText).split(/上一則|下一則|回列表/)[0]
        .replace(/發布日期\s*[：:]?\s*\d{4}[-/]\d{1,2}[-/]\d{1,2}/g,' ')
        .replace(/最後更新日期\s*[：:]?\s*\d{4}[-/]\d{1,2}[-/]\d{1,2}/g,' ');
      const dateContext=content.match(/(?:活動時間|活動日期|活動期間|舉辦日期|展期|活動將於|活動自)[：:\s，,。]*[^。]{0,240}/g)?.join(' ')||'';
      let dateSpan=eventDateSpan(dateContext,TODAY.slice(0,4));
      if(dateSpan){
        const dates=parseDates(dateContext,TODAY.slice(0,4));
        if(dates.length>1&&/展期|延續|至|期間/.test(dateContext))dateSpan={start:dates[0].value,end:dates.at(-1).value};
      }
      if(!dateSpan)continue;
      const description=content.replace(/\s+/g,' ').trim().slice(0,240);
      const event=makeEvent({title,description,start:dateSpan.start,end:dateSpan.end,url:item.url,source,city:source.city,raw:article});
      if(event)found.push(event);
    }catch{}
  }
  return found;
}
function similarity(a,b) {
  if(a===b) return 1;
  const grams=value=>{const chars=[...value];const set=new Set();for(let i=0;i<chars.length-1;i++)set.add(chars[i]+chars[i+1]);return set;};
  const aa=grams(a),bb=grams(b); if(!aa.size||!bb.size)return 0;
  let common=0; for(const item of aa)if(bb.has(item))common++;
  return 2*common/(aa.size+bb.size);
}
function dateOverlap(a,b) {
  const aStart=Date.parse(`${a.start_date}T00:00:00Z`),aEnd=Date.parse(`${a.end_date}T00:00:00Z`),bStart=Date.parse(`${b.start_date}T00:00:00Z`),bEnd=Date.parse(`${b.end_date}T00:00:00Z`);
  return aStart<=bEnd+86400000 && bStart<=aEnd+86400000;
}
function mergeSources(target, incoming) {
  const refs=[...(target.source_refs||[]),...(incoming.source_refs||[])];
  target.source_refs=[...new Map(refs.filter(ref=>ref?.url).map(ref=>[ref.url,ref])).values()];
  if(!target.source_url)target.source_url=incoming.source_url;
  if(!target.source_name)target.source_name=incoming.source_name;
  return target;
}
function mergeDuplicate(events, candidate) {
  const title=normalTitle(candidate.title);
  const match=events.find(event=>event.city===candidate.city&&dateOverlap(event,candidate)&&similarity(title,normalTitle(event.title))>=0.84);
  if(match){mergeSources(match,candidate);return true;}
  events.push(candidate);return false;
}
async function fetchSource(source) {
  const started=Date.now();
  try {
    source={...source,url:source.url.replaceAll('{year}',TODAY.slice(0,4))};
    const response=await fetch(source.url,{headers:{'user-agent':USER_AGENT,accept:'text/html,application/xhtml+xml,application/ld+json,application/json;q=0.9,*/*;q=0.8'},signal:AbortSignal.timeout(12000)});
    if(!response.ok)throw new Error(`HTTP ${response.status}`);
    const html=await response.text();
    if(/Just a moment\.\.\.|Attention Required!|Cloudflare Ray ID/i.test(html.slice(0,6000)))throw new Error('網站阻擋自動讀取（Cloudflare）');
    const events=source.mode==='article-list'?await fetchArticleListEvents(html,source):parseEvents(html,source);
    return {source:source.name,city:source.city,url:source.url,status:'ok',http_status:response.status,bytes:Buffer.byteLength(html),candidates:events.length,elapsed_ms:Date.now()-started,events};
  } catch(error) {
    return {source:source.name,city:source.city,url:source.url,status:'error',error:error.message,elapsed_ms:Date.now()-started,events:[]};
  }
}
async function runPool(items,limit,worker) {
  const out=new Array(items.length);let next=0;
  await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{while(next<items.length){const index=next++;out[index]=await worker(items[index]);}}));
  return out;
}

const existing=JSON.parse(await readFile(EVENTS_PATH,'utf8'));
const sources=JSON.parse(await readFile(SOURCES_PATH,'utf8')).filter(source=>source.enabled);
const reports=await runPool(sources,4,fetchSource);
const events=existing.events||[];
let imported=0, duplicates=0;
for(const report of reports) for(const candidate of report.events) {
  if(mergeDuplicate(events,candidate)) duplicates++; else imported++;
}
existing.events=events; existing.count=events.length; existing.county_sources_updated_at=new Date().toISOString();
await writeFile(EVENTS_PATH,JSON.stringify(existing,null,2)+'\n','utf8');
const approved=events.filter(event=>event.status==='Approved');
await writeFile(PREVIEW_PATH,`window.LOCAL_APPROVED_EVENTS = ${JSON.stringify(approved)};\n`,'utf8');
await writeFile(ADMIN_DATA_PATH,`window.ADMIN_EVENTS = ${JSON.stringify(events)};\n`,'utf8');
const summary={fetched_at:new Date().toISOString(),sources:reports.map(({events,...report})=>report),source_count:sources.length,successful:reports.filter(report=>report.status==='ok').length,failed:reports.filter(report=>report.status==='error').length,candidates:reports.reduce((sum,report)=>sum+(report.candidates||0),0),new_pending:imported,merged_duplicates:duplicates,total_events:events.length,approved:approved.length};
await writeFile(REPORT_PATH,JSON.stringify(summary,null,2)+'\n','utf8');
console.log(`County sources: ${summary.successful}/${summary.source_count} reachable; ${summary.candidates} candidates; ${imported} new Pending, ${duplicates} merged as duplicates.`);
for(const report of reports) console.log(`${report.status==='ok'?'OK':'SKIP'} ${report.city} · ${report.source} · ${report.candidates||0} 筆${report.error?` · ${report.error}`:''}`);
