// A tiny page server for the UI e2e tests: GET /<Title> returns a page titled <Title>. With
// `url(title, { icon })` the page declares a site icon served here: "png" (a 16×16 PNG), "svg" (a
// plain SVG), "script-svg" (an SVG with a <script>) or "big-png" (a PNG over 32 KB). /favicon.ico is
// 404, so a page without a declared icon has none.
import { createServer } from 'node:http';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAHElEQVR4nGP4z8BAEmIY1TCqYVTDqIZRDcNXAwBrnz/x2fH3DwAAAABJRU5ErkJggg==', 'base64');
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="#e5532d"/></svg>';
const ICONS = {
  png: ['image/png', PNG],
  svg: ['image/svg+xml', SVG],
  'script-svg': ['image/svg+xml', SVG.replace('</svg>', '<script>document.title = "pwned"</script></svg>')],
  // A valid PNG start followed by padding: what counts is the size.
  'big-png': ['image/png', Buffer.concat([PNG, Buffer.alloc(40 * 1024, 7)])],
};

/** Starts the server on a free port. Returns `{ url(title, { icon }?), close() }`. */
export async function startPageServer() {
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/favicon.ico') {
      res.writeHead(404);
      return res.end();
    }
    const icon = /^\/_icon\/([\w-]+)$/.exec(path)?.[1];
    if (icon) {
      const [type, body] = ICONS[icon] ?? [];
      res.writeHead(type ? 200 : 404, type ? { 'content-type': type, 'cache-control': 'no-store' } : {});
      return res.end(body);
    }
    const title = decodeURIComponent(path.slice(1)) || 'Home';
    const declared = new URL(req.url ?? '/', 'http://x').searchParams.get('icon');
    const safe = title.replace(/[<>&"]/g, '');
    const link = declared && ICONS[declared] ? `<link rel="icon" href="/_icon/${declared}">` : '';
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>${safe}</title>${link}<h1>${safe}</h1>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: (title, { icon } = {}) => `http://127.0.0.1:${port}/${encodeURIComponent(title)}${icon ? `?icon=${icon}` : ''}`,
    close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}
