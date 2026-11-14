// Fixture server for browser-devtools.e2e.mjs (browser_audit and browser_export_test). Serves the HTML
// files in this folder plus endpoints whose cost a performance check should notice, on a free port.
//
//   /slow.css?ms=400     a stylesheet that answers after a delay (render-blocking when linked in <head>)
//   /big.js?kb=300       an uncompressed script of that size that also blocks the main thread ~250 ms
//   /api?ms=600          JSON after a delay
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const wait = ms => new Promise(r => setTimeout(r, ms));

export async function startDevtoolsServer({ port = 0, host = '127.0.0.1' } = {}) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (status, body, type) => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(body);
    };
    try {
      if (url.pathname === '/slow.css') {
        await wait(Number(url.searchParams.get('ms') ?? 400));
        return send(200, 'body { font: 15px/1.4 sans-serif; margin: 16px; } .muted { color: #b0b0b0; }', 'text/css');
      }
      if (url.pathname === '/big.js') {
        const kb = Number(url.searchParams.get('kb') ?? 300);
        const filler = `/* ${'x'.repeat(1000)} */\n`.repeat(kb);
        return send(200, `${filler}(function () { const end = performance.now() + 250; while (performance.now() < end) {} window.bigLoaded = true; })();`, 'text/javascript');
      }
      if (url.pathname === '/api') {
        await wait(Number(url.searchParams.get('ms') ?? 600));
        return send(200, JSON.stringify({ items: [1, 2, 3] }), 'application/json');
      }
      const file = normalize(join(here, url.pathname === '/' ? 'a11y.html' : url.pathname));
      if (!file.startsWith(here)) return send(403, 'forbidden', 'text/plain');
      send(200, await readFile(file), types[extname(file)] ?? 'application/octet-stream');
    } catch {
      send(404, 'not found', 'text/plain');
    }
  });
  await new Promise(resolve => server.listen(port, host, resolve));
  const actual = server.address().port;
  return { port: actual, url: `http://${host}:${actual}`, close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); }) };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const s = await startDevtoolsServer({ port: Number(process.argv[2] ?? 0) });
  console.log(`devtools fixtures: ${s.url}`);
}
