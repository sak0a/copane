// Agent sessions of this window. One session = one MCP server process = one conversation of an agent
// (a Claude Code chat tab, a `claude` CLI run in a terminal, a Codex session ...). Each gets a label,
// a badge and a color, which is how the user tells them apart on tabs, terminals and in the UI.
import type { AgentKind, InstanceMatch, SessionDescriptor } from '../../shared/protocol';
import { Emitter, type Event } from './events';

export interface SessionColor {
  /** Stable id, e.g. "blue". */
  id: string;
  /** Theme color id usable with `new vscode.ThemeColor(...)`, including for terminal tab colors. */
  themeColor: string;
  /** Fallback CSS color for places without theme access (inside web pages). */
  hex: string;
}

export const SESSION_COLORS: readonly SessionColor[] = [
  { id: 'blue', themeColor: 'terminal.ansiBlue', hex: '#3794ff' },
  { id: 'magenta', themeColor: 'terminal.ansiMagenta', hex: '#c586c0' },
  { id: 'green', themeColor: 'terminal.ansiGreen', hex: '#23d18b' },
  { id: 'yellow', themeColor: 'terminal.ansiYellow', hex: '#e5c07b' },
  { id: 'cyan', themeColor: 'terminal.ansiCyan', hex: '#29b8db' },
  { id: 'red', themeColor: 'terminal.ansiRed', hex: '#f14c4c' },
];

export interface SessionClient {
  name: string;
  version?: string;
  kind: AgentKind;
}

export interface AgentSession {
  /** Stable across reconnects; equals the session key the MCP server presented. */
  readonly id: string;
  readonly client: SessionClient;
  /** 1-based, unique among live sessions of the same agent kind in this window. */
  readonly number: number;
  /** "Claude 2" */
  readonly label: string;
  /** "C2" */
  readonly badge: string;
  readonly color: SessionColor;
  /** Short task summary the agent set for itself via `session_set_title`, shown next to the label. */
  title: string | undefined;
  readonly pid: number | undefined;
  readonly cwd: string | undefined;
  readonly createdAt: number;
  lastActivityAt: number;
  /** False while the MCP server is disconnected and the grace period is running. */
  connected: boolean;
  /** How the MCP server found this window on its latest connection (for diagnostics). */
  matchedBy?: InstanceMatch;
}

export interface SessionConnectInfo {
  sessionKey: string;
  client: SessionClient;
  pid?: number;
  cwd?: string;
  matchedBy?: InstanceMatch;
}

export type SessionChange =
  | { type: 'added'; session: AgentSession }
  | { type: 'updated'; session: AgentSession }
  | { type: 'removed'; session: AgentSession };

const KIND_NAMES: Record<AgentKind, string> = { 'claude-code': 'Claude', codex: 'Codex', other: 'Agent' };

export interface SessionManagerOptions {
  /** How long a disconnected session is kept before it is removed. */
  graceMs?: () => number;
  now?: () => number;
}

export class SessionManager {
  private readonly sessions = new Map<string, AgentSession>();
  private readonly connections = new Map<string, number>();
  private readonly graceTimers = new Map<string, NodeJS.Timeout>();
  private readonly changeEmitter = new Emitter<SessionChange>();
  private readonly graceMs: () => number;
  private readonly now: () => number;

  /** Fires when a session is added, changes (title, connection state) or is removed for good. */
  readonly onDidChange: Event<SessionChange> = this.changeEmitter.event;

  constructor(options: SessionManagerOptions = {}) {
    this.graceMs = options.graceMs ?? (() => 20_000);
    this.now = options.now ?? Date.now;
  }

