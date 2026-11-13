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
  /**
   * Where sessions are remembered across window reloads (the window's workspace state). With it, a
   * session that reconnects after a reload gets its label, badge, color and title back, so the names
   * and colors on its terminals (which survive the reload) stay true.
   */
  memory?: SessionMemory;
}

/** What is remembered of a session, so it can be given the same identity when it comes back. */
export interface RememberedSession {
  id: string;
  client: SessionClient;
  number: number;
  colorId: string;
  title?: string;
  pid?: number;
  cwd?: string;
  createdAt: number;
  /** When the window last knew it (refreshed while the session exists). */
  seenAt: number;
  /** Still a session of the window when saved (connected or within its grace period), not ended. */
  live: boolean;
}

export interface SessionMemory {
  load(): readonly RememberedSession[];
  save(sessions: RememberedSession[]): void;
}

/** Sessions of a window that was open this recently are taken to be coming back (a reload or restart). */
export const RESTORE_WINDOW_MS = 10 * 60_000;
/** Restored sessions wait at least this long for their agent to reconnect: a reload takes seconds. */
export const RESTORE_GRACE_MS = 30_000;
/** Ended sessions are remembered this long, so one that comes back late can get its number back if it is free. */
const ENDED_MEMORY_MS = 24 * 60 * 60_000;
const ENDED_MEMORY_MAX = 30;
const HEARTBEAT_MS = 60_000;

export class SessionManager {
  private readonly sessions = new Map<string, AgentSession>();
  private readonly connections = new Map<string, number>();
  private readonly graceTimers = new Map<string, NodeJS.Timeout>();
  private readonly changeEmitter = new Emitter<SessionChange>();
  private readonly graceMs: () => number;
  private readonly now: () => number;
  private readonly memory: SessionMemory | undefined;
  /** Identities of ended sessions (by key), for one that comes back later. */
  private readonly ended = new Map<string, RememberedSession>();
  private heartbeat: NodeJS.Timeout | undefined;

  /** Fires when a session is added, changes (title, connection state) or is removed for good. */
  readonly onDidChange: Event<SessionChange> = this.changeEmitter.event;

