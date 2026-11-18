// Pages for test/e2e/ui-tab-groups.e2e.mjs: GET /<Title> returns a page titled <Title> with a button
// (#count) that counts its clicks, so a test can tell whether the page was reloaded (the count resets)
// while its tab was pinned and unpinned. /favicon.ico is 404.
import { createServer } from 'node:http';

/** Starts the server on a free port. Returns `{ url(title), close() }`. */
export async function startCounterServer() {
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/favicon.ico') {
      res.writeHead(404);
      return res.end();
    }
    const title = (decodeURIComponent(path.slice(1)) || 'Home').replace(/[<>&"]/g, '');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>${title}</title><h1>${title}</h1><button id="count" onclick="this.textContent = String(Number(this.textContent) + 1)">0</button>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: title => `http://127.0.0.1:${port}/${encodeURIComponent(title)}`,
    close: () =>
      new Promise(resolve => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
