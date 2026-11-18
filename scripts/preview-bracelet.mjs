import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { renderPreview } from './bracelet-timeline.mjs';
import { InvalidBatch, openEncounterStore, projectEncounters } from './encounter-store.mjs';

const frontend = new URL('../Frontend.html', import.meta.url);
const port = Number(process.env.CLICK_PREVIEW_PORT || 8081);
const localData = new URL('../.click-preview/', import.meta.url);
const modules = new Map([
  ['/bracelet-controls.mjs', new URL('./bracelet-controls.mjs', import.meta.url)],
  ['/bracelet-client.mjs', new URL('./bracelet-client.mjs', import.meta.url)],
]);

await mkdir(localData, { recursive: true });
const store = openEncounterStore(fileURLToPath(new URL('encounters.sqlite', localData)));

async function timeline() {
  return projectEncounters(store.list(), store.profileNames());
}

async function batchBody(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 32 * 1024) throw new InvalidBatch('The sync request is too large.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new InvalidBatch('Send a valid JSON batch.');
  }
}

function json(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    .end(JSON.stringify(payload));
}

const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  const currentPort = server.address().port;
  if (![`localhost:${currentPort}`, `127.0.0.1:${currentPort}`].includes(request.headers.host)) {
    response.writeHead(403).end();
    return;
  }
  try {
    if (request.method === 'GET' && modules.has(request.url)) {
      const source = await readFile(modules.get(request.url), 'utf8');
      response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }).end(source);
      return;
    }
    if (request.method === 'GET' && ['/', '/Frontend.html'].includes(request.url)) {
      const [html, accounts] = await Promise.all([readFile(frontend, 'utf8'), timeline()]);
      const preview = renderPreview(html, accounts);
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(preview);
      return;
    }
    if (request.method === 'GET' && request.url === '/api/encounters/timeline') {
      json(response, 200, { timeline: await timeline() });
      return;
    }
    if (request.method === 'POST' && ['/api/encounters/batch', '/api/demo-profile'].includes(request.url)) {
      if (request.headers.origin !== `http://${request.headers.host}`
        || request.headers['content-type']?.split(';')[0] !== 'application/json') {
        json(response, 403, { error: 'Sync must start from the local Click page.' });
        return;
      }
      const body = await batchBody(request);
      if (request.url === '/api/demo-profile') {
        store.saveProfileName(body);
        json(response, 200, { timeline: await timeline() });
        return;
      }
      const acceptedEventIds = store.saveBatch(body);
      json(response, 200, { acceptedEventIds, timeline: await timeline() });
      return;
    }
    response.writeHead(404).end();
  } catch (error) {
    if (error instanceof InvalidBatch) {
      json(response, 400, { error: error.message });
      return;
    }
    console.error(error.message);
    json(response, 500, { error: 'The local Click server could not finish the request. Check the preview terminal.' });
  }
});

server.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
server.listen(port, '127.0.0.1', () => {
  console.log(`Click timeline preview: http://localhost:${server.address().port}`);
});
