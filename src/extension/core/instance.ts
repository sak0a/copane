// Publishes this window in the instance registry so MCP servers can find it, and removes it on exit.
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { ensurePrivateDir, instanceFile, instancesDir, socketPathFor } from '../../shared/paths';
import { Env, PROTOCOL_VERSION, type InstanceInfo, type WindowDescriptor } from '../../shared/protocol';
import type { Logger } from './log';

export function describeWindow(): WindowDescriptor {
  return {
    instanceId: String(process.pid),
    workspaceName: vscode.workspace.name ?? null,
    workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath),
    remoteName: vscode.env.remoteName ?? null,
    platform: process.platform,
  };
}

export class InstanceRegistration implements vscode.Disposable {
  readonly info: InstanceInfo;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(
    context: vscode.ExtensionContext,
    private readonly log: Logger,
  ) {
    const id = String(process.pid);
    const window = describeWindow();
    this.info = {
      id,
      pid: process.pid,
      socketPath: socketPathFor(id),
      token: crypto.randomBytes(32).toString('hex'),
      protocolVersion: PROTOCOL_VERSION,
      extensionVersion: String(context.extension.packageJSON.version),
      workspaceName: window.workspaceName,
      workspaceFolders: window.workspaceFolders,
      remoteName: window.remoteName,
      appName: vscode.env.appName,
      startedAt: Date.now(),
      lastFocusedAt: vscode.window.state.focused ? Date.now() : 0,
    };
    // Agents started from this window's integrated terminals find the window through this variable.
    context.environmentVariableCollection.replace(Env.instance, id);
    context.environmentVariableCollection.description = 'Lets agents started in this terminal reach this VS Code window.';
  }

  /** Writes the instance file. Call after the bridge server is listening. Throws if it cannot. */
  publish(): void {
    ensurePrivateDir(instancesDir());
    if (!this.write()) throw new Error(`cannot write ${instanceFile(this.info.id)}; agents will not find this window`);
    this.subscriptions.push(
      vscode.window.onDidChangeWindowState(state => {
        if (!state.focused) return;
        this.info.lastFocusedAt = Date.now();
        this.write();
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.info.workspaceFolders = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
        this.info.workspaceName = vscode.workspace.name ?? null;
        this.write();
      }),
    );
  }

  private write(): boolean {
    const file = instanceFile(this.info.id);
    const temp = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify(this.info, null, 2), { mode: 0o600 });
      fs.renameSync(temp, file); // Atomic: readers never see a half-written file.
      return true;
    } catch (err) {
      fs.rmSync(temp, { force: true });
      this.log.error(`could not write the instance file ${file}`, err);
      return false;
    }
  }

  dispose(): void {
    for (const s of this.subscriptions.splice(0)) s.dispose();
    fs.rmSync(instanceFile(this.info.id), { force: true });
  }
}
