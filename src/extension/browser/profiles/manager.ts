// Login profiles: separate in-memory login stores for groups of browser tabs (see model.ts for what a
// profile is and how long it lives, browserTarget.ts for the CDP calls).
//
// Copane keeps one "host" CDP session open on the browser target for as long as the extension runs. It
// creates every profile's browser context, which keeps each profile usable after its last tab closes.
// When the host is gone (window reload, extension host restart), a profile is still reached through
// any of its open tabs: a session started from such a tab may open more tabs in the tab's context.
import * as vscode from 'vscode';
import { ToolError } from '../../core/errors';
import { Emitter } from '../../core/events';
import { scopedLogger, type Logger } from '../../core/log';
import type { BridgeServices, BrowserTabInfo } from '../../core/services';
import { sessionDisplayName, type AgentSession } from '../../core/sessions';
import { browserViewUri, viewIdOf } from '../decorations';
import type { BrowserServiceImpl } from '../service';
import { BrowserTargetSession, identifyTab, isUnknownContext } from './browserTarget';
import {
  agentMayUseDefault,
  classifyRestoredTab,
  DEFAULT_PROFILE,
  isPrivate,
  LIFETIME,
  LOST,
  parseProfileName,
  parseProfiles,
  privateKey,
  privateOwner,
  profileLabel,
  resolveProfile,
  touchRecent,
  type AgentLoginStoreSetting,
  type LostReason,
  type PersistedProfiles,
  type SessionDefaults,
} from './model';

const STATE_KEY = 'copane.browser.profiles';
const NEW_TAB_WAIT_MS = 8_000;

interface ProfileTab {
  profile: string;
  contextId: string;
  viewId: string | undefined;
  /** No longer in `profile`: VS Code restarted and gave it a store of its own. */
  detached: boolean;
}

interface ProfileContext {
  contextId: string;
  /** Created by the current host session, so it stays usable without open tabs. */
  owned: boolean;
}

export interface OpenedInProfile {
  tab: vscode.BrowserTab;
  profile: string;
  /** The profile had no login store yet (or its old one was gone): the tab starts logged out. */
  fresh: boolean;
  lost: LostReason | undefined;
}

export function agentLoginStoreSetting(): AgentLoginStoreSetting {
  return vscode.workspace.getConfiguration('copane.browser').get<string>('agentLoginStore', 'shared') === 'private' ? 'private' : 'shared';
}

export class ProfileManager implements vscode.Disposable {
  private host: BrowserTargetSession | undefined;
  private hosting: Promise<BrowserTargetSession> | undefined;
  private readonly contexts = new Map<string, ProfileContext>();
  private readonly lost = new Map<string, LostReason>();
  private readonly tabs = new Map<vscode.BrowserTab, ProfileTab>();
  private readonly defaults = new Map<string, SessionDefaults>();
  private recent: string[] = [];
  /** One open at a time per profile, so two calls never create two stores for one name. */
  private readonly queues = new Map<string, Promise<unknown>>();
  /** What `browser_open` should tell the agent about a tab it just opened. */
  private readonly notes = new Map<vscode.BrowserTab, string>();
  private readonly changeEmitter = new Emitter<void>();
  private readonly decorationEmitter = new vscode.EventEmitter<vscode.Uri[]>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly log: Logger;
  private persistTimer: NodeJS.Timeout | undefined;
  private restoring = true;
  readonly ready: Promise<void>;
  readonly onDidChange = this.changeEmitter.event;

