import { describe, expect, it } from 'vitest';
import { clipLines, DEFAULT_MAX_CHARS, formatClip, formatDuration, shortCommand } from '../../src/extension/terminal/render';

const lines = Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`);

describe('clipLines', () => {
  it('keeps everything that fits', () => {
    const clip = clipLines(['a', 'b'], { maxChars: 1000 });
    expect(clip).toMatchObject({ text: 'a\nb', first: 1, last: 2, total: 2, omittedBefore: 0, omittedAfter: 0 });
  });

  it('keeps only the end when asked (headTail false) and says what was cut', () => {
    const clip = clipLines(lines, { maxChars: 1000, headTail: false });
    expect(clip.last).toBe(1000);
    expect(clip.text.endsWith('line 1000')).toBe(true);
    expect(clip.text.length).toBeLessThanOrEqual(1000);
    expect(clip.omittedBefore).toBe(clip.first - 1);
    const text = formatClip(clip, from => `read(${from})`);
    expect(text).toMatch(new RegExp(`Showing lines ${clip.first}-1000 of 1000; ${clip.first - 1} earlier lines cut\\. Read them with read\\(1\\)`));
  });

  it('pages forward from a line', () => {
    const clip = clipLines(lines, { maxChars: 1000, fromLine: 11 });
    expect(clip.first).toBe(11);
    expect(clip.text.startsWith('line 11\n')).toBe(true);
    expect(clip.omittedAfter).toBe(1000 - clip.last);
    expect(formatClip(clip, from => `read(${from})`)).toMatch(new RegExp(`Continue with read\\(${clip.last + 1}\\)`));
  });

  it('cuts a single huge line in the middle instead of dropping it', () => {
    const clip = clipLines(['x'.repeat(50_000)], { maxChars: 5000 });
    expect(clip.longLinesCut).toBe(1);
    expect(clip.text.length).toBeLessThan(2100);
    expect(clip.text).toMatch(/characters cut/);
  });

  it('collapses runs of 4+ identical lines and 3+ blank lines, with exact counts', () => {
    const input = ['start', ...Array(10).fill('retrying...'), 'x', 'x', 'x', '', '', '', '', '', 'y', '', '', 'end'];
    const clip = clipLines(input);
    expect(clip.text).toBe(['start', 'retrying...', '[repeated 9 more times]', 'x', 'x', 'x', '[5 blank lines]', 'y', '', '', 'end'].join('\n'));
    expect(clip).toMatchObject({ first: 1, last: input.length, total: input.length, omittedBefore: 0, omittedAfter: 0 });
  });

  it('keeps original line numbers for paging when runs are collapsed', () => {
    const input = [...Array.from({ length: 50 }, (_, i) => `a${i + 1}`), ...Array(500).fill('same'), ...Array.from({ length: 50 }, (_, i) => `b${i + 1} ${'-'.repeat(30)}`)];
    // The whole run is one short entry, so the end of the output fits with it.
    const tail = clipLines(input, { maxChars: 2500, headTail: false });
    expect(tail.last).toBe(600);
    expect(tail.text).toContain('same\n[repeated 499 more times]\nb1 ');
    expect(tail.first).toBeLessThanOrEqual(51);
    expect(tail.omittedBefore).toBe(tail.first - 1);
    expect(tail.text.startsWith(`a${tail.first}\n`)).toBe(true);
    // Paging from inside the run starts there and counts what is left of it.
    const page = clipLines(input, { maxChars: 500, fromLine: 301 });
    expect(page.first).toBe(301);
    expect(page.text.startsWith('same\n[repeated 249 more times]\nb1 ')).toBe(true);
    expect(page.omittedAfter).toBe(600 - page.last);
    expect(input[page.last - 1]).toBe(page.text.split('\n').at(-1));
    expect(formatClip(page, from => `read(${from})`)).toMatch(new RegExp(`Continue with read\\(${page.last + 1}\\)`));
  });

  it('says "(no output)" for nothing', () => {
    expect(formatClip(clipLines([]), () => '')).toBe('(no output)');
  });
});

/** Expands collapsed runs back into lines ("x" + "[repeated N more times]" -> N+1 lines, "[N blank lines]"). */
function expand(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const repeated = /^\[repeated (\d+) more times\]$/.exec(line);
    const blank = /^\[(\d+) blank lines\]$/.exec(line);
    if (repeated) for (let i = 0; i < Number(repeated[1]); i++) out.push(out.at(-1)!);
    else if (blank) for (let i = 0; i < Number(blank[1]); i++) out.push('');
    else out.push(line);
  }
  return out;
}

/** Follows the "Continue with read(N)" hints from `from` until the output ends, as an agent would. */
function pageFrom(input: readonly string[], from: number, maxChars?: number): { lines: string[]; calls: number } {
  const got: string[] = [];
  let calls = 0;
  for (let next: number | undefined = from; next !== undefined; calls++) {
    const clip = clipLines(input, { fromLine: next, maxChars });
    expect(clip.first).toBe(next);
    got.push(...expand(clip.text));
    const text = formatClip(clip, n => `read(${n})`);
    const m = /Continue with read\((\d+)\)/.exec(text);
    next = m ? Number(m[1]) : undefined;
    if (next !== undefined) expect(next).toBe(clip.last + 1);
    expect(calls).toBeLessThan(1000);
  }
  return { lines: got, calls };
}

describe('clipLines head and tail', () => {
  const seq = Array.from({ length: 5000 }, (_, i) => String(i + 1));

  it('keeps everything up to the default, with no cut', () => {
    const fits = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
    const clip = clipLines(fits);
    expect(clip.gap).toBeUndefined();
    expect(formatClip(clip, n => `read(${n})`)).toBe(fits.join('\n'));
  });

  it('keeps the start and the end of long output by default, naming the cut lines exactly', () => {
    const clip = clipLines(seq);
    expect(clip).toMatchObject({ first: 1, last: 5000, total: 5000, omittedBefore: 0, omittedAfter: 0 });
    const gap = clip.gap!;
    expect(gap).toBeDefined();
    const text = formatClip(clip, n => `read(${n})`);
    const shown = text.split('\n');
    const markerAt = shown.findIndex(l => l.startsWith('[…'));
    expect(shown[markerAt]).toBe(`[… ${gap.to - gap.from + 1} lines cut here (lines ${gap.from}-${gap.to} of 5000). Read them with read(${gap.from}).]`);
    // Head: lines 1..from-1, tail: to+1..5000, both exact.
    expect(shown.slice(0, markerAt)).toEqual(seq.slice(0, gap.from - 1));
    expect(shown.slice(markerAt + 1)).toEqual(seq.slice(gap.to));
    // Sizes: about 2,000 for the start and the rest of 12,000 for the end.
    const headChars = shown.slice(0, markerAt).join('\n').length;
    expect(headChars).toBeLessThanOrEqual(DEFAULT_MAX_CHARS / 6);
    expect(headChars).toBeGreaterThan(DEFAULT_MAX_CHARS / 6 - 10);
    expect(clip.text.length).toBeLessThanOrEqual(DEFAULT_MAX_CHARS);
    expect(clip.text.length).toBeGreaterThan(DEFAULT_MAX_CHARS - 10);
  });

  it('paging from the cut reaches every left-out line exactly once, then the end', () => {
    const clip = clipLines(seq);
    const { lines: got } = pageFrom(seq, clip.gap!.from);
    expect(got).toEqual(seq.slice(clip.gap!.from - 1));
    // Paging with a small max_chars too: forward only, never head+tail.
    expect(pageFrom(seq, clip.gap!.from, 500).lines).toEqual(seq.slice(clip.gap!.from - 1));
  });

  it('never splits a collapsed run, and counts its lines in the cut range', () => {
    const input = [
      ...Array.from({ length: 30 }, (_, i) => `head ${i + 1} ${'-'.repeat(40)}`),
      ...Array(400).fill('same'),
      ...Array.from({ length: 300 }, (_, i) => `mid ${i + 1} ${'-'.repeat(40)}`),
      ...Array(5).fill(''),
      ...Array.from({ length: 200 }, (_, i) => `end ${i + 1} ${'-'.repeat(40)}`),
    ];
    for (const maxChars of [undefined, 1500, 3000, 8000]) {
      const clip = clipLines(input, { maxChars });
      const gap = clip.gap!;
      expect(gap, String(maxChars)).toBeDefined();
      const text = formatClip(clip, n => `read(${n})`);
      const [before, after] = text.split(/\n\[… .*\]\n/);
      expect(expand(before!)).toEqual(input.slice(0, gap.from - 1));
      expect(expand(after!)).toEqual(input.slice(gap.to));
      expect(pageFrom(input, gap.from, maxChars).lines).toEqual(input.slice(gap.from - 1));
    }
  });

  it('applies to an explicit max_chars too, in the same proportions', () => {
    const clip = clipLines(seq, { maxChars: 3000 });
    expect(clip.gap!.from).toBeGreaterThan(50);
    expect(clip.text.length).toBeLessThanOrEqual(3000);
    expect(clip.text.endsWith('\n5000')).toBe(true);
    const big = clipLines(seq, { maxChars: 80_000 });
    expect(big.gap).toBeUndefined();
    expect(big.text.split('\n')).toEqual(seq);
  });

  it('keeps only the end when the first line alone exceeds the start\'s share', () => {
    const input = ['x'.repeat(5000), ...seq];
    const clip = clipLines(input, { maxChars: 3000 });
    expect(clip.gap).toBeUndefined();
    expect(clip.omittedBefore).toBe(clip.first - 1);
    expect(formatClip(clip, n => `read(${n})`)).toMatch(/earlier lines cut\. Read them with read\(1\)/);
  });

  it('numbers the lines of a partial output from the start of the whole (lineOffset)', () => {
    const clip = clipLines(seq.slice(1000));
    const text = formatClip(clip, n => `read(${n})`, { lineOffset: 1000 });
    const gap = clip.gap!;
    expect(text).toContain(`(lines ${gap.from + 1000}-${gap.to + 1000} of 5000). Read them with read(${gap.from + 1000})`);
    expect(text.split('\n')[0]).toBe('1001');
    expect(formatClip(clipLines([]), () => '')).toBe('(no output)');
  });
});

describe('formatting helpers', () => {
  it('formats durations', () => {
    expect(formatDuration(250)).toBe('250 ms');
    expect(formatDuration(3200)).toBe('3.2 s');
    expect(formatDuration(42_000)).toBe('42 s');
    expect(formatDuration(150_000)).toBe('2 min 30 s');
  });
  it('shortens command lines', () => {
    expect(shortCommand('a\nb')).toBe('a ⏎ b');
    expect(shortCommand(`node ${'x'.repeat(100)} server.mjs`, 20)).toBe('node xxxxx…erver.mjs');
  });
});
