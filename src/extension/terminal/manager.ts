// Tracks every integrated terminal of the window: agent terminals (created by a session) and the
// user's own. Agent terminals get a headless mirror (mirror.ts) fed with their output, so commands
// return the rendered text. The user's own terminals only keep a small raw tail (tail.ts) until an agent
// is allowed to use one; its mirror then starts from that tail, and is released again when no session
// uses the terminal any more. Commands run through shell integration when it is active, which gives exit codes
// and exact command boundaries; without it there is an honest, degraded fallback.
import * as vscode from 'vscode';
import { ToolError } from '../core/errors';
import { Emitter } from '../core/events';
import type { BridgeServices, TerminalInfo, TerminalService, TerminalState } from '../core/services';
import type { AgentSession } from '../core/sessions';
import { decideAccess, labelPrefix, matchPersisted, renamedFor, type AccessDecision, parsePolicy, parseSessionEndPolicy, type PersistedTerminal } from './access';
import { assessActivity, looksLikeShellPrompt, QUIET_MS, stoppedForInput, type Activity } from './activity';
import { sameCommand, TerminalMirror, type LinesResult, type Mark, type MirrorFeed, type Region } from './mirror';
import { shortCommand } from './render';
import { TerminalTail } from './tail';

export interface Execution {
  readonly commandLine: string;
  readonly startedAt: number;
  endedAt: number | undefined;
  exitCode: number | undefined;
  /** The mirror region of the output (shell integration only). */
  region: Region | undefined;
  /** Without shell integration: where the command was typed, and the lines once it ended. */
  fallback: { mark: Mark; frozen: string[] | undefined } | undefined;
  ended: boolean;
  readonly done: Promise<void>;
  /** The session that ran it through a tool, if any. */
  agentSession: string | undefined;
  /** Executions mode: resolves when the output stream of this execution has been fully fed. */
  pumped: Promise<void> | undefined;
  /** Resolves `done`. */
  readonly resolveDone: () => void;
}

function newExecution(commandLine: string, fallback: Execution['fallback']): Execution {
  let resolveDone!: () => void;
  const done = new Promise<void>(resolve => (resolveDone = resolve));
  return { commandLine, startedAt: Date.now(), endedAt: undefined, exitCode: undefined, region: undefined, fallback, ended: false, done, agentSession: undefined, pumped: undefined, resolveDone };
}

export type HandoffOutcome =
  | { kind: 'command-finished' }
  | { kind: 'done'; via: 'notification' | 'command' }
  | { kind: 'declined'; via: 'notification' | 'command' }
  | { kind: 'dismissed' }
  | { kind: 'timeout' }
  | { kind: 'cancelled' }
  | { kind: 'closed' };

interface Handoff {
  readonly sessionId: string;
  readonly message: string;
  readonly since: number;
  finish(outcome: HandoffOutcome): void;
}

export class Tracked {
  /** Empty until the terminal has been identified (matched against persisted ownership). */
  id = '';
  origin: 'agent' | 'user' = 'user';
  ownerKey: string | undefined;
  /** Agent terminals: the owner's label the name was made from, to tell when it no longer matches. */
  label: string | undefined;
  starting = false;
  current: Execution | undefined;
  last: Execution | undefined;
  lastExitCode: number | undefined;
  handoff: Handoff | undefined;
  closed = false;
  createdCwd: string | undefined;
  pid: number | undefined;
  readonly createdAt = Date.now();
  /** The shell has finished drawing a prompt since this terminal was tracked (OSC 633;B; stream mode only). */
  promptDrawn = false;
  readonly granted = new Set<string>();
  readonly refusedUntil = new Map<string, number>();
  readonly consentPending = new Map<string, Promise<boolean>>();
  /** Sessions that were already told what is degraded in this terminal. */
  readonly limitationsShown = new Set<string>();
  /** Sessions that were already shown the full "Next:" suggestions for a running command here. */
  readonly hintsShown = new Set<string>();
  /** Per session: the last finished execution whose end it was told about. */
  readonly reportedEnd = new Map<string, Execution>();
  /** Per session: where its last read ended. */
  readonly marks = new Map<string, Mark>();
  /**
   * Stream mode: VS Code reports executions and the output stream arrives separately, in either
   * order. Regions not yet matched to an execution, and executions still waiting for their region.
   */
  readonly unclaimedRegions: Region[] = [];
  readonly awaitingRegion: Execution[] = [];
  pendingRun: { resolve(execution: Execution): void } | undefined;
  readonly identified: Promise<void>;
  markIdentified!: () => void;
  /** Terminal size, when known (proposed API terminalDimensions). */
  size: { columns: number; rows: number } | undefined;
  /** Raw recent output, for a terminal without a mirror yet (and kept for the user's terminals). */
  tail: TerminalTail | undefined = new TerminalTail();
  private mirrorInstance: TerminalMirror | undefined;

  constructor(
    readonly terminal: vscode.Terminal,
    private readonly createMirror: (t: Tracked) => TerminalMirror,
  ) {
    this.identified = new Promise(resolve => (this.markIdentified = resolve));
  }

  /** The headless emulator of this terminal, created on first use (starting from the kept tail). */
  get mirror(): TerminalMirror {
    if (!this.mirrorInstance) this.mirrorInstance = this.createMirror(this);
    return this.mirrorInstance;
  }

  get mirrored(): boolean {
    return this.mirrorInstance !== undefined;
  }

  /** Output from the terminal. */
  feed(data: string): void {
    this.tail?.append(data);
    if (this.mirrorInstance) void this.mirrorInstance.write(data);
  }

