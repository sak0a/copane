// A tiny "company app" for test/e2e/browser-profiles.e2e.mjs: it logs you in with a cookie and shows
// who is logged in, so a test can tell which login store a tab uses. Served on a free port of 127.0.0.1;
// the same server is reachable as http://localhost:<port> too, a different site (for cross-origin frames).
//
//   import { startProfileServer } from '../fixtures/browser-profiles/server.mjs';
//   const server = await startProfileServer();   // server.url('/login?user=dev'), server.close()
//
// Or standalone: node test/fixtures/browser-profiles/server.mjs   (prints the base URL)
//
//   /                 "Logged in as <user>" (cookie `user`), or "Not logged in"; also the localStorage value
//   /login?user=x     sets the persistent cookie `user=x` (one day) and a session cookie, then shows /
//   /logout           clears both
//   /opener           a target=_blank link and a window.open button, both to /
//   /framed           embeds / of the other host (localhost <-> 127.0.0.1) in an iframe: a cross-origin frame
//   /basic            HTTP Basic authentication (any user, password "secret"), then who is logged in
//   /api/whoami       JSON {user} (mocked by the tests through browser_route)
//   /fetcher          fetches /api/whoami and shows the answer in #api
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const escape = value => String(value).replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`);
const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function whoPage(req) {
  const user = cookies(req).user;
  const who = user ? `Logged in as ${escape(user)}` : 'Not logged in';
  return page(
    who,
    `<h1 id="who">${who}</h1><p>localStorage: <span id="ls"></span></p>
     <script>document.getElementById('ls').textContent = localStorage.getItem('user') ?? '(none)';</script>`,
  );
}

export async function startProfileServer() {
  let port = 0;
  const server = createServer((req, res) => {
    const { pathname: path, searchParams: q } = new URL(req.url, 'http://x');
    const html = (body, headers = {}) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers });
      res.end(body);
    };
    const host = (req.headers.host ?? '').split(':')[0];
    switch (path) {
      case '/':
        return html(whoPage(req));
      case '/login': {
        const user = q.get('user') ?? 'someone';
        return html(
          page(`Logged in as ${escape(user)}`, `<h1 id="who">Logged in as ${escape(user)}</h1><script>localStorage.setItem('user', ${JSON.stringify(user)});</script>`),
          { 'set-cookie': [`user=${encodeURIComponent(user)}; Path=/; Max-Age=86400; SameSite=Lax`, `session=${encodeURIComponent(user)}; Path=/; SameSite=Lax`] },
        );
      }
      case '/logout':
        return html(page('Logged out', '<h1 id="who">Not logged in</h1><script>localStorage.removeItem("user");</script>'), {
          'set-cookie': ['user=; Path=/; Max-Age=0', 'session=; Path=/; Max-Age=0'],
        });
      case '/opener':
        return html(page('Opener', `<h1>Opener</h1><a id="blank" href="/?via=blank" target="_blank">open in new tab</a> <button id="open" onclick="window.open('/?via=script')">window.open</button>`));
      case '/framed': {
        const other = host === 'localhost' ? `http://127.0.0.1:${port}` : `http://localhost:${port}`;
        return html(page('Framed', `<h1>Framed</h1><iframe id="f" src="${other}/" style="width:500px;height:200px"></iframe>`));
      }
      case '/basic': {
        const auth = req.headers.authorization ?? '';
        const [scheme, encoded] = auth.split(' ');
        const [name, password] = scheme === 'Basic' && encoded ? Buffer.from(encoded, 'base64').toString().split(':') : [];
        if (password !== 'secret') {
          res.writeHead(401, { 'www-authenticate': 'Basic realm="profiles fixture"', 'content-type': 'text/plain' });
          return res.end('login required');
        }
        return html(page('Basic ok', `<h1 id="basic">Basic auth as ${escape(name)}</h1><p id="cookie">${escape(cookies(req).user ?? '(no cookie)')}</p>`));
      }
      case '/api/whoami':
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        return res.end(JSON.stringify({ user: cookies(req).user ?? null }));
      case '/fetcher':
        return html(page('Fetcher', `<h1>Fetcher</h1><p id="api">...</p><script>fetch('/api/whoami').then(r => r.text()).then(t => document.getElementById('api').textContent = t);</script>`));
      default:
        res.writeHead(404, { 'content-type': 'text/plain' });
        return res.end('not found');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    port,
    url: (path = '/') => `${base}${path}`,
    /** The same server under the other site name (a cross-origin frame of `base` pages). */
    otherUrl: (path = '/') => `http://localhost:${port}${path}`,
    close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = await startProfileServer();
  console.log(server.base);
}
