// Sessions and the bridge itself, against a running dev host.
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agent, assert, hostDir, run, sleep, test, until } from './harness.mjs';

// The dev host's user settings; cases that change them put them back.
const settingsFile = join(hostDir, 'ud', 'User', 'settings.json');
const originalSettings = existsSync(settingsFile) ? readFileSync(settingsFile, 'utf8') : '{}';
async function setSettings(values) {
  const merged = { ...JSON.parse(originalSettings || '{}'), ...values };
  for (const [key, value] of Object.entries(values)) if (value === undefined) delete merged[key];
  writeFileSync(settingsFile, JSON.stringify(merged, null, 2));
  await sleep(1500); // VS Code picks up the file change.
}
const restoreSettings = async () => {
  writeFileSync(settingsFile, originalSettings);
  await sleep(1500);
};

test('two agent sessions get their own label and see each other', async () => {
  const a = await agent({ session: 'core-a' });
  const b = await agent({ session: 'core-b' });
  try {
    // B first: a session exists in the window once its MCP server has connected, which its first call ensures.
    const infoB = JSON.parse(await b.ok('session_info'));
    const infoA = JSON.parse(await a.ok('session_info'));
    assert.notEqual(infoA.you.label, infoB.you.label);
    assert.notEqual(infoA.you.color, infoB.you.color);
    assert.ok(infoA.otherSessions.some(s => s.label.startsWith(infoB.you.label)));
  } finally {
    await a.close();
    await b.close();
  }
});

test('a session keeps its identity when it reconnects with the same key', async () => {
  const first = await agent({ session: 'core-resume' });
  await first.ok('session_set_title', { title: 'resume check' });
  const before = JSON.parse(await first.ok('session_info')).you;
  await first.close();
  const second = await agent({ session: 'core-resume' });
  try {
    assert.deepEqual(JSON.parse(await second.ok('session_info')).you, before);
  } finally {
    await second.close();
  }
});

test('tool arguments are validated with a readable message', async () => {
  const a = await agent();
  try {
    const result = await a.call('session_set_title', { title: 42 });
    assert.ok(result.isError);
    assert.match(result.text, /title/);
  } finally {
    await a.close();
  }
});

test('an unknown argument is refused, naming it and the valid ones', async () => {
  const a = await agent();
  try {
    const result = await a.call('session_set_title', { title: 'never set', titel: 'typo' });
    assert.ok(result.isError);
    assert.match(result.text, /^session_set_title has no argument "titel"; nothing was done\. Its arguments are "title"\./);
    const info = JSON.parse(await a.ok('session_info'));
    assert.equal(info.you.title, null, 'the refused call did nothing');
  } finally {
    await a.close();
  }
});

test('copane.tools.profile and copane.tools.disabled change the list of a connected agent and refuse calls', async () => {
  const a = await agent({ session: 'core-tools' });
  try {
    const before = (await a.tools()).map(t => t.name);
    const browser = before.includes('browser_open');
    let notified = 0;
    a.mcp.setNotificationHandler(ToolListChangedNotificationSchema, () => void notified++);
    await setSettings({ 'copane.tools.profile': 'core', 'copane.tools.disabled': ['terminal_close', 'window_status', 'no_such_tool'] });
    const names = await until(async () => {
      const list = (await a.tools()).map(t => t.name);
      return !list.includes('terminal_close') && list;
    }, 'the tool list to change');
    await until(() => notified > 0, 'the client to be told the list changed');
    for (const gone of ['terminal_close', 'terminal_interrupt', 'session_info', ...(browser ? ['browser_emulate', 'browser_route', 'browser_audit'] : [])]) {
      assert.ok(!names.includes(gone), `${gone} is still listed`);
    }
    for (const kept of ['terminal_run', 'terminal_send', 'session_set_title', 'window_status', 'window_select', 'debug_vscode_command', ...(browser ? ['browser_open', 'browser_click', 'browser_handle_dialog'] : [])]) {
      assert.ok(names.includes(kept), `${kept} is missing`);
    }

    const info = await a.call('session_info', {});
    assert.ok(info.isError);
    assert.equal(info.text, 'session_info is turned off in this VS Code window by the user\'s setting "copane.tools.profile": "core". window_status shows your session label and the window.');
    const close = await a.call('terminal_close', {});
    assert.ok(close.isError);
    assert.match(close.text, /^terminal_close is turned off in this VS Code window by the user's setting "copane\.tools\.disabled"\./);
    assert.match(await a.ok('window_status'), /Connected to VS Code window/);

    await restoreSettings();
    await until(async () => (await a.tools()).map(t => t.name).includes('terminal_close'), 'the tools to come back');
    assert.deepEqual((await a.tools()).map(t => t.name).sort(), [...before].sort());
    assert.ok(JSON.parse(await a.ok('session_info')).you.label);
  } finally {
    await restoreSettings();
    await a.close();
  }
});

test('copane.usageNotesInResults false: a Copilot session gets no usage notes in its results', async () => {
  await setSettings({ 'copane.usageNotesInResults': false });
  const a = await agent({ session: `core-notes-${Date.now()}`, client: 'copilot-cli' });
  try {
    const result = await a.mcp.callTool({ name: 'session_info', arguments: {} });
    assert.ok(!result.isError);
    assert.equal(result.content.length, 1, 'no notes part');
    assert.match(JSON.parse(result.content[0].text).you.label, /^Copilot \d+$/);
  } finally {
    await restoreSettings();
    await a.close();
  }
});

await run();