  resize(columns: number, rows: number): void {
    this.size = { columns, rows };
    this.mirrorInstance?.resize(columns, rows);
  }

  /** Drops the mirror (and every position that pointed into it); the tail stays. */
  releaseMirror(): void {
    const mirror = this.mirrorInstance;
    if (!mirror) return;
    this.mirrorInstance = undefined;
    for (const e of [this.current, this.last, ...this.awaitingRegion]) if (e) e.region = undefined;
    this.unclaimedRegions.length = 0;
    this.awaitingRegion.length = 0;
    this.marks.clear();
    mirror.dispose();
  }

  /** Releases everything held for output (on close). */
  disposeOutput(): void {
    this.tail = undefined;
    this.mirrorInstance?.dispose();
    this.mirrorInstance = undefined;
  }

  get name(): string {
    return this.terminal.name;
  }

  get state(): TerminalState {
    if (this.closed) return 'closed';
    if (this.handoff) return 'waiting-for-user';
    if (this.current) return 'running';
    if (this.starting) return 'starting';
    return 'idle';
  }

  get shellIntegration(): boolean {
    return !this.closed && this.terminal.shellIntegration !== undefined;
  }

  get cwd(): string | undefined {
    const uri = this.terminal.shellIntegration?.cwd;
    return uri ? (uri.scheme === 'file' ? uri.fsPath : uri.toString()) : this.createdCwd;
  }
}

const STATE_KEY = 'copane.terminals.v1';
const SHELL_INTEGRATION_WAIT_MS = 12_000;
const FIRST_PROMPT_WAIT_MS = 2_000;
/** How long a region of output may come before its execution and still be paired with it by order. */
const REGION_PAIRING_MS = 2_000;
/** How long after the shell's end marker VS Code may take to report the end of a command. */
const MISSED_END_MS = 3_000;

export class TerminalManager implements TerminalService, vscode.Disposable {
  private readonly byTerminal = new Map<vscode.Terminal, Tracked>();
  /** Closed terminals whose records were dropped: late events for them must not track them again. */
  private readonly forgotten = new WeakSet<vscode.Terminal>();
  private readonly changeEmitter = new Emitter<void>();
  private readonly disposables: vscode.Disposable[] = [];
  /** Per session: the terminal it uses when a tool gets no `terminal`. */
  private readonly currentOf = new Map<string, string>();
  private nextId = 1;
  private readonly persisted: PersistedTerminal[];
  private readonly activatedAt = Date.now();
  private lastUserEditAt = 0;
  private changeQueued = false;
  private renaming = false;
  readonly feed: MirrorFeed;
  readonly dimensionsAvailable: boolean;
  readonly ready: Promise<void>;

  readonly onDidChange = this.changeEmitter.event;

  constructor(private readonly services: BridgeServices) {
    this.persisted = services.context.workspaceState.get<PersistedTerminal[]>(STATE_KEY, []);
    for (const r of this.persisted) this.nextId = Math.max(this.nextId, Number(/(\d+)$/.exec(r.id)?.[1] ?? 0) + 1);

    // Proposed APIs, used when the user enabled proposed API for this extension (as the browser needs).
    let feed: MirrorFeed = 'executions';
    try {
      this.disposables.push(vscode.window.onDidWriteTerminalData(e => this.live(e.terminal)?.feed(e.data)));
      feed = 'stream';
    } catch {
      // Not enabled: command output comes from shell-integration executions only.
    }
    this.feed = feed;
    let dimensions = false;
    try {
      this.disposables.push(vscode.window.onDidChangeTerminalDimensions(e => this.byTerminal.get(e.terminal)?.resize(e.dimensions.columns, e.dimensions.rows)));
      dimensions = true;
    } catch {
      // Not enabled: mirrors use a default size; plain output is unaffected, full-screen programs may look off.
    }
    this.dimensionsAvailable = dimensions;

    this.disposables.push(
      vscode.window.onDidOpenTerminal(t => void this.live(t)),
      vscode.window.onDidCloseTerminal(t => this.onClosed(t)),
      vscode.window.onDidChangeTerminalShellIntegration(e => {
        const tracked = this.live(e.terminal);
        if (!tracked) return;
        if (tracked.starting) tracked.starting = false;
        this.changed();
      }),
      vscode.window.onDidStartTerminalShellExecution(e => this.onExecutionStart(e)),
      vscode.window.onDidEndTerminalShellExecution(e => void this.onExecutionEnd(e)),
      vscode.window.onDidChangeTerminalState(() => this.changed()),
      vscode.workspace.onDidChangeTextDocument(e => {
        if (e.contentChanges.length > 0 && (e.document.uri.scheme === 'file' || e.document.uri.scheme === 'untitled')) this.lastUserEditAt = Date.now();
      }),
      services.sessions.onDidChange(change => {
        if (change.type === 'removed') this.onSessionEnded(change.session);
        else {
          this.changed();
          this.renameStale();
        }
      }),
      vscode.window.onDidChangeActiveTerminal(() => this.renameStale()),
    );
    for (const t of vscode.window.terminals) this.track(t);
    this.ready = Promise.all([...this.byTerminal.values()].map(t => t.identified)).then(() => undefined);
  }

  // ------------------------------------------------------------------ TerminalService

  list(): TerminalInfo[] {
    return this.all().map(t => this.info(t));
  }

  get(terminalId: string): TerminalInfo | undefined {
    const t = this.find(terminalId);
    return t ? this.info(t) : undefined;
  }

