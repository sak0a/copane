// Cross-origin (out-of-process) iframes of one tab. Site isolation puts such a frame in its own CDP
// target, which the tab's page session cannot see into. The registry auto-attaches to every iframe
// target (`Target.setAutoAttach` with flatten on the page session, then on each frame session for
// nested frames; VS Code's proxy forwards that to Chromium and announces each child on the session
// that asked), records the frame's console and network traffic into the tab's logs, and tracks each
// frame's document so refs into a frame that navigated or went away are reported stale.
//
// One registry per tab, owned by its PageState and shared by every session using the tab. What it
// enables in a frame (Page, Runtime, Network, Log, DOM, lifecycle events, auto-attach) is recording
// state of the tab like the same domains on the page target; nothing per agent session. The page
// indicator and certificate handling stay on the page target only.
//
// A frame that navigates to another site keeps its target; one that navigates to the page's own site
// becomes part of the page target (its target detaches); a removed frame detaches. Frame ids are
// stable across all of that, and the target id of a frame target is its root frame's id.
//
// New frame targets are held before their document runs (`waitForDebuggerOnStart`) until the registry
// has enabled its domains there and `hooks.attachFrame` (request interception) is in place, so a
// frame's earliest requests are recorded and intercepted too. The hold is bounded (FRAME_HOLD_MS) and
// always released; a frame that was already running when the bridge attached is not held.
import type { Disposable } from '../../core/events';
import type { Logger } from '../../core/log';
import type { CdpPage } from '../../core/services';
import type { ConsoleLog } from './consoleLog';
import type { NetworkLog } from './networkLog';
import { RingBuffer } from './ringBuffer';

function clipUrl(url: string): string {
  return url.length > 200 ? `${url.slice(0, 199)}…` : url || '(no URL yet)';
}

export const FRAME_WORLD_NAME = '__agent_bridge__';

const AUTO_ATTACH = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: 'iframe', exclude: false }] };
/** Longest a new frame waits for the bridge before it runs anyway. */
export const FRAME_HOLD_MS = 3000;

export interface FrameTarget {
  /** Target id, which is also the id of the frame this target renders (the iframe's content frame). */
  readonly id: string;
  /** CDP session of the frame target. */
  readonly session: CdpPage;
  /** Id of the frame that contains the iframe element (in the page target or in another frame target). */
  readonly parentFrameId: string | undefined;
  /** Order of attachment, which follows document order for frames present at load. */
  readonly order: number;
  url: string;
  /** Loader id of the frame's current document; changes on every cross-document navigation. */
  loaderId: string | undefined;
  /** Frame ids rendered by this target: its own frame and same-origin iframes inside it. */
  readonly localFrames: Set<string>;
  /** Lifecycle events of the current document ("DOMContentLoaded", "load"). */
  readonly lifecycle: Set<string>;
  loading: boolean;
  /** `seq` at which the frame last started loading. */
  loadingSince: number;
  /** Settles once the domains are enabled and the document is known (never rejects). */
  ready: Promise<void>;
  /** Backend node id of the `<iframe>` element in the parent's target, once looked up. */
  ownerNode?: number;
  readonly worlds: Map<string, number>;
}

export interface FrameNavigation {
  seq: number;
  frameId: string;
  url: string;
  /** The target went away: the frame was removed, or navigated to the page's own site. */
  detached?: boolean;
}

export interface FrameHooks {
  log: Logger;
  console: ConsoleLog;
  network: NetworkLog;
  nextSeq(): number;
  /** Network activity in a frame (for "network idle"). */
  activity(): void;
  /** Something about the frames changed (wakes waiters). */
  changed(): void;
  /**
   * A frame target attached (request interception serves it from here on). A new frame's document
   * waits for the returned promise (at most FRAME_HOLD_MS) before it runs.
   */
  attachFrame?(session: CdpPage): Promise<void> | void;
}

