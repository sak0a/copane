// What the bridge knows about one tab's page, kept up to date from CDP events: the main frame and its
// loading state, navigations, an open JavaScript dialog, console messages and network requests.
// One PageState per tab, shared by every session using the tab. It holds no per-session state and
// changes nothing in the page beyond enabling CDP domains.
import { ToolError } from '../../core/errors';
import { Emitter, type Disposable } from '../../core/events';
import type { Logger } from '../../core/log';
import type { CdpPage } from '../../core/services';
import { ConsoleLog } from './consoleLog';
import { FrameRegistry } from './frames';
import { NetworkLog } from './networkLog';
import { RingBuffer } from './ringBuffer';

export const WORLD_NAME = '__agent_bridge__';

export type DialogType = 'alert' | 'confirm' | 'prompt' | 'beforeunload';

export interface DialogInfo {
  seq: number;
  type: DialogType;
  message: string;
  defaultPrompt: string;
  url: string;
  openedAt: number;
  /** Set once the dialog closed: accepted or not, and by whom we cannot tell. */
  closed?: { accepted: boolean; userInput?: string };
}

export interface NavigationEntry {
  seq: number;
  time: number;
  url: string;
  /** pushState / hash change, as opposed to a new document. */
  sameDocument: boolean;
  loaderId: string | undefined;
}

export interface PopupEntry {
  seq: number;
  url: string;
  kind: 'window' | 'download';
}

/** Thrown out of a CDP call when a dialog opens while it runs: the call would block until handled. */
export class DialogInterrupt extends Error {
  constructor(readonly dialog: DialogInfo) {
    super(`A ${dialog.type} dialog opened`);
  }
}

export type WaitResult<T> = { ok: true; value: T } | { ok: false; reason: 'timeout' | 'dialog' };

const CONSOLE_CAPACITY = 1000;
const NETWORK_CAPACITY = 1000;

export class PageState {
  page: CdpPage;
  private seqCounter = 0;
  readonly console = new ConsoleLog(CONSOLE_CAPACITY, () => this.nextSeq());
  readonly network = new NetworkLog(NETWORK_CAPACITY, () => this.nextSeq());
  readonly navigations = new RingBuffer<NavigationEntry>(200);
  readonly dialogs = new RingBuffer<DialogInfo>(50);
  readonly popups = new RingBuffer<PopupEntry>(50);
  /** When recording started for this tab. */
  readonly recordingSince = Date.now();

  mainFrameId: string | undefined;
  /** Loader id of the main frame's current document; changes on every cross-document navigation. */
  loaderId: string | undefined;
  url = '';
  dialog: DialogInfo | undefined;
  crashed = false;
  /** A navigation of the main frame was requested and has not committed or been abandoned yet. */
  pendingNavigation: { seq: number; url: string | undefined } | undefined;
  /** Main frame is loading (between frameStartedLoading and frameStoppedLoading). */
  loading = false;
  /** `seq` at which the main frame last started a cross-document navigation or started loading. */
  navigationStartSeq = 0;
  /** `seq` at which the main frame last committed a navigation or stopped loading (also when aborted). */
  navigationEndSeq = 0;
  isMac = false;
  /** Focus emulation is on (while an agent controls the tab; see prepareInput in input.ts). */
  focusEmulation = false;
  lastNetworkActivity = Date.now();
  /** Cross-origin (out-of-process) iframes of the page, re-created with every CDP connection. */
  frames!: FrameRegistry;

  private readonly lifecycle = new Map<string, Set<string>>();
  private readonly worlds = new Map<string, number>();
  private readonly mainWorlds = new Map<string, number>();
  private subscriptions: Disposable[] = [];
  private readonly changeEmitter = new Emitter<void>();
  readonly onDidChange = this.changeEmitter.event;
  ready: Promise<void> = Promise.resolve();

  constructor(
    page: CdpPage,
    private readonly log: Logger,
  ) {
    this.page = page;
    this.bind(page);
  }

  get seq(): number {
    return this.seqCounter;
  }

  nextSeq(): number {
    return ++this.seqCounter;
  }

  /** Lifecycle events seen for the current document ("DOMContentLoaded", "load", "networkIdle", ...). */
  lifecycleOf(loaderId = this.loaderId): Set<string> {
    return (loaderId && this.lifecycle.get(loaderId)) || new Set();
  }

