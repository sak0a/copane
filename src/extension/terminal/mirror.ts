// A headless terminal emulator that mirrors one VS Code terminal, so the extension can return what a
// person sees on screen instead of the raw byte stream: carriage returns, cursor movement, colors,
// line wrapping and full-screen programs are interpreted by xterm.js, the same emulator VS Code
// renders with. No dependency on `vscode`, so it is unit-tested in plain Node.
//
// Command boundaries are "regions" of the buffer. Two ways to feed a mirror:
// - "stream": the terminal's whole output (proposed `onDidWriteTerminalData`). Regions come from the
//   shell-integration sequences in the stream itself (OSC 633 ; C = output starts, D ; <code> = ends).
// - "executions": only the output of each command (`TerminalShellExecution.read()`), framed by
//   `beginRegion` / `endRegion`. The prompt and what is typed at it are not visible in this mode.
//
// Fast output (a build log, `yes`) must not make the extension host sluggish. Data is queued and handed
// to xterm.js a slice at a time; while a backlog builds up, parsing takes at most about a third of the
// time, and when the backlog holds far more lines than the scrollback keeps, the older ones are skipped
// unparsed (they would have scrolled out anyway). Shell-integration markers and screen-mode switches in
// skipped text are kept, so command boundaries and full-screen state stay right; output whose beginning
// was skipped is reported like output whose beginning scrolled out.
import { Terminal as Xterm, type IBuffer, type IMarker } from '@xterm/headless';
import { Emitter, type Event } from '../core/events';

export type MirrorFeed = 'stream' | 'executions';

