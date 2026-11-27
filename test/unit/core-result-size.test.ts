// What a result may weigh for the client that receives it (core/resultSize.ts), and how the sized
// parts of results are kept within it.
import { describe, expect, it } from 'vitest';
import { blockByteLimit, COPILOT_BLOCK_BYTES, COPILOT_FILE_THRESHOLD_BYTES, fitBytes, utf8Bytes } from '../../src/extension/core/resultSize';
import { clipLines, DEFAULT_MAX_CHARS } from '../../src/extension/terminal/render';
import { textWindow } from '../../src/extension/browser/page/snapshot';

describe('result size for the client', () => {
  it('limits only Copilot, below the size at which it hands its model a file', () => {
    expect(blockByteLimit({ kind: 'copilot' })).toBe(COPILOT_BLOCK_BYTES);
    for (const kind of ['claude-code', 'codex', 'other'] as const) expect(blockByteLimit({ kind })).toBeUndefined();
    expect(COPILOT_BLOCK_BYTES).toBeLessThan(COPILOT_FILE_THRESHOLD_BYTES - 2000);
  });

  it('renders once when there is no limit or the result fits', () => {
    let calls = 0;
    const render = (max: number) => (calls++, 'x'.repeat(max));
    expect(fitBytes(render, s => s, 5000, undefined)).toHaveLength(5000);
    expect(fitBytes(render, s => s, 5000, 6000)).toHaveLength(5000);
    expect(calls).toBe(2);
  });

  it('lowers the character limit until the bytes fit', () => {
    // Three bytes a character: 20,000 characters are 60,000 bytes.
    const sizes: number[] = [];
    const out = fitBytes(max => (sizes.push(max), '漢'.repeat(max)), s => s, 20_000, COPILOT_BLOCK_BYTES);
    expect(utf8Bytes(out)).toBeLessThanOrEqual(COPILOT_BLOCK_BYTES);
    expect(utf8Bytes(out)).toBeGreaterThan(COPILOT_BLOCK_BYTES * 0.9);
    expect(sizes.length).toBeLessThanOrEqual(3);
  });

  it('stops at the smallest size a renderer supports, and when a renderer does not get smaller', () => {
    expect(fitBytes(max => '漢'.repeat(max), s => s, 2000, 100, 1500)).toHaveLength(1500);
    let calls = 0;
    fitBytes(() => (calls++, '漢'.repeat(9000)), s => s, 9000, 100);
    expect(calls).toBeLessThanOrEqual(5);
  });

  it('keeps terminal output and page text within the limit at their own boundaries', () => {
    const lines = Array.from({ length: 3000 }, (_, i) => `${i} 構築しています：依存関係を解決中 — größe `.repeat(3));
    const plain = clipLines(lines, {});
    expect(utf8Bytes(plain.text)).toBeGreaterThan(COPILOT_BLOCK_BYTES);
    const fitted = fitBytes(max => clipLines(lines, { maxChars: max }), c => c.text, DEFAULT_MAX_CHARS, COPILOT_BLOCK_BYTES, 500);
    expect(utf8Bytes(fitted.text)).toBeLessThanOrEqual(COPILOT_BLOCK_BYTES);
    // Still the start and the end, with whole lines and the gap named.
    expect(fitted.text.startsWith(lines[0]!)).toBe(true);
    expect(fitted.text.endsWith(lines.at(-1)!)).toBe(true);
    expect(fitted.gap).toBeDefined();

    const text = Array.from({ length: 2000 }, (_, i) => `段落 ${i}：这是一个用于文档示例的域名。`).join('\n');
    const win = fitBytes(max => textWindow(text, 0, max), w => w.text, 20_000, COPILOT_BLOCK_BYTES);
    expect(utf8Bytes(win.text)).toBeLessThanOrEqual(COPILOT_BLOCK_BYTES);
    expect(win.end).toBeLessThan(win.total);
    // The cut is at a line end, and reading on from `end` continues with the next line.
    expect(win.text.endsWith('。')).toBe(true);
    expect(textWindow(text, win.end, 200).text.startsWith('段落')).toBe(true);
  });
});
