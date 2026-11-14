// A small company site with a real sign-in, for handing a tab to the user (browser-handoff.e2e.mjs).
// On 127.0.0.1 and a free port.
//
//   /            302 to /dashboard when signed in, else to /login?next=/dashboard
//   /login       a sign-in form (user name, password) that posts to /login
//   POST /login  checks the login: sets the session cookie "sid" (HttpOnly) and redirects to `next`;
//                a wrong login gets the form again with HTTP 401
//   /dashboard   "Welcome, <user>" when signed in, else 302 to /login
//   /spa         a single-page sign-in: user name, password and one-time code, sent by fetch() as JSON
//                to /api/token with the code in an "X-One-Time-Code" header; the answer carries a token.
//                The page does not navigate: it shows "Signed in as <user>" and keeps the form.
//   /plain       an ordinary page with nothing to sign in to
//
// `logins` lists the logins the server received (user, password, via), so a test can tell that what
// the user typed reached the site, and nothing else.
import { randomBytes } from 'node:crypto';
import http from 'node:http';

const page = (title, body) => `<!doctype html><meta charset="utf-8"><title>${title}</title><style>body{font:15px system-ui;margin:40px} input,button{font:inherit;display:block;margin:8px 0;padding:4px}</style>${body}`;

function loginForm(next, error) {
  return page(
    'Sign in — Fixture Corp',
    `<h1>Sign in</h1>${error ? '<p id="error">Wrong user name or password.</p>' : ''}
<form method="post" action="/login">
  <input type="hidden" name="next" value="${next.replace(/"/g, '&quot;')}">
  <label>User name <input id="user" name="username" autocomplete="username"></label>
  <label>Password <input id="pass" name="password" type="password" autocomplete="current-password"></label>
  <button id="submit" type="submit">Sign in</button>
</form>`,
  );
}

const SPA = page(
  'Fixture SPA',
  `<h1>Fixture SPA</h1>
<p id="status">Not signed in.</p>
<form id="f">
  <input id="user" autocomplete="username" placeholder="user">
  <input id="pass" type="password" placeholder="password">
  <input id="otp" autocomplete="one-time-code" placeholder="code">
  <button id="submit" type="submit">Sign in</button>
</form>
<script>
document.getElementById('f').addEventListener('submit', async event => {
  event.preventDefault();
  const username = document.getElementById('user').value;
  const password = document.getElementById('pass').value;
  const otp = document.getElementById('otp').value;
  console.log('signing in as ' + username + ' with code ' + otp);
  const r = await fetch('/api/token', { method: 'POST', headers: { 'content-type': 'application/json', 'x-one-time-code': otp }, body: JSON.stringify({ username, password }) });
  const answer = await r.json();
  document.getElementById('status').textContent = r.ok ? 'Signed in as ' + answer.user : 'Sign-in failed';
});
</script>`,
);

export async function startHandoffServer({ user = 'alice', password = 'correct horse 42', code = '914273' } = {}) {
  const sessions = new Map();
  const logins = [];
  const tokens = [];
  const cookieSession = req => {
    const sid = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
    return sid ? sessions.get(sid) : undefined;
  };
  const readBody = req =>
    new Promise(resolve => {
      let data = '';
      req.on('data', chunk => (data += chunk));
      req.on('end', () => resolve(data));
    });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers });
      res.end(body);
    };
    const signedIn = cookieSession(req);
    if (url.pathname === '/') return send(302, '', { location: signedIn ? '/dashboard' : '/login?next=/dashboard' });
    if (url.pathname === '/login' && req.method === 'POST') {
      const form = new URLSearchParams(await readBody(req));
      logins.push({ user: form.get('username'), password: form.get('password'), via: 'form' });
      if (form.get('username') !== user || form.get('password') !== password) return send(401, loginForm(form.get('next') || '/dashboard', true));
      const sid = randomBytes(12).toString('hex');
      sessions.set(sid, user);
      return send(302, '', { location: form.get('next') || '/dashboard', 'set-cookie': `sid=${sid}; HttpOnly; Path=/; SameSite=Lax` });
    }
    if (url.pathname === '/login') return send(200, loginForm(url.searchParams.get('next') || '/dashboard', false));
    if (url.pathname === '/dashboard') {
      if (!signedIn) return send(302, '', { location: '/login?next=/dashboard' });
      return send(200, page('Dashboard — Fixture Corp', `<h1>Welcome, ${signedIn}</h1><p>Your open issues: 3</p>`));
    }
    if (url.pathname === '/spa') return send(200, SPA);
    if (url.pathname === '/api/token' && req.method === 'POST') {
      let body = {};
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        // stays empty
      }
      logins.push({ user: body.username, password: body.password, code: req.headers['x-one-time-code'], via: 'fetch' });
      const ok = body.username === user && body.password === password && req.headers['x-one-time-code'] === code;
      const token = ok ? `tok_${randomBytes(16).toString('hex')}` : undefined;
      if (token) tokens.push(token);
      res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(ok ? { user, token } : { error: 'denied' }));
    }
    if (url.pathname === '/plain') return send(200, page('Plain page', '<h1>Plain page</h1><p>Nothing to sign in to.</p>'));
    send(404, page('Not found', '<h1>Not found</h1>'));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    port,
    user,
    password,
    code,
    logins,
    tokens,
    url: (path = '/') => `http://127.0.0.1:${port}${path}`,
    close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}
