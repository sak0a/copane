// The last part of a terminal's raw output, kept cheaply for terminals no agent may use yet (the user's
// own). Interpreting output costs memory and CPU (a headless emulator per terminal, see mirror.ts), so a
// user terminal gets its mirror only when an agent is allowed to use it; the mirror then starts from
// this tail, so the agent sees what is on screen and the recent output, as the user does.
// No dependency on `vscode`, so it is unit-tested.

/** About the last 1000 lines of typical output. */
export const TAIL_CHARS = 64 * 1024;

export class TerminalTail {
  private chunks: string[] = [];
  private size = 0;
  /** Older output was dropped, so the tail does not start at the terminal's beginning. */
  truncated = false;
  /** When data last arrived (ms), and how much in total: what a mirror reports for activity. */
  lastWriteAt = 0;
  received = 0;
  /** Whether a full-screen program's screen (alternate buffer) is showing at the end of the tail. */
  private alternate = false;

  constructor(
    private readonly maxChars = TAIL_CHARS,
    private readonly now: () => number = Date.now,
  ) {}

  append(data: string): void {
    if (!data) return;
    this.lastWriteAt = this.now();
    this.received += data.length;
    this.trackScreen(data);
    this.chunks.push(data);
    this.size += data.length;
    if (this.size > this.maxChars * 1.5) this.trim();
  }

  /** Whether the output so far ends at the start of a line. */
  get atLineStart(): boolean {
    const last = this.chunks[this.chunks.length - 1];
    return !last || last.endsWith('\n');
  }

  get length(): number {
    return this.size;
  }

  /**
   * The output to replay into a new mirror. Starts at a line boundary when cut; when a full-screen
   * program is showing and its start was cut off, switches to its screen first.
   */
  text(): string {
    if (this.size > this.maxChars) this.trim();
    const body = this.chunks.join('');
    this.chunks = body ? [body] : [];
    return this.truncated && this.alternate && !/\x1b\[\?(1049|1047|47)h/.test(body) ? `\x1b[?1049h${body}` : body;
  }

  clear(): void {
    this.chunks = [];
    this.size = 0;
  }

  private trim(): void {
    const all = this.chunks.join('');
    let start = all.length - this.maxChars;
    const nl = all.indexOf('\n', start);
    // Start after a line break, so no escape sequence is cut in half (unless one line is that long).
    if (nl >= 0 && nl < all.length - 1) start = nl + 1;
    const kept = all.slice(start);
    this.chunks = [kept];
    this.size = kept.length;
    this.truncated = true;
  }

  private trackScreen(data: string): void {
    if (data.indexOf('\x1b[?') < 0) return;
    const re = /\x1b\[\?(?:1049|1047|47)([hl])/g;
    for (let m = re.exec(data); m; m = re.exec(data)) this.alternate = m[1] === 'h';
  }
}