export class FrameRegistry {
  private readonly byId = new Map<string, FrameTarget>();
  private readonly subscriptions: Disposable[] = [];
  private counter = 0;
  private disposed = false;
  readonly navigations = new RingBuffer<FrameNavigation>(100);
  /** False when the CDP connection cannot address child sessions (then frames stay unreadable). */
  readonly supported: boolean;
  /** Settles when the page session's auto-attach request was answered. */
  readonly started: Promise<void>;

  constructor(
    private readonly page: CdpPage,
    private readonly hooks: FrameHooks,
  ) {
    this.supported = typeof page.childSession === 'function';
    if (!this.supported) {
      this.started = Promise.resolve();
      return;
    }
    this.subscriptions.push(page.on('Target.attachedToTarget', p => this.onAttached(p, undefined)));
    this.started = page.send('Target.setAutoAttach', AUTO_ATTACH, { timeoutMs: 5000 }).then(
      () => undefined,
      err => hooks.log.warn(`frames: auto-attach failed on ${page.tabId}`, err),
    );
  }

  /** All frame targets, parents before children, in attach order. */
  list(): FrameTarget[] {
    const all = [...this.byId.values()].sort((a, b) => a.order - b.order);
    const out: FrameTarget[] = [];
    const visit = (parent: FrameTarget | undefined) => {
      for (const f of all) if (this.parentOf(f) === parent && !out.includes(f)) (out.push(f), visit(f));
    };
    visit(undefined);
    for (const f of all) if (!out.includes(f)) out.push(f); // parent not known (yet)
    return out;
  }

  get(id: string): FrameTarget | undefined {
    return this.byId.get(id);
  }

  get size(): number {
    return this.byId.size;
  }

  /** The frame target that renders a frame id; undefined when the page target renders it (or it is unknown). */
  targetOf(frameId: string | undefined): FrameTarget | undefined {
    if (!frameId) return undefined;
    const direct = this.byId.get(frameId);
    if (direct) return direct;
    for (const f of this.byId.values()) if (f.localFrames.has(frameId)) return f;
    return undefined;
  }

  /** The frame target containing this one's iframe element; undefined = the page target. */
  parentOf(frame: FrameTarget): FrameTarget | undefined {
    return this.targetOf(frame.parentFrameId);
  }

  /** The chain from the outermost frame target down to `frame`. */
  chain(frame: FrameTarget): FrameTarget[] {
    const out: FrameTarget[] = [];
    for (let f: FrameTarget | undefined = frame; f && !out.includes(f); f = this.parentOf(f)) out.unshift(f);
    return out;
  }

  /** Frames that started loading after `seq` and have not finished. */
  loadingSince(seq: number): FrameTarget[] {
    return [...this.byId.values()].filter(f => f.loading && f.loadingSince > seq && !f.session.closed);
  }

  /** What happened to frames after `seq`, for an action's report: one line per frame, at most `max`. */
  describeSince(seq: number, max = 3): string[] {
    const last = new Map<string, FrameNavigation>();
    for (const n of this.navigations.after(seq)) last.set(n.frameId, n);
    const lines = [...last.values()].map(n =>
      n.detached ? `A cross-origin frame (${clipUrl(n.url)}) went away: removed, reloaded or navigated to this page's own site.` : `A frame navigated to ${clipUrl(n.url)}.`,
    );
    return lines.length > max ? [...lines.slice(0, max), `${lines.length - max} more frames navigated.`] : lines;
  }

  /** Waits (bounded) until every known frame has its document. */
  async whenReady(timeoutMs = 3000): Promise<void> {
    await this.started;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([Promise.all([...this.byId.values()].map(f => f.ready)), new Promise<void>(r => (timer = setTimeout(r, timeoutMs)))]);
    clearTimeout(timer);
  }

  /** Execution context id of the bridge's isolated world in a frame of a frame target. */
  async isolatedWorld(frame: FrameTarget, frameId = frame.id): Promise<number> {
    const known = frame.worlds.get(frameId);
    if (known !== undefined) return known;
    const { executionContextId } = await frame.session.send('Page.createIsolatedWorld', { frameId, worldName: FRAME_WORLD_NAME, grantUniveralAccess: false });
    frame.worlds.set(frameId, executionContextId);
    return executionContextId;
  }

