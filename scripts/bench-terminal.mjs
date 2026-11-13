#!/usr/bin/env node
// Measures what the headless terminal mirror costs (src/extension/terminal/mirror.ts): heap per
// terminal with a full scrollback, and parse throughput for fast output (a build log, `yes`).
//
//   node --expose-gc scripts/bench-terminal.mjs
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = mkdtempSync(join(tmpdir(), 'copane-bench-'));
await build({ entryPoints: [join(root, 'src/extension/terminal/mirror.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(out, 'mirror.mjs'), logLevel: 'error' });
const { TerminalMirror } = await import(pathToFileURL(join(out, 'mirror.mjs')).href);
rmSync(out, { recursive: true, force: true });
if (!global.gc) {
  console.error('run with node --expose-gc');
  process.exit(1);
}
const heap = () => {
  global.gc();
  global.gc();
  const m = process.memoryUsage();
  return m.heapUsed + m.external;
};
const mb = n => `${(n / 1024 / 1024).toFixed(2)} MB`; // JS heap plus typed-array memory (xterm keeps cells in typed arrays)

// 1. Memory: N mirrors, each fed 5000 lines of a typical 100-character build log line.
const line = i => `[${String(i).padStart(5)}] \x1b[32mcompiling\x1b[0m src/components/module-${i % 97}/index.tsx ... done in ${i % 13} ms   \r\n`;
const N = 10;
const base = heap();
const mirrors = [];
for (let m = 0; m < N; m++) {
  const mirror = new TerminalMirror({ feed: 'stream', cols: 120, rows: 30 });
  let chunk = '';
  for (let i = 0; i < 5000; i++) chunk += line(i);
  await mirror.write(chunk);
  mirrors.push(mirror);
}
const full = heap();
console.log(`mirror with a full scrollback (4000 lines at 120 columns): ${mb((full - base) / N)} per terminal`);
for (const m of mirrors) m.dispose();
mirrors.length = 0;
const empty0 = heap();
for (let m = 0; m < N; m++) {
  const mirror = new TerminalMirror({ feed: 'stream', cols: 120, rows: 30 });
  await mirror.write('user@host ~ % ');
  mirrors.push(mirror);
}
console.log(`mirror of a terminal that printed one prompt: ${mb((heap() - empty0) / N)} per terminal`);
for (const m of mirrors) m.dispose();

// 2. Throughput: `yes` output (2 bytes per line) and a build log, 32 MB each, in 64 kB chunks.
async function throughput(label, make) {
  const mirror = new TerminalMirror({ feed: 'stream', cols: 120, rows: 30 });
  const chunk = make();
  const total = 32 * 1024 * 1024;
  const cpu0 = process.cpuUsage();
  const t0 = performance.now();
  let lag = 0;
  let last = performance.now();
  const probe = setInterval(() => {
    const now = performance.now();
    lag = Math.max(lag, now - last - 5);
    last = now;
  }, 5);
  for (let sent = 0; sent < total; sent += chunk.length) mirror.write(chunk);
  await mirror.flush();
  clearInterval(probe);
  const ms = performance.now() - t0;
  const cpu = process.cpuUsage(cpu0);
  console.log(`${label}: ${(total / 1024 / 1024 / (ms / 1000)).toFixed(1)} MB/s, ${((cpu.user + cpu.system) / 1000).toFixed(0)} ms CPU for 32 MB, longest event-loop stall ${lag.toFixed(0)} ms`);
  mirror.dispose();
}
await throughput('yes', () => 'y\r\n'.repeat(64 * 1024 / 3));
let log = '';
for (let i = 0; log.length < 64 * 1024; i++) log += line(i);
await throughput('build log', () => log);
