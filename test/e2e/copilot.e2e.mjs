// GitHub Copilot sessions, against a running dev host: labelled as Copilot, and given Copane's usage
// notes once, in their first tool result (Copilot CLI does not pass MCP server instructions on).
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

await run();