  forgetWorld(frame: FrameTarget, contextId: number): void {
    for (const [id, ctx] of frame.worlds) if (ctx === contextId) frame.worlds.delete(id);
  }

  dispose(): void {
    this.disposed = true;
    for (const s of this.subscriptions.splice(0)) s.dispose();
    this.byId.clear();
  }

  private onAttached(
    p: { sessionId: string; targetInfo: { targetId: string; type: string; url?: string; parentFrameId?: string }; waitingForDebugger?: boolean },
    via: FrameTarget | undefined,
  ): void {
    if (!p?.sessionId) return;
    const session = this.page.childSession!(p.sessionId);
    if (this.disposed || p.targetInfo?.type !== 'iframe') {
      // Only iframes are asked for; anything else that waits for us must not stay paused.
      if (p.waitingForDebugger) void session.send('Runtime.runIfWaitingForDebugger', {}, { timeoutMs: 5000 }).catch(() => {});
      return;
    }
    const info = p.targetInfo;
    const previous = this.byId.get(info.targetId);
    if (previous && previous.session === session) return;
    const frame: FrameTarget = {
      id: info.targetId,
      session,
      parentFrameId: info.parentFrameId ?? via?.id,
      order: ++this.counter,
      url: info.url ?? '',
      loaderId: undefined,
      localFrames: new Set([info.targetId]),
      lifecycle: new Set(),
      loading: false,
      loadingSince: 0,
      ready: Promise.resolve(),
      worlds: new Map(),
    };
    this.byId.set(frame.id, frame);
    const subs: Disposable[] = [];
    const on = (event: string, fn: (p: any) => void) =>
      subs.push(
        session.on(event, params => {
          try {
            fn(params);
          } catch (err) {
            this.hooks.log.warn(`frame event ${event} failed`, err);
          }
          this.hooks.changed();
        }),
      );
    this.record(frame, on);
    on('Target.attachedToTarget', params => this.onAttached(params, frame));
    this.subscriptions.push(
      session.onDidClose(() => {
        for (const s of subs.splice(0)) s.dispose();
        if (this.byId.get(frame.id) !== frame) return;
        this.byId.delete(frame.id);
        if (!this.disposed) this.navigations.push({ seq: this.hooks.nextSeq(), frameId: frame.id, url: frame.url, detached: true });
        this.hooks.changed();
      }),
    );
    frame.ready = this.initialize(frame, p.waitingForDebugger === true);
    this.hooks.changed();
  }

