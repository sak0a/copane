// VS Code's own MCP client: one MCP server process for every chat of a window, each tool call naming
// its chat in `_meta["vscode.conversationId"]`. Each conversation must be a session of its own.
import { randomUUID } from 'node:crypto';
import { agent, assert, run, test } from './harness.mjs';

const VSCODE = 'Visual Studio Code';

/** A tool call from one chat conversation (`conversation` undefined: a call without the meta key). */
async function callIn(a, conversation, tool, args = {}) {
  const _meta = conversation ? { 'vscode.conversationId': conversation, 'vscode.requestId': randomUUID() } : undefined;
  const result = await a.mcp.callTool({ name: tool, arguments: args, ...(_meta ? { _meta } : {}) }, undefined, { timeout: 120_000 });
  const text = (result.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  assert.ok(!result.isError, `${tool} failed: ${text}`);
  return text;
}

const you = async (a, conversation) => JSON.parse(await callIn(a, conversation, 'session_info')).you;

test('two conversations in one MCP server process are two sessions; calls without one keep the default', async () => {
  const a = await agent({ client: VSCODE });
  const [chat1, chat2] = [randomUUID(), randomUUID()];
  try {
    const one = await you(a, chat1);
    const two = await you(a, chat2);
    const fallback = await you(a, undefined);
    assert.notEqual(one.id, two.id);
    assert.notEqual(one.label, two.label);
    assert.ok(![one.id, two.id].includes(fallback.id), 'the default session is a third one');
    assert.match(one.id, /^vscode-chat:[0-9a-f]{32}$/);
    assert.ok(!one.id.includes(chat1), 'the conversation id is not the session key');
    assert.deepEqual(await you(a, chat1), one, 'the same conversation reuses its session');

    const status1 = await callIn(a, chat1, 'window_status');
    const status2 = await callIn(a, chat2, 'window_status');
    assert.match(status1, new RegExp(`as "${one.label}"`));
    assert.match(status2, new RegExp(`as "${two.label}"`));
  } finally {
    await a.close();
  }
});

test("a terminal opened in one conversation is that conversation's current terminal, not the other's", async () => {
  const a = await agent({ client: VSCODE });
  const [chat1, chat2] = [randomUUID(), randomUUID()];
  let id;
  try {
    const label1 = (await you(a, chat1)).label;
    await you(a, chat2);
    const opened = await callIn(a, chat1, 'terminal_create', { name: 'conversations e2e' });
    id = /Opened (\S+)/.exec(opened)?.[1];
    assert.ok(id, opened);
    const mine = JSON.parse(await callIn(a, chat1, 'terminal_list')).find(t => t.id === id);
    assert.equal(mine.owner, 'you');
    assert.equal(mine.current, true);
    const theirs = JSON.parse(await callIn(a, chat2, 'terminal_list')).find(t => t.id === id);
    assert.equal(theirs.owner, label1);
    assert.equal(theirs.current, undefined);
  } finally {
    if (id) await callIn(a, chat1, 'terminal_close', { terminal: id }).catch(() => {});
    await a.close();
  }
});

test('a conversation resumes its session in a new MCP server process (a window reload restarts it)', async () => {
  const chat = randomUUID();
  const first = await agent({ client: VSCODE });
  await callIn(first, chat, 'session_set_title', { title: 'conversation resume' });
  const before = await you(first, chat);
  await first.close();
  const second = await agent({ client: VSCODE });
  try {
    assert.deepEqual(await you(second, chat), before);
  } finally {
    await second.close();
  }
});

test('one tool list for all conversations', async () => {
  const a = await agent({ client: VSCODE });
  try {
    const names = (await a.tools()).map(t => t.name);
    assert.ok(names.includes('session_info') && names.includes('window_status'));
    assert.equal(new Set(names).size, names.length);
  } finally {
    await a.close();
  }
});

await run();
