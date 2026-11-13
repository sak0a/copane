#!/usr/bin/env node
// Measures what the tools cost an agent in context: the size of the tool definitions, of single
// navigate and snapshot results on real pages, and the total result size of scripted multi-step tasks
// (what an agent pays for the whole job, not for one call). Compare with the Playwright MCP server.
//
//   node scripts/dev-host.mjs --name measure
//   node scripts/measure-tokens.mjs copane [--name measure] [--tasks [--plain] [--only <task>]] [--out run.json] [<url> ...]
//   node scripts/measure-tokens.mjs playwright [<url> ...]      # downloads @playwright/mcp
//   node scripts/measure-tokens.mjs compare before.json after.json
//
// With no URLs, the pages measured are example.com, a Wikipedia article, a GitHub repository and
// Hacker News. --tasks also runs the tasks below (fixture pages are served by the script itself) and
// prints calls and result tokens per task. A task first tries the cheapest route the tools offer (a
// text-reading mode, a find tool, page changes in action results) and checks that the answer is really
// in what the agent got back; a task that fails its check is reported as failed, never as cheap.
//
// Token counts are estimates (characters / 3.6). DUMP=1 writes each result to /tmp/copane-measure/.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const kind = argv[0];
const opt = name => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const tok = s => Math.round(s.length / 3.6); // rough: JSON and YAML run ~3.6 chars per token

if (kind === 'compare') {
  compare(JSON.parse(readFileSync(argv[1], 'utf8')), JSON.parse(readFileSync(argv[2], 'utf8')));
  process.exit(0);
}

const DEFAULT_PAGES = ['https://example.com', 'https://en.wikipedia.org/wiki/Visual_Studio_Code', 'https://github.com/microsoft/playwright-mcp', 'https://news.ycombinator.com'];
const valueFlags = new Set(['--name', '--out']);
const urls = argv.slice(1).filter((a, i, all) => !a.startsWith('--') && !valueFlags.has(all[i - 1]));
const pages = urls.length ? urls : DEFAULT_PAGES;
const hostName = opt('name') ?? 'measure';
const hostDir = `/tmp/copane-dev/${hostName}`;
const dumpDir = '/tmp/copane-measure';
if (process.env.DUMP) mkdirSync(dumpDir, { recursive: true });

const transport =
  kind === 'copane'
    ? new StdioClientTransport({ command: process.execPath, args: [join(root, 'dist/mcp-server.js')], env: { ...process.env, COPANE_HOME: `${hostDir}/home`, COPANE_SESSION: `measure-${Date.now()}` }, cwd: `${hostDir}/ws`, stderr: 'ignore' })
    : new StdioClientTransport({ command: 'npx', args: ['-y', '@playwright/mcp@latest', '--headless', '--isolated'], stderr: 'ignore' });
const c = new Client({ name: 'claude-code', version: '0' });
await c.connect(transport);
const out = { kind, definitions: {}, pages: [], tasks: [] };

// ---------------------------------------------------------------- definitions
const { tools } = await c.listTools();
const real = tools.filter(t => !t.name.startsWith('debug_'));
const total = JSON.stringify(real);
const instructions = c.getInstructions() ?? '';
out.definitions = { tools: real.length, chars: total.length, instructions: instructions.length, byTool: Object.fromEntries(real.map(t => [t.name, JSON.stringify(t).length])) };
console.log(`${kind}: ${real.length} tools, definitions ${total.length} chars ≈ ${tok(total)} tokens; instructions ${instructions.length} chars`);
const by = real.map(t => [t.name, JSON.stringify(t).length]).sort((a, b) => b[1] - a[1]);
console.log('  largest:', by.slice(0, 8).map(([n, l]) => `${n} ${l}`).join(', '));
const toolNames = new Set(real.map(t => t.name));
const schemaOf = name => real.find(t => t.name === name)?.inputSchema?.properties ?? {};

