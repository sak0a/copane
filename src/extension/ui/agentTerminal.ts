// Finds the integrated terminal an agent itself runs in (`claude` started in a terminal of this
// window), so "show session" can bring up the conversation rather than just a row about it. The
// session's pid is its MCP server, a child of the agent; the terminal whose shell is an ancestor of
// that process is the one. Agents in an editor or side-bar chat have no such terminal.
import { execFile } from 'node:child_process';
import * as vscode from 'vscode';
import { parseProcessTable, walkAncestors } from '../../mcp/ancestors';

function processTable(): Promise<Map<number, number>> {
  const [command, args] =
    process.platform === 'win32'
      ? [
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }'],
        ]
      : ['ps', ['-A', '-o', 'pid=,ppid=']];
  return new Promise(resolve =>
    execFile(command, args as string[], { encoding: 'utf8', timeout: 10_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) =>
      resolve(err ? new Map() : parseProcessTable(stdout)),
    ),
  );
}

function within<T>(promise: Thenable<T>, ms: number): Promise<T | undefined> {
  return Promise.race([Promise.resolve(promise).catch(() => undefined), new Promise<undefined>(r => setTimeout(() => r(undefined), ms))]);
}

/** The terminal of this window whose shell (directly or not) started the process `pid`, if any. */
export async function findTerminalRunning(pid: number | undefined): Promise<vscode.Terminal | undefined> {
  if (!pid) return undefined;
  const terminals = vscode.window.terminals;
  if (!terminals.length) return undefined;
  const [table, shells] = await Promise.all([processTable(), Promise.all(terminals.map(t => within(t.processId, 2000)))]);
  const ancestors = new Set(walkAncestors(p => table.get(p), pid, 32));
  const index = shells.findIndex(shell => shell !== undefined && ancestors.has(shell));
  return index >= 0 ? terminals[index] : undefined;
}