  /** (Re)binds to a CDP connection of this tab, keeping the recorded history. */
  bind(page: CdpPage): void {
    for (const s of this.subscriptions.splice(0)) s.dispose();
    this.page = page;
    this.dialog = undefined;
    // Emulation overrides belong to the CDP connection; a new one starts without them.
    this.focusEmulation = false;
    this.worlds.clear();
    this.mainWorlds.clear();
    const on = (event: string, fn: (p: any) => void) =>
      this.subscriptions.push(
        page.on(event, p => {
          try {
            fn(p);
          } catch (err) {
            this.log.warn(`page event ${event} failed`, err);
          }
          this.changeEmitter.fire();
        }),
      );

    on('Page.frameNavigated', p => {
      const frame = p.frame;
      if (frame.parentId) return;
      this.mainFrameId = frame.id;
      this.url = frame.url + (frame.urlFragment ?? '');
      if (frame.loaderId !== this.loaderId) {
        this.loaderId = frame.loaderId;
        this.navigations.push({ seq: this.nextSeq(), time: Date.now(), url: this.url, sameDocument: false, loaderId: frame.loaderId });
        this.crashed = false;
        if (this.lifecycle.size > 20) this.lifecycle.delete(this.lifecycle.keys().next().value!);
      }
      this.pendingNavigation = undefined;
      this.navigationEndSeq = this.nextSeq();
    });
    on('Page.navigatedWithinDocument', p => {
      if (p.frameId !== this.mainFrameId) return;
      this.url = p.url;
      this.navigations.push({ seq: this.nextSeq(), time: Date.now(), url: p.url, sameDocument: true, loaderId: this.loaderId });
    });
    on('Page.lifecycleEvent', p => {
      if (p.frameId !== this.mainFrameId) return;
      let set = this.lifecycle.get(p.loaderId);
      if (!set) this.lifecycle.set(p.loaderId, (set = new Set()));
      if (p.name === 'init') set.clear();
      set.add(p.name);
    });
    on('Page.domContentEventFired', () => {
      if (this.loaderId) this.addLifecycle('DOMContentLoaded');
    });
    on('Page.loadEventFired', () => {
      if (this.loaderId) this.addLifecycle('load');
    });
    on('Page.frameStartedLoading', p => {
      if (p.frameId !== this.mainFrameId) return;
      this.loading = true;
      this.navigationStartSeq = this.nextSeq();
    });
    on('Page.frameStoppedLoading', p => {
      if (p.frameId !== this.mainFrameId) return;
      this.loading = false;
      this.pendingNavigation = undefined;
      this.navigationEndSeq = this.nextSeq();
    });
    const requested = (p: { frameId: string; url?: string; disposition?: string }) => {
      if (p.frameId !== this.mainFrameId) return;
      if (p.disposition && p.disposition !== 'currentTab') return;
      this.pendingNavigation = { seq: this.nextSeq(), url: p.url };
      this.navigationStartSeq = this.pendingNavigation.seq;
    };
    on('Page.frameRequestedNavigation', requested);
    on('Page.frameStartedNavigating', p => {
      if (!/samedocument/i.test(p.navigationType ?? '')) requested({ frameId: p.frameId, url: p.url });
    });
    on('Page.frameScheduledNavigation', requested);
    // Not used to clear pendingNavigation: Chrome sends frameClearedScheduledNavigation when a scripted
    // navigation actually starts, not only when it is cancelled.
    on('Page.javascriptDialogOpening', p => {
      const dialog: DialogInfo = { seq: this.nextSeq(), type: p.type, message: p.message ?? '', defaultPrompt: p.defaultPrompt ?? '', url: p.url ?? '', openedAt: Date.now() };
      this.dialog = dialog;
      this.dialogs.push(dialog);
    });
    on('Page.javascriptDialogClosed', p => {
      if (this.dialog) this.dialog.closed = { accepted: Boolean(p.result), userInput: p.userInput };
      this.dialog = undefined;
    });
    on('Page.windowOpen', p => this.popups.push({ seq: this.nextSeq(), url: p.url, kind: 'window' }));
    on('Page.downloadWillBegin', p => this.popups.push({ seq: this.nextSeq(), url: p.suggestedFilename || p.url, kind: 'download' }));
    on('Inspector.targetCrashed', () => {
      this.crashed = true;
    });

    on('Runtime.executionContextCreated', p => {
      const c = p.context;
      const frameId = c.auxData?.frameId;
      if (!frameId) return;
      if (c.name === WORLD_NAME) this.worlds.set(frameId, c.id);
      else if (c.auxData?.isDefault) this.mainWorlds.set(frameId, c.id);
    });
    on('Runtime.executionContextDestroyed', p => {
      for (const map of [this.worlds, this.mainWorlds]) for (const [frame, id] of map) if (id === p.executionContextId) map.delete(frame);
    });
    on('Runtime.executionContextsCleared', () => {
      this.worlds.clear();
      this.mainWorlds.clear();
    });
    on('Runtime.consoleAPICalled', p => this.console.onConsoleApi(p));
    on('Runtime.exceptionThrown', p => this.console.onException(p));
    on('Log.entryAdded', p => this.console.onLogEntry(p));

    const activity = () => (this.lastNetworkActivity = Date.now());
    on('Network.requestWillBeSent', p => {
      activity();
      this.network.onRequest(p);
      this.network.prune();
    });
    on('Network.requestWillBeSentExtraInfo', p => this.network.onRequestExtra(p));
    on('Network.responseReceived', p => this.network.onResponse(p));
    on('Network.loadingFinished', p => {
      activity();
      this.network.onFinished(p);
    });
    on('Network.loadingFailed', p => {
      activity();
      this.network.onFailed(p);
    });
    on('Network.requestServedFromCache', p => this.network.onServedFromCache(p));

    this.subscriptions.push(page.onDidClose(() => this.changeEmitter.fire()));
    this.ready = this.initialize(page);
    this.frames?.dispose();
    this.frames = new FrameRegistry(page, {
      log: this.log,
      console: this.console,
      network: this.network,
      nextSeq: () => this.nextSeq(),
      activity,
      changed: () => this.changeEmitter.fire(),
    });
  }

