// Fixture for test/e2e/browser-har.e2e.mjs: a page whose traffic carries every kind of secret a HAR
// export must mask, plus a cross-origin frame. Two local sites (127.0.0.1 and localhost) on free ports.
//
//   import { startHarServers, SECRETS } from '../fixtures/browser-har/server.mjs';
//   const s = await startHarServers();   // s.url('/'), s.close()
//
// Or standalone: node test/fixtures/browser-har/server.mjs   (prints the base URL)
//
//   /             sets cookies (sid, theme); its script reads the secrets from /config (JSON with
//                 secret-named keys, so no secret is in the HTML), calls /api/items with a token in the
//                 query, an X-Api-Key and an Authorization header (the JSON answer has an access_token),
//                 posts a login form with a password, loads /pixel.png and /big (3 MB); window.done
//                 resolves when all of that and the frame's request finished. Has a cross-origin <iframe>.
//   /frame        the iframe page (on the other site); it calls /frame-api.
//   /handoff      after 1.5 s, reads /handoff-config and calls /api/token?code=<HANDOFF secret>, then
//                 shows "Signed in".
//   /second       a plain page (for "bodies of an earlier page").
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

/** Values that must not be in a HAR written with default options. */
export const SECRETS = {
  cookie: 'COOKIE-SECRET-1234',
  query: 'QUERY-SECRET-5678',
  header: 'HEADER-SECRET-9012',
  authorization: 'AUTH-SECRET-3456',
  bodyToken: 'BODY-SECRET-7890',
  password: 'FORM-SECRET-2345',
  handoff: 'HANDOFF-SECRET-6789',
};

// A 1×1 PNG.
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const page = frameOrigin => `<!doctype html><html><head><meta charset="utf-8"><title>HAR fixture</title></head><body>
<h1>HAR fixture</h1>
<img src="/pixel.png" alt="pixel">
<iframe id="f" title="Other site" width="300" height="100" src="${frameOrigin}/frame"></iframe>
<script>
  const frameDone = new Promise(resolve => addEventListener('message', e => { if (e.data === 'frame-done') resolve(); }));
  window.done = fetch('/config').then(r => r.json()).then(c => Promise.all([
    fetch('/api/items?q=shoes&access_token=' + c.access_token, { headers: { 'X-Api-Key': c.api_key, Authorization: 'Bearer ' + c.auth_token } }).then(r => r.json()),
    fetch('/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'user=ann&password=' + c.password + '&remember=1' }).then(r => r.text()),
    fetch('/big').then(r => r.text()),
    frameDone,
  ])).then(() => 'done');
</script></body></html>`;

const framePage = `<!doctype html><html><head><meta charset="utf-8"><title>Frame</title></head><body><p>Frame</p>
<script>fetch('/frame-api?x=1').then(r => r.json()).then(() => parent.postMessage('frame-done', '*'));</script></body></html>`;

const handoffPage = `<!doctype html><html><head><meta charset="utf-8"><title>Hand-off</title></head><body><p id="s">Waiting</p>
<script>setTimeout(() => fetch('/handoff-config').then(r => r.json()).then(c => fetch('/api/token?code=' + c.code, { method: 'POST', body: 'code=' + c.code })).then(() => (document.getElementById('s').textContent = 'Signed in')), 1500);</script></body></html>`;

function serve(host, routes) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const route = routes[url.pathname];
    if (!route) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('not found');
    }
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const [status, headers, body] = route(url, Buffer.concat(chunks).toString('utf8'));
      res.writeHead(status, { 'cache-control': 'no-store', 'access-control-allow-origin': '*', ...headers });
      res.end(body);
    });
  });
  return new Promise(resolve => server.listen(0, host, () => resolve(server)));
}

const json = body => [200, { 'content-type': 'application/json' }, JSON.stringify(body)];
const html = body => [200, { 'content-type': 'text/html; charset=utf-8' }, body];

export async function startHarServers() {
  let frameOrigin = '';
  const main = await serve('127.0.0.1', {
    '/': () => [200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': [`sid=${SECRETS.cookie}; Path=/; HttpOnly`, 'theme=dark; Path=/'] }, page(frameOrigin)],
    '/config': () => json({ access_token: SECRETS.query, api_key: SECRETS.header, auth_token: SECRETS.authorization, password: SECRETS.password }),
    '/handoff-config': () => json({ code: SECRETS.handoff }),
    '/api/items': () => json({ items: [1, 2, 3], access_token: SECRETS.bodyToken }),
    '/login': (_url, body) => [200, { 'content-type': 'text/plain' }, `ok ${body.length}`],
    '/pixel.png': () => [200, { 'content-type': 'image/png' }, PIXEL],
    '/big': () => [200, { 'content-type': 'text/plain' }, 'b'.repeat(3_000_000)],
    '/handoff': () => html(handoffPage),
    '/api/token': () => json({ ok: true }),
    '/second': () => html('<!doctype html><title>Second</title><p>Second page</p>'),
  });
  const other = await serve('localhost', {
    '/frame': () => html(framePage),
    '/frame-api': () => json({ frame: true }),
  });
  frameOrigin = `http://localhost:${other.address().port}`;
  const base = `http://127.0.0.1:${main.address().port}`;
  return {
    base,
    frameOrigin,
    url: path => base + path,
    close: () => Promise.all([main, other].map(s => new Promise(r => (s.closeAllConnections?.(), s.close(r))))),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const s = await startHarServers();
  console.log(`${s.base}/  (frame from ${s.frameOrigin})`);
}
