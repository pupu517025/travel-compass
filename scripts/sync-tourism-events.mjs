#!/usr/bin/env node
// Daily importer for the Tourism Administration public event JSON archive.
// New/changed records enter Pending; unchanged moderation decisions are preserved.
import { inflateRawSync } from 'node:zlib';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import vm from 'node:vm';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = resolve(ROOT, 'data/tourism-events.json');
const PREVIEW = resolve(ROOT, 'data/tourism-events-preview.js');
const ADMIN_DATA = resolve(ROOT, 'data/admin-events.js');
const SOURCE = 'https://media.taiwan.net.tw/XMLReleaseAll_public/v2.0/Zh_tw/Event-json.zip';
const TODAY = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
const COUNTY_NAMES = new Map([
  ['台北市','台北市'], ['臺北市','台北市'], ['台中市','台中市'], ['臺中市','台中市'],
  ['台南市','台南市'], ['臺南市','台南市'], ['台東縣','台東縣'], ['臺東縣','台東縣'],
  ['桃園市','桃園市'], ['新北市','新北市'], ['基隆市','基隆市'], ['新竹市','新竹市'],
  ['新竹縣','新竹縣'], ['苗栗縣','苗栗縣'], ['彰化縣','彰化縣'], ['南投縣','南投縣'],
  ['雲林縣','雲林縣'], ['嘉義市','嘉義市'], ['嘉義縣','嘉義縣'], ['高雄市','高雄市'],
  ['屏東縣','屏東縣'], ['宜蘭縣','宜蘭縣'], ['花蓮縣','花蓮縣'], ['澎湖縣','澎湖縣'],
  ['金門縣','金門縣'], ['連江縣','連江縣'],
]);
const text = value => typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
const key = value => String(value).toLowerCase().replace(/[^a-z0-9]/g, '');
function deepValue(object, names) {
  const wanted = new Set(names.map(key));
  if (!object || typeof object !== 'object') return undefined;
  for (const [name, value] of Object.entries(object)) if (wanted.has(key(name)) && value != null) return value;
  for (const value of Object.values(object)) {
    if (value && typeof value === 'object') { const found = deepValue(value, names); if (found != null) return found; }
  }
}
function dateOnly(value) {
  if (value == null) return '';
  if (typeof value === 'number') value = new Date(value).toISOString();
  const match = String(value).match(/(20\d{2})[-/]?(\d{2})[-/]?(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : '';
}
function listRecords(root) {
  const found = [];
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    if (!Array.isArray(value) && deepValue(value, ['EventID','EventId']) != null && deepValue(value, ['EventName']) != null) found.push(value);
    if (Array.isArray(value)) value.forEach(visit); else Object.values(value).forEach(visit);
  };
  visit(root);
  return [...new Map(found.map(item => [text(deepValue(item, ['EventID','EventId'])), item])).values()];
}
function unzipJson(buffer) {
  const eocdSignature = 0x06054b50;
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65558); i--) if (buffer.readUInt32LE(i) === eocdSignature) { eocd = i; break; }
  if (eocd < 0) throw new Error('Downloaded source is not a ZIP archive.');
  const entries = buffer.readUInt16LE(eocd + 10), directoryOffset = buffer.readUInt32LE(eocd + 16);
  let cursor = directoryOffset;
  const files = [];
  for (let i = 0; i < entries; i++) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Invalid ZIP directory.');
    const method = buffer.readUInt16LE(cursor + 10), compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28), extraLength = buffer.readUInt16LE(cursor + 30), commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    cursor += 46 + nameLength + extraLength + commentLength;
    if (!/\.json$/i.test(name)) continue;
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) continue;
    const localName = buffer.readUInt16LE(localOffset + 26), localExtra = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localName + localExtra;
    const compressed = buffer.subarray(start, start + compressedSize);
    const content = method === 0 ? compressed : method === 8 ? inflateRawSync(compressed) : null;
    if (content) files.push({ name, content });
  }
  if (!files.length) throw new Error('No JSON file found inside the official archive.');
  return files;
}
function toAppEvent(raw, oldById) {
  const id = text(deepValue(raw, ['EventID','EventId']));
  const originalTitle = text(deepValue(raw, ['EventName','Name']));
  const start = dateOnly(deepValue(raw, ['StartDateTime','StartDate','StartTime']));
  const end = dateOnly(deepValue(raw, ['EndDateTime','EndDate','EndTime'])) || start;
  if (!id || !originalTitle || !start || !end || end < TODAY) return null;
  const rawStatus = text(deepValue(raw, ['EventStatus','Status'])).toLowerCase();
  if (/cancel|postponed|suspend/.test(rawStatus)) return null;
  const address = deepValue(raw, ['PostalAddress','Address']) || {};
  const cityText = text(deepValue(address, ['City','County','縣市'])) || text(deepValue(raw, ['LocatedCities','City','County']));
  const city = COUNTY_NAMES.get(cityText) || cityText.replace(/^臺/, '台');
  const district = text(deepValue(address, ['Town','District','Township','鄉鎮區'])) || text(deepValue(raw, ['Town','District']));
  const lat = Number(deepValue(raw, ['PositionLat','Latitude','Lat']));
  const lng = Number(deepValue(raw, ['PositionLon','Longitude','Lng','Lon']));
  if (!city || !Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) return null;
  const description = text(deepValue(raw, ['Description','Summary'])).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  const summary = Array.from(description).slice(0, 50).join('');
  const classes = JSON.stringify(deepValue(raw, ['EventClasses','EventClass']) || '').toLowerCase();
  const classificationText = `${classes} ${originalTitle} ${description}`;
  const category = /nature|ecolog|自然|生態|戶外|賞花|健行|步道|山海/.test(classificationText) ? '大自然' : /indoor|展覽|博物館|美術館|室內|劇場/.test(classificationText) ? '室內' : '市區';
  const urlValue = deepValue(raw, ['WebsiteURL','CalendarURLs','SameAsURLs','URL']);
  const url = Array.isArray(urlValue) ? text(urlValue[0]?.URL || urlValue[0]) : text(urlValue?.URL || urlValue);
  const sourceHash = createHash('sha256').update(JSON.stringify({originalTitle,start,end,city,district,lat,lng,summary,url})).digest('hex');
  const old = oldById.get(id);
  const title = /^20\d{2}/.test(originalTitle) ? originalTitle : `${start.slice(0,4)} ${originalTitle}`;
  return { id, source_id:id, source_hash:sourceHash, status:old?.source_hash === sourceHash ? old.status : 'Pending', title, city, district, start_date:start, end_date:end,
    kid_friendly:/親子|兒童|家庭|親子友善/.test(`${originalTitle} ${summary}`), category, summary,
    lat, lng, source_url:/^https?:\/\//i.test(url) ? url : '', source_name:'交通部觀光署觀光資訊資料庫' };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: node scripts/sync-tourism-events.mjs [--file <Event-json.zip>] [--url <archive-url>]');
    return;
  }
  const fileIndex = args.indexOf('--file');
  const urlIndex = args.indexOf('--url');
  const localFile = fileIndex >= 0 ? resolve(args[fileIndex + 1] || '') : '';
  const sourceUrl = urlIndex >= 0 ? args[urlIndex + 1] : SOURCE;
  if (urlIndex >= 0 && !sourceUrl) throw new Error('Usage: node scripts/sync-tourism-events.mjs --url <archive-url>');
  let old = { events:[] };
  try { old = JSON.parse(await readFile(OUTPUT, 'utf8')); }
  catch {
    // The public deployment intentionally omits the full catalogue, but keeps
    // an approved-only snapshot so scheduled imports retain moderation state.
    try {
      const snapshot = { window:{} };
      vm.runInNewContext(await readFile(PREVIEW, 'utf8'), snapshot);
      old.events = snapshot.window.LOCAL_APPROVED_EVENTS || [];
    } catch {}
  }
  const oldById = new Map((old.events || []).map(event => [event.source_id || event.id, event]));
  let archive;
  if (fileIndex >= 0) {
    if (!args[fileIndex + 1]) throw new Error('Usage: node scripts/sync-tourism-events.mjs --file <path-to-Event-json.zip>');
    archive = await readFile(localFile);
  } else {
    const response = await fetch(sourceUrl, { headers:{'user-agent':'TravelCompass-EventSync/1.0'} });
    if (!response.ok) throw new Error(`Official archive download failed: HTTP ${response.status}`);
    archive = Buffer.from(await response.arrayBuffer());
  }
  const jsonFiles = unzipJson(archive);
  const records = jsonFiles.flatMap(file => listRecords(JSON.parse(file.content.toString('utf8').replace(/^\uFEFF/, ''))));
  const byEvent = new Map();
  for (const record of records) {
    const event = toAppEvent(record, oldById);
    if (!event) continue;
    const identity = `${event.city}|${event.district}|${event.title.normalize('NFKC').replace(/\s/g,'')}|${event.end_date}`;
    const prior = byEvent.get(identity);
    if (!prior || (!prior.source_url && event.source_url)) byEvent.set(identity, event);
  }
  const events = [...byEvent.values()];
  // County calendar records are maintained by the second importer. Preserve their
  // moderation decisions across daily Tourism Administration archive refreshes.
  const normalizeTitle = value => String(value || '').normalize('NFKC').replace(/20\d{2}/g, '').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
  const titleSimilarity = (a, b) => {
    if (a === b) return 1;
    const grams = value => new Set([...value].slice(0, -1).map((char, index) => char + [...value][index + 1]));
    const aa = grams(a), bb = grams(b);
    if (!aa.size || !bb.size) return 0;
    let common = 0;
    for (const gram of aa) if (bb.has(gram)) common++;
    return 2 * common / (aa.size + bb.size);
  };
  for (const prior of old.events || []) {
    if (!String(prior.id || '').startsWith('county_')) continue;
    const duplicate = events.find(event => event.city === prior.city && event.start_date <= prior.end_date && prior.start_date <= event.end_date && titleSimilarity(normalizeTitle(event.title), normalizeTitle(prior.title)) >= 0.84);
    if (duplicate) {
      duplicate.source_refs = [...new Map([...(duplicate.source_refs || []), ...(prior.source_refs || [])].filter(ref => ref?.url).map(ref => [ref.url, ref])).values()];
    } else events.push(prior);
  }
  const result = { source:localFile ? SOURCE : sourceUrl, fetched_at:new Date().toISOString(), count:events.length, events };
  await mkdir(dirname(OUTPUT), { recursive:true });
  await writeFile(OUTPUT, JSON.stringify(result, null, 2) + '\n', 'utf8');
  await writeFile(PREVIEW, `window.LOCAL_APPROVED_EVENTS = ${JSON.stringify(events)};\n`, 'utf8');
  await writeFile(ADMIN_DATA, `window.ADMIN_EVENTS = ${JSON.stringify(events)};\n`, 'utf8');
  const pending = events.filter(event => event.status === 'Pending').length;
  const approved = events.filter(event => event.status === 'Approved').length;
  console.log(`Imported ${events.length} unique current geocoded events from ${records.length} source records (${pending} pending review, ${approved} approved).`);
  console.log(`Output: ${OUTPUT}`);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