  constructor(
    private readonly services: BridgeServices,
    private readonly browser: BrowserServiceImpl,
  ) {
    this.log = scopedLogger(services.log, 'profiles');
    const state = parseProfiles(services.context.workspaceState.get(STATE_KEY));
    for (const [id, d] of Object.entries(state.defaults)) this.defaults.set(id, d);
    this.recent = state.recent;
    this.subscriptions.push(
      vscode.window.registerFileDecorationProvider({
        onDidChangeFileDecorations: this.decorationEmitter.event,
        provideFileDecoration: uri => this.decorationFor(uri),
      }),
      this.decorationEmitter,
      vscode.window.onDidCloseBrowserTab(tab => this.onClosed(tab)),
      browser.onDidOpenTab!(info => void this.onOpened(info)),
      services.sessions.onDidChange(change => {
        if (change.type !== 'removed') return;
        if (this.defaults.delete(change.session.id)) this.changed();
      }),
    );
    browser.addTabInfoProvider(tabId => {
      const profile = this.describeTab(tabId);
      return profile ? { profile } : undefined;
    });
    this.ready = this.restore(state);
  }

  // ------------------------------------------------------------------ opening tabs

  /**
   * `BrowserServiceImpl.opener`: decides the profile of a tab an agent opens and opens it there, or
   * returns undefined for the window's default store.
   */
  async openForAgent(session: AgentSession, url: string, options: { background?: boolean; profile?: string }): Promise<vscode.BrowserTab | undefined> {
    await this.ready;
    let explicit: string | undefined;
    if (options.profile !== undefined && options.profile.trim() !== '') {
      const parsed = parseProfileName(options.profile, session.id);
      if (!parsed.ok) throw new ToolError('invalid_input', parsed.message);
      explicit = parsed.key;
    }
    const setting = agentLoginStoreSetting();
    const { key, source } = resolveProfile({ sessionId: session.id, explicit, defaults: this.defaults.get(session.id), setting });
    if (key === DEFAULT_PROFILE) {
      if (!agentMayUseDefault(setting, source)) {
        throw new ToolError(
          'access_denied',
          "The user's setting copane.browser.agentLoginStore is \"private\": agent sessions do not open tabs in the window's default login store. Leave out `profile` (your tab opens in your private profile) or name a profile.",
        );
      }
      return undefined;
    }
    const opened = await this.open(key, url);
    const others = this.tabIdsOf(key).filter(id => id !== this.browser.tabIdOf(opened.tab));
    this.notes.set(opened.tab, this.openNote(opened, session, source, others, !!options.background));
    return opened.tab;
  }

  /** The sentence `browser_open` adds for a tab opened in a profile (once). */
  takeNote(tabId: string): string | undefined {
    const tab = this.browser.browserTabOf(tabId);
    if (!tab) return undefined;
    const note = this.notes.get(tab);
    this.notes.delete(tab);
    return note;
  }

