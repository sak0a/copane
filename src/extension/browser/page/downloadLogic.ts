// Downloads an agent starts in a browser tab: file names, the folder they go to, and how a download
// is described to the agent. Pure; the bookkeeping that needs VS Code is in downloads.ts.
import { basename, extname, isAbsolute, join } from 'node:path';
import { clip, formatBytes } from './ringBuffer';

export type DownloadPhase =
  /** The browser is still receiving it. */
  | 'downloading'
  /** Finished and moved to `path`. */
  | 'saved'
  /** Finished in the staging folder; the user has not said yet whether it may be kept. */
  | 'awaiting-user'
  /** The user said no; the file was deleted. */
  | 'denied'
  /** The setting forbids agent downloads; the file was deleted. */
  | 'blocked'
  /** The browser cancelled it (network error, server closed the connection, cancelled in the browser). */
  | 'failed'
  /** Not captured by the bridge: VS Code asked the user where to save it, so the path is unknown. */
  | 'user-dialog'
  /** A remote window: the browser runs on the user's computer and saved it there. */
  | 'remote'
  /** Finished, but could not be moved out of the staging folder. */
  | 'move-failed';

export interface DownloadEntry {
  /** "dl-3", unique in this window. */
  id: string;
  tabId: string;
  guid: string;
  url: string;
  /** The name the page or server suggested (sanitized). */
  name: string;
  /** The agent session that controlled the tab when it started, if any. */
  sessionId: string | undefined;
  /** PageState sequence number when it started, to match it to an action. */
  seq: number;
  startedAt: number;
  endedAt?: number;
  /** The bridge was saving downloads to its staging folder when this one started. */
  captured: boolean;
  received: number;
  /** Bytes received before the browser gave up (it reports 0 once it cancels). */
  maxReceived: number;
  /** 0 when unknown. */
  total: number;
  phase: DownloadPhase;
  /** Where the finished file is (saved, or still in staging after a failed move). */
  path?: string;
  /** Why it failed, was refused, or could not be moved. */
  reason?: string;
  /** VS Code's remote name ("ssh-remote", "wsl") for phase "remote". */
  remoteName?: string;
}

export const FINAL_PHASES: ReadonlySet<DownloadPhase> = new Set(['saved', 'denied', 'blocked', 'failed', 'move-failed', 'remote', 'user-dialog']);

/** Done from the agent's point of view: nothing will change any more, or nothing the bridge can see. */
export function isFinished(entry: DownloadEntry): boolean {
  if (entry.phase === 'remote' || entry.phase === 'user-dialog') return entry.endedAt !== undefined;
  return FINAL_PHASES.has(entry.phase);
}

const RESERVED = /[<>:"/\\|?*\u0000-\u001f\u007f]/g;
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/** A file name that is safe on every platform: no path, no reserved characters, not empty. */
export function sanitizeFileName(name: string): string {
  let n = basename(String(name).replace(/\\/g, '/')).replace(RESERVED, '_').trim();
  n = n.replace(/^[.\s]+$/, '').replace(/[.\s]+$/, '');
  if (WINDOWS_DEVICE.test(n)) n = `_${n}`;
  if (n.length > 200) {
    const ext = extname(n).slice(0, 20);
    n = n.slice(0, 200 - ext.length) + ext;
  }
  return n || 'download';
}

/** "report.csv", "report (1).csv", "report (2).csv", ... ; ".env" → ".env (1)". */
export function* candidateNames(name: string, limit = 1000): Generator<string> {
  yield name;
  const ext = name.startsWith('.') && name.indexOf('.', 1) < 0 ? '' : extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  for (let i = 1; i <= limit; i++) yield `${stem} (${i})${ext}`;
}

/**
 * The folder agent downloads go to. `setting` is `copane.browser.downloadsFolder`: empty for
 * "<Downloads>/Copane", `~/...` for the home directory, a relative path for the first workspace folder.
 * Returns an error text when a relative path has no workspace folder to resolve against.
 */
export function resolveDownloadsFolder(setting: string, env: { home: string; downloadsDir: string; workspaceFolder: string | undefined }): { folder: string } | { error: string } {
  const value = setting.trim();
  if (!value) return { folder: join(env.downloadsDir, 'Copane') };
  if (value === '~' || value.startsWith('~/') || value.startsWith('~\\')) return { folder: join(env.home, value.slice(1)) };
  if (isAbsolute(value)) return { folder: value };
  if (!env.workspaceFolder) return { error: `the setting copane.browser.downloadsFolder is the relative path "${value}" and this window has no workspace folder to resolve it against` };
  return { folder: join(env.workspaceFolder, value) };
}

/**
 * The user's Downloads folder. On Linux it honours XDG_DOWNLOAD_DIR from `~/.config/user-dirs.dirs`
 * (pass that file's text); elsewhere it is ~/Downloads.
 */
export function systemDownloadsDir(home: string, platform: NodeJS.Platform, userDirs?: string): string {
  if (platform === 'linux' && userDirs) {
    const m = /^\s*XDG_DOWNLOAD_DIR\s*=\s*"([^"]*)"/m.exec(userDirs);
    if (m?.[1]) {
      const dir = m[1].replace(/^\$HOME(?=\/|$)/, home).replace(/\/+$/, '');
      // "$HOME/" is how XDG says the folder is disabled.
      if (isAbsolute(dir) && dir !== home.replace(/\/+$/, '')) return dir;
    }
  }
  return join(home, 'Downloads');
}