  private record(frame: FrameTarget, on: (event: string, fn: (p: any) => void) => void): void {
    const { console, network } = this.hooks;
    on('Page.frameNavigated', p => {
      const f = p.frame;
      if (f.id !== frame.id) {
        frame.localFrames.add(f.id);
        return;
      }
      frame.url = f.url + (f.urlFragment ?? '');
      if (f.loaderId !== frame.loaderId) {
        frame.loaderId = f.loaderId;
        frame.lifecycle.clear();
        this.navigations.push({ seq: this.hooks.nextSeq(), frameId: frame.id, url: frame.url });
      }
    });
    on('Page.navigatedWithinDocument', p => {
      if (p.frameId === frame.id) frame.url = p.url;
    });
    on('Page.frameAttached', p => frame.localFrames.add(p.frameId));
    on('Page.frameDetached', p => {
      if (p.frameId !== frame.id && p.reason !== 'swap') frame.localFrames.delete(p.frameId);
    });
    on('Page.lifecycleEvent', p => {
      if (p.frameId !== frame.id || (frame.loaderId && p.loaderId !== frame.loaderId)) return;
      if (p.name === 'init') frame.lifecycle.clear();
      frame.lifecycle.add(p.name);
    });
    on('Page.frameStartedLoading', p => {
      if (p.frameId !== frame.id) return;
      frame.loading = true;
      frame.loadingSince = this.hooks.nextSeq();
    });
    on('Page.frameStoppedLoading', p => {
      if (p.frameId !== frame.id) return;
      frame.loading = false;
      // Lifecycle events can be missed for a frame attached mid-load; a stopped load means it is done.
      frame.lifecycle.add('DOMContentLoaded');
      frame.lifecycle.add('load');
    });
    on('Runtime.executionContextCreated', p => {
      const c = p.context;
      if (c.name === FRAME_WORLD_NAME && c.auxData?.frameId) frame.worlds.set(c.auxData.frameId, c.id);
    });
    on('Runtime.executionContextDestroyed', p => {
      for (const [id, ctx] of frame.worlds) if (ctx === p.executionContextId) frame.worlds.delete(id);
    });
    on('Runtime.executionContextsCleared', () => frame.worlds.clear());
    on('Runtime.consoleAPICalled', p => console.onConsoleApi(p));
    on('Runtime.exceptionThrown', p => console.onException(p));
    on('Log.entryAdded', p => console.onLogEntry(p));
    on('Network.requestWillBeSent', p => {
      this.hooks.activity();
      network.onRequest(p);
      network.prune();
    });
    on('Network.requestWillBeSentExtraInfo', p => network.onRequestExtra(p));
    on('Network.responseReceived', p => network.onResponse(p));
    on('Network.loadingFinished', p => {
      this.hooks.activity();
      network.onFinished(p);
    });
    on('Network.loadingFailed', p => {
      this.hooks.activity();
      network.onFailed(p);
    });
    on('Network.requestServedFromCache', p => network.onServedFromCache(p));
  }

  private async initialize(frame: FrameTarget, held: boolean): Promise<void> {
    const { session } = frame;
    const quick = { timeoutMs: 5000 };
    const enable = (method: string, params: Record<string, unknown> = {}) =>
      session.send(method, params, quick).then(undefined, err => {
        if (!session.closed) this.hooks.log.debug(`frames: ${method} failed in ${frame.url || frame.id}: ${err instanceof Error ? err.message : String(err)}`);
      });
    const attach = async () => {
      try {
        await this.hooks.attachFrame?.(session);
      } catch (err) {
        this.hooks.log.warn(`frames: attaching ${frame.url || frame.id} failed`, err);
      }
    };
    // Everything that must be in place before the frame's document runs: recording, nested frames
    // (held the same way), and interception.
    const before = Promise.all([
      enable('Page.enable'),
      enable('Page.setLifecycleEventsEnabled', { enabled: true }),
      enable('Network.enable', { maxTotalBufferSize: 5_000_000, maxResourceBufferSize: 2_000_000, maxPostDataSize: 65_536 }),
      enable('Log.enable'),
      enable('DOM.enable'),
      enable('Runtime.enable'),
      enable('Target.setAutoAttach', AUTO_ATTACH),
      attach(),
    ]);
    if (held) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([before, new Promise<void>(resolve => (timer = setTimeout(resolve, FRAME_HOLD_MS)))]);
      clearTimeout(timer);
      // Always release the frame, whatever failed above: a held frame shows nothing and loads nothing.
      await enable('Runtime.runIfWaitingForDebugger');
    } else {
      await before;
    }
    try {
      const { frameTree } = await session.send('Page.getFrameTree', {}, quick);
      const visit = (node: any) => {
        frame.localFrames.add(node.frame.id);
        for (const child of node.childFrames ?? []) visit(child);
      };
      visit(frameTree);
      if (frameTree.frame.id === frame.id && !frame.loaderId) {
        frame.loaderId = frameTree.frame.loaderId;
        frame.url = frameTree.frame.url + (frameTree.frame.urlFragment ?? '');
      }
      const { result } = await session.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }, { timeoutMs: 3000 });
      if (result?.value === 'interactive' || result?.value === 'complete') frame.lifecycle.add('DOMContentLoaded');
      if (result?.value === 'complete') frame.lifecycle.add('load');
    } catch {
      // The frame is going away or busy; tools that use it find out.
    }
    this.hooks.changed();
  }
}
