// A tiny page server for the UI e2e test: GET /<Title> returns a page titled <Title>.
import { createServer } from 'node:http';

/** Starts the server on a free port. Returns `{ url(title), close() }`. */
export async function startPageServer() {
  const server = createServer((req, res) => {
    const title = decodeURIComponent((req.url ?? '/').slice(1).split('?')[0]) || 'Home';
    const safe = title.replace(/[<>&"]/g, '');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>${safe}</title><h1>${safe}</h1>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: title => `http://127.0.0.1:${port}/${encodeURIComponent(title)}`,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}
