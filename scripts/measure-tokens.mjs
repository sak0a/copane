#!/usr/bin/env node
// Measures what the tools cost an agent in context: the size of the tool definitions, and of the
// navigate and snapshot results on real pages. Compare with the Playwright MCP server on the same pages.
//
//   node scripts/dev-host.mjs --name measure
//   node scripts/measure-tokens.mjs copane <url> [<url> ...]       # against the dev host "measure"
//   node scripts/measure-tokens.mjs playwright <url> [<url> ...]   # downloads @playwright/mcp
//
// Token counts are estimates (characters / 3.6). DUMP=1 writes each result to /tmp/copane-snap-<kind>-<n>.txt.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const [,, kind, ...urls] = process.argv;
const tok = s => Math.round(s.length / 3.6); // rough: JSON and YAML run ~3.6 chars per token
const transport = kind === 'copane'
  ? new StdioClientTransport({ command: process.execPath, args: [process.cwd() + '/dist/mcp-server.js'], env: { ...process.env, COPANE_HOME: '/tmp/copane-dev/measure/home' }, cwd: '/tmp/copane-dev/measure/ws', stderr: 'ignore' })
  : new StdioClientTransport({ command: 'npx', args: ['-y', '@playwright/mcp@latest', '--headless', '--isolated'], stderr: 'ignore' });
const c = new Client({ name: 'claude-code', version: '0' });
await c.connect(transport);
const { tools } = await c.listTools();
const real = tools.filter(t => !t.name.startsWith('debug_'));
const total = JSON.stringify(real);
console.log(`${kind}: ${real.length} tools, definitions ${total.length} chars ≈ ${tok(total)} tokens; instructions ${(c.getInstructions() ?? '').length} chars`);
const by = real.map(t => [t.name, JSON.stringify(t).length]).sort((a, b) => b[1] - a[1]);
console.log('  largest:', by.slice(0, 8).map(([n, l]) => `${n} ${l}`).join(', '));
const call = async (name, args) => { const r = await c.callTool({ name, arguments: args }, undefined, { timeout: 120000 }); return (r.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n'); };
for (const url of urls) {
  let nav, snap;
  if (kind === 'copane') {
    nav = await call(urls.indexOf(url) === 0 ? 'browser_open' : 'browser_navigate', { url });
    if (urls.indexOf(url) === 0) await call('browser_wait_for', { loadState: 'load' }).catch(() => {});
    snap = await call('browser_snapshot', {});
  } else {
    nav = await call('browser_navigate', { url });
    snap = await call('browser_snapshot', {});
  }
  console.log(`  ${url}\n    navigate result ${nav.length} chars ≈ ${tok(nav)} tok | snapshot ${snap.length} chars ≈ ${tok(snap)} tok`);
  if (process.env.DUMP) (await import('node:fs')).writeFileSync(`/tmp/copane-snap-${kind}-${urls.indexOf(url)}.txt`, nav + '\n=====\n' + snap);
}
if (kind === 'copane') await call('browser_close_tab', {}).catch(() => {});
await c.close();
