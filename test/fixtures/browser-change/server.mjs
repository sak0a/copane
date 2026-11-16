// Fixture server for browser-change.e2e.mjs (browser_check_change): a fake dev server with hot
// updates, on a free port. app.html loads app.js, which listens on the event stream /events the way
// a Vite client listens on its socket; POST /edit?mode=… is "the agent edited a file":
//
//   hmr      logs "[vite] hot updated: /src/app.js" after importing /src/app.js?t=<ms>, which repaints #panel
//   css      replaces the text of <style id="theme"> only (no console line): #box changes colour
//   error    imports /src/broken.js?t=<ms>, whose render() throws at line 4 (an uncaught TypeError)
//   404      a hot update of #panel that also fetches /api/missing (404)
//   overlay  shows a <vite-error-overlay> with a shadow root, as Vite does for a build error
//   reload   logs "[vite] page reload /app.html" and reloads; the page shows the new version
//   navigate goes to /app.html?page=2
//   none     nothing reaches the page
//
// Every edit bumps the version that app.html and plain.html (a page without hot reload) show.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export async function startChangeServer({ port = 0, host = '127.0.0.1' } = {}) {
  let version = 1;
  const clients = new Set();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (status, body, type) => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(body);
    };
    try {
      if (req.method === 'POST' && url.pathname === '/edit') {
        const mode = url.searchParams.get('mode') ?? 'hmr';
        version++;
        if (mode !== 'none') for (const c of clients) c.write(`data: ${JSON.stringify({ mode, version })}\n\n`);
        return send(200, JSON.stringify({ mode, version, clients: clients.size }), 'application/json');
      }
      if (url.pathname === '/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(': connected\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (url.pathname === '/favicon.ico') return send(204, '', 'image/x-icon');
      if (url.pathname === '/api/missing') return send(404, JSON.stringify({ error: 'not found' }), 'application/json');
      if (url.pathname === '/' || url.pathname === '/app.html' || url.pathname === '/plain.html') {
        const file = url.pathname === '/plain.html' ? 'plain.html' : 'app.html';
        const html = (await readFile(join(here, file), 'utf8')).replaceAll('{{version}}', String(version));
        return send(200, html, 'text/html; charset=utf-8');
      }
      if (url.pathname === '/app.js') return send(200, await readFile(join(here, 'app.js')), 'text/javascript');
      if (url.pathname === '/src/app.js') return send(200, await readFile(join(here, 'src', 'app.js')), 'text/javascript');
      if (url.pathname === '/src/broken.js') return send(200, await readFile(join(here, 'src', 'broken.js')), 'text/javascript');
      send(404, 'not found', 'text/plain');
    } catch {
      send(500, 'server error', 'text/plain');
    }
  });
  await new Promise(resolve => server.listen(port, host, resolve));
  const actual = server.address().port;
  const base = `http://${host}:${actual}`;
  return {
    port: actual,
    url: base,
    /** Simulates an edit; resolves with how many pages were told. */
    edit: async mode => (await (await fetch(`${base}/edit?mode=${mode}`, { method: 'POST' })).json()),
    close: () =>
      new Promise(resolve => {
        for (const c of clients) c.end();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const s = await startChangeServer({ port: Number(process.argv[2] ?? 0) });
  console.log(`change fixtures: ${s.url}/app.html  (POST ${s.url}/edit?mode=hmr|css|error|404|overlay|reload|navigate|none)`);
}