/** Private OSC used to frame regions in "executions" mode, so framing stays in order with the data. */
const FRAME_OSC = 7771;
/** Private OSC around the markers kept from skipped output (see `compact`). */
const SKIP_OSC = 7772;
/** Characters handed to xterm.js at a time. */
const SLICE_CHARS = 128 * 1024;
/** Unparsed backlog at which old lines are skipped. */
const COMPACT_CHARS = 1024 * 1024;
/** While a backlog exists, wait this many times as long as a slice took to parse before the next (~33% duty). */
const BACKLOG_PAUSE_FACTOR = 2;
/** Escape sequences that change state the rest of the output depends on: shell integration and our own framing, screen and cursor-key modes. */
const KEPT_SEQUENCES = /\x1b\](?:633|7771);[^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[\?(?:1049|1047|47|1)[hl]/g;

export interface Region {
  readonly id: number;
  /** Line where the output starts; disposed (line -1) once it scrolled out of the scrollback. */
  readonly start: IMarker | undefined;
  readonly startCol: number;
  end: IMarker | undefined;
  endCol: number;
  ended: boolean;
  exitCode: number | undefined;
  /** The command line the shell reported for it (OSC 633;E), when it did. */
  commandLine: string | undefined;
  /** Part of its beginning is missing: skipped as too fast, or from before the terminal was mirrored. */
  truncated?: boolean;
  /** When the output started (the mirror's clock). */
  readonly startedAt?: number;
}

/**
 * A read position: new output is everything after it, on the normal screen. A full-screen program
 * (alternate screen) leaves the normal buffer untouched, so a mark taken meanwhile holds the normal
 * buffer's line in `line` and gets a real marker when the program returns to the normal screen.
 */
export interface Mark {
  /** Undefined while the mark waits for the normal screen (see `line`). */
  readonly marker: IMarker | undefined;
  readonly col: number;
  /** Set when the mark was taken while a full-screen program was showing. */
  readonly alternate: boolean;
  /** Taken on the alternate screen: the normal buffer's line, used until `marker` is set. */
  readonly line?: number;
  /** How many times output had been skipped when the mark was taken (see TerminalMirror.skips). */
  readonly skips?: number;
}

export interface LinesResult {
  lines: string[];
  /** The start position scrolled out of the scrollback, so earlier lines are missing. */
  startLost: boolean;
}

export interface ScreenSnapshot {
  lines: string[];
  cursor: { row: number; col: number };
  /** A full-screen program (vim, less, top ...) is using the alternate screen. */
  alternate: boolean;
  cols: number;
  rows: number;
}

export interface MirrorOptions {
  feed: MirrorFeed;
  cols?: number;
  rows?: number;
  scrollback?: number;
  now?: () => number;
}

export class TerminalMirror {
  private readonly xterm: Xterm;
  private readonly now: () => number;
  private nextRegionId = 1;
  private openRegion: Region | undefined;
  private reportedCommandLine: string | undefined;
  private readonly startEmitter = new Emitter<Region>();
  private readonly endEmitter = new Emitter<Region>();
  private readonly promptEmitter = new Emitter<void>();
  private readonly promptEndEmitter = new Emitter<void>();
  /** When data last arrived (ms). */
  lastWriteAt = 0;
  /** Total characters received, to tell "something changed" cheaply. */
  received = 0;
  /** How many times output arrived faster than it could be interpreted and old lines were skipped. */
  skips = 0;
  /** Lines skipped in total. */
  skippedLines = 0;
  readonly feed: MirrorFeed;
  private readonly scrollback: number;
  private readonly queue: Array<{ data: string; seq: number }> = [];
  private queuedChars = 0;
  private seq = 0;
  private parsedSeq = 0;
  private parsing = false;
  private pauseTimer: NodeJS.Timeout | undefined;
  private readonly waiters: Array<{ seq: number; resolve: () => void }> = [];
  private inSkipped = false;
  private disposed = false;
  /** Marks taken on the alternate screen, given markers when the normal screen is back. */
  private readonly pendingMarks: Array<{ marker: IMarker | undefined; line?: number }> = [];

  /** A command's output starts (OSC 633;C or `beginRegion`). Fired while parsing, in stream order. */
  readonly onRegionStart: Event<Region> = this.startEmitter.event;
  readonly onRegionEnd: Event<Region> = this.endEmitter.event;
  /** The shell started drawing its prompt (OSC 633;A, stream mode only). */
  readonly onPrompt: Event<void> = this.promptEmitter.event;
  /** The shell finished drawing its prompt and waits for input (OSC 633;B, stream mode only). */
  readonly onPromptEnd: Event<void> = this.promptEndEmitter.event;

  constructor(options: MirrorOptions) {
    this.feed = options.feed;
    this.now = options.now ?? Date.now;
    this.scrollback = options.scrollback ?? 4000;
    this.xterm = new Xterm({
      cols: clamp(options.cols ?? 120, 20, 500),
      rows: clamp(options.rows ?? 30, 5, 200),
      scrollback: this.scrollback,
      allowProposedApi: true,
      convertEol: false,
    });
    this.xterm.parser.registerOscHandler(633, data => {
      if (this.feed === 'stream') this.onShellIntegration(data);
      return true;
    });
    this.xterm.parser.registerOscHandler(FRAME_OSC, data => {
      if (this.feed === 'executions') this.onShellIntegration(data);
      return true;
    });
    this.xterm.buffer.onBufferChange(buffer => {
      if (buffer.type === 'normal') this.resolvePendingMarks();
    });
    this.xterm.parser.registerOscHandler(SKIP_OSC, data => {
      this.inSkipped = data === 'start';
      if (this.inSkipped) {
        this.skips++;
        if (this.openRegion && !this.openRegion.ended) this.openRegion.truncated = true;
      }
      return true;
    });
  }

  get cols(): number {
    return this.xterm.cols;
  }

  get rows(): number {
    return this.xterm.rows;
  }

  /** Arrow keys must be sent as SS3 sequences while the program enabled application cursor mode. */
  get applicationCursorKeys(): boolean {
    return this.xterm.modes.applicationCursorKeysMode;
  }

  get alternate(): boolean {
    return this.xterm.buffer.active.type === 'alternate';
  }

  get currentRegion(): Region | undefined {
    return this.openRegion;
  }

  /** Queues output; resolves once it has been interpreted (or skipped, see `compact`). */
  write(data: string): Promise<void> {
    if (!data) return this.flush();
    this.lastWriteAt = this.now();
    this.received += data.length;
    return this.enqueue(data);
  }

  /** Resolves once everything written so far has been parsed. */
  flush(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.parsedSeq >= this.seq) return new Promise<void>(resolve => this.xterm.write('', resolve));
    return this.waitFor(this.seq);
  }

  /**
   * Feeds output that was printed before this mirror existed (kept by a TerminalTail), without counting
   * it as new activity. `truncated`: its beginning is missing, so a command open in it lost its start.
   */
  replay(data: string, truncated: boolean): Promise<void> {
    return this.enqueue(truncated ? `\x1b]${SKIP_OSC};start\x07\x1b]${SKIP_OSC};end\x07${data}` : data);
  }

  /** Characters received but not yet interpreted. */
  get backlog(): number {
    return this.queuedChars;
  }

  private enqueue(data: string): Promise<void> {
    const seq = ++this.seq;
    this.queue.push({ data, seq });
    this.queuedChars += data.length;
    if (this.queuedChars > COMPACT_CHARS) this.compact();
    this.pump();
    return this.waitFor(seq);
  }

  private waitFor(seq: number): Promise<void> {
    if (this.disposed || this.parsedSeq >= seq) return Promise.resolve();
    return new Promise<void>(resolve => this.waiters.push({ seq, resolve }));
  }

  private pump(): void {
    if (this.parsing || this.pauseTimer || this.disposed || this.queue.length === 0) return;
    let data = '';
    let upTo = this.parsedSeq;
    while (this.queue.length > 0 && (data === '' || data.length + this.queue[0]!.data.length <= SLICE_CHARS)) {
      const next = this.queue.shift()!;
      data += next.data;
      upTo = next.seq;
    }
    this.queuedChars -= data.length;
    this.parsing = true;
    const started = performance.now();
    this.xterm.write(data, () => {
      this.parsing = false;
      this.settle(upTo);
      if (this.disposed || this.queue.length === 0) return;
      // A backlog: leave the event loop to everything else for a while before the next slice.
      const pause = Math.min(250, (performance.now() - started) * BACKLOG_PAUSE_FACTOR);
      if (pause < 1) return this.pump();
      this.pauseTimer = setTimeout(() => {
        this.pauseTimer = undefined;
        this.pump();
      }, pause);
    });
  }

  private settle(upTo: number): void {
    this.parsedSeq = Math.max(this.parsedSeq, upTo);
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      const w = this.waiters[i]!;
      if (w.seq <= this.parsedSeq) {
        this.waiters.splice(i, 1);
        w.resolve();
      }
    }
  }

  /**
   * The backlog is too large: keep only as many of its last lines as the screen and scrollback hold,
   * plus the state-changing sequences of the skipped part, in order, framed so regions know.
   */
  private compact(): void {
    const all = this.queue.map(e => e.data).join('');
    const keepLines = this.scrollback + this.xterm.rows + 50;
    let cut = all.length;
    for (let lines = 0; lines < keepLines; lines++) {
      const i = all.lastIndexOf('\n', cut - 1);
      if (i <= 0) return; // Not that many lines: nothing would scroll out, so nothing is skipped.
      cut = i;
    }
    const skipped = all.slice(0, cut + 1);
    let lines = 0;
    for (let i = skipped.indexOf('\n'); i >= 0; i = skipped.indexOf('\n', i + 1)) lines++;
    this.skippedLines += lines;
    const kept = skipped.match(KEPT_SEQUENCES)?.join('') ?? '';
    const data = `\x1b]${SKIP_OSC};start\x07${kept}\x1b]${SKIP_OSC};end\x07\r\n${all.slice(cut + 1)}`;
    const seq = this.queue[this.queue.length - 1]!.seq;
    this.queue.length = 0;
    this.queue.push({ data, seq });
    this.queuedChars = data.length;
  }

  resize(cols: number, rows: number): void {
    const c = clamp(cols, 20, 500);
    const r = clamp(rows, 5, 200);
    if (c !== this.xterm.cols || r !== this.xterm.rows) this.xterm.resize(c, r);
  }

  /** Executions mode: frames the output of one command. Starts on a fresh line. */
  async beginRegion(): Promise<Region | undefined> {
    await this.flush();
    const prefix = this.xterm.buffer.normal.cursorX > 0 ? '\r\n' : '';
    let region: Region | undefined;
    const sub = this.onRegionStart(r => (region = r));
    await this.write(`${prefix}\x1b]${FRAME_OSC};C\x07`);
    sub.dispose();
    return region;
  }

  async endRegion(exitCode: number | undefined): Promise<void> {
    await this.write(`\x1b]${FRAME_OSC};D${exitCode === undefined ? '' : `;${exitCode}`}\x07`);
  }

  /**
   * A region for a command whose output began before this mirror existed (or before what it holds):
   * from the top of the buffer, marked truncated. It becomes the open region, so the command's end closes it.
   */
  regionFromStart(): Region {
    const buffer = this.xterm.buffer.normal;
    const region: Region = {
      id: this.nextRegionId++,
      start: this.xterm.registerMarker(-(buffer.baseY + buffer.cursorY)),
      startCol: 0,
      end: undefined,
      endCol: 0,
      ended: false,
      exitCode: undefined,
      commandLine: undefined,
      truncated: true,
    };
    this.openRegion = region;
    return region;
  }

  /** Lines of a command's output, as rendered. An open region ends at the cursor. */
  regionLines(region: Region): LinesResult {
    const buffer = this.xterm.buffer.normal;
    const startLost = !region.start || region.start.line < 0 || region.truncated === true;
    const startLine = startLost ? 0 : region.start!.line;
    const startCol = startLost ? 0 : region.startCol;
    let endLine: number;
    let endCol: number | undefined;
    if (region.ended && region.end && region.end.line >= 0) {
      endLine = region.end.line;
      endCol = region.endCol;
    } else {
      endLine = buffer.baseY + buffer.cursorY;
      endCol = undefined;
    }
    return { lines: tidy(readLines(buffer, startLine, startCol, endLine, endCol)), startLost };
  }

  /** The current position, for reading what comes after it later. */
  mark(options: { exact?: boolean } = {}): Mark {
    const buffer = this.xterm.buffer.normal;
    // Unless exact, start at the beginning of the cursor line: a progress bar may still redraw it.
    const col = options.exact ? buffer.cursorX : 0;
    if (this.alternate) {
      // The normal buffer does not change until the program leaves the alternate screen.
      const mark: Mark = { marker: undefined, col, alternate: true, skips: this.skips, line: buffer.baseY + buffer.cursorY };
      this.pendingMarks.push(mark);
      return mark;
    }
    const marker = this.xterm.registerMarker(0);
    return { marker, col, alternate: false, skips: this.skips };
  }

  /** Back on the normal screen: marks taken on the alternate screen get markers at their line. */
  private resolvePendingMarks(): void {
    const buffer = this.xterm.buffer.normal;
    // registerMarker counts from the cursor of the active buffer, which is the normal one again. Its
    // cursor may not be restored yet (xterm.js restores it after this event), so count from where it is now.
    const cursor = buffer.baseY + buffer.cursorY;
    for (const mark of this.pendingMarks.splice(0)) {
      if (mark.marker || mark.line === undefined) continue;
      mark.marker = this.xterm.registerMarker(Math.min(mark.line, buffer.length - 1) - cursor);
    }
  }

  /** A mark at the end of a finished region (nothing more will be written into it). */
  markAfter(region: Region): Mark {
    if (region.end && region.end.line >= 0) return { marker: region.end, col: region.endCol, alternate: false, skips: this.skips };
    return this.mark({ exact: true });
  }

  /**
   * Everything after `mark` on the normal screen, as rendered. While a full-screen program shows,
   * that is only what was printed before it started; its own screen is `screen()`.
   */
  linesSince(mark: Mark | undefined): LinesResult {
    const buffer = this.xterm.buffer.normal;
    const endLine = buffer.baseY + buffer.cursorY;
    const line = mark?.marker ? mark.marker.line : mark?.line;
    if (!mark || line === undefined || line < 0) {
      // No mark: the last screenful. A mark whose line is gone: it scrolled out, read what is left.
      const from = mark ? 0 : Math.max(0, endLine - this.xterm.rows + 1);
      return { lines: tidy(readLines(buffer, from, 0, endLine, undefined)), startLost: !!mark };
    }
    const skipped = mark.skips !== undefined && this.skips > mark.skips;
    return { lines: tidy(readLines(buffer, Math.min(line, endLine), mark.col, endLine, undefined)), startLost: skipped };
  }

  /** The visible screen of the active buffer (the full-screen program's screen if one is running). */
  screen(): ScreenSnapshot {
    const buffer = this.xterm.buffer.active;
    const top = buffer.baseY;
    const lines: string[] = [];
    for (let y = top; y < top + this.xterm.rows; y++) lines.push(buffer.getLine(y)?.translateToString(true) ?? '');
    while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();
    return { lines, cursor: { row: buffer.cursorY, col: buffer.cursorX }, alternate: this.alternate, cols: this.xterm.cols, rows: this.xterm.rows };
  }

  /** The line the cursor is on, split at the cursor. */
  cursorLine(): { beforeCursor: string; afterCursor: string } {
    const buffer = this.xterm.buffer.active;
    const line = buffer.getLine(buffer.baseY + buffer.cursorY);
    const full = line?.translateToString(false) ?? '';
    return { beforeCursor: full.slice(0, buffer.cursorX), afterCursor: full.slice(buffer.cursorX).trimEnd() };
  }

  /** The last `count` non-empty lines of the screen, for prompt detection. */
  tail(count: number): string[] {
    return this.screen().lines.filter(l => l.trim() !== '').slice(-count);
  }

  dispose(): void {
    this.disposed = true;
    if (this.pauseTimer) clearTimeout(this.pauseTimer);
    this.pauseTimer = undefined;
    this.queue.length = 0;
    this.queuedChars = 0;
    for (const w of this.waiters.splice(0)) w.resolve();
    this.startEmitter.dispose();
    this.endEmitter.dispose();
    this.promptEmitter.dispose();
    this.promptEndEmitter.dispose();
    this.xterm.dispose();
  }

  private onShellIntegration(data: string): void {
    const [kind, ...rest] = data.split(';');
    if (kind === 'C') {
      if (this.openRegion && !this.openRegion.ended) this.closeRegion(undefined);
      const buffer = this.xterm.buffer.normal;
      const region: Region = {
        id: this.nextRegionId++,
        start: this.alternate ? undefined : this.xterm.registerMarker(0),
        startCol: buffer.cursorX,
        end: undefined,
        endCol: 0,
        ended: false,
        exitCode: undefined,
        commandLine: this.reportedCommandLine,
        ...(this.inSkipped ? { truncated: true } : {}),
        startedAt: this.now(),
      };
      this.reportedCommandLine = undefined;
      this.openRegion = region;
      this.startEmitter.fire(region);
    } else if (kind === 'D') {
      if (!this.openRegion || this.openRegion.ended) return;
      const code = rest[0] !== undefined && rest[0] !== '' ? Number(rest[0]) : undefined;
      this.closeRegion(Number.isFinite(code) ? code : undefined);
    } else if (kind === 'E') {
      this.reportedCommandLine = decodeOscValue(rest[0] ?? '');
    } else if (kind === 'A') {
      this.promptEmitter.fire();
    } else if (kind === 'B') {
      this.promptEndEmitter.fire();
    }
  }

  private closeRegion(exitCode: number | undefined): void {
    const region = this.openRegion!;
    const buffer = this.xterm.buffer.normal;
    region.end = this.alternate ? undefined : this.xterm.registerMarker(0);
    region.endCol = buffer.cursorX;
    region.ended = true;
    region.exitCode = exitCode;
    this.endEmitter.fire(region);
  }
}

