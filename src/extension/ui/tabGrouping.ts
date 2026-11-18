// "Collapse a session's tabs": the half that touches VS Code. Reads the browser tabs and the editor
// tab bar, asks tabGroups.ts what to pin or unpin, and runs that with VS Code's own pin commands on
// each tab's resource (`vscode-browser:/<viewId>`), which act on that tab wherever it is, without
// activating it, focusing it or reloading its page. Runs one plan at a time; changes of tabs, leases,
// sessions and the tab bar are coalesced into the next one. Remembers per window (workspace state)
// which sessions are collapsed and which tabs Copane pinned, and reconciles after a reload.
import * as vscode from 'vscode';
import type { BridgeServices, BrowserTabInfo } from '../core/services';
import { scopedLogger, type Logger } from '../core/log';
import { Coalescer } from './coalescer';
import { ContextKey } from './ids';
import { hostOf, tabTitle } from './model';
import { tabOwner } from './panelModel';
import type { UiSources } from './sources';
import {
  applyOps,
  collapsedCounts,
  collapseOthers,
  EMPTY_GROUPING,
  expandAll,
  isEmptyGrouping,
  matchStrip,
  planGroupBySession,
  planGrouping,
  setCollapsed,
  type GroupingPlan,
  type GroupingState,
  type GroupingTab,
  type PinOp,
  type StripEntry,
} from './tabGroups';

const STATE_KEY = 'copane.ui.tabGroups';
/** How long after activation a tab Copane pinned that shows up unpinned is taken as a pin the reload lost. */
const RESTORE_MS = 20_000;
const BROWSER_SCHEME = 'vscode-browser';
const USE_COMPACT = 'Use Compact Pinned Tabs';
const KEEP_SIZE = 'Keep Current Size';

export type SizingChoice = 'ask' | 'compact' | 'keep';

interface Snapshot {
  tabs: GroupingTab[];
  sessions: string[];
  infos: BrowserTabInfo[];
}

export class TabGrouping implements vscode.Disposable {
  private state: GroupingState;
  private restoring: boolean;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly coalescer = new Coalescer(() => void this.run(() => this.reconcile()), 100);
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly emitter = new vscode.EventEmitter<void>();
  private readonly decorationEmitter = new vscode.EventEmitter<vscode.Uri[]>();
  private readonly log: Logger;
  private counts = new Map<string, number>();
  private lastSnapshot: Snapshot = { tabs: [], sessions: [], infos: [] };
  /** Tabs Copane tried to attach to learn their view id (once each). */
  private readonly attachTried = new Set<string>();
  private contextKeys = '';
  private contextKeyValues: { collapsibleTabs: string[]; collapsedTabs: string[] } = { collapsibleTabs: [], collapsedTabs: [] };
  private decorated = new Set<string>();

  /** The collapsed sessions or the tabs Copane pinned changed. */
  readonly onDidChange = this.emitter.event;
  readonly onDidChangeFileDecorations = this.decorationEmitter.event;

  constructor(
    private readonly services: BridgeServices,
    private readonly sources: UiSources,
  ) {
    this.log = scopedLogger(services.log, 'ui');
    this.state = parseState(services.context.workspaceState.get(STATE_KEY));
    this.restoring = !isEmptyGrouping(this.state);
    if (this.restoring) {
      const timer = setTimeout(() => {
        this.restoring = false;
        this.schedule();
      }, RESTORE_MS);
      this.subscriptions.push({ dispose: () => clearTimeout(timer) });
    }
    this.subscriptions.push(
      ...sources.subscribe(() => this.schedule()).map(d => ({ dispose: () => d.dispose() })),
      vscode.window.tabGroups.onDidChangeTabs(() => this.schedule()),
      vscode.window.tabGroups.onDidChangeTabGroups(() => this.schedule()),
      vscode.window.registerFileDecorationProvider(this),
      this.emitter,
      this.decorationEmitter,
    );
    this.schedule();
  }

  // ----------------------------------------------------------------------------- reading

  /** Collapsed sessions and how many of their tabs are collapsed, as of the last reconcile. */
  collapsedSessions(): ReadonlyMap<string, number> {
    return this.counts;
  }

