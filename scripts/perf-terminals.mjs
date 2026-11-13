#!/usr/bin/env node
// Measures what the terminal module costs in a running dev host's extension host: memory for the user's
// own terminals that print a lot, and CPU and event-loop stalls while one prints as fast as it can.
// Uses the dev-only tool debug_extension_eval, so it needs a dev host (scripts/dev-host.mjs).
//
//   node scripts/perf-terminals.mjs --name <dev host> [--terminals 8] [--lines 100000] [--yes-seconds 10]
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const name = opt('name', 'dev');
const terminals = Number(opt('terminals', 8));
const lines = Number(opt('lines', 100000));
const yesSeconds = Number(opt('yes-seconds', 10));

const call = (tool, input) => execFileSync(process.execPath, [join(root, 'scripts/mcp-call.mjs'), '--name', name, '--session', 'perf', tool, JSON.stringify(input)], { encoding: 'utf8' });
const evalJson = code => JSON.parse(call('debug_extension_eval', { code }));
const command = (command, cmdArgs) => call('debug_vscode_command', { command, args: cmdArgs });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const mb = n => `${(n / 1024 / 1024).toFixed(1)} MB`;

const stats = () =>
  evalJson(`
    if (!globalThis.__perfGc) {
      require('node:v8').setFlagsFromString('--expose-gc');
      globalThis.__perfGc = require('node:vm').runInNewContext('gc');
    }
    globalThis.__perfGc();
    globalThis.__perfGc();
    const m = process.memoryUsage();
    const c = process.cpuUsage();
    return { heap: m.heapUsed, external: m.external + m.arrayBuffers, rss: m.rss, cpuMs: (c.user + c.system) / 1000, terminals: vscode.window.terminals.length };
  `);

const before = stats();
console.log(`start: ${before.terminals} terminals, heap+external ${mb(before.heap + before.external)}, rss ${mb(before.rss)}`);
for (let i = 0; i < terminals; i++) {
  command('workbench.action.terminal.new');
  await sleep(1500);
  command('workbench.action.terminal.sendSequence', [{ text: `seq 1 ${lines} | sed 's/$/ some build output text to make a line longer/'\r` }]);
}
await sleep(8000);
const after = stats();
console.log(
  `${terminals} user terminals that printed ${lines} lines each (no agent ever used them): heap+external +${mb(after.heap + after.external - before.heap - before.external)} ` +
    `(${mb((after.heap + after.external - before.heap - before.external) / terminals)} per terminal), rss +${mb(after.rss - before.rss)}, CPU ${(after.cpuMs - before.cpuMs).toFixed(0)} ms`,
);

// Fast output: `yes` in one more user terminal for a few seconds; the extension host measures its own
// event-loop delay meanwhile.
command('workbench.action.terminal.new');
await sleep(1500);
evalJson(`
  const { monitorEventLoopDelay } = require('node:perf_hooks');
  globalThis.__perfHistogram = monitorEventLoopDelay({ resolution: 10 });
  globalThis.__perfHistogram.enable();
  globalThis.__perfCpu = process.cpuUsage();
  globalThis.__perfT0 = Date.now();
  globalThis.__perfPeak = 0;
  globalThis.__perfSampler = setInterval(() => (globalThis.__perfPeak = Math.max(globalThis.__perfPeak, process.memoryUsage().rss)), 100);
  return null;
`);
command('workbench.action.terminal.sendSequence', [{ text: `timeout ${yesSeconds} yes\r` }]);
await sleep(yesSeconds * 1000 + 1500);
const fast = evalJson(`
  const h = globalThis.__perfHistogram;
  h.disable();
  clearInterval(globalThis.__perfSampler);
  const c = process.cpuUsage(globalThis.__perfCpu);
  const wall = Date.now() - globalThis.__perfT0;
  return { cpuPercent: Math.round(((c.user + c.system) / 1000 / wall) * 100), maxDelayMs: Math.round(h.max / 1e6), p99DelayMs: Math.round(h.percentile(99) / 1e6), meanDelayMs: Math.round(h.mean / 1e6), peakRss: globalThis.__perfPeak };
`);
console.log(`\`yes\` for ${yesSeconds} s in a user terminal: extension host CPU ${fast.cpuPercent}%, event-loop delay mean ${fast.meanDelayMs} ms, p99 ${fast.p99DelayMs} ms, max ${fast.maxDelayMs} ms, peak rss ${mb(fast.peakRss)}`);
await sleep(2000);
const end = stats();
console.log(`after: heap+external ${mb(end.heap + end.external)}, rss ${mb(end.rss)}`);
