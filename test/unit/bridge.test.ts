// The bridge server and the JSON-RPC peer over a real socket, without VS Code.
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { BridgeServer, dropsServerInstructions, USAGE_NOTES_HEADING, usageNotesPolicy, withUsageNotes } from '../../src/extension/core/bridgeServer';
import type { ToolSelection } from '../../src/extension/core/toolSelection';
import { ToolError } from '../../src/extension/core/errors';
import { nullLogger } from '../../src/extension/core/log';
import { SessionManager, type SessionClient } from '../../src/extension/core/sessions';
import { defineTool, image, text, ToolRegistry } from '../../src/extension/core/tools';
import { RpcError, RpcPeer } from '../../src/shared/jsonrpc';
import { ErrorCodes, Methods, PROTOCOL_VERSION, type CallToolResult, type HelloParams, type HelloResult, type ListToolsResult } from '../../src/shared/protocol';

const windowInfo = { instanceId: '1', workspaceName: 'w', workspaceFolders: ['/w'], remoteName: null, platform: process.platform };
let dir: string;
let socketPath: string;
let sessions: SessionManager;
let tools: ToolRegistry;
let server: BridgeServer;
const peers: RpcPeer[] = [];

function hello(sessionKey: string, token = 'secret'): HelloParams {
  return {
    protocolVersion: PROTOCOL_VERSION,
    token,
    sessionKey,
    client: { name: 'claude-code', kind: 'claude-code' },
    process: { pid: 1, cwd: '/w' },
    matchedBy: 'cwd',
  };
}

async function connect(): Promise<RpcPeer> {
  const socket = await new Promise<net.Socket>((resolve, reject) => {
    const s = net.connect(socketPath);
    s.once('connect', () => resolve(s));
    s.once('error', reject);
  });
  const peer = new RpcPeer(socket);
  peers.push(peer);
  return peer;
}

