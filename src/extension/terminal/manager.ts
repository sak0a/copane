// Tracks every integrated terminal of the window: agent terminals (created by a session) and the
// user's own. Each terminal gets a headless mirror (mirror.ts) fed with its output, so commands return
// the rendered text. Commands run through shell integration when it is active, which gives exit codes
// and exact command boundaries; without it there is an honest, degraded fallback.
import * as vscode from 'vscode';
import { ToolError } from '../core/errors';
import { Emitter } from '../core/events';
import type { BridgeServices, TerminalInfo, TerminalService, TerminalState } from '../core/services';
import type { AgentSession } from '../core/sessions';
import { decideAccess, matchPersisted, type AccessDecision, parsePolicy, parseSessionEndPolicy, type PersistedTerminal } from './access';
import { assessActivity, looksLikeShellPrompt, type Activity } from './activity';
import { TerminalMirror, type LinesResult, type Mark, type MirrorFeed, type Region } from './mirror';
import { shortCommand } from './render';

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
  starting = false;
  current: Execution | undefined;
  last: Execution | undefined;
  lastExitCode: number | undefined;
  handoff: Handoff | undefined;
  closed = false;
  createdCwd: string | undefined;
  pid: number | undefined;
  readonly createdAt = Date.now();
  readonly granted = new Set<string>();
  readonly refusedUntil = new Map<string, number>();
  readonly consentPending = new Map<string, Promise<boolean>>();
  /** Sessions that were already told what is degraded in this terminal. */
  readonly limitationsShown = new Set<string>();
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

  constructor(
    readonly terminal: vscode.Terminal,
    readonly mirror: TerminalMirror,
  ) {
    this.identified = new Promise(resolve => (this.markIdentified = resolve));
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

export class TerminalManager implements TerminalService, vscode.Disposable {
  private readonly byTerminal = new Map<vscode.Terminal, Tracked>();
  private readonly changeEmitter = new Emitter<void>();
  private readonly disposables: vscode.Disposable[] = [];
  /** Per session: the terminal it uses when a tool gets no `terminal`. */
  private readonly currentOf = new Map<string, string>();
  private nextId = 1;
  private readonly persisted: PersistedTerminal[];
  private readonly activatedAt = Date.now();
  private lastUserEditAt = 0;
  private changeQueued = false;
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
      this.disposables.push(vscode.window.onDidWriteTerminalData(e => void this.track(e.terminal).mirror.write(e.data)));
      feed = 'stream';
    } catch {
      // Not enabled: command output comes from shell-integration executions only.
    }
    this.feed = feed;
    let dimensions = false;
    try {
      this.disposables.push(vscode.window.onDidChangeTerminalDimensions(e => this.byTerminal.get(e.terminal)?.mirror.resize(e.dimensions.columns, e.dimensions.rows)));
      dimensions = true;
    } catch {
      // Not enabled: mirrors use a default size; plain output is unaffected, full-screen programs may look off.
    }
    this.dimensionsAvailable = dimensions;

    this.disposables.push(
      vscode.window.onDidOpenTerminal(t => void this.track(t)),
      vscode.window.onDidCloseTerminal(t => this.onClosed(t)),
      vscode.window.onDidChangeTerminalShellIntegration(e => {
        const tracked = this.track(e.terminal);
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
        else this.changed();
      }),
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

  /** Returns the tracking record of a terminal, creating it on first sight. */
  track(terminal: vscode.Terminal, created?: { session: AgentSession; cwd: string | undefined }): Tracked {
    const existing = this.byTerminal.get(terminal);
    if (existing) return existing;
    let size: { columns: number; rows: number } | undefined;
    if (this.dimensionsAvailable) {
      try {
        size = terminal.dimensions;
      } catch {
        size = undefined;
      }
    }
    const mirror = new TerminalMirror({ feed: this.feed, cols: size?.columns, rows: size?.rows });
    const t = new Tracked(terminal, mirror);
    this.byTerminal.set(terminal, t);
    mirror.onRegionStart(region => {
      if (this.feed !== 'stream') return;
      const i = t.awaitingRegion.findIndex(e => sameCommand(e.commandLine, region.commandLine));
      if (i >= 0) {
        // Executions before the match will not get a region any more.
        t.awaitingRegion.splice(0, i + 1)[i]!.region = region;
      } else {
        t.unclaimedRegions.push(region);
        if (t.unclaimedRegions.length > 10) t.unclaimedRegions.shift();
      }
    });
    if (created) {
      t.id = `term-${this.nextId++}`;
      t.origin = 'agent';
      t.ownerKey = created.session.id;
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
    } else {
      t.id = `term-${this.nextId++}`;
      t.origin = 'user';
    }
    t.markIdentified();
    if (t.closed) return;
    this.persist();
    this.changed();
  }

  private onExecutionStart(e: vscode.TerminalShellExecutionStartEvent): void {
    const t = this.track(e.terminal);
    t.starting = false;
    const execution = newExecution(e.execution.commandLine.value, undefined);
    executionOf.set(e.execution, execution);
    if (t.current && !t.current.ended) this.finish(t, t.current, undefined);
    t.current = execution;
    if (this.feed === 'stream') {
      const i = t.unclaimedRegions.findIndex(r => sameCommand(execution.commandLine, r.commandLine));
      if (i >= 0) execution.region = t.unclaimedRegions.splice(0, i + 1)[i];
      else t.awaitingRegion.push(execution);
      if (t.awaitingRegion.length > 10) t.awaitingRegion.shift();
    } else {
      // read() must be called right away, or early output is lost.
      const stream = e.execution.read();
      execution.pumped = (async () => {
        execution.region = await t.mirror.beginRegion();
        try {
          for await (const data of stream) await t.mirror.write(data);
        } catch {
          // The stream ends abruptly when the terminal closes.
        }
        await t.mirror.endRegion(execution.exitCode);
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
      while (!(execution.region?.ended ?? false) && !t.closed && Date.now() < deadline) await sleep(25);
    } else if (execution.pumped) {
      await Promise.race([execution.pumped, sleep(1500)]);
    }
    await t.mirror.flush();
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
    // Keep the record (and mirror) a little, so a tool that is waiting can still report the output.
    setTimeout(() => {
      this.byTerminal.delete(terminal);
      t.mirror.dispose();
    }, 60_000).unref?.();
    for (const [session, id] of this.currentOf) if (id === t.id) this.currentOf.delete(session);
    this.persist();
    this.changed();
  }

  private onSessionEnded(session: AgentSession): void {
    const policy = parseSessionEndPolicy(vscode.workspace.getConfiguration('copane.terminal').get('onSessionEnd'));
    for (const t of this.all()) {
      t.granted.delete(session.id);
      t.marks.delete(session.id);
      if (t.origin !== 'agent' || t.ownerKey !== session.id) continue;
      if (policy === 'close' || (policy === 'closeIdle' && (t.state === 'idle' || t.state === 'starting'))) t.terminal.dispose();
    }
    this.currentOf.delete(session.id);
    this.changed();
  }

  private persist(): void {
    const current: PersistedTerminal[] = this.all()
      .filter(t => t.origin === 'agent')
      .map(t => ({ id: t.id, pid: t.pid, name: t.name, ownerKey: t.ownerKey, createdAt: t.createdAt }));
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
    for (const t of this.byTerminal.values()) t.mirror.dispose();
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

/** Whether a region's reported command line belongs to an execution (unknown matches anything). */
function sameCommand(executionLine: string, reported: string | undefined): boolean {
  return reported === undefined || reported.trim() === executionLine.trim();
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