  /** Registers a connection. Returns the existing session when the key is known (a reconnect). */
  connect(info: SessionConnectInfo): AgentSession {
    this.connections.set(info.sessionKey, (this.connections.get(info.sessionKey) ?? 0) + 1);
    const timer = this.graceTimers.get(info.sessionKey);
    if (timer) {
      clearTimeout(timer);
      this.graceTimers.delete(info.sessionKey);
    }
    const existing = this.sessions.get(info.sessionKey);
    if (existing) {
      existing.connected = true;
      existing.lastActivityAt = this.now();
      if (info.matchedBy) existing.matchedBy = info.matchedBy;
      this.changeEmitter.fire({ type: 'updated', session: existing });
      return existing;
    }
    const number = this.freeNumber(info.client.kind);
    const name = KIND_NAMES[info.client.kind];
    const session: AgentSession = {
      id: info.sessionKey,
      client: info.client,
      number,
      label: `${name} ${number}`,
      badge: `${name.charAt(0)}${number > 9 ? '+' : number}`,
      color: this.freeColor(),
      title: undefined,
      pid: info.pid,
      cwd: info.cwd,
      createdAt: this.now(),
      lastActivityAt: this.now(),
      connected: true,
      ...(info.matchedBy ? { matchedBy: info.matchedBy } : {}),
    };
    this.sessions.set(session.id, session);
    this.changeEmitter.fire({ type: 'added', session });
    return session;
  }

  /** Call when a connection of the session closes. The session is removed after the grace period. */
  disconnect(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    const remaining = Math.max(0, (this.connections.get(id) ?? 1) - 1);
    this.connections.set(id, remaining);
    if (remaining > 0) return;
    session.connected = false;
    this.changeEmitter.fire({ type: 'updated', session });
    const grace = this.graceMs();
    if (grace <= 0) {
      this.remove(id);
      return;
    }
    const timer = setTimeout(() => this.remove(id), grace);
    timer.unref?.();
    this.graceTimers.set(id, timer);
  }

  /** Ends a session immediately (user action). */
  remove(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    const timer = this.graceTimers.get(id);
    if (timer) clearTimeout(timer);
    this.graceTimers.delete(id);
    this.connections.delete(id);
    this.sessions.delete(id);
    session.connected = false;
    this.changeEmitter.fire({ type: 'removed', session });
  }

  get(id: string): AgentSession | undefined {
    return this.sessions.get(id);
  }

  list(): AgentSession[] {
    return [...this.sessions.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  setTitle(id: string, title: string | undefined): void {
    const session = this.sessions.get(id);
    if (!session) return;
    const next = title?.trim().slice(0, 60) || undefined;
    if (next === session.title) return;
    session.title = next;
    this.changeEmitter.fire({ type: 'updated', session });
  }

  /** Records agent activity (used for idle detection and "last active" in the UI). Does not fire. */
  touch(id: string): void {
    const session = this.sessions.get(id);
    if (session) session.lastActivityAt = this.now();
  }

  dispose(): void {
    for (const timer of this.graceTimers.values()) clearTimeout(timer);
    this.graceTimers.clear();
    this.changeEmitter.dispose();
  }

  private freeNumber(kind: AgentKind): number {
    const used = new Set([...this.sessions.values()].filter(s => s.client.kind === kind).map(s => s.number));
    let n = 1;
    while (used.has(n)) n++;
    return n;
  }

  private freeColor(): SessionColor {
    const counts = new Map<string, number>(SESSION_COLORS.map(c => [c.id, 0]));
    for (const s of this.sessions.values()) counts.set(s.color.id, (counts.get(s.color.id) ?? 0) + 1);
    // Least used color, first in palette order on a tie.
    return [...SESSION_COLORS].sort((a, b) => counts.get(a.id)! - counts.get(b.id)!)[0]!;
  }
}

/** "Claude 2" or "Claude 2 · fixing login" */
export function sessionDisplayName(session: AgentSession): string {
  return session.title ? `${session.label} · ${session.title}` : session.label;
}

export function describeSession(session: AgentSession): SessionDescriptor {
  return { id: session.id, label: session.label, badge: session.badge, color: session.color.id };
}
