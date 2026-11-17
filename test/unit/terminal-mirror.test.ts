import { describe, expect, it } from 'vitest';
import { sameCommand, TerminalMirror } from '../../src/extension/terminal/mirror';

const C = '\x1b]633;C\x07';
const D = (code?: number) => `\x1b]633;D${code === undefined ? '' : `;${code}`}\x07`;
const A = '\x1b]633;A\x07';

describe('TerminalMirror (stream feed)', () => {
  it('returns the rendered output of a command between OSC 633 C and D', async () => {
    const m = new TerminalMirror({ feed: 'stream', cols: 40, rows: 10 });
    const regions: number[] = [];
    m.onRegionEnd(r => regions.push(r.exitCode ?? -1));
    await m.write(`${A}user@host % ls\r\n${C}`);
    const region = m.currentRegion!;
    await m.write('\x1b[1;32mgreen\x1b[0m file\r\nDownloading 10%\rDownloading 55%\rDownloading 100%\r\nline with spaces   \r\n');
    expect(m.regionLines(region).lines).toEqual(['green file', 'Downloading 100%', 'line with spaces']);
    await m.write(`${D(3)}${A}user@host % `);
    expect(regions).toEqual([3]);
    expect(region.ended).toBe(true);
    // The prompt after the command is not part of its output.
    expect(m.regionLines(region).lines).toEqual(['green file', 'Downloading 100%', 'line with spaces']);
  });

  it('interprets cursor movement such as multi-line progress redraws', async () => {
    const m = new TerminalMirror({ feed: 'stream', cols: 40, rows: 10 });
    await m.write(`$ build\r\n${C}`);
    const region = m.currentRegion!;
    await m.write('task a: 0%\r\ntask b: 0%\r\n');
    await m.write('\x1b[2A\x1b[2Ktask a: done\r\n\x1b[2Ktask b: done\r\n');
    await m.write(D(0));
    expect(m.regionLines(region).lines).toEqual(['task a: done', 'task b: done']);
  });

  it('joins soft-wrapped rows back into one line', async () => {
    const m = new TerminalMirror({ feed: 'stream', cols: 20, rows: 5 });
    await m.write(`$ x\r\n${C}${'a'.repeat(50)}\r\nshort\r\n${D(0)}`);
    const lines = m.regionLines(m.currentRegion!).lines;
    expect(lines).toEqual(['a'.repeat(50), 'short']);
  });

  it('keeps output without a trailing newline but not what the prompt prints after D', async () => {
    const m = new TerminalMirror({ feed: 'stream', cols: 30, rows: 5 });
    await m.write(`$ printf hi\r\n${C}hi${D(0)}%          \r\n$ `);
    expect(m.regionLines(m.currentRegion!).lines).toEqual(['hi']);
  });

  it('reads only what is new since a mark, re-reading a line that is being redrawn', async () => {
    const m = new TerminalMirror({ feed: 'stream', cols: 40, rows: 10 });
    await m.write('one\r\nprogress 1%');
    const mark = m.mark();
    await m.write('\rprogress 99%\r\ntwo\r\n');
    expect(m.linesSince(mark).lines).toEqual(['progress 99%', 'two']);
  });

  it('shows the screen of a full-screen program and knows it is on the alternate screen', async () => {
    const m = new TerminalMirror({ feed: 'stream', cols: 30, rows: 6 });
    await m.write('$ less file\r\n');
    await m.write('\x1b[?1049h\x1b[H\x1b[2Jline 1\r\nline 2\r\n\x1b[6;1H:');
    const screen = m.screen();
    expect(screen.alternate).toBe(true);
    expect(screen.lines[0]).toBe('line 1');
    expect(screen.lines.at(-1)).toBe(':');
    expect(screen.cursor).toEqual({ row: 5, col: 1 });
    await m.write('\x1b[?1049l');
    expect(m.alternate).toBe(false);
  });

  it('a mark taken on the alternate screen never re-reads earlier normal-screen output', async () => {
    const m = new TerminalMirror({ feed: 'stream', cols: 30, rows: 6 });
    for (let i = 1; i <= 20; i++) await m.write(`old ${i}\r\n`);
    await m.write('$ less file\r\n');
    const before = m.mark();
    await m.write('\x1b[?1049h\x1b[H\x1b[2Jpage 1\r\n');
    const onAlt = m.mark();
    expect(onAlt.alternate).toBe(true);
    expect(onAlt.marker).toBeUndefined();
    // Nothing new on the normal screen while the program shows; its screen is screen().
    expect(m.linesSince(onAlt)).toEqual({ lines: [], startLost: false });
    expect(m.linesSince(before).lines).toEqual([]);
    await m.write('\x1b[H\x1b[2Jpage 2\r\n');
    const again = m.mark();
    expect(m.linesSince(onAlt).lines).toEqual([]);
    // The program quits; the shell prints after it. Only that is new.
    await m.write('\x1b[?1049lbye\r\n$ ');
    expect(m.alternate).toBe(false);
    expect(onAlt.marker).toBeDefined();
    expect(m.linesSince(onAlt).lines).toEqual(['bye', '$']);
    expect(m.linesSince(again).lines).toEqual(['bye', '$']);
    expect(m.linesSince(before).lines).toEqual(['bye', '$']);
    // The marker follows the buffer from now on, like any other.
    await m.write('\r\nmore\r\n');
    expect(m.linesSince(onAlt).lines).toEqual(['bye', '$', 'more']);
  });

  it('a mark on the alternate screen keeps unread lines printed before the program started', async () => {
    const m = new TerminalMirror({ feed: 'stream', cols: 30, rows: 6 });
    await m.write('seen\r\n');
    const mark = m.mark();
    await m.write('unread\r\n\x1b[?1049h\x1b[H\x1b[2Jscreen\r\n');
    expect(m.linesSince(mark).lines).toEqual(['unread']);
    const exact = m.mark({ exact: true });
    await m.write('\x1b[?1049l');
    expect(m.linesSince(exact).lines).toEqual([]);
  });

  it('tracks application cursor key mode', async () => {
    const m = new TerminalMirror({ feed: 'stream' });
    expect(m.applicationCursorKeys).toBe(false);
    await m.write('\x1b[?1h');
    expect(m.applicationCursorKeys).toBe(true);
  });

  it('reports a lost start when output scrolled out of the scrollback', async () => {
    const m = new TerminalMirror({ feed: 'stream', cols: 20, rows: 5, scrollback: 10 });
    await m.write(`$ seq\r\n${C}`);
    const region = m.currentRegion!;
    for (let i = 1; i <= 50; i++) await m.write(`${i}\r\n`);
    await m.write(D(0));
    const { lines, startLost } = m.regionLines(region);
    expect(startLost).toBe(true);
    expect(lines.at(-1)).toBe('50');
  });

  it('ignores the private framing sequence in stream mode', async () => {
    const m = new TerminalMirror({ feed: 'stream' });
    await m.write('\x1b]7771;C\x07');
    expect(m.currentRegion).toBeUndefined();
  });

  it('splits the cursor line at the cursor', async () => {
    const m = new TerminalMirror({ feed: 'stream', cols: 40 });
    await m.write('Password: ');
    expect(m.cursorLine()).toEqual({ beforeCursor: 'Password: ', afterCursor: '' });
  });
});

