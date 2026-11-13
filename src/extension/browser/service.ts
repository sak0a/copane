// Tracks the integrated-browser tabs of this window and gates access to them.
import * as vscode from 'vscode';
import { ToolError } from '../core/errors';
import { Emitter } from '../core/events';
import type { BridgeServices, BrowserService, BrowserTabInfo, CdpPage, TabAccess } from '../core/services';
import type { AgentSession } from '../core/sessions';
import { CdpConnection } from './cdp';

interface TabRecord {
  id: string;
  tab: vscode.BrowserTab;
  origin: 'agent' | 'user';
  openedBy: string | undefined;
  paused: boolean;
  connection: CdpConnection | undefined;
  connecting: Promise<CdpConnection> | undefined;
}

const NOT_ENABLED =
  "The integrated browser is not enabled for this extension in the user's VS Code yet. Ask the user to run the command \"Agent Bridge: Enable Integrated Browser\" and restart VS Code, then try again.";

export function browserApiAvailable(): boolean {
  try {
    return Array.isArray(vscode.window.browserTabs);
  } catch {
    return false; // Accessing a proposed API that is not enabled throws.
  }
}

export class BrowserServiceImpl implements BrowserService, vscode.Disposable {
  readonly available = browserApiAvailable();
  private readonly records = new Map<vscode.BrowserTab, TabRecord>();
  private readonly currentTab = new Map<string, string>();
  private nextTabNumber = 1;
  private readonly changeEmitter = new Emitter<void>();
  private readonly attachEmitter = new Emitter<CdpPage>();
  private readonly subscriptions: vscode.Disposable[] = [];
  /** Tabs being opened by a session right now, so `onDidOpenBrowserTab` can attribute them. */
  private pendingOpens: Array<{ url: string; sessionId: string }> = [];

  readonly onDidChange = this.changeEmitter.event;
  readonly onDidAttachPage = this.attachEmitter.event;

  constructor(private readonly services: BridgeServices) {
    if (!this.available) return;
    for (const tab of vscode.window.browserTabs) this.track(tab);
    this.subscriptions.push(
      vscode.window.onDidOpenBrowserTab(tab => {
        this.track(tab);
        this.changeEmitter.fire();
      }),
      vscode.window.onDidCloseBrowserTab(tab => this.untrack(tab)),
      vscode.window.onDidChangeActiveBrowserTab(() => this.changeEmitter.fire()),
      vscode.window.onDidChangeBrowserTabState(() => this.changeEmitter.fire()),
      services.tabLeases.onDidChange(() => this.changeEmitter.fire()),
      services.sessions.onDidChange(change => {
        if (change.type !== 'removed') return;
        this.currentTab.delete(change.session.id);
        this.changeEmitter.fire();
      }),
    );
  }

  listTabs(): BrowserTabInfo[] {
    if (!this.available) return [];
    return vscode.window.browserTabs.map(tab => this.describe(this.track(tab)));
  }

  getTab(tabId: string): BrowserTabInfo | undefined {
    const record = this.find(tabId);
    return record && this.describe(record);
  }

  async acquire(session: AgentSession, tabId: string | undefined, access: TabAccess): Promise<{ tab: BrowserTabInfo; page: CdpPage }> {
    this.requireAvailable();
    const id = tabId ?? this.currentTab.get(session.id);
    if (!id) throw new ToolError('not_found', 'You have no current tab. Open one with browser_open, or pass `tab` (see browser_list_tabs).');
    const record = this.find(id);
    if (!record) throw new ToolError('not_found', `There is no tab "${id}". It may have been closed; call browser_list_tabs for the current tabs.`);
    if (record.paused) throw new ToolError('access_denied', `The user has paused agent access to ${id}. Wait for them to resume it.`);
    if (access === 'control') {
      const result = this.services.tabLeases.acquire(id, session.id);
      if (!result.ok) {
        const holder = this.services.sessions.get(result.heldBy.sessionId);
        throw new ToolError('busy', `${id} is being controlled by ${holder?.label ?? 'another agent session'}. You can still read it (snapshot, screenshot). Use another tab, or try again later.`);
      }
    }
    this.currentTab.set(session.id, id);
    const page = await this.connect(record);
    return { tab: this.describe(record), page };
  }

