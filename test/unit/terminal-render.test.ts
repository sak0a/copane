import { describe, expect, it } from 'vitest';
import { clipLines, formatClip, formatDuration, shortCommand } from '../../src/extension/terminal/render';

const lines = Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`);

describe('clipLines', () => {
  it('keeps everything that fits', () => {
    const clip = clipLines(['a', 'b'], { maxChars: 1000 });
    expect(clip).toMatchObject({ text: 'a\nb', first: 1, last: 2, total: 2, omittedBefore: 0, omittedAfter: 0 });
  });

  it('keeps the end of long output and says what was cut', () => {
    const clip = clipLines(lines, { maxChars: 1000 });
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
    const tail = clipLines(input, { maxChars: 2500 });
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
