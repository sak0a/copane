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
  /**
   * What the user sees the session called, on its terminals and tabs and in the views: its name
   * (`title`) when it has one, else `autoLabel`. Unique in the window. Changes when the session is
   * named (`SessionManager.setTitle`), so read it when needed rather than keeping a copy.
   */
  label: string;
  /** "Claude 2": agent kind and number, never changes. What `label` is while the session has no name. */
  readonly autoLabel: string;
  /** "C2" */
  readonly badge: string;
  readonly color: SessionColor;
  /**
   * The session's name, e.g. "checkout tests": given by the user ("Rename Agent Session") or by the
   * agent (`session_set_title`), shown instead of `autoLabel`. Undefined: no name.
   */
  title: string | undefined;
  /** Who gave the name. A name the user gave is never replaced by the agent. */
  titleBy?: 'user' | 'agent';
  readonly pid: number | undefined;
  readonly cwd: string | undefined;
  readonly createdAt: number;
  lastActivityAt: number;
  /** False while the MCP server is disconnected and the grace period is running, and while away. */
  connected: boolean;
  /**
   * A session of an earlier run of this window (before a reload or a restart of VS Code) whose agent
   * has not come back yet. It has no time limit: it stays while it still owns a tab or a terminal,
   * so those keep their session until the agent reconnects (its conversation is continued) or the
   * user ends it. See `SessionManagerOptions.holds`.
   */
  away?: boolean;
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

const KIND_NAMES: Record<AgentKind, string> = { 'claude-code': 'Claude', codex: 'Codex', copilot: 'Copilot', other: 'Agent' };
/** Names that read like an automatic label ("Claude 3"): given to a session, they would be mistaken for another one. */
const AUTOMATIC_LABEL = new RegExp(`^(?:${Object.values(KIND_NAMES).join('|')})\\s+\\d+$`, 'i');
/** Longest session name, in characters. Agents are asked for much shorter ones (`session_set_title`). */
export const MAX_SESSION_NAME = 60;

/** Why a name was not given to a session (`SessionManager.setTitle`). */
export type NameRefusal =
  /** The user named the session, and the agent tried to change it. */
  | { reason: 'named-by-user'; name: string }
  /** Another session of the window is called that. */
  | { reason: 'taken'; by: AgentSession }
  /** It reads like the automatic label of another session ("Claude 3"). */
  | { reason: 'automatic' };

/**
 * One line, no control characters and no bidirectional overrides (which could make a name in a prompt
 * read differently from what it is), at most MAX_SESSION_NAME characters; undefined when nothing is left.
 */
export function normalizeSessionName(value: string | undefined): string | undefined {
  const line = (value ?? '')
    .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '')
    .replace(/[\p{Cc}\s]+/gu, ' ')
    .trim();
  return Array.from(line).slice(0, MAX_SESSION_NAME).join('').trim() || undefined;
}
/**
 * The badge letter where it is not the name's first letter. Badges are at most two characters (VS Code
 * file decorations), so Claude, Codex and Copilot cannot all be told apart by their name: Copilot is
 * "G" (GitHub Copilot). Claude and Codex keep "C"; their color and tooltip tell them apart.
 */
const BADGE_LETTERS: Partial<Record<AgentKind, string>> = { copilot: 'G' };

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
  /**
   * Whether a session still owns something in the window (a tab it opened, a terminal of its own).
   * With it, a session restored from before a reload or restart is not ended when its agent has not
   * reconnected after the grace period: it stays as an `away` session for as long as this is true.
   * An agent chat reconnects only when the user continues it, long after any grace period, and its
   * tabs and terminals would meanwhile belong to nobody. Call `reviewAway` when the answer may have
   * changed. Without it, restored sessions end after their grace period.
   */
  holds?: (sessionId: string) => boolean;
}

/** What is remembered of a session, so it can be given the same identity when it comes back. */
export interface RememberedSession {
  id: string;
  client: SessionClient;
  number: number;
  colorId: string;
  title?: string;
  /** Who gave `title`; absent in records of older versions (where only agents gave titles). */
  titleBy?: 'user' | 'agent';
  pid?: number;
  cwd?: string;
  createdAt: number;
  /** When the window last knew it (refreshed while the session exists). */
  seenAt: number;
  /** Still a session of the window when saved (connected, within its grace period or away), not ended. */
  live: boolean;
  /** It was away when saved: it comes back away, not as one that is about to reconnect. */
  away?: boolean;
}

export interface SessionMemory {
  load(): readonly RememberedSession[];
  save(sessions: RememberedSession[]): void;
}

/** Sessions of a window that was open this recently are taken to be coming back (a reload or restart). */
export const RESTORE_WINDOW_MS = 10 * 60_000;
/** Restored sessions wait at least this long for their agent to reconnect: a reload takes seconds. */
export const RESTORE_GRACE_MS = 30_000;
/**
 * What a restored session owned shows up a little after the window starts (terminals are revived
 * and recognised one by one, tabs are matched to their ids): until the window has been up this long,
 * an away session is not ended for owning nothing.
 */
