import { describe, expect, it } from 'vitest';
import { labelPrefix, renamedFor } from '../../src/extension/terminal/access';
import { TerminalMirror } from '../../src/extension/terminal/mirror';
import { TerminalTail } from '../../src/extension/terminal/tail';

const C = '\x1b]633;C\x07';
const D = (code: number) => `\x1b]633;D;${code}\x07`;

describe('TerminalTail', () => {
  it('keeps only the end of the output, cut at a line start', () => {
    const tail = new TerminalTail(100);
    for (let i = 0; i < 100; i++) tail.append(`line ${i}\r\n`);
    const text = tail.text();
    expect(text.length).toBeLessThanOrEqual(100);
    expect(text.startsWith('line ')).toBe(true);
    expect(text.endsWith('line 99\r\n')).toBe(true);
    expect(tail.truncated).toBe(true);
    expect(tail.received).toBe(890);
  });

  it('switches to the full-screen program\'s screen when its start was cut off', async () => {
    const tail = new TerminalTail(200);
    tail.append('\x1b[?1049h');
    for (let i = 0; i < 50; i++) tail.append(`\x1b[Hframe ${i}\r\n`);
    const mirror = new TerminalMirror({ feed: 'stream', cols: 40, rows: 10 });
    await mirror.replay(tail.text(), tail.truncated);
    expect(mirror.alternate).toBe(true);
    expect(mirror.screen().lines[0]).toBe('frame 49');
    mirror.dispose();
  });

  it('gives a mirror made later the screen and recent output; a command open in it lost its start', async () => {
    const tail = new TerminalTail(300);
    tail.append(`user % make\r\n${C}`);
    for (let i = 0; i < 200; i++) tail.append(`step ${i}\r\n`);
    const mirror = new TerminalMirror({ feed: 'stream', cols: 40, rows: 10 });
    await mirror.replay(tail.text(), tail.truncated);
    const region = mirror.regionFromStart();
    await mirror.write(`done\r\n${D(0)}`);
    const out = mirror.regionLines(region);
    expect(out.startLost).toBe(true);
    expect(out.lines.at(-1)).toBe('done');
    expect(out.lines).toContain('step 199');
    expect(region.exitCode).toBe(0);
    mirror.dispose();
  });
});

describe('TerminalMirror with fast output', () => {
  it('skips lines that would scroll out anyway, keeping command boundaries', async () => {
    const mirror = new TerminalMirror({ feed: 'stream', cols: 40, rows: 10, scrollback: 100 });
    const ends: number[] = [];
    mirror.onRegionEnd(r => ends.push(r.exitCode ?? -1));
    const mark = mirror.mark();
    // Written all at once, as a burst arrives faster than it is parsed.
    const writes = [mirror.write(`${C}`)];
    for (let i = 0; i < 40; i++) writes.push(mirror.write('y\r\n'.repeat(10_000)));
    writes.push(mirror.write(`${D(3)}${C}last command\r\n`));
    await Promise.all(writes);
    expect(mirror.skips).toBeGreaterThan(0);
    expect(mirror.skippedLines).toBeGreaterThan(300_000);
    expect(ends).toEqual([3]);
    const open = mirror.currentRegion!;
    expect(mirror.regionLines(open).lines).toEqual(['last command']);
    expect(mirror.linesSince(mark).startLost).toBe(true);
    mirror.dispose();
  });

  it('resolves pending writes when disposed', async () => {
    const mirror = new TerminalMirror({ feed: 'stream' });
    const pending = mirror.write('x\r\n'.repeat(100_000));
    mirror.dispose();
    await expect(pending).resolves.toBeUndefined();
  });
});

describe('terminal names after a label change', () => {
  it('finds the session label a terminal was named after', () => {
    expect(labelPrefix('Claude 2')).toBe('Claude 2');
    expect(labelPrefix('Claude 2: dev server')).toBe('Claude 2');
    expect(labelPrefix('Codex 11 (3)')).toBe('Codex 11');
    expect(labelPrefix('Copilot 1: tests')).toBe('Copilot 1');
    expect(renamedFor('Copilot 2: tests', 'Copilot 2', 'Copilot 1')).toBe('Copilot 1: tests');
    expect(labelPrefix('Claude 2x')).toBeUndefined();
    expect(labelPrefix('zsh')).toBeUndefined();
  });

  it('renames only names still made from the old label', () => {
    expect(renamedFor('Claude 2: dev server', 'Claude 2', 'Claude 3')).toBe('Claude 3: dev server');
    expect(renamedFor('Claude 2 (2)', 'Claude 2', 'Claude 1')).toBe('Claude 1 (2)');
    expect(renamedFor('Claude 2', 'Claude 2', 'Claude 2')).toBeUndefined();
    expect(renamedFor('my server', 'Claude 2', 'Claude 3')).toBeUndefined();
  });
});
