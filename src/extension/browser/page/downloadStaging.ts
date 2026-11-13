// The folder the browser saves agent downloads into before they are kept (see downloads.ts), on the
// machine the browser runs on. In a local window that is this machine. In a remote window (WSL, SSH,
// containers) the browser runs on the user's computer and this extension host on the remote one: the
// browser saves into a private folder on the user's computer (found by services.remote), and finished
// files are copied from there to the remote side through vscode.workspace.fs (scheme vscode-local),
// where the agent can read them.
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { RemoteService } from '../../core/services';
import { moveUnique } from './downloadFiles';
import { candidateNames, systemDownloadsDir } from './downloadLogic';

export interface Staging {
  /** The folder as the browser sees it (a path on the machine it runs on). */
  readonly browserPath: string;
  /** Creates the folder. */
  prepare(): Promise<void>;
  /** Waits up to `waitMs` for the staged file of a download to appear. */
  exists(guid: string, waitMs: number): Promise<boolean>;
  remove(guid: string): Promise<void>;
  /** Moves a staged file into `folder` on this extension host's machine under a free name; returns the path. */
  moveOut(guid: string, folder: string, name: string): Promise<string>;
  /** Files in the staging folder. */
  list(): Promise<Array<{ name: string; mtimeMs: number }>>;
  /** Moves a staged file into the user's own Downloads folder (on their machine); returns the path to show them. */
  moveToUserDownloads(guid: string, name: string): Promise<string>;
  removeAll(): Promise<void>;
}

export class LocalStaging implements Staging {
  readonly browserPath = join(tmpdir(), 'copane-downloads', String(process.pid));

  constructor(private readonly userDownloads: () => string) {}

  async prepare(): Promise<void> {
    await mkdir(this.browserPath, { recursive: true });
  }

  async exists(guid: string, waitMs: number): Promise<boolean> {
    return until(waitMs, async () => {
      await stat(join(this.browserPath, guid));
    });
  }

  async remove(guid: string): Promise<void> {
    await rm(join(this.browserPath, guid), { force: true }).catch(() => undefined);
  }

  moveOut(guid: string, folder: string, name: string): Promise<string> {
    return moveUnique(join(this.browserPath, guid), folder, name);
  }

  async list(): Promise<Array<{ name: string; mtimeMs: number }>> {
    const names = await readdir(this.browserPath).catch(() => [] as string[]);
    const out: Array<{ name: string; mtimeMs: number }> = [];
    for (const name of names) {
      const info = await stat(join(this.browserPath, name)).catch(() => undefined);
      if (info) out.push({ name, mtimeMs: info.mtimeMs });
    }
    return out;
  }

  moveToUserDownloads(guid: string, name: string): Promise<string> {
    return moveUnique(join(this.browserPath, guid), this.userDownloads(), name);
  }

  async removeAll(): Promise<void> {
    await rm(this.browserPath, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Staging on the user's computer, seen from a remote extension host. */
export class UiStaging implements Staging {
  readonly browserPath: string;

  private constructor(
    private readonly folder: vscode.Uri,
    browserPath: string,
    private readonly remote: RemoteService,
  ) {
    this.browserPath = browserPath;
  }

  static async create(remote: RemoteService): Promise<UiStaging | { error: string }> {
    const folder = await remote.uiFolder('download-staging');
    return 'error' in folder ? folder : new UiStaging(folder.uri, folder.nativePath, remote);
  }

  async prepare(): Promise<void> {
    await vscode.workspace.fs.createDirectory(this.folder);
  }

  private file(name: string): vscode.Uri {
    return vscode.Uri.joinPath(this.folder, name);
  }

  exists(guid: string, waitMs: number): Promise<boolean> {
    return until(waitMs, async () => {
      await vscode.workspace.fs.stat(this.file(guid));
    });
  }

  async remove(guid: string): Promise<void> {
    await Promise.resolve(vscode.workspace.fs.delete(this.file(guid))).catch(() => undefined);
  }

  async moveOut(guid: string, folder: string, name: string): Promise<string> {
    await mkdir(folder, { recursive: true });
    for (const candidate of candidateNames(name)) {
      const dest = join(folder, candidate);
      if (await stat(dest).then(() => true, () => false)) continue;
      try {
        // Copied by VS Code from the user's machine to this one; never over an existing file.
        await vscode.workspace.fs.copy(this.file(guid), vscode.Uri.file(dest), { overwrite: false });
      } catch (err) {
        if (err instanceof vscode.FileSystemError && err.code === 'FileExists') continue;
        throw err;
      }
      await this.remove(guid);
      return dest;
    }
    throw new Error(`too many files named like ${name} in ${folder}`);
  }

  async list(): Promise<Array<{ name: string; mtimeMs: number }>> {
    const entries = await Promise.resolve(vscode.workspace.fs.readDirectory(this.folder)).catch(() => [] as [string, vscode.FileType][]);
    const out: Array<{ name: string; mtimeMs: number }> = [];
    for (const [name] of entries) {
      const info = await Promise.resolve(vscode.workspace.fs.stat(this.file(name))).catch(() => undefined);
      if (info) out.push({ name, mtimeMs: info.mtime });
    }
    return out;
  }

  async moveToUserDownloads(guid: string, name: string): Promise<string> {
    const downloads = await this.remote.uiFolder('downloads');
    if ('error' in downloads) throw new Error(downloads.error);
    for (const candidate of candidateNames(name)) {
      try {
        await vscode.workspace.fs.rename(this.file(guid), vscode.Uri.joinPath(downloads.uri, candidate), { overwrite: false });
        return `${downloads.nativePath}${downloads.nativePath.includes('\\') ? '\\' : '/'}${candidate}`;
      } catch (err) {
        if (err instanceof vscode.FileSystemError && err.code === 'FileExists') continue;
        throw err;
      }
    }
    throw new Error(`too many files named like ${name} in ${downloads.nativePath}`);
  }

  async removeAll(): Promise<void> {
    await Promise.resolve(vscode.workspace.fs.delete(this.folder, { recursive: true })).catch(() => undefined);
  }
}

/** The local staging, with the user's Downloads folder of this machine for their own downloads. */
export function localStaging(readUserDirs: () => string | undefined): LocalStaging {
  return new LocalStaging(() => systemDownloadsDir(homedir(), process.platform, readUserDirs()));
}

async function until(waitMs: number, check: () => Promise<void>): Promise<boolean> {
  for (const deadline = Date.now() + waitMs; ; ) {
    try {
      await check();
      return true;
    } catch {
      if (Date.now() >= deadline) return false;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}
