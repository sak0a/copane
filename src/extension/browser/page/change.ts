// browser_check_change: a baseline of a tab before the agent edits code, and afterwards a check that
// waits for the dev server's update (hot update or reload) to arrive and settle, then reports only
// what changed. The judgement is in changeLogic.ts, the texts in changeReport.ts, the pixels in png.ts
// and imageDiff.ts; this file talks to the page.
//
// Baselines are per session and tab, in memory (a decoded screenshot of at most 400,000 pixels, about
// 1.6 MB, and positions in the tab's logs), at most 10 per window. A baseline stays as it is until the
// agent takes a new one; each check waits for an update since the previous check (or the baseline),
// lists what is new since then, and compares the screenshot with the baseline's.
//
// A DOM watch runs in the page from the baseline on (WATCH): it learns which elements change on their
// own (a clock, polling, an animation), so only other DOM changes count as an update.
import type { ToolContent } from '../../../shared/protocol';
import { ToolError } from '../../core/errors';
import { image, text } from '../../core/tools';
import { deniedMessage } from '../access';
import { dialogMessage, type PageCall } from './call';
import {
  cleanLocation,
  dedupeErrors,
  dedupeFailures,
  DEV_SERVER_LOST,
  describeUpdate,
  errorKey,
  errorsWithoutFailedRequests,
  failedResourceUrl,
  hmrState,
  hookGeometry,
  isBackgroundRequest,
  isFailedResourceLine,
  isHmrConsole,
  isHmrRequest,
  isRecurring,
  nodeVerdict,
  recordMutation,
  recurringErrors,
  recurringRequests,
  reloadedFrames,
  requestKey,
  settleBlocker,
  type SettleBlocker,
} from './changeLogic';
import { formatBaseline, formatChange, formatNoUpdate, formatStuck, formatTimeout, type ScreenshotOutcome, type ViewState } from './changeReport';
import { formatConsoleEntry, shortLocation, type ConsoleEntry } from './consoleLog';
import { diffImages, regions } from './imageDiff';
import { formatNetworkEntry, isFailure, type NetworkEntry } from './networkLog';
import { DialogInterrupt, type PageState } from './pageState';
import { crop, decodePng, downscale, UnsupportedPng, type RgbaImage } from './png';
import { WITHHELD_MESSAGE } from './privacy';
import { clip } from './ringBuffer';
import { screenshotScale } from './screenshotMath';
import { TOGGLE_BRIDGE_UI } from './scripts';

/** Turns a "url:line:col" from the console into a workspace "file:line:col" (source maps), if it can. */
export type Locate = (call: PageCall, location: string) => Promise<string | undefined>;

/** Widest screenshot kept for comparing (image px), and most pixels (about 1.6 MB as RGBA). */
const DIFF_WIDTH = 800;
const DIFF_PIXELS = 400_000;
const MAX_BASELINES = 10;
const MAX_SETTLE_MS = 10_000;
/** Settling gets at least this long, even when the update arrived just before the timeout. */
const MIN_SETTLE_MS = 3000;
const MAX_LISTED = 8;
const LOCATE_TIMEOUT_MS = 3000;
/** The diff capture is attached as it is up to this size (base64 chars); a busier page gets a JPEG. */
const MAX_PNG_ATTACH = 300_000;
/** Time beyond the check's own limits for reading the page and capturing it. */
const GRACE_MS = 5000;
/** At most this long for one screenshot (a tab in the background takes about a second). */
const CAPTURE_MS = 8000;
/** A whole baseline takes at most this long. */
const BASELINE_MS = 20_000;
/** A page that answered nothing for this long at the timeout is reported as not responding. */
const UNANSWERED_MS = 3000;

interface FrameDoc {
  loaderId: string;
  url: string;
}

export interface Baseline {
  tabId: string;
  /** Position in the tab's logs when the baseline was taken. */
  seq: number;
  loaderId: string | undefined;
  url: string;
  takenAt: number;
  /** Errors and failed request URLs of the document at the baseline (for "still there" after a reload). */
  docErrors: string[];
  docFailureUrls: string[];
  view: ViewState;
  image?: DiffImage;
  imageProblem?: string;
  /** A dev server's error overlay shown at the baseline. */
  overlay?: Overlay;
  /** The overlay text at the baseline or the last check ('' for none): a different one is an update. */
  lastOverlay: string;
  /** Page time (WATCH) at the baseline or the last check: DOM changes after it are new. */
  watchMark: number;
  /** The document the watch mark belongs to. */
  watchDoc: string | undefined;
  /** The frames' documents at the baseline or the last check. */
  frames: Record<string, FrameDoc>;
  /** Requests still in flight at the baseline or the last check: their later failure is new. */
  pending: NetworkEntry[];
  /** How many errors and failed requests checks of this baseline listed as new. */
  reported: { errors: number; failures: number };
  /** Where the last check ended: the next one waits for an update after it. */
  checked?: { seq: number; at: number };
}