  isCollapsed(sessionId: string): boolean {
    return this.state.collapsed.includes(sessionId);
  }

  /** What `debug_ui_state` shows: the state and each tab as the planner sees it. */
  debugState(): unknown {
    const snap = this.snapshot();
    return {
      collapsed: this.state.collapsed,
      pinnedByUs: this.state.pinnedByUs,
      optedOut: this.state.optedOut,
      restoring: this.restoring,
      counts: Object.fromEntries(this.counts),
      contextKeys: this.contextKeyValues,
      tabs: snap.tabs.map(t => ({ ...t, pinnedByUs: this.state.pinnedByUs.includes(t.tabId) })),
    };
  }

  /** The session a browser editor's resource (`vscode-browser:/<viewId>`) is shown under, if any. */
  ownerOfResource(uri: vscode.Uri): { tabId: string; sessionId: string | undefined } | undefined {
    const viewId = viewIdOf(uri);
    const tab = viewId ? this.sources.tabs().find(t => t.viewId === viewId) : undefined;
    return tab && { tabId: tab.id, sessionId: tabOwner(tab, this.services.sessions.list())?.id };
  }

  /** The session a tab is shown under. */
  ownerOfTab(tabId: string): string | undefined {
    const tab = this.sources.tabs().find(t => t.id === tabId);
    return tab && tabOwner(tab, this.services.sessions.list())?.id;
  }

