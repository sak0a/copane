// An HTTPS server with a certificate no browser trusts: self-signed, generated for each run with
// openssl (present on macOS, Linux and Git for Windows). Nothing secret is stored in the repository.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function startSelfSignedServer() {
  const dir = mkdtempSync(join(tmpdir(), 'ab-cert-'));
  const key = join(dir, 'key.pem');
  const cert = join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
  const server = https.createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><title>Self-signed fixture</title><h1>self-signed ok</h1>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  rmSync(dir, { recursive: true, force: true });
  const { port } = server.address();
  return {
    /** `host` is "127.0.0.1" or "localhost": two names for the same server, so two hosts to approve. */
    url: (host, path = '/') => `https://${host}:${port}${path}`,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}
