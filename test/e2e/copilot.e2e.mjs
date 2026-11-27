// GitHub Copilot sessions, against a running dev host: labelled as Copilot, and given Copane's usage
// notes once, in their first tool result (Copilot CLI does not pass MCP server instructions on).
import http from 'node:http';
import { agent, assert, run, test } from './harness.mjs';

const NOTES = "Copane's usage notes (shown once";

/** The text blocks of one tool call, separately. */
async function texts(a, tool, args = {}) {
  const result = await a.mcp.callTool({ name: tool, arguments: args });
  assert.ok(!result.isError, `${tool} failed: ${JSON.stringify(result.content)}`);
  return (result.content ?? []).filter(b => b.type === 'text').map(b => b.text);
}

test('a copilot-cli client is a Copilot session and gets the usage notes once', async () => {
  const a = await agent({ session: 'copilot-a', client: 'copilot-cli' });
  try {
    const first = await texts(a, 'session_info');
    assert.equal(first.length, 2, 'the tool result plus one part with the notes');
    const you = JSON.parse(first[0]).you;
    assert.match(you.label, /^Copilot \d+$/);
    assert.ok(first[1].startsWith(NOTES), first[1].slice(0, 80));
    assert.match(first[1], /browser_tab {"action":"release"}/);
    const second = await texts(a, 'session_info');
    assert.equal(second.length, 1);
    assert.ok(!second.join('\n').includes(NOTES));
  } finally {
    await a.close();
  }
});

test('the notes are not repeated when the same Copilot session reconnects', async () => {
  const first = await agent({ session: 'copilot-resume', client: 'copilot-cli' });
  assert.equal((await texts(first, 'session_info')).length, 2);
  await first.close();
  const again = await agent({ session: 'copilot-resume', client: 'copilot-cli' });
  try {
    assert.equal((await texts(again, 'session_info')).length, 1);
  } finally {
    await again.close();
  }
});

test('other clients get no notes', async () => {
  for (const client of ['some-agent', 'claude-code']) {
    const a = await agent({ session: `copilot-other-${client}`, client });
    try {
      const blocks = await texts(a, 'session_info');
      assert.equal(blocks.length, 1, `${client}: ${blocks.length} text parts`);
      assert.ok(!blocks[0].includes(NOTES));
      assert.doesNotMatch(JSON.parse(blocks[0]).you.label, /^Copilot/);
    } finally {
      await a.close();
    }
  }
});

// Copilot gives its model a file instead of a tool result over 20 KiB (core/resultSize.ts).
const FILE_THRESHOLD = 20 * 1024;
const bytes = parts => Buffer.byteLength(parts.join('\n'), 'utf8');

test('results for Copilot stay below the size at which it hands its model a file, counted in bytes', async () => {
  // A long page in Japanese: three bytes a character, so a limit in characters is not enough.
  const items = Array.from({ length: 900 }, (_, i) => `<li><a href="/item/${i}">項目 ${i}：これは文書の例に使用するためのドメインです</a></li>`).join('');
  const server = http.createServer((_request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(`<!doctype html><meta charset="utf-8"><title>長いページ</title><h1>長いページ</h1><ul>${items}</ul>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const copilot = await agent({ session: 'copilot-size', client: 'copilot-cli' });
  const claude = await agent({ session: 'copilot-size-other' });
  const hasBrowser = (await copilot.tools()).some(t => t.name === 'browser_open');
  try {
    if (hasBrowser) {
      // The first result of a Copilot session also carries the usage notes: still below the size.
      await texts(copilot, 'browser_open', { url });
      for (const args of [{}, { mode: 'text' }]) {
        const parts = await texts(copilot, 'browser_snapshot', args);
        assert.ok(bytes(parts) < FILE_THRESHOLD, `browser_snapshot ${JSON.stringify(args)}: ${bytes(parts)} bytes`);
        assert.ok(bytes(parts) > FILE_THRESHOLD / 2, 'cut to fit, not to a fraction');
        assert.match(parts.join('\n'), /offset \d+/, 'says how to read on');
      }
      // Another agent has no such limit and gets the snapshot by characters, as before.
      await texts(claude, 'browser_open', { url });
      assert.ok(bytes(await texts(claude, 'browser_snapshot')) > FILE_THRESHOLD);
      // What the agent asks for by size is its own choice.
      assert.ok(bytes(await texts(copilot, 'browser_snapshot', { maxChars: 20000, offset: 0 })) > FILE_THRESHOLD);
    }
    const command = `node -e "for (let i = 0; i < 1500; i++) console.log(i, '依存関係を解決しています — größe '.repeat(4))"`;
    const out = await texts(copilot, 'terminal_run', { command });
    assert.ok(bytes(out) < FILE_THRESHOLD, `terminal_run: ${bytes(out)} bytes`);
    assert.match(out.join('\n'), /lines? cut here .* Read them with terminal_read/);
    assert.match(out.join('\n'), /^1499 /m, 'the end of the output is kept');
  } finally {
    for (const a of [copilot, claude]) {
      if (hasBrowser) await a.call('browser_tab', { action: 'close' });
      for (const t of JSON.parse((await a.call('terminal_list')).text.replace(/^No terminals.*$/s, '[]'))) if (t.owner === 'you') await a.call('terminal_close', { terminal: t.id });
      await a.close();
    }
    server.close();
  }
});

await run();