  async openTab(session: AgentSession, url: string, options: { background?: boolean } = {}): Promise<BrowserTabInfo> {
    this.requireAvailable();
    const pending = { url, sessionId: session.id };
    this.pendingOpens.push(pending);
    try {
      const tab = await vscode.window.openBrowserTab(url, { background: options.background ?? false, preserveFocus: true });
      const record = this.track(tab);
      record.origin = 'agent';
      record.openedBy = session.id;
      this.currentTab.set(session.id, record.id);
      this.services.tabLeases.acquire(record.id, session.id, { force: true });
      this.changeEmitter.fire();
      return this.describe(record);
    } finally {
      this.pendingOpens = this.pendingOpens.filter(p => p !== pending);
    }
  }

  async closeTab(tabId: string): Promise<void> {
    const record = this.find(tabId);
    if (!record) throw new ToolError('not_found', `There is no tab "${tabId}".`);
    await record.tab.close();
  }

  async revealTab(tabId: string): Promise<void> {
    if (!this.find(tabId)) throw new ToolError('not_found', `There is no tab "${tabId}".`);
    throw new ToolError('unavailable', 'Bringing a tab to the front is not supported yet.');
  }

  releaseTab(tabId: string, sessionId?: string): void {
    this.services.tabLeases.release(tabId, sessionId);
  }

  setPaused(tabId: string, paused: boolean): void {
    const record = this.find(tabId);
    if (!record || record.paused === paused) return;
    record.paused = paused;
    if (paused) this.services.tabLeases.release(tabId);
    this.changeEmitter.fire();
  }

  dispose(): void {
    for (const s of this.subscriptions.splice(0)) s.dispose();
    for (const record of this.records.values()) record.connection?.close();
    this.records.clear();
    this.changeEmitter.dispose();
    this.attachEmitter.dispose();
  }

  private requireAvailable(): void {
    if (!this.available) throw new ToolError('unavailable', NOT_ENABLED);
  }

  private track(tab: vscode.BrowserTab): TabRecord {
    let record = this.records.get(tab);
    if (!record) {
      const opening = this.pendingOpens.find(p => p.url === tab.url) ?? (this.pendingOpens.length === 1 ? this.pendingOpens[0] : undefined);
      record = {
        id: `tab-${this.nextTabNumber++}`,
        tab,
        origin: opening ? 'agent' : 'user',
        openedBy: opening?.sessionId,
        paused: false,
        connection: undefined,
        connecting: undefined,
      };
      this.records.set(tab, record);
    }
    return record;
  }

  private untrack(tab: vscode.BrowserTab): void {
    const record = this.records.get(tab);
    if (!record) return;
    this.records.delete(tab);
    // The CDP session does not report the tab closing on its own, so close it here.
    record.connection?.close();
    this.services.tabLeases.release(record.id);
    for (const [sessionId, id] of this.currentTab) if (id === record.id) this.currentTab.delete(sessionId);
    this.changeEmitter.fire();
  }

  private find(tabId: string): TabRecord | undefined {
    for (const record of this.records.values()) if (record.id === tabId) return record;
    return undefined;
  }

  private async connect(record: TabRecord): Promise<CdpConnection> {
    if (record.connection && !record.connection.closed) return record.connection;
    record.connecting ??= CdpConnection.attach(record.id, record.tab)
      .then(connection => {
        record.connection = connection;
        connection.onDidClose(() => {
          if (record.connection === connection) record.connection = undefined;
        });
        this.attachEmitter.fire(connection);
        return connection;
      })
      .finally(() => (record.connecting = undefined));
    return record.connecting;
  }

  private describe(record: TabRecord): BrowserTabInfo {
    const { sessions, tabLeases } = this.services;
    const openedBy = record.openedBy && sessions.get(record.openedBy) ? record.openedBy : undefined;
    return {
      id: record.id,
      url: record.tab.url,
      title: record.tab.title,
      active: vscode.window.activeBrowserTab === record.tab,
      origin: record.origin,
      openedBy,
      controlledBy: tabLeases.holder(record.id)?.sessionId,
      allowedSessions: openedBy ? [openedBy] : [],
      paused: record.paused,
    };
  }
}
