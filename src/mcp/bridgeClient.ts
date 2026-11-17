// The MCP server's connection to its VS Code window: finds the window, says hello, keeps the tool
// list, and recovers when the window reloads or closes. Free of MCP and of process globals, so it is
// unit-tested against a real bridge server.
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import { RpcError, RpcPeer } from '../shared/jsonrpc';
import {
  Env,
  ErrorCodes,
  Methods,
  PROTOCOL_VERSION,
  type AgentKind,
  type CallToolResult,
  type HelloParams,
  type HelloResult,
  type InstanceInfo,
  type InstanceMatch,
  type ListToolsResult,
  type WireTool,
} from '../shared/protocol';
import { explainNoMatch, selectInstance, type DiscoveryResult } from './discovery';

export interface BridgeClientTiming {
  /** How often to look for a window while a caller waits for one. */
  pollMs: number;
  /** How often to look for a window in the background while disconnected. */
  backgroundMs: number;
  /** How long the last tool list stays visible after the window went away (a reload takes seconds). */
  graceMs: number;
  /** How long a tool call waits for a window to come back, when it was connected before. */
  callWaitAfterLossMs: number;
  /** How long a tool call waits for a window when it was never connected. */
  callWaitMs: number;
  helloTimeoutMs: number;
}

const DEFAULT_TIMING: BridgeClientTiming = {
  pollMs: 250,
  backgroundMs: 1000,
  graceMs: 30_000,
  callWaitAfterLossMs: 20_000,
  callWaitMs: 4_000,
  helloTimeoutMs: 10_000,
};

export interface BridgeClientOptions {
  env: NodeJS.ProcessEnv;
  cwd: string;
  pid: number;
  /**
   * The session key, or how to choose it from the MCP client's name (`sessionKeyFrom`). A function is
   * called once, at the first connection: MCP initialize, which names the client, comes before it.
   */
  sessionKey: string | ((clientName: string) => string);
  readInstances(): InstanceInfo[];
  ancestors(): Promise<number[]>;
  log(message: string): void;
  timing?: Partial<BridgeClientTiming>;
  /** A window chosen before this client existed (as with `window_select`), tried before discovery. */
  window?: string;
}

export interface Connection {
  peer: RpcPeer;
  hello: HelloResult;
  instance: InstanceInfo;
  matchedBy: InstanceMatch;
  note: string | undefined;
}

/** The environment variable in which an agent gives its MCP servers its own session id. */
const SESSION_ID_VARS: Partial<Record<AgentKind, string>> = {
  // The conversation id; the same when it is resumed with --resume, and its sub-agents use the same
  // MCP server process.
  'claude-code': 'CLAUDE_CODE_SESSION_ID',
  // Undocumented (observed in Copilot CLI 1.0.105): the id `copilot --resume=<id>` takes.
  copilot: 'COPILOT_AGENT_SESSION_ID',
};

/**
 * Stable identity of this agent session, so a reconnect resumes it: `COPANE_SESSION` when set, else
 * the session id the connected agent puts in its MCP servers' environment, else a random one.
 *
 * Agents started inside one another inherit each other's variables (a `copilot` run in a Claude Code
 * shell has `CLAUDE_CODE_SESSION_ID`), so when the client is known (`clientName`, from MCP
 * initialize) only that agent's own variable is used: another agent's id would make this session
 * take over that agent's session. Without a client name, the variables are tried in a fixed order.
 */
export function sessionKeyFrom(env: NodeJS.ProcessEnv, clientName?: string): string {
  const explicit = env[Env.sessionKey];
  if (explicit) return explicit;
  if (clientName !== undefined) {
    const own = SESSION_ID_VARS[agentKind(clientName)];
    return (own && env[own]) || randomUUID();
  }
  return env.CLAUDE_CODE_SESSION_ID || env.COPILOT_AGENT_SESSION_ID || randomUUID();
}

export function agentKind(clientName: string): AgentKind {
  const name = clientName.toLowerCase();
  if (name.includes('claude')) return 'claude-code';
  if (name.includes('codex')) return 'codex';
  if (name.includes('copilot')) return 'copilot';
  return 'other';
}

