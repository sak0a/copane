// Remote windows (WSL, SSH, containers): this extension host runs on the remote machine, VS Code's UI
// and the integrated browser on the user's. This module provides `services.remote`, which finds folders
// on the user's machine and reaches them through vscode.workspace.fs (scheme vscode-local).
import * as vscode from 'vscode';
import type { BridgeServices } from '../core/services';
import { remoteDebugTools } from './debug';
import { UiSide } from './uiSide';

export function activateRemote(services: BridgeServices): void {
  if (vscode.env.remoteName) services.remote = new UiSide(services.context, services.log);
  services.context.subscriptions.push(services.tools.register(remoteDebugTools(services)));
}
