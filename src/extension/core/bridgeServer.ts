// The socket server of one VS Code window. Each connection is one MCP server process, i.e. one agent
// session. It authenticates with the token from the instance file, then lists and calls tools.
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { RpcError, RpcPeer } from '../../shared/jsonrpc';
import { ensurePrivateDir } from '../../shared/paths';
import {
  ErrorCodes,
  Methods,
  PROTOCOL_VERSION,
  type CallToolParams,
  type CallToolResult,
  type HelloParams,
  type HelloResult,
  type ListToolsResult,
  type WindowDescriptor,
} from '../../shared/protocol';
import type { Disposable } from './events';
import { scopedLogger, type Logger } from './log';
import { describeSession, type AgentSession, type SessionManager } from './sessions';
import type { ToolRegistry } from './tools';

export interface BridgeServerOptions {
  socketPath: string;
  token: string;
  extensionVersion: string;
  window: WindowDescriptor;
  sessions: SessionManager;
  tools: ToolRegistry;
  log: Logger;
  /** Usage guidance sent to each agent, built at connect time so it reflects current capabilities. */
  instructions: () => string;
}

export class BridgeServer implements Disposable {
  private readonly server: net.Server;
  private readonly peers = new Set<RpcPeer>();
  private readonly peerSessions = new Map<RpcPeer, AgentSession>();
  private readonly subscriptions: Disposable[] = [];

  constructor(private readonly options: BridgeServerOptions) {
    this.server = net.createServer(socket => this.accept(socket));
    this.server.on('error', err => options.log.error('bridge server error', err));
    // Tell every connected MCP server to re-fetch the list (coalesced, modules register in bursts).
    let scheduled = false;
    this.subscriptions.push(
      options.tools.onDidChange(() => {
        if (scheduled) return;
        scheduled = true;
        setTimeout(() => {
          scheduled = false;
          for (const peer of this.peers) peer.notify(Methods.toolsChanged);
        }, 50);
      }),
      // A session that was ended (by the user, or after its grace period) must not keep acting
      // through a connection that is still open.
      options.sessions.onDidChange(change => {
        if (change.type !== 'removed') return;
        for (const [peer, session] of [...this.peerSessions]) if (session === change.session) peer.close();
      }),
    );
  }

  async listen(): Promise<void> {
    const { socketPath } = this.options;
    if (process.platform !== 'win32') {
      ensurePrivateDir(path.dirname(socketPath));
      fs.rmSync(socketPath, { force: true }); // A stale socket of a crashed host with a recycled pid.
    }
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(socketPath, () => {
        this.server.off('error', reject);
        resolve();
      });
    });
    if (process.platform !== 'win32') fs.chmodSync(socketPath, 0o600);
  }

  private accept(socket: net.Socket): void {
    const { options } = this;
    const peer = new RpcPeer(socket);
    let session: AgentSession | undefined;
    this.peers.add(peer);

    const requireSession = (): AgentSession => {
      if (!session) throw new RpcError(ErrorCodes.unauthorized, 'send "hello" first');
      return session;
    };

    peer.onRequest(Methods.hello, (params: HelloParams): HelloResult => {
      if (!params || params.token !== options.token) throw new RpcError(ErrorCodes.unauthorized, 'invalid token');
      if (params.protocolVersion !== PROTOCOL_VERSION) {
        throw new RpcError(
          ErrorCodes.protocolMismatch,
          `protocol version ${params.protocolVersion} is not supported (expected ${PROTOCOL_VERSION}); update the extension`,
        );
      }
      if (session) throw new RpcError(ErrorCodes.invalidParams, 'hello was already sent on this connection');
      session = options.sessions.connect({
        sessionKey: params.sessionKey,
        client: params.client,
        pid: params.process?.pid,
        cwd: params.process?.cwd,
      });
      this.peerSessions.set(peer, session);
      options.log.info(`${session.label} connected (${params.client.name} ${params.client.version ?? ''}, pid ${params.process?.pid}, matched by ${params.matchedBy})`);
      return {
        protocolVersion: PROTOCOL_VERSION,
        extensionVersion: options.extensionVersion,
        session: describeSession(session),
        window: options.window,
        instructions: options.instructions(),
      };
    });

    peer.onRequest(Methods.ping, () => ({}));

    peer.onRequest(Methods.listTools, (): ListToolsResult => {
      requireSession();
      return { tools: options.tools.list() };
    });

    peer.onRequest(Methods.callTool, async (params: CallToolParams, ctx): Promise<CallToolResult> => {
      const current = requireSession();
      options.sessions.touch(current.id);
      const started = Date.now();
      const result = await options.tools.call(params.name, params.arguments, {
        session: current,
        signal: ctx.signal,
        log: scopedLogger(options.log, `${current.label} ${params.name}`),
      });
      options.log.debug(`${current.label} ${params.name} ${result.isError ? 'failed' : 'ok'} in ${Date.now() - started} ms`);
      return result;
    });

    peer.onClose(() => {
      this.peers.delete(peer);
      this.peerSessions.delete(peer);
      // Only if it is still the live session: the key may belong to a newer session by now.
      if (session && options.sessions.get(session.id) === session) {
        options.log.info(`${session.label} disconnected`);
        options.sessions.disconnect(session.id);
      }
    });
  }

  dispose(): void {
    for (const s of this.subscriptions.splice(0)) s.dispose();
    for (const peer of [...this.peers]) peer.close();
    this.peers.clear();
    this.peerSessions.clear();
    this.server.close();
    if (process.platform !== 'win32') fs.rmSync(this.options.socketPath, { force: true });
  }
}
