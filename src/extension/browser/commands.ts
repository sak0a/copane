// User commands of the browser module: take over a tab (pause / resume agent access), stop an agent's
// control, share a tab with a session, reset permissions, show a tab. These are the user's own
// actions, so they may use quick picks directly; anything an agent waits on goes through
// `services.prompts`.
//
// Every command that acts on a tab accepts, as its first argument: a tab id ("tab-3"), an object with
// an `id` (a BrowserTabInfo, e.g. from the Sessions view), a `vscode-browser:` URI (what VS Code
// passes from a browser editor's title bar), or nothing (the active browser tab, else a quick pick).
import * as vscode from 'vscode';
import type { BridgeServices, BrowserTabInfo } from '../core/services';
import { sessionDisplayName } from '../core/sessions';
import { viewIdOf } from './decorations';
import type { BrowserServiceImpl } from './service';

export function registerBrowserCommands(services: BridgeServices, browser: BrowserServiceImpl): void {
  const { sessions, tabLeases } = services;

  const pickTab = async (arg: unknown, placeHolder: string, filter: (t: BrowserTabInfo) => boolean = () => true): Promise<string | undefined> => {
    if (typeof arg === 'string' && browser.getTab(arg)) return browser.getTab(arg)!.id;
    if (arg && typeof arg === 'object' && 'id' in arg && typeof (arg as any).id === 'string' && browser.getTab((arg as any).id)) return (arg as any).id;
    if (arg instanceof vscode.Uri) {
      const viewId = viewIdOf(arg);
      const id = viewId && browser.tabIdForViewId(viewId);
      if (id) return id;
    }
    const active = browser.activeTabId();
    if (arg === undefined && active && filter(browser.getTab(active)!)) return active;
    const tabs = browser.listTabs().filter(filter);
    if (tabs.length === 0) {
      void vscode.window.showInformationMessage('There is no browser tab for that.');
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      tabs.map(t => ({ label: t.title || t.url, description: t.url, detail: describeUse(t), id: t.id })),
      { placeHolder },
    );
    return picked?.id;
  };

  const describeUse = (t: BrowserTabInfo): string => {
    const name = (id: string | undefined) => (id && sessions.get(id) ? sessionDisplayName(sessions.get(id)!) : undefined);
    if (t.paused) return 'Agent access paused';
    if (t.controlledBy) return `Controlled by ${name(t.controlledBy) ?? 'an agent'}`;
    if (t.origin === 'agent') return `Opened by ${name(t.openedBy) ?? 'an ended agent session'}`;
    return 'Opened by you';
  };

  services.context.subscriptions.push(
    vscode.commands.registerCommand('agentBridge.browser.pauseTab', async (arg?: unknown) => {
      const id = await pickTab(arg, 'Pause agent access to which tab?', t => !t.paused);
      if (id) browser.setPaused(id, true);
    }),
    vscode.commands.registerCommand('agentBridge.browser.resumeTab', async (arg?: unknown) => {
      const id = await pickTab(arg, 'Resume agent access to which tab?', t => t.paused);
      if (id) browser.setPaused(id, false);
    }),
    vscode.commands.registerCommand('agentBridge.browser.releaseTab', async (arg?: unknown) => {
      const id = await pickTab(arg, 'End agent control of which tab?', t => !!t.controlledBy);
      if (id) tabLeases.release(id);
    }),
    vscode.commands.registerCommand('agentBridge.browser.revealTab', async (arg?: unknown) => {
      const id = await pickTab(arg, 'Show which tab?');
      if (id) await browser.revealTab(id);
    }),
    vscode.commands.registerCommand('agentBridge.browser.shareTab', async (arg?: unknown, sessionArg?: unknown) => {
      const id = await pickTab(arg, 'Share which tab with an agent session?', t => t.origin === 'user');
      if (!id) return;
      let sessionId = typeof sessionArg === 'string' && sessions.get(sessionArg) ? sessionArg : undefined;
      if (!sessionId) {
        const live = sessions.list();
        if (live.length === 0) {
          void vscode.window.showInformationMessage('No agent session is connected to this window.');
          return;
        }
        const picked = await vscode.window.showQuickPick(
          live.map(s => ({ label: sessionDisplayName(s), description: s.connected ? undefined : 'disconnected', id: s.id })),
          { placeHolder: `Which session may use ${browser.getTab(id)?.title || id}?` },
        );
        sessionId = picked?.id;
      }
      if (sessionId) browser.grantAccess(id, sessionId);
    }),
    vscode.commands.registerCommand('agentBridge.browser.resetPermissions', () => {
      browser.resetConsent();
      void vscode.window.showInformationMessage('Agent sessions will ask again before using your browser tabs.');
    }),
  );
}