/** Baselines per `${sessionId}\0${tabId}`, the most recently used last; at most 10. */
export class ChangeBaselines {
  private readonly map = new Map<string, Baseline>();
  /** Keys whose baseline was dropped to make room (bounded), to say so instead of "no baseline". */
  private readonly evicted = new Set<string>();

  constructor(
    /** False for a tab that no longer exists: its baselines are dropped. */
    private readonly tabExists: (tabId: string) => boolean,
    private readonly max = MAX_BASELINES,
  ) {}

  get(key: string): Baseline | undefined {
    this.prune();
    const b = this.map.get(key);
    if (b) {
      this.map.delete(key);
      this.map.set(key, b);
    }
    return b;
  }

  set(key: string, baseline: Baseline): void {
    this.prune();
    this.map.delete(key);
    this.evicted.delete(key);
    this.map.set(key, baseline);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value!;
      this.map.delete(oldest);
      this.evicted.add(oldest);
      if (this.evicted.size > 200) this.evicted.delete(this.evicted.values().next().value!);
    }
  }

  /** The baseline for this key was dropped because newer ones filled the store. */
  wasEvicted(key: string): boolean {
    return this.evicted.has(key);
  }

  dropSession(sessionId: string): void {
    for (const set of [this.map, this.evicted]) for (const key of [...set.keys()]) if (key.startsWith(`${sessionId}\u0000`)) set.delete(key);
  }

  get size(): number {
    return this.map.size;
  }

  private prune(): void {
    for (const [key, b] of [...this.map]) if (!this.tabExists(b.tabId)) this.map.delete(key);
  }
}

/**
 * Isolated world. Watches the document's DOM (not the bridge's own UI) from the first call on, with a
 * record per mutated node (changeLogic.ts recordMutation, isRecurring, nodeVerdict, embedded here), and
 * returns the page time, how many nodes changed since `mark` (and count as an update, or are not known
 * yet), how many change on their own, and how long the DOM has been quiet apart from those.
 */
export const WATCH = `function (mark) {
  const ${recordMutation.name} = ${recordMutation.toString()};
  const ${isRecurring.name} = ${isRecurring.toString()};
  const ${nodeVerdict.name} = ${nodeVerdict.toString()};
  const record$ = ${recordMutation.name}, recurring$ = ${isRecurring.name}, verdict$ = ${nodeVerdict.name};
  let w = window.__copaneChangeWatch;
  let fresh = false;
  if (!w || w.doc !== document) {
    fresh = true;
    const start = Date.now();
    w = window.__copaneChangeWatch = { doc: document, start, lastForeign: start, nodes: new Map() };
    const ours = (n) => {
      const el = n && (n.nodeType === 1 ? n : n.parentElement);
      return !!(el && el.closest && el.closest('[data-copane-ui]'));
    };
    new MutationObserver((records) => {
      const now = Date.now();
      const seen = new Set();
      for (const r of records) {
        if (ours(r.target)) continue;
        if (r.type === 'childList' && [...r.addedNodes, ...r.removedNodes].every(ours)) continue;
        if (seen.has(r.target)) continue;
        seen.add(r.target);
        const rec = record$(w.nodes.get(r.target), now);
        w.nodes.set(r.target, rec);
        if (!recurring$(rec)) w.lastForeign = now;
      }
      if (w.nodes.size > 5000) for (const [n, rec] of w.nodes) if (now - rec.last > 60000) w.nodes.delete(n);
    }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  }
  const now = Date.now();
  let changed = 0, pending = 0, recurring = 0;
  for (const rec of w.nodes.values()) {
    const v = verdict$(rec, now, w.start);
    if (v === 'recurring') { recurring++; continue; }
    if (rec.last < (mark || 0)) continue;
    if (v === 'changed') changed++; else pending++;
  }
  return { now, changed, pending, recurring, quietMs: now - w.lastForeign, fresh };
}`;

/** Isolated world. The text of a dev server's error overlay (Vite, webpack, Next.js), or null. */
export const OVERLAY_TEXT = `function () {
  const clean = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
  const vite = document.querySelector('vite-error-overlay');
  if (vite) {
    const r = vite.shadowRoot;
    const part = (sel) => clean(r && r.querySelector(sel) && r.querySelector(sel).textContent);
    const text = [part('.plugin'), part('.message-body'), part('.file')].filter(Boolean).join(' ') || clean(r && r.textContent);
    return { kind: 'Vite error overlay', text: text.slice(0, 600) };
  }
  const frame = document.querySelector('iframe#webpack-dev-server-client-overlay');
  if (frame) {
    try {
      const t = clean(frame.contentDocument && frame.contentDocument.body && frame.contentDocument.body.innerText);
      if (t) return { kind: 'webpack error overlay', text: t.slice(0, 600) };
    } catch {}
  }
  const div = document.querySelector('#webpack-dev-server-client-overlay-div');
  if (div && clean(div.innerText)) return { kind: 'webpack error overlay', text: clean(div.innerText).slice(0, 600) };
  for (const portal of document.querySelectorAll('nextjs-portal')) {
    const t = clean(portal.shadowRoot && portal.shadowRoot.textContent);
    if (/Failed to compile|Unhandled Runtime Error|Build Error|Runtime Error/.test(t)) return { kind: 'Next.js error overlay', text: t.slice(0, 600) };
  }
  return null;
}`;