  private addLifecycle(name: string): void {
    const loaderId = this.loaderId!;
    let set = this.lifecycle.get(loaderId);
    if (!set) this.lifecycle.set(loaderId, (set = new Set()));
    set.add(name);
  }

  private async initialize(page: CdpPage): Promise<void> {
    const quick = { timeoutMs: 5000 };
    const enable = async (method: string, params: Record<string, unknown> = {}) => {
      try {
        await page.send(method, params, quick);
      } catch (err) {
        this.log.warn(`${method} failed on ${page.tabId}`, err);
      }
    };
    await Promise.all([
      enable('Page.enable'),
      enable('Page.setLifecycleEventsEnabled', { enabled: true }),
      enable('Network.enable', { maxTotalBufferSize: 50_000_000, maxResourceBufferSize: 10_000_000, maxPostDataSize: 65_536 }),
      enable('Log.enable'),
      enable('DOM.enable'),
    ]);
    try {
      const { frameTree } = await page.send('Page.getFrameTree', {}, quick);
      const frame = frameTree.frame;
      if (!this.mainFrameId || frame.id !== this.mainFrameId || !this.loaderId) {
        this.mainFrameId = frame.id;
        this.loaderId = frame.loaderId;
        this.url = frame.url + (frame.urlFragment ?? '');
      }
    } catch (err) {
      this.log.warn(`Page.getFrameTree failed on ${page.tabId}`, err);
    }
    // Runtime.enable reports existing execution contexts and replays console messages logged before.
    await enable('Runtime.enable');
    try {
      const { result } = await page.send('Runtime.evaluate', { expression: '[document.readyState, navigator.platform]', returnByValue: true }, { timeoutMs: 3000 });
      const [readyState, platform] = (result?.value ?? []) as [string, string];
      this.isMac = /mac/i.test(platform ?? '');
      if (readyState === 'interactive' || readyState === 'complete') this.addLifecycle('DOMContentLoaded');
      if (readyState === 'complete') this.addLifecycle('load');
    } catch {
      // The page does not answer: probably a dialog that opened before we attached. Tools detect it.
    }
    this.changeEmitter.fire();
  }

