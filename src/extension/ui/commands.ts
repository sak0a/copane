// User commands of the Sessions view. Each takes its target from a tree row, from an id (string, as
// `debug_vscode_command` passes it), or asks with a quick pick when run from the Command Palette.
import * as vscode from 'vscode';
import type { BridgeServices, BrowserTabInfo, TerminalInfo } from '../core/services';
import type { AgentSession } from '../core/sessions';
import { Cmd } from './ids';
import { hostOf, plural, tabTitle, tabBelongsTo, tabState, terminalBelongsTo, type AttentionItem, type ViewNode } from './model';
import type { UiState } from './state';
import type { SessionsTree } from './tree';

type Ref = ViewNode['ref'];

class TargetGone extends Error {
  constructor() {
    super('That tab, terminal or session is gone.');
  }
}

const AGENT_APPS: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex' };

export function registerUiCommands(services: BridgeServices, state: UiState, tree: SessionsTree): vscode.Disposable[] {
  const { sessions } = services;
  const sources = state.sources;
  const tabs = () => sources.tabs();
  const terminals = () => sources.terminals();
  const sessionLabel = (id: string | undefined) => (id ? (sessions.get(id)?.label ?? 'an ended session') : undefined);

  /**
   * Resolves a command argument: a tree row handle or a tab / terminal / session id. Undefined when
   * there is no argument (Command Palette: ask with a quick pick). Throws TargetGone when the row or
   * id no longer exists, e.g. a row clicked just as its tab closed.
   */
  const refOf = (arg: unknown): Ref | undefined => {
    if (arg === undefined || arg === null) return undefined;
    if (typeof arg === 'object' && typeof (arg as { id?: unknown }).id === 'string') {
      const ref = state.flush().nodes.get((arg as { id: string }).id)?.ref;
      if (ref) return ref;
    } else if (typeof arg === 'string') {
      if (tabs().some(t => t.id === arg)) return { tabId: arg };
      if (terminals().some(t => t.id === arg)) return { terminalId: arg };
      if (sessions.get(arg)) return { sessionId: arg };
    }
    throw new TargetGone();
  };

  const report = (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    services.log.warn(`UI command failed: ${message}`);
    void vscode.window.showWarningMessage(message);
  };

  // ----------------------------------------------------------------------------- pickers

  const describeTab = (tab: BrowserTabInfo): string => {
    const users = sessions.list().filter(s => tabBelongsTo(tab, s.id));
    if (tab.paused) return 'paused by you';
    if (tab.controlledBy) return `controlled by ${sessionLabel(tab.controlledBy)}`;
    if (users.length) return `used by ${users.map(s => s.label).join(', ')}`;
    return tab.origin === 'user' ? 'your tab' : 'idle';
  };

  async function pickTab(filter: (t: BrowserTabInfo) => boolean, placeHolder: string, none: string): Promise<string | undefined> {
    if (!sources.browserAvailable) {
      void vscode.window.showInformationMessage('The integrated browser is not enabled for Agent Bridge, so there are no tabs to act on.');
      return undefined;
    }
    const candidates = tabs().filter(filter);
    if (!candidates.length) {
      void vscode.window.showInformationMessage(none);
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      candidates.map(t => ({
        label: `$(${t.paused ? 'debug-pause' : 'globe'}) ${tabTitle(t) || hostOf(t.url) || t.url}`,
        description: describeTab(t),
        detail: t.url,
        id: t.id,
      })),
      { placeHolder, matchOnDescription: true, matchOnDetail: true },
    );
    return picked?.id;
  }

  const describeTerminal = (t: TerminalInfo): string => {
    const owner = t.origin === 'agent' ? sessionLabel(t.ownedBy) : 'your terminal';
    const state = t.state === 'waiting-for-user' ? 'waiting for you' : t.state === 'running' ? `running ${t.currentCommand ?? ''}`.trim() : t.state;
    return [owner, state].filter(Boolean).join(' · ');
  };

  async function pickTerminal(filter: (t: TerminalInfo) => boolean, placeHolder: string, none: string): Promise<string | undefined> {
    const candidates = terminals().filter(t => filter(t) && (t.origin === 'agent' || sessions.list().some(s => terminalBelongsTo(t, s.id))));
    if (!candidates.length) {
      void vscode.window.showInformationMessage(none);
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      candidates.map(t => ({
        label: `$(${t.state === 'waiting-for-user' ? 'bell-dot' : 'terminal'}) ${t.name}`,
        description: describeTerminal(t),
        detail: t.userInputRequest,
        id: t.id,
      })),
      { placeHolder, matchOnDescription: true },
    );
    return picked?.id;
  }

  async function pickSession(placeHolder: string): Promise<string | undefined> {
    const list = sessions.list();
    if (!list.length) {
      void vscode.window.showInformationMessage('No agent session is connected to this window.');
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      list.map(s => ({
        label: `$(${s.connected ? 'circle-filled' : 'circle-outline'}) ${s.label}`,
        description: [s.title, s.connected ? undefined : 'disconnected'].filter(Boolean).join(' · '),
        detail: sessionContents(s),
        id: s.id,
      })),
      { placeHolder },
    );
    return picked?.id;
  }

  const sessionContents = (s: AgentSession): string => {
    const t = tabs().filter(tab => tabBelongsTo(tab, s.id)).length;
    const n = terminals().filter(term => terminalBelongsTo(term, s.id)).length;
    return [t ? plural(t, 'browser tab') : undefined, n ? plural(n, 'terminal') : undefined].filter(Boolean).join(', ') || 'no tabs or terminals';
  };

  // ----------------------------------------------------------------------------- actions

  async function revealTab(tabId: string): Promise<void> {
    try {
      await services.browser.revealTab(tabId);
    } catch (err) {
      // Quiet on purpose: the row stays where it is, and the reason goes to the status bar briefly.
      const message = err instanceof Error ? err.message : String(err);
      services.log.info(`UI: could not show ${tabId}: ${message}`);
      vscode.window.setStatusBarMessage(`$(info) ${message}`, 5000);
    }
  }

  function revealTerminal(terminalId: string, preserveFocus = false): void {
    try {
      sources.revealTerminal(terminalId, preserveFocus);
    } catch (err) {
      report(err);
    }
  }

  function setPaused(tabId: string, paused: boolean): void {
    try {
      services.browser.setPaused(tabId, paused);
    } catch (err) {
      report(err);
    }
  }

  async function endSession(sessionId: string): Promise<void> {
    const session = sessions.get(sessionId);
    if (!session) return;
    const ownTabs = tabs().filter(t => t.origin === 'agent' && t.openedBy === session.id);
    const ownTerminals = terminals().filter(t => t.origin === 'agent' && t.ownedBy === session.id && t.state !== 'closed');
    const contents = [ownTabs.length ? plural(ownTabs.length, 'tab') : undefined, ownTerminals.length ? plural(ownTerminals.length, 'terminal') : undefined]
      .filter(Boolean)
      .join(' and ');
    const end = 'End Session';
    const endAndClose = `End and Close Its ${[ownTabs.length ? 'Tabs' : undefined, ownTerminals.length ? 'Terminals' : undefined].filter(Boolean).join(' and ')}`;
    const answer = await services.prompts.ask({
      message: `End ${session.label}${session.title ? ` (${session.title})` : ''}?`,
      detail: [
        `${session.label} will be disconnected from this window and lose control of every tab and terminal it uses.`,
        contents ? `Its ${contents} stay open unless you choose to close them.` : undefined,
        `If the agent is still running, its next action connects it again as a new session with nothing assigned. To stop the agent itself, stop it in ${AGENT_APPS[session.client.kind] ?? 'its own window'}.`,
      ]
        .filter(Boolean)
        .join('\n\n'),
      choices: contents ? [end, endAndClose] : [end],
      modal: true,
    });
    if (answer !== end && answer !== endAndClose) return;
    sessions.remove(session.id);
    if (answer === endAndClose) {
      for (const t of ownTerminals) {
        try {
          sources.closeTerminal(t.id);
        } catch (err) {
          services.log.warn(`UI: could not close ${t.id}: ${String(err)}`);
        }
      }
      for (const t of ownTabs) await services.browser.closeTab(t.id).catch(err => services.log.warn(`UI: could not close ${t.id}: ${String(err)}`));
    }
  }

  async function goTo(item: AttentionItem): Promise<void> {
    if (item.kind === 'terminal') revealTerminal(item.targetId, false);
    else await revealTab(item.targetId);
    const sessionId = item.sessionIds[0];
    if (sessionId && tree.view.visible) await tree.reveal(`session:${sessionId}/${item.kind}:${item.targetId}`).catch(() => undefined);
  }

  async function showAttention(): Promise<void> {
    const items = state.flush().attention;
    if (items.length === 0) {
      await vscode.commands.executeCommand(Cmd.focusSessions);
      return;
    }
    if (items.length === 1) return goTo(items[0]!);
    const resume: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('debug-continue'), tooltip: 'Resume Agents on This Tab' };
    const quickPick = vscode.window.createQuickPick<vscode.QuickPickItem & { item: AttentionItem }>();
    quickPick.placeholder = 'Agents waiting for you';
    quickPick.matchOnDescription = true;
    quickPick.items = items.map(item => ({
      label: `$(${item.icon.id}) ${item.label}`,
      description: item.description,
      detail: item.detail,
      item,
      buttons: item.kind === 'tab' ? [resume] : [],
    }));
    await new Promise<void>(resolve => {
      quickPick.onDidTriggerItemButton(e => {
        setPaused(e.item.item.targetId, false);
        quickPick.items = quickPick.items.filter(i => i !== e.item);
        if (!quickPick.items.length) quickPick.hide();
      });
      quickPick.onDidAccept(() => {
        const chosen = quickPick.selectedItems[0];
        quickPick.hide();
        if (chosen) void goTo(chosen.item);
      });
      quickPick.onDidHide(() => {
        quickPick.dispose();
        resolve();
      });
      quickPick.show();
    });
  }

  // ----------------------------------------------------------------------------- registration

  const command = (id: string, fn: (...args: any[]) => unknown) =>
    vscode.commands.registerCommand(id, async (...args: unknown[]) => {
      try {
        await fn(...args);
      } catch (err) {
        if (err instanceof TargetGone) vscode.window.setStatusBarMessage(`$(info) ${err.message}`, 4000);
        else report(err);
      }
    });

  return [
    command(Cmd.showAttention, showAttention),
    command(Cmd.revealTab, async (arg?: unknown) => {
      const id = refOf(arg)?.tabId ?? (await pickTab(() => true, 'Show which browser tab?', 'No browser tab is open.'));
      if (id) await revealTab(id);
    }),
    command(Cmd.pauseTab, async (arg?: unknown) => {
      const id =
        refOf(arg)?.tabId ??
        (await pickTab(t => !t.paused && sessions.list().some(s => tabBelongsTo(t, s.id)), 'Pause agents on which tab? You take over until you resume it.', 'No agent is using a tab that could be paused.'));
      if (id) setPaused(id, true);
    }),
    command(Cmd.resumeTab, async (arg?: unknown) => {
      const id = refOf(arg)?.tabId ?? (await pickTab(t => t.paused, 'Resume agents on which tab?', 'No tab is paused.'));
      if (id) setPaused(id, false);
    }),
    command(Cmd.releaseTab, async (arg?: unknown) => {
      const ref = refOf(arg);
      const id = ref?.tabId ?? (await pickTab(t => t.controlledBy !== undefined, 'Release which tab from the agent controlling it?', 'No agent is controlling a tab.'));
      if (!id) return;
      const sessionId = ref?.sessionId ?? tabs().find(t => t.id === id)?.controlledBy;
      services.browser.releaseTab(id, sessionId);
    }),
    command(Cmd.closeTab, async (arg?: unknown) => {
      const id = refOf(arg)?.tabId ?? (await pickTab(() => true, 'Close which browser tab?', 'No browser tab is open.'));
      if (id) await services.browser.closeTab(id);
    }),
    command(Cmd.revealTerminal, async (arg?: unknown, options?: { preserveFocus?: boolean }) => {
      const id = refOf(arg)?.terminalId ?? (await pickTerminal(() => true, 'Show which agent terminal?', 'No agent terminal is open.'));
      if (id) revealTerminal(id, options?.preserveFocus ?? false);
    }),
    command(Cmd.interruptTerminal, async (arg?: unknown) => {
      const id =
        refOf(arg)?.terminalId ??
        (await pickTerminal(t => t.state === 'running' || t.state === 'waiting-for-user', 'Interrupt the command in which terminal (Ctrl+C)?', 'No agent terminal is running a command.'));
      if (id) sources.interruptTerminal(id);
    }),
    command(Cmd.closeTerminal, async (arg?: unknown) => {
      const id = refOf(arg)?.terminalId ?? (await pickTerminal(t => t.state !== 'closed', 'Close which agent terminal?', 'No agent terminal is open.'));
      if (!id) return;
      const terminal = terminals().find(t => t.id === id);
      if (terminal?.state === 'running' || terminal?.state === 'waiting-for-user') {
        const close = 'Close Terminal';
        const answer = await services.prompts.ask({
          message: `Close "${terminal.name}"?`,
          detail: `It is still running ${terminal.currentCommand ? `"${terminal.currentCommand}"` : 'a command'}, which will be stopped.`,
          choices: [close],
          modal: true,
        });
        if (answer !== close) return;
      }
      sources.closeTerminal(id);
    }),
    command(Cmd.endSession, async (arg?: unknown) => {
      const id = refOf(arg)?.sessionId ?? (await pickSession('End which agent session?'));
      if (id) await endSession(id);
    }),
    command(Cmd.pauseSessionTabs, async (arg?: unknown) => {
      const id = refOf(arg)?.sessionId ?? (await pickSession('Pause every tab of which agent session?'));
      if (!id) return;
      for (const t of tabs()) if (tabBelongsTo(t, id) && tabState(t, id) !== 'paused') setPaused(t.id, true);
    }),
    command(Cmd.resumeSessionTabs, async (arg?: unknown) => {
      const id = refOf(arg)?.sessionId ?? (await pickSession('Resume every tab of which agent session?'));
      if (!id) return;
      for (const t of tabs()) if (tabBelongsTo(t, id) && t.paused) setPaused(t.id, false);
    }),
  ];
}