  reveal(terminalId: string, options?: { preserveFocus?: boolean }): void {
    this.find(terminalId)?.terminal.show(options?.preserveFocus ?? false);
  }

  interrupt(terminalId: string): void {
    const t = this.find(terminalId);
    if (t && !t.closed) t.terminal.sendText('\x03', false);
  }

  close(terminalId: string): void {
    const t = this.find(terminalId);
    if (t && !t.closed) t.terminal.dispose();
  }

  resolveUserRequest(terminalId: string, outcome: 'done' | 'declined'): boolean {
    const t = this.find(terminalId);
    if (!t?.handoff) return false;
    t.handoff.finish({ kind: outcome, via: 'command' });
    return true;
  }

  // ------------------------------------------------------------------ lookup and access

  all(): Tracked[] {
    return [...this.byTerminal.values()].filter(t => t.id && !t.closed).sort((a, b) => idNumber(a.id) - idNumber(b.id));
  }

  find(terminalId: string): Tracked | undefined {
    for (const t of this.byTerminal.values()) if (t.id === terminalId) return t;
    return undefined;
  }

  forTerminal(terminal: vscode.Terminal | undefined): Tracked | undefined {
    return terminal ? this.byTerminal.get(terminal) : undefined;
  }

  pendingHandoffs(): Tracked[] {
    return this.all().filter(t => t.handoff);
  }

  info(t: Tracked): TerminalInfo {
    return {
      id: t.id,
      name: t.name,
      origin: t.origin,
      ownedBy: t.ownerKey && this.services.sessions.get(t.ownerKey) ? t.ownerKey : undefined,
      state: t.state,
      shellIntegration: t.shellIntegration,
      cwd: t.cwd,
      currentCommand: t.current?.commandLine,
      lastExitCode: t.lastExitCode,
      allowedSessions: [...t.granted].filter(id => this.services.sessions.get(id)),
      ...(t.handoff
        ? { request: { sessionId: t.handoff.sessionId, message: t.handoff.message, since: t.handoff.since }, userInputRequest: t.handoff.message }
        : {}),
    };
  }

  ownerAlive(t: Tracked): boolean {
    return !!t.ownerKey && !!this.services.sessions.get(t.ownerKey);
  }

  /** The session's own terminals, open ones only. */
  ownedBy(sessionId: string): Tracked[] {
    return this.all().filter(t => t.origin === 'agent' && t.ownerKey === sessionId);
  }

  currentFor(session: AgentSession): Tracked | undefined {
    const id = this.currentOf.get(session.id);
    const t = id ? this.find(id) : undefined;
    if (t && !t.closed) return t;
    // After a reload the choice is gone; fall back to the newest terminal the session owns.
    return this.ownedBy(session.id).at(-1);
  }

  setCurrent(session: AgentSession, t: Tracked): void {
    this.currentOf.set(session.id, t.id);
  }

  /** Whether the session may use the terminal right now, must ask, or is refused. */
  access(session: AgentSession, t: Tracked): AccessDecision {
    const policy = parsePolicy(vscode.workspace.getConfiguration('copane.terminal').get('userTerminals'));
    return decideAccess({ origin: t.origin, ownerKey: t.ownerKey, ownerAlive: this.ownerAlive(t), granted: t.granted, refusedUntil: t.refusedUntil }, session.id, policy, Date.now());
  }

  /** Throws a ToolError unless the session may read and type in the terminal (may ask the user). */
  async ensureAccess(session: AgentSession, t: Tracked, signal: AbortSignal): Promise<void> {
    const decision = this.access(session, t);
    if (decision.kind === 'allowed') return;
    if (decision.kind === 'denied') {
      if (decision.reason === 'policy') {
        throw new ToolError('access_denied', `${t.id} ("${t.name}") is the user's own terminal, and the setting copane.terminal.userTerminals is "deny", so agents cannot read or type in it. Use your own terminal instead (terminal_run creates one).`);
      }
      throw new ToolError('access_denied', `The user declined to let you use ${t.id} ("${t.name}") a moment ago. Do not ask again right away; use your own terminal, or ask the user in chat if you really need this one.`);
    }
    let pending = t.consentPending.get(session.id);
    if (!pending) {
      const owner = t.ownerKey ? this.services.sessions.get(t.ownerKey) : undefined;
      const message =
        decision.reason === 'user-terminal'
          ? `${session.label} wants to read and type in your terminal "${t.name}".`
          : `${session.label} wants to read and type in the terminal "${t.name}" of ${owner?.label ?? 'another agent session'}.`;
      pending = this.services.prompts
        .ask({ message, choices: ['Allow', 'Deny'], signal })
        .then(answer => {
          if (answer === 'Allow') {
            t.granted.add(session.id);
            return true;
          }
          if (answer === 'Deny') t.refusedUntil.set(session.id, Date.now() + 2 * 60_000);
          return false;
        })
        .finally(() => t.consentPending.delete(session.id));
      t.consentPending.set(session.id, pending);
    }
    const allowed = await pending;
    if (allowed) return;
    if (signal.aborted) throw new ToolError('cancelled', 'Cancelled while waiting for the user to allow access to the terminal.');
    throw new ToolError('access_denied', `The user did not allow you to use ${t.id} ("${t.name}"). Use your own terminal instead (terminal_run creates one), or ask the user in chat why.`);
  }

  // ------------------------------------------------------------------ creating terminals

