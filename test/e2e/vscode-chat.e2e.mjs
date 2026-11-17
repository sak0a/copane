// The MCP server definition Copane offers VS Code's own chat (setting copane.vscodeChat.serverDefinition),
// against a running dev host. The dev host turns AI features off, so no chat ever starts the server
// here: the test reads what the provider gives VS Code, checks that VS Code asked for it, and then
// starts exactly that command with exactly that environment itself, as VS Code would.
//
//   node scripts/dev-host.mjs --name vscode-chat
//   node test/e2e/vscode-chat.e2e.mjs --name vscode-chat
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agent, assert, hostDir, run, test, until } from './harness.mjs';

const SETTING = 'copane.vscodeChat.serverDefinition';
const launcher = join(hostDir, 'home', 'bin', process.platform === 'win32' ? 'mcp-server.js' : 'mcp-server');

async function evalInHost(a, code) {
  return JSON.parse(await a.ok('debug_extension_eval', { code }));
}

const state = a => evalInHost(a, `return await vscode.commands.executeCommand('copane.vscodeChat.serverDefinitions');`);

async function setSetting(a, value) {
  await evalInHost(a, `await vscode.workspace.getConfiguration().update(${JSON.stringify(SETTING)}, ${JSON.stringify(value)}, vscode.ConfigurationTarget.Global); return null;`);
}

/** Starts the server the way VS Code would start the definition, as an MCP client named like VS Code's. */
async function startAsVscode(def, clientName = 'Visual Studio Code') {
  // VS Code starts it with its extension host's environment (Local harness) or little more than PATH
  // (Copilot harness), plus the definition's env. Start from PATH alone so nothing else can route it.
  const env = { PATH: process.env.PATH ?? '', ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot ?? '' } : {}), ...def.env };
  const transport = new StdioClientTransport({ command: def.command, args: def.args, env, cwd: tmpdir(), stderr: process.env.DEBUG ? 'inherit' : 'ignore' });
  const mcp = new Client({ name: clientName, version: '1.146.0' });
  await mcp.connect(transport);
  return mcp;
}

test('the provider is registered and offers nothing while the setting is off (the default)', async () => {
  const a = await agent({ session: 'vscode-chat-off' });
  try {
    await setSetting(a, undefined);
    const s = await state(a);
    assert.equal(s.apiAvailable, true, `this VS Code should have the API: ${s.problem}`);
    assert.equal(s.registered, true, `VS Code should accept the provider: ${s.problem}`);
    assert.equal(s.enabled, false);
    assert.deepEqual(s.definitions, []);
    assert.match(s.reason, /is off/);
    assert.ok(s.provided >= 1, 'VS Code asks a provider for its definitions once it is registered');
  } finally {
    await a.close();
  }
});

test('turned on, VS Code is offered the launcher with COPANE_INSTANCE of this window', async () => {
  const a = await agent({ session: 'vscode-chat-on' });
  try {
    const instanceId = await evalInHost(a, 'return services.window.instanceId;');
    const before = (await state(a)).provided;
    await setSetting(a, true);
    // VS Code's extension host asks the provider again when it fires its change event.
    const s = await until(async () => {
      const now = await state(a);
      return now.enabled && now.provided > before ? now : undefined;
    }, 'VS Code to ask the provider again');
    assert.equal(s.definitions.length, 1);
    const [def] = s.definitions;
    assert.equal(def.label, 'copane');
    if (process.platform === 'win32') {
      assert.deepEqual(def.args, [launcher]);
      assert.equal(def.env.ELECTRON_RUN_AS_NODE, '1');
    } else {
      assert.equal(def.command, launcher);
      assert.deepEqual(def.args, []);
    }
    assert.equal(def.env.COPANE_INSTANCE, instanceId);
    assert.equal(def.env.COPANE_HOME, join(hostDir, 'home'), 'the dev host bridge home, so the server finds this window');
    assert.equal(def.env.COPANE_SESSION, undefined, 'no fixed session key: every server process gets its own session');
  } finally {
    await a.close();
  }
});

