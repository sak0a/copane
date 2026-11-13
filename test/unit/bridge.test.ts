// The bridge server and the JSON-RPC peer over a real socket, without VS Code.
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { BridgeServer } from '../../src/extension/core/bridgeServer';
import { nullLogger } from '../../src/extension/core/log';
import { SessionManager } from '../../src/extension/core/sessions';
import { defineTool, ToolRegistry } from '../../src/extension/core/tools';
import { RpcError, RpcPeer } from '../../src/shared/jsonrpc';
import { ErrorCodes, Methods, PROTOCOL_VERSION, type CallToolResult, type HelloParams, type HelloResult } from '../../src/shared/protocol';

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
});
