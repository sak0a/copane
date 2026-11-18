// The user-facing side of Copane: the Sessions view (its own activity bar container), the
// Agent Tabs view (its own container in the bottom panel), the status bar item, the commands to step in (show, pause / resume, release, interrupt, close, end),
// and collapsing a session's browser tabs in the editor tab bar (tabGrouping.ts).
// Logic lives in model.ts (pure, unit-tested); this file only wires it to VS Code.
import * as vscode from 'vscode';
import type { BridgeServices } from '../core/services';
import { registerUiCommands } from './commands';
import { registerUiDebugTools } from './debugUi';
import { ContextKey } from './ids';
import { TabsPanel } from './panel';
import { FixtureTerminals, UiSources } from './sources';
import { UiState } from './state';
import { StatusBar } from './statusBar';
import { TabGrouping } from './tabGrouping';
import { SessionsTree } from './tree';

/** Status bar, the Sessions view, the Agent Tabs panel view, user commands. */
export function activateUi(services: BridgeServices): void {
  const { context, log } = services;
  const development = context.extensionMode === vscode.ExtensionMode.Development;
  const fixtures = development ? new FixtureTerminals() : undefined;
  const sources = new UiSources(services, log, fixtures);
  const state = new UiState(services, sources);
  const tree = new SessionsTree(state);
  const panel = new TabsPanel(state);
  const statusBar = new StatusBar(state);
  const grouping = new TabGrouping(services, sources);
  state.setCollapsedSessions(() => grouping.collapsedSessions());
  grouping.onDidChange(() => state.refresh());

  void vscode.commands.executeCommand('setContext', ContextKey.browserUnavailable, !sources.browserAvailable);
  context.subscriptions.push(state, tree, panel, statusBar, grouping, ...registerUiCommands(services, state, tree, grouping));
  if (fixtures) context.subscriptions.push(fixtures, registerUiDebugTools(services, state, statusBar, tree, panel, fixtures, grouping));
}
