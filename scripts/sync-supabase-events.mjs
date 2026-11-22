#!/usr/bin/env node
// Upsert the locally synchronized event catalogue and preserve cloud moderation decisions.
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EVENTS_PATH = resolve(ROOT, 'data/tourism-events.json');
const PREVIEW_PATH = resolve(ROOT, 'data/tourism-events-preview.js');
const ADMIN_PATH = resolve(ROOT, 'data/admin-events.js');
const baseUrl = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const key = process.env.SUPABASE_SECRET_KEY || '';

if (!baseUrl || !key) {
  console.log('Supabase credentials not configured; cloud upload skipped.');
  process.exit(0);
}

const headers = { apikey:key, 'content-type':'application/json' };
const columns = ['id','source_id','source_hash','status','title','city','district','start_date','end_date','kid_friendly','category','summary','lat','lng','source_url','source_name','source_refs','location_precision','moderated_at','updated_at'];
const remote = [];
for (let offset = 0; ; offset += 1000) {
  const response = await fetch(`${baseUrl}/rest/v1/events?select=${columns.join(',')}&limit=1000&offset=${offset}`, { headers, signal:AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Could not read existing cloud statuses: HTTP ${response.status} ${await response.text()}`);
  const page = await response.json();
  remote.push(...page);
  if (page.length < 1000) break;
}
const remoteById = new Map(remote.map(event => [event.id, event]));
const catalog = JSON.parse(await readFile(EVENTS_PATH, 'utf8'));
const now = new Date().toISOString();

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

for (const event of catalog.events || []) {
  const previous = remoteById.get(event.id);
  if (previous && previous.source_hash === event.source_hash) {
    event.status = previous.status;
    if (previous.moderated_at) event.moderated_at = previous.moderated_at;
  }
  event.updated_at = previous?.updated_at || now;
}

const rows = (catalog.events || []).map(event => {
  const row = Object.fromEntries(columns.map(column => [column, event[column] ?? null]));
  row.source_refs = event.source_refs || [];
  row.kid_friendly = event.kid_friendly === true;
  return row;
});
const changedRows = [];
for (const row of rows) {
  const previous = remoteById.get(row.id);
  if (previous && columns.filter(column => column !== 'updated_at').every(column => stable(row[column]) === stable(previous[column]))) {
    row.updated_at = previous.updated_at;
  } else {
    row.updated_at = now;
    const event = catalog.events.find(item => item.id === row.id);
    event.updated_at = now;
    changedRows.push(row);
  }
}
for (let offset = 0; offset < changedRows.length; offset += 250) {
  const batch = changedRows.slice(offset, offset + 250);
  const url = `${baseUrl}/rest/v1/events?on_conflict=id`;
  const result = await fetch(url, { method:'POST', headers:{...headers, Prefer:'resolution=merge-duplicates,return=minimal'}, body:JSON.stringify(batch), signal:AbortSignal.timeout(30000) });
  if (!result.ok) throw new Error(`Cloud event upload failed: HTTP ${result.status} ${await result.text()}`);
}

await writeFile(EVENTS_PATH, JSON.stringify(catalog, null, 2) + '\n', 'utf8');
const approved = catalog.events.filter(event => event.status === 'Approved');
await writeFile(PREVIEW_PATH, `window.LOCAL_APPROVED_EVENTS = ${JSON.stringify(approved)};\n`, 'utf8');
await writeFile(ADMIN_PATH, `window.ADMIN_EVENTS = ${JSON.stringify(catalog.events)};\n`, 'utf8');
console.log(`Synchronized ${rows.length} events to Supabase (${changedRows.length} changed); ${approved.length} approved and ${rows.length - approved.length} awaiting review.`);
