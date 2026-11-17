// Cutting terminal output to a size a model can take (Claude Code rejects tool results beyond roughly
// 25k tokens), deliberately and visibly: keep the end by default, say what was cut and how to read it.

/** Default size of the output part of a result, in characters (~5k tokens). */
export const DEFAULT_MAX_CHARS = 20_000;
/** Upper bound an agent may ask for (~20k tokens, under Claude Code's limit with room for the rest). */
export const MAX_MAX_CHARS = 80_000;
/** A single line longer than this is cut in the middle (minified files, base64 ...). */
export const MAX_LINE_CHARS = 2_000;

export interface Clip {
  /** The lines to show, joined with "\n". */
  text: string;
  /** 1-based number of the first and last line shown (0 when nothing is shown). */
  first: number;
  last: number;
  total: number;
  /** Lines left out before `first` and after `last`. */
  omittedBefore: number;
  omittedAfter: number;
  /** Lines that were cut in the middle because they were too long on their own. */
  longLinesCut: number;
}

function cutLong(line: string, limit: number): [string, boolean] {
  if (line.length <= limit) return [line, false];
  const head = Math.floor(limit * 0.6);
  const tail = limit - head;
  return [`${line.slice(0, head)} … [${line.length - limit} characters cut] … ${line.slice(-tail)}`, true];
}

/** Runs of at least this many identical lines show the line once and how often it repeats. */
export const REPEAT_RUN = 4;
/** Runs of at least this many blank lines show as one line with their count. */
export const BLANK_RUN = 3;

/** Consecutive lines shown as one entry: [from, to] are 0-based indexes into the input, inclusive. */
interface Group {
  text: string;
  from: number;
  to: number;
  cut: boolean;
}

/** Groups `lines[from..]` (or up to `to`), collapsing runs of repeated and blank lines. */
function group(lines: readonly string[], lineLimit: number, from: number): Group[] {
  const out: Group[] = [];
  for (let i = from; i < lines.length; ) {
    const raw = lines[i]!;
    let j = i + 1;
    while (j < lines.length && lines[j] === raw) j++;
    const blank = raw.trim() === '';
    if (blank) while (j < lines.length && lines[j]!.trim() === '') j++;
    const count = j - i;
    if (blank && count >= BLANK_RUN) {
      out.push({ text: `[${count} blank lines]`, from: i, to: j - 1, cut: false });
    } else if (!blank && count >= REPEAT_RUN) {
      const [line, cut] = cutLong(raw, lineLimit);
      out.push({ text: `${line}\n[repeated ${count - 1} more times]`, from: i, to: j - 1, cut });
    } else {
      // Too short a run to collapse: each line on its own.
      for (let k = i; k < j; k++) {
        const [line, cut] = cutLong(lines[k]!, lineLimit);
        out.push({ text: line, from: k, to: k, cut });
      }
    }
    i = j;
  }
  return out;
}

/**
 * Keeps the end of `lines` within `maxChars`, or, with `fromLine` (1-based), the lines starting there.
 * Never returns an empty clip when there are lines: the last (or first) one is always included, cut.
 * Runs of 4+ identical lines and of 3+ blank lines are collapsed (with their count); line numbers
 * (`first`, `last`, `fromLine`) always count the original lines.
 */
export function clipLines(lines: readonly string[], options: { maxChars?: number; fromLine?: number } = {}): Clip {
  const maxChars = Math.max(500, Math.min(options.maxChars ?? DEFAULT_MAX_CHARS, MAX_MAX_CHARS));
  const lineLimit = Math.min(MAX_LINE_CHARS, maxChars);
  const total = lines.length;
  const picked: Group[] = [];
  let used = 0;
  const take = (g: Group): boolean => {
    const cost = g.text.length + 1;
    if (picked.length > 0 && used + cost > maxChars) return false;
    used += cost;
    picked.push(g);
    return true;
  };
  const result = (start: number, end: number): Clip => ({
    text: picked.map(g => g.text).join('\n'),
    first: picked.length ? start + 1 : 0,
    last: picked.length ? end + 1 : 0,
    total,
    omittedBefore: picked.length ? start : Math.min(start, total),
    omittedAfter: picked.length ? total - end - 1 : total - Math.min(start, total),
    longLinesCut: picked.filter(g => g.cut).length,
  });
  if (options.fromLine !== undefined) {
    const start = Math.max(1, Math.min(options.fromLine, total + 1)) - 1;
    for (const g of group(lines, lineLimit, start)) if (!take(g)) break;
    return result(start, picked.at(-1)?.to ?? start);
  }
  const groups = group(lines, lineLimit, 0);
  for (let i = groups.length - 1; i >= 0 && take(groups[i]!); i--);
  picked.reverse();
  return result(picked[0]?.from ?? total, total - 1);
}

/**
 * The output block of a result: a note about what was cut (with the call that reads the rest), then
 * the text. `readMore` builds that call for a given starting line.
 */
export function formatClip(clip: Clip, readMore: (fromLine: number) => string, options: { startLost?: boolean } = {}): string {
  const notes: string[] = [];
  if (options.startLost) notes.push('[The beginning of this output scrolled out of the terminal history (4000 lines) and is no longer available.]');
  if (clip.omittedBefore > 0) {
    notes.push(`[Showing lines ${clip.first}-${clip.last} of ${clip.total}; ${clip.omittedBefore} earlier lines cut. Read them with ${readMore(1)}.]`);
  }
  if (clip.longLinesCut > 0) notes.push(`[${clip.longLinesCut} very long line(s) were shortened in the middle.]`);
  const body = clip.total === 0 ? '(no output)' : clip.text;
  const tail = clip.omittedAfter > 0 ? `\n[${clip.omittedAfter} more lines. Continue with ${readMore(clip.last + 1)}.]` : '';
  return (notes.length ? `${notes.join('\n')}\n` : '') + body + tail;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} s`;
  const m = Math.floor(s / 60);
  const rest = Math.round(s - m * 60);
  if (m < 60) return rest ? `${m} min ${rest} s` : `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** Shortens a command line for one-line mentions, keeping both ends (the program and its last arguments). */
export function shortCommand(commandLine: string, max = 80): string {
  const one = commandLine.replace(/\s*\n\s*/g, ' ⏎ ').trim();
  if (one.length <= max) return one;
  const head = Math.ceil((max - 1) / 2);
  return `${one.slice(0, head)}…${one.slice(one.length - (max - 1 - head))}`;
}
