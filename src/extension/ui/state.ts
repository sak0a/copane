// Keeps the current view model and rebuilds it, coalesced, whenever a session, tab, lease or terminal
// changes. Listeners only hear about updates that change something on screen.
import * as vscode from 'vscode';
import type { BridgeServices } from '../core/services';
import { Coalescer } from './coalescer';
import { FaviconCache, type FaviconCheck } from './favicon';
import { buildViewModel, chromeSignature, diffModels, tabBelongsTo, type UiInput, type ViewModel } from './model';
import { buildPanelModel, type PanelModel } from './panelModel';
import type { UiSources } from './sources';

export interface UiUpdate {
  model: ViewModel;
  /** The tree must be refreshed from the root. */
  full: boolean;
  /** Ids of tree nodes whose row or children changed. */
  changed: string[];
  /** Status bar, badge, view description or attention list changed. */
  chromeChanged: boolean;
}

/** An update of the Agent Tabs panel view. Only fired when a row or the description changed. */
export interface PanelUpdate {
  model: PanelModel;
  full: boolean;
  changed: string[];
  descriptionChanged: boolean;
}

export class UiState implements vscode.Disposable {
  private current: ViewModel;
  private currentPanel: PanelModel;
  private readonly emitter = new vscode.EventEmitter<UiUpdate>();
  private readonly panelEmitter = new vscode.EventEmitter<PanelUpdate>();
  private readonly coalescer: Coalescer;
  private readonly subscriptions: Array<{ dispose(): void }> = [];
  private readonly favicons = new FaviconCache();
  /** The checked site icon (or why it is not shown) of each listed tab, as of the last rebuild. */
  private iconChecks = new Map<string, FaviconCheck>();
  /** Icons refused, already logged (by reason and URI length), so a refresh does not log them again. */
  private readonly loggedRefusals = new Set<string>();

  /** The collapsed sessions (tabGrouping.ts), set once that exists. */
  private collapsedSessions: (() => ReadonlyMap<string, number>) | undefined;

  readonly onDidUpdate = this.emitter.event;
  readonly onDidUpdatePanel = this.panelEmitter.event;

  constructor(
    private readonly services: BridgeServices,
    readonly sources: UiSources,
  ) {
    const input = this.input();
    this.current = buildViewModel(input);
    this.currentPanel = buildPanelModel(input);
    this.coalescer = new Coalescer(() => this.rebuild());
    this.subscriptions.push(
      ...sources.subscribe(() => this.coalescer.schedule()),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('copane.sessionGraceSeconds') || e.affectsConfiguration('copane.ui.favicons')) this.coalescer.schedule();
      }),
    );
  }

  /** Where the views read which sessions are collapsed; rebuilds with it. */
  setCollapsedSessions(provider: () => ReadonlyMap<string, number>): void {
    this.collapsedSessions = provider;
    this.refresh();
  }

  /** Rebuilds soon (coalesced), for a change no source event reports. */
  refresh(): void {
    this.coalescer.schedule();
  }

  get model(): ViewModel {
    return this.current;
  }

  get panel(): PanelModel {
    return this.currentPanel;
  }

  /** Applies pending changes now, so a command acts on what is on screen and the latest state. */
  flush(): ViewModel {
    this.coalescer.flushNow();
    return this.current;
  }

  /** Like `flush`, for the panel view. */
  flushPanel(): PanelModel {
    this.coalescer.flushNow();
    return this.currentPanel;
  }

  /** The `data:` URI of a site icon key in the current models (see `ViewIcon.image`). */
  imageUri(key: string): string | undefined {
    return this.favicons.uriOf(key);
  }

  /** The site icon state of each listed tab: its key, or why it is not shown (debug tool). */
  iconStates(): Record<string, { key: string; mime: string; bytes: number } | { refused: string }> {
    const out: Record<string, { key: string; mime: string; bytes: number } | { refused: string }> = {};
    for (const [tabId, c] of this.iconChecks) out[tabId] = c.ok ? { key: c.key, mime: c.mime, bytes: c.bytes } : { refused: c.reason };
    return out;
  }

  input(): UiInput {
    const sessions = this.services.sessions.list();
    const tabs = this.sources.tabs();
    return {
      sessions,
      tabs,
      tabIcons: this.tabIcons(tabs, sessions),
      terminals: this.sources.terminals(),
      browserAvailable: this.sources.browserAvailable,
      graceSeconds: Math.max(0, vscode.workspace.getConfiguration('copane').get<number>('sessionGraceSeconds', 20)),
      sessionProfiles: this.sources.sessionProfiles(sessions.map(s => s.id)),
      collapsedSessions: this.collapsedSessions?.(),
    };
  }

  /**
   * Site icons of the tabs the views list (tabs some session uses), read from what VS Code already shows
   * and checked once per distinct icon (cached). Tabs no longer listed drop out of the cache.
   */
  private tabIcons(tabs: UiInput['tabs'], sessions: UiInput['sessions']): Map<string, string> | undefined {
    const checks = new Map<string, FaviconCheck>();
    const inUse = new Set<string>();
    const enabled = vscode.workspace.getConfiguration('copane.ui').get<boolean>('favicons', true);
    if (enabled) {
      for (const tab of tabs) {
        if (!sessions.some(s => tabBelongsTo(tab, s.id))) continue;
        const uri = this.sources.tabIcon(tab.id);
        if (!uri) continue;
        inUse.add(uri);
        const check = this.favicons.get(uri);
        checks.set(tab.id, check);
        if (!check.ok) this.logRefusal(tab.id, check.reason, uri.length);
      }
    }
    this.favicons.retain(inUse);
    this.iconChecks = checks;
    if (!enabled) return undefined;
    const keys = new Map<string, string>();
    for (const [tabId, c] of checks) if (c.ok) keys.set(tabId, c.key);
    return keys;
  }

  private logRefusal(tabId: string, reason: string, length: number): void {
    const key = `${reason}|${length}`;
    if (this.loggedRefusals.has(key)) return;
    if (this.loggedRefusals.size > 200) this.loggedRefusals.clear();
    this.loggedRefusals.add(key);
    this.services.log.info(`UI: the site icon of ${tabId} is not shown (${reason}); the views show the generic icon.`);
  }

  private rebuild(): void {
    const input = this.input();
    const prev = this.current;
    const next = buildViewModel(input);
    this.current = next;
    const diff = diffModels(prev, next);
    const chromeChanged = chromeSignature(prev) !== chromeSignature(next);

    const prevPanel = this.currentPanel;
    const nextPanel = buildPanelModel(input);
    this.currentPanel = nextPanel;
    const panelDiff = diffModels(prevPanel, nextPanel);
    const descriptionChanged = prevPanel.description !== nextPanel.description;

    if (diff.full || diff.changed.length || chromeChanged) this.emitter.fire({ model: next, full: diff.full, changed: diff.changed, chromeChanged });
    if (panelDiff.full || panelDiff.changed.length || descriptionChanged) {
      this.panelEmitter.fire({ model: nextPanel, full: panelDiff.full, changed: panelDiff.changed, descriptionChanged });
    }
  }

  dispose(): void {
    this.coalescer.dispose();
    for (const s of this.subscriptions.splice(0)) s.dispose();
    this.emitter.dispose();
    this.panelEmitter.dispose();
  }
}