  /** Execution context id of the bridge's isolated world in a frame, created on first use. */
  async isolatedWorld(frameId = this.mainFrameId): Promise<number> {
    if (!frameId) throw new ToolError('failed', 'The page has no main frame yet. Wait a moment and try again.');
    const known = this.worlds.get(frameId);
    if (known !== undefined) return known;
    const { executionContextId } = await this.page.send('Page.createIsolatedWorld', { frameId, worldName: WORLD_NAME, grantUniveralAccess: false });
    this.worlds.set(frameId, executionContextId);
    return executionContextId;
  }

  /** Execution context id of the page's own JavaScript world in a frame, if known. */
  mainWorld(frameId = this.mainFrameId): number | undefined {
    return frameId ? this.mainWorlds.get(frameId) : undefined;
  }

  forgetWorld(contextId: number): void {
    for (const map of [this.worlds, this.mainWorlds]) for (const [frame, id] of map) if (id === contextId) map.delete(frame);
  }

  /**
   * Resolves once `check` returns something other than undefined/false, re-checking on every page
   * event and every `pollMs`. Stops early when a dialog opens (unless `ignoreDialogs`), throws when
   * the signal aborts or the tab closes.
   */
  waitFor<T>(check: () => T | undefined | false, options: { timeoutMs: number; signal?: AbortSignal; pollMs?: number; ignoreDialogs?: boolean }): Promise<WaitResult<T>> {
    return new Promise((resolve, reject) => {
      let done = false;
      const subs: Disposable[] = [];
      const finish = (fn: () => void) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearInterval(poll);
        for (const s of subs) s.dispose();
        options.signal?.removeEventListener('abort', onAbort);
        fn();
      };
      const evaluate = () => {
        if (done) return;
        if (this.page.closed) return finish(() => reject(new ToolError('not_found', `Tab ${this.page.tabId} was closed.`)));
        let value: T | undefined | false;
        try {
          value = check();
        } catch (err) {
          return finish(() => reject(err));
        }
        if (value !== undefined && value !== false) return finish(() => resolve({ ok: true, value }));
        if (this.dialog && !options.ignoreDialogs) {
          // Only a dialog that stays open counts (the browser answers some at once).
          const dialog = this.dialog;
          if (Date.now() - dialog.openedAt >= 50) return finish(() => resolve({ ok: false, reason: 'dialog' }));
          setTimeout(evaluate, 60);
        }
      };
      const onAbort = () => finish(() => reject(new ToolError('cancelled', 'Cancelled.')));
      const timer = setTimeout(() => finish(() => resolve({ ok: false, reason: 'timeout' })), Math.max(0, options.timeoutMs));
      const poll = setInterval(evaluate, options.pollMs ?? 200);
      subs.push(this.onDidChange(evaluate));
      if (options.signal?.aborted) return onAbort();
      options.signal?.addEventListener('abort', onAbort);
      evaluate();
    });
  }

  /** Requests in flight that count against "network idle" (long-lived and very old ones excluded). */
  networkIdleFor(): number {
    const now = Date.now();
    if (this.network.inflight(now, 10_000).length > 0) return 0;
    return now - this.lastNetworkActivity;
  }

  /** Turns focus emulation off again (the agent no longer controls the tab). */
  endFocusEmulation(): void {
    if (!this.focusEmulation) return;
    this.focusEmulation = false;
    if (!this.page.closed) this.page.send('Emulation.setFocusEmulationEnabled', { enabled: false }, { timeoutMs: 5000 }).then(undefined, () => {});
  }

  dispose(): void {
    for (const s of this.subscriptions.splice(0)) s.dispose();
    this.frames.dispose();
    this.changeEmitter.dispose();
  }
}

/** One PageState per tab, re-bound when the tab's CDP connection is re-established. */
export class PageStates {
  private readonly byTab = new Map<string, PageState>();

  constructor(private readonly log: Logger) {}

  forPage(page: CdpPage): PageState {
    let state = this.byTab.get(page.tabId);
    if (!state) this.byTab.set(page.tabId, (state = new PageState(page, this.log)));
    else if (state.page !== page) state.bind(page);
    return state;
  }

  get(tabId: string): PageState | undefined {
    return this.byTab.get(tabId);
  }

  delete(tabId: string): void {
    this.byTab.get(tabId)?.dispose();
    this.byTab.delete(tabId);
  }

  dispose(): void {
    for (const s of this.byTab.values()) s.dispose();
    this.byTab.clear();
  }
}