test('that exact command connects to this window, matched by COPANE_INSTANCE, as an "Agent" session', async () => {
  const a = await agent({ session: 'vscode-chat-spawn' });
  let mcp;
  try {
    await setSetting(a, true);
    const s = await until(async () => {
      const now = await state(a);
      return now.definitions.length ? now : undefined;
    }, 'the definition');
    const [def] = s.definitions;
    mcp = await startAsVscode(def);
    const result = await mcp.callTool({ name: 'window_status', arguments: {} });
    const text = (result.content ?? []).map(b => b.text ?? '').join('\n');
    assert.ok(!result.isError, text);
    assert.match(text, new RegExp(`Connected to VS Code window ${def.env.COPANE_INSTANCE} `));
    assert.match(text, /Matched because COPANE_INSTANCE names it/);
    const sessions = await evalInHost(
      a,
      `return services.sessions.list().filter(s => s.client.name === 'Visual Studio Code' && s.connected !== false).map(s => ({ label: s.label, kind: s.client.kind, matchedBy: s.matchedBy, cwd: s.cwd }));`,
    );
    assert.equal(sessions.length, 1, JSON.stringify(sessions));
    assert.equal(sessions[0].matchedBy, 'env');
    assert.equal(sessions[0].kind, 'other');
    assert.match(sessions[0].label, /^Agent \d+$/);
    // Tools are those of this window.
    const { tools } = await mcp.listTools();
    assert.ok(tools.some(t => t.name === 'terminal_create'), tools.map(t => t.name).join(', '));
  } finally {
    await mcp?.close();
    await a.close();
  }
});

// VS Code's own MCP client (the Local harness path) starting the server, without any chat or model:
// "MCP: Start Server" by the id VS Code gives an extension's server, `<extension id>/<label>`.
test("VS Code's own MCP client starts it from the definition: a child of this extension host, an \"Agent\" session", async () => {
  const a = await agent({ session: 'vscode-chat-vscode' });
  const id = await evalInHost(a, `return services.context.extension.id.toLowerCase() + '/copane';`);
  try {
    await setSetting(a, true);
    await until(async () => (await state(a)).definitions.length, 'the definition');
    const sessions = () =>
      evalInHost(a, `return services.sessions.list().filter(s => s.client.name === vscode.env.appName && s.connected).map(s => ({ label: s.label, kind: s.client.kind, matchedBy: s.matchedBy }));`);
    // VS Code knows the server only once the collection (its `when` clause) and the provider's update
    // have reached the workbench, shortly after the setting changed: until then the start does nothing.
    let tries = 0;
    const [session] = await until(
      async () => {
        const list = await sessions();
        if (list.length) return list;
        if (tries++ % 10 === 0) await evalInHost(a, `await vscode.commands.executeCommand('workbench.mcp.startServer', ${JSON.stringify(id)}); return null;`);
        return undefined;
      },
      `VS Code to start ${id} and the server to connect`,
      { timeoutMs: 30_000, intervalMs: 300 },
    );
    assert.equal(session.matchedBy, 'ancestor', 'started by this window\'s extension host, which is exact before COPANE_INSTANCE');
    assert.equal(session.kind, 'other');
    assert.match(session.label, /^Agent \d+$/);
  } finally {
    await evalInHost(a, `await vscode.commands.executeCommand('workbench.mcp.stopServer', ${JSON.stringify(id)}); return null;`).catch(() => {});
    await a.close();
  }
});

test('turned off again, the definition is withdrawn', async () => {
  const a = await agent({ session: 'vscode-chat-withdraw' });
  try {
    await setSetting(a, true);
    const before = (await state(a)).provided;
    await setSetting(a, undefined);
    const s = await until(async () => {
      const now = await state(a);
      return !now.enabled && now.provided > before ? now : undefined;
    }, 'VS Code to ask the provider after the setting went off');
    assert.deepEqual(s.definitions, []);
  } finally {
    await a.close();
  }
});

await run();
