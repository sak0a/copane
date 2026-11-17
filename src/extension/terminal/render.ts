// Cutting terminal output to a size a model can take (Claude Code rejects tool results beyond roughly
// 25k tokens), deliberately and visibly: keep the start and the end, say what was cut and how to read it.

/** Default size of the output part of a result, in characters (~3k tokens). */
export const DEFAULT_MAX_CHARS = 12_000;
/** Upper bound an agent may ask for (~20k tokens, under Claude Code's limit with room for the rest). */
export const MAX_MAX_CHARS = 80_000;
/** A single line longer than this is cut in the middle (minified files, base64 ...). */
export const MAX_LINE_CHARS = 2_000;
/**
 * Share of the budget kept from the start when output is cut (the first compile error, the command's
 * header); the rest keeps the end. 2,000 of the default 12,000.
 */
export const HEAD_SHARE = 1 / 6;

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
  /**
   * Head and tail: lines `from`-`to` (1-based, inclusive) were left out between the two; `at` is the
   * index in `text` of the line break where they were.
   */
  gap?: { from: number; to: number; at: number };
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
 * Fits `lines` into `maxChars`. Without `fromLine`: everything when it fits, else the start (a sixth of
 * the budget, `HEAD_SHARE`) and the end, with the lines between left out (`gap`). With `fromLine`
 * (1-based): the lines starting there, as many as fit, never cut in the middle, so paging with
 * `fromLine` = `last + 1` reaches every line exactly once.
 * Never returns an empty clip when there are lines: the last (or first) one is always included, cut.
 * Runs of 4+ identical lines and of 3+ blank lines are collapsed (with their count) and never split;
 * line numbers (`first`, `last`, `gap`, `fromLine`) always count the original lines.
 */
export function clipLines(lines: readonly string[], options: { maxChars?: number; fromLine?: number; headTail?: boolean } = {}): Clip {
  const maxChars = Math.max(500, Math.min(options.maxChars ?? DEFAULT_MAX_CHARS, MAX_MAX_CHARS));
  const lineLimit = Math.min(MAX_LINE_CHARS, maxChars);
  const total = lines.length;
  const longLinesCut = (gs: readonly Group[]) => gs.filter(g => g.cut).length;
  const cost = (g: Group) => g.text.length + 1;
  if (options.fromLine !== undefined) {
    const start = Math.max(1, Math.min(options.fromLine, total + 1)) - 1;
    const picked: Group[] = [];
    let used = 0;
    for (const g of group(lines, lineLimit, start)) {
      if (picked.length > 0 && used + cost(g) > maxChars) break;
      used += cost(g);
      picked.push(g);
    }
    const end = picked.at(-1)?.to ?? start;
    return {
      text: picked.map(g => g.text).join('\n'),
      first: picked.length ? start + 1 : 0,
      last: picked.length ? end + 1 : 0,
      total,
      omittedBefore: picked.length ? start : Math.min(start, total),
      omittedAfter: picked.length ? total - end - 1 : total - Math.min(start, total),
      longLinesCut: longLinesCut(picked),
    };
  }
  const groups = group(lines, lineLimit, 0);
  const all = groups.reduce((n, g) => n + cost(g), 0);
  if (all <= maxChars) {
    return { text: groups.map(g => g.text).join('\n'), first: total ? 1 : 0, last: total, total, omittedBefore: 0, omittedAfter: 0, longLinesCut: longLinesCut(groups) };
  }
  // The start, within its share; then the end, within the rest (and what the start left over).
  let used = 0;
  let h = 0;
  if (options.headTail !== false) {
    const headBudget = Math.floor(maxChars * HEAD_SHARE);
    for (; h < groups.length && used + cost(groups[h]!) <= headBudget; h++) used += cost(groups[h]!);
  }
  let t = groups.length;
  while (t > h && (t === groups.length || used + cost(groups[t - 1]!) <= maxChars)) used += cost(groups[--t]!);
  const head = groups.slice(0, h);
  const tail = groups.slice(t);
  const headText = head.map(g => g.text).join('\n');
  const tailText = tail.map(g => g.text).join('\n');
  const shown = [...head, ...tail];
  if (head.length === 0) {
    const start = tail[0]!.from;
    return { text: tailText, first: start + 1, last: total, total, omittedBefore: start, omittedAfter: 0, longLinesCut: longLinesCut(shown) };
  }
  const gapFrom = head.at(-1)!.to + 2;
  const gapTo = tail[0]!.from;
  return {
    text: `${headText}\n${tailText}`,
    first: 1,
    last: total,
    total,
    omittedBefore: 0,
    omittedAfter: 0,
    longLinesCut: longLinesCut(shown),
    ...(gapTo >= gapFrom ? { gap: { from: gapFrom, to: gapTo, at: headText.length } } : {}),
  };
}

/**
 * The output block of a result: a note about what was cut (with the call that reads the rest), then
 * the text. `readMore` builds that call for a given starting line. With `lineOffset`, the lines are
 * the end part of a longer output: numbers shown (and passed to `readMore`) count from its start.
 */
export function formatClip(clip: Clip, readMore: (fromLine: number) => string, options: { startLost?: boolean; lineOffset?: number } = {}): string {
  const o = options.lineOffset ?? 0;
  const notes: string[] = [];
  if (options.startLost) notes.push('[The beginning of this output scrolled out of the terminal history (4000 lines) and is no longer available.]');
  if (clip.omittedBefore > 0) {
    notes.push(`[Showing lines ${clip.first + o}-${clip.last + o} of ${clip.total + o}; ${clip.omittedBefore} earlier lines cut. Read them with ${readMore(o + 1)}.]`);
  }
  if (clip.longLinesCut > 0) notes.push(`[${clip.longLinesCut} very long line(s) were shortened in the middle.]`);
  let body = clip.total === 0 ? '(no output)' : clip.text;
  if (clip.gap) {
    const { from, to, at } = clip.gap;
    const n = to - from + 1;
    const marker = `[… ${n} line${n === 1 ? '' : 's'} cut here (lines ${from + o}-${to + o} of ${clip.total + o}). Read them with ${readMore(from + o)}.]`;
    body = `${body.slice(0, at)}\n${marker}${body.slice(at)}`;
  }
  const tail = clip.omittedAfter > 0 ? `\n[${clip.omittedAfter} more lines. Continue with ${readMore(clip.last + o + 1)}.]` : '';
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
