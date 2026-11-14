// Fixture page for test/e2e/browser-emulation.e2e.mjs, served on a free port of 127.0.0.1.
//
//   import { startEmulationServer } from '../fixtures/browser-emulation/server.mjs';
//   const server = await startEmulationServer();   // server.url('/'), server.close()
//
// Or standalone: node test/fixtures/browser-emulation/server.mjs   (prints the base URL)
//
// The page reports what it sees in `window.report()` (viewport, pixel ratio, media queries, touch,
// language, time zone, user agent) and in #facts, and shows a 4×4 grid of buttons that fill the
// viewport. Clicking a button writes its name into #last and window.lastClick, so a click by
// coordinates can be checked against the cell it should hit.
//
//   /long             a tall page (3000 px) for scrolling; window.scrollY tells how far it went
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const page = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Emulation fixture</title>
<style>
  html, body { margin: 0; height: 100%; font: 14px sans-serif; }
  body { background: #fff; color: #000; }
  @media (prefers-color-scheme: dark) { body { background: #000; color: #fff; } }
  #grid { position: fixed; inset: 0; display: grid; grid-template: repeat(4, 1fr) / repeat(4, 1fr); }
  #grid button { border: 1px solid #888; background: transparent; color: inherit; font: inherit; }
  #facts { position: fixed; left: 4px; top: 4px; pointer-events: none; white-space: pre; font-size: 11px; }
  #last { position: fixed; right: 4px; top: 4px; pointer-events: none; }
  .narrow-only { display: none; }
  @media (max-width: 600px) { .narrow-only { display: block; } }
</style></head><body>
<div id="grid"></div>
<div id="facts"></div>
<div id="last">none</div>
<p class="narrow-only" style="position:fixed;bottom:4px;left:4px">Narrow layout</p>
<script>
  const grid = document.getElementById('grid');
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
    const b = document.createElement('button');
    b.textContent = 'r' + r + 'c' + c;
    b.onclick = () => { window.lastClick = b.textContent; document.getElementById('last').textContent = b.textContent; };
    grid.appendChild(b);
  }
  window.report = () => ({
    width: innerWidth,
    height: innerHeight,
    dpr: devicePixelRatio,
    dark: matchMedia('(prefers-color-scheme: dark)').matches,
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
    coarse: matchMedia('(pointer: coarse)').matches,
    touchPoints: navigator.maxTouchPoints,
    language: navigator.language,
    numberFormat: new Intl.NumberFormat().format(1234.5),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    userAgent: navigator.userAgent,
  });
  const show = () => { document.getElementById('facts').textContent = JSON.stringify(window.report(), null, 1); };
  addEventListener('resize', show);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', show);
  show();
</script>
</body></html>`;

const long = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Long fixture</title></head>
<body style="margin:0"><div style="height:3000px;background:linear-gradient(#fff,#888)">top</div><p id="end">end</p></body></html>`;

export async function startEmulationServer() {
  const server = createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://x');
    if (pathname === '/long') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(long);
      return;
    }
    if (pathname !== '/') {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(page);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: (path = '/') => `http://127.0.0.1:${port}${path}`,
    close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = await startEmulationServer();
  console.log(server.url('/'));
}
