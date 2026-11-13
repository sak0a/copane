// Finds the VS Code window an agent belongs to. Pure functions over the instance list, so the rules
// are unit-testable; the process inspection they need is passed in.
import * as path from 'node:path';
import { Env, type InstanceInfo, type InstanceMatch } from '../shared/protocol';

export interface DiscoveryInput {
  instances: InstanceInfo[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Pids of this process's ancestors, nearest first. */
  ancestors: number[];
  /** A window id the agent chose with `window_select`. Wins while that window is open. */
  explicit?: string;
  /** The window this server was connected to before it went away (closed or reloaded). */
  previous?: { id: string; workspaceFolders: string[] };
}

export interface DiscoveryResult {
  instance: InstanceInfo;
  matchedBy: InstanceMatch;
  /** Something the agent should know about the match, e.g. that several windows had the folder open. */
  note?: string;
}

/**
 * Order of preference:
 * 1. A window the agent chose explicitly (`window_select`).
 * 2. An ancestor process is a window's extension host: an agent spawned by an extension, such as a
 *    chat session of the Claude Code extension. Checked before the environment variable because it
 *    is exact, while the variable can be inherited from elsewhere (VS Code started from a terminal
 *    of another VS Code inherits that window's id).
 * 3. `COPANE_INSTANCE`: set in every integrated terminal of a window (a `claude` CLI run there).
 * 4. The window that replaced the one this server was connected to: same workspace folders, i.e. the
 *    window was reloaded (its extension host, and so its id, changes) while the agent kept running.
 * 5. The working directory is inside a window's workspace folder (deepest folder wins, then the most
 *    recently focused window).
 * 6. Exactly one window is open.
 * Several windows and none of the above: no match. Guessing would put the agent in the wrong project.
 */
export function selectInstance(input: DiscoveryInput): DiscoveryResult | undefined {
  const { instances, env, cwd, ancestors, explicit, previous } = input;
  if (instances.length === 0) return undefined;

  if (explicit) {
    const instance = instances.find(i => i.id === explicit);
    if (instance) return { instance, matchedBy: 'explicit' };
  }

  for (const pid of ancestors) {
    const instance = instances.find(i => i.pid === pid);
    if (instance) return { instance, matchedBy: 'ancestor' };
  }

  const fromEnv = env[Env.instance];
  if (fromEnv) {
    const instance = instances.find(i => i.id === fromEnv);
    if (instance) return { instance, matchedBy: 'env' };
  }

  // Only when the previous window is gone: if it is still open, it ended the session itself, and
  // another window with the same folders is not its successor.
  if (previous && previous.workspaceFolders.length > 0 && !instances.some(i => i.id === previous.id)) {
    const same = instances
      .filter(i => i.id !== previous.id && sameFolders(i.workspaceFolders, previous.workspaceFolders))
      .sort((a, b) => b.startedAt - a.startedAt);
    if (same[0]) return { instance: same[0], matchedBy: 'reconnect' };
  }

  // Deepest workspace folder containing the cwd, per window.
  const depths = new Map<InstanceInfo, number>();
  for (const instance of instances) {
    for (const folder of instance.workspaceFolders) {
      if (isInside(cwd, folder)) depths.set(instance, Math.max(depths.get(instance) ?? 0, path.resolve(folder).length));
    }
  }
  if (depths.size > 0) {
    const deepest = Math.max(...depths.values());
    const tied = [...depths].filter(([, d]) => d === deepest).map(([i]) => i);
    tied.sort((a, b) => b.lastFocusedAt - a.lastFocusedAt);
    const note = tied.length > 1 ? `${tied.length} windows have this folder open; chose the one focused most recently.` : undefined;
    return { instance: tied[0]!, matchedBy: 'cwd', ...(note ? { note } : {}) };
  }

  if (instances.length === 1) return { instance: instances[0]!, matchedBy: 'single' };
  return undefined;
}

/** Why `selectInstance` found nothing, in words for the agent. */
export function explainNoMatch(input: Pick<DiscoveryInput, 'instances' | 'cwd' | 'env'>): string {
  const { instances, cwd, env } = input;
  if (instances.length === 0) {
    return 'No VS Code window with the Copane extension is running (none has registered in the bridge home).';
  }
  const stale = env[Env.instance] ? ` COPANE_INSTANCE=${env[Env.instance]} names a window that is no longer open.` : '';
  return `${instances.length} VS Code windows are open, and none contains the working directory ${cwd}.${stale}`;
}

export function sameFolders(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const norm = (list: string[]) => list.map(f => path.resolve(f)).sort();
  const x = norm(a);
  const y = norm(b);
  return x.every((f, i) => f === y[i]);
}

export function isInside(child: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