interface WatchState {
  now: number;
  changed: number;
  pending: number;
  recurring: number;
  quietMs: number;
  fresh: boolean;
}

interface Overlay {
  kind: string;
  text: string;
}

/** The time a step may still take: what is left until `until`, capped, never under half a second. */
class Budget {
  constructor(public until: number) {}
  ms(max: number): number {
    return Math.max(500, Math.min(max, this.until - Date.now()));
  }
}

/** Errors a check must pass on: cancellation and dialogs. Anything else means the page could not be read now. */
function rethrowFatal(err: unknown): void {
  if (err instanceof DialogInterrupt || (err instanceof ToolError && err.code === 'cancelled')) throw err;
}

/** Refuses to go on once the user has taken the tab over (paused it, or an agent handed it to them). */
function assertNotPaused(call: PageCall): void {
  if (call.env.services.browser.getTab(call.tab.id)?.paused) throw new ToolError('access_denied', deniedMessage({ kind: 'paused' }, call.tab.id));
}

/** Reads a page-side value; undefined when the page does not answer (and `answered` is not called). */
async function readPage<T>(call: PageCall, fn: string, args: unknown[], budget: Budget, answered?: () => void): Promise<T | undefined> {
  if (call.state.crashed) return undefined;
  try {
    const value = await call.evaluate<T>(fn, args, { timeoutMs: budget.ms(1500) });
    answered?.();
    return value;
  } catch (err) {
    rethrowFatal(err);
    return undefined;
  }
}

const readWatch = (call: PageCall, mark: number, budget: Budget, answered?: () => void) => readPage<WatchState>(call, WATCH, [mark], budget, answered);
const readOverlay = async (call: PageCall, budget: Budget, answered?: () => void) => (await readPage<Overlay | null>(call, OVERLAY_TEXT, [], budget, answered)) ?? undefined;

/** The documents of the page's frames (same-process ones from the frame tree, cross-origin ones from the frame registry). */
async function frameDocs(call: PageCall, budget: Budget): Promise<Record<string, FrameDoc> | undefined> {
  try {
    const { frameTree } = await call.send<{ frameTree: FrameTree }>('Page.getFrameTree', {}, { timeoutMs: budget.ms(3000) });
    const out: Record<string, FrameDoc> = {};
    const walk = (node: FrameTree) => {
      for (const child of node.childFrames ?? []) {
        out[child.frame.id] = { loaderId: child.frame.loaderId, url: child.frame.url };
        walk(child);
      }
    };
    walk(frameTree);
    for (const f of call.state.frames.list()) if (f.loaderId) out[f.id] = { loaderId: f.loaderId, url: f.url };
    return out;
  } catch (err) {
    rethrowFatal(err);
    return undefined;
  }
}

interface FrameTree {
  frame: { id: string; loaderId: string; url: string };
  childFrames?: FrameTree[];
}

/** The viewport in CSS px (as targets.ts `viewport`, bounded in time). */
async function readViewport(call: PageCall, timeoutMs: number): Promise<{ width: number; height: number; pageX: number; pageY: number; dpr: number }> {
  const m = await call.send('Page.getLayoutMetrics', {}, { timeoutMs });
  const css = m.cssVisualViewport ?? m.cssLayoutViewport;
  const dev = m.visualViewport ?? m.layoutViewport;
  return { width: css.clientWidth, height: css.clientHeight, pageX: css.pageX ?? 0, pageY: css.pageY ?? 0, dpr: dev && css.clientWidth ? dev.clientWidth / css.clientWidth : 1 };
}

/**
 * Shows the bridge's page UI again. Sent straight to the tab, not through the call: a cancelled call
 * refuses every command, and the indicator (Take over, Resume, Done) must never stay hidden. While a
 * dialog blocks the page, it is shown again once the dialog is gone.
 */
function showBridgeUi(call: PageCall): void {
  const { state } = call;
  const send = async () => {
    try {
      const contextId = await state.isolatedWorld();
      await state.page.send('Runtime.callFunctionOn', { functionDeclaration: TOGGLE_BRIDGE_UI, executionContextId: contextId, arguments: [{ value: false }], returnByValue: true }, { timeoutMs: 5000 });
    } catch (err) {
      call.ctx.log.warn(`could not show the page indicator of ${call.tab.id} again`, err);
    }
  };
  if (state.page.closed) return;
  if (!state.dialog) {
    void send();
    return;
  }
  const sub = state.onDidChange(() => {
    if (state.dialog) return;
    sub.dispose();
    clearTimeout(timer);
    void send();
  });
  const timer = setTimeout(() => {
    sub.dispose();
    call.ctx.log.warn(`the page indicator of ${call.tab.id} stays hidden: a dialog was still open after 2 minutes`);
  }, 120_000);
}

