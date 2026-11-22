import { createServer } from 'node:http';
import { readFile, rename, stat, writeFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const eventsPath = resolve(root, 'data/tourism-events.json');
const previewPath = resolve(root, 'data/tourism-events-preview.js');
const adminDataPath = resolve(root, 'data/admin-events.js');
const types = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.json':'application/json; charset=utf-8', '.css':'text/css; charset=utf-8', '.svg':'image/svg+xml' };
const sendJson = (response, status, value) => { response.writeHead(status, { 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' }); response.end(JSON.stringify(value)); };
async function saveJson(path, value) {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8');
  await rename(temporary, path);
}
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (pathname === '/api/events' && request.method === 'GET') {
      response.writeHead(200, { 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' });
      response.end(await readFile(eventsPath));
      return;
    }
    if (pathname === '/api/events/status' && request.method === 'POST') {
      let body = '';
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 16384) { sendJson(response, 413, { error:'Request too large' }); return; }
      }
      let update;
      try { update = JSON.parse(body); } catch { sendJson(response, 400, { error:'Invalid JSON' }); return; }
      if (!update?.id || !['Approved','Pending','Rejected'].includes(update.status)) { sendJson(response, 400, { error:'Invalid activity status update' }); return; }
      const data = JSON.parse(await readFile(eventsPath, 'utf8'));
      const event = data.events.find(item => item.id === update.id);
      if (!event) { sendJson(response, 404, { error:'Activity not found' }); return; }
      event.status = update.status;
      event.moderated_at = new Date().toISOString();
      data.updated_at = event.moderated_at;
      data.count = data.events.length;
      await saveJson(eventsPath, data);
      const approved = data.events.filter(item => item.status === 'Approved');
      await writeFile(previewPath, `window.LOCAL_APPROVED_EVENTS = ${JSON.stringify(approved)};\n`, 'utf8');
      await writeFile(adminDataPath, `window.ADMIN_EVENTS = ${JSON.stringify(data.events)};\n`, 'utf8');
      sendJson(response, 200, { ok:true, event, approved_count:approved.length, pending_count:data.events.filter(item => item.status === 'Pending').length });
      return;
    }
    const target = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (target !== root && !target.startsWith(root + sep)) throw new Error('Forbidden');
    if (!(await stat(target)).isFile()) throw new Error('Not found');
    response.writeHead(200, { 'content-type':types[extname(target)] || 'application/octet-stream', 'cache-control':'no-cache' });
    response.end(await readFile(target));
  } catch {
    response.writeHead(404, { 'content-type':'text/plain; charset=utf-8' });
    response.end('Not found');
  }
});
const port = Number(process.env.PORT || 8000);
function listen(candidate) {
  const onError = error => {
    server.off('error', onError);
    if (error.code === 'EADDRINUSE' && !process.env.PORT && candidate < port + 10) return listen(candidate + 1);
    throw error;
  };
  server.once('error', onError);
  server.listen(candidate, '127.0.0.1', () => console.log(`旅遊不卡卡預覽：http://127.0.0.1:${candidate}`));
}
listen(port);
