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

/** Runs a command and returns its stdout, or throws with a one-line reason. */
export type Runner = (command: string, args: string[], timeoutMs: number) => Promise<string>;

const defaultRunner: Runner = (command, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(command, args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${(stderr || err.message).trim().split(/\r?\n/)[0]}`));
      else resolve(stdout);
    });
  });

/** `wmic process get ParentProcessId,ProcessId /format:csv` → "Node,ParentProcessId,ProcessId" rows. */
export function parseWmicCsv(text: string): ProcessTable {
  const table: ProcessTable = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = /,(\d+),(\d+)\s*$/.exec(line);
    if (match) table.set(Number(match[2]), Number(match[1]));
  }
  return table;
}

/** Ways to read the Windows process table, tried in order. */
export function windowsMethods(env: NodeJS.ProcessEnv): Array<{ name: string; command: string; args: string[]; parse(text: string): ProcessTable }> {
  // By full path: the agent may start this server with a PATH that lacks System32.
  const root = env.SystemRoot || env.SYSTEMROOT || env.windir || 'C:\\Windows';
  const query = 'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }';
  const psArgs = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', query];
  return [
    { name: 'powershell', command: `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`, args: psArgs, parse: parseProcessTable },
    { name: 'pwsh', command: 'pwsh.exe', args: psArgs, parse: parseProcessTable },
    { name: 'wmic', command: `${root}\\System32\\wbem\\WMIC.exe`, args: ['process', 'get', 'ParentProcessId,ProcessId', '/format:csv'], parse: parseWmicCsv },
  ];
}

export interface AncestorLookup {
  pids: number[];
  /** How the process table was read: "proc", "ps", "powershell", "pwsh", "wmic", or "none". */
  method: string;
  ms: number;
  /** Why the preferred methods failed, when they did. */
  errors: string[];
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
  return (await lookupAncestors({ platform })).pids;
}

/**
 * The ancestors of `pid` and how they were found. On Windows reading the process table means starting
 * PowerShell (most of a second, more on a cold start); when it is missing or blocked by policy,
 * PowerShell 7 and then WMIC are tried. Without any of them the server still finds its window through
 * the terminal variable, the working directory, or because it is the only window.
 */
export async function lookupAncestors(
  options: { platform?: NodeJS.Platform; pid?: number; ppid?: number; env?: NodeJS.ProcessEnv; run?: Runner } = {},
): Promise<AncestorLookup> {
  const platform = options.platform ?? process.platform;
  const self = options.pid ?? process.pid;
  const ppid = options.ppid ?? process.ppid;
  const run = options.run ?? defaultRunner;
  const started = Date.now();
  if (platform === 'linux' && !options.run) {
    // Also inside WSL. Reading /proc costs microseconds per level.
    return { pids: walkAncestors(pid => (pid === self ? ppid : linuxParent(pid)), self), method: 'proc', ms: Date.now() - started, errors: [] };
  }
  const methods =
    platform === 'win32'
      ? windowsMethods(options.env ?? process.env)
      : [{ name: 'ps', command: 'ps', args: ['-A', '-o', 'pid=,ppid='], parse: parseProcessTable }];
  const errors: string[] = [];
  for (const method of methods) {
    try {
      const table = method.parse(await run(method.command, method.args, platform === 'win32' ? 10_000 : 5_000));
      if (table.size === 0) throw new Error('returned no processes');
      return { pids: walkAncestors(pid => (pid === self ? ppid : table.get(pid)), self), method: method.name, ms: Date.now() - started, errors };
    } catch (err) {
      errors.push(`${method.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { pids: ppid > 1 ? [ppid] : [], method: 'none', ms: Date.now() - started, errors };
}
