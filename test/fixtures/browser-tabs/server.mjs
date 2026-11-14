// Fixture pages for test/e2e/browser-tabs.e2e.mjs, served on a free port of 127.0.0.1.
//
//   import { startFixtureServer } from '../fixtures/browser-tabs/server.mjs';
//   const server = await startFixtureServer();   // server.url('/plain'), server.close()
//
// Or standalone: node test/fixtures/browser-tabs/server.mjs   (prints the base URL)
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const page = (title, body, head = '') => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${head}</head><body>${body}</body></html>`;

const escape = value => String(value).replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`);

const routes = {
  // An ordinary page with something to click near the bottom-right corner, where the indicator sits.
  '/plain': () => ({
    body: page(
      'Plain fixture',
      `<h1>Plain fixture</h1><p id="clicks">0</p>
       <button id="corner" style="position:fixed;right:0;bottom:0;width:240px;height:60px" onclick="document.getElementById('clicks').textContent = String(Number(document.getElementById('clicks').textContent) + 1)">corner</button>`,
    ),
  }),
  // Opens a popup from a link and from script.
  '/opener': () => ({
    body: page(
      'Opener fixture',
      `<h1>Opener</h1><a id="blank" href="/popup" target="_blank">open popup</a>
       <button id="open" onclick="window.open('/popup?script')">window.open</button>`,
    ),
  }),
  // A page whose <title> (and so its editor tab label) is chosen by the test: /titled?t=Name
  '/titled': query => ({ body: page(escape(query.get('t') ?? 'Titled'), `<h1>${escape(query.get('t') ?? 'Titled')}</h1>`) }),
  '/popup': () => ({ body: page('Popup fixture', '<h1>Popup</h1>') }),
  // A hostile page: strict CSP with Trusted Types, styles that hide anything injected, and a script
  // that removes foreign nodes. The indicator must still show and work.
  '/hostile': () => ({
    headers: { 'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; require-trusted-types-for 'script'" },
    body: page(
      'Hostile fixture',
      `<h1>Hostile</h1>
       <script>
         new MutationObserver(() => {
           for (const el of [...document.documentElement.children]) if (el !== document.head && el !== document.body) el.remove();
         }).observe(document.documentElement, { childList: true });
         window.__copaneMarker = 'page';
       </script>`,
      `<style>html > div { display: none; } * { font-size: 40px !important; color: red !important; }</style>`,
    ),
  }),
};

export async function startFixtureServer() {
  const server = createServer((req, res) => {
    const { pathname: path, searchParams } = new URL(req.url, 'http://x');
    const route = routes[path];
    if (!route) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    const { body, headers = {} } = route(searchParams);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers });
    res.end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    host: `127.0.0.1:${port}`,
    url: path => `${base}${path}`,
    close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = await startFixtureServer();
  console.log(server.base);
}
