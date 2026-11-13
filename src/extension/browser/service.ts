// Tracks the integrated-browser tabs of this window and gates access to them: who opened a tab,
// whether a session may use it (consent for user tabs), who controls it (leases), whether the user has
// paused it, and how the tab shows that (page indicator, editor tab badge).
import * as vscode from 'vscode';
import { ToolError } from '../core/errors';
import { Emitter } from '../core/events';
import { scopedLogger, type Logger } from '../core/log';
import type { BridgeServices, BrowserService, BrowserTabInfo, CdpPage, TabAccess } from '../core/services';
import { sessionDisplayName, type AgentSession } from '../core/sessions';
import { consentPrompt, decideAccess, deniedMessage, formatAge, pageTitle, relation, type UserTabsSetting } from './access';
import { CdpConnection } from './cdp';
import { ConsentStore, siteOf, type ConsentAnswer } from './consent';
import { browserViewUri, TabDecorations } from './decorations';
import { PageMarker, type MarkerAction, type MarkerState } from './marker';
import { candidatesFor, compareTabIds, parseState, type PersistedBrowserState, type PersistedTab } from './tabState';

interface TabRecord {
  /** "tab-3"; empty while a tab restored after a reload is being matched to the id it had before. */
  id: string;
  tab: vscode.BrowserTab;
  origin: 'agent' | 'user';
  openedBy: string | undefined;
  openerTab: string | undefined;
  paused: boolean;
  viewId: string | undefined;
  connection: CdpConnection | undefined;
  connecting: Promise<CdpConnection> | undefined;
  marker: PageMarker | undefined;
  /** The session that last held the control lease. */
  lastController: string | undefined;
  /** `onDidOpenTab` has fired for it (or it existed before activation). */
  announced: boolean;
}

interface PendingConsent {
  promise: Promise<void>;
  controller: AbortController;
  sessionId: string;
  tabId: string;
}

interface PendingPopup {
  fromTab: string;
  sessionId: string;
  url: string;
  at: number;
}

const STATE_KEY = 'copane.browser.state';
/** How long a tool call waits for the user to answer a consent prompt before it returns. */
const CONSENT_WAIT_MS = 120_000;
/** A tab that appears this long after a controlled page called window.open counts as that page's popup. */
const POPUP_WINDOW_MS = 5_000;
const IDENTIFY_TIMEOUT_MS = 5_000;
const NEUTRAL_COLOR = '#8a8a8a';

export const NOT_ENABLED =
  "The integrated browser is not enabled for this extension in the user's VS Code yet. Ask the user to run the command \"Copane: Enable Integrated Browser\" and restart VS Code, then try again.";

export function browserApiAvailable(): boolean {
  try {
    return Array.isArray(vscode.window.browserTabs);
  } catch {
    return false; // Accessing a proposed API that is not enabled throws.
  }
}

const config = () => vscode.workspace.getConfiguration('copane.browser');

export class BrowserServiceImpl implements BrowserService, vscode.Disposable {
  readonly available = browserApiAvailable();
  private readonly records = new Map<vscode.BrowserTab, TabRecord>();
  private readonly currentTab = new Map<string, string>();
  private readonly consent = new ConsentStore();
  private readonly pendingConsent = new Map<string, PendingConsent>();
  private pendingPopups: PendingPopup[] = [];
  /** Tabs that opened while a session's `openTab` was in flight; attributed once it returns. */
  private readonly unannounced = new Set<TabRecord>();
  private openingCount = 0;
  private nextTabNumber = 1;
  private remembered: PersistedBrowserState = parseState(undefined);
  private restoring = true;
  private persistTimer: NodeJS.Timeout | undefined;
  private decorations: TabDecorations | undefined;
  private readonly changeEmitter = new Emitter<void>();
  private readonly attachEmitter = new Emitter<CdpPage>();
  private readonly openEmitter = new Emitter<BrowserTabInfo>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly log: Logger;
  /** Resolves once tabs restored after a window reload have their old ids back. */
  readonly ready: Promise<void>;

