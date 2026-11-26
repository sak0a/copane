// Finds the VS Code window an agent belongs to. Pure functions over the instance list, so the rules
// are unit-testable; the process inspection they need is passed in.
import * as path from 'node:path';
import { Env, type InstanceInfo, type InstanceMatch } from '../shared/protocol';

export interface DiscoveryInput {
  instances: InstanceInfo[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  /**
   * The folder the agent's session works in, when the agent says so and it may differ from `cwd`
   * (Copilot: `COPILOT_SESSION_CWD`). Tried before `cwd` in rules 5 and 6.
   */
  sessionCwd?: string;
  /** Pids of this process's ancestors, nearest first. */
  ancestors: number[];
  /** A window id the agent chose with `window_select`. Wins while that window is open. */
  explicit?: string;
  /** The window this server was connected to before it went away (closed or reloaded). */
  previous?: { id: string; workspaceFolders: string[] };
  /**
   * Resolves symbolic links (`fs.realpathSync`). The working directory of a process is already
   * resolved (`/private/tmp/x` on macOS, and agents such as Codex resolve it too), while VS Code
   * reports workspace folders as opened (`/tmp/x`): both forms are compared.
   */
  realpath?: (p: string) => string;
  /**
   * Reads a text file (`fs.readFileSync(p, 'utf8')`); throws for a missing file or a directory. Used
   * to recognise a git worktree (its `.git` is a file) and find its main checkout. Without it, the
   * worktree rule is skipped.
   */
  readFile?: (p: string) => string;
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
 * 6. The working directory is in a git worktree outside every workspace folder (agents often work in
 *    one) and the same place in the worktree's main checkout is inside a window's workspace folder,
 *    chosen as in 5.
 * 7. Exactly one window is open.
 * Several windows and none of the above: no match. Guessing would put the agent in the wrong project.
 */
export function selectInstance(input: DiscoveryInput): DiscoveryResult | undefined {
  const { instances, env, cwd, ancestors, explicit, previous } = input;
  const real = (p: string) => {
    try {
      return input.realpath ? input.realpath(p) : p;
    } catch {
      return p; // A folder that is gone.
    }
  };
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

  const dirs = input.sessionCwd && input.sessionCwd !== cwd ? [input.sessionCwd, cwd] : [cwd];
  for (const dir of dirs) {
    const byCwd = deepestContaining(instances, dir, real);
    if (byCwd) return { ...byCwd, matchedBy: 'cwd' };
  }

  for (const dir of dirs) {
    const worktree = input.readFile ? worktreeOf(dir, input.readFile) : undefined;
    if (!worktree) continue;
    const mapped = path.join(worktree.mainCheckout, path.relative(worktree.root, dir));
    const byMain = deepestContaining(instances, mapped, real);
    if (byMain) {
      const about = `The worktree's main checkout is ${worktree.mainCheckout}.`;
      return { instance: byMain.instance, matchedBy: 'worktree', note: byMain.note ? `${about} ${byMain.note}` : about };
    }
  }

  if (instances.length === 1) return { instance: instances[0]!, matchedBy: 'single' };
  return undefined;
}

/** The window whose workspace folder most deeply contains `dir` (then the most recently focused one). */
function deepestContaining(instances: InstanceInfo[], dir: string, real: (p: string) => string): { instance: InstanceInfo; note?: string } | undefined {
  const depths = new Map<InstanceInfo, number>();
  for (const instance of instances) {
    for (const folder of instance.workspaceFolders) {
      if (isInside(dir, folder) || isInside(real(dir), real(folder))) depths.set(instance, Math.max(depths.get(instance) ?? 0, path.resolve(real(folder)).length));
    }
  }
  if (depths.size === 0) return undefined;
  const deepest = Math.max(...depths.values());
  const tied = [...depths].filter(([, d]) => d === deepest).map(([i]) => i);
  tied.sort((a, b) => b.lastFocusedAt - a.lastFocusedAt);
  const note = tied.length > 1 ? `${tied.length} windows have this folder open; chose the one focused most recently.` : undefined;
  return { instance: tied[0]!, ...(note ? { note } : {}) };
}

/**
 * The git worktree `dir` is in, and its main checkout: a worktree's `.git` is a file
 * `gitdir: <repo>/.git/worktrees/<name>`, whose `commondir` names the main repository's `.git`
 * directory; its parent is the main checkout. Undefined for a main checkout (`.git` is a directory),
 * a submodule (no `commondir`), a bare repository, no repository, or anything unreadable.
 */
export function worktreeOf(dir: string, readFile: (p: string) => string): { root: string; mainCheckout: string } | undefined {
  let current = path.resolve(dir);
  for (let depth = 0; depth < 64; depth++) {
    let content: string | undefined;
    try {
      content = readFile(path.join(current, '.git'));
    } catch (err) {
      // A `.git` directory: the nearest repository is a main checkout, not a worktree.
      if ((err as NodeJS.ErrnoException)?.code === 'EISDIR') return undefined;
    }
    if (content !== undefined) {
      try {
        const match = /^gitdir:\s*(.+?)\s*$/m.exec(content);
        if (!match) return undefined;
        const gitdir = path.resolve(current, match[1]!);
        const common = readFile(path.join(gitdir, 'commondir')).trim();
        if (!common) return undefined;
        const commonDir = path.resolve(gitdir, common);
        if (path.basename(commonDir) !== '.git') return undefined; // A bare repository has no checkout.
        const mainCheckout = path.dirname(commonDir);
        if (mainCheckout === current) return undefined;
        return { root: current, mainCheckout };
      } catch {
        return undefined;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
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
