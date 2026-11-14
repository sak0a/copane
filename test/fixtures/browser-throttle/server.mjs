// Fixture for test/e2e/browser-throttle.e2e.mjs: two local sites (127.0.0.1 and localhost, so the
// frame is a separate CDP target) on free ports.
//
//   import { startThrottleServers } from '../fixtures/browser-throttle/server.mjs';
//   const s = await startThrottleServers();   // s.url('/'), s.frameUrl('/frame'), s.close()
//
// Or standalone: node test/fixtures/browser-throttle/server.mjs   (prints the base URLs)
//
//   /             a page with a cross-origin iframe. window.measure(kb) fetches /blob?kb=<kb> and
//                 resolves {ms, ok, error}; window.cpu() times a fixed busy loop (ms);
//                 window.frame(op, kb) asks the frame: op "measure" (the same fetch, on its own
//                 site), "cpu" or "online" (its navigator.onLine).
//   /frame        the iframe page (answers postMessage {id, op, kb} with {id, result})
//   /blob?kb=N    N kB of text, no-store
//   /ping         a tiny JSON body
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const measureFn = `async function measure(kb) {
  const t = performance.now();
  try {
    const r = await fetch('/blob?kb=' + kb + '&t=' + Math.random(), { cache: 'no-store' });
    const text = await r.text();
    return { ms: Math.round(performance.now() - t), ok: r.ok, bytes: text.length };
  } catch (e) {
    return { ms: Math.round(performance.now() - t), ok: false, error: String(e) };
  }
}`;

const cpuFn = `function cpu() { const t = performance.now(); let x = 0; for (let i = 0; i < 2e7; i++) x += Math.sqrt(i); window.__x = x; return Math.round(performance.now() - t); }`;

const page = frameOrigin => `<!doctype html><html><head><meta charset="utf-8"><title>Throttle fixture</title></head><body>
<h1>Throttle fixture</h1>
<p id="online"></p>
<iframe id="f" title="Other site" width="300" height="120" src="${frameOrigin}/frame"></iframe>
<script>
  ${measureFn}
  ${cpuFn}
  window.measure = measure;
  window.cpu = cpu;
  const pending = new Map(); let next = 0;
  window.addEventListener('message', e => { const p = pending.get(e.data && e.data.id); if (p) { pending.delete(e.data.id); p(e.data.result); } });
  window.frame = (op, kb) => new Promise(resolve => { const id = ++next; pending.set(id, resolve); document.getElementById('f').contentWindow.postMessage({ id, op, kb }, '*'); });
  const show = () => (document.getElementById('online').textContent = navigator.onLine ? 'online' : 'offline');
  addEventListener('online', show); addEventListener('offline', show); show();
</script></body></html>`;

const framePage = `<!doctype html><html><head><meta charset="utf-8"><title>Frame</title></head><body><p>Frame on another site</p>
<script>
  ${measureFn}
  ${cpuFn}
  window.addEventListener('message', async e => {
    const d = e.data || {};
    const result = d.op === 'measure' ? await measure(d.kb) : d.op === 'cpu' ? cpu() : d.op === 'online' ? navigator.onLine : undefined;
    e.source.postMessage({ id: d.id, result }, '*');
  });
</script></body></html>`;

function serve(host, render) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (status, body, type) => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
      res.end(body);
    };
    if (url.pathname === '/blob') return send(200, 'x'.repeat(Math.max(0, Math.min(5000, Number(url.searchParams.get('kb')) || 1)) * 1024), 'text/plain');
    if (url.pathname === '/ping') return send(200, '{"pong":true}', 'application/json');
    if (url.pathname === '/frame') return send(200, framePage, 'text/html; charset=utf-8');
    if (url.pathname === '/') return send(200, render(), 'text/html; charset=utf-8');
    send(404, 'not found', 'text/plain');
  });
  return new Promise(resolve => server.listen(0, host, () => resolve(server)));
}

export async function startThrottleServers() {
  let frameOrigin = '';
  const main = await serve('127.0.0.1', () => page(frameOrigin));
  const other = await serve('localhost', () => page(frameOrigin));
  frameOrigin = `http://localhost:${other.address().port}`;
  const base = `http://127.0.0.1:${main.address().port}`;
  return {
    base,
    frameOrigin,
    url: path => base + path,
    frameUrl: path => frameOrigin + path,
    close: () => Promise.all([main, other].map(s => new Promise(r => (s.closeAllConnections?.(), s.close(r))))),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const s = await startThrottleServers();
  console.log(`${s.base}/  (frame from ${s.frameOrigin})`);
}
