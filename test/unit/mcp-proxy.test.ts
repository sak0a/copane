// The MCP server (BridgeClient + proxy) against real bridge servers over real sockets, with an MCP
// SDK client in front: what an agent sees when windows start late, reload, are ambiguous or end it.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { BridgeServer } from '../../src/extension/core/bridgeServer';
import { nullLogger } from '../../src/extension/core/log';
import { SessionManager } from '../../src/extension/core/sessions';
import { defineTool, ToolRegistry } from '../../src/extension/core/tools';
import { BridgeClient, sessionCwdFrom, sessionKeyFrom, startedFromVsCode } from '../../src/mcp/bridgeClient';
import { CONVERSATION_META_KEY, ConversationBridges, conversationIdOf, conversationSessionKey, type ConversationBridgesOptions } from '../../src/mcp/conversations';
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

async function openWindow(
  id: string,
  folders: string[],
  options: { startedAt?: number; extraTool?: boolean; browserTool?: boolean; graceMs?: number; stateTools?: boolean; browserOff?: boolean } = {},
): Promise<FakeWindow> {
  const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\ab-proxy-${process.pid}-${id}-${Date.now()}` : path.join(dir, `${id}.sock`);
  const sessions = new SessionManager({ graceMs: () => options.graceMs ?? 0 });
  const tools = new ToolRegistry();
  tools.register([defineTool({ name: 'whoami', description: 'x', input: {}, handler: (_a, ctx) => `${ctx.session.label} in ${id}` })]);
  // Per-session state, like a session's current tab or terminal.
  const notes = new Map<string, string>();
  if (options.stateTools) tools.register([
    defineTool({ name: 'note', description: 'x', input: { text: z.string() }, handler: (a, ctx) => (notes.set(ctx.session.id, a.text), 'noted') }),
    defineTool({ name: 'recall', description: 'x', input: {}, handler: (_a, ctx) => notes.get(ctx.session.id) ?? '(nothing)' }),
  ]);
  if (options.extraTool) tools.register([defineTool({ name: 'extra', description: 'x', input: {}, handler: () => 'extra' })]);
  if (options.browserTool) tools.register([defineTool({ name: 'browser_open', description: 'x', input: {}, handler: () => 'opened' })]);
  const windowInfo = { instanceId: id, workspaceName: path.basename(folders[0] ?? 'none'), workspaceFolders: folders, remoteName: null, platform: process.platform };
  const server = new BridgeServer({
    socketPath,
    token: `t${id}`,
    extensionVersion: '0.0.0',
    window: windowInfo,
    sessions,
    tools,
    log: nullLogger,
    instructions: () => `Window instructions of ${id}.${options.browserOff ? ' The integrated browser is not enabled in this VS Code.' : ''}`,
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

async function agent(
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    ancestors?: number[];
    initWaitMs?: number;
    progressMs?: number;
    clientName?: string;
    sessionKey?: string | ((clientName: string) => string);
    /** Serve VS Code chat conversations (`_meta["vscode.conversationId"]`), as dist/mcp-server.js does. */
    conversations?: Omit<ConversationBridgesOptions, 'create'>;
  } = {},
) {
  const common = {
    env: options.env ?? {},
    cwd: options.cwd ?? '/work/a',
    pid: 4242,
    readInstances: () => instances,
    ancestors: async () => options.ancestors ?? [],
    log: (m: string) => void (process.env.DBG && console.error(m)),
    timing: { pollMs: 20, backgroundMs: 40, graceMs: 1500, callWaitAfterLossMs: 4000, callWaitMs: 150 },
  };
  const bridge = new BridgeClient({ ...common, sessionKey: options.sessionKey ?? 'key-1' });
  const created: string[] = [];
  const conversations = options.conversations
    ? new ConversationBridges({
        ...options.conversations,
        create: (sessionKey, window) => {
          created.push(sessionKey);
          return new BridgeClient({ ...common, sessionKey, window });
        },
      })
    : undefined;
  if (conversations) cleanups.push(() => conversations.dispose());
  const server = createProxyServer(bridge, { version: '0.0.0', initWaitMs: options.initWaitMs ?? 300, conversations, ...(options.progressMs ? { progressMs: options.progressMs } : {}) });
  const client = new Client({ name: options.clientName ?? 'claude-code', version: '9.9.9' });
  let listChanged = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    listChanged++;
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  cleanups.push(() => client.close(), () => bridge.dispose());
  const call = async (name: string, args: Record<string, unknown> = {}, conversation?: string) => {
    const _meta = conversation === undefined ? undefined : { [CONVERSATION_META_KEY]: conversation, 'vscode.requestId': 'r1' };
    const result = (await client.callTool({ name, arguments: args, ...(_meta ? { _meta } : {}) })) as { content: Array<{ text: string }>; isError?: boolean };
    return { text: result.content.map(c => c.text).join('\n'), isError: result.isError === true };
  };
  const toolNames = async () => (await client.listTools()).tools.map(t => t.name).sort();
  return { client, bridge, conversations, created, call, toolNames, listChanged: () => listChanged };
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
    expect(status.text).toMatch(/No VS Code window with the Copane extension is running/);
    expect(status.text).toMatch(/appear on their own/);
    const failed = await call('whoami');
    expect(failed.isError).toBe(true);
    expect(failed.text).toMatch(/Not connected/);

    await openWindow('100', ['/work/a']);
    await until(() => listChanged() > 0, 'tools/list_changed');
    expect(await toolNames()).toEqual(['whoami', 'window_select', 'window_status']);
    expect((await call('whoami')).text).toBe('Claude 1 in 100');
  });

  it('window_status says how to enable the browser when the window lists no browser tools', async () => {
    await openWindow('100', ['/work/a'], { browserOff: true });
    const without = await agent();
    expect((await without.call('window_status')).text).toMatch(/no browser_\* tools\. Ask the user to run the command "Copane: Enable Integrated Browser"/);
    // No browser tools because the user's settings turned them off: not the browser's fault.
    await openWindow('300', ['/work/c']);
    const filtered = await agent({ cwd: '/work/c' });
    expect((await filtered.call('window_status')).text).not.toMatch(/Enable Integrated Browser/);
    await openWindow('200', ['/work/b'], { browserTool: true });
    const withBrowser = await agent({ cwd: '/work/b' });
    const status = (await withBrowser.call('window_status')).text;
    expect(status).toMatch(/Connected to VS Code window 200/);
    expect(status).not.toMatch(/Enable Integrated Browser/);
  });

  it('waits for a window that is still starting at initialize, when the agent was started from VS Code', async () => {
    setTimeout(() => void openWindow('100', ['/work/a']), 100);
    const { client } = await agent({ initWaitMs: 2000, env: { TERM_PROGRAM: 'vscode' } });
    expect(client.getInstructions()).toContain('Window instructions of 100.');
  });

  it('does not wait for a window when the agent was started outside VS Code and none matches', async () => {
    // Registered for every session of the agent: one started in a plain terminal must not pay
    // the wait at its start and at every call.
    let started = Date.now();
    const { client, call, toolNames, listChanged } = await agent({ initWaitMs: 2000 });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(client.getInstructions()).toMatch(/Not connected to a VS Code window/);
    started = Date.now();
    expect((await call('whoami')).text).toMatch(/Not connected/);
    expect(Date.now() - started).toBeLessThan(100);

    // Windows of other projects are open: still nothing to wait for.
    await openWindow('200', ['/work/b']);
    await openWindow('300', ['/work/c']);
    const other = await agent({ initWaitMs: 2000, cwd: '/elsewhere' });
    started = Date.now();
    expect((await other.call('whoami')).text).toMatch(/Not connected/);
    expect(Date.now() - started).toBeLessThan(100);

    // Its own window opens later: picked up in the background, as before.
    await openWindow('100', ['/work/a']);
    await until(() => listChanged() > 0, 'tools/list_changed');
    expect(await toolNames()).toEqual(['whoami', 'window_select', 'window_status']);
    expect((await call('whoami')).text).toMatch(/in 100/);
  });

  it('survives a window reload: calls wait for the new window, the tool list does not flap', async () => {
    const first = await openWindow('100', ['/work/a', '/work/b']);
    // A `claude` CLI in a terminal: found through the terminal variable, which goes stale on reload.
    const { call, bridge, listChanged } = await agent({ env: { COPANE_INSTANCE: '100' }, cwd: '/elsewhere' });
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

  it('reports progress while a call runs, to a client that asked for it, so its time limit does not cut the call', async () => {
    const win = await openWindow('100', ['/work/a']);
    win.server['options'].tools.register([
      defineTool({ name: 'slow', description: 'x', input: {}, handler: () => new Promise<string>(resolve => setTimeout(() => resolve('done'), 260)) }),
    ]);
    const { client } = await agent({ progressMs: 50 });
    const seen: Array<{ progress: number; message?: string }> = [];
    // The SDK sends `_meta.progressToken` when a call wants progress, as agents do.
    const result = (await client.callTool({ name: 'slow', arguments: {} }, undefined, { onprogress: p => seen.push(p) })) as { content: Array<{ text: string }> };
    expect(result.content[0]!.text).toBe('done');
    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(seen[0]!.message).toMatch(/^slow is still running \(\d+ s\)$/);
    expect(seen.map(p => p.progress)).toEqual(seen.map((_p, i) => i + 1));
    // Nothing after the call has ended, and nothing for a call that did not ask.
    const count = seen.length;
    await client.callTool({ name: 'slow', arguments: {} });
    await new Promise(r => setTimeout(r, 120));
    expect(seen.length).toBe(count);
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

  it('finds the window of the folder a Copilot session works in, whatever folder the server was started from', async () => {
    await openWindow('100', ['/work/a']);
    await openWindow('200', ['/work/b']);
    const copilot = await agent({ clientName: 'copilot-cli', cwd: '/', env: { COPILOT_SESSION_CWD: '/work/b' } });
    expect((await copilot.call('whoami')).text).toMatch(/^Copilot 1 in 200/);
    // Another agent that only inherited the variable (started inside a Copilot session) goes by its own directory.
    const claude = await agent({ cwd: '/work/a', env: { COPILOT_SESSION_CWD: '/work/b' } });
    expect((await claude.call('whoami')).text).toBe('Claude 1 in 100');
    expect(sessionCwdFrom({ COPILOT_SESSION_CWD: '/work/b' }, 'copilot-cli')).toBe('/work/b');
    expect(sessionCwdFrom({ COPILOT_SESSION_CWD: '' }, 'copilot-cli')).toBeUndefined();
    expect(sessionCwdFrom({ COPILOT_SESSION_CWD: 'relative/dir' }, 'copilot-cli')).toBeUndefined();
    expect(sessionCwdFrom({ COPILOT_SESSION_CWD: '/work/b' }, 'claude-code')).toBeUndefined();
  });

  it('tells an agent started from VS Code (a window may still be starting) from one started elsewhere', () => {
    expect(startedFromVsCode({ TERM_PROGRAM: 'vscode' })).toBe(true);
    expect(startedFromVsCode({ COPANE_INSTANCE: '123' })).toBe(true);
    expect(startedFromVsCode({ VSCODE_IPC_HOOK: '/tmp/x.sock' })).toBe(true);
    // Copilot passes `${COPANE_INSTANCE:-}`: empty when its own environment has none.
    expect(startedFromVsCode({ COPANE_INSTANCE: '', PATH: '/usr/bin', TERM_PROGRAM: 'Apple_Terminal' })).toBe(false);
    expect(startedFromVsCode({})).toBe(false);
  });
  it('uses the explicit key, then the Claude Code session id, then a random one', () => {
    expect(sessionKeyFrom({ COPANE_SESSION: 'a', CLAUDE_CODE_SESSION_ID: 'b' })).toBe('a');
    expect(sessionKeyFrom({ CLAUDE_CODE_SESSION_ID: 'b' })).toBe('b');
    expect(sessionKeyFrom({ COPILOT_AGENT_SESSION_ID: 'c' })).toBe('c');
    expect(sessionKeyFrom({})).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("with the client known, uses only that agent's own session id, never one inherited from another agent", () => {
    const both = { CLAUDE_CODE_SESSION_ID: 'claude-id', COPILOT_AGENT_SESSION_ID: 'copilot-id' };
    expect(sessionKeyFrom(both, 'claude-code')).toBe('claude-id');
    expect(sessionKeyFrom(both, 'copilot-cli')).toBe('copilot-id');
    expect(sessionKeyFrom({ ...both, COPANE_SESSION: 'x' }, 'copilot-cli')).toBe('x');
    // A copilot started in a Claude Code shell, and a Claude Code started from Copilot.
    expect(sessionKeyFrom({ CLAUDE_CODE_SESSION_ID: 'claude-id' }, 'copilot-cli')).toMatch(/^[0-9a-f-]{36}$/);
    expect(sessionKeyFrom({ COPILOT_AGENT_SESSION_ID: 'copilot-id' }, 'claude-code')).toMatch(/^[0-9a-f-]{36}$/);
    // Agents without a session id of their own do not take another agent's.
    expect(sessionKeyFrom(both, 'codex-mcp-client')).toMatch(/^[0-9a-f-]{36}$/);
    expect(sessionKeyFrom(both, 'Visual Studio Code')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("chooses the key by the connected client's name", async () => {
    const win = await openWindow('100', ['/work/a']);
    const env = { CLAUDE_CODE_SESSION_ID: 'claude-id', COPILOT_AGENT_SESSION_ID: 'copilot-id' };
    const copilot = await agent({ env, clientName: 'copilot-cli', sessionKey: name => sessionKeyFrom(env, name) });
    expect((await copilot.call('whoami')).text).toContain('Copilot 1 in 100');
    expect(copilot.bridge.sessionKey).toBe('copilot-id');
    const claude = await agent({ env, clientName: 'claude-code', sessionKey: name => sessionKeyFrom(env, name) });
    expect((await claude.call('whoami')).text).toBe('Claude 1 in 100');
    expect(win.sessions.list().map(s => [s.id, s.label])).toEqual([
      ['copilot-id', 'Copilot 1'],
      ['claude-id', 'Claude 1'],
    ]);
  });

  it('gives a Copilot session the window instructions once, with its first tool result', async () => {
    await openWindow('100', ['/work/a']);
    const copilot = await agent({ clientName: 'copilot-cli' });
    const first = (await copilot.call('whoami')).text;
    expect(first.startsWith('Copilot 1 in 100\n')).toBe(true);
    expect(first).toContain("Copane's usage notes (shown once");
    expect(first).toContain('Window instructions of 100.');
    expect((await copilot.call('whoami')).text).toBe('Copilot 1 in 100');
    const claude = await agent({ clientName: 'claude-code', sessionKey: 'key-2' });
    expect((await claude.call('whoami')).text).toBe('Claude 1 in 100');
  });

  it('keeps the instructions under the length Claude Code shows', () => {
    const bridge = {
      current: { hello: { instructions: 'x'.repeat(10_000) } },
      connectionSummary: () => 'summary',
    } as unknown as BridgeClient;
    expect(buildInstructions(bridge).length).toBeLessThanOrEqual(4000);
  });
});

describe('VS Code chat conversations (one MCP server process for every chat of a window)', () => {
  const vscode = { clientName: 'Visual Studio Code', conversations: {} };

  it('gives each conversation its own session, reuses it for the same id, and keeps the default for calls without one', async () => {
    const win = await openWindow('100', ['/work/a'], { stateTools: true });
    const { call, created } = await agent(vscode);
    expect((await call('whoami')).text).toBe('Agent 1 in 100');
    expect((await call('whoami', {}, 'chat-a')).text).toBe('Agent 2 in 100');
    expect((await call('whoami', {}, 'chat-b')).text).toBe('Agent 3 in 100');
    expect((await call('whoami', {}, 'chat-a')).text).toBe('Agent 2 in 100');
    expect(created).toEqual([conversationSessionKey('chat-a'), conversationSessionKey('chat-b')]);

    await call('note', { text: 'a' }, 'chat-a');
    await call('note', { text: 'b' }, 'chat-b');
    expect((await call('recall', {}, 'chat-a')).text).toBe('a');
    expect((await call('recall', {}, 'chat-b')).text).toBe('b');
    expect((await call('recall')).text).toBe('(nothing)');

    expect((await call('window_status', {}, 'chat-b')).text).toMatch(/Connected to VS Code window 100 .* as "Agent 3"/);
    expect((await call('window_status')).text).toMatch(/as "Agent 1"/);
    const keys = win.sessions.list().map(s => s.id);
    expect(keys).toEqual(['key-1', conversationSessionKey('chat-a'), conversationSessionKey('chat-b')]);
    expect(win.sessions.list().every(s => s.client.name === 'Visual Studio Code' && s.client.kind === 'other')).toBe(true);
  });

  it('ignores the conversation id when the server is not set up for conversations', async () => {
    await openWindow('100', ['/work/a']);
    const { call } = await agent({ clientName: 'Visual Studio Code' });
    expect((await call('whoami', {}, 'chat-a')).text).toBe('Agent 1 in 100');
    expect((await call('whoami', {}, 'chat-b')).text).toBe('Agent 1 in 100');
  });

  it('reads only a usable conversation id, and namespaces its key', () => {
    expect(conversationIdOf({ 'vscode.conversationId': 'x' })).toBe('x');
    expect(conversationIdOf({ 'vscode.conversationId': '' })).toBeUndefined();
    expect(conversationIdOf({ 'vscode.conversationId': 7 })).toBeUndefined();
    expect(conversationIdOf({ progressToken: 1 })).toBeUndefined();
    expect(conversationIdOf(undefined)).toBeUndefined();
    expect(conversationSessionKey('x')).toMatch(/^vscode-chat:[0-9a-f]{32}$/);
    expect(conversationSessionKey('x')).toBe(conversationSessionKey('x'));
    expect(conversationSessionKey('x')).not.toBe(conversationSessionKey('y'));
    expect(conversationSessionKey('x', 's1')).toBe(`s1/${conversationSessionKey('x')}`);
    // The id itself is not in the key the window stores.
    expect(conversationSessionKey('vscode-chat-session://local/abc')).not.toContain('abc');
  });

  it('sends one tools/list_changed for a tool list change, however many conversations are connected', async () => {
    const win = await openWindow('100', ['/work/a']);
    const { call, listChanged, toolNames } = await agent(vscode);
    for (const id of ['a', 'b', 'c']) await call('whoami', {}, id);
    const before = listChanged();
    win.server['options'].tools.register([defineTool({ name: 'later', description: 'x', input: {}, handler: () => 'later' })]);
    await until(() => listChanged() > before, 'tools/list_changed');
    await new Promise(r => setTimeout(r, 300));
    expect(listChanged() - before).toBe(1);
    expect(await toolNames()).toContain('later');
    expect((await call('later', {}, 'b')).text).toBe('later');
  });

  it('closes the least recently used conversation beyond the limit; it resumes its session when it comes back', async () => {
    const win = await openWindow('100', ['/work/a'], { stateTools: true, graceMs: 5000 });
    const { call, conversations } = await agent({ ...vscode, conversations: { max: 2 } });
    await call('note', { text: 'kept' }, 'a');
    await call('whoami', {}, 'b');
    await call('whoami', {}, 'a'); // b is now the least recently used
    expect((await call('whoami', {}, 'c')).text).toBe('Agent 4 in 100');
    expect(conversations!.size).toBe(2);
    expect(conversations!.peek('b')).toBeUndefined();
    const keyB = conversationSessionKey('b');
    await until(() => win.sessions.get(keyB)?.connected === false, 'b to be disconnected in the window');
    expect((await call('whoami', {}, 'b')).text).toBe('Agent 3 in 100');
    expect(win.sessions.get(keyB)?.connected).toBe(true);
    // a was closed for b; it comes back to the same session with its state.
    expect(conversations!.peek('a')).toBeUndefined();
    expect((await call('recall', {}, 'a')).text).toBe('kept');
    expect(win.sessions.list()).toHaveLength(4);
  });

  it('never closes a conversation in the middle of a call', async () => {
    const win = await openWindow('100', ['/work/a']);
    win.server['options'].tools.register([
      defineTool({ name: 'slow', description: 'x', input: {}, handler: () => new Promise<string>(resolve => setTimeout(() => resolve('done'), 400)) }),
    ]);
    const { call, conversations } = await agent({ ...vscode, conversations: { max: 1 } });
    const slow = call('slow', {}, 'a');
    await new Promise(r => setTimeout(r, 100));
    expect((await call('whoami', {}, 'b')).text).toBe('Agent 3 in 100');
    expect((await slow).text).toBe('done');
    expect(conversations!.size).toBe(2);
    await call('whoami', {}, 'b');
    expect(conversations!.size).toBe(1);
    expect(conversations!.peek('a')).toBeUndefined();
  });

  it('closes a conversation that has been idle, and the window disconnects its session', async () => {
    const win = await openWindow('100', ['/work/a'], { graceMs: 5000 });
    const { call, conversations } = await agent({ ...vscode, conversations: { idleMs: 150, sweepMs: 30 } });
    await call('whoami', {}, 'a');
    const key = conversationSessionKey('a');
    expect(win.sessions.get(key)?.connected).toBe(true);
    await until(() => conversations!.size === 0, 'the idle conversation to be closed');
    await until(() => win.sessions.get(key)?.connected === false, 'the session to be disconnected');
    expect(win.sessions.get('key-1')?.connected).toBe(true);
    expect((await call('whoami', {}, 'a')).text).toBe('Agent 2 in 100');
  });

  it('window_select moves only the conversation that called it; a new conversation starts in the chosen window', async () => {
    await openWindow('100', ['/work/a']);
    await openWindow('200', ['/work/b']);
    const { call } = await agent(vscode);
    expect((await call('whoami', {}, 'a')).text).toBe('Agent 2 in 100');
    expect((await call('whoami', {}, 'b')).text).toBe('Agent 3 in 100');
    expect((await call('window_select', { window: '200' }, 'a')).text).toMatch(/Connected to VS Code window 200/);
    expect((await call('whoami', {}, 'a')).text).toBe('Agent 1 in 200');
    expect((await call('whoami', {}, 'b')).text).toBe('Agent 3 in 100');
    expect((await call('whoami')).text).toBe('Agent 1 in 100');
    expect((await call('whoami', {}, 'c')).text).toBe('Agent 2 in 200');
    expect((await call('window_status', {}, 'c')).text).toMatch(/chosen with window_select/);
  });

  it('a conversation follows its window through a reload', async () => {
    const first = await openWindow('100', ['/work/a']);
    const { call, conversations } = await agent(vscode);
    expect((await call('whoami', {}, 'a')).text).toBe('Agent 2 in 100');
    first.close();
    await until(() => !conversations!.peek('a')?.current, 'the conversation to see the window go away');
    setTimeout(() => void openWindow('200', ['/work/a']), 300);
    const result = await call('whoami', {}, 'a');
    expect(result.text).toMatch(/^Agent \d in 200$/);
    expect(conversations!.peek('a')?.current?.matchedBy).toBe('reconnect');
  });
});
