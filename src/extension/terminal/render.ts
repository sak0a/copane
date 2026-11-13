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

/**
 * Keeps the end of `lines` within `maxChars`, or, with `fromLine` (1-based), the lines starting there.
 * Never returns an empty clip when there are lines: the last (or first) one is always included, cut.
 */
export function clipLines(lines: readonly string[], options: { maxChars?: number; fromLine?: number } = {}): Clip {
  const maxChars = Math.max(500, Math.min(options.maxChars ?? DEFAULT_MAX_CHARS, MAX_MAX_CHARS));
  const lineLimit = Math.min(MAX_LINE_CHARS, maxChars);
  const total = lines.length;
  const picked: string[] = [];
  let used = 0;
  let longLinesCut = 0;
  const take = (raw: string): boolean => {
    const [line, cut] = cutLong(raw, lineLimit);
    const cost = line.length + 1;
    if (picked.length > 0 && used + cost > maxChars) return false;
    if (cut) longLinesCut++;
    used += cost;
    picked.push(line);
    return true;
  };
  if (options.fromLine !== undefined) {
    const start = Math.max(1, Math.min(options.fromLine, total + 1));
    for (let i = start - 1; i < total && take(lines[i]!); i++);
    const first = picked.length ? start : 0;
    const last = picked.length ? start + picked.length - 1 : 0;
    return { text: picked.join('\n'), first, last, total, omittedBefore: start - 1, omittedAfter: total - (start - 1) - picked.length, longLinesCut };
  }
  for (let i = total - 1; i >= 0 && take(lines[i]!); i--);
  picked.reverse();
  const first = picked.length ? total - picked.length + 1 : 0;
  return { text: picked.join('\n'), first, last: picked.length ? total : 0, total, omittedBefore: total - picked.length, omittedAfter: 0, longLinesCut };
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