const MATCH_WORDS: Record<InstanceMatch, string> = {
  ancestor: "this agent was started by that window's extension host",
  env: 'COPANE_INSTANCE names it (set in its integrated terminals, and by the server definition it gives VS Code chat)',
  reconnect: 'it replaced the window this session used before (a window reload)',
  cwd: 'the working directory is inside its workspace',
  worktree: 'the working directory is a git worktree of a repository open in it',
  single: 'it is the only open window',
  explicit: 'chosen with window_select',
};

export class BridgeClient {
  private readonly timing: BridgeClientTiming;
  private connection: Connection | undefined;
  private connecting: Promise<Connection | undefined> | undefined;
  private ancestorList: Promise<number[]> | undefined;
  private tools: WireTool[] | undefined;
  /** Until when the last tool list is still shown while disconnected. */
  private toolsKeptUntil = 0;
  private previous: { id: string; workspaceFolders: string[] } | undefined;
  private explicit: string | undefined;
  private lastProblem: string | undefined;
  /** The bridge closed our connection while its window stayed open (the user ended the session). */
  private endedByWindow = false;
  private switching = false;
  private background: NodeJS.Timeout | undefined;
  private graceTimer: NodeJS.Timeout | undefined;
  private lastVisible = '[]';
  private disposed = false;
  private key: string | undefined;
  client: { name: string; version?: string } = { name: 'unknown' };
  /** Called when the tool list the agent should see has changed. */
  onToolsChanged: () => void = () => {};

  constructor(private readonly options: BridgeClientOptions) {
    this.timing = { ...DEFAULT_TIMING, ...options.timing };
    this.explicit = options.window;
  }

  get current(): Connection | undefined {
    return this.connection && !this.connection.peer.isClosed ? this.connection : undefined;
  }

  /** Fixed when first read, which is at the first connection (after MCP initialize named the client). */
  get sessionKey(): string {
    const { sessionKey } = this.options;
    this.key ??= typeof sessionKey === 'string' ? sessionKey : sessionKey(this.client.name);
    return this.key;
  }

  /** Starts looking for a window in the background, so tools appear once one opens. */
  start(): void {
    this.scheduleBackground();
  }

