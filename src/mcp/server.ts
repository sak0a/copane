// MCP stdio server. One process per agent session, spawned by the agent (Claude Code, Codex, ...).
// It finds the VS Code window the agent runs in, connects to that window's bridge and forwards the
// tool list and tool calls. It holds no tool logic of its own.
import { randomUUID } from 'node:crypto';
import * as net from 'node:net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { RpcPeer } from '../shared/jsonrpc';
import { readLiveInstances } from '../shared/paths';
import {
  Env,
  MCP_SERVER_NAME,
  Methods,
  PROTOCOL_VERSION,
  type AgentKind,
  type CallToolResult,
  type HelloParams,
  type HelloResult,
  type ListToolsResult,
} from '../shared/protocol';
import { ancestorPids } from './ancestors';
import { selectInstance } from './discovery';

declare const __VERSION__: string | undefined;
const VERSION = typeof __VERSION__ === 'string' ? __VERSION__ : '0.0.0-dev';

const NOT_CONNECTED =
  'Not connected to a VS Code window. Open the project in VS Code with the Agent Bridge extension enabled, then try again. ' +
  'If VS Code is already open, run the command "Agent Bridge: Show Log" there to check that the extension started.';

function log(message: string): void {
  process.stderr.write(`[agent-bridge] ${message}\n`);
}

function agentKind(clientName: string): AgentKind {
  const name = clientName.toLowerCase();
  if (name.includes('claude')) return 'claude-code';
  if (name.includes('codex')) return 'codex';
  return 'other';
}

interface Connection {
  peer: RpcPeer;
  hello: HelloResult;
}

class BridgeClient {
  private connection: Connection | undefined;
  private connecting: Promise<Connection | undefined> | undefined;
  private readonly sessionKey = process.env[Env.sessionKey] || process.env.CLAUDE_CODE_SESSION_ID || randomUUID();
  private readonly ancestors = ancestorPids();
  client: { name: string; version?: string } = { name: 'unknown' };
  onToolsChanged: () => void = () => {};

  /** Connects if needed. Returns undefined when no window can be found right now. */
  async ensure(): Promise<Connection | undefined> {
    if (this.connection && !this.connection.peer.isClosed) return this.connection;
    this.connecting ??= this.connect().finally(() => (this.connecting = undefined));
    return this.connecting;
  }

  private async connect(): Promise<Connection | undefined> {
    const found = selectInstance({ instances: readLiveInstances(), env: process.env, cwd: process.cwd(), ancestors: this.ancestors });
    if (!found) return undefined;
    const { instance, matchedBy } = found;
    let peer: RpcPeer | undefined;
    try {
      const socket = await new Promise<net.Socket>((resolve, reject) => {
        const s = net.connect(instance.socketPath);
        s.once('connect', () => resolve(s));
        s.once('error', reject);
      });
      peer = new RpcPeer(socket);
      const params: HelloParams = {
        protocolVersion: PROTOCOL_VERSION,
        token: instance.token,
        sessionKey: this.sessionKey,
        client: { ...this.client, kind: agentKind(this.client.name) },
        process: { pid: process.pid, cwd: process.cwd() },
        matchedBy,
      };
      const hello = await peer.request<HelloResult>(Methods.hello, params, { timeoutMs: 10_000 });
      const connection: Connection = { peer, hello };
      peer.onNotification(Methods.toolsChanged, () => this.onToolsChanged());
      peer.onClose(() => {
        if (this.connection === connection) this.connection = undefined;
        log('disconnected from VS Code');
        this.onToolsChanged();
      });
      this.connection = connection;
      log(`connected to window ${instance.id} (${instance.workspaceName ?? 'no workspace'}) as ${hello.session.label}, matched by ${matchedBy}`);
      return connection;
    } catch (err) {
      peer?.close(); // Do not leave a half-open connection behind when hello fails.
      log(`could not connect to window ${instance.id}: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }
}

async function main(): Promise<void> {
  const bridge = new BridgeClient();
  // Connect before the MCP handshake so `instructions` can come from the window. The client info is
  // not known yet at this point; it is sent with the first hello after `initialize`.
  const server = new Server(
    { name: MCP_SERVER_NAME, version: VERSION },
    {
      capabilities: { tools: { listChanged: true } },
      instructions:
        "Tools for the VS Code window you are running in: its integrated browser tabs (browser_*) and integrated terminals (terminal_*). The user sees what you do there and can step in. Call session_info to see this window and your session's label.",
    },
  );

  server.oninitialized = () => {
    const info = server.getClientVersion();
    if (info) bridge.client = { name: info.name, version: info.version };
    void bridge.ensure();
  };
  bridge.onToolsChanged = () => void server.sendToolListChanged().catch(() => {});

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const connection = await bridge.ensure();
    if (!connection) return { tools: [] };
    const { tools } = await connection.peer.request<ListToolsResult>(Methods.listTools, undefined, { timeoutMs: 10_000 });
    return { tools: tools as any };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const connection = await bridge.ensure();
    if (!connection) return { content: [{ type: 'text', text: NOT_CONNECTED }], isError: true };
    try {
      return (await connection.peer.request<CallToolResult>(
        Methods.callTool,
        { name: request.params.name, arguments: request.params.arguments ?? {} },
        { signal: extra.signal },
      )) as any;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text', text: `The connection to VS Code failed during ${request.params.name}: ${message}. Try again.` }], isError: true };
    }
  });

  await server.connect(new StdioServerTransport());
  // The agent closing our stdin means the session ended.
  process.stdin.on('close', () => process.exit(0));
}

main().catch(err => {
  log(`fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