const closed = (peer: RpcPeer) => new Promise<void>(resolve => peer.onClose(resolve));

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-'));
  socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\ab-test-${process.pid}-${Date.now()}` : path.join(dir, 'b.sock');
  sessions = new SessionManager({ graceMs: () => 0 });
  tools = new ToolRegistry();
  tools.register([
    defineTool({ name: 'whoami', description: 'x', input: {}, handler: (_a, ctx) => ctx.session.label }),
    defineTool({
      name: 'wait',
      description: 'x',
      input: { ms: z.number() },
      handler: (args, ctx) =>
        new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => resolve('done'), args.ms);
          ctx.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('aborted'));
          });
        }),
    }),
  ]);
  server = new BridgeServer({ socketPath, token: 'secret', extensionVersion: '0.0.0', window: windowInfo, sessions, tools, log: nullLogger, instructions: () => 'hi' });
  await server.listen();
});

afterEach(() => {
  for (const peer of peers.splice(0)) peer.close();
  server.dispose();
  sessions.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('BridgeServer', () => {
  it('refuses tools before hello and a hello with the wrong token', async () => {
    const peer = await connect();
    await expect(peer.request(Methods.listTools)).rejects.toMatchObject({ code: ErrorCodes.unauthorized });
    await expect(peer.request(Methods.callTool, { name: 'whoami' })).rejects.toMatchObject({ code: ErrorCodes.unauthorized });
    await expect(peer.request(Methods.hello, hello('a', 'wrong'))).rejects.toMatchObject({ code: ErrorCodes.unauthorized });
    expect(sessions.list()).toEqual([]);
  });

  it('refuses another protocol version', async () => {
    const peer = await connect();
    await expect(peer.request(Methods.hello, { ...hello('a'), protocolVersion: 999 })).rejects.toMatchObject({ code: ErrorCodes.protocolMismatch });
  });

  it('gives each connection its own session and routes calls to it', async () => {
    const [a, b] = [await connect(), await connect()];
    const ha = await a.request<HelloResult>(Methods.hello, hello('a'));
    const hb = await b.request<HelloResult>(Methods.hello, hello('b'));
    expect([ha.session.label, hb.session.label]).toEqual(['Claude 1', 'Claude 2']);
    expect(ha.instructions).toBe('hi');
    const ra = await a.request<CallToolResult>(Methods.callTool, { name: 'whoami' });
    const rb = await b.request<CallToolResult>(Methods.callTool, { name: 'whoami' });
    expect([ra.content[0], rb.content[0]]).toEqual([{ type: 'text', text: 'Claude 1' }, { type: 'text', text: 'Claude 2' }]);
  });

  it('ends the session when its connection closes', async () => {
    const peer = await connect();
    await peer.request(Methods.hello, hello('a'));
    expect(sessions.list()).toHaveLength(1);
    peer.close();
    await expect.poll(() => sessions.list().length).toBe(0);
  });

  it('closes the connection of a session the user ended, without touching a newer session with the same key', async () => {
    const old = await connect();
    await old.request(Methods.hello, hello('a'));
    const oldClosed = closed(old);
    sessions.remove('a');
    await oldClosed;
    const fresh = await connect();
    await fresh.request(Methods.hello, hello('a'));
    await new Promise(r => setTimeout(r, 30));
    expect(sessions.get('a')?.connected).toBe(true);
  });

  it('aborts a running tool when the caller cancels', async () => {
    const peer = await connect();
    await peer.request(Methods.hello, hello('a'));
    const controller = new AbortController();
    const call = peer.request(Methods.callTool, { name: 'wait', arguments: { ms: 5000 } }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await expect(call).rejects.toMatchObject({ code: ErrorCodes.cancelled });
  });

  it('tells connected peers when the tool list changes', async () => {
    const peer = await connect();
    await peer.request(Methods.hello, hello('a'));
    const changed = new Promise<void>(resolve => peer.onNotification(Methods.toolsChanged, () => resolve()));
    tools.register([defineTool({ name: 'late', description: 'x', input: {}, handler: () => 'ok' })]);
    await changed;
  });
});

describe('RpcPeer', () => {
  it('rejects pending requests when the connection closes and times out slow ones', async () => {
    const peer = await connect();
    await peer.request(Methods.hello, hello('a'));
    await expect(peer.request(Methods.callTool, { name: 'wait', arguments: { ms: 5000 } }, { timeoutMs: 30 })).rejects.toThrow(/timed out/);
    const pending = peer.request(Methods.callTool, { name: 'wait', arguments: { ms: 5000 } });
    peer.close();
    await expect(pending).rejects.toBeInstanceOf(RpcError);
    await expect(peer.request(Methods.ping)).rejects.toMatchObject({ code: ErrorCodes.notReady });
  });

  it('answers unknown methods with an error instead of hanging', async () => {
    const peer = await connect();
    await expect(peer.request('nope')).rejects.toMatchObject({ code: ErrorCodes.methodNotFound });
  });

  /** A stream whose incoming bytes the test delivers, in the chunks it chooses. */
  function fakeStream() {
    const listeners: Array<(chunk: Buffer | string) => void> = [];
    const written: string[] = [];
    return {
      written,
      deliver: (chunk: Buffer | string) => listeners.forEach(l => l(chunk)),
      stream: {
        write: (data: string) => written.push(data),
        on: (event: string, listener: (...args: any[]) => void) => {
          if (event === 'data') listeners.push(listener);
        },
        destroy: () => {},
      },
    };
  }

  it('keeps characters of several bytes whole when a chunk boundary cuts them', () => {
    // A socket delivers a long message in chunks of bytes (8 kB on macOS), wherever they fall.
    const text = 'größe 漢字 — € 🙂 '.repeat(40);
    const bytes = Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', method: 'note', params: { text } })}\n`);
    for (const size of [1, 2, 3, 5, 7, 64]) {
      const { stream, deliver } = fakeStream();
      const received: string[] = [];
      new RpcPeer(stream).onNotification('note', p => received.push(p.text));
      for (let i = 0; i < bytes.length; i += size) deliver(bytes.subarray(i, i + size));
      expect(received, `in chunks of ${size} bytes`).toEqual([text]);
    }
  });

  it('reads several messages from one chunk and one message from many', () => {
    const { stream, deliver } = fakeStream();
    const received: number[] = [];
    new RpcPeer(stream).onNotification('n', p => received.push(p.i));
    const line = (i: number, pad = '') => `${JSON.stringify({ jsonrpc: '2.0', method: 'n', params: { i, pad } })}\n`;
    deliver(Buffer.from(line(1) + line(2) + '\n' + line(3).slice(0, 10)));
    expect(received).toEqual([1, 2]);
    deliver(line(3).slice(10) + 'not json\n');
    const long = line(4, 'x'.repeat(100_000));
    for (let i = 0; i < long.length; i += 8192) deliver(Buffer.from(long.slice(i, i + 8192)));
    deliver(line(5));
    expect(received).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('usage notes for clients that drop server instructions', () => {
  const copilotHello = (key: string): HelloParams => ({ ...hello(key), client: { name: 'copilot-cli', version: '1.0.105', kind: 'copilot' } });
  const call = (peer: RpcPeer, name: string) => peer.request<CallToolResult>(Methods.callTool, { name });
  const texts = (r: CallToolResult) => r.content.filter(c => c.type === 'text').map(c => (c as { text: string }).text);

  async function restart(needsUsageNotes?: (client: SessionClient) => boolean): Promise<void> {
    server.dispose();
    sessions.dispose();
    sessions = new SessionManager({ graceMs: () => 60_000 });
    if (!tools.list().some(t => t.name === 'shot')) tools.register([
      defineTool({ name: 'shot', description: 'x', input: {}, handler: () => [text('a picture'), image('AAAA')] }),
      defineTool({
        name: 'fail',
        description: 'x',
        input: {},
        handler: () => {
          throw new ToolError('not_found', 'nope');
        },
      }),
    ]);
    server = new BridgeServer({ socketPath, token: 'secret', extensionVersion: '0.0.0', window: windowInfo, sessions, tools, log: nullLogger, instructions: () => 'hi', ...(needsUsageNotes ? { needsUsageNotes } : {}) });
    await server.listen();
  }

  it('appends them once, to the first successful result, after its other parts', async () => {
    await restart();
    const peer = await connect();
    await peer.request(Methods.hello, copilotHello('cop'));
    const failed = await call(peer, 'fail');
    expect(failed).toEqual({ content: [{ type: 'text', text: 'nope' }], isError: true });
    const first = await call(peer, 'shot');
    expect(first.content).toEqual([
      { type: 'text', text: 'a picture' },
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      { type: 'text', text: `${USAGE_NOTES_HEADING}\nhi` },
    ]);
    expect(first.isError).toBeUndefined();
    expect(texts(await call(peer, 'shot'))).toEqual(['a picture']);
  });

  it('keeps them for the next result when the first one is as large as Copilot takes', async () => {
    await restart();
    // A full page: with the notes it would pass the size above which Copilot hands its model a file.
    tools.register([defineTool({ name: 'page', description: 'x', input: {}, handler: () => 'x'.repeat(19_800) })]);
    const peer = await connect();
    await peer.request(Methods.hello, copilotHello('cop-large'));
    expect(texts(await call(peer, 'page'))).toEqual(['x'.repeat(19_800)]);
    expect(texts(await call(peer, 'shot'))).toEqual(['a picture', `${USAGE_NOTES_HEADING}\nhi`]);
    expect(texts(await call(peer, 'shot'))).toEqual(['a picture']);
  });

  it('does not repeat them when the same session reconnects', async () => {
    await restart();
    const before = await connect();
    await before.request(Methods.hello, copilotHello('cop'));
    expect(texts(await call(before, 'whoami'))).toEqual(['Copilot 1', `${USAGE_NOTES_HEADING}\nhi`]);
    const gone = closed(before);
    before.close();
    await gone;
    const after = await connect();
    await after.request(Methods.hello, copilotHello('cop'));
    expect(texts(await call(after, 'whoami'))).toEqual(['Copilot 1']);
  });

  it('leaves other clients unchanged, and can be turned off', async () => {
    await restart();
    const claude = await connect();
    await claude.request(Methods.hello, hello('cl'));
    expect(await call(claude, 'shot')).toEqual({ content: [{ type: 'text', text: 'a picture' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }] });
    await restart(() => false);
    const copilot = await connect();
    await copilot.request(Methods.hello, copilotHello('cop'));
    expect(texts(await call(copilot, 'whoami'))).toEqual(['Copilot 1']);
  });

  it('applies to Copilot only, by client kind', () => {
    expect(dropsServerInstructions({ name: 'copilot-cli', kind: 'copilot' })).toBe(true);
    for (const kind of ['claude-code', 'codex', 'other'] as const) expect(dropsServerInstructions({ name: 'x', kind })).toBe(false);
    const result: CallToolResult = { content: [{ type: 'text', text: 'r' }] };
    expect(withUsageNotes(result, 'i')).toEqual({ content: [{ type: 'text', text: 'r' }, { type: 'text', text: `${USAGE_NOTES_HEADING}\ni` }] });
    expect(result.content).toHaveLength(1);
  });

  it('follows the user\'s switch (copane.usageNotesInResults), read at each call', async () => {
    let on = false;
    await restart(usageNotesPolicy(() => on));
    const copilot = await connect();
    await copilot.request(Methods.hello, copilotHello('cop'));
    expect(texts(await call(copilot, 'whoami'))).toEqual(['Copilot 1']);
    on = true;
    expect(texts(await call(copilot, 'whoami'))).toEqual(['Copilot 1', `${USAGE_NOTES_HEADING}\nhi`]);
    const policy = usageNotesPolicy(() => true);
    expect(policy({ name: 'copilot-cli', kind: 'copilot' })).toBe(true);
    expect(policy({ name: 'claude-code', kind: 'claude-code' })).toBe(false);
  });
});

describe('tool selection (copane.tools.*)', () => {
  let selection: ToolSelection = {};

  async function restart(): Promise<void> {
    server.dispose();
    server = new BridgeServer({ socketPath, token: 'secret', extensionVersion: '0.0.0', window: windowInfo, sessions, tools, log: nullLogger, instructions: () => 'hi', toolSelection: () => selection });
    await server.listen();
  }
  const names = async (peer: RpcPeer) => (await peer.request<ListToolsResult>(Methods.listTools)).tools.map(t => t.name);

  it('lists only the tools that are on and refuses calls to the others, read at each request', async () => {
    selection = { disabled: ['wait', 'unknown_tool'] };
    await restart();
    const peer = await connect();
    await peer.request(Methods.hello, hello('a'));
    expect(await names(peer)).toEqual(['whoami']);
    const refused = await peer.request<CallToolResult>(Methods.callTool, { name: 'wait', arguments: { ms: 1 } });
    expect(refused).toEqual({ content: [{ type: 'text', text: expect.stringMatching(/^wait is turned off in this VS Code window by the user's setting "copane.tools.disabled"\./) }], isError: true });
    selection = {};
    expect(await names(peer)).toEqual(['whoami', 'wait']);
    expect(await peer.request<CallToolResult>(Methods.callTool, { name: 'wait', arguments: { ms: 1 } })).toEqual({ content: [{ type: 'text', text: 'done' }] });
  });

  it('answers an old name of a merged tool through the new tool, unlisted, under the new tool\'s settings', async () => {
    const texts = (r: CallToolResult) => r.content.filter(c => c.type === 'text').map(c => (c as { text: string }).text);
    tools.register([
      defineTool({ name: 'terminal_send', description: 'x', input: { terminal: z.string().optional(), keys: z.array(z.string()).optional() }, handler: args => `sent ${JSON.stringify(args)}` }),
    ]);
    await restart();
    const peer = await connect();
    await peer.request(Methods.hello, hello('a'));
    expect(await names(peer)).not.toContain('terminal_interrupt');
    const note = '(terminal_interrupt is now terminal_send {"keys":["Ctrl+C"]}: call that from now on; the old name will be removed.)';
    expect(texts(await peer.request<CallToolResult>(Methods.callTool, { name: 'terminal_interrupt', arguments: { terminal: 'term-1' } }))).toEqual([
      `${note}\nsent {"terminal":"term-1","keys":["Ctrl+C"]}`,
    ]);
    // Arguments the old tool did not take are refused, as they would have been.
    const wrong = await peer.request<CallToolResult>(Methods.callTool, { name: 'terminal_interrupt', arguments: { text: 'y' } });
    expect(wrong.isError).toBe(true);
    expect(texts(wrong)[0]).toMatch(/^\(terminal_interrupt is now [^\n]*\nterminal_interrupt has no argument "text"; nothing was done\. Its arguments are "terminal"\./);
    // The new tool turned off: refused, naming it.
    selection = { disabled: ['terminal_send'] };
    expect(texts(await peer.request<CallToolResult>(Methods.callTool, { name: 'terminal_interrupt', arguments: {} }))[0]).toMatch(/^terminal_send is turned off/);
    // The old name turned off by name: refused too.
    selection = { disabled: ['terminal_interrupt'] };
    expect(texts(await peer.request<CallToolResult>(Methods.callTool, { name: 'terminal_interrupt', arguments: {} }))[0]).toMatch(/^terminal_interrupt is turned off/);
    selection = {};
  });

  it('tells connected peers when told the selection changed', async () => {
    await restart();
    const peer = await connect();
    await peer.request(Methods.hello, hello('a'));
    let count = 0;
    const changed = new Promise<void>(resolve => peer.onNotification(Methods.toolsChanged, () => (++count, resolve())));
    server.notifyToolsChanged();
    server.notifyToolsChanged();
    await changed;
    await new Promise(r => setTimeout(r, 100));
    expect(count).toBe(1);
  });
});
