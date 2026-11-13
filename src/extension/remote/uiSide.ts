// The user's machine as seen from a remote extension host (WSL, SSH, containers). Everything here goes
// through `vscode.workspace.fs` with `vscode-local:` URIs, which VS Code routes to the UI side's file
// system: no second extension on the user's machine is needed.
//
// What is not given: the user's home folder there. It is found, in this order, from
//   1. what was found before (global state of this remote),
//   2. argv.json as VS Code itself opened it ("Configure Runtime Arguments", see learnArgvJson),
//   3. in WSL, the Windows paths the distribution inherits (PATH, VSCODE_WSL_EXT_LOCATION),
//   4. the one home folder under C:\Users, /Users or /home that has this VS Code's data folder
//      (`.vscode`, `.vscode-insiders` ...) with an argv.json the user can read.
// A development host never looks for the real home: it uses COPANE_UI_HOME (scripts/remote-dev-host.mjs
// sets it to a throwaway folder), so tests cannot write into the developer's own folders.
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { Logger } from '../core/log';
import type { RemoteService, UiFolder, UiMachine } from '../core/services';
import { argvJsonPath, describeRemote, downloadsFolder, HOME_ROOTS, homeFromArgvJson, localPath, mayBeHome, nativePath, platformOfPath, stagingFolder, wslHomeHints } from './uiPaths';

const HOME_KEY = 'copane.remote.uiHome';
const ARGV_KEY = 'copane.remote.uiArgvJson';

export class UiSide implements RemoteService {
  readonly remoteName = vscode.env.remoteName;
  readonly where: string;
  private found: Promise<UiMachine | { error: string }> | undefined;
  private readonly dataFolderName: string;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: Logger,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    this.where = describeRemote(this.remoteName, env, hostname());
    this.dataFolderName = readDataFolderName();
  }

  private get isDev(): boolean {
    return this.context.extensionMode !== vscode.ExtensionMode.Production;
  }

  uiHome(): Promise<UiMachine | { error: string }> {
    if (!this.found) {
      this.found = this.findHome().then(result => {
        // Not found now does not mean never (an argv.json learned later, a folder created): try again next time.
        if ('error' in result) this.found = undefined;
        else this.log.info(`remote: the user's home on their machine is ${result.home.nativePath} (${result.platform})`);
        return result;
      });
    }
    return this.found;
  }

  async uiFolder(kind: 'download-staging' | 'downloads'): Promise<UiFolder | { error: string }> {
    const machine = await this.uiHome();
    if ('error' in machine) return machine;
    const home = machine.home.uri.path;
    const path = kind === 'downloads' ? downloadsFolder(home) : `${stagingFolder(home, machine.platform)}/${safeName(`${this.remoteName ?? 'local'}-${process.pid}`)}`;
    const folder = this.folder(path);
    try {
      await vscode.workspace.fs.createDirectory(folder.uri);
      return folder;
    } catch (err) {
      return { error: `could not create ${folder.nativePath} on the user's computer: ${message(err)}` };
    }
  }

  async uiArgvJson(): Promise<UiFolder | { error: string }> {
    const learned = this.context.globalState.get<string>(ARGV_KEY);
    if (learned && !this.isDev) return this.folder(learned);
    const machine = await this.uiHome();
    if ('error' in machine) return machine;
    return this.folder(argvJsonPath(machine.home.uri.path, this.dataFolderName));
  }

  learnArgvJson(uri: vscode.Uri): void {
    if (uri.scheme !== 'vscode-local' || this.isDev) return;
    void this.context.globalState.update(ARGV_KEY, uri.path);
    const home = homeFromArgvJson(uri.path, this.dataFolderName);
    if (home) {
      void this.context.globalState.update(HOME_KEY, home);
      this.found = undefined;
    }
  }

  private folder(path: string): UiFolder {
    return { uri: vscode.Uri.from({ scheme: 'vscode-local', path }), nativePath: nativePath(path) };
  }

  private machine(home: string): UiMachine {
    return { platform: platformOfPath(home), home: this.folder(home) };
  }

  private async findHome(): Promise<UiMachine | { error: string }> {
    if (!this.remoteName) return { error: 'this is not a remote window' };
    const override = this.env.COPANE_UI_HOME;
    if (override) {
      const home = localPath(override.replace(/^vscode-local:/, ''));
      return (await this.isDir(home)) ? this.machine(home) : { error: `COPANE_UI_HOME (${override}) is not a folder on the user's computer` };
    }
    if (this.isDev) return { error: "this is an extension development host without COPANE_UI_HOME (scripts/remote-dev-host.mjs sets it), so it does not look for the developer's real home folder" };

    const remembered = this.context.globalState.get<string>(HOME_KEY);
    if (remembered && (await this.isDir(remembered))) return this.machine(remembered);
    for (const home of this.remoteName === 'wsl' ? wslHomeHints(this.env) : []) {
      if (await this.hasDataFolder(home)) return this.remember(home);
    }
    const homes: string[] = [];
    for (const root of HOME_ROOTS) {
      let entries: [string, vscode.FileType][];
      try {
        entries = await vscode.workspace.fs.readDirectory(vscode.Uri.from({ scheme: 'vscode-local', path: root }));
      } catch {
        continue;
      }
      for (const [name, type] of entries) {
        if (!(type & vscode.FileType.Directory) || !mayBeHome(name)) continue;
        const home = `${root}/${name}`;
        if (await this.hasDataFolder(home)) homes.push(home);
      }
      if (homes.length > 0) break;
    }
    if (homes.length === 1) return this.remember(homes[0]!);
    return {
      error:
        homes.length === 0
          ? `could not find the user's home folder on their computer (no folder with ${this.dataFolderName}/argv.json under ${HOME_ROOTS.map(nativePath).join(', ')})`
          : `several home folders on the user's computer have a VS Code data folder (${homes.map(nativePath).join(', ')}), so it is unclear which is theirs; running "Copane: Enable Integrated Browser" once tells it`,
    };
  }

  private remember(home: string): UiMachine {
    void this.context.globalState.update(HOME_KEY, home);
    return this.machine(home);
  }

  private async hasDataFolder(home: string): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.from({ scheme: 'vscode-local', path: argvJsonPath(home, this.dataFolderName) }));
      return true;
    } catch {
      return false;
    }
  }

  private async isDir(path: string): Promise<boolean> {
    try {
      return ((await vscode.workspace.fs.stat(vscode.Uri.from({ scheme: 'vscode-local', path }))).type & vscode.FileType.Directory) !== 0;
    } catch {
      return false;
    }
  }
}

/** The data folder name of this VS Code build (`.vscode`, `.vscode-insiders` ...); the server has the same product.json fields as its client. */
function readDataFolderName(): string {
  try {
    const product = JSON.parse(readFileSync(join(vscode.env.appRoot, 'product.json'), 'utf8'));
    if (typeof product.dataFolderName === 'string' && product.dataFolderName) return product.dataFolderName;
  } catch {
    // Keep the Stable default.
  }
  return '.vscode';
}

function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