function size(entry: DownloadEntry): string {
  const got = Math.max(entry.received, entry.maxReceived);
  return entry.total > 0 ? formatBytes(entry.total) : formatBytes(got);
}

function progress(entry: DownloadEntry): string {
  const got = Math.max(entry.received, entry.maxReceived);
  if (entry.total > 0) return `${Math.floor((got / entry.total) * 100)}% (${formatBytes(got)} of ${formatBytes(entry.total)})`;
  return `${formatBytes(got)} so far`;
}

/** One line for the agent: "dl-2 report.csv: saved to /…/report.csv (2.0 kB)". */
export function describeDownload(entry: DownloadEntry): string {
  const head = `${entry.id} ${clip(entry.name, 120)}`;
  switch (entry.phase) {
    case 'downloading':
      return `${head}: downloading, ${progress(entry)}.`;
    case 'saved':
      return `${head}: saved to ${entry.path} (${size(entry)})${entry.path && basename(entry.path) !== entry.name ? `; renamed because ${entry.name} already existed there` : ''}.`;
    case 'awaiting-user':
      return `${head}: downloaded (${size(entry)}); waiting for the user to allow saving it.`;
    case 'denied':
      return `${head}: not saved, ${entry.reason ?? 'the user did not allow it'}.`;
    case 'blocked':
      return `${head}: not saved, ${entry.reason ?? 'downloads by agents are turned off'}; the user can change the setting copane.browser.agentDownloads.`;
    case 'failed': {
      const got = entry.maxReceived;
      const at = entry.total > 0 ? ` after ${formatBytes(got)} of ${formatBytes(entry.total)}` : got > 0 ? ` after ${formatBytes(got)}` : '';
      return `${head}: failed${at}: ${entry.reason ?? 'the browser cancelled it (network error, the server closed the connection, or it was cancelled)'}.`;
    }
    case 'user-dialog': {
      const state = entry.endedAt === undefined ? `still ${progress(entry)}` : entry.reason ? `failed: ${entry.reason}` : `finished (${size(entry)})`;
      return `${head}: VS Code asked the user where to save it, so its path is unknown to you (${state}). It started outside the moments the bridge saves downloads for you; to capture a download that starts late, call browser_downloads with wait: true right after the action that triggers it.`;
    }
    case 'remote': {
      const state = entry.endedAt === undefined ? `still ${progress(entry)}` : entry.reason ? `failed: ${entry.reason}` : `finished (${size(entry)})`;
      return `${head}: this is a remote window (${entry.remoteName ?? 'remote'}): the browser runs on the user's computer, VS Code asked the user where to save it there, and the file is not reachable from where you run (${state}). Ask the user to copy it into the workspace if you need it.`;
    }
    case 'move-failed':
      return `${head}: downloaded (${size(entry)}) but could not be moved to the downloads folder (${entry.reason}); it is at ${entry.path}.`;
  }
}
