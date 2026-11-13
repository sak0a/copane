// The MCP server (BridgeClient + proxy) against real bridge servers over real sockets, with an MCP
// SDK client in front: what an agent sees when windows start late, reload, are ambiguous or end it.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BridgeServer } from '../../src/extension/core/bridgeServer';
import { nullLogger } from '../../src/extension/core/log';
import { SessionManager } from '../../src/extension/core/sessions';
import { defineTool, ToolRegistry } from '../../src/extension/core/tools';
import { BridgeClient, sessionKeyFrom } from '../../src/mcp/bridgeClient';
import { buildInstructions, createProxyServer } from '../../src/mcp/proxy';
import { PROTOCOL_VERSION, type InstanceInfo } from '../../src/shared/protocol';

interface FakeWindow {
  info: InstanceInfo;
  sessions: SessionManager;
  server: BridgeServer;
  close(): void;
}

let dir: string;
let instances: InstanceInfo[];
const windows: FakeWindow[] = [];
const cleanups: Array<() => unknown> = [];

async function openWindow(id: string, folders: string[], options: { startedAt?: number; extraTool?: boolean } = {}): Promise<FakeWindow> {
  const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\ab-proxy-${process.pid}-${id}-${Date.now()}` : path.join(dir, `${id}.sock`);
  const sessions = new SessionManager({ graceMs: () => 0 });
  const tools = new ToolRegistry();
  tools.register([defineTool({ name: 'whoami', description: 'x', input: {}, handler: (_a, ctx) => `${ctx.session.label} in ${id}` })]);
  if (options.extraTool) tools.register([defineTool({ name: 'extra', description: 'x', input: {}, handler: () => 'extra' })]);
  const windowInfo = { instanceId: id, workspaceName: path.basename(folders[0] ?? 'none'), workspaceFolders: folders, remoteName: null, platform: process.platform };
  const server = new BridgeServer({
    socketPath,
    token: `t${id}`,
    extensionVersion: '0.0.0',
    window: windowInfo,
    sessions,
    tools,
    log: nullLogger,
    instructions: () => `Window instructions of ${id}.`,
  });
  await server.listen();
  const info: InstanceInfo = {
    id,
    pid: Number(id),
    socketPath,
    token: `t${id}`,
    protocolVersion: PROTOCOL_VERSION,
    extensionVersion: '0.0.0',
    workspaceName: windowInfo.workspaceName,
    workspaceFolders: folders,
    remoteName: null,
    appName: 'Code',
    startedAt: options.startedAt ?? Date.now(),
    lastFocusedAt: 0,
  };
  instances.push(info);
  const win: FakeWindow = {
    info,
    sessions,
    server,
    close: () => {
      instances = instances.filter(i => i !== info);
      server.dispose();
      sessions.dispose();
    },
  };
  windows.push(win);
  return win;
}

async function agent(options: { cwd?: string; env?: NodeJS.ProcessEnv; ancestors?: number[]; initWaitMs?: number } = {}) {
  const bridge = new BridgeClient({
    env: options.env ?? {},
    cwd: options.cwd ?? '/work/a',
    pid: 4242,
    sessionKey: 'key-1',
    readInstances: () => instances,
    ancestors: async () => options.ancestors ?? [],
    log: m => process.env.DBG && console.error(m),
    timing: { pollMs: 20, backgroundMs: 40, graceMs: 1500, callWaitAfterLossMs: 4000, callWaitMs: 150 },
  });
  const server = createProxyServer(bridge, { version: '0.0.0', initWaitMs: options.initWaitMs ?? 300 });
  const client = new Client({ name: 'claude-code', version: '9.9.9' });
  let listChanged = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    listChanged++;
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  cleanups.push(() => client.close(), () => bridge.dispose());
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
    return { text: result.content.map(c => c.text).join('\n'), isError: result.isError === true };
  };
  const toolNames = async () => (await client.listTools()).tools.map(t => t.name).sort();
  return { client, bridge, call, toolNames, listChanged: () => listChanged };
}

const until = async (fn: () => boolean | Promise<boolean>, what: string, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs;
  while (!(await fn())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 20));
  }
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-proxy-'));
  instances = [];
});

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
  for (const w of windows.splice(0)) w.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('MCP server', () => {
  it('gives instructions naming the window and session when the window is up at initialize', async () => {
    await openWindow('100', ['/work/a']);
    const { client, call, toolNames } = await agent();
    const instructions = client.getInstructions() ?? '';
    expect(instructions).toContain('Window instructions of 100.');
    expect(instructions).toMatch(/connected to the VS Code window "a" \(\/work\/a\) as "Claude 1"/);
    expect(instructions).toContain('window_status');
    expect(await toolNames()).toEqual(['whoami', 'window_select', 'window_status']);
    expect((await call('whoami')).text).toBe('Claude 1 in 100');
  });

  it('without a window explains why and what to do, then picks the window up when it starts', async () => {
    const { client, call, toolNames, listChanged } = await agent({ initWaitMs: 50 });
    expect(client.getInstructions()).toMatch(/Not connected to a VS Code window/);
    expect(await toolNames()).toEqual(['window_select', 'window_status']);
    const status = await call('window_status');
    expect(status.text).toMatch(/No VS Code window with the Agent Bridge extension is running/);
    expect(status.text).toMatch(/appear on their own/);
    const failed = await call('whoami');
    expect(failed.isError).toBe(true);
    expect(failed.text).toMatch(/Not connected/);

    await openWindow('100', ['/work/a']);
    await until(() => listChanged() > 0, 'tools/list_changed');
    expect(await toolNames()).toEqual(['whoami', 'window_select', 'window_status']);
    expect((await call('whoami')).text).toBe('Claude 1 in 100');
  });

  it('waits for a window that is still starting at initialize', async () => {
    setTimeout(() => void openWindow('100', ['/work/a']), 100);
    const { client } = await agent({ initWaitMs: 2000 });
    expect(client.getInstructions()).toContain('Window instructions of 100.');
  });

  it('survives a window reload: calls wait for the new window, the tool list does not flap', async () => {
    const first = await openWindow('100', ['/work/a', '/work/b']);
    // A `claude` CLI in a terminal: found through the terminal variable, which goes stale on reload.
    const { call, bridge, listChanged } = await agent({ env: { AGENT_BRIDGE_INSTANCE: '100' }, cwd: '/elsewhere' });
    expect((await call('whoami')).text).toBe('Claude 1 in 100');
    const before = listChanged();

    first.close();
    await until(() => !bridge.current, 'the client to see the window go away');
    const reopened = new Promise<void>(resolve => setTimeout(() => void openWindow('200', ['/work/b', '/work/a']).then(() => resolve()), 300));
    const result = await call('whoami');
    await reopened;
    expect(result.text).toBe('Claude 1 in 200');
    expect(bridge.current?.matchedBy).toBe('reconnect');
    expect(listChanged()).toBe(before);
  });

  it('a call in flight when the window goes away fails with an explanation', async () => {
    const win = await openWindow('100', ['/work/a']);
    win.server['options'].tools.register([
      defineTool({ name: 'slow', description: 'x', input: {}, handler: () => new Promise<string>(resolve => setTimeout(() => resolve('late'), 2000)) }),
    ]);
    const { call } = await agent();
    const pending = call('slow');
    await new Promise(r => setTimeout(r, 100));
    win.close();
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/may or may not have taken effect/);
  });

  it('reports a changed tool list after reconnecting to a window with other tools', async () => {
    const first = await openWindow('100', ['/work/a']);
    const { call, toolNames, listChanged } = await agent();
    await call('whoami');
    const before = listChanged();
    first.close();
    await openWindow('200', ['/work/a'], { extraTool: true });
    await until(() => listChanged() > before, 'tools/list_changed after reconnect');
    expect(await toolNames()).toContain('extra');
  });

  it('drops the tools once a closed window has not come back within the grace period', async () => {
    const win = await openWindow('100', ['/work/a']);
    const { call, toolNames } = await agent();
    await call('whoami');
    win.close();
    expect(await toolNames()).toContain('whoami');
    await until(async () => !(await toolNames()).includes('whoami'), 'tools to disappear', 4000);
  });

  it('never guesses between several windows, and lets the agent choose', async () => {
    await openWindow('100', ['/work/a']);
    await openWindow('200', ['/work/b']);
    const { call, toolNames } = await agent({ cwd: '/elsewhere' });
    expect(await toolNames()).toEqual(['window_select', 'window_status']);
    const status = await call('window_status');
    expect(status.text).toMatch(/2 VS Code windows are open, and none contains the working directory \/elsewhere/);
    expect(status.text).toMatch(/- 100 "a" \(\/work\/a\)/);
    expect(status.text).toMatch(/call window_select/);

    expect((await call('window_select', { window: 'nope' })).isError).toBe(true);
    const selected = await call('window_select', { window: 'b' });
    expect(selected.isError).toBe(false);
    expect(selected.text).toMatch(/Connected to VS Code window 200/);
    expect((await call('whoami')).text).toBe('Claude 1 in 200');
    expect(await toolNames()).toContain('whoami');
  });

  it('prefers the extension host it was started by', async () => {
    await openWindow('100', ['/work/a']);
    await openWindow('200', ['/work/a']);
    const { call } = await agent({ ancestors: [7, 200, 1] });
    expect((await call('whoami')).text).toBe('Claude 1 in 200');
    expect((await call('window_status')).text).toMatch(/started by that window's extension host/);
  });

  it('does not come back on its own when the window ended the session, but the next call reconnects', async () => {
    const win = await openWindow('100', ['/work/a']);
    const { call, bridge } = await agent();
    await call('whoami');
    const session = win.sessions.list()[0]!;
    win.sessions.remove(session.id); // The user ended the session in the window.
    await until(() => !bridge.current, 'disconnect');
    await new Promise(r => setTimeout(r, 200));
    expect(win.sessions.list()).toHaveLength(0);
    expect((await call('whoami')).text).toBe('Claude 1 in 100');
  });

  it('after the window ended the session, reconnects to that window, not to another with the same folder', async () => {
    const win = await openWindow('100', ['/work/a']);
    await openWindow('200', ['/work/a'], { startedAt: Date.now() + 1000 });
    const { call, bridge } = await agent({ ancestors: [100] });
    await call('whoami');
    win.sessions.remove(win.sessions.list()[0]!.id);
    await until(() => !bridge.current, 'disconnect');
    expect((await call('whoami')).text).toBe('Claude 1 in 100');
  });

  it('switches windows cleanly: one tool list change, no empty list in between', async () => {
    await openWindow('100', ['/work/a']);
    await openWindow('200', ['/work/b'], { extraTool: true });
    const { call, client, toolNames } = await agent();
    await call('whoami');
    const lists: string[][] = [];
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      lists.push(await toolNames());
    });
    expect((await call('window_select', { window: '200' })).isError).toBe(false);
    await until(() => lists.length > 0, 'tools/list_changed');
    await new Promise(r => setTimeout(r, 100));
    expect(lists).toEqual([['extra', 'whoami', 'window_select', 'window_status']]);
  });

  it('records how the session matched its window, in the window', async () => {
    const win = await openWindow('100', ['/work/a']);
    const { call } = await agent();
    await call('whoami');
    expect(win.sessions.list()[0]?.matchedBy).toBe('cwd');
    expect(win.sessions.list()[0]?.client).toMatchObject({ name: 'claude-code', version: '9.9.9', kind: 'claude-code' });
  });
});

describe('session key and instructions', () => {
  it('uses the explicit key, then the Claude Code session id, then a random one', () => {
    expect(sessionKeyFrom({ AGENT_BRIDGE_SESSION: 'a', CLAUDE_CODE_SESSION_ID: 'b' })).toBe('a');
    expect(sessionKeyFrom({ CLAUDE_CODE_SESSION_ID: 'b' })).toBe('b');
    expect(sessionKeyFrom({})).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('keeps the instructions under the length Claude Code shows', () => {
    const bridge = {
      current: { hello: { instructions: 'x'.repeat(10_000) } },
      connectionSummary: () => 'summary',
    } as unknown as BridgeClient;
    expect(buildInstructions(bridge).length).toBeLessThanOrEqual(4000);
  });
});