/** Runs `fn` with the bridge's own page UI hidden (it never shows in screenshots), and shows it again on every way out. */
async function withoutBridgeUi<T>(call: PageCall, budget: Budget, fn: () => Promise<T>): Promise<T> {
  try {
    try {
      await call.evaluate<number>(TOGGLE_BRIDGE_UI, [true], { timeoutMs: budget.ms(2000) });
    } catch (err) {
      rethrowFatal(err);
    }
    return await fn();
  } finally {
    showBridgeUi(call);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => (timer = setTimeout(() => reject(new ToolError('timeout', `The browser did not answer ${what} within ${Math.round(ms / 1000)} s.`)), ms))),
  ]);
}

interface DiffImage {
  img: RgbaImage;
  /** Image px per viewport CSS px (after shrinking). */
  scale: number;
  /** Set when the image's geometry is unknown: regions are given as fractions of an image this size. */
  fractionOf?: { width: number; height: number };
}

interface DiffCapture {
  view: ViewState;
  image?: DiffImage;
  /** The PNG as captured (base64), sized like browser_screenshot's: what the agent can be shown. */
  png?: string;
  /** What the screenshot hook said about its image (device emulation). */
  note?: string;
  problem?: string;
}

/**
 * A PNG of the viewport sized like browser_screenshot's, decoded and shrunk (at most 800 px wide and
 * 400,000 pixels) for comparing. One capture serves both, because a capture of a tab in the background
 * takes about a second. While a device is emulated, the emulation hook takes it; its own description
 * gives the geometry.
 */