  /** Connects if needed, waiting up to `waitMs` for a window to appear. */
  async ensure(waitMs = 0): Promise<Connection | undefined> {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const current = this.current ?? (await this.attempt());
      if (current || this.disposed || Date.now() >= deadline) return current;
      await sleep(Math.min(this.timing.pollMs, Math.max(0, deadline - Date.now())));
    }
  }

  /** The tools the agent should see right now. */
  async listTools(): Promise<WireTool[]> {
    const connection = this.current;
    if (connection && !this.tools) await this.refreshTools(connection);
    return this.visibleTools();
  }

  visibleTools(): WireTool[] {
    if (this.current || this.endedByWindow || Date.now() < this.toolsKeptUntil) return this.tools ?? [];
    return [];
  }

  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
    // Right after the window went away it is most likely reloading: wait for it to come back.
    const reloading = Date.now() < this.toolsKeptUntil;
    const wait = reloading ? this.timing.callWaitAfterLossMs : this.timing.callWaitMs;
    const connection = await this.ensure(wait);
    if (!connection) return errorResult(`${this.notConnectedText()}\n${this.adviceText()}`);
    try {
      return await connection.peer.request<CallToolResult>(Methods.callTool, { name, arguments: args }, { signal });
    } catch (err) {
      if (err instanceof RpcError && err.code === ErrorCodes.cancelled) return errorResult('Cancelled.');
      if (err instanceof RpcError && err.code === ErrorCodes.notReady) {
        return errorResult(
          `The connection to VS Code closed during ${name} (the window was probably reloaded or closed). ` +
            'The call may or may not have taken effect; check before repeating it. The session reconnects on its own when the window is back.',
        );
      }
      return errorResult(`The connection to VS Code failed during ${name}: ${err instanceof Error ? err.message : String(err)}. Try again.`);
    }
  }

  /** Connects to a window chosen by the agent: an id, or a workspace name or folder. */
  async select(choice: string): Promise<{ ok: boolean; text: string }> {
    const instances = this.options.readInstances();
    const wanted = choice.trim().toLowerCase();
    const found =
      instances.find(i => i.id === choice.trim()) ??
      instances.find(i => (i.workspaceName ?? '').toLowerCase() === wanted) ??
      instances.find(i => i.workspaceFolders.some(f => f.toLowerCase() === wanted || baseName(f).toLowerCase() === wanted));
    if (!found) {
      return { ok: false, text: `There is no open window "${choice}".\n${this.windowListText(instances)}` };
    }
    this.explicit = found.id;
    // An attempt already under way targets the window chosen before; let it finish, then switch.
    if (this.connecting) await this.connecting.catch(() => undefined);
    const current = this.current;
    if (current && current.instance.id !== found.id) {
      this.switching = true;
      current.peer.close();
      this.switching = false;
    }
    const connection = await this.ensure(this.timing.callWaitMs);
    if (!connection || connection.instance.id !== found.id) {
      return { ok: false, text: `Could not connect to window ${found.id}. ${this.lastProblem ?? ''}`.trim() };
    }
    return { ok: true, text: this.statusText() };
  }

  /** Where this session is connected, or why not, and the open windows. For `window_status`. */
  statusText(): string {
    const instances = this.options.readInstances();
    const connection = this.current;
    const lines: string[] = [];
    if (connection) {
      const { instance, hello, matchedBy, note } = connection;
      lines.push(
        `Connected to VS Code window ${instance.id} ${describeWorkspace(instance)} as "${hello.session.label}". ` +
          `Matched because ${MATCH_WORDS[matchedBy]}.${note ? ` ${note}` : ''}`,
      );
      if (hello.window.remoteName) lines.push(`The window is a remote window (${hello.window.remoteName}); paths are as seen there.`);
    } else {
      lines.push(this.notConnectedText());
    }
    lines.push(this.windowListText(instances, connection?.instance.id));
    lines.push(connection ? 'To use another window instead, call window_select with its id.' : this.adviceText(instances));
    return lines.join('\n');
  }

  /** Short state line for the MCP `instructions`. */
  connectionSummary(): string {
    const connection = this.current;
    if (!connection) return this.notConnectedText();
    return `This session is connected to the VS Code window ${describeWorkspace(connection.instance)} as "${connection.hello.session.label}".`;
  }

  dispose(): void {
    this.disposed = true;
    if (this.background) clearInterval(this.background);
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.current?.peer.close();
  }

  private notConnectedText(): string {
    return `Not connected to a VS Code window. ${this.lastProblem ?? explainNoMatch({ instances: this.options.readInstances(), cwd: this.options.cwd, env: this.options.env })}`;
  }

  private adviceText(instances = this.options.readInstances()): string {
    if (instances.length === 0) {
      return (
        'What to do: ask the user to open this project in VS Code with the Copane extension installed. ' +
        'The tools appear on their own a few seconds after the window has started; no restart of this session is needed.'
      );
    }
    return 'What to do: call window_select with the id of the window whose project you are working in (or ask the user which one).';
  }

  private windowListText(instances: InstanceInfo[], connectedId?: string): string {
    if (instances.length === 0) return 'Open windows: none.';
    const rows = instances.map(i => {
      const remote = i.remoteName ? ` [${i.remoteName}]` : '';
      const mark = i.id === connectedId ? '  (connected)' : '';
      return `- ${i.id} ${describeWorkspace(i)}${remote}${mark}`;
    });
    return `Open windows:\n${rows.join('\n')}`;
  }

  private attempt(): Promise<Connection | undefined> {
    this.connecting ??= this.connectOnce().finally(() => (this.connecting = undefined));
    return this.connecting;
  }

  private async connectOnce(): Promise<Connection | undefined> {
    if (this.disposed) return undefined;
    const instances = this.options.readInstances();
    this.ancestorList ??= this.options.ancestors().catch(() => []);
    const found = selectInstance({
      instances,
      env: this.options.env,
      cwd: this.options.cwd,
      ancestors: instances.length > 0 ? await this.ancestorList : [],
      explicit: this.explicit,
      previous: this.previous,
      realpath: p => fs.realpathSync.native(p),
      readFile: p => fs.readFileSync(p, 'utf8'),
    });
    if (!found) {
      this.lastProblem = explainNoMatch({ instances, cwd: this.options.cwd, env: this.options.env });
      return undefined;
    }
    return this.open(found);
  }

  private async open({ instance, matchedBy, note }: DiscoveryResult): Promise<Connection | undefined> {
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
        process: { pid: this.options.pid, cwd: this.options.cwd },
        matchedBy,
      };
      const hello = await peer.request<HelloResult>(Methods.hello, params, { timeoutMs: this.timing.helloTimeoutMs });
      const connection: Connection = { peer, hello, instance, matchedBy, note };
      // Another window's tools must not stay visible if this window's list cannot be fetched.
      if (this.previous && this.previous.id !== instance.id && matchedBy !== 'reconnect') this.tools = undefined;
      peer.onNotification(Methods.toolsChanged, () => void this.refreshTools(connection));
      peer.onClose(() => this.handleClose(connection));
      this.connection = connection;
      this.previous = { id: instance.id, workspaceFolders: instance.workspaceFolders };
      this.endedByWindow = false;
      this.lastProblem = undefined;
      if (this.graceTimer) clearTimeout(this.graceTimer);
      this.options.log(`connected to window ${instance.id} (${instance.workspaceName ?? 'no workspace'}) as ${hello.session.label}, matched by ${matchedBy}`);
      await this.refreshTools(connection);
      return this.current;
    } catch (err) {
      peer?.close(); // Do not leave a half-open connection behind when hello fails.
      const message = err instanceof Error ? err.message : String(err);
      this.lastProblem = `Window ${instance.id} ${describeWorkspace(instance)} did not accept the connection: ${message}.`;
      this.options.log(`could not connect to window ${instance.id}: ${message}`);
      return undefined;
    }
  }

  private async refreshTools(connection: Connection): Promise<void> {
    try {
      const { tools } = await connection.peer.request<ListToolsResult>(Methods.listTools, undefined, { timeoutMs: 10_000 });
      if (this.connection !== connection) return;
      this.tools = tools;
    } catch (err) {
      this.options.log(`could not fetch the tool list: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.notifyIfChanged();
  }

  private handleClose(connection: Connection): void {
    if (this.connection !== connection) return;
    this.connection = undefined;
    const windowStillOpen = this.options.readInstances().some(i => i.id === connection.instance.id);
    if (this.switching) {
      // select() connects to the new window right away; the tool list changes once, from there.
      this.options.log(`left window ${connection.instance.id}`);
      return;
    }
    if (windowStillOpen) {
      // The window ended this session (the user stopped it) or its bridge restarted. Do not come back
      // on our own; the next tool call reconnects, which is the agent deciding to continue.
      this.endedByWindow = true;
      this.options.log(`window ${connection.instance.id} closed the connection`);
    } else {
      // Reloaded or closed. Keep showing the tools for a while: a reloaded window is back in seconds.
      this.options.log(`window ${connection.instance.id} went away; looking for it again`);
      this.toolsKeptUntil = Date.now() + this.timing.graceMs;
      if (this.graceTimer) clearTimeout(this.graceTimer);
      this.graceTimer = setTimeout(() => this.notifyIfChanged(), this.timing.graceMs + 10);
      this.graceTimer.unref?.();
    }
    this.notifyIfChanged();
    this.scheduleBackground();
  }

  private scheduleBackground(): void {
    if (this.background || this.disposed) return;
    this.background = setInterval(() => {
      if (this.disposed || this.current) {
        clearInterval(this.background);
        this.background = undefined;
        return;
      }
      if (this.endedByWindow || this.connecting) return;
      void this.attempt();
    }, this.timing.backgroundMs);
    this.background.unref?.();
  }

  private notifyIfChanged(): void {
    const visible = JSON.stringify(this.visibleTools());
    if (visible === this.lastVisible) return;
    this.lastVisible = visible;
    try {
      this.onToolsChanged();
    } catch {
      // The listener reports to the agent; nothing to do if that fails.
    }
  }
}

function describeWorkspace(instance: InstanceInfo): string {
  const name = instance.workspaceName ? `"${instance.workspaceName}"` : '(no folder open)';
  return instance.workspaceFolders.length ? `${name} (${instance.workspaceFolders.join(', ')})` : name;
}

function baseName(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

function errorResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
