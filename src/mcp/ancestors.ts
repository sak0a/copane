// Process ancestry of the MCP server, used to find the extension host that (indirectly) spawned it.
// One snapshot of the process table per lookup, not one process spawn per ancestor: on Windows each
// PowerShell start costs most of a second, so walking twelve levels one call at a time took seconds.
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';

/** pid → parent pid. */
export type ProcessTable = Map<number, number>;

/** Parses "pid ppid" lines (the output of `ps -A -o pid=,ppid=` or the PowerShell query below). */
export function parseProcessTable(text: string): ProcessTable {
  const table: ProcessTable = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (match) table.set(Number(match[1]), Number(match[2]));
  }
  return table;
}

/** Ancestors of `pid` in `table`, nearest first, stopping at pid 0/1, a cycle or `limit`. */
export function walkAncestors(parentOf: (pid: number) => number | undefined, pid: number, limit = 16): number[] {
  const result: number[] = [];
  let current = pid;
  for (let i = 0; i < limit; i++) {
    const parent = parentOf(current);
    if (!parent || parent <= 1 || parent === pid || result.includes(parent)) break;
    result.push(parent);
    current = parent;
  }
  return result;
}

function run(command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise(resolve => {
    execFile(command, args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) =>
      resolve(err ? '' : stdout),
    );
  });
}

function linuxParent(pid: number): number | undefined {
  try {
    // "pid (comm) state ppid ...": comm may contain spaces and parentheses, so split after the last ')'.
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]) || undefined;
  } catch {
    return undefined;
  }
}

/** Pids of the ancestors of this process, nearest first. Best effort: returns what it could determine. */
export async function ancestorPids(platform: NodeJS.Platform = process.platform): Promise<number[]> {
  const self = process.pid;
  if (platform === 'linux') {
    // Also inside WSL. Reading /proc costs microseconds per level.
    return walkAncestors(pid => (pid === self ? process.ppid : linuxParent(pid)), self);
  }
  let table: ProcessTable;
  if (platform === 'win32') {
    const query = 'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }';
    table = parseProcessTable(await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', query], 10_000));
  } else {
    table = parseProcessTable(await run('ps', ['-A', '-o', 'pid=,ppid='], 5_000));
  }
  return walkAncestors(pid => (pid === self ? process.ppid : table.get(pid)), self);
}