  /** Set by the certificate gate (see `BrowserService.certificateRefusal`). */
  certificateRefusal: ((url: string) => string | undefined) | undefined;

  readonly onDidChange = this.changeEmitter.event;
  readonly onDidAttachPage = this.attachEmitter.event;
  readonly onDidOpenTab = this.openEmitter.event;

  constructor(private readonly services: BridgeServices) {
    this.log = scopedLogger(services.log, 'browser');
    if (!this.available) {
      this.ready = Promise.resolve();
      return;
    }
    this.remembered = parseState(services.context.workspaceState.get(STATE_KEY));
    this.nextTabNumber = this.remembered.nextNumber;
    this.consent.restore(this.remembered.consent);
    for (const [sessionId, tabId] of Object.entries(this.remembered.currentTab)) this.currentTab.set(sessionId, tabId);
    this.ready = this.restore();

    this.decorations = new TabDecorations(viewId => this.decorationFor(viewId));
    this.subscriptions.push(
      this.decorations,
      vscode.window.onDidOpenBrowserTab(tab => this.onOpened(tab)),
      vscode.window.onDidCloseBrowserTab(tab => this.untrack(tab)),
      vscode.window.onDidChangeActiveBrowserTab(() => {
        this.updateContextKeys();
        this.changeEmitter.fire();
      }),
      vscode.window.onDidChangeBrowserTabState(() => {
        this.schedulePersist();
        this.changeEmitter.fire();
      }),
      services.tabLeases.onDidChange(change => {
        const record = this.find(change.resourceId);
        if (!record) return;
        if (change.lease) record.lastController = change.lease.sessionId;
        this.refreshMarking(record);
        this.changeEmitter.fire();
      }),
      services.sessions.onDidChange(change => {
        if (change.type === 'removed') this.onSessionRemoved(change.session);
        else this.refreshMarking(...this.allRecords().filter(r => this.involves(r, change.session.id)));
        this.changeEmitter.fire();
      }),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('copane.browser.pageIndicator')) this.refreshMarking(...this.allRecords());
      }),
    );
    this.updateContextKeys();
  }

  // ------------------------------------------------------------------ BrowserService

  listTabs(): BrowserTabInfo[] {
    if (!this.available) return [];
    for (const tab of vscode.window.browserTabs) if (!this.records.has(tab)) this.onOpened(tab);
    return this.allRecords()
      .sort((a, b) => compareTabIds(a.id, b.id))
      .map(r => this.describe(r));
  }

  getTab(tabId: string): BrowserTabInfo | undefined {
    const record = this.find(normalizeTabId(tabId));
    return record && this.describe(record);
  }

  async acquire(session: AgentSession, tabId: string | undefined, access: TabAccess, signal?: AbortSignal): Promise<{ tab: BrowserTabInfo; page: CdpPage }> {
    this.assertAvailable();
    await this.ready;
    const record = this.resolve(session, tabId);
    await this.checkAccess(session, record, signal);
    if (access === 'control') this.takeLease(session, record);
    this.setCurrent(session.id, record.id);
    const page = await this.connect(record);
    return { tab: this.describe(record), page };
  }

  async openTab(session: AgentSession, url: string, options: { background?: boolean } = {}): Promise<BrowserTabInfo> {
    this.assertAvailable();
    await this.ready;
    this.openingCount++;
    let record: TabRecord;
    try {
      const tab = await vscode.window.openBrowserTab(url, { background: options.background ?? false, preserveFocus: true });
      record = this.records.get(tab) ?? this.track(tab, this.freshId());
      this.unannounced.delete(record);
      record.origin = 'agent';
      record.openedBy = session.id;
      this.setCurrent(session.id, record.id);
      this.services.tabLeases.acquire(record.id, session.id, { force: true });
      this.announce(record);
    } finally {
      if (--this.openingCount === 0) {
        for (const other of [...this.unannounced]) void this.classify(other);
        this.unannounced.clear();
      }
    }
    // Attach right away so the page shows who controls it and the editor tab gets its badge.
    try {
      await this.connect(record);
    } catch (err) {
      this.log.warn(`could not attach to ${record.id} after opening it: ${errorText(err)}`);
    }
    return this.describe(record);
  }

  async closeTab(tabId: string): Promise<void> {
    this.assertAvailable();
    const record = this.find(normalizeTabId(tabId));
    if (!record) throw new ToolError('not_found', `There is no tab "${tabId}". Call browser_list_tabs for the open tabs.`);
    await record.tab.close();
    // The close event usually follows at once; do not report success while the tab is still listed.
    for (let i = 0; i < 20 && this.records.has(record.tab); i++) await sleep(100);
    if (this.records.has(record.tab)) this.untrack(record.tab);
  }

  async revealTab(tabId: string): Promise<void> {
    this.assertAvailable();
    const record = this.find(normalizeTabId(tabId));
    if (!record) throw new ToolError('not_found', `There is no tab "${tabId}". Call browser_list_tabs for the open tabs.`);
    if (!record.viewId) {
      try {
        await this.connect(record);
      } catch (err) {
        this.log.warn(`could not attach to ${record.id} to reveal it: ${errorText(err)}`);
      }
    }
    if (!record.viewId) throw new ToolError('unavailable', `VS Code did not say which editor shows ${record.id}, so it cannot be brought to the front. Ask the user to switch to the tab "${pageTitle(record.tab.title, record.tab.url) || record.tab.url}".`);
    // The browser editor of an existing view is opened (revealed) through its resource. Pass the group
    // it is in, so VS Code activates it there instead of moving it to the active group.
    await vscode.commands.executeCommand('vscode.open', browserViewUri(record.viewId), {
      viewColumn: this.columnOf(record),
      preserveFocus: true,
      preview: false,
    });
  }

  releaseTab(tabId: string, sessionId?: string): void {
    this.services.tabLeases.release(normalizeTabId(tabId), sessionId);
  }

  setPaused(tabId: string, paused: boolean): void {
    const record = this.find(normalizeTabId(tabId));
    if (!record || record.paused === paused) return;
    record.paused = paused;
    this.log.info(`${record.id} ${paused ? 'paused' : 'resumed'} by the user`);
    if (paused) this.services.tabLeases.release(record.id);
    this.refreshMarking(record);
    this.schedulePersist();
    this.changeEmitter.fire();
  }

  grantAccess(tabId: string, sessionId: string): void {
    const record = this.find(normalizeTabId(tabId));
    if (!record) return;
    this.consent.grant(sessionId, record.id);
    // Calls waiting on the prompt for this question go ahead now (the notification itself may stay).
    this.pendingConsent.get(`${sessionId}|${record.id}`)?.controller.abort();
    this.schedulePersist();
    this.changeEmitter.fire();
  }

  revokeAccess(tabId: string, sessionId?: string): void {
    const id = normalizeTabId(tabId);
    this.consent.revoke({ tabId: id, sessionId });
    const record = this.find(id);
    // A session that loses access also loses control.
    const holder = this.services.tabLeases.holder(id);
    if (record?.origin === 'user' && holder && (sessionId === undefined || holder.sessionId === sessionId)) this.services.tabLeases.release(id);
    this.schedulePersist();
    this.changeEmitter.fire();
  }

  // ------------------------------------------------------------------ Used by the tools and commands of this module

  /** Forget everything the user allowed or denied, for every tab and session. */
  resetConsent(): void {
    this.consent.revoke();
    for (const pending of this.pendingConsent.values()) pending.controller.abort();
    this.schedulePersist();
    this.changeEmitter.fire();
  }

  currentTabOf(sessionId: string): string | undefined {
    const id = this.currentTab.get(sessionId);
    return id && this.find(id) ? id : undefined;
  }

  /** The tab a tool call means: `tabId`, or the session's current tab. Throws a ToolError for the agent. */
  resolveId(session: AgentSession, tabId: string | undefined): string {
    return this.resolve(session, tabId).id;
  }

  /** How the tab relates to the session: its own, another live session's, an ended session's, or the user's. */
  relationOf(session: AgentSession, tabId: string): ReturnType<typeof relation> | undefined {
    const record = this.find(tabId);
    return record && relation(record, session.id, id => !!this.services.sessions.get(id));
  }

  /** The tab for an editor resource (`vscode-browser:/<viewId>`), or the active browser tab. */
  tabIdForViewId(viewId: string): string | undefined {
    return this.allRecords().find(r => r.viewId === viewId)?.id;
  }

  activeTabId(): string | undefined {
    const active = vscode.window.activeBrowserTab;
    return active ? this.records.get(active)?.id || undefined : undefined;
  }

  idleSeconds(): number {
    return leaseIdleSeconds();
  }

  dispose(): void {
    for (const s of this.subscriptions.splice(0)) s.dispose();
    for (const pending of this.pendingConsent.values()) pending.controller.abort();
    for (const record of this.records.values()) {
      record.marker?.dispose();
      record.connection?.close();
    }
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persist();
    }
    this.records.clear();
    this.changeEmitter.dispose();
    this.attachEmitter.dispose();
    this.openEmitter.dispose();
  }

  // ------------------------------------------------------------------ Access

  private resolve(session: AgentSession, tabId: string | undefined): TabRecord {
    if (tabId !== undefined && tabId.trim() !== '') {
      const id = normalizeTabId(tabId);
      const record = this.find(id);
      if (!record) throw new ToolError('not_found', `There is no tab "${tabId}". It may have been closed; call browser_list_tabs for the open tabs.`);
      return record;
    }
    const current = this.currentTab.get(session.id);
    if (!current) throw new ToolError('not_found', 'You have no current tab. Open one with browser_open, or pass `tab` (see browser_list_tabs).');
    const record = this.find(current);
    if (!record) {
      this.currentTab.delete(session.id);
      throw new ToolError('not_found', `Your current tab ${current} was closed. Open a new one with browser_open, or pick one from browser_list_tabs and pass \`tab\`.`);
    }
    return record;
  }

  private async checkAccess(session: AgentSession, record: TabRecord, signal: AbortSignal | undefined): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      const decision = decideAccess({
        sessionId: session.id,
        access: 'read',
        tab: record,
        isLive: id => !!this.services.sessions.get(id),
        consent: this.consent.check(session.id, record.id, record.tab.url),
        setting: userTabsSetting(),
      });
      if (decision.kind === 'ok') return;
      if (decision.kind === 'ask' && attempt === 0) {
        await this.askConsent(session, record, signal);
        if (!this.records.has(record.tab)) throw new ToolError('not_found', `${record.id} was closed while waiting for the user.`);
        continue;
      }
      if (decision.kind === 'ask') throw new ToolError('access_denied', `The user did not allow you to use ${record.id}. Open your own tab with browser_open.`);
      throw new ToolError('access_denied', deniedMessage(decision, record.id));
    }
  }

  private async askConsent(session: AgentSession, record: TabRecord, signal: AbortSignal | undefined): Promise<void> {
    const key = `${session.id}|${record.id}`;
    let pending = this.pendingConsent.get(key);
    if (!pending) {
      const controller = new AbortController();
      const url = record.tab.url;
      const prompt = consentPrompt(sessionDisplayName(session), record.tab, siteOf(url));
      this.log.info(`asking the user whether ${session.label} may use ${record.id} (${url})`);
      const promise = this.services.prompts
        .ask({ message: prompt.message, choices: prompt.choices, signal: controller.signal })
        .then(
          answer => {
            if (controller.signal.aborted) return;
            const mapped: ConsentAnswer = answer === prompt.allowTab ? 'tab' : answer === prompt.allowSite ? 'site' : answer === prompt.deny ? 'deny' : 'dismissed';
            this.log.info(`the user answered ${mapped} for ${session.label} on ${record.id}`);
            this.consent.record(session.id, record.id, url, mapped);
            this.schedulePersist();
            this.changeEmitter.fire();
          },
          err => this.log.warn(`consent prompt failed: ${errorText(err)}`),
        )
        .finally(() => {
          if (this.pendingConsent.get(key) === pending) this.pendingConsent.delete(key);
        });
      pending = { promise, controller, sessionId: session.id, tabId: record.id };
      this.pendingConsent.set(key, pending);
    }
    const outcome = await raceAnswer(pending.promise, CONSENT_WAIT_MS, signal);
    if (outcome === 'aborted') throw new ToolError('cancelled', 'Cancelled.');
    if (outcome === 'timeout') {
      throw new ToolError(
        'timeout',
        `The user has not answered whether you may use ${record.id} yet; the request stays open in VS Code. Do not retry in a loop: continue with other work or ask the user in chat, then call again (it will not ask twice).`,
      );
    }
  }

  private takeLease(session: AgentSession, record: TabRecord): void {
    const result = this.services.tabLeases.acquire(record.id, session.id);
    if (result.ok) return;
    const holder = this.services.sessions.get(result.heldBy.sessionId);
    const who = holder ? sessionDisplayName(holder) : 'another agent session';
    const ago = formatAge(Date.now() - result.heldBy.lastUsedAt);
    throw new ToolError(
      'busy',
      `${record.id} is being controlled by ${who} (last action ${ago} ago). You can still read it (snapshot, screenshot). Use another tab (browser_open), or try again later: control frees up when they release it or after ${formatAge(leaseIdleSeconds() * 1000)} without actions.`,
    );
  }

  private setCurrent(sessionId: string, tabId: string): void {
    if (this.currentTab.get(sessionId) === tabId) return;
    this.currentTab.set(sessionId, tabId);
    this.schedulePersist();
  }

  // ------------------------------------------------------------------ Tracking and attribution

  private track(tab: vscode.BrowserTab, id: string): TabRecord {
    const record: TabRecord = {
      id,
      tab,
      origin: 'user',
      openedBy: undefined,
      openerTab: undefined,
      paused: false,
      viewId: undefined,
      connection: undefined,
      connecting: undefined,
      marker: undefined,
      lastController: undefined,
      announced: false,
    };
    this.records.set(tab, record);
    return record;
  }

  private onOpened(tab: vscode.BrowserTab): void {
    if (this.records.has(tab)) return;
    const record = this.track(tab, this.freshId());
    this.changeEmitter.fire();
    // `openBrowserTab` reports its tab through this event before it returns; wait for it to say which.
    if (this.openingCount > 0) this.unannounced.add(record);
    else void this.classify(record);
  }

  /** Decides whether a new tab is a popup of a page some session controls, then announces it. */
  private async classify(record: TabRecord): Promise<void> {
    let popup = this.takePopup(record);
    if (!popup && this.recentAgentControl()) {
      // The page's window.open event can arrive just after the tab itself.
      await sleep(400);
      popup = this.takePopup(record);
    }
    if (popup && this.records.has(record.tab) && record.origin === 'user') {
      record.origin = 'agent';
      record.openedBy = popup.sessionId;
      record.openerTab = popup.fromTab;
      this.log.info(`${record.id} was opened by the page in ${popup.fromTab}; attributed to ${this.services.sessions.get(popup.sessionId)?.label ?? popup.sessionId}`);
      if (this.services.sessions.get(popup.sessionId)) this.services.tabLeases.acquire(record.id, popup.sessionId, { force: true });
      void this.connect(record).catch(err => this.log.warn(`could not attach to popup ${record.id}: ${errorText(err)}`));
    }
    this.announce(record);
  }

  private takePopup(record: TabRecord): PendingPopup | undefined {
    const now = Date.now();
    this.pendingPopups = this.pendingPopups.filter(p => now - p.at < POPUP_WINDOW_MS);
    const url = record.tab.url;
    const index = this.pendingPopups.findIndex(p => p.url === url || url === '' || url === 'about:blank' || p.url === '' || p.url === 'about:blank');
    if (index < 0) return undefined;
    return this.pendingPopups.splice(index, 1)[0];
  }

  private recentAgentControl(): boolean {
    const now = Date.now();
    return this.allRecords().some(r => {
      const lease = this.services.tabLeases.holder(r.id);
      return lease && now - lease.lastUsedAt < 10_000;
    });
  }

  private announce(record: TabRecord): void {
    if (record.announced || !record.id) return;
    record.announced = true;
    this.schedulePersist();
    this.changeEmitter.fire();
    this.openEmitter.fire(this.describe(record));
  }

  private untrack(tab: vscode.BrowserTab): void {
    const record = this.records.get(tab);
    if (!record) return;
    this.records.delete(tab);
    this.unannounced.delete(record);
    // The CDP session does not report the tab closing on its own, so close it here.
    record.marker?.dispose();
    record.connection?.close('tab-closed');
    if (record.id) {
      this.services.tabLeases.release(record.id);
      this.consent.forgetTab(record.id);
      for (const [key, pending] of this.pendingConsent) {
        if (pending.tabId === record.id) {
          pending.controller.abort();
          this.pendingConsent.delete(key);
        }
      }
    }
    this.decorations?.changed([record.viewId]);
    this.schedulePersist();
    this.updateContextKeys();
    this.changeEmitter.fire();
  }

  private onSessionRemoved(session: AgentSession): void {
    this.currentTab.delete(session.id);
    this.consent.forgetSession(session.id);
    for (const [key, pending] of this.pendingConsent) {
      if (pending.sessionId === session.id) {
        pending.controller.abort();
        this.pendingConsent.delete(key);
      }
    }
    this.refreshMarking(...this.allRecords().filter(r => this.involves(r, session.id)));
    this.schedulePersist();
  }

  private involves(record: TabRecord, sessionId: string): boolean {
    return record.openedBy === sessionId || record.lastController === sessionId || this.services.tabLeases.holder(record.id)?.sessionId === sessionId;
  }

  private freshId(): string {
    return `tab-${this.nextTabNumber++}`;
  }

  private find(tabId: string): TabRecord | undefined {
    if (!tabId) return undefined;
    for (const record of this.records.values()) if (record.id === tabId) return record;
    return undefined;
  }

  private allRecords(): TabRecord[] {
    return [...this.records.values()].filter(r => r.id);
  }

  // ------------------------------------------------------------------ Restoring ids after a window reload

  private async restore(): Promise<void> {
    const taken = new Set<string>();
    const pending: Array<Promise<void>> = [];
    for (const tab of vscode.window.browserTabs) {
      const record = this.track(tab, '');
      record.announced = true; // It was there before this extension host started.
      if (candidatesFor(this.remembered, tab.url, taken).length === 0) {
        record.id = this.freshId();
        continue;
      }
      pending.push(
        CdpConnection.identify(tab).then(
          viewId => {
            const entry = viewId ? this.remembered.tabs.find(t => t.viewId === viewId && !taken.has(t.viewId)) : undefined;
            record.viewId = viewId;
            if (entry) {
              taken.add(entry.viewId);
              this.adopt(record, entry);
            }
          },
          err => this.log.debug(`could not identify a restored tab: ${errorText(err)}`),
        ),
      );
    }
    if (pending.length) await Promise.race([Promise.all(pending), sleep(IDENTIFY_TIMEOUT_MS)]);
    for (const record of this.records.values()) if (!record.id) record.id = this.freshId();
    // Decisions and current tabs that point at tabs that are gone mean nothing any more.
    const live = new Set(this.allRecords().map(r => r.id));
    for (const t of this.remembered.tabs) if (!live.has(t.id)) this.consent.forgetTab(t.id);
    for (const [sessionId, tabId] of this.currentTab) if (!live.has(tabId)) this.currentTab.delete(sessionId);
    this.restoring = false;
    this.persist();
    this.changeEmitter.fire();
    if (pending.length) this.log.info(`restored ${taken.size} of ${pending.length} remembered tab ids`);
  }

  private adopt(record: TabRecord, entry: PersistedTab): void {
    record.id = entry.id;
    record.origin = entry.origin;
    record.openedBy = entry.openedBy;
    record.openerTab = entry.openerTab;
    record.paused = entry.paused ?? false;
  }

  private schedulePersist(): void {
    if (this.restoring || this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      this.persist();
    }, 300);
  }

  private persist(): void {
    if (this.restoring || !this.available) return;
    const tabs: PersistedTab[] = [];
    for (const r of this.allRecords()) {
      if (!r.viewId) continue;
      tabs.push({ id: r.id, viewId: r.viewId, origin: r.origin, openedBy: r.openedBy, openerTab: r.openerTab, paused: r.paused || undefined, url: r.tab.url });
    }
    const state: PersistedBrowserState = {
      version: 1,
      nextNumber: this.nextTabNumber,
      tabs,
      currentTab: Object.fromEntries(this.currentTab),
      consent: this.consent.snapshot(),
    };
    this.remembered = state;
    void Promise.resolve(this.services.context.workspaceState.update(STATE_KEY, state)).then(undefined, err => this.log.warn(`could not save tab state: ${errorText(err)}`));
  }

  // ------------------------------------------------------------------ CDP

  private async connect(record: TabRecord): Promise<CdpConnection> {
    if (record.connection && !record.connection.closed) return record.connection;
    record.connecting ??= CdpConnection.attach(record.id, record.tab)
      .then(connection => {
        if (!this.records.has(record.tab)) {
          connection.close('tab-closed');
          throw new ToolError('not_found', `${record.id} was closed.`);
        }
        record.connection = connection;
        const viewIdChanged = connection.viewId && connection.viewId !== record.viewId;
        if (connection.viewId) record.viewId = connection.viewId;
        const marker = new PageMarker(connection, action => this.onMarkerAction(record, action), m => this.log.warn(`${record.id}: ${m}`));
        record.marker = marker;
        connection.beforeInput = () => marker.beforeInput();
        connection.onDidClose(() => {
          marker.dispose();
          if (record.marker === marker) record.marker = undefined;
          if (record.connection === connection) record.connection = undefined;
        });
        // Popups: a controlled page that opens a window hands the new tab to its controller.
        connection.on('Page.windowOpen', params => {
          const holder = this.services.tabLeases.holder(record.id);
          if (!holder) return;
          this.pendingPopups.push({ fromTab: record.id, sessionId: holder.sessionId, url: String(params?.url ?? ''), at: Date.now() });
        });
        void connection.send('Page.enable').catch(err => this.log.debug(`Page.enable failed on ${record.id}: ${errorText(err)}`));
        marker.set(this.markerState(record));
        if (viewIdChanged) {
          this.decorations?.changed([record.viewId]);
          this.schedulePersist();
        }
        this.log.debug(`attached to ${record.id}${record.viewId ? ` (view ${record.viewId})` : ''}`);
        this.attachEmitter.fire(connection);
        return connection;
      })
      .finally(() => (record.connecting = undefined));
    return record.connecting;
  }

  // ------------------------------------------------------------------ Marking

  private onMarkerAction(record: TabRecord, action: MarkerAction): void {
    this.setPaused(record.id, action === 'pause');
  }

  private markerState(record: TabRecord): MarkerState | null {
    if (!config().get<boolean>('pageIndicator', true)) return null;
    if (record.paused) {
      const last = record.lastController ? this.services.sessions.get(record.lastController) : undefined;
      return { label: last ? sessionDisplayName(last) : 'agents', color: last?.color.hex ?? NEUTRAL_COLOR, paused: true };
    }
    const holder = this.services.tabLeases.holder(record.id);
    const session = holder && this.services.sessions.get(holder.sessionId);
    return session ? { label: sessionDisplayName(session), color: session.color.hex, paused: false } : null;
  }

  private refreshMarking(...records: TabRecord[]): void {
    for (const record of records) record.marker?.set(this.markerState(record));
    this.decorations?.changed(records.map(r => r.viewId));
    this.updateContextKeys();
  }

  private decorationFor(viewId: string): vscode.FileDecoration | undefined {
    const record = this.allRecords().find(r => r.viewId === viewId);
    if (!record) return undefined;
    const { sessions, tabLeases } = this.services;
    if (record.paused) return new vscode.FileDecoration('⏸', 'Agent access paused: agents cannot use this tab until you resume it.');
    const holder = tabLeases.holder(record.id);
    const live = (id: string | undefined) => (id ? sessions.get(id) : undefined);
    const controller = holder ? live(holder.sessionId) : undefined;
    const session = controller ?? live(record.lastController) ?? (record.origin === 'agent' ? live(record.openedBy) : undefined);
    if (!session) return undefined;
    const tooltip = controller ? `${sessionDisplayName(session)} is controlling this tab` : `Used by ${sessionDisplayName(session)}`;
    return new vscode.FileDecoration(session.badge, tooltip, new vscode.ThemeColor(session.color.themeColor));
  }

  private updateContextKeys(): void {
    const active = vscode.window.activeBrowserTab;
    const record = active ? this.records.get(active) : undefined;
    const controlled = !!record?.id && !!this.services.tabLeases.holder(record.id);
    void vscode.commands.executeCommand('setContext', 'copane.browser.activeTabControlled', controlled);
    void vscode.commands.executeCommand('setContext', 'copane.browser.activeTabPaused', !!record?.paused);
  }

  private columnOf(record: TabRecord): vscode.ViewColumn | undefined {
    // Browser editors are opaque to the tabs API (no input), so match by label. The API's title is the
    // editor's long title, "<page title> (<url>)"; the tab label is the page title.
    // Without a page title the label is the host.
    const labels = new Set([record.tab.title, pageTitle(record.tab.title, record.tab.url) || hostOf(record.tab.url)]);
    const matches = (label: string) => labels.has(label);
    const groups = vscode.window.tabGroups.all.filter(g => g.tabs.some(t => t.input === undefined && matches(t.label)));
    return groups.length === 1 ? groups[0]!.viewColumn : undefined;
  }

  private describe(record: TabRecord): BrowserTabInfo {
    const { sessions, tabLeases } = this.services;
    const isLive = (id: string | undefined): id is string => !!id && !!sessions.get(id);
    const openedBy = isLive(record.openedBy) ? record.openedBy : undefined;
    const allowed = new Set(this.consent.allowedSessions(record.id, record.tab.url).filter(isLive));
    if (openedBy) allowed.add(openedBy);
    return {
      id: record.id,
      url: record.tab.url,
      title: pageTitle(record.tab.title, record.tab.url),
      active: vscode.window.activeBrowserTab === record.tab,
      origin: record.origin,
      openedBy,
      controlledBy: tabLeases.holder(record.id)?.sessionId,
      allowedSessions: [...allowed],
      paused: record.paused,
      viewId: record.viewId,
      openerTab: record.openerTab,
    };
  }

  /** Throws the "not enabled" ToolError when the proposed browser API is off. */
  assertAvailable(): void {
    if (!this.available) throw new ToolError('unavailable', NOT_ENABLED);
  }
}

/** Accepts "tab-3", "3" and " tab-3 ". */
export function normalizeTabId(value: string): string {
  const v = value.trim();
  return /^\d+$/.test(v) ? `tab-${v}` : v;
}

export function userTabsSetting(): UserTabsSetting {
  const value = config().get<string>('userTabs', 'ask');
  return value === 'allow' || value === 'deny' ? value : 'ask';
}

export function leaseIdleSeconds(): number {
  const value = config().get<number>('leaseIdleSeconds', 120);
  return Number.isFinite(value) && value >= 5 ? value : 120;
}

async function raceAnswer(promise: Promise<void>, timeoutMs: number, signal: AbortSignal | undefined): Promise<'answered' | 'timeout' | 'aborted'> {
  if (signal?.aborted) return 'aborted';
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise.then(() => 'answered' as const),
      new Promise<'timeout'>(resolve => (timer = setTimeout(() => resolve('timeout'), timeoutMs))),
      new Promise<'aborted'>(resolve => {
        onAbort = () => resolve('aborted');
        signal?.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