  /** Opens `url` in a new tab of profile `key` (not the default store). */
  open(key: string, url: string): Promise<OpenedInProfile> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.then(
      () => this.openNow(key, url),
      () => this.openNow(key, url),
    );
    this.queues.set(key, next);
    void next.finally(() => {
      if (this.queues.get(key) === next) this.queues.delete(key);
    }).catch(() => {});
    return next;
  }

  private async openNow(key: string, url: string): Promise<OpenedInProfile> {
    await this.ready;
    const existing = this.contexts.get(key);
    if (existing) {
      try {
        const tab = await this.openInContext(key, existing, url);
        return { tab, profile: key, fresh: false, lost: undefined };
      } catch (err) {
        if (!isUnknownContext(err)) throw this.failure(err);
        this.log.info(`profile ${key}: its login store is gone (${errorText(err)}); starting a new one`);
        this.contexts.delete(key);
        this.lost.set(key, this.lost.get(key) ?? 'unreachable');
      }
    }
    try {
      const host = await this.ensureHost();
      const contextId = await host.createContext();
      this.contexts.set(key, { contextId, owned: true });
      const lost = this.lost.get(key);
      this.lost.delete(key);
      this.recent = touchRecent(this.recent, key);
      this.log.info(`profile ${key}: new login store ${contextId}`);
      const tab = await this.createTab(host, key, contextId, url);
      return { tab, profile: key, fresh: true, lost };
    } catch (err) {
      throw this.failure(err);
    }
  }

  private async openInContext(key: string, context: ProfileContext, url: string): Promise<vscode.BrowserTab> {
    this.recent = touchRecent(this.recent, key);
    if (context.owned && this.host && !this.host.closed) {
      try {
        return await this.createTab(this.host, key, context.contextId, url);
      } catch (err) {
        if (!isUnknownContext(err)) throw err;
        context.owned = false;
      }
    }
    // Any open tab of the profile can open more tabs in its store.
    const member = [...this.tabs].find(([, t]) => t.contextId === context.contextId && !t.detached)?.[0];
    if (!member) throw new Error(`Unknown browser context ${context.contextId}`);
    const session = await BrowserTargetSession.start(member);
    try {
      return await this.createTab(session, key, context.contextId, url);
    } finally {
      session.close();
    }
  }

  private async createTab(session: BrowserTargetSession, key: string, contextId: string, url: string): Promise<vscode.BrowserTab> {
    const before = new Set(vscode.window.browserTabs);
    const { viewId } = await session.createTab(url, contextId);
    const tab = await this.findNewTab(before, viewId);
    this.tabs.set(tab, { profile: key, contextId, viewId, detached: false });
    this.changed(viewId);
    return tab;
  }

  /** The tab VS Code opened for a target just created: the new one with that view id. */
  private async findNewTab(before: ReadonlySet<vscode.BrowserTab>, viewId: string | undefined): Promise<vscode.BrowserTab> {
    const checked = new Set<vscode.BrowserTab>();
    const deadline = Date.now() + NEW_TAB_WAIT_MS;
    while (Date.now() < deadline) {
      const fresh = vscode.window.browserTabs.filter(t => !before.has(t) && !checked.has(t));
      for (const tab of fresh) {
        if (!viewId) return tab;
        checked.add(tab);
        try {
          if ((await identifyTab(tab)).viewId === viewId) return tab;
        } catch (err) {
          this.log.debug(`could not identify a new tab: ${errorText(err)}`);
        }
      }
      await sleep(100);
    }
    throw new Error('VS Code did not show the new tab');
  }

  private ensureHost(): Promise<BrowserTargetSession> {
    if (this.host && !this.host.closed) return Promise.resolve(this.host);
    this.hosting ??= (async () => {
      let root = vscode.window.browserTabs[0];
      let launcher: vscode.BrowserTab | undefined;
      if (!root) {
        // A browser session can only be started from a tab: open an empty one for a moment.
        launcher = await vscode.window.openBrowserTab('about:blank', { background: true, preserveFocus: true });
        root = launcher;
      }
      try {
        const host = await BrowserTargetSession.start(root);
        host.onDidClose(() => this.onHostClosed(host));
        this.host = host;
        this.log.info('started the browser session that holds login profiles');
        return host;
      } finally {
        // The session outlives the tab it was started from.
        if (launcher) void Promise.resolve(launcher.close()).then(undefined, () => {});
      }
    })().finally(() => (this.hosting = undefined));
    return this.hosting;
  }

  private onHostClosed(host: BrowserTargetSession): void {
    if (this.host !== host) return;
    this.host = undefined;
    this.log.info('the browser session that holds login profiles closed');
    for (const [key, context] of this.contexts) {
      if (!context.owned) continue;
      context.owned = false;
      this.dropIfUnreachable(key);
    }
    this.changed();
  }

  private failure(err: unknown): Error {
    if (err instanceof ToolError) return err;
    return new ToolError('failed', `Could not open a tab in a login profile: ${errorText(err)}. Try again; if it keeps failing, open the tab without \`profile\`.`);
  }

  // ------------------------------------------------------------------ profiles of sessions

  /** Sets (or with `key` undefined clears) a session's default profile, as the user or the agent. */
  setDefault(sessionId: string, key: string | undefined, by: 'user' | 'agent'): void {
    const current = { ...this.defaults.get(sessionId) };
    if (key === undefined) delete current[by];
    else current[by] = key;
    if (current.user === undefined && current.agent === undefined) this.defaults.delete(sessionId);
    else this.defaults.set(sessionId, current);
    if (key) this.recent = touchRecent(this.recent, key);
    this.changed();
  }

  defaultsOf(sessionId: string): SessionDefaults {
    return { ...this.defaults.get(sessionId) };
  }

  /** `BrowserService.sessionProfile`. */
  sessionProfile(sessionId: string): { name: string; label: string; setBy: 'user' | 'agent' | 'setting' } | undefined {
    const { key, source } = resolveProfile({ sessionId, defaults: this.defaults.get(sessionId), setting: agentLoginStoreSetting() });
    if (source === 'argument') return undefined;
    if (key === DEFAULT_PROFILE && source === 'setting') return undefined;
    return { name: key, label: this.label(key), setBy: source };
  }

  // ------------------------------------------------------------------ what there is

  /** Every profile Copane knows in this window: with a store, with tabs, lost, recently used, or a session default. */
  list(): Array<{ key: string; label: string; tabIds: string[]; alive: boolean; keptWithoutTabs: boolean; lost: LostReason | undefined }> {
    const keys = new Set<string>([...this.contexts.keys(), ...this.lost.keys(), ...this.recent]);
    for (const t of this.tabs.values()) if (!t.detached) keys.add(t.profile);
    for (const d of this.defaults.values()) for (const k of [d.user, d.agent]) if (k && k !== DEFAULT_PROFILE) keys.add(k);
    return [...keys]
      .sort((a, b) => Number(isPrivate(a)) - Number(isPrivate(b)) || a.localeCompare(b))
      .map(key => {
        const context = this.contexts.get(key);
        return {
          key,
          label: this.label(key),
          tabIds: this.tabIdsOf(key),
          alive: !!context,
          keptWithoutTabs: !!context?.owned && !!this.host && !this.host.closed,
          lost: context ? undefined : this.lost.get(key),
        };
      });
  }

  tabIdsOf(key: string): string[] {
    const context = this.contexts.get(key);
    const ids: string[] = [];
    for (const [tab, t] of this.tabs) {
      if (t.detached || t.profile !== key || (context && t.contextId !== context.contextId)) continue;
      const id = this.browser.tabIdOf(tab);
      if (id) ids.push(id);
    }
    return ids.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }

  /** The profile part of a tab's info, or undefined for the default store. */
  describeTab(tabId: string): BrowserTabInfo['profile'] {
    const tab = this.browser.browserTabOf(tabId);
    const t = tab && this.tabs.get(tab);
    if (!t) return undefined;
    const label = this.label(t.profile);
    if (t.detached) {
      return {
        name: t.profile,
        label: 'own login store',
        kind: 'detached',
        description: `Has a login store of its own, empty after VS Code restarted: it was in the login profile "${label}" before, and profiles do not survive a restart. It shares logins with no other tab.`,
      };
    }
    if (isPrivate(t.profile)) {
      return {
        name: t.profile,
        label,
        kind: 'private',
        description: `In the login profile ${label}: its cookies and logins are shared only with that session's other private tabs, not with the default store. ${LIFETIME}`,
      };
    }
    return {
      name: t.profile,
      label,
      kind: 'named',
      description: `In the login profile "${label}": its cookies and logins are shared only with other tabs of "${label}", not with the default store. ${LIFETIME}`,
    };
  }

  /** `BrowserServiceImpl.markerNote`: what the in-page indicator adds to the session's label. */
  markerNote(tabId: string): string | undefined {
    const profile = this.describeTab(tabId);
    if (!profile) return undefined;
    if (profile.kind === 'detached') return 'own login store';
    if (profile.kind === 'private') return 'private profile';
    return `profile ${profile.label}`;
  }

  label(key: string): string {
    return profileLabel(key, id => {
      const s = this.services.sessions.get(id);
      return s ? sessionDisplayName(s) : undefined;
    });
  }

  /** Closes a profile: its tabs, and its login store when Copane created it. */
  async closeProfile(key: string): Promise<number> {
    const members = [...this.tabs].filter(([, t]) => t.profile === key && !t.detached).map(([tab]) => tab);
    for (const tab of members) await Promise.resolve(tab.close()).then(undefined, () => {});
    const context = this.contexts.get(key);
    if (context?.owned && this.host && !this.host.closed) {
      await this.host.send('Target.disposeBrowserContext', { browserContextId: context.contextId }).catch(err => this.log.debug(`could not dispose ${key}: ${errorText(err)}`));
    }
    this.contexts.delete(key);
    this.lost.delete(key);
    this.recent = this.recent.filter(k => k !== key);
    for (const [sessionId, d] of this.defaults) {
      if (d.user === key || d.agent === key) this.setDefault(sessionId, undefined, d.user === key ? 'user' : 'agent');
    }
    this.changed();
    return members.length;
  }

  // ------------------------------------------------------------------ tab events

  private async onOpened(info: BrowserTabInfo): Promise<void> {
    const tab = this.browser.browserTabOf(info.id);
    if (!tab || this.tabs.has(tab) || this.contexts.size === 0) return;
    // A tab nobody here opened in a profile, e.g. a popup or `target=_blank` link of a profile tab:
    // it is in the profile when its page is in the profile's store.
    try {
      const { viewId, contextId } = await identifyTab(tab);
      if (!contextId || this.tabs.has(tab)) return;
      const key = [...this.contexts].find(([, c]) => c.contextId === contextId)?.[0];
      if (!key || !vscode.window.browserTabs.includes(tab)) return;
      this.tabs.set(tab, { profile: key, contextId, viewId, detached: false });
      this.log.info(`${info.id} is in profile ${key}`);
      this.changed(viewId);
      this.browser.remark(info.id);
    } catch (err) {
      this.log.debug(`could not tell the profile of ${info.id}: ${errorText(err)}`);
    }
  }

  private onClosed(tab: vscode.BrowserTab): void {
    const t = this.tabs.get(tab);
    this.notes.delete(tab);
    if (!t) return;
    this.tabs.delete(tab);
    if (!t.detached) this.dropIfUnreachable(t.profile);
    this.changed(t.viewId);
  }

  /** A profile whose store nobody can reach any more (no tab, not owned by the host) is lost. */
  private dropIfUnreachable(key: string): void {
    const context = this.contexts.get(key);
    if (!context || context.owned) return;
    if ([...this.tabs.values()].some(t => t.contextId === context.contextId && !t.detached)) return;
    this.contexts.delete(key);
    this.lost.set(key, 'orphaned');
    this.log.info(`profile ${key}: its last tab closed while no browser session of Copane held it; its logins are lost`);
  }

  // ------------------------------------------------------------------ after a reload

  private async restore(state: PersistedProfiles): Promise<void> {
    try {
      await this.browser.ready;
      if (state.tabs.length === 0 && Object.keys(state.contexts).length === 0) return;
      const remembered = new Map(state.tabs.map(t => [t.viewId, t]));
      const knownContexts = new Map(Object.entries(state.contexts).map(([key, contextId]) => [contextId, key]));
      let restarted = false;
      await Promise.race([
        Promise.all(
          vscode.window.browserTabs.map(async tab => {
            try {
              const { viewId, contextId } = await identifyTab(tab);
              const entry = viewId ? remembered.get(viewId) : undefined;
              const kind = classifyRestoredTab(entry, contextId);
              if (kind?.kind === 'detached') {
                if (!entry?.detached) restarted = true;
                this.tabs.set(tab, { profile: kind.formerProfile, contextId: contextId!, viewId, detached: true });
              } else {
                const key = kind?.profile ?? (contextId ? knownContexts.get(contextId) : undefined);
                if (!key || !contextId) return;
                this.tabs.set(tab, { profile: key, contextId, viewId, detached: false });
                if (!this.contexts.has(key)) this.contexts.set(key, { contextId, owned: false });
              }
            } catch (err) {
              this.log.debug(`could not identify a restored tab: ${errorText(err)}`);
            }
          }),
        ),
        sleep(8000),
      ]);
      for (const key of Object.keys(state.contexts)) if (!this.contexts.has(key)) this.lost.set(key, restarted ? 'restart' : 'orphaned');
      this.log.info(`restored ${this.tabs.size} profile tab(s); ${[...this.lost.keys()].length} profile(s) lost their logins`);
    } finally {
      this.restoring = false;
      this.changed();
      this.persist();
    }
  }

  private persist(): void {
    if (this.restoring) return;
    const state: PersistedProfiles = {
      version: 1,
      contexts: Object.fromEntries([...this.contexts].map(([k, c]) => [k, c.contextId])),
      tabs: [...this.tabs.values()].filter(t => t.viewId).map(t => ({ viewId: t.viewId!, profile: t.profile, contextId: t.contextId, ...(t.detached ? { detached: true } : {}) })),
      defaults: Object.fromEntries(this.defaults),
      recent: this.recent,
    };
    void Promise.resolve(this.services.context.workspaceState.update(STATE_KEY, state)).then(undefined, err => this.log.warn(`could not save profiles: ${errorText(err)}`));
  }

  // ------------------------------------------------------------------ display

  private openNote(opened: OpenedInProfile, session: AgentSession, source: string, others: string[], background: boolean): string {
    const label = this.label(opened.profile);
    const name = isPrivate(opened.profile) ? (privateOwner(opened.profile) === session.id ? 'your private login profile' : `the login profile ${label}`) : `the login profile "${label}"`;
    const why = source === 'user' ? ' (the default the user set for your session)' : source === 'agent' ? ' (your default)' : source === 'setting' ? ' (the setting for agent sessions)' : '';
    const parts = [`It is in ${name}${why}`];
    if (opened.lost) parts.push(`, which starts empty again: its earlier logins are gone because ${LOST[opened.lost]}.`);
    else if (opened.fresh) parts.push(isPrivate(opened.profile) ? ', new and empty: no other session and not the default store share it.' : ', new and empty: log in once and later tabs of this profile share the login.');
    else parts.push(others.length ? `, shared with ${others.join(', ')}.` : ', whose logins it shares.');
    if (background) parts.push(' Profile tabs always open in front.');
    if (opened.fresh) parts.push(` ${LIFETIME}`);
    return parts.join('');
  }

  private decorationFor(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const viewId = viewIdOf(uri);
    if (!viewId) return undefined;
    for (const [tab, t] of this.tabs) {
      if (t.viewId !== viewId) continue;
      const id = this.browser.tabIdOf(tab);
      const profile = id ? this.describeTab(id) : undefined;
      return profile ? new vscode.FileDecoration(undefined, profile.kind === 'detached' ? 'Own login store (its profile ended when VS Code restarted)' : `Login profile: ${profile.label}`) : undefined;
    }
    return undefined;
  }

  private changed(...viewIds: Array<string | undefined>): void {
    if (this.restoring) return;
    const ids = viewIds.filter((v): v is string => !!v);
    this.decorationEmitter.fire(ids.length ? ids.map(browserViewUri) : [...this.tabs.values()].flatMap(t => (t.viewId ? [browserViewUri(t.viewId)] : [])));
    this.changeEmitter.fire();
    this.browser.tabInfoChanged();
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      this.persist();
    }, 300);
  }

  dispose(): void {
    for (const s of this.subscriptions.splice(0)) s.dispose();
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
      this.persist();
    }
    // Closing the host ends Copane's hold on profiles without open tabs; their tabs keep their logins.
    this.host?.close();
    this.changeEmitter.dispose();
  }
}


const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
