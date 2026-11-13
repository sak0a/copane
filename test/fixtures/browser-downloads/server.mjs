// Fixture pages for test/e2e/browser-downloads.e2e.mjs, served on a free port of 127.0.0.1.
//
//   import { startDownloadServer } from '../fixtures/browser-downloads/server.mjs';
//   const server = await startDownloadServer();   // server.url('/'), server.close()
//
// Or standalone: node test/fixtures/browser-downloads/server.mjs   (prints the base URL)
//
//   /?delay=ms        links and buttons that start downloads; #late downloads `delay` ms after its click
//   /file?name=&size= a file of `size` bytes sent as an attachment named `name`
//   /slow?name=&ms=   an attachment sent in pieces over `ms` milliseconds (default 3000)
//   /broken?name=     an attachment whose connection is cut half way
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const escape = value => String(value).replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`);

const index = () => `<!doctype html><html><head><meta charset="utf-8"><title>Downloads fixture</title></head><body>
<h1>Downloads</h1>
<p><a id="report" href="/file?name=report.csv&size=2048" download>Download report</a></p>
<p><a id="same" href="/file?name=same.txt&size=10">Same name</a></p>
<p><a id="slow" href="/slow?name=slow.bin&ms=3000">Slow download</a></p>
<p><a id="broken" href="/broken?name=broken.bin">Broken download</a></p>
<p><button id="blob" onclick="
  const a = document.createElement('a');
  a.href = window.URL.createObjectURL(new Blob(['made,in,page\\n1,2,3\\n'], { type: 'text/csv' }));
  a.download = 'generated.csv';
  document.body.appendChild(a); a.click(); a.remove();
">Generate CSV</button></p>
<p><button id="late" onclick="
  setTimeout(async () => {
    const blob = await (await fetch('/file?name=late.txt&size=50')).blob();
    const a = document.createElement('a');
    a.href = window.URL.createObjectURL(blob);
    a.download = 'export.txt';
    document.body.appendChild(a); a.click(); a.remove();
  }, Number(new URLSearchParams(location.search).get('delay') ?? 2000));
">Export later</button></p>
</body></html>`;

function content(size) {
  const line = 'copane download fixture 0123456789abcdefghijklmnopqrstuvwxyz\n';
  return Buffer.from(line.repeat(Math.ceil(size / line.length)).slice(0, size));
}

const attachment = name => ({ 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${String(name).replace(/["\\\r\n]/g, '_')}"` });

export async function startDownloadServer() {
  const server = createServer((req, res) => {
    const { pathname: path, searchParams: q } = new URL(req.url, 'http://x');
    if (path === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(index());
    } else if (path === '/file') {
      const body = content(Number(q.get('size') ?? 100));
      res.writeHead(200, { ...attachment(q.get('name') ?? 'file.txt'), 'content-length': body.length });
      res.end(body);
    } else if (path === '/slow') {
      const total = 64 * 1024;
      const pieces = 8;
      const ms = Number(q.get('ms') ?? 3000);
      res.writeHead(200, { ...attachment(q.get('name') ?? 'slow.bin'), 'content-length': total });
      let sent = 0;
      const timer = setInterval(() => {
        res.write(content(total / pieces));
        if (++sent === pieces) {
          clearInterval(timer);
          res.end();
        }
      }, ms / pieces);
      res.on('close', () => clearInterval(timer));
    } else if (path === '/broken') {
      res.writeHead(200, { ...attachment(q.get('name') ?? 'broken.bin'), 'content-length': 100_000 });
      res.write(content(1000));
      setTimeout(() => res.destroy(), 300);
    } else {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end(`not found: ${escape(path)}`);
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: (path = '/') => `http://127.0.0.1:${port}${path}`,
    close: () => new Promise(resolve => server.close(() => resolve())),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = await startDownloadServer();
  console.log(server.url('/'));
}
