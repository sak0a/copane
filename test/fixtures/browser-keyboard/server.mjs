// Fixture server for browser-keyboard.e2e.mjs (browser_audit type "keyboard"). Serves the HTML files
// in this folder on a free port. `%OTHER%` in a page is replaced by `other` (the origin of a second
// server, e.g. on localhost, for a cross-origin frame), or by the server's own origin without one.
//
//   index.html      known problems: no skip link, invisible focus, unreachable controls, tabindex=3,
//                   shadow DOM, a same-origin and a cross-origin frame
//   trap.html       a widget that keeps Tab inside; ?dialog opens a modal <dialog>
//   skip.html       a skip link whose target does not exist
//   many.html       400 links (the step limit)
//   frame.html      the frames' content (?same: a link; ?cross: a button without a focus style)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

export async function startKeyboardServer({ port = 0, host = '127.0.0.1', other } = {}) {
  let origin = '';
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (status, body, type) => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(body);
    };
    try {
      const file = normalize(join(here, url.pathname === '/' ? 'index.html' : url.pathname));
      if (!file.startsWith(here) || file.endsWith('.mjs')) return send(403, 'forbidden', 'text/plain');
      let body = await readFile(file);
      if (extname(file) === '.html') body = body.toString('utf8').replaceAll('%OTHER%', other ?? origin);
      send(200, body, types[extname(file)] ?? 'application/octet-stream');
    } catch {
      send(404, 'not found', 'text/plain');
    }
  });
  await new Promise(resolve => server.listen(port, host, resolve));
  const actual = server.address().port;
  origin = `http://${host.includes(':') ? `[${host}]` : host}:${actual}`;
  return { port: actual, url: origin, close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); }) };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const other = await startKeyboardServer({ host: 'localhost' });
  const s = await startKeyboardServer({ port: Number(process.argv[2] ?? 0), other: other.url });
  console.log(`keyboard fixtures: ${s.url} (cross-origin frames from ${other.url})`);
}
