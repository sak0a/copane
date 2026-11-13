import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';

/** Pids of the ancestors of `pid`, nearest first. Best effort: returns what it could determine. */
export function ancestorPids(pid: number = process.pid, limit = 12): number[] {
  const result: number[] = [];
  let current = pid;
  for (let i = 0; i < limit; i++) {
    const parent = parentOf(current);
    if (!parent || parent <= 1 || result.includes(parent)) break;
    result.push(parent);
    current = parent;
  }
  return result;
}

function parentOf(pid: number): number | undefined {
  if (pid === process.pid) return process.ppid;
  try {
    if (process.platform === 'linux') {
      // "pid (comm) state ppid ...": comm may contain spaces and parentheses, so split after the last ')'.
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]) || undefined;
    }
    if (process.platform === 'win32') {
      const out = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ParentProcessId`],
        { encoding: 'utf8', timeout: 5000, windowsHide: true },
      );
      return Number(out.trim()) || undefined;
    }
    const out = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8', timeout: 3000 });
    return Number(out.trim()) || undefined;
  } catch {
    return undefined;
  }
}
