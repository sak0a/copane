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
import { Terminal as Xterm, type IBuffer, type IMarker } from '@xterm/headless';
import { Emitter, type Event } from '../core/events';

export type MirrorFeed = 'stream' | 'executions';

/** Private OSC used to frame regions in "executions" mode, so framing stays in order with the data. */
const FRAME_OSC = 7771;

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
  /** When the output started (the mirror's clock). */
  readonly startedAt?: number;
}

/** A read position: new output is everything after it. */
export interface Mark {
  readonly marker: IMarker | undefined;
  readonly col: number;
  /** Set when the mark was taken while a full-screen program was showing. */
  readonly alternate: boolean;
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
  readonly feed: MirrorFeed;

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
    this.xterm = new Xterm({
      cols: clamp(options.cols ?? 120, 20, 500),
      rows: clamp(options.rows ?? 30, 5, 200),
      scrollback: options.scrollback ?? 4000,
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

  write(data: string): Promise<void> {
    if (!data) return this.flush();
    this.lastWriteAt = this.now();
    this.received += data.length;
    const done = new Promise<void>(resolve => this.xterm.write(data, resolve));
    return done;
  }

  /** Resolves once everything written so far has been parsed. */
  flush(): Promise<void> {
    return new Promise<void>(resolve => this.xterm.write('', resolve));
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

  /** Lines of a command's output, as rendered. An open region ends at the cursor. */
  regionLines(region: Region): LinesResult {
    const buffer = this.xterm.buffer.normal;
    const startLost = !region.start || region.start.line < 0;
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
    if (this.alternate) return { marker: undefined, col: 0, alternate: true };
    // Unless exact, start at the beginning of the cursor line: a progress bar may still redraw it.
    const marker = this.xterm.registerMarker(0);
    return { marker, col: options.exact ? buffer.cursorX : 0, alternate: false };
  }

  /** A mark at the end of a finished region (nothing more will be written into it). */
  markAfter(region: Region): Mark {
    if (region.end && region.end.line >= 0) return { marker: region.end, col: region.endCol, alternate: false };
    return this.mark({ exact: true });
  }

  /** Everything after `mark` on the normal screen, as rendered. */
  linesSince(mark: Mark | undefined): LinesResult {
    const buffer = this.xterm.buffer.normal;
    const endLine = buffer.baseY + buffer.cursorY;
    if (!mark || mark.alternate || !mark.marker || mark.marker.line < 0) {
      const lost = !!mark && !mark.alternate;
      const from = mark ? 0 : Math.max(0, endLine - this.xterm.rows + 1);
      return { lines: tidy(readLines(buffer, from, 0, endLine, undefined)), startLost: lost };
    }
    return { lines: tidy(readLines(buffer, mark.marker.line, mark.col, endLine, undefined)), startLost: false };
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