  async create(session: AgentSession, options: { name?: string; cwd?: string; env?: Record<string, string>; shell?: string; shellArgs?: string[]; reveal?: boolean }): Promise<Tracked> {
    const label = options.name ? `${session.label}: ${options.name}` : this.freeDefaultName(session);
    const terminal = vscode.window.createTerminal({
      name: label,
      cwd: options.cwd ?? session.cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      env: { GIT_PAGER: 'cat', PAGER: 'cat', ...options.env },
      ...(options.shell ? { shellPath: options.shell, shellArgs: options.shellArgs } : {}),
      iconPath: new vscode.ThemeIcon('sparkle'),
      color: new vscode.ThemeColor(session.color.themeColor),
      isTransient: false,
      location: vscode.TerminalLocation.Panel,
    });
    const t = this.track(terminal, { session, cwd: options.cwd });
    if (options.reveal !== false) terminal.show(true);
    this.setCurrent(session, t);
    void terminal.processId.then(pid => {
      t.pid = pid;
      this.persist();
    });
    this.persist();
    this.changed();
    return t;
  }

  private freeDefaultName(session: AgentSession): string {
    const names = new Set(this.all().map(t => t.name));
    if (!names.has(session.label)) return session.label;
    for (let n = 2; ; n++) if (!names.has(`${session.label} (${n})`)) return `${session.label} (${n})`;
  }

