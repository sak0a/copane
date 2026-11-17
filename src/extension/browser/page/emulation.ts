// Device and media emulation of a tab on an agent's behalf (browser_emulate).
//
// Emulation is tab state that belongs to the session that set it: it lasts while that session holds
// the tab's control lease and is undone when the lease ends (release, idle timeout, session end, the
// user pausing the tab), when the user resets it, or when the extension shuts down.
//
// Device size, scale factor, mobile and user agent go through VS Code's own device emulation (it folds
// these CDP commands into its device profile; see emulationLogic.ts), so the browser's device toolbar
// shows them and the user can change or close it there. Colour scheme, reduced motion, locale and time
// zone are overrides of our CDP session that VS Code does not show; the tab's info (`emulation`), a
// context key and the editor title button "Reset Agent Emulation" make them visible. So does network
// and CPU throttling, which also goes to the tab's cross-origin frames and outlives the CDP session
// (throttle.ts).
import * as vscode from 'vscode';
import { ToolError } from '../../core/errors';
import type { BridgeServices, BrowserTabInfo, CdpPage } from '../../core/services';
import { sessionDisplayName } from '../../core/sessions';
import type { ToolContent } from '../../../shared/protocol';
import { image, text } from '../../core/tools';
import { viewIdOf } from '../decorations';
import type { PageCall, PageHook, ScreenshotRequest } from './call';
import { describeEmulation, emulationSteps, isEmulating, isThrottling, mergeEmulation, shortEmulationLabel, type EmulateArgs, type EmulationSettings } from './emulationLogic';
import { imageSize } from './imageSize';
import { DialogInterrupt, type PageStates } from './pageState';
import { ThrottleTargets } from './throttle';
import { sameNetwork, throttlingNote } from './throttleLogic';
import { screenshotScale, sharperAvailable, SHARPER_NOTE } from './screenshotMath';
import { TOGGLE_BRIDGE_UI } from './scripts';
import { elementBox, viewport } from './targets';

/** What the emulation and download features need from the browser service besides `BrowserService`. */
export interface TabInfoHost {
  addTabInfoProvider(provider: (tabId: string) => Partial<BrowserTabInfo> | undefined): vscode.Disposable;
  tabInfoChanged(): void;
  tabIdForViewId(viewId: string): string | undefined;
  activeTabId(): string | undefined;
  idleSeconds(): number;
}

interface TabEmulation {
  sessionId: string;
  settings: EmulationSettings;
  page: CdpPage;
  /** The tab's user agent before any override, for the Accept-Language override. */
  baseUserAgent: string | undefined;
  /** When the current network/CPU throttling started (ms since epoch). */
  throttledSince?: number;
}

const CONTEXT_KEY = 'copane.browser.activeTabEmulated';
const TOUCH_CACHE_MS = 1500;

export class EmulationManager implements PageHook, vscode.Disposable {
  private readonly tabs = new Map<string, TabEmulation>();
  /** Why a session's emulation of a tab ended without it asking, told on its next browser_emulate. */
  private readonly ended = new Map<string, string>();
  private readonly touchCache = new Map<string, { value: boolean; at: number; loaderId: string | undefined }>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private contextValue = false;
  private readonly throttle: ThrottleTargets;
  private disposing = false;

  constructor(
    private readonly services: BridgeServices,
    private readonly host: TabInfoHost,
    /** The tabs' page states, for their frame targets (throttling). */
    private readonly states?: PageStates,
  ) {
    this.throttle = new ThrottleTargets(services.context?.workspaceState, services.log);
    this.subscriptions.push(
      host.addTabInfoProvider(tabId => {
        const s = this.tabs.get(tabId);
        return s ? { emulation: { sessionId: s.sessionId, label: shortEmulationLabel(s.settings), description: describeEmulation(s.settings) } } : undefined;
      }),
      services.tabLeases.onDidChange(change => {
        const s = this.tabs.get(change.resourceId);
        if (!s || change.lease?.sessionId === s.sessionId) return;
        const session = this.services.sessions.get(s.sessionId);
        void this.end(change.resourceId, session ? `control of ${change.resourceId} ended (you released it, it was idle for ${host.idleSeconds()} s, or the user took it over), which ends emulation` : 'your session ended');
      }),
      services.browser.onDidAttachPage(page => this.reattach(page)),
      services.browser.onDidChange(() => this.updateContextKey()),
      services.sessions.onDidChange(change => {
        if (change.type !== 'removed') return;
        for (const key of [...this.ended.keys()]) if (key.startsWith(`${change.session.id}|`)) this.ended.delete(key);
      }),
      vscode.commands.registerCommand('copane.browser.resetEmulation', (arg?: unknown) => this.resetCommand(arg)),
      // Tabs an earlier run left throttled are attached as soon as they are listed, which undoes it (reattach).
      services.browser.onDidChange(() => this.attachLeftovers()),
    );
    setTimeout(() => this.attachLeftovers(), 0);
  }

