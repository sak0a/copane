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
}

export interface DiscoveryResult {
  instance: InstanceInfo;
  matchedBy: InstanceMatch;
}

/**
 * Order of preference:
 * 1. `AGENT_BRIDGE_INSTANCE`: set in every integrated terminal of a window (a `claude` CLI run there).
 * 2. An ancestor process is a window's extension host (an agent spawned by an extension, such as the
 *    Claude Code extension's chat sessions).
 * 3. The working directory is inside a window's workspace folder (deepest folder wins, then the most
 *    recently focused window).
 * 4. Exactly one window is open.
 */
export function selectInstance(input: DiscoveryInput): DiscoveryResult | undefined {
  const { instances, env, cwd, ancestors } = input;
  if (instances.length === 0) return undefined;

  const fromEnv = env[Env.instance];
  if (fromEnv) {
    const instance = instances.find(i => i.id === fromEnv);
    if (instance) return { instance, matchedBy: 'env' };
  }

  for (const pid of ancestors) {
    const instance = instances.find(i => i.pid === pid);
    if (instance) return { instance, matchedBy: 'ancestor' };
  }

  let best: { instance: InstanceInfo; depth: number } | undefined;
  for (const instance of instances) {
    for (const folder of instance.workspaceFolders) {
      if (!isInside(cwd, folder)) continue;
      const depth = path.resolve(folder).length;
      const better = !best || depth > best.depth || (depth === best.depth && instance.lastFocusedAt > best.instance.lastFocusedAt);
      if (better) best = { instance, depth };
    }
  }
  if (best) return { instance: best.instance, matchedBy: 'cwd' };

  if (instances.length === 1) return { instance: instances[0]!, matchedBy: 'single' };
  return undefined;
}

export function isInside(child: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