let dumpN = 0;
const call = async (name, args = {}) => {
  const r = await c.callTool({ name, arguments: args }, undefined, { timeout: 120000 });
  const text = (r.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  if (process.env.DUMP) writeFileSync(`${dumpDir}/${kind}-${String(++dumpN).padStart(3, '0')}-${name}.txt`, `${JSON.stringify(args)}\n=====\n${text}`);
  return { text, isError: r.isError === true };
};

// ---------------------------------------------------------------- single pages
for (const [i, url] of pages.entries()) {
  let nav, snap;
  if (kind === 'copane') {
    nav = (await call(i === 0 ? 'browser_open' : 'browser_navigate', { url })).text;
    snap = (await call('browser_snapshot', {})).text;
  } else {
    nav = (await call('browser_navigate', { url })).text;
    snap = (await call('browser_snapshot', {})).text;
  }
  // "showing the first N of M characters" (0.1.1) or "showing characters 0-N of M".
  const shown = /showing (?:the first |characters 0-)(\d+) of (\d+)/.exec(snap);
  out.pages.push({ url, navigate: nav.length, snapshot: snap.length, cut: shown ? `${Math.round((Number(shown[1]) / Number(shown[2])) * 100)}%` : undefined });
  console.log(`  ${url}\n    navigate result ${nav.length} chars ≈ ${tok(nav)} tok | snapshot ${snap.length} chars ≈ ${tok(snap)} tok${shown ? ` (cut, shows ${out.pages.at(-1).cut})` : ''}`);
}
if (kind === 'copane') await call('browser_close_tab', {}).catch(() => {});

// ---------------------------------------------------------------- tasks
if (argv.includes('--tasks') && kind === 'copane') {
  const { startFixtureServer } = await import('../test/fixtures/pages/server.mjs');
  const site = await startFixtureServer();
  const fixture = path => `${site.url}${path}`;
  // What the tools offer; tasks use the cheapest route available, like an agent reading the definitions.
  // --plain: snapshots only, to tell what the snapshot format buys from what the other modes buy.
  const plain = argv.includes('--plain');
  const has = {
    readMode: !plain && 'mode' in schemaOf('browser_snapshot'),
    find: !plain && 'find' in schemaOf('browser_snapshot'),
  };
  const refIn = (text, pattern) => new RegExp(`${pattern}[^\\n]*?\\[ref=(e\\d+)\\]`).exec(text)?.[1];

  const tasks = {
    // Find a link in a long list and follow it.
    async 'HN: open the comments of the third story'(t) {
      await t.call('browser_open', { url: 'https://news.ycombinator.com' });
      let snap = await t.call('browser_snapshot', {});
      const after3 = snap.slice(snap.search(/(^|\s|")3\.(\s|"|$)/m));
      const ref = /link "(?:\d+\s+comments?|discuss)"[^\n]*?\[ref=(e\d+)\]/.exec(after3)?.[1];
      if (!ref) return t.fail('no comments link after rank 3');
      const click = await t.call('browser_click', { ref });
      t.check(/item\?id=/.test(click), 'click reached the item page');
      const read = await t.call('browser_snapshot', has.readMode ? { mode: 'text' } : {});
      t.check(/comment|reply|ago/i.test(read), 'comments readable');
    },
    // Use a search box, then read the first paragraph of the article.
    async 'Wikipedia: search a term, read the first paragraph'(t) {
      await t.call('browser_open', { url: 'https://en.wikipedia.org/wiki/Main_Page' });
      const look = await t.call('browser_snapshot', has.find ? { find: 'Search' } : {});
      const box = '(?:searchbox|combobox) "Search Wikipedia"';
      let ref = refIn(look, box);
      if (!ref) {
        // A narrow window collapses the search box behind a "Search" link that opens it.
        const toggle = refIn(look, 'link "Search"');
        if (!toggle) return t.fail('no search box or search link');
        const click = await t.call('browser_click', { ref: toggle });
        ref = refIn(click, box) ?? refIn(await t.call('browser_snapshot', has.find ? { find: 'Search' } : {}), box);
      }
      if (!ref) return t.fail('no search box');
      await t.call('browser_type', { ref, text: 'Visual Studio Code', submit: true });
      const read = await t.call('browser_snapshot', has.readMode ? { mode: 'text', maxChars: 4000 } : {});
      t.check(/source-code editor|integrated development environment/i.test(read) && /developed by/i.test(read) && /Microsoft/.test(read), 'first paragraph present');
    },
    // A number in a page's sidebar.
    async 'GitHub: find the star count of a repository'(t) {
      await t.call('browser_open', { url: 'https://github.com/microsoft/playwright-mcp' });
      const starRe = /([\d.,]+k?)\s+stars?\b|stars?\b[^\n]{0,40}?([\d.,]+k)/i;
      let text = await t.call('browser_snapshot', has.find ? { find: 'stars' } : {});
      if (!starRe.test(text) && /Snapshot cut/.test(text)) text = await t.call('browser_snapshot', { maxChars: 60000 });
      t.check(starRe.test(text), 'star count present');
    },
    // Fill a form, submit it, and confirm the result.
    async 'Fixture: fill and submit the sign-up form'(t) {
      await t.call('browser_open', { url: fixture('/form.html') });
      const snap = await t.call('browser_snapshot', {});
      const r = p => refIn(snap, p);
      const fields = [
        { ref: r('textbox "Name"'), value: 'Ada' },
        { ref: r('textbox "Email"'), value: 'ada@example.com' },
        { ref: r('checkbox "I accept the terms"'), value: true },
        { ref: r('combobox "Country"'), value: 'France' },
      ];
      if (fields.some(f => !f.ref)) return t.fail('missing form refs');
      await t.call('browser_fill_form', { fields });
      const click = await t.call('browser_click', { ref: r('button "Create account"') });
      // An agent confirms the outcome: from the click result if it shows the change, else from a snapshot.
      if (!/Saved:/.test(click)) t.check(/Saved:/.test(await t.call('browser_snapshot', {})), 'result visible');
    },
    // Find one item far down a long page and act on it.
    async 'Fixture: click an item far down a long page'(t) {
      await t.call('browser_open', { url: fixture('/long.html') });
      let ref;
      if (has.find) ref = refIn(await t.call('browser_snapshot', { find: 'Item 25.3 ' }), 'link "Item 25\\.3 ');
      if (!ref) {
        const snap = await t.call('browser_snapshot', {});
        ref = refIn(snap, 'link "Item 25\\.3 ');
        if (!ref) {
          const section = refIn(snap, 'region "Section 25"');
          if (!section) return t.fail('section 25 not listed');
          ref = refIn(await t.call('browser_snapshot', { ref: section }), 'link "Item 25\\.3 ');
        }
      }
      if (!ref) return t.fail('item not found');
      const click = await t.call('browser_click', { ref });
      t.check(/#item-25-3/.test(click), 'URL changed to the item');
    },
    // Read values out of a table.
    async 'Fixture: read a value from a table'(t) {
      await t.call('browser_open', { url: fixture('/table.html') });
      const text = await t.call('browser_snapshot', has.readMode ? { mode: 'text' } : {});
      t.check(/Widget 37\b[^\n]*?\n?[^\n]*?Lisbon/.test(text) || /Widget 37[\s\S]{0,200}Lisbon/.test(text), 'row of Widget 37 readable');
    },
  };

  const only = opt('only');
  for (const [name, fn] of Object.entries(tasks)) {
    if (only && !name.includes(only)) continue;
    const t = {
      calls: 0,
      chars: 0,
      failed: undefined,
      async call(tool, args) {
        const r = await call(tool, args);
        this.calls++;
        this.chars += r.text.length;
        return r.text;
      },
      check(ok, what) {
        if (!ok && !this.failed) this.failed = what;
      },
      fail(what) {
        this.failed ??= what;
      },
    };
    try {
      await fn(t);
    } catch (err) {
      t.failed = `error: ${err.message}`;
    }
    await call('browser_close_tab', {}).catch(() => {});
    out.tasks.push({ name, calls: t.calls, chars: t.chars, failed: t.failed });
    console.log(`  task ${name}: ${t.calls} calls, results ${t.chars} chars ≈ ${tok({ length: t.chars })} tok${t.failed ? `  FAILED (${t.failed})` : ''}`);
  }
  await site.close();
}

await c.close();
if (opt('out')) writeFileSync(opt('out'), JSON.stringify(out, null, 2));

// ---------------------------------------------------------------- compare
function compare(before, after) {
  const pct = (b, a) => (b ? `${a <= b ? '−' : '+'}${Math.abs(Math.round(((a - b) / b) * 100))}%` : '');
  const row = cells => `| ${cells.join(' | ')} |`;
  console.log('\nTool definitions');
  console.log(row(['', 'before', 'after', 'change']));
  console.log(row(['---', '---:', '---:', '---:']));
  console.log(row(['tools', before.definitions.tools, after.definitions.tools, '']));
  console.log(row(['definition chars (≈ tokens)', `${before.definitions.chars} (${tok({ length: before.definitions.chars })})`, `${after.definitions.chars} (${tok({ length: after.definitions.chars })})`, pct(before.definitions.chars, after.definitions.chars)]));
  console.log(row(['instructions chars', before.definitions.instructions, after.definitions.instructions, pct(before.definitions.instructions, after.definitions.instructions)]));
  console.log('\nSingle snapshots (chars; share of the page shown)');
  console.log(row(['page', 'before', 'after', 'change']));
  console.log(row(['---', '---:', '---:', '---:']));
  for (const p of after.pages) {
    const b = before.pages.find(x => x.url === p.url);
    if (!b) continue;
    console.log(row([p.url.replace(/^https?:\/\//, ''), `${b.snapshot}${b.cut ? ` (${b.cut})` : ' (all)'}`, `${p.snapshot}${p.cut ? ` (${p.cut})` : ' (all)'}`, pct(b.snapshot, p.snapshot)]));
  }
  if (after.tasks.length) {
    console.log('\nTasks (calls, result tokens)');
    console.log(row(['task', 'before', 'after', 'change']));
    console.log(row(['---', '---:', '---:', '---:']));
    let tb = 0, ta = 0;
    for (const t of after.tasks) {
      const b = before.tasks.find(x => x.name === t.name);
      if (!b) continue;
      tb += b.chars;
      ta += t.chars;
      const cell = x => `${x.calls} calls, ${tok({ length: x.chars })} tok${x.failed ? ' FAILED' : ''}`;
      console.log(row([t.name, cell(b), cell(t), pct(b.chars, t.chars)]));
    }
    console.log(row(['**total**', `${tok({ length: tb })} tok`, `${tok({ length: ta })} tok`, pct(tb, ta)]));
  }
}
