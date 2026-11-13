import { describe, expect, it } from 'vitest';
import { ancestorPids, lookupAncestors, parseProcessTable, parseWmicCsv, walkAncestors, type Runner } from '../../src/mcp/ancestors';

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

  it('parses WMIC CSV output (columns in alphabetical order: parent first)', () => {
    expect([...parseWmicCsv('\r\nNode,ParentProcessId,ProcessId\r\nPC,1,10\r\nPC,10,20\r\n')]).toEqual([
      [10, 1],
      [20, 10],
    ]);
  });

  describe('on Windows (simulated)', () => {
    const table = '20 10\r\n10 4\r\n4 1\r\n';
    const env = { SystemRoot: 'C:\\WINDOWS' };

    it('uses Windows PowerShell by its full path (the agent\'s PATH may lack System32)', async () => {
      const calls: string[] = [];
      const run: Runner = async command => {
        calls.push(command);
        return table;
      };
      const result = await lookupAncestors({ platform: 'win32', pid: 20, ppid: 10, env, run });
      expect(result).toMatchObject({ pids: [10, 4], method: 'powershell', errors: [] });
      expect(calls).toEqual(['C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe']);
    });

    it('falls back to PowerShell 7, then WMIC, when PowerShell is blocked, and reports why', async () => {
      const run: Runner = async (command, args) => {
        if (command.endsWith('powershell.exe')) throw new Error('This program is blocked by group policy.');
        if (command === 'pwsh.exe') throw new Error('spawn pwsh.exe ENOENT');
        expect(args).toContain('/format:csv');
        return 'Node,ParentProcessId,ProcessId\r\nPC,10,20\r\nPC,4,10\r\n';
      };
      const result = await lookupAncestors({ platform: 'win32', pid: 20, ppid: 10, env, run });
      expect(result.pids).toEqual([10, 4]);
      expect(result.method).toBe('wmic');
      expect(result.errors).toEqual(['powershell: This program is blocked by group policy.', 'pwsh: spawn pwsh.exe ENOENT']);
    });

    it('still knows the direct parent when nothing works', async () => {
      const run: Runner = async () => {
        throw new Error('nope');
      };
      expect(await lookupAncestors({ platform: 'win32', pid: 20, ppid: 10, env, run })).toMatchObject({ pids: [10], method: 'none' });
    });
  });

  it('finds the real parent of this process', async () => {
    const ancestors = await ancestorPids();
    expect(ancestors[0]).toBe(process.ppid);
  }, 30_000); // On Windows this starts PowerShell and queries WMI, which can take seconds on a cold CI runner.
});