async function captureForDiff(call: PageCall, budget: Budget): Promise<DiffCapture> {
  let vp: Awaited<ReturnType<typeof readViewport>>;
  try {
    vp = await readViewport(call, budget.ms(5000));
  } catch (err) {
    rethrowFatal(err);
    return { view: { width: 0, height: 0, scrollX: 0, scrollY: 0 }, problem: `the page did not report its viewport (${clip(errorText(err), 160)})` };
  }
  const view: ViewState = { width: vp.width, height: vp.height, scrollX: vp.pageX, scrollY: vp.pageY };
  let png: string | undefined;
  let note: string | undefined;
  try {
    await withoutBridgeUi(call, budget, async () => {
      for (const hook of call.env.hooks ?? []) {
        if (!hook.screenshot) continue;
        const shot = await withTimeout(hook.screenshot(call, { target: undefined, fullPage: false, format: 'png' }), budget.ms(CAPTURE_MS), 'the screenshot');
        if (!shot) continue;
        const img = shot.find(c => c.type === 'image');
        const said = shot.find(c => c.type === 'text');
        note = said?.type === 'text' ? said.text : '';
        if (img?.type === 'image' && img.mimeType === 'image/png') png = img.data;
        return;
      }
      const s = screenshotScale(vp.width, vp.height);
      const { data } = await call.send<{ data: string }>(
        'Page.captureScreenshot',
        { format: 'png', clip: { x: vp.pageX, y: vp.pageY, width: vp.width, height: vp.height, scale: s / vp.dpr }, fromSurface: true },
        { timeoutMs: budget.ms(CAPTURE_MS) },
      );
      png = data;
    });
  } catch (err) {
    rethrowFatal(err);
    const late = err instanceof ToolError && err.code === 'timeout';
    return { view, problem: late ? 'the screenshot did not arrive in time; the tab may be in the background, where VS Code draws it rarely' : `the screenshot failed: ${clip(errorText(err), 200)}` };
  }
  if (!png) return { view, note, problem: 'no PNG screenshot' };
  try {
    const full = decodePng(Buffer.from(png, 'base64'));
    if (note === undefined) {
      const img = downscale(full, DIFF_WIDTH, DIFF_PIXELS);
      return { view, png, image: { img, scale: img.width / Math.max(1, vp.width) } };
    }
    const geometry = hookGeometry(note);
    if (!geometry) {
      const img = downscale(full, DIFF_WIDTH, DIFF_PIXELS);
      return { view, png, note, image: { img, scale: 1, fractionOf: { width: img.width, height: img.height } } };
    }
    const shown = geometry.viewport ? crop(full, geometry.viewport.width, geometry.viewport.height) : full;
    const img = downscale(shown, DIFF_WIDTH, DIFF_PIXELS);
    return { view, png, note, image: { img, scale: geometry.scale * (img.width / shown.width) } };
  } catch (err) {
    if (err instanceof UnsupportedPng) return { view, note, problem: 'unsupported image' };
    throw err;
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The screenshot the agent gets when the PNG is too big: a JPEG of the viewport, sized like browser_screenshot's. */
async function afterImage(call: PageCall, budget: Budget): Promise<{ image?: ToolContent; note?: string }> {
  try {
    for (const hook of call.env.hooks ?? []) {
      if (!hook.screenshot) continue;
      const shot = await withTimeout(hook.screenshot(call, { target: undefined, fullPage: false, format: 'jpeg' }), budget.ms(CAPTURE_MS), 'the screenshot');
      if (!shot) continue;
      const said = shot.find(c => c.type === 'text');
      return { image: shot.find(c => c.type === 'image'), note: said?.type === 'text' ? said.text : undefined };
    }
    const vp = await readViewport(call, budget.ms(5000));
    const scale = screenshotScale(vp.width, vp.height);
    const { data } = await withoutBridgeUi(call, budget, () =>
      call.send('Page.captureScreenshot', { format: 'jpeg', quality: 80, clip: { x: vp.pageX, y: vp.pageY, width: vp.width, height: vp.height, scale: scale / vp.dpr }, fromSurface: true }, { timeoutMs: budget.ms(CAPTURE_MS) }),
    );
    return { image: image(data, 'image/jpeg') };
  } catch (err) {
    rethrowFatal(err);
    return {};
  }
}

/** `seq` of the navigation that created the current document (0 when it was before recording began). */
function documentStartSeq(state: PageState): number {
  const navs = state.navigations.all();
  for (let i = navs.length - 1; i >= 0; i--) if (!navs[i]!.sameDocument && navs[i]!.loaderId === state.loaderId) return navs[i]!.seq;
  return 0;
}

/** Requests that have not finished (event streams and sockets never do, so they are left out). */
function inFlight(e: NetworkEntry, now: number): boolean {
  return e.end === undefined && !e.failed && e.status === undefined && e.type !== 'EventSource' && e.type !== 'WebSocket' && now - e.startedAt < 60_000;
}

export async function takeBaseline(call: PageCall, store: ChangeBaselines): Promise<string> {
  const { state } = call;
  const budget = new Budget(Date.now() + BASELINE_MS);
  // A page still loading is compared once it has loaded (bounded).
  if (state.loading || !state.lifecycleOf().has('load') || state.networkIdleFor() < 500) {
    const r = await state.waitFor(() => !state.loading && state.lifecycleOf().has('load') && state.networkIdleFor() >= 500, { timeoutMs: 5000, signal: call.signal, pollMs: 100 });
    if (!r.ok && r.reason === 'dialog') throw new ToolError('failed', dialogMessage(call.tab.id, state.dialog!));
  }
  // Starts the DOM watch (it keeps running until the check), or reads the one already running.
  await readWatch(call, 0, budget);
  assertNotPaused(call);
  const shot = await captureForDiff(call, budget);
  const watched = await readWatch(call, 0, budget);
  const overlay = await readOverlay(call, budget);
  const frames = (await frameDocs(call, budget)) ?? {};
  assertNotPaused(call);
  const seq = state.seq;
  const docSeq = documentStartSeq(state);
  const failures = state.network.entries.after(docSeq).filter(e => e.seq <= seq && isFailure(e));
  const consoleErrors = state.console.entries.after(docSeq).filter(e => e.seq <= seq && e.level === 'error');
  // Requests that failed before the bridge recorded the tab are known only from the browser's console line.
  const failedUrls = new Set(failures.map(f => requestKey(f.url)));
  const unrecorded = [...new Set(consoleErrors.filter(e => isFailedResourceLine(e) && !failedUrls.has(requestKey(failedResourceUrl(e)))).map(failedResourceUrl))];
  const errors = consoleErrors.filter(e => !isFailedResourceLine(e) && !(e.source === 'browser' && e.text === WITHHELD_MESSAGE && failures.some(f => f.withheld)));
  const now = Date.now();
  const baseline: Baseline = {
    tabId: call.tab.id,
    seq,
    loaderId: state.loaderId,
    url: state.url,
    takenAt: now,
    docErrors: errors.map(e => e.text),
    docFailureUrls: [...failures.map(f => f.url), ...unrecorded],
    view: shot.view,
    image: shot.image,
    imageProblem: shot.problem,
    overlay,
    lastOverlay: overlay?.text ?? '',
    watchMark: watched?.now ?? 0,
    watchDoc: state.loaderId,
    frames,
    pending: state.network.entries.after(docSeq).filter(e => e.seq <= seq && inFlight(e, now)),
    reported: { errors: 0, failures: 0 },
  };
  store.set(call.sessionTabKey, baseline);
  return formatBaseline({
    tabId: call.tab.id,
    url: state.url,
    view: shot.view,
    errors: errors.length,
    failures: failures.length + unrecorded.length,
    selfChanging: watched?.recurring ?? 0,
    imageProblem: shot.problem,
    overlay,
  });
}

export interface CheckOptions {
  reload: boolean;
  timeoutMs: number;
  locate?: Locate;
}

export async function checkChange(call: PageCall, base: Baseline, options: CheckOptions): Promise<string | ToolContent[]> {
  const { state } = call;
  const started = Date.now();
  const sinceSeq = base.checked?.seq ?? base.seq;
  const sinceAt = base.checked?.at ?? base.takenAt;
  const deadline = started + options.timeoutMs;
  const budget = new Budget(deadline + GRACE_MS);
  let step = 'reloading';
  try {
    return await runCheck();
  } catch (err) {
    if (!(err instanceof ToolError && err.code === 'timeout')) throw err;
    // The tab stopped answering: say so, with what the logs already show.
    const failures = state.network.entries.after(sinceSeq).filter(isFailure);
    const errors = errorsWithoutFailedRequests(state.console.entries.after(sinceSeq), failures);
    const now = Date.now();
    const consoleTexts = state.console.entries.after(sinceSeq).map(e => e.text);
    const requestUrls = state.network.entries.after(sinceSeq).filter(e => isHmrRequest(e, state.url)).map(e => e.url);
    const update = describeUpdate({ documentChanged: state.loaderId !== base.loaderId, urlChanged: state.url !== base.url, consoleTexts, requestUrls, overlay: false, newErrors: 0, domChanged: false, frames: [] });
    return formatStuck({ tabId: call.tab.id, step, waitedMs: now - started, update: update === 'a change' ? undefined : update, errors: errors.slice(0, MAX_LISTED).map(e => clip(e.text.split('\n')[0]!, 300)), failures: failures.slice(0, MAX_LISTED).map(f => formatNetworkEntry(f, now)) });
  }

  async function runCheck(): Promise<string | ToolContent[]> {
    const failDialog = (): never => {
      throw new ToolError('failed', dialogMessage(call.tab.id, state.dialog!));
    };
    if (options.reload && !state.crashed) {
      try {
        await call.send('Page.reload', { ignoreCache: false }, { timeoutMs: budget.ms(10_000) });
      } catch (err) {
        if (!(err instanceof DialogInterrupt)) throw err;
      }
    }

    // 1. Wait for a sign that an update arrived (it may have come before this call). What the page
    //    does on its own (polling, a recurring error) is not one.
    step = 'waiting for the update';
    const before = state.network.entries.all().filter(e => e.seq <= sinceSeq);
    const recurringUrls = recurringRequests(before);
    const recurringErrorKeys = recurringErrors(state.console.entries.all().filter(e => e.seq <= sinceSeq && e.level === 'error'));
    let lastAnswer = Date.now();
    const answered = () => (lastAnswer = Date.now());
    const ownFailure = (e: NetworkEntry) => isFailure(e) && !isBackgroundRequest(e, recurringUrls);
    const logSignal = (): boolean =>
      state.crashed ||
      state.navigations.after(sinceSeq).length > 0 ||
      state.frames.navigations.after(sinceSeq).some(n => !n.detached) ||
      state.console.entries.after(sinceSeq).some(e => isHmrConsole(e.text) || (e.level === 'error' && !recurringErrorKeys.has(errorKey(e.text)) && !(isFailedResourceLine(e) && recurringUrls.has(requestKey(failedResourceUrl(e)))))) ||
      state.network.entries.after(sinceSeq).some(e => isHmrRequest(e, state.url) || ownFailure(e)) ||
      base.pending.some(ownFailure);
    let domChanged = false;
    let watch: WatchState | undefined;
    for (;;) {
      assertNotPaused(call);
      if (logSignal()) break;
      // An overlay that appeared, changed or went away (one already there at the last look is not news).
      if (((await readOverlay(call, budget, answered))?.text ?? '') !== base.lastOverlay) break;
      watch = (await readWatch(call, base.watchMark, budget, answered)) ?? watch;
      if (watch && !watch.fresh && state.loaderId === base.watchDoc && watch.changed > 0) {
        domChanged = true;
        break;
      }
      const frames = await frameDocs(call, budget);
      if (frames && reloadedFrames(base.frames, frames).length) break;
      const left = deadline - Date.now();
      if (left <= 0) {
        if (Date.now() - lastAnswer > UNANSWERED_MS) throw new ToolError('timeout', 'no answer');
        return formatTimeout({
          tabId: call.tab.id,
          timeoutMs: options.timeoutMs,
          sinceMs: Date.now() - sinceAt,
          since: base.checked ? 'last check' : 'baseline',
          selfChanging: watch?.recurring ?? 0,
          pendingDom: watch?.pending ?? 0,
          hasFrames: Object.keys(frames ?? base.frames).length > 0,
          devServerLost: devServerLost(state, sinceSeq),
        });
      }
      const r = await state.waitFor(logSignal, { timeoutMs: Math.min(200, left), signal: call.signal });
      if (!r.ok && r.reason === 'dialog') failDialog();
    }
    const signalAt = Date.now();
    const signalSeq = state.seq;

    // 2. Wait for the page to settle: loaded, the update's requests done, DOM quiet (apart from what
    //    changes on its own), no update half-applied.
    step = 'waiting for the page to settle';
    const settleUntil = signalAt + Math.min(MAX_SETTLE_MS, Math.max(MIN_SETTLE_MS, deadline - signalAt));
    budget.until = settleUntil + GRACE_MS + CAPTURE_MS;
    const background = recurringRequests(state.network.entries.all().filter(e => e.seq <= signalSeq));
    let busySince = 0;
    let blocker: SettleBlocker | undefined;
    const stuck = () => !state.crashed && Date.now() - lastAnswer > UNANSWERED_MS;
    lastAnswer = Date.now();
    for (;;) {
      assertNotPaused(call);
      if (state.crashed) break;
      // A page that stops answering (a script that never ends) will not settle: say so now.
      if (stuck()) throw new ToolError('timeout', 'no answer');
      const now = Date.now();
      let domQuietMs = 0;
      if (state.loading || !state.lifecycleOf().has('DOMContentLoaded')) answered();
      else {
        const w = await readWatch(call, base.watchMark, budget, answered);
        // Quiet counts from the update on: a DOM quiet since long before it has not received it yet.
        domQuietMs = Math.min(w ? w.quietMs : Infinity, Date.now() - signalAt);
      }
      const own = state.network.entries.after(sinceSeq).filter(e => !isBackgroundRequest(e, background));
      if (own.some(e => inFlight(e, now))) busySince = now;
      const lastStart = Math.max(0, ...own.map(e => e.startedAt));
      blocker = settleBlocker({
        loading: state.loading,
        documentChanged: state.loaderId !== base.loaderId,
        loaded: state.lifecycleOf().has('load'),
        networkIdleMs: now - Math.max(busySince, lastStart),
        domQuietMs,
        hmrPending: hmrState(consoleLines(state, sinceSeq), now) === 'pending',
      });
      if (!blocker || Date.now() >= settleUntil) break;
      const r = await state.waitFor(() => state.crashed, { timeoutMs: 150, signal: call.signal });
      if (!r.ok && r.reason === 'dialog') failDialog();
    }

    // 3. Read the logs once, up to a fixed point: the next check starts exactly there.
    step = 'reading the page';
    assertNotPaused(call);
    const endSeq = state.seq;
    const endWatch = await readWatch(call, base.watchMark, budget, answered);
    if (stuck()) throw new ToolError('timeout', 'no answer');
    const endDoc = state.loaderId;
    const endFrames = await frameDocs(call, budget);
    const now = Date.now();
    const documentChanged = state.loaderId !== base.loaderId;
    const docSeq = documentChanged ? documentStartSeq(state) : Infinity;
    const consoleNew = state.console.entries.after(sinceSeq).filter(e => e.seq <= endSeq);
    const networkNew = state.network.entries.after(sinceSeq).filter(e => e.seq <= endSeq);
    // Requests sent before the last checkpoint that failed since count as new too.
    const failures = [...networkNew.filter(isFailure), ...base.pending.filter(e => isFailure(e) && !networkNew.includes(e))];
    const errors = errorsWithoutFailedRequests(consoleNew, failures);
    const errorSplit = dedupeErrors(errors.filter(e => e.seq > docSeq), base.docErrors, documentChanged);
    const freshErrors = [...errors.filter(e => e.seq <= docSeq), ...errorSplit.fresh];
    const failureSplit = dedupeFailures(failures.filter(e => e.seq > docSeq), base.docFailureUrls, documentChanged);
    const freshFailures = [...failures.filter(e => e.seq <= docSeq), ...failureSplit.fresh];
    const errorLines = await Promise.all(freshErrors.slice(0, MAX_LISTED).map(e => formatError(call, e, options.locate)));
    const failureLines = freshFailures.slice(0, MAX_LISTED).map(f => formatNetworkEntry(f, now));
    const navigated = state.url !== base.url ? { from: base.url, to: state.url } : undefined;
    const frames = endFrames ? reloadedFrames(base.frames, endFrames) : [];
    const crashed = state.crashed;
    const hmr = hmrState(consoleLines(state, sinceSeq, endSeq), now);

    // 4. The screenshot, compared with the baseline's.
    step = 'taking the screenshot';
    const overlay = crashed ? undefined : await readOverlay(call, budget);
    let screenshot: ScreenshotOutcome | undefined;
    let scrolled: { from: ViewState; to: ViewState } | undefined;
    let attach: ToolContent | undefined;
    let imageNote: string | undefined;
    if (!crashed) {
      assertNotPaused(call);
      const after = await captureForDiff(call, budget);
      const resized = after.view.width > 0 && (Math.abs(after.view.width - base.view.width) > 1 || Math.abs(after.view.height - base.view.height) > 1);
      if (resized) screenshot = { kind: 'resized', from: base.view, to: after.view };
      else if (!base.image) screenshot = { kind: 'skipped', reason: base.imageProblem ?? 'no baseline screenshot' };
      else if (!after.image) screenshot = { kind: 'skipped', reason: after.problem ?? 'no screenshot' };
      else if (after.image.img.width !== base.image.img.width || after.image.img.height !== base.image.img.height) screenshot = { kind: 'skipped', reason: 'the screenshots differ in size' };
      else screenshot = { kind: 'diff', ...regions(diffImages(base.image.img, after.image.img), after.image.scale), fractionOf: after.image.fractionOf };
      if (after.view.width > 0 && (Math.abs(after.view.scrollX - base.view.scrollX) >= 1 || Math.abs(after.view.scrollY - base.view.scrollY) >= 1)) scrolled = { from: base.view, to: after.view };
      if ((screenshot.kind === 'diff' && screenshot.changed > 0) || screenshot.kind === 'resized' || navigated) {
        if (after.png && after.png.length <= MAX_PNG_ATTACH) {
          attach = image(after.png, 'image/png');
          imageNote = after.note;
        } else {
          assertNotPaused(call);
          const jpeg = await afterImage(call, budget);
          attach = jpeg.image;
          imageNote = jpeg.note;
        }
      }
    }

    const overlayChanged = Boolean(overlay) && overlay?.text !== base.lastOverlay;
    const unchanged = !crashed && !freshErrors.length && !freshFailures.length && !navigated && !documentChanged && !frames.length && !overlayChanged && (!screenshot || (screenshot.kind === 'diff' && screenshot.changed === 0));
    const earlier = { ...base.reported };
    // The next check starts where these logs ended.
    base.checked = { seq: endSeq, at: now };
    base.lastOverlay = overlay?.text ?? '';
    if (endWatch) {
      base.watchMark = endWatch.now;
      base.watchDoc = endDoc;
    }
    if (endFrames) base.frames = endFrames;
    base.pending = [...base.pending.filter(e => inFlight(e, now)), ...networkNew.filter(e => inFlight(e, now))];
    base.reported = { errors: base.reported.errors + freshErrors.length, failures: base.reported.failures + freshFailures.length };

    if (unchanged && (hmr === 'nothing' || hmr === 'silent')) {
      const line = [...consoleNew].reverse().find(e => isHmrConsole(e.text))?.text.split('\n')[0] ?? '';
      return formatNoUpdate({ tabId: call.tab.id, how: hmr, line, elapsedMs: Date.now() - started });
    }
    const update = describeUpdate({
      documentChanged,
      urlChanged: Boolean(navigated),
      consoleTexts: consoleNew.map(e => e.text),
      requestUrls: networkNew.filter(e => isHmrRequest(e, state.url)).map(e => e.url),
      overlay: overlayChanged,
      newErrors: freshErrors.length,
      domChanged,
      frames,
    });
    const report = formatChange({
      tabId: call.tab.id,
      update,
      elapsedMs: Date.now() - started,
      errors: errorLines,
      moreErrors: Math.max(0, freshErrors.length - MAX_LISTED),
      failures: failureLines,
      moreFailures: Math.max(0, freshFailures.length - MAX_LISTED),
      still: { errors: errorSplit.still.length, failures: failureSplit.still.length },
      earlier,
      warnings: consoleNew.filter(e => e.level === 'warning').length,
      navigated,
      overlay: overlay && overlay.text !== base.overlay?.text ? overlay : undefined,
      // A different overlay is listed as new; the baseline's one is then replaced, not gone.
      overlayBefore: !base.overlay ? undefined : !overlay ? 'gone' : overlay.text === base.overlay.text ? 'still' : undefined,
      crashed,
      screenshot,
      scrolled,
      imageAttached: Boolean(attach),
      imageNote,
      unsettled: blocker && !crashed ? { blocker, ms: Date.now() - signalAt } : undefined,
      devServerLost: devServerLost(state, sinceSeq),
      frames,
      selfChanging: endWatch?.recurring ?? 0,
    });
    return attach ? [text(report), attach] : report;
  }
}

function consoleLines(state: PageState, sinceSeq: number, endSeq = Infinity): Array<{ text: string; time: number }> {
  return state.console.entries
    .after(sinceSeq)
    .filter(e => e.seq <= endSeq)
    .map(e => ({ text: e.text, time: e.time }));
}

/** "[exception] Uncaught TypeError: …  (src/x.vue:31:18)": the first line, located through `locate` when it can. */
async function formatError(call: PageCall, e: ConsoleEntry, locate: Locate | undefined): Promise<string> {
  const firstLine = clip(e.text.split('\n')[0]!, 300);
  const line = formatConsoleEntry({ ...e, text: firstLine }, { withLocation: false });
  if (!e.location || e.text === WITHHELD_MESSAGE) return line;
  let where: string | undefined;
  if (locate) {
    try {
      where = await Promise.race([locate(call, e.location), new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), LOCATE_TIMEOUT_MS))]);
    } catch (err) {
      rethrowFatal(err);
    }
  }
  return `${line}  (${where ?? cleanLocation(shortLocation(e.location, call.state.url))})`;
}

function devServerLost(state: PageState, sinceSeq: number): string | undefined {
  const entry = state.console.entries.after(sinceSeq).find(e => DEV_SERVER_LOST.test(e.text));
  return entry ? entry.text.split('\n')[0] : undefined;
}
