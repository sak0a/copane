// Development-only tools for the UI (registered only when the extension runs from source, like
// core/debugTools.ts): read what the Sessions view and status bar show, and inject fixture terminals
// so states the terminal service cannot produce yet (running, waiting for the user ...) can be seen.
import * as vscode from 'vscode';
import { z } from 'zod';
import type { BridgeServices, TerminalInfo } from '../core/services';
import { defineTool, json } from '../core/tools';
import { treeAsText } from './model';
import type { TabsPanel } from './panel';
import { panelAsText } from './panelModel';
import type { FixtureTerminals } from './sources';
import type { UiState } from './state';
import type { StatusBar } from './statusBar';
import type { TabGrouping } from './tabGrouping';
import type { SessionsTree } from './tree';

export function registerUiDebugTools(services: BridgeServices, state: UiState, statusBar: StatusBar, tree: SessionsTree, panel: TabsPanel, fixtures: FixtureTerminals, grouping: TabGrouping): vscode.Disposable {
  return services.tools.register([
    defineTool({
      name: 'debug_ui_state',
      description:
        'Development only. Shows what the Copane UI currently renders: the Sessions tree as text, every row (id, label, description, icon, contextValue), the status bar item, the view badge, the attention list, and the Agent Tabs panel view (`panel`: text, rows, description, visible). `activeTerminal` is the active terminal (name, shell pid); `sessionsSelection` the selected Sessions rows; `favicons` the site icon of each listed tab (key, or why it is refused); `tabGroups` the collapsed sessions, the tabs Copane pinned and each tab as the tab grouping sees it (owner, pinned, group, index). Reflects the last coalesced update, so poll for changes.',
      input: {},
      annotations: { readOnlyHint: true },
      handler: async () => {
        const model = state.model;
        const terminal = vscode.window.activeTerminal;
        const terminalPid = terminal ? await Promise.race([Promise.resolve(terminal.processId), new Promise<undefined>(r => setTimeout(() => r(undefined), 1000))]) : undefined;
        return [
          json({
            tree: treeAsText(model),
            rows: [...model.nodes.values()].map(n => ({ id: n.id, kind: n.kind, label: n.label, description: n.description ?? null, icon: n.icon, contextValue: n.contextValue })),
            status: { ...model.status, shown: statusBar.snapshot() },
            badge: model.badge ?? null,
            viewBadge: tree.view.badge ?? null,
            viewDescription: model.viewDescription ?? null,
            viewVisible: tree.view.visible,
            attention: model.attention,
            panel: {
              text: panelAsText(state.panel),
              rows: state.panel.roots.map(n => ({ id: n.id, label: n.label, description: n.description ?? null, icon: n.icon, contextValue: n.contextValue, ref: n.ref })),
              description: panel.view.description ?? null,
              badge: panel.view.badge ?? null,
              visible: panel.view.visible,
            },
            activeTerminal: terminal ? { name: terminal.name, pid: terminalPid ?? null } : null,
            sessionsViewVisible: tree.view.visible,
            sessionsSelection: tree.view.selection.map(h => h.id),
            favicons: state.iconStates(),
            tabGroups: grouping.debugState(),
          }),
        ];
      },
    }),
    defineTool({
      name: 'debug_ui_fixtures',
      description:
        'Development only. Replaces the fixture terminals shown in the Copane Sessions view (merged with the real ones). `ownedBy` and `allowedSessions` take session ids (the session key). The UI commands interrupt / close act on fixtures too.',
      input: {
        terminals: z
          .array(
            z.object({
              id: z.string().describe('e.g. "fx-1"'),
              name: z.string(),
              origin: z.enum(['agent', 'user']).optional(),
              ownedBy: z.string().optional(),
              state: z.enum(['starting', 'idle', 'running', 'waiting-for-user', 'closed']),
              currentCommand: z.string().optional(),
              lastExitCode: z.number().optional(),
              userInputRequest: z.string().optional(),
              allowedSessions: z.array(z.string()).optional(),
              shellIntegration: z.boolean().optional(),
              cwd: z.string().optional(),
            }),
          )
          .describe('The complete fixture list; [] removes all.'),
      },
      handler: args => {
        const list: TerminalInfo[] = args.terminals.map(t => ({
          id: t.id,
          name: t.name,
          origin: t.origin ?? 'agent',
          ownedBy: t.ownedBy,
          state: t.state,
          shellIntegration: t.shellIntegration ?? true,
          cwd: t.cwd,
          currentCommand: t.currentCommand,
          lastExitCode: t.lastExitCode,
          userInputRequest: t.userInputRequest,
          allowedSessions: t.allowedSessions,
        }));
        fixtures.set(list);
        return `${list.length} fixture terminal(s) set.`;
      },
    }),
  ]);
}