  private readonly leftoversTried = new Set<string>();

  private attachLeftovers(): void {
    if (!this.services.browser.available || !this.services.browser.attach) return;
    for (const tabId of this.throttle.markedTabs()) {
      if (this.leftoversTried.has(tabId) || this.tabs.has(tabId) || !this.services.browser.getTab(tabId)) continue;
      this.leftoversTried.add(tabId);
      void this.services.browser.attach(tabId).catch(err => this.services.log.warn(`${tabId}: could not attach to undo throttling: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  // ------------------------------------------------------------------ browser_emulate

  async emulate(call: PageCall, args: EmulateArgs): Promise<string> {
    const session = call.ctx.session;
    const tabId = call.tab.id;
    const note = this.ended.get(`${session.id}|${tabId}`);
    this.ended.delete(`${session.id}|${tabId}`);
    const lines = note ? [`Note: your earlier emulation of ${tabId} had ended: ${note}.`] : [];

    let state = this.tabs.get(tabId);
    if (state && state.sessionId !== session.id) {
      await this.end(tabId, 'another session took control of the tab');
      state = undefined;
    }
    const given = Object.entries(args).some(([k, v]) => k !== 'tab' && v !== undefined);
    if (!given) {
      lines.push(state ? `${tabId} emulates ${describeEmulation(state.settings)}.` : `${tabId} is not emulating anything.`);
      return lines.join('\n');
    }

    const prev = state?.settings ?? {};
    let next: EmulationSettings;
    try {
      next = mergeEmulation(prev, args);
    } catch (err) {
      throw new ToolError('invalid_input', err instanceof Error ? err.message : String(err));
    }
    const baseUserAgent = state?.baseUserAgent ?? (await call.evaluate<string>('function () { return navigator.userAgent; }').catch(() => undefined));
    const record: TabEmulation = state ?? { sessionId: session.id, settings: {}, page: call.page, baseUserAgent };
    record.page = call.page;
    if (isThrottling(next)) {
      // Remembered before it is applied: throttling outlives the CDP session (throttle.ts).
      this.throttle.cancelLeftover(tabId);
      await this.throttle.remember(tabId);
    }
    try {
      for (const step of emulationSteps(prev, next, { baseUserAgent })) {
        await call.send(step.method, step.params, { timeoutMs: 10_000 });
        if (step.waitMs) await call.sleep(step.waitMs);
      }
    } catch (err) {
      // Leave nothing half-applied behind (also when cancelled): undo everything either state had.
      record.settings = {
        device: next.device ?? prev.device,
        colorScheme: next.colorScheme ?? prev.colorScheme,
        reducedMotion: next.reducedMotion ?? prev.reducedMotion,
        locale: next.locale ?? prev.locale,
        timezone: next.timezone ?? prev.timezone,
        network: next.network ?? prev.network,
        cpu: next.cpu ?? prev.cpu,
      };
      this.tabs.set(tabId, record);
      const ending = this.end(tabId, undefined);
      if (err instanceof ToolError && err.code === 'cancelled') {
        void ending;
        throw err;
      }
      await ending;
      throw new ToolError('failed', `Could not change emulation of ${tabId}: ${err instanceof Error ? err.message : String(err)}. Emulation was turned off.`);
    }
    record.settings = next;
    if (isEmulating(next)) this.tabs.set(tabId, record);
    else this.tabs.delete(tabId);
    this.touchCache.delete(tabId);
    const throttleChanged = !sameNetwork(prev.network, next.network) || prev.cpu !== next.cpu;
    if (throttleChanged) record.throttledSince = isThrottling(next) ? Date.now() : undefined;
    this.throttle.follow(tabId, call.state, next);
    if (!isThrottling(next)) this.throttle.forget(tabId);
    this.changed();

    if (!isEmulating(next)) {
      lines.push(`${tabId} is back to normal: no emulation.`);
      return lines.join('\n');
    }
    const deviceChanged = JSON.stringify(prev.device) !== JSON.stringify(next.device);
    if (deviceChanged && next.device) await call.sleep(300); // VS Code lays out the editor for the new size.
    const vp = await viewport(call);
    lines.push(`${tabId} now emulates ${describeEmulation(next)}. The viewport is ${Math.round(vp.width)}×${Math.round(vp.height)} CSS px.`);
    const mismatch = this.sizeMismatch(next, vp);
    if (mismatch) lines.push(mismatch);
    if (next.device?.mobile) lines.push('Clicks are sent as taps; hover menus, right-click, modifier clicks and dragging do not work while mobile is on.');
    if (throttleChanged && isThrottling(next)) {
      lines.push(
        `It covers the page and its cross-origin frames${next.network?.offline ? ', which see navigator.onLine false' : ''}; responses mocked with browser_route are not slowed and still arrive offline. Your tools keep working. Reload (browser_history) to see a ${next.network ? 'slow or offline' : 'slow'} page load.`,
      );
    }
    lines.push(
      `${next.device ? 'The user sees the device in the browser\'s device toolbar. ' : ''}It lasts until you call browser_emulate with reset: true, release the tab, leave it idle for ${this.host.idleSeconds()} s, or the user resets it.`,
    );
    return lines.join('\n');
  }

  private sizeMismatch(settings: EmulationSettings, vp: { width: number; height: number }): string | undefined {
    const d = settings.device;
    if (!d) return undefined;
    const off = (want: number | undefined, got: number) => want !== undefined && Math.abs(want - got) > 1;
    if (!off(d.width, vp.width) && !off(d.height, vp.height)) return undefined;
    return `VS Code's device emulation does not match what you set (wanted ${d.width ?? 'auto'}×${d.height ?? 'auto'}): the user may have changed or closed it in the browser's device toolbar. Call browser_emulate again if you still need it.`;
  }

  /** Undoes a tab's emulation (best effort when the page is gone) and tells its session next time. */
  private async end(tabId: string, reason: string | undefined): Promise<void> {
    const state = this.tabs.get(tabId);
    if (!state) return;
    this.tabs.delete(tabId);
    this.touchCache.delete(tabId);
    if (reason) this.ended.set(`${state.sessionId}|${tabId}`, reason);
    this.changed();
    this.throttle.stop(tabId);
    // While the extension shuts down the commands may not get through: the next run clears leftovers.
    if (!this.disposing) this.throttle.forget(tabId);
    const page = state.page;
    if (page.closed) return;
    try {
      for (const step of emulationSteps(state.settings, {}, { baseUserAgent: state.baseUserAgent })) {
        await page.send(step.method, step.params, { timeoutMs: 5000 });
        if (step.waitMs) await new Promise(resolve => setTimeout(resolve, step.waitMs));
      }
    } catch (err) {
      this.services.log.warn(`${tabId}: could not end emulation: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** A new CDP connection to an emulated tab has none of our session's overrides: apply them again. */
  private reattach(page: CdpPage): void {
    const state = this.tabs.get(page.tabId);
    if (!state && this.states) this.throttle.clearLeftover(page, () => this.states!.forPage(page));
    page.onDidClose(() =>
      setTimeout(() => {
        if (this.services.browser.getTab(page.tabId)) return;
        this.tabs.delete(page.tabId);
        this.touchCache.delete(page.tabId);
        // The tab is gone, and its throttling with it.
        this.throttle.stop(page.tabId);
        if (!this.disposing) this.throttle.forget(page.tabId);
        this.changed();
      }, 0),
    );
    if (!state || state.page === page) return;
    state.page = page;
    if (this.states && isThrottling(state.settings)) this.throttle.follow(page.tabId, this.states.forPage(page), state.settings);
    void (async () => {
      for (const step of emulationSteps({}, state.settings, { baseUserAgent: state.baseUserAgent, sessionOnly: true })) await page.send(step.method, step.params, { timeoutMs: 5000 });
    })().catch(err => this.services.log.warn(`${page.tabId}: could not restore emulation: ${err instanceof Error ? err.message : String(err)}`));
  }

  private async resetCommand(arg: unknown): Promise<void> {
    let tabId: string | undefined;
    if (typeof arg === 'string') tabId = arg;
    else if (arg instanceof vscode.Uri) tabId = this.host.tabIdForViewId(viewIdOf(arg) ?? '');
    else if (arg && typeof arg === 'object' && typeof (arg as { id?: unknown }).id === 'string') tabId = (arg as { id: string }).id;
    else {
      const active = this.host.activeTabId();
      if (active && this.tabs.has(active)) tabId = active;
      else if (this.tabs.size === 1) tabId = [...this.tabs.keys()][0];
      else if (this.tabs.size > 1) {
        const picked = await vscode.window.showQuickPick(
          [...this.tabs].map(([id, s]) => ({ label: this.services.browser.getTab(id)?.title || id, description: shortEmulationLabel(s.settings), id })),
          { placeHolder: 'End emulation in which tab?' },
        );
        tabId = picked?.id;
      }
    }
    if (!tabId || !this.tabs.has(tabId)) {
      if (arg === undefined && this.tabs.size === 0) vscode.window.setStatusBarMessage('No agent is emulating a device in a browser tab.', 5000);
      return;
    }
    const session = this.services.sessions.get(this.tabs.get(tabId)!.sessionId);
    this.services.log.info(`${tabId}: the user reset the emulation set by ${session?.label ?? 'an agent'}`);
    await this.end(tabId, 'the user reset it');
  }

  // ------------------------------------------------------------------ PageHook

  async usesTouch(call: PageCall): Promise<boolean> {
    const cached = this.touchCache.get(call.tab.id);
    if (cached && Date.now() - cached.at < TOUCH_CACHE_MS && cached.loaderId === call.state.loaderId) return cached.value;
    let value = false;
    try {
      // VS Code's mobile emulation (ours, or the user's from the device toolbar) reports a coarse
      // pointer and touch points; a desktop with a touch screen still has a fine primary pointer.
      value = await call.evaluate<boolean>("function () { return matchMedia('(pointer: coarse)').matches && navigator.maxTouchPoints > 0; }", [], { timeoutMs: 2000 });
    } catch (err) {
      if (err instanceof DialogInterrupt || (err instanceof ToolError && err.code === 'cancelled')) throw err;
    }
    this.touchCache.set(call.tab.id, { value, at: Date.now(), loaderId: call.state.loaderId });
    return value;
  }

  /**
   * While VS Code emulates a device, a screenshot with a clip region makes Chromium replace the device
   * emulation for the capture and then drop it, which leaves the page at the editor's size. A screencast
   * frame shows the page as emulated and is scaled by the browser, so viewport shots use that.
   */
  async screenshot(call: PageCall, request: ScreenshotRequest): Promise<ToolContent[] | undefined> {
    const state = this.tabs.get(call.tab.id);
    if (!state?.settings.device) return undefined;
    const vp = await viewport(call);
    const detail = request.detail ?? 'normal';
    const scale = screenshotScale(vp.width, vp.height, detail);
    let hidden = 0;
    try {
      hidden = await call.evaluate<number>(TOGGLE_BRIDGE_UI, [true]);
    } catch (err) {
      if (err instanceof DialogInterrupt || (err instanceof ToolError && err.code === 'cancelled')) throw err;
    }
    let data: string;
    let factor: number;
    const notes: string[] = [];
    try {
      const frame = await screencastFrame(call, request.format, Math.round(vp.width * scale), Math.round(vp.height * scale));
      if (!frame) {
        data = (await call.send('Page.captureScreenshot', { format: request.format, ...(request.format === 'jpeg' ? { quality: 80 } : {}), fromSurface: true })).data;
        factor = (imageSize(Buffer.from(data, 'base64'))?.width ?? vp.width) / vp.width;
      } else {
        data = frame.data;
        const size = imageSize(Buffer.from(data, 'base64'));
        const { deviceWidth: dw, deviceHeight: dh } = frame.metadata ?? {};
        factor = (size?.width ?? vp.width * scale) / vp.width;
        if (size && dw && dh && Math.abs(size.width / size.height - vp.width / vp.height) > 0.02 * (vp.width / vp.height)) {
          // A tab in the background is drawn at a fixed size without fitting the device to it: the frame
          // shows that whole area, with the emulated viewport at its top-left at 1:1.
          const viewScale = screenshotScale(dw, dh, detail);
          const whole = (await screencastFrame(call, request.format, Math.round(dw * viewScale), Math.round(dh * viewScale))) ?? frame;
          data = whole.data;
          factor = (imageSize(Buffer.from(data, 'base64'))?.width ?? dw * viewScale) / dw;
          const shownW = Math.min(vp.width, dw);
          const shownH = Math.min(vp.height, dh);
          const cut = shownW < vp.width || shownH < vp.height;
          notes.push(
            `${call.tab.id} is in the background, where VS Code draws it in a ${Math.round(dw)}×${Math.round(dh)} px area without fitting the device: the emulated viewport is the top-left ${Math.round(shownW * factor)}×${Math.round(shownH * factor)} px of the image${cut ? ', and the rest of it is cut off' : ''}. Bring the tab to the front with browser_show_tab for a complete picture.`,
          );
        }
      }
    } finally {
      if (hidden > 0 && !call.state.dialog) await call.evaluate(TOGGLE_BRIDGE_UI, [false]).catch(() => undefined);
    }
    const size = imageSize(Buffer.from(data, 'base64'));
    const w = size?.width ?? Math.round(vp.width * factor);
    const h = size?.height ?? Math.round(vp.height * factor);
    if (request.target) {
      const box = await elementBox(call, request.target.backendNodeId);
      notes.push(
        box
          ? `Only the viewport can be captured while a device is emulated; ${request.target.label} is at x ${Math.round(box.x * factor)}, y ${Math.round(box.y * factor)}, ${Math.round(box.width * factor)}×${Math.round(box.height * factor)} px in this image.`
          : `Only the viewport can be captured while a device is emulated, and ${request.target.label} has no visible box in it.`,
      );
    }
    if (request.fullPage) notes.push('Only the viewport can be captured while a device is emulated; scroll with browser_scroll for the rest of the page.');
    const mapping = Math.abs(factor - 1) < 0.01 ? 'Image pixels are viewport CSS pixels, so a point in it can be passed as x/y to browser_click.' : `To click a point in it, divide its image coordinates by ${factor.toFixed(3)} and pass them as x/y to browser_click.`;
    if (sharperAvailable(vp.width, vp.height, detail) && factor < 0.99) notes.push(SHARPER_NOTE);
    const mismatch = this.sizeMismatch(state.settings, vp);
    return [
      image(data, `image/${request.format}`),
      text(
        [`Screenshot of the viewport in ${call.tab.id} (${w}×${h} px; viewport ${Math.round(vp.width)}×${Math.round(vp.height)} CSS px), emulating ${describeEmulation(state.settings)}. ${mapping}`, ...notes, ...(mismatch ? [mismatch] : [])].join(' '),
      ),
    ];
  }

  // ------------------------------------------------------------------ Visibility

  private changed(): void {
    this.host.tabInfoChanged();
    this.updateContextKey();
  }

  private updateContextKey(): void {
    const active = this.host.activeTabId();
    const value = !!active && this.tabs.has(active);
    if (value === this.contextValue) return;
    this.contextValue = value;
    void vscode.commands.executeCommand('setContext', CONTEXT_KEY, value);
  }

  /** browser_audit performance: says that the numbers were (or were not) taken under throttling. */
  measurementNote(call: PageCall, loadedAt: number | undefined): string | undefined {
    const s = this.tabs.get(call.tab.id);
    if (!s || !isThrottling(s.settings)) return undefined;
    return throttlingNote({ network: s.settings.network, cpu: s.settings.cpu, since: s.throttledSince ?? 0 }, loadedAt);
  }

  /** The session that emulates a tab, for messages. */
  describeOwner(tabId: string): string | undefined {
    const s = this.tabs.get(tabId);
    const session = s && this.services.sessions.get(s.sessionId);
    return session ? sessionDisplayName(session) : undefined;
  }

  dispose(): void {
    this.disposing = true;
    for (const s of this.subscriptions.splice(0)) s.dispose();
    // Do not leave the user's tabs in phone size when the extension goes away.
    for (const tabId of [...this.tabs.keys()]) void this.end(tabId, undefined);
    this.throttle.dispose();
  }
}

interface ScreencastFrame {
  data: string;
  sessionId: number;
  /** deviceWidth/deviceHeight: the size of the area VS Code draws the page in, in DIP. */
  metadata?: { deviceWidth?: number; deviceHeight?: number };
}

/** One screencast frame scaled to fit maxWidth × maxHeight, or undefined when none arrives in time. */
async function screencastFrame(call: PageCall, format: 'jpeg' | 'png', maxWidth: number, maxHeight: number): Promise<ScreencastFrame | undefined> {
  let onFrame: (params: ScreencastFrame) => void = () => {};
  const frame = new Promise<ScreencastFrame>(resolve => (onFrame = resolve));
  const sub = call.page.on('Page.screencastFrame', params => onFrame(params));
  try {
    await call.send('Page.startScreencast', { format, ...(format === 'jpeg' ? { quality: 80 } : {}), maxWidth, maxHeight, everyNthFrame: 1 });
    const got = await Promise.race([frame, call.sleep(3000).then(() => undefined)]);
    if (got) void call.page.send('Page.screencastFrameAck', { sessionId: got.sessionId }, { timeoutMs: 3000 }).catch(() => undefined);
    return got;
  } finally {
    sub.dispose();
    if (!call.page.closed) await call.page.send('Page.stopScreencast', {}, { timeoutMs: 3000 }).catch(() => undefined);
  }
}
