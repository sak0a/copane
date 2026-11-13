// The user-facing side of Agent Bridge: the Sessions view (its own activity bar container), the
// status bar item, and the commands to step in (show, pause / resume, release, interrupt, close, end).
// Logic lives in model.ts (pure, unit-tested); this file only wires it to VS Code.
import * as vscode from 'vscode';
import type { BridgeServices } from '../core/services';
import { registerUiCommands } from './commands';
import { registerUiDebugTools } from './debugUi';
import { ContextKey } from './ids';
import { FixtureTerminals, UiSources } from './sources';
import { UiState } from './state';
import { StatusBar } from './statusBar';
import { SessionsTree } from './tree';

/** Status bar, the sessions view, user commands. */
export function activateUi(services: BridgeServices): void {
  const { context, log } = services;
  const development = context.extensionMode === vscode.ExtensionMode.Development;
  const fixtures = development ? new FixtureTerminals() : undefined;
  const sources = new UiSources(services, log, fixtures);
  const state = new UiState(services, sources);
  const tree = new SessionsTree(state);
  const statusBar = new StatusBar(state);

  void vscode.commands.executeCommand('setContext', ContextKey.browserUnavailable, !sources.browserAvailable);
  context.subscriptions.push(state, tree, statusBar, ...registerUiCommands(services, state, tree));
  if (fixtures) context.subscriptions.push(fixtures, registerUiDebugTools(services, state, statusBar, tree, fixtures));
}