  /** Waits until shell integration is active, up to a limit. False when it did not activate. */
  async waitForShellIntegration(t: Tracked, signal: AbortSignal, maxMs = SHELL_INTEGRATION_WAIT_MS): Promise<boolean> {
    if (t.terminal.shellIntegration) return true;
    if (!shellIntegrationEnabled() || !canHaveShellIntegration(t.terminal)) return false;
    // A terminal that has been around for a while without it will not get it any more.
    const age = Date.now() - t.createdAt;
    const budget = t.origin === 'agent' && age < maxMs ? maxMs - age : Math.min(1500, maxMs);
    return new Promise<boolean>(resolve => {
      const done = (value: boolean) => {
        clearTimeout(timer);
        sub.dispose();
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      };
      const onAbort = () => done(false);
      const sub = vscode.window.onDidChangeTerminalShellIntegration(e => {
        if (e.terminal === t.terminal) done(true);
      });
      const timer = setTimeout(() => done(t.terminal.shellIntegration !== undefined), budget);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  // ------------------------------------------------------------------ running commands

  /** Starts a command through shell integration and resolves once the shell reports it started. */
  async startWithShellIntegration(session: AgentSession, t: Tracked, commandLine: string, signal: AbortSignal): Promise<Execution> {
    if (!t.terminal.shellIntegration) throw new ToolError('unavailable', 'Shell integration is not active in this terminal.');
    // Shell integration can activate before the first prompt is complete (bash). A command sent then
    // makes VS Code take part of the prompt for typed input: it sends Ctrl+C and reports a bogus
    // command ("^Cnal/ws") that would be taken for this one. In a terminal just opened for the session,
    // wait for the end of the first prompt (briefly; a shell without the marker just runs later).
    if (this.feed === 'stream' && !t.promptDrawn && t.origin === 'agent' && Date.now() - t.createdAt < SHELL_INTEGRATION_WAIT_MS) {
      await new Promise<void>(resolve => {
        const done = () => {
          clearTimeout(timer);
          sub.dispose();
          signal.removeEventListener('abort', done);
          resolve();
        };
        const sub = t.mirror.onPromptEnd(done);
        const timer = setTimeout(done, FIRST_PROMPT_WAIT_MS);
        signal.addEventListener('abort', done, { once: true });
      });
    }
    const si = t.terminal.shellIntegration;
    if (!si) throw new ToolError('unavailable', 'Shell integration is not active in this terminal.');
    const started = new Promise<Execution>(resolve => (t.pendingRun = { resolve }));
    si.executeCommand(commandLine);
    const result = await raceTimeout(started, 10_000, signal);
    if (result === 'timeout' || result === 'aborted') {
      t.pendingRun = undefined;
      if (result === 'aborted') throw new ToolError('cancelled', 'Cancelled before the command started.');
      throw new ToolError(
        'failed',
        `The shell in ${t.id} did not start the command within 10 s. Something else may own the terminal (a program waiting for input?). Look with terminal_read { what: "screen" }, or use another terminal (terminal_create).`,
      );
    }
    result.agentSession = session.id;
    return result;
  }

  /** Without shell integration: types the command and watches the screen for the next prompt. */
  startWithoutShellIntegration(session: AgentSession, t: Tracked, commandLine: string): Execution | undefined {
    if (this.feed !== 'stream') {
      t.terminal.sendText(commandLine, true);
      return undefined;
    }
    const mark = t.mirror.mark({ exact: false });
    const execution = newExecution(commandLine, { mark, frozen: undefined });
    execution.agentSession = session.id;
    const markDone = execution.resolveDone;
    t.current = execution;
    t.terminal.sendText(commandLine, true);
    this.changed();
    const sentAt = Date.now();
    const timer = setInterval(() => {
      if (t.closed || t.current !== execution) {
        clearInterval(timer);
        markDone();
        return;
      }
      const quiet = Date.now() - Math.max(t.mirror.lastWriteAt, sentAt);
      const { beforeCursor, afterCursor } = t.mirror.cursorLine();
      const lines = t.mirror.linesSince(mark).lines;
      if (quiet >= 800 && lines.length >= 2 && !t.mirror.alternate && looksLikeShellPrompt(beforeCursor, afterCursor)) {
        clearInterval(timer);
        execution.fallback!.frozen = lines.slice(1, -1);
        execution.ended = true;
        execution.endedAt = Date.now();
        t.current = undefined;
        t.last = execution;
        markDone();
        this.changed();
      }
    }, 250);
    return execution;
  }

  /** The rendered output of an execution so far (all of it that is still in the scrollback). */
  outputOf(t: Tracked, execution: Execution): LinesResult {
    if (execution.region) return t.mirror.regionLines(execution.region);
    if (execution.fallback) {
      if (execution.fallback.frozen) return { lines: execution.fallback.frozen, startLost: false };
      const { lines, startLost } = t.mirror.linesSince(execution.fallback.mark);
      return { lines: lines.slice(1), startLost };
    }
    return { lines: [], startLost: false };
  }

  /** Where "new output" starts for this session after it was shown `execution`'s output. */
  markRead(session: AgentSession, t: Tracked, execution?: Execution): void {
    const mark = execution?.ended && execution.region ? t.mirror.markAfter(execution.region) : t.mirror.mark();
    t.marks.set(session.id, mark);
  }

  /** New output since the session's last read, and moves the read position to the end. */
  readNew(session: AgentSession, t: Tracked): LinesResult {
    const result = this.linesSince(t, t.marks.get(session.id));
    t.marks.set(session.id, t.mirror.mark());
    return result;
  }

  /** Output after a mark, without the shell's own prompt when the terminal is back at it. */
  linesSince(t: Tracked, mark: Mark | undefined): LinesResult {
    const result = t.mirror.linesSince(mark);
    if (this.feed === 'stream' && !t.current && t.shellIntegration && result.lines.length > 0) {
      const { beforeCursor } = t.mirror.cursorLine();
      if (result.lines[result.lines.length - 1]!.trimEnd() === beforeCursor.trimEnd()) result.lines.pop();
    }
    return result;
  }

  activity(t: Tracked): Activity {
    const { beforeCursor, afterCursor } = t.mirror.cursorLine();
    return assessActivity({
      running: !!t.current || !!t.handoff,
      quietMs: Date.now() - Math.max(t.mirror.lastWriteAt, t.current?.startedAt ?? 0),
      beforeCursor,
      afterCursor,
      tail: t.mirror.tail(5),
      alternate: t.mirror.alternate,
      outputSinceStart: !t.current || t.mirror.lastWriteAt > t.current.startedAt + 100,
    });
  }

  /**
   * Whether `execution`, the terminal's running command, has stopped to be answered (a prompt, a
   * menu, a still full-screen program), so that waiting longer for its end is pointless. Judged
   * from the command's own output; flushes the mirror once the output has gone quiet.
   */
  async stoppedForInput(t: Tracked, execution: Execution): Promise<boolean> {
    if (execution.ended || t.current !== execution || t.handoff || t.closed) return false;
    const quiet = () => Date.now() - Math.max(t.mirror.lastWriteAt, execution.startedAt);
    if (quiet() < QUIET_MS) return false;
    await t.mirror.flush();
    if (execution.ended || t.current !== execution) return false;
    const { beforeCursor, afterCursor } = t.mirror.cursorLine();
    const own = this.outputOf(t, execution).lines.filter(line => line.trim() !== '');
    return stoppedForInput({
      running: true,
      quietMs: quiet(),
      beforeCursor,
      afterCursor,
      tail: own.slice(-4),
      alternate: t.mirror.alternate,
      // By its output, not by the clock: `sudo` or `read` print their prompt the moment they start.
      outputSinceStart: own.length > 0,
    });
  }

  /** What is degraded in this terminal, for tool results. Empty when everything works. */
  limitations(t: Tracked): string[] {
    const notes: string[] = [];
    if (!t.shellIntegration) {
      const why = !shellIntegrationEnabled()
        ? 'the user turned it off (terminal.integrated.shellIntegration.enabled)'
        : t.terminal.state.shell
          ? `the shell (${t.terminal.state.shell}) did not activate it`
          : 'the shell does not support it or has not activated it';
      notes.push(
        this.feed === 'stream'
          ? `No shell integration in ${t.id} (${why}): exit codes are unknown, and the end of a command is guessed from the prompt reappearing.`
          : `No shell integration in ${t.id} (${why}), and terminal output access (proposed API terminalDataWriteEvent) is not enabled: commands can be typed, but their output and exit codes cannot be read.`,
      );
    } else if (this.feed === 'executions') {
      notes.push('Only command output is visible (the prompt and full-screen redraws between commands are not), because the proposed API terminalDataWriteEvent is not enabled.');
    }
    return notes;
  }

  // ------------------------------------------------------------------ hand-off

  async handOff(
    session: AgentSession,
    t: Tracked,
    options: { message: string; execution: Execution | undefined; timeoutMs: number; signal: AbortSignal },
  ): Promise<{ outcome: HandoffOutcome; since: Mark; waitedMs: number }> {
    const since = t.mirror.mark();
    const startedAt = Date.now();
    const promptAbort = new AbortController();
    let finish!: (outcome: HandoffOutcome) => void;
    const outcome = new Promise<HandoffOutcome>(resolve => {
      let settled = false;
      finish = value => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
    });
    t.handoff = { sessionId: session.id, message: options.message, since: startedAt, finish };
    this.changed();
    // Focus the terminal so the user can type right away, unless they are typing in an editor this
    // very moment: then their keystrokes would land in the terminal. "Show Terminal" focuses it.
    const typing = vscode.window.state.focused && Date.now() - this.lastUserEditAt < 3000;
    t.terminal.show(typing);

    const timer = setTimeout(() => finish({ kind: 'timeout' }), options.timeoutMs);
    const onAbort = () => finish({ kind: 'cancelled' });
    options.signal.addEventListener('abort', onAbort, { once: true });
    void options.execution?.done.then(() => finish({ kind: 'command-finished' }));

    void (async () => {
      const where = `the terminal "${t.name}"`;
      let choices = ['Show Terminal', 'Done', "Won't Do"];
      for (;;) {
        const answer = await this.services.prompts.ask({ message: `${session.label} needs you in ${where}: ${options.message}`, choices, signal: promptAbort.signal, autoClose: true });
        if (promptAbort.signal.aborted) return;
        if (answer === 'Show Terminal') {
          t.terminal.show(false);
          choices = ['Done', "Won't Do"];
          continue;
        }
        if (answer === 'Done') return finish({ kind: 'done', via: 'notification' });
        if (answer === "Won't Do") return finish({ kind: 'declined', via: 'notification' });
        // Closed without an answer. While the command runs, its end still tells the agent.
        if (!options.execution || options.execution.ended) return finish({ kind: 'dismissed' });
        return;
      }
    })();

    const result = await outcome;
    clearTimeout(timer);
    options.signal.removeEventListener('abort', onAbort);
    promptAbort.abort();
    if (t.handoff?.finish === finish) t.handoff = undefined;
    this.changed();
    await t.mirror.flush();
    return { outcome: result, since, waitedMs: Date.now() - startedAt };
  }

  // ------------------------------------------------------------------ events

  /** The record of an open terminal (tracked on first sight), or undefined for one already closed and forgotten. */
  private live(terminal: vscode.Terminal): Tracked | undefined {
    return this.byTerminal.get(terminal) ?? (this.forgotten.has(terminal) || terminal.exitStatus !== undefined ? undefined : this.track(terminal));
  }

  /** Returns the tracking record of a terminal, creating it on first sight. */
  track(terminal: vscode.Terminal, created?: { session: AgentSession; cwd: string | undefined }): Tracked {
    const existing = this.byTerminal.get(terminal);
    if (existing) return existing;
    const t = new Tracked(terminal, x => this.createMirror(x));
    if (this.dimensionsAvailable) {
      try {
        t.size = terminal.dimensions;
      } catch {
        t.size = undefined;
      }
    }
    this.byTerminal.set(terminal, t);
    if (created) {
      t.id = `term-${this.nextId++}`;
      t.origin = 'agent';
      t.ownerKey = created.session.id;
      t.label = created.session.label;
      void t.mirror;
      t.createdCwd = created.cwd ?? created.session.cwd;
      t.starting = !terminal.shellIntegration && shellIntegrationEnabled() && canHaveShellIntegration(terminal);
      if (t.starting) setTimeout(() => {
        if (t.starting) {
          t.starting = false;
          this.changed();
        }
      }, SHELL_INTEGRATION_WAIT_MS).unref?.();
      t.markIdentified();
    } else {
      void this.identify(t);
    }
    return t;
  }

  /**
   * The mirror of a terminal, created when an agent first needs it. A terminal that has printed before
   * (the user's own, or one found at startup) starts from its kept tail: the agent sees the screen and
   * the recent output, as the user does; anything older is reported as cut off.
   */
  private createMirror(t: Tracked): TerminalMirror {
    const mirror = new TerminalMirror({ feed: this.feed, cols: t.size?.columns, rows: t.size?.rows });
    mirror.onPromptEnd(() => (t.promptDrawn = true));
    // VS Code occasionally misses the end of a command (seen with bash when the echoed command line
    // wraps) and never fires onDidEndTerminalShellExecution: the command would look like it runs
    // forever. The shell's own end marker (OSC 633;D) is in the stream, so finish with its exit code.
    mirror.onRegionEnd(region => {
      if (this.feed !== 'stream') return;
      setTimeout(() => {
        const execution = t.current;
        if (execution && execution.region === region && !execution.ended) this.finish(t, execution, region.exitCode);
      }, MISSED_END_MS).unref?.();
    });
    mirror.onRegionStart(region => {
      if (this.feed !== 'stream') return;
      let i = t.awaitingRegion.findIndex(e => sameCommand(e.commandLine, region.commandLine));
      // VS Code starts an execution and the mirror a region on the same OSC 633;C, so output that starts
      // while a command runs is that command's, even when the shell reported its line differently (bash
      // reports aliases expanded: "ls --color=auto x" for "ls x").
      if (i < 0 && t.current && !t.current.ended && !t.current.region) i = t.awaitingRegion.lastIndexOf(t.current);
      if (i >= 0) {
        // Executions before the match will not get a region any more.
        t.awaitingRegion.splice(0, i + 1)[i]!.region = region;
      } else {
        t.unclaimedRegions.push(region);
        if (t.unclaimedRegions.length > 10) t.unclaimedRegions.shift();
      }
    });
    const tail = t.tail;
    if (tail && tail.received > 0) {
      void mirror.replay(tail.text(), tail.truncated).then(async () => {
        // The running command started before what the tail holds: its output so far is what is there.
        const current = t.current;
        if (!current || current.region || current.fallback || mirror !== (t.mirrored ? t.mirror : undefined)) return;
        if (this.feed === 'stream') {
          current.region = mirror.regionFromStart();
          const i = t.awaitingRegion.indexOf(current);
          if (i >= 0) t.awaitingRegion.splice(i, 1);
        } else {
          const region = await mirror.beginRegion();
          if (region) {
            region.truncated = true;
            current.region = region;
          }
        }
      }).catch(err => this.services.log.warn(`replaying the output of ${t.id || 'a terminal'} failed: ${err instanceof Error ? err.message : String(err)}`));
      mirror.lastWriteAt = tail.lastWriteAt;
      mirror.received = tail.received;
    }
    // Agent terminals do not need the tail once mirrored; the user's keep it, in case the mirror is released.
    if (t.origin === 'agent') t.tail = undefined;
    return mirror;
  }

  /** Whether any live session still uses a user terminal (so its mirror is worth keeping). */
  private inUse(t: Tracked): boolean {
    if (t.handoff || t.current?.fallback) return true;
    const alive = (id: string | undefined) => !!id && !!this.services.sessions.get(id);
    if (alive(t.current?.agentSession)) return true;
    for (const id of t.granted) if (alive(id)) return true;
    for (const id of t.marks.keys()) if (alive(id)) return true;
    return false;
  }

  /** Decides whether a terminal we did not just create is an agent terminal from before a reload. */
  private async identify(t: Tracked): Promise<void> {
    const pid = await Promise.race([Promise.resolve(t.terminal.processId).catch(() => undefined), sleep(3000).then(() => undefined)]);
    t.pid = pid;
    const claimed = new Set(this.all().map(x => x.id));
    const record = matchPersisted(this.persisted, claimed, pid, t.terminal.name);
    if (record) {
      t.id = record.id;
      t.origin = 'agent';
      t.ownerKey = record.ownerKey;
      t.label = record.label ?? labelPrefix(record.name);
      if (!t.closed) void t.mirror;
    } else {
      t.id = `term-${this.nextId++}`;
      t.origin = 'user';
    }
    t.markIdentified();
    if (t.closed) return;
    this.persist();
    this.changed();
    this.renameStale();
  }

  private onExecutionStart(e: vscode.TerminalShellExecutionStartEvent): void {
    const t = this.live(e.terminal);
    if (!t) return;
    t.starting = false;
    const execution = newExecution(e.execution.commandLine.value, undefined);
    executionOf.set(e.execution, execution);
    if (t.current && !t.current.ended) this.finish(t, t.current, undefined);
    t.current = execution;
    if (this.feed === 'stream') {
      let i = t.unclaimedRegions.findIndex(r => sameCommand(execution.commandLine, r.commandLine));
      // The output arrived first, under a line reported differently (see onRegionStart): the latest
      // region, if it started just now.
      const latest = t.unclaimedRegions.at(-1);
      if (i < 0 && latest && Date.now() - (latest.startedAt ?? 0) < REGION_PAIRING_MS) i = t.unclaimedRegions.length - 1;
      if (i >= 0) execution.region = t.unclaimedRegions.splice(0, i + 1)[i];
      else t.awaitingRegion.push(execution);
      if (t.awaitingRegion.length > 10) t.awaitingRegion.shift();
    } else {
      // read() must be called right away, or early output is lost.
      const stream = e.execution.read();
      execution.pumped = (async () => {
        // A terminal without a mirror keeps the output in its tail; a mirror made meanwhile frames the rest.
        if (t.mirrored) execution.region = await t.mirror.beginRegion();
        else if (t.tail && !t.tail.atLineStart) t.tail.append('\r\n');
        try {
          for await (const data of stream) {
            if (t.mirrored) await t.mirror.write(data);
            t.tail?.append(data);
          }
        } catch {
          // The stream ends abruptly when the terminal closes.
        }
        if (t.mirrored && execution.region) await t.mirror.endRegion(execution.exitCode);
      })();
    }
    if (t.pendingRun) {
      const pending = t.pendingRun;
      t.pendingRun = undefined;
      pending.resolve(execution);
    }
    this.changed();
  }

  private async onExecutionEnd(e: vscode.TerminalShellExecutionEndEvent): Promise<void> {
    const t = this.byTerminal.get(e.terminal);
    const execution = executionOf.get(e.execution);
    if (!t || !execution || execution.ended) return;
    execution.exitCode = e.exitCode;
    // Let the output catch up with the end event: the data stream can lag behind it.
    if (this.feed === 'stream') {
      const deadline = Date.now() + 2500;
      while (t.mirrored && !(execution.region?.ended ?? false) && !t.closed && Date.now() < deadline) await sleep(25);
    } else if (execution.pumped) {
      await Promise.race([execution.pumped, sleep(1500)]);
    }
    if (t.mirrored) await t.mirror.flush();
    if (execution.exitCode === undefined && execution.region?.ended) execution.exitCode = execution.region.exitCode;
    this.finish(t, execution, execution.exitCode);
  }

  private finish(t: Tracked, execution: Execution, exitCode: number | undefined): void {
    if (execution.ended) return;
    execution.ended = true;
    execution.endedAt = Date.now();
    execution.exitCode = exitCode;
    if (exitCode !== undefined) t.lastExitCode = exitCode;
    t.last = execution;
    if (t.current === execution) t.current = undefined;
    execution.resolveDone();
    this.changed();
  }

  private onClosed(terminal: vscode.Terminal): void {
    const t = this.byTerminal.get(terminal);
    if (!t) return;
    t.closed = true;
    t.handoff?.finish({ kind: 'closed' });
    if (t.current) {
      const current = t.current;
      if (current.fallback && !current.fallback.frozen) current.fallback.frozen = this.outputOf(t, current).lines;
      this.finish(t, current, undefined);
    }
    // Keep the record (and mirror) a little, so a tool that is waiting can still report the output; a
    // terminal no agent used has nothing worth keeping.
    t.tail = undefined;
    const forget = () => {
      this.byTerminal.delete(terminal);
      this.forgotten.add(terminal);
      t.disposeOutput();
    };
    if (t.mirrored) setTimeout(forget, 60_000).unref?.();
    else forget();
    for (const [session, id] of this.currentOf) if (id === t.id) this.currentOf.delete(session);
    this.persist();
    this.changed();
  }

  private onSessionEnded(session: AgentSession): void {
    const policy = parseSessionEndPolicy(vscode.workspace.getConfiguration('copane.terminal').get('onSessionEnd'));
    for (const t of this.all()) {
      t.granted.delete(session.id);
      t.marks.delete(session.id);
      if (t.origin === 'user' && t.mirrored && !this.inUse(t)) t.releaseMirror();
      if (t.origin !== 'agent' || t.ownerKey !== session.id) continue;
      if (policy === 'close' || (policy === 'closeIdle' && (t.state === 'idle' || t.state === 'starting'))) t.terminal.dispose();
    }
    this.currentOf.delete(session.id);
    this.changed();
  }

  /**
   * An agent terminal is named after its session ("Claude 2: dev server"). Sessions get their label back
   * when they reconnect after a reload (core/sessions.ts), but one that returns after its number was
   * given to another session gets a new label, and its terminals would show the wrong owner. VS Code can
   * rename only the active terminal (and cannot recolor one at all), so a stale name is fixed when the
   * terminal is active: right away if it is, otherwise as soon as the user switches to it.
   */
  private renameStale(): void {
    const t = this.forTerminal(vscode.window.activeTerminal);
    if (!t || t.closed || t.origin !== 'agent' || !t.ownerKey || this.renaming) return;
    const owner = this.services.sessions.get(t.ownerKey);
    const name = owner ? renamedFor(t.name, t.label, owner.label) : undefined;
    if (!owner || !name) return;
    this.renaming = true;
    void Promise.resolve(vscode.commands.executeCommand('workbench.action.terminal.renameWithArg', { name }))
      .then(async () => {
        for (let i = 0; i < 20 && t.terminal.name !== name; i++) await sleep(50);
        if (t.terminal.name === name) {
          t.label = owner.label;
          this.services.log.info(`renamed ${t.id} to "${name}" (its session is now ${owner.label})`);
          this.persist();
          this.changed();
        }
      })
      .catch(err => this.services.log.warn(`could not rename ${t.id}: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => (this.renaming = false));
  }

  private persist(): void {
    const current: PersistedTerminal[] = this.all()
      .filter(t => t.origin === 'agent')
      .map(t => ({ id: t.id, pid: t.pid, name: t.name, ownerKey: t.ownerKey, createdAt: t.createdAt, ...(t.label ? { label: t.label } : {}) }));
    // Terminals revived after a reload can appear a little after activation; keep their records a while.
    if (Date.now() - this.activatedAt < 60_000) {
      const ids = new Set(current.map(r => r.id));
      const closedIds = new Set([...this.byTerminal.values()].filter(t => t.closed).map(t => t.id));
      for (const r of this.persisted) if (!ids.has(r.id) && !closedIds.has(r.id)) current.push(r);
    }
    void this.services.context.workspaceState.update(STATE_KEY, current);
  }

  /** Coalesces change notifications into one per tick. */
  changed(): void {
    if (this.changeQueued) return;
    this.changeQueued = true;
    queueMicrotask(() => {
      this.changeQueued = false;
      void vscode.commands.executeCommand('setContext', 'copane.terminal.waitingForUser', this.pendingHandoffs().length > 0);
      this.changeEmitter.fire();
    });
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    for (const t of this.byTerminal.values()) t.disposeOutput();
    this.byTerminal.clear();
    this.changeEmitter.dispose();
  }
}

const executionOf = new WeakMap<vscode.TerminalShellExecution, Execution>();

/** Shells VS Code injects shell integration into automatically. Unknown shells get the benefit of the doubt. */
const INTEGRATED_SHELLS = new Set(['bash', 'zsh', 'fish', 'pwsh', 'powershell', 'gitbash']);

function canHaveShellIntegration(terminal: vscode.Terminal): boolean {
  const options = terminal.creationOptions as vscode.TerminalOptions;
  const fromPath = options.shellPath ? options.shellPath.split(/[\\/]/).pop()!.replace(/\.exe$/i, '').toLowerCase() : undefined;
  const shell = terminal.state.shell ?? fromPath;
  return shell === undefined || INTEGRATED_SHELLS.has(shell);
}

export function shellIntegrationEnabled(): boolean {
  return vscode.workspace.getConfiguration('terminal.integrated').get<boolean>('shellIntegration.enabled', true) !== false;
}

function idNumber(id: string): number {
  return Number(/(\d+)$/.exec(id)?.[1] ?? 0);
}

export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Waits for a promise, a timeout or an abort, whichever comes first. */
export async function raceTimeout<T>(promise: Promise<T>, ms: number, signal: AbortSignal): Promise<T | 'timeout' | 'aborted'> {
  if (signal.aborted) return 'aborted';
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<'timeout'>(resolve => (timer = setTimeout(() => resolve('timeout'), Math.max(0, ms)))),
      new Promise<'aborted'>(resolve => {
        onAbort = () => resolve('aborted');
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