export const AWAY_SETTLE_MS = 60_000;
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
  private readonly holds: ((sessionId: string) => boolean) | undefined;
  private readonly startedAt: number;
  /** Restored sessions whose agent has not connected in this run: these may become away. */
  private readonly restored = new Set<string>();
  private settleTimer: NodeJS.Timeout | undefined;
  /** Identities of ended sessions (by key), for one that comes back later. */
  private readonly ended = new Map<string, RememberedSession>();
  private heartbeat: NodeJS.Timeout | undefined;

  /** Fires when a session is added, changes (title, connection state) or is removed for good. */
  readonly onDidChange: Event<SessionChange> = this.changeEmitter.event;

  constructor(options: SessionManagerOptions = {}) {
    this.graceMs = options.graceMs ?? (() => 20_000);
    this.now = options.now ?? Date.now;
    this.memory = options.memory;
    this.holds = options.holds;
    this.startedAt = this.now();
    if (this.memory) this.restore(this.memory.load());
    if (this.restored.size > 0 && this.holds) {
      this.settleTimer = setTimeout(() => this.reviewAway(), AWAY_SETTLE_MS + 50);
      this.settleTimer.unref?.();
    }
  }

  /** Registers a connection. Returns the existing session when the key is known (a reconnect). */
  connect(info: SessionConnectInfo): AgentSession {
    this.connections.set(info.sessionKey, (this.connections.get(info.sessionKey) ?? 0) + 1);
    const timer = this.graceTimers.get(info.sessionKey);
    if (timer) {
      clearTimeout(timer);
      this.graceTimers.delete(info.sessionKey);
    }
    this.restored.delete(info.sessionKey);
    const existing = this.sessions.get(info.sessionKey);
    if (existing) {
      existing.connected = true;
      delete existing.away;
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
      titleBy: known?.titleBy,
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
    const timer = setTimeout(() => this.graceOver(id), ms);
    timer.unref?.();
    this.graceTimers.set(id, timer);
  }

  /**
   * The agent did not reconnect in time. A session of this run ends. One restored from before a
   * reload or restart becomes away instead while it owns something (or may yet turn out to).
   */
  private graceOver(id: string): void {
    this.graceTimers.delete(id);
    const session = this.sessions.get(id);
    if (!session) return;
    if (!this.restored.has(id) || !this.holds || (this.settled() && !this.holds(id))) {
      this.remove(id);
      return;
    }
    session.away = true;
    this.changeEmitter.fire({ type: 'updated', session });
    this.save();
  }

  private settled(): boolean {
    return this.now() - this.startedAt >= AWAY_SETTLE_MS;
  }

  /**
   * Ends the away sessions that own nothing any more (the user closed their tabs and terminals).
   * Call when tabs or terminals changed. Does nothing while the window is still starting.
   */
  reviewAway(): void {
    if (!this.holds || !this.settled()) return;
    for (const session of [...this.sessions.values()]) {
      if (session.away && !this.holds(session.id)) this.remove(session.id);
    }
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
    this.restored.delete(id);
    session.connected = false;
    delete session.away;
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

  /**
   * Names a session (`by` the user or its agent), or takes its name away (empty or undefined, or its
   * own automatic label). Returns why not when the name is refused: the agent cannot change a name the
   * user gave, and names are unique in the window and never read like another session's automatic
   * label. The session's `label` follows; terminals named after it are renamed by the terminal module.
   */
  setTitle(id: string, title: string | undefined, by: 'user' | 'agent' = 'agent'): NameRefusal | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    if (by === 'agent' && session.titleBy === 'user' && session.title) return { reason: 'named-by-user', name: session.title };
    let next = normalizeSessionName(title);
    if (next && next.toLowerCase() === session.autoLabel.toLowerCase()) next = undefined;
    if (next) {
      const refusal = this.nameRefusal(next, id);
      if (refusal) return refusal;
    }
    const nextBy = next ? by : undefined;
    if (next === session.title && nextBy === session.titleBy) return undefined;
    applyTitle(session, next, nextBy);
    this.changeEmitter.fire({ type: 'updated', session });
    this.save();
    return undefined;
  }

  private nameRefusal(name: string, sessionId: string): NameRefusal | undefined {
    if (AUTOMATIC_LABEL.test(name)) return { reason: 'automatic' };
    const key = name.toLowerCase();
    const holder = [...this.sessions.values()].find(s => s.id !== sessionId && s.label.toLowerCase() === key);
    return holder ? { reason: 'taken', by: holder } : undefined;
  }

  /** Records agent activity (used for idle detection and "last active" in the UI). Does not fire. */
  touch(id: string): void {
    const session = this.sessions.get(id);
    if (session) session.lastActivityAt = this.now();
  }

  dispose(): void {
    for (const timer of this.graceTimers.values()) clearTimeout(timer);
    this.graceTimers.clear();
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = undefined;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    this.changeEmitter.dispose();
  }

  // ------------------------------------------------------------------ memory across reloads

  /**
   * Brings back the sessions of the window's previous extension host, with the same label, badge,
   * color and title. After a reload, or VS Code restarted within RESTORE_WINDOW_MS, as disconnected
   * sessions in their grace period, so their number is not given to another session while they
   * reconnect; one whose agent does not reconnect then becomes away (`graceOver`). Sessions that
   * were away already, or of a window closed for longer (with `holds`), come back away at once:
   * their agents are not about to reconnect, but their terminals and tabs may still be there.
   * Ended ones are only remembered, to get their number back later if it is still free.
   */
  private restore(remembered: readonly RememberedSession[]): void {
    const now = this.now();
    const grace = this.graceMs();
    for (const r of remembered) {
      if (!r || typeof r.id !== 'string' || !r.client || typeof r.number !== 'number') continue;
      const recent = now - r.seenAt < RESTORE_WINDOW_MS;
      const away = !!this.holds && (r.away === true || !recent);
      if (r.live && (recent || away) && grace > 0 && !this.sessions.has(r.id) && !this.numberTaken(r.client.kind, r.number)) {
        const session = this.build({
          id: r.id,
          client: r.client,
          number: r.number,
          color: SESSION_COLORS.find(c => c.id === r.colorId) ?? this.freeColor(),
          title: r.title,
          titleBy: r.titleBy,
          pid: r.pid,
          cwd: r.cwd,
          createdAt: r.createdAt,
          connected: false,
          matchedBy: undefined,
        });
        this.sessions.set(session.id, session);
        this.restored.add(session.id);
        if (away) session.away = true;
        else this.startGrace(session.id, Math.max(grace, RESTORE_GRACE_MS));
      } else if (now - r.seenAt < ENDED_MEMORY_MS) {
        this.ended.set(r.id, { ...r, live: false });
      }
    }
    this.pruneEnded();
    this.save();
  }

  /**
   * A session with its labels. A remembered name it cannot have any more (another session took it
   * meanwhile) is dropped: the session goes back to its automatic label.
   */
  private build(
    fields: Omit<AgentSession, 'label' | 'autoLabel' | 'badge' | 'title' | 'titleBy' | 'lastActivityAt' | 'matchedBy'> & {
      title: string | undefined;
      titleBy: 'user' | 'agent' | undefined;
      matchedBy: InstanceMatch | undefined;
    },
  ): AgentSession {
    const name = KIND_NAMES[fields.client.kind];
    const { matchedBy, title: wanted, titleBy, ...rest } = fields;
    const autoLabel = `${name} ${fields.number}`;
    const normalized = normalizeSessionName(wanted);
    const title = normalized && normalized.toLowerCase() !== autoLabel.toLowerCase() && !this.nameRefusal(normalized, fields.id) ? normalized : undefined;
    const session: AgentSession = {
      ...rest,
      label: autoLabel,
      autoLabel,
      badge: `${BADGE_LETTERS[fields.client.kind] ?? name.charAt(0)}${fields.number > 9 ? '+' : fields.number}`,
      title: undefined,
      lastActivityAt: this.now(),
      ...(matchedBy ? { matchedBy } : {}),
    };
    applyTitle(session, title, title ? (titleBy ?? 'agent') : undefined);
    return session;
  }

  private remember(s: AgentSession): RememberedSession {
    return {
      id: s.id,
      client: s.client,
      number: s.number,
      colorId: s.color.id,
      ...(s.title ? { title: s.title, titleBy: s.titleBy ?? 'agent' } : {}),
      ...(s.pid !== undefined ? { pid: s.pid } : {}),
      ...(s.cwd !== undefined ? { cwd: s.cwd } : {}),
      createdAt: s.createdAt,
      seenAt: this.now(),
      live: true,
      ...(s.away ? { away: true } : {}),
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

function applyTitle(session: AgentSession, title: string | undefined, by: 'user' | 'agent' | undefined): void {
  session.title = title;
  if (title && by) session.titleBy = by;
  else delete session.titleBy;
  session.label = title ?? session.autoLabel;
}

/**
 * How sentences name a session, in prompts to the user and messages to agents: "Claude 2", or
 * "checkout tests (Claude 2)" once it has a name. The automatic label stays in sentences so an agent
 * cannot pass itself off as something else in a question to the user by the name it gives itself.
 */
export function sessionDisplayName(session: AgentSession): string {
  return session.title ? `${session.label} (${session.autoLabel})` : session.label;
}

export function describeSession(session: AgentSession): SessionDescriptor {
  return { id: session.id, label: session.label, badge: session.badge, color: session.color.id };
}