  /** How many browser tabs each live session is shown with (the ones a collapse would pin). */
  tabCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    const sessions = this.services.sessions.list();
    for (const tab of this.sources.tabs()) {
      const owner = tabOwner(tab, sessions);
      if (owner) counts.set(owner.id, (counts.get(owner.id) ?? 0) + 1);
    }
    return counts;
  }

  // ----------------------------------------------------------------------------- commands

  collapse(sessionId: string): Promise<void> {
    return this.change(snap => setCollapsed(this.state, sessionId, true, snap.tabs));
  }

  expand(sessionId: string): Promise<void> {
    return this.change(snap => setCollapsed(this.state, sessionId, false, snap.tabs));
  }

  collapseOthers(sessionId: string): Promise<void> {
    return this.change(snap => collapseOthers(this.state, sessionId, snap.sessions, snap.tabs));
  }

  expandAll(): Promise<void> {
    return this.change(() => expandAll(this.state));
  }

  /** Every session's tabs side by side, nothing collapsed. */
  groupBySession(): Promise<void> {
    return this.run(async () => {
      this.restoring = false;
      const snap = this.snapshot();
      await this.execute(planGroupBySession({ sessions: snap.sessions, tabs: snap.tabs, state: this.state }));
    });
  }

  /**
   * Whether collapsing shows: one sentence for the command's message when it does not, or does less
   * than it could. Asks once (setting `copane.ui.collapsedTabSizing`) whether to make pinned tabs
   * compact; changes `workbench.editor.pinnedTabSizing` in the user's settings only with that consent.
   */
  async prepareSizing(): Promise<string | undefined> {
    const editor = vscode.workspace.getConfiguration('workbench.editor');
    const showTabs = editor.get<string>('showTabs', 'multiple');
    if (showTabs !== 'multiple') {
      return `The editor shows ${showTabs === 'single' ? 'only the active tab' : 'no tabs'} (workbench.editor.showTabs is "${showTabs}"), so collapsed tabs look no different there.`;
    }
    if (editor.get<boolean>('pinnedTabsOnSeparateRow', false)) {
      return 'Pinned tabs are on their own row (workbench.editor.pinnedTabsOnSeparateRow), so collapsed tabs move there and save room only with compact pinned tabs.';
    }
    const sizing = editor.get<string>('pinnedTabSizing', 'normal');
    if (sizing === 'compact') return undefined;
    const ui = vscode.workspace.getConfiguration('copane.ui');
    let choice = ui.get<SizingChoice>('collapsedTabSizing', 'ask');
    if (choice === 'ask') {
      const answer = await this.services.prompts.ask({
        message: 'Make pinned tabs compact, so collapsed tabs show as their site icon only?',
        detail: `Copane collapses a session's tabs by pinning them. This sets "workbench.editor.pinnedTabSizing" to "compact" in your user settings, which applies to all pinned tabs in VS Code, your own too. Your answer is kept in the setting "copane.ui.collapsedTabSizing".`,
        choices: [USE_COMPACT, KEEP_SIZE],
        modal: true,
      });
      if (answer === USE_COMPACT) choice = 'compact';
      else if (answer === KEEP_SIZE) choice = 'keep';
      if (choice !== 'ask') await ui.update('collapsedTabSizing', choice, vscode.ConfigurationTarget.Global);
    }
    if (choice === 'compact') {
      await editor.update('pinnedTabSizing', 'compact', vscode.ConfigurationTarget.Global);
      return undefined;
    }
    return sizing === 'shrink'
      ? 'Pinned tabs are "shrink" size (workbench.editor.pinnedTabSizing), so collapsed tabs save only some room.'
      : 'Pinned tabs are full size (workbench.editor.pinnedTabSizing is "normal"), so collapsed tabs are grouped at the left but take as much room as before.';
  }

  // ----------------------------------------------------------------------------- FileDecorationProvider

  /** Adds "collapsed with <session>" to the hover of a collapsed tab, which shows only its site icon. */
  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const viewId = viewIdOf(uri);
    const tab = viewId ? this.lastSnapshot.tabs.find(t => t.viewId === viewId) : undefined;
    if (!tab || !this.state.pinnedByUs.includes(tab.tabId)) return undefined;
    const session = tab?.ownerId ? this.services.sessions.get(tab.ownerId) : undefined;
    if (!session) return undefined;
    return new vscode.FileDecoration(undefined, `Collapsed with ${session.label}${session.title ? ` (${session.title})` : ''}'s tabs`);
  }

  // ----------------------------------------------------------------------------- running

  private schedule(): void {
    if (isEmptyGrouping(this.state) && this.counts.size === 0 && !this.decorated.size) {
      this.updateContextKeys();
      return;
    }
    this.coalescer.schedule();
  }

  /** Runs `fn` after everything queued before it. Never rejects. */
  private run(fn: () => Promise<void>): Promise<void> {
    const next = this.queue.then(fn).catch(err => this.log.warn(`tab grouping failed: ${err instanceof Error ? err.message : String(err)}`));
    this.queue = next;
    return next;
  }

  private change(update: (snap: Snapshot) => GroupingState): Promise<void> {
    return this.run(async () => {
      const before = JSON.stringify(this.state);
      this.state = update(this.snapshot());
      // Saved here too: a session with no tab to pin or unpin changes only its collapsed flag, which
      // reconcile would not see as a change.
      if (JSON.stringify(this.state) !== before) this.persist();
      await this.reconcile();
    });
  }

  private async reconcile(): Promise<void> {
    let snap = this.snapshot();
    if (await this.learnViewIds(snap)) snap = this.snapshot();
    await this.execute(planGrouping({ sessions: snap.sessions, tabs: snap.tabs, state: this.state, restoring: this.restoring }));
  }

  /** Attaches (once) to tabs of collapsed sessions whose view id is not known yet. */
  private async learnViewIds(snap: Snapshot): Promise<boolean> {
    const attach = this.services.browser.attach?.bind(this.services.browser);
    if (!attach) return false;
    const collapsed = new Set(this.state.collapsed);
    const missing = snap.tabs.filter(t => !t.viewId && t.ownerId && collapsed.has(t.ownerId) && !this.attachTried.has(t.tabId));
    for (const t of missing) {
      this.attachTried.add(t.tabId);
      await attach(t.tabId).catch(err => this.log.info(`could not attach to ${t.tabId} to find its editor: ${String(err)}`));
    }
    return missing.length > 0;
  }

  private async execute(plan: GroupingPlan): Promise<void> {
    const succeeded: PinOp[] = [];
    for (const op of plan.ops) {
      // A pin command whose resource matches no editor acts on the active editor instead, so only
      // run it for a tab that is still open.
      if (!this.sources.tabs().some(t => t.viewId === op.viewId)) {
        this.log.info(`not ${op.op}ning ${op.tabId}: it closed`);
        continue;
      }
      try {
        await vscode.commands.executeCommand(op.op === 'pin' ? 'workbench.action.pinEditor' : 'workbench.action.unpinEditor', browserViewUri(op.viewId));
        succeeded.push(op);
      } catch (err) {
        this.log.warn(`could not ${op.op} ${op.tabId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (plan.ops.length) this.log.debug(`tab grouping: ${succeeded.map(o => `${o.op} ${o.tabId}`).join(', ')}`);
    const before = JSON.stringify(this.state);
    this.state = { ...plan.state, pinnedByUs: applyOps(plan.base, succeeded) };
    if (JSON.stringify(this.state) !== before) this.persist();
    this.refreshDerived();
  }

  private refreshDerived(): void {
    this.lastSnapshot = this.snapshot();
    const counts = collapsedCounts(this.lastSnapshot.tabs, this.state);
    const changed = JSON.stringify([...counts]) !== JSON.stringify([...this.counts]);
    this.counts = counts;
    const pinned = new Set(this.state.pinnedByUs);
    const decorated = new Set(this.lastSnapshot.tabs.filter(t => t.viewId && pinned.has(t.tabId)).map(t => t.viewId!));
    const touched = [...new Set([...decorated, ...this.decorated])];
    this.decorated = decorated;
    if (touched.length) this.decorationEmitter.fire(touched.map(browserViewUri));
    this.updateContextKeys();
    if (changed) this.emitter.fire();
  }

  /** View ids for `resourceFilename in copane.ui.collapsibleTabs` / `collapsedTabs` in the editor tab's context menu. */
  private updateContextKeys(): void {
    const sessions = this.services.sessions.list();
    const collapsible: string[] = [];
    const collapsed: string[] = [];
    for (const tab of this.sources.tabs()) {
      if (!tab.viewId) continue;
      const owner = tabOwner(tab, sessions);
      if (!owner) continue;
      (this.state.collapsed.includes(owner.id) ? collapsed : collapsible).push(tab.viewId);
    }
    const key = JSON.stringify([collapsible, collapsed]);
    if (key === this.contextKeys) return;
    this.contextKeys = key;
    this.contextKeyValues = { collapsibleTabs: collapsible, collapsedTabs: collapsed };
    void vscode.commands.executeCommand('setContext', ContextKey.collapsibleTabs, collapsible);
    void vscode.commands.executeCommand('setContext', ContextKey.collapsedTabs, collapsed);
  }

  private persist(): void {
    void Promise.resolve(this.services.context.workspaceState.update(STATE_KEY, isEmptyGrouping(this.state) ? undefined : this.state)).then(undefined, err =>
      this.log.warn(`could not save the collapsed sessions: ${String(err)}`),
    );
  }

  private snapshot(): Snapshot {
    const infos = this.sources.tabs();
    const sessions = this.services.sessions.list();
    const entries: StripEntry[] = [];
    for (const group of vscode.window.tabGroups.all) {
      group.tabs.forEach((t, index) => {
        if (t.input === undefined) entries.push({ label: t.label, pinned: t.isPinned, group: group.viewColumn, index });
      });
    }
    const strip = matchStrip(
      infos.map(t => ({ tabId: t.id, labels: [t.title, tabTitle(t), hostOf(t.url) ?? ''] })),
      entries,
    );
    const tabs = infos.map(t => ({
      tabId: t.id,
      viewId: t.viewId,
      ownerId: tabOwner(t, sessions)?.id,
      waiting: t.request ? true : undefined,
      ...strip.get(t.id),
    }));
    return { tabs, sessions: sessions.map(s => s.id), infos };
  }

  dispose(): void {
    this.coalescer.dispose();
    for (const s of this.subscriptions.splice(0)) s.dispose();
  }
}

function browserViewUri(viewId: string): vscode.Uri {
  return vscode.Uri.from({ scheme: BROWSER_SCHEME, path: `/${viewId}` });
}

function viewIdOf(uri: vscode.Uri): string | undefined {
  if (uri.scheme !== BROWSER_SCHEME) return undefined;
  return uri.path.replace(/^\//, '') || undefined;
}

function parseState(value: unknown): GroupingState {
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  if (!value || typeof value !== 'object') return { ...EMPTY_GROUPING };
  const v = value as Record<string, unknown>;
  return { collapsed: strings(v.collapsed), pinnedByUs: strings(v.pinnedByUs), optedOut: strings(v.optedOut) };
}