describe('TerminalMirror (executions feed)', () => {
  it('frames each command with beginRegion/endRegion and ignores OSC 633 inside the data', async () => {
    const m = new TerminalMirror({ feed: 'executions', cols: 40, rows: 10 });
    const first = (await m.beginRegion())!;
    await m.write(`${C}first output`);
    await m.endRegion(0);
    const second = (await m.beginRegion())!;
    await m.write('second\r\noutput\r\n');
    expect(m.regionLines(second).lines).toEqual(['second', 'output']);
    await m.endRegion(1);
    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(1);
    expect(m.regionLines(first).lines).toEqual(['first output']);
  });
});

describe('sameCommand (which execution a region of output belongs to)', () => {
  it('matches the whole line, or an unknown one', () => {
    expect(sameCommand('echo hi', 'echo hi')).toBe(true);
    expect(sameCommand('  echo hi ', 'echo hi')).toBe(true);
    expect(sameCommand('echo hi', undefined)).toBe(true);
    expect(sameCommand('echo hi', 'echo ho')).toBe(false);
  });

  it("matches bash's report of one simple command of a compound line", () => {
    expect(sameCommand("echo hello; printf '\\033[31mred\\033[0m\\n'; false", 'echo hello')).toBe(true);
    expect(sameCommand('make && make test', 'make')).toBe(true);
    expect(sameCommand('ls | wc -l', 'ls')).toBe(true);
    expect(sameCommand('false || echo fallback', 'echo fallback')).toBe(true);
    expect(sameCommand('(cd sub && npm test)', 'cd sub')).toBe(true);
    expect(sameCommand('echo a\necho b', 'echo b')).toBe(true);
  });

  it('does not match a different command that merely starts the same', () => {
    expect(sameCommand('ls -la', 'ls')).toBe(false);
    expect(sameCommand('npm test', 'npm')).toBe(false);
    expect(sameCommand('echo hello; true', 'hello')).toBe(false);
    expect(sameCommand('echo hi', '')).toBe(false);
  });
});
