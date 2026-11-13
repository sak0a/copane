// File-system layout shared by the extension and the MCP server. Both must agree on these paths,
// and both run in the same OS (inside WSL for a WSL window), so `os.homedir()` matches.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Env, type InstanceInfo } from './protocol';

/** `~/.vscode-agent-bridge`, or `$AGENT_BRIDGE_HOME` (tests and dev hosts use a private one). */
export function bridgeHome(env: NodeJS.ProcessEnv = process.env): string {
  return env[Env.home] || path.join(os.homedir(), '.vscode-agent-bridge');
}

export function instancesDir(env?: NodeJS.ProcessEnv): string {
  return path.join(bridgeHome(env), 'instances');
}

export function instanceFile(id: string, env?: NodeJS.ProcessEnv): string {
  return path.join(instancesDir(env), `${id}.json`);
}

/**
 * Where a window's bridge listens. Unix sockets live in the bridge home (path length is limited to
 * ~104 bytes on macOS, so keep it short); Windows uses a named pipe.
 */
export function socketPathFor(id: string, env?: NodeJS.ProcessEnv): string {
  if (process.platform === 'win32') return `\\\\.\\pipe\\vscode-agent-bridge-${os.userInfo().username}-${id}`;
  return path.join(bridgeHome(env), 'run', `${id}.sock`);
}

/** Creates a directory only the current user can access. */
export function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(dir, 0o700);
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Reads every instance file whose extension host is still running. Stale files are removed. */
export function readLiveInstances(env?: NodeJS.ProcessEnv): InstanceInfo[] {
  const dir = instancesDir(env);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const live: InstanceInfo[] = [];
  for (const name of names) {
    const file = path.join(dir, name);
    if (name.endsWith('.tmp')) {
      removeIfOlderThan(file, 60_000); // Left behind by a host that crashed mid-write.
      continue;
    }
    if (!name.endsWith('.json')) continue;
    try {
      const info = JSON.parse(fs.readFileSync(file, 'utf8')) as InstanceInfo;
      if (typeof info.pid === 'number' && isProcessAlive(info.pid)) live.push(info);
      else fs.rmSync(file, { force: true });
    } catch {
      // Half-written or unreadable file: skip it, the owner rewrites it.
    }
  }
  return live;
}

function removeIfOlderThan(file: string, ageMs: number): void {
  try {
    if (Date.now() - fs.statSync(file).mtimeMs > ageMs) fs.rmSync(file, { force: true });
  } catch {
    // Already gone.
  }
}
