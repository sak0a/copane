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
