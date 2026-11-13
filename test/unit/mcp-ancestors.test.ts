import { describe, expect, it } from 'vitest';
import { ancestorPids, parseProcessTable, walkAncestors } from '../../src/mcp/ancestors';

describe('process ancestry', () => {
  it('parses ps and PowerShell output', () => {
    const table = parseProcessTable('  10   1\r\n 20 10\nnoise\n30 20\n');
    expect([...table]).toEqual([
      [10, 1],
      [20, 10],
      [30, 20],
    ]);
  });

  it('walks to the root and stops at cycles and the limit', () => {
    const table = parseProcessTable('30 20\n20 10\n10 1');
    expect(walkAncestors(p => table.get(p), 30)).toEqual([20, 10]);
    const cycle = new Map([
      [3, 2],
      [2, 3],
    ]);
    expect(walkAncestors(p => cycle.get(p), 3)).toEqual([2]);
    const long = (p: number) => p + 1;
    expect(walkAncestors(long, 2, 5)).toEqual([3, 4, 5, 6, 7]);
  });

  it('finds the real parent of this process', async () => {
    const ancestors = await ancestorPids();
    expect(ancestors[0]).toBe(process.ppid);
  });
});