/** Undoes the escaping of shell-integration values: \\ is a backslash, \xHH a character. */
/**
 * Whether a region's reported command line (OSC 633;E) belongs to an execution of `executionLine`;
 * unknown matches anything. bash reports only the simple command running when its output starts
 * ($BASH_COMMAND, unless its history can be used): "echo a" for "echo a; echo b", "make" for
 * "make && make test", "ls" for "ls | wc -l". So a reported command also matches when it is one whole
 * simple command of the line: bounded by the start, a separator (; & | ( newline) or the end.
 */
export function sameCommand(executionLine: string, reported: string | undefined): boolean {
  if (reported === undefined) return true;
  const line = executionLine.trim();
  const command = reported.trim();
  if (command === line) return true;
  if (!command) return false;
  for (let at = line.indexOf(command); at >= 0; at = line.indexOf(command, at + 1)) {
    const before = line.slice(0, at);
    const after = line.slice(at + command.length);
    if (/(^|[;&|(\n]\s*)$/.test(before) && /^\s*($|[;&|)\n])/.test(after)) return true;
  }
  return false;
}

export function decodeOscValue(value: string): string {
  return value.replace(/\\(\\|x([0-9a-fA-F]{2}))/g, (_m, _what: string, hex: string | undefined) => (hex ? String.fromCharCode(parseInt(hex, 16)) : '\\'));
}

/** Reads buffer lines [fromLine, toLine] into logical lines (soft-wrapped rows joined). */
function readLines(buffer: IBuffer, fromLine: number, fromCol: number, toLine: number, toCol: number | undefined): string[] {
  const out: string[] = [];
  let current = '';
  for (let y = fromLine; y <= toLine; y++) {
    const line = buffer.getLine(y);
    if (!line) break;
    const continues = y < toLine && buffer.getLine(y + 1)?.isWrapped === true;
    const start = y === fromLine ? fromCol : 0;
    const end = y === toLine ? toCol : undefined;
    if (y === toLine && end === 0 && y !== fromLine && !line.isWrapped) break;
    current += line.translateToString(!continues, start, end);
    if (!continues) {
      out.push(current);
      current = '';
    }
  }
  if (current) out.push(current);
  return out;
}

/** Trims line ends and drops trailing empty lines. */
function tidy(lines: string[]): string[] {
  const out = lines.map(l => l.trimEnd());
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}
