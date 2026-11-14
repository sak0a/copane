// Network and CPU throttling beyond the page target, for EmulationManager (emulation.ts):
//
// - Frames: a cross-origin iframe is its own CDP target and renderer process, which the page target's
//   throttling does not reach. While a tab is throttled, every frame target of it gets the same
//   settings, also frames that attach later; they are undone when the throttling ends. (A frame's
//   document request follows the page's settings; what it loads in the moment before its target is
//   attached may slip through.)
// - Requests answered by the bridge itself (browser_route mocks, CDP Fetch at the request stage)
//   never reach the network: they are not slowed and still arrive while offline.
// - Leftovers: throttling outlives the CDP session that set it (throttleLogic.ts). The tabs being
//   throttled are remembered in the window's workspace state before it is applied, so when the
//   extension host restarts or crashes, the next attach to such a tab undoes it on the page and on the
//   frames that attach in the following seconds.
import type * as vscode from 'vscode';
import type { Disposable } from '../../core/events';
import type { Logger } from '../../core/log';
import type { CdpPage } from '../../core/services';
import type { PageState } from './pageState';
import { CLEAR_THROTTLING, cpuStep, networkStep, type CdpStep, type NetworkThrottle } from './throttleLogic';

const STORE_KEY = 'copane.browser.throttledTabs';
/** How long after attaching to a leftover tab its frames are cleared as they attach. */
const LEFTOVER_FRAMES_MS = 15_000;
/** Markers older than this are dropped (their tabs are long gone). */
const MARKER_MAX_AGE_MS = 7 * 24 * 3600_000;

interface Followed {
  steps: CdpStep[];
  key: string;
  state: PageState;
  /** Frame sessions and the settings (key) they got. */
  applied: WeakMap<CdpPage, string>;
  /** Frame sessions that got settings, to undo them. */
  sessions: Set<CdpPage>;
  sub: Disposable;
}

export class ThrottleTargets implements Disposable {
  private readonly followed = new Map<string, Followed>();
  private readonly leftovers = new Map<string, Disposable>();

  constructor(
    private readonly store: vscode.Memento | undefined,
    private readonly log: Logger,
  ) {}

  /** Applies throttling to the tab's frame targets now and to frames that attach later; undefined settings end it. */
  follow(tabId: string, state: PageState, settings: { network?: NetworkThrottle; cpu?: number }): void {
    if (!settings.network && !settings.cpu) return this.stop(tabId);
    const steps = [networkStep(settings.network), cpuStep(settings.cpu)];
    const key = JSON.stringify(steps);
    let f = this.followed.get(tabId);
    if (f && f.state !== state) {
      f.sub.dispose();
      this.followed.delete(tabId);
      f = undefined;
    }
    if (!f) {
      const created: Followed = { steps, key, state, applied: new WeakMap(), sessions: new Set(), sub: { dispose() {} } };
      created.sub = state.onDidChange(() => this.applyToFrames(created));
      this.followed.set(tabId, (f = created));
    }
    f.steps = steps;
    f.key = key;
    this.applyToFrames(f);
  }

  /** Ends throttling of the tab's frame targets. */
  stop(tabId: string): void {
    const f = this.followed.get(tabId);
    if (!f) return;
    this.followed.delete(tabId);
    f.sub.dispose();
    for (const session of f.sessions) if (!session.closed) void this.send(session, CLEAR_THROTTLING);
  }

  private applyToFrames(f: Followed): void {
    for (const frame of f.state.frames.list()) {
      if (frame.session.closed || f.applied.get(frame.session) === f.key) continue;
      f.applied.set(frame.session, f.key);
      f.sessions.add(frame.session);
      void this.send(frame.session, f.steps);
    }
    for (const s of [...f.sessions]) if (s.closed) f.sessions.delete(s);
  }

  private async send(target: CdpPage, steps: CdpStep[]): Promise<void> {
    for (const step of steps) {
      try {
        await target.send(step.method, step.params, { timeoutMs: 5000 });
      } catch (err) {
        if (!target.closed) this.log.debug(`throttling: ${step.method} failed on a frame of ${target.tabId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // ------------------------------------------------------------------ leftovers

  /** Remembers that the tab is about to be throttled (before it is). */
  async remember(tabId: string): Promise<void> {
    if (!this.store) return;
    const now = Date.now();
    const all = Object.fromEntries(Object.entries(this.markers()).filter(([, at]) => now - at < MARKER_MAX_AGE_MS));
    if (all[tabId]) return;
    all[tabId] = now;
    await this.store.update(STORE_KEY, all).then(undefined, err => this.log.warn('throttling: could not remember a throttled tab', err));
  }

  /** The tab is no longer throttled by this window. */
  forget(tabId: string): void {
    if (!this.store || !(tabId in this.markers())) return;
    const { [tabId]: _gone, ...rest } = this.markers();
    void this.store.update(STORE_KEY, rest).then(undefined, err => this.log.warn('throttling: could not forget a throttled tab', err));
  }

  /**
   * A tab was attached that an earlier run of the extension throttled and may have left throttled (it
   * restarted or crashed): undoes throttling on the page and on frames that attach soon after. Returns
   * true when it did.
   */
  clearLeftover(page: CdpPage, state: () => PageState): boolean {
    if (!(page.tabId in this.markers())) return false;
    this.log.info(`${page.tabId}: undoing network/CPU throttling left from before the extension restarted`);
    void this.send(page, CLEAR_THROTTLING);
    this.leftovers.get(page.tabId)?.dispose();
    const cleared = new WeakSet<CdpPage>();
    const s = state();
    const clearFrames = () => {
      for (const frame of s.frames.list()) {
        if (cleared.has(frame.session) || frame.session.closed) continue;
        cleared.add(frame.session);
        void this.send(frame.session, CLEAR_THROTTLING);
      }
    };
    const sub = s.onDidChange(clearFrames);
    const timer = setTimeout(() => done.dispose(), LEFTOVER_FRAMES_MS);
    const done = {
      dispose: () => {
        clearTimeout(timer);
        sub.dispose();
        if (this.leftovers.get(page.tabId) === done) this.leftovers.delete(page.tabId);
      },
    };
    this.leftovers.set(page.tabId, done);
    clearFrames();
    this.forget(page.tabId);
    return true;
  }

  /** Stops clearing a leftover tab's frames (it is being throttled again). */
  cancelLeftover(tabId: string): void {
    this.leftovers.get(tabId)?.dispose();
  }

  /** Tabs an earlier run may have left throttled. */
  markedTabs(): string[] {
    return Object.keys(this.markers());
  }

  private markers(): Record<string, number> {
    const value = this.store?.get<Record<string, number>>(STORE_KEY);
    return value && typeof value === 'object' ? value : {};
  }

  dispose(): void {
    for (const tabId of [...this.followed.keys()]) this.stop(tabId);
    for (const l of [...this.leftovers.values()]) l.dispose();
  }
}
