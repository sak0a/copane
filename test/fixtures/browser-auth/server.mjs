// Fixtures for credential prompts and request mocking, all on 127.0.0.1 and free ports:
//
// startAuthServer(): an HTTP server whose paths ask for credentials the way company sites do.
//   /basic/...      Basic, realm "Fixture Basic"          /basic-api   Basic, realm "Fixture API" (JSON)
//   /digest/...     Digest (MD5), realm "Fixture Digest"  /negotiate   Negotiate only (Kerberos)
//   /ntlm           NTLM handshake: answers the type-1 message with a fixed challenge and accepts any
//                   type-3 message for the expected user (the password is not verified: there is no
//                   MD4 in modern OpenSSL, and what matters is whether the browser sends typed credentials)
//   /xhr            an open page that fetches /basic-api from script
//   /many?n=200     an open page that loads n small images (to measure the cost of interception)
//   /app            an open page with a button that fetches /api/cart and shows the outcome (?auto: at once)
//   /frame?src=URL  an open page that embeds URL in an iframe (cross-site when URL uses another host name)
//   /api/cart       JSON
// Every request is counted per path (`hits`), and the Authorization header of the last one is kept.
// `rejectNextLogin()` makes the next request with a valid Basic login get a 401 anyway (once), as when a
// server session ends: the browser then drops the login it had cached and asks again.
//
// startAuthProxy(): a forward HTTP proxy that answers 407 until it gets the right Proxy-Authorization,
// then forwards plain HTTP requests (and CONNECT tunnels). Hosts ending in ".proxy.test" are served by
// the proxy itself (plain HTTP), or tunnelled to 127.0.0.1:`tlsPort` (CONNECT), so no real network is
// needed. `setLogin()` changes the login and realm it expects, so a test can make it ask again.
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';

const html = (title, body = '') => `<!doctype html><meta charset="utf-8"><title>${title}</title><h1>${title}</h1>${body}`;
const md5 = s => createHash('md5').update(s).digest('hex');
const GIF = Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64');

function basicOk(header, user, password) {
  const m = /^Basic\s+(.+)$/i.exec(header ?? '');
  return !!m && Buffer.from(m[1], 'base64').toString('utf8') === `${user}:${password}`;
}

function parseDigest(header) {
  const out = {};
  for (const m of (header ?? '').replace(/^Digest\s+/i, '').matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]*))/g)) out[m[1]] = m[2] ?? m[3];
  return out;
}

/** Fields of an NTLM type-3 message (user and domain), or undefined. */
function ntlmType3User(buf) {
  if (buf.length < 64 || buf.toString('latin1', 0, 8) !== 'NTLMSSP\0' || buf.readUInt32LE(8) !== 3) return undefined;
  const field = offset => {
    const len = buf.readUInt16LE(offset);
    const at = buf.readUInt32LE(offset + 4);
    return buf.subarray(at, at + len);
  };
  const unicode = (buf.readUInt32LE(60) & 1) === 1;
  const str = b => (unicode ? b.toString('utf16le') : b.toString('latin1'));
  return { domain: str(field(28)), user: str(field(36)) };
}

/** A fixed NTLM type-2 (challenge) message, unicode, no target info. */
function ntlmType2() {
  const b = Buffer.alloc(48);
  b.write('NTLMSSP\0', 0, 'latin1');
  b.writeUInt32LE(2, 8);
  b.writeUInt16LE(0, 12); // target name: empty
  b.writeUInt16LE(0, 14);
  b.writeUInt32LE(48, 16);
  b.writeUInt32LE(0x00008201 | 0x00080000, 20); // unicode, NTLM, always sign, extended session security
  randomBytes(8).copy(b, 24);
  return b.toString('base64');
}