  constructor(options: SessionManagerOptions = {}) {
    this.graceMs = options.graceMs ?? (() => 20_000);
    this.now = options.now ?? Date.now;
    this.memory = options.memory;
    if (this.memory) this.restore(this.memory.load());
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
      this.save();
      return existing;
    }
    // A session that ended a while ago and comes back: same color and title, and its number when no
    // other session took it meanwhile.
    const before = this.ended.get(info.sessionKey);
    const known = before && before.client.kind === info.client.kind ? before : undefined;
    this.ended.delete(info.sessionKey);
    const number = known && !this.numberTaken(info.client.kind, known.number) ? known.number : this.freeNumber(info.client.kind);
    const session = this.build({
      id: info.sessionKey,
      client: info.client,
      number,
      color: (known && SESSION_COLORS.find(c => c.id === known.colorId)) || this.freeColor(),
      title: known?.title,
      pid: info.pid,
      cwd: info.cwd,
      createdAt: this.now(),
      connected: true,
      matchedBy: info.matchedBy,
    });
    this.sessions.set(session.id, session);
    this.changeEmitter.fire({ type: 'added', session });
    this.save();
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
    this.startGrace(id, grace);
    this.save();
  }

  private startGrace(id: string, ms: number): void {
    const timer = setTimeout(() => this.remove(id), ms);
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
    if (this.memory) {
      this.ended.set(id, { ...this.remember(session), live: false });
      this.pruneEnded();
    }
    this.changeEmitter.fire({ type: 'removed', session });
    this.save();
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
    this.save();
  }

  /** Records agent activity (used for idle detection and "last active" in the UI). Does not fire. */
  touch(id: string): void {
    const session = this.sessions.get(id);
    if (session) session.lastActivityAt = this.now();
  }

  dispose(): void {
    for (const timer of this.graceTimers.values()) clearTimeout(timer);
    this.graceTimers.clear();
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    this.changeEmitter.dispose();
  }

  // ------------------------------------------------------------------ memory across reloads

  /**
   * Brings back the sessions of the window's previous extension host (a reload, or VS Code restarted
   * within RESTORE_WINDOW_MS): as disconnected sessions in their grace period, with the same label,
   * badge, color and title, so their number is not given to another session while they reconnect.
   * Older or ended ones are only remembered, to get their number back later if it is still free.
   */
  private restore(remembered: readonly RememberedSession[]): void {
    const now = this.now();
    const grace = this.graceMs();
    for (const r of remembered) {
      if (!r || typeof r.id !== 'string' || !r.client || typeof r.number !== 'number') continue;
      const recent = now - r.seenAt < RESTORE_WINDOW_MS;
      if (r.live && recent && grace > 0 && !this.sessions.has(r.id) && !this.numberTaken(r.client.kind, r.number)) {
        const session = this.build({
          id: r.id,
          client: r.client,
          number: r.number,
          color: SESSION_COLORS.find(c => c.id === r.colorId) ?? this.freeColor(),
          title: r.title,
          pid: r.pid,
          cwd: r.cwd,
          createdAt: r.createdAt,
          connected: false,
          matchedBy: undefined,
        });
        this.sessions.set(session.id, session);
        this.startGrace(session.id, Math.max(grace, RESTORE_GRACE_MS));
      } else if (now - r.seenAt < ENDED_MEMORY_MS) {
        this.ended.set(r.id, { ...r, live: false });
      }
    }
    this.pruneEnded();
    this.save();
  }

  private build(fields: Omit<AgentSession, 'label' | 'badge' | 'lastActivityAt' | 'matchedBy'> & { matchedBy: InstanceMatch | undefined }): AgentSession {
    const name = KIND_NAMES[fields.client.kind];
    const { matchedBy, ...rest } = fields;
    return {
      ...rest,
      label: `${name} ${fields.number}`,
      badge: `${name.charAt(0)}${fields.number > 9 ? '+' : fields.number}`,
      lastActivityAt: this.now(),
      ...(matchedBy ? { matchedBy } : {}),
    };
  }

  private remember(s: AgentSession): RememberedSession {
    return {
      id: s.id,
      client: s.client,
      number: s.number,
      colorId: s.color.id,
      ...(s.title ? { title: s.title } : {}),
      ...(s.pid !== undefined ? { pid: s.pid } : {}),
      ...(s.cwd !== undefined ? { cwd: s.cwd } : {}),
      createdAt: s.createdAt,
      seenAt: this.now(),
      live: true,
    };
  }

  private pruneEnded(): void {
    const now = this.now();
    for (const [id, r] of this.ended) if (now - r.seenAt >= ENDED_MEMORY_MS) this.ended.delete(id);
    const extra = this.ended.size - ENDED_MEMORY_MAX;
    if (extra > 0) [...this.ended.entries()].sort((a, b) => a[1].seenAt - b[1].seenAt).slice(0, extra).forEach(([id]) => this.ended.delete(id));
  }

  /** Writes what to remember; while sessions exist, refreshed every minute so a reload can tell they were just here. */
  private save(): void {
    if (!this.memory) return;
    const live = [...this.sessions.values()].map(s => this.remember(s));
    try {
      this.memory.save([...live, ...this.ended.values()]);
    } catch {
      // Remembering is best effort.
    }
    if (live.length > 0 && !this.heartbeat) {
      this.heartbeat = setInterval(() => this.save(), HEARTBEAT_MS);
      this.heartbeat.unref?.();
    } else if (live.length === 0 && this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
  }

  private numberTaken(kind: AgentKind, number: number): boolean {
    for (const s of this.sessions.values()) if (s.client.kind === kind && s.number === number) return true;
    return false;
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
