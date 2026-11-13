// File helpers for editing other programs' configuration files safely: atomic replacement that keeps
// the file's mode, and a lock that is compatible with the one Claude Code uses for its config file.
import * as fs from 'node:fs';
import * as path from 'node:path';

export function readTextIfExists(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

/**
 * Replaces `file` with `text` atomically (write a temporary file next to it, then rename), so a reader
 * never sees a half-written file. Keeps the mode of an existing file; new files get `mode`.
 * Follows a symlinked file and replaces its target, so a dotfile managed by a symlink stays one.
 */
export function writeFileAtomic(file: string, text: string, mode = 0o600): void {
  let target = file;
  try {
    target = fs.realpathSync(file);
  } catch {
    // Does not exist yet.
  }
  let keepMode = mode;
  try {
    keepMode = fs.statSync(target).mode & 0o777;
  } catch {
    fs.mkdirSync(path.dirname(target), { recursive: true });
  }
  const temp = `${target}.agent-bridge-${process.pid}-${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temp, text, { mode: keepMode });
    if (process.platform !== 'win32') fs.chmodSync(temp, keepMode);
    fs.renameSync(temp, target);
  } catch (err) {
    fs.rmSync(temp, { force: true });
    throw err;
  }
}

export interface LockOptions {
  /** A lock older than this is considered abandoned (proper-lockfile's default is 10 s). */
  staleMs?: number;
  /** Give up after this long. */
  timeoutMs?: number;
}

/**
 * Runs `fn` while holding `<file>.lock`, a directory created atomically with mkdir. This is the
 * protocol of the `proper-lockfile` package, which Claude Code uses for `~/.claude.json`
 * (`lockfilePath: <config>.lock`), so a Claude Code process saving its config at the same moment waits
 * for us instead of overwriting our change with its stale copy.
 */
export async function withFileLock<T>(file: string, fn: () => T | Promise<T>, options: LockOptions = {}): Promise<T> {
  const lock = `${file}.lock`;
  const staleMs = options.staleMs ?? 10_000;
  const deadline = Date.now() + (options.timeoutMs ?? 15_000);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let delay = 25; ; delay = Math.min(delay * 2, 500)) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > staleMs) {
          fs.rmSync(lock, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue; // Released between mkdir and stat.
      }
      if (Date.now() > deadline) throw new Error(`${file} is locked by another program (${lock}); try again in a moment`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  // Keep the lock fresh while we hold it, as proper-lockfile does, so nobody considers it stale.
  const refresh = setInterval(() => {
    const now = new Date();
    try {
      fs.utimesSync(lock, now, now);
    } catch {
      // Lost; nothing sensible to do mid-write.
    }
  }, Math.max(1000, staleMs / 2));
  refresh.unref?.();
  try {
    return await fn();
  } finally {
    clearInterval(refresh);
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

/** A short, home-relative form of a path for messages: `~/.claude.json`. */
export function tildify(file: string, home: string): string {
  if (!home) return file;
  const rel = path.relative(home, file);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? `~${path.sep}${rel}` : file;
}