export async function startAuthServer({ user = 'alice', password = 'open sesame' } = {}) {
  const hits = new Map();
  const authorization = new Map();
  const nonce = randomBytes(8).toString('hex');
  let rejectNext = false;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;
    hits.set(path, (hits.get(path) ?? 0) + 1);
    if (req.headers.authorization) authorization.set(path, req.headers.authorization);
    const send = (status, type, body, headers = {}) => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...headers });
      res.end(body);
    };
    const challenge = (header, body = 'login required') => send(401, 'text/html', html('401 Unauthorized', `<p>${body}</p>`), { 'www-authenticate': header });

    if (path.startsWith('/basic/')) {
      const ok = basicOk(req.headers.authorization, user, password);
      if (ok && rejectNext) {
        rejectNext = false;
        return challenge('Basic realm="Fixture Basic", charset="UTF-8"', 'session ended');
      }
      if (!ok) return challenge('Basic realm="Fixture Basic", charset="UTF-8"');
      return send(200, 'text/html', html('Basic ok', `<p id="who">${user}</p>`));
    }
    if (path === '/basic-api') {
      if (!basicOk(req.headers.authorization, user, password)) return challenge('Basic realm="Fixture API"');
      return send(200, 'application/json', JSON.stringify({ ok: true, user }));
    }
    if (path.startsWith('/digest/')) {
      const d = parseDigest(req.headers.authorization);
      if (d.username === user && d.nonce === nonce) {
        const ha1 = md5(`${user}:Fixture Digest:${password}`);
        const ha2 = md5(`${req.method}:${d.uri}`);
        const expected = d.qop ? md5(`${ha1}:${d.nonce}:${d.nc}:${d.cnonce}:${d.qop}:${ha2}`) : md5(`${ha1}:${d.nonce}:${ha2}`);
        if (d.response === expected) return send(200, 'text/html', html('Digest ok'));
      }
      return challenge(`Digest realm="Fixture Digest", qop="auth", nonce="${nonce}", algorithm=MD5`);
    }
    if (path === '/negotiate') return challenge('Negotiate');
    if (path === '/ntlm') {
      const m = /^NTLM\s+(.+)$/i.exec(req.headers.authorization ?? '');
      const msg = m ? Buffer.from(m[1], 'base64') : undefined;
      if (msg && msg.length >= 12 && msg.readUInt32LE(8) === 1) return challenge(`NTLM ${ntlmType2()}`, 'ntlm challenge');
      const t3 = msg && ntlmType3User(msg);
      if (t3 && t3.user.toLowerCase() === user.toLowerCase()) return send(200, 'text/html', html('NTLM ok', `<p id="who">${t3.domain}\\${t3.user}</p>`));
      return challenge('NTLM');
    }
    if (path === '/xhr') {
      return send(200, 'text/html', html('XHR page', `<p id="out">loading</p><script>fetch('/basic-api').then(async r => { document.getElementById('out').textContent = r.status + ' ' + (await r.text()); }, e => { document.getElementById('out').textContent = 'error ' + e.message; });</script>`));
    }
    if (path === '/many') {
      const n = Math.min(2000, Number(url.searchParams.get('n') ?? 200));
      const tag = url.searchParams.get('t') ?? '';
      const imgs = Array.from({ length: n }, (_, i) => `<img src="/img/${i}.gif?t=${tag}" width="1" height="1">`).join('');
      return send(200, 'text/html', html(`Many ${n}`, imgs));
    }
    if (path.startsWith('/img/')) return send(200, 'image/gif', GIF);
    if (path === '/app') {
      return send(
        200,
        'text/html',
        html(
          'Cart app',
          `<button id="load" onclick="load()">Load cart</button><p id="out">idle</p>
<script>
async function load() {
  const out = document.getElementById('out');
  out.textContent = 'loading';
  const t = performance.now();
  try {
    const r = await fetch('/api/cart', { method: 'GET', headers: { 'x-app': 'fixture' } });
    out.textContent = 'status ' + r.status + ' body ' + (await r.text()) + ' after ' + Math.round(performance.now() - t) + ' ms';
  } catch (e) {
    out.textContent = 'network error ' + e.message;
  }
}
${url.searchParams.has('auto') ? 'load();' : ''}
</script>`,
        ),
      );
    }
    if (path === '/frame') return send(200, 'text/html', html('Frame host', `<iframe src="${(url.searchParams.get('src') ?? '').replace(/"/g, '&quot;')}" width="600" height="200"></iframe>`));
    if (path === '/api/cart') return send(200, 'application/json', JSON.stringify({ items: 2, seenHeader: req.headers['x-injected'] ?? null }));
    if (path === '/') return send(200, 'text/html', html('Auth fixture'));
    send(404, 'text/plain', 'not found');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    /** A second name for the same server, so "another host" can be tested. */
    url: (path = '/', host = '127.0.0.1') => `http://${host}:${port}${path}`,
    hits: path => hits.get(path) ?? 0,
    authorization: path => authorization.get(path),
    rejectNextLogin: () => {
      rejectNext = true;
    },
    reset: () => {
      hits.clear();
      authorization.clear();
    },
    close: () =>
      new Promise(resolve => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
}

export async function startAuthProxy({ user = 'proxyuser', password = 'proxy pass', realm = 'Fixture Proxy', port: listenPort = 0, tlsPort } = {}) {
  let challenges = 0;
  let forwarded = 0;
  const authorized = req => basicOk(req.headers['proxy-authorization'], user, password);
  const deny = res => {
    challenges++;
    res.writeHead(407, { 'proxy-authenticate': `Basic realm="${realm}"`, 'content-type': 'text/html' });
    res.end(html('407 Proxy Authentication Required'));
  };
  const server = http.createServer((req, res) => {
    if (!authorized(req)) return deny(res);
    forwarded++;
    let target;
    try {
      target = new URL(req.url);
    } catch {
      res.writeHead(400).end('absolute URL expected');
      return;
    }
    if (target.hostname.endsWith('.proxy.test')) {
      res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
      res.end(html('Through the proxy', `<p>${target.hostname}</p>`));
      return;
    }
    const headers = { ...req.headers };
    delete headers['proxy-authorization'];
    delete headers['proxy-connection'];
    const upstream = http.request({ host: target.hostname, port: target.port || 80, method: req.method, path: target.pathname + target.search, headers }, up => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    });
    upstream.on('error', () => res.writeHead(502).end('bad gateway'));
    req.pipe(upstream);
  });
  // Tunnels are not tracked by the HTTP server, so close() would wait for the browser to drop them.
  const sockets = new Set();
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('connect', (req, socket, head) => {
    if (!authorized(req)) {
      challenges++;
      socket.end(`HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="${realm}"\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    forwarded++;
    const [host, port] = req.url.split(':');
    const local = host.endsWith('.proxy.test');
    if (local && !tlsPort) return void socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
    const upstream = net.connect(local ? tlsPort : Number(port) || 443, local ? '127.0.0.1' : host, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    sockets.add(upstream);
    upstream.on('close', () => sockets.delete(upstream));
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });
  await new Promise(resolve => server.listen(listenPort, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    port,
    stats: () => ({ challenges, forwarded }),
    setLogin: (u, p, r = realm) => {
      user = u;
      password = p;
      realm = r;
    },
    close: () =>
      new Promise(resolve => {
        server.close(resolve);
        for (const s of sockets) s.destroy();
      }),
  };
}

// `node test/fixtures/browser-auth/server.mjs` runs both and prints their ports, for probing by hand.
if (import.meta.url === `file://${process.argv[1]}`) {
  const s = await startAuthServer();
  const p = await startAuthProxy();
  console.log(JSON.stringify({ server: s.origin, proxyPort: p.port }));
}
