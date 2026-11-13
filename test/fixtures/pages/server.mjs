// Fixture server for the page-tool e2e test. Serves the HTML files in this folder plus a few dynamic
// endpoints, on a free port. Usable standalone: `node test/fixtures/pages/server.mjs` prints the URL.
//
//   /slow?ms=2000        responds after a delay (JSON)
//   /status/<code>       responds with that status
//   /json                small JSON body
//   /echo                echoes method, headers and body (JSON)
//   /hang                never responds (until the server stops)
//   /redirect?to=<path>  302 to <path>
//   /upload              accepts a multipart upload and reports the file names and sizes
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.txt': 'text/plain' };

/** Starts the server on `port` (0 = free port) and `host`. Returns `{ url, port, close }`. */
export async function startFixtureServer({ port = 0, host = '127.0.0.1' } = {}) {
  const hanging = new Set();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (status, body, type = 'application/json') => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-fixture': 'yes' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    try {
      if (url.pathname === '/slow') {
        const ms = Number(url.searchParams.get('ms') ?? 1000);
        await new Promise(r => setTimeout(r, ms));
        return send(200, { slow: ms });
      }
      if (url.pathname.startsWith('/status/')) return send(Number(url.pathname.slice(8)) || 500, { status: url.pathname.slice(8) });
      if (url.pathname === '/json') return send(200, { items: [1, 2, 3], name: 'fixture' });
      if (url.pathname === '/hang') return void hanging.add(res);
      if (url.pathname === '/redirect') {
        res.writeHead(302, { location: url.searchParams.get('to') ?? '/' });
        return res.end();
      }
      if (url.pathname === '/echo' || url.pathname === '/upload') {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const body = Buffer.concat(chunks);
        if (url.pathname === '/upload') {
          const names = [...body.toString('latin1').matchAll(/filename="([^"]*)"/g)].map(m => m[1]);
          return send(200, `<!doctype html><title>Uploaded</title><h1>Uploaded</h1><p id="files">${names.join(', ')}</p><p>${body.length} bytes</p>`, 'text/html');
        }
        return send(200, { method: req.method, headers: req.headers, body: body.toString('utf8') });
      }
      const file = normalize(join(here, url.pathname === '/' ? 'index.html' : url.pathname));
      if (!file.startsWith(here)) return send(403, 'forbidden', 'text/plain');
      const data = await readFile(file);
      res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(data);
    } catch {
      send(404, 'not found', 'text/plain');
    }
  });
  await new Promise(resolve => server.listen(port, host, resolve));
  const actual = server.address().port;
  return {
    port: actual,
    url: `http://${host.includes(':') ? `[${host}]` : host}:${actual}`,
    close: () =>
      new Promise(resolve => {
        for (const res of hanging) res.destroy();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.argv[2] ?? 0);
  const a = await startFixtureServer({ port });
  const b = await startFixtureServer({ host: 'localhost' });
  const c = await startFixtureServer({ host: '::1' });
  console.log(`fixtures: ${a.url}  (second origin: ${b.url}, third: ${c.url})`);
  console.log(`cross-origin frames: ${a.url}/xframes.html?b=${encodeURIComponent(b.url)}&c=${encodeURIComponent(c.url)}`);
}
