// Paths on the user's machine as seen from a remote extension host. VS Code addresses that machine's
// files as `vscode-local:` URIs whose path is the UI side's `file` URI path: `/Users/me/x` on macOS,
// `/home/me/x` on Linux, `/c:/Users/me/x` on Windows. Pure, so it is unit-tested.

export type UiPlatform = 'win32' | 'darwin' | 'linux';

const DRIVE = /^\/([a-zA-Z]):(\/|$)/;

/** The platform a UI-side path belongs to. */
export function platformOfPath(localPath: string): UiPlatform {
  if (DRIVE.test(localPath)) return 'win32';
  return localPath.startsWith('/Users/') ? 'darwin' : 'linux';
}

/** `/c:/Users/me` → `C:\Users\me`; POSIX paths stay as they are. */
export function nativePath(localPath: string): string {
  const m = DRIVE.exec(localPath);
  if (!m) return localPath;
  const rest = localPath.slice(m[0].length).replace(/\/+$/, '').replace(/\//g, '\\');
  return `${m[1]!.toUpperCase()}:\\${rest}`;
}

/** `C:\Users\me` → `/C:/Users/me`; POSIX paths stay as they are. */
export function localPath(native: string): string {
  return /^[a-zA-Z]:[\\/]/.test(native) ? `/${native.replace(/\\/g, '/')}` : native;
}

/** Joins path segments of a UI-side path. */
export function joinLocal(base: string, ...parts: string[]): string {
  return [base.replace(/\/+$/, ''), ...parts.map(p => p.replace(/^\/+|\/+$/g, ''))].filter(Boolean).join('/');
}

/** Folders in a Users or home directory that are not a person's home. */
const NOT_A_HOME = new Set(['public', 'default', 'default user', 'all users', 'shared', 'guest', '.localized', 'desktop.ini', 'lost+found']);

export function mayBeHome(name: string): boolean {
  return !NOT_A_HOME.has(name.toLowerCase()) && !name.startsWith('.');
}

/** Where people's home folders are, in the order to look: Windows, macOS, Linux. */
export const HOME_ROOTS = ['/c:/Users', '/Users', '/home'];

/**
 * In WSL the Windows user's home shows through Windows paths the distribution inherits: the WSL
 * extension's folder (VSCODE_WSL_EXT_LOCATION) and PATH entries such as
 * /mnt/c/Users/me/AppData/Local/Programs/Microsoft VS Code/bin. Returns candidate homes, most likely first.
 */
export function wslHomeHints(env: NodeJS.ProcessEnv): string[] {
  const sources = [env.VSCODE_WSL_EXT_LOCATION ?? '', ...(env.PATH ?? '').split(':')];
  const out: string[] = [];
  for (const s of sources) {
    const m = /^\/(?:mnt\/)?([a-zA-Z])\/Users\/([^/]+)(?:\/|$)/.exec(s);
    if (!m || !mayBeHome(m[2]!)) continue;
    const home = `/${m[1]!.toLowerCase()}:/Users/${m[2]}`;
    if (!out.includes(home)) out.push(home);
  }
  return out;
}

/**
 * A private per-user folder on the user's machine for files in transit (the browser saves downloads
 * there before they are copied to the remote side): the user's temp or cache folder, never shared ones.
 */
export function stagingFolder(home: string, platform: UiPlatform): string {
  if (platform === 'win32') return joinLocal(home, 'AppData/Local/Temp/copane-downloads');
  if (platform === 'darwin') return joinLocal(home, 'Library/Caches/Copane/downloads');
  return joinLocal(home, '.cache/copane/downloads');
}

export function downloadsFolder(home: string): string {
  return joinLocal(home, 'Downloads');
}

/** The argv.json of a (non-portable) VS Code install: `<home>/<data folder>/argv.json`. */
export function argvJsonPath(home: string, dataFolderName: string): string {
  return joinLocal(home, dataFolderName, 'argv.json');
}

/** The home folder an argv.json path implies, when it is `<home>/<data folder>/argv.json`. */
export function homeFromArgvJson(argvPath: string, dataFolderName: string): string | undefined {
  const suffix = `/${dataFolderName}/argv.json`;
  return argvPath.toLowerCase().endsWith(suffix.toLowerCase()) && argvPath.length > suffix.length ? argvPath.slice(0, -suffix.length) : undefined;
}

/** Where the remote side is, for messages: "WSL (Ubuntu)", "the SSH host build-1", "the container". */
export function describeRemote(remoteName: string | undefined, env: NodeJS.ProcessEnv, hostname: string): string {
  switch (remoteName) {
    case undefined:
      return 'this computer';
    case 'wsl':
      return env.WSL_DISTRO_NAME ? `WSL (${env.WSL_DISTRO_NAME})` : 'WSL';
    case 'ssh-remote':
      return `the SSH host ${hostname}`;
    case 'dev-container':
    case 'attached-container':
    case 'k8s-container':
      return 'the container';
    case 'codespaces':
      return 'the codespace';
    case 'tunnel':
      return `the tunnel host ${hostname}`;
    default:
      return `the remote machine (${remoteName})`;
  }
}
