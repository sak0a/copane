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
import { blockByteLimit, COPILOT_FILE_THRESHOLD_BYTES, utf8Bytes } from './resultSize';
import { describeSession, type AgentSession, type SessionClient, type SessionManager } from './sessions';
import { resolveToolAlias, withAliasNote } from './toolAliases';
import { disabledToolMessage, isToolEnabled, type ToolSelection } from './toolSelection';
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
  /**
   * Whether a session's client is known not to pass MCP server instructions to its model; such a
   * session gets them once, with its first successful tool result. Default `dropsServerInstructions`;
   * `() => false` turns it off.
   */
  needsUsageNotes?: (client: SessionClient) => boolean;
  /**
   * Which tools agents get (the user's `copane.tools.*` settings), read on every list and call. Tools
   * it turns off are not listed, and a call to one is refused with a message. Default: all tools.
   * Call `notifyToolsChanged` when it changes.
   */
  toolSelection?: () => ToolSelection;
}

/**
 * Clients known not to give the model the server's MCP `instructions`. Copilot CLI passes them only
 * when started with `--allow-all-mcp-server-instructions`.
 */
export function dropsServerInstructions(client: SessionClient): boolean {
  return client.kind === 'copilot';
}

/**
 * `needsUsageNotes` with the user's switch (`copane.usageNotesInResults`): off for someone who starts
 * Copilot with `--allow-all-mcp-server-instructions`, whose model already gets the instructions.
 */
export function usageNotesPolicy(enabled: () => boolean, needs: (client: SessionClient) => boolean = dropsServerInstructions): (client: SessionClient) => boolean {
  return client => enabled() && needs(client);
}

/**
 * A result with the usage notes stays below this, so that Copilot still gives it to its model
 * instead of a file (core/resultSize.ts): a first call that returns a full page keeps the notes
 * for the call after it.
 */
export const USAGE_NOTES_RESULT_BYTES = COPILOT_FILE_THRESHOLD_BYTES - 1000;

function textBytes(result: CallToolResult): number {
  return result.content.reduce((n, part) => n + (part.type === 'text' ? utf8Bytes(part.text) : 0), 0);
}

export const USAGE_NOTES_HEADING = "Copane's usage notes (shown once, with your first Copane tool result):";

/**
 * The result with the usage notes added as one more text part after everything else; content and
 * other fields are left as they are.
 */
export function withUsageNotes(result: CallToolResult, instructions: string): CallToolResult {
  return { ...result, content: [...result.content, { type: 'text', text: `${USAGE_NOTES_HEADING}\n${instructions}` }] };
}

export class BridgeServer implements Disposable {
  private readonly server: net.Server;
  private readonly peers = new Set<RpcPeer>();
  private readonly peerSessions = new Map<RpcPeer, AgentSession>();
  private readonly subscriptions: Disposable[] = [];
  /** Sessions that have been given the usage notes in a tool result (see `needsUsageNotes`). */
  private readonly notesGiven = new WeakSet<AgentSession>();
  private changeScheduled = false;

  constructor(private readonly options: BridgeServerOptions) {
    this.server = net.createServer(socket => this.accept(socket));
    this.server.on('error', err => options.log.error('bridge server error', err));
    this.subscriptions.push(
      options.tools.onDidChange(() => this.notifyToolsChanged()),
      // A session that was ended (by the user, or after its grace period) must not keep acting
      // through a connection that is still open.
      options.sessions.onDidChange(change => {
        if (change.type !== 'removed') return;
        for (const [peer, session] of [...this.peerSessions]) if (session === change.session) peer.close();
      }),
    );
  }

  /**
   * Tells every connected MCP server to re-fetch the tool list, which tells its client (coalesced:
   * modules register in bursts). For a change of `toolSelection`; registry changes do it themselves.
   */
  notifyToolsChanged(): void {
    if (this.changeScheduled) return;
    this.changeScheduled = true;
    setTimeout(() => {
      this.changeScheduled = false;
      for (const peer of this.peers) peer.notify(Methods.toolsChanged);
    }, 50);
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
        matchedBy: params.matchedBy,
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
      const selection = options.toolSelection?.();
      return { tools: selection ? options.tools.list().filter(t => isToolEnabled(selection, t.name)) : options.tools.list() };
    });

    peer.onRequest(Methods.callTool, async (params: CallToolParams, ctx): Promise<CallToolResult> => {
      const current = requireSession();
      options.sessions.touch(current.id);
      const selection = options.toolSelection?.();
      // An old name of a merged tool (core/toolAliases.ts): call the new tool, under its settings too.
      const alias = options.tools.has(params.name) ? undefined : resolveToolAlias(params.name, params.arguments);
      const name = alias?.name ?? params.name;
      const off = selection && [params.name, name].find(n => !isToolEnabled(selection, n));
      if (selection && off) {
        return { content: [{ type: 'text', text: disabledToolMessage(selection, off) }], isError: true };
      }
      if (alias && 'error' in alias) return withAliasNote({ content: [{ type: 'text', text: alias.error }], isError: true }, alias.note);
      const started = Date.now();
      const called = await options.tools.call(name, alias ? alias.args : params.arguments, {
        session: current,
        signal: ctx.signal,
        log: scopedLogger(options.log, `${current.label} ${name}`),
      });
      const result = alias ? withAliasNote(called, alias.note) : called;
      options.log.debug(`${current.label} ${params.name}${alias ? ` (as ${name})` : ''} ${result.isError ? 'failed' : 'ok'} in ${Date.now() - started} ms`);
      // Once per session (the session object outlives reconnects with the same key), on success only,
      // and not with a result the notes would make too large for the client: they wait for the next.
      if (!result.isError && !this.notesGiven.has(current) && (options.needsUsageNotes ?? dropsServerInstructions)(current.client)) {
        const noted = withUsageNotes(result, options.instructions());
        if (blockByteLimit(current.client) === undefined || textBytes(noted) <= USAGE_NOTES_RESULT_BYTES) {
          this.notesGiven.add(current);
          return noted;
        }
      }
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
