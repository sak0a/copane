// browser_check_change: a baseline of a tab before the agent edits code, and afterwards a check that
// waits for the dev server's update (hot update or reload) to arrive and settle, then reports only
// what changed. The judgement is in changeLogic.ts, the texts in changeReport.ts, the pixels in png.ts
// and imageDiff.ts; this file talks to the page.
//
// Baselines are per session and tab, in memory (a decoded screenshot of at most 800 px width, about
// 1.5 MB, and positions in the tab's logs), at most 10 per window. A baseline stays as it is until the
// agent takes a new one; each check waits for an update since the previous check (or the baseline)
// and compares the page with the baseline.
import type { ToolContent } from '../../../shared/protocol';
import { ToolError } from '../../core/errors';
import { image, text } from '../../core/tools';
import { dialogMessage, type PageCall } from './call';
import { cleanLocation, dedupeErrors, DEV_SERVER_LOST, describeUpdate, hmrPending, isHmrConsole, isHmrRequest, repeatsFailedRequest, settleBlocker, type SettleBlocker } from './changeLogic';
import { formatBaseline, formatChange, formatTimeout, type ScreenshotOutcome, type ViewState } from './changeReport';
import { formatConsoleEntry, shortLocation, type ConsoleEntry } from './consoleLog';
import { diffImages, regions } from './imageDiff';
import { formatNetworkEntry, isFailure, withheldUrl, type NetworkEntry } from './networkLog';
import { DialogInterrupt, type PageState } from './pageState';
import { decodePng, downscale, UnsupportedPng, type RgbaImage } from './png';
import { WITHHELD_MESSAGE } from './privacy';
import { clip } from './ringBuffer';
import { screenshotScale } from './screenshotMath';
import { TOGGLE_BRIDGE_UI } from './scripts';
import { viewport } from './targets';

/** Turns a "url:line:col" from the console into a workspace "file:line:col" (source maps), if it can. */
export type Locate = (call: PageCall, location: string) => Promise<string | undefined>;

/** Widest screenshot kept for comparing (image px). */
const DIFF_WIDTH = 800;
const MAX_BASELINES = 10;
const MAX_SETTLE_MS = 10_000;
/** Settling gets at least this long, even when the update arrived just before the timeout. */
const MIN_SETTLE_MS = 3000;
const MAX_LISTED = 8;
const LOCATE_TIMEOUT_MS = 3000;
/** The diff capture is attached as it is up to this size (base64 chars); a busier page gets a JPEG. */
const MAX_PNG_ATTACH = 300_000;

export interface Baseline {
  tabId: string;
  /** Position in the tab's logs when the baseline was taken. */
  seq: number;
  loaderId: string | undefined;
  url: string;
  takenAt: number;
  /** Errors and failed requests of the document at the baseline (for "still there" after a reload). */
  docErrors: string[];
  docFailures: string[];
  view: ViewState;
  image?: { img: RgbaImage; scale: number };
  imageProblem?: string;
  /** The DOM changed on its own while the baseline watched it: DOM changes do not signal an update. */
  churn: boolean;
  /** A dev server's error overlay shown at the baseline. */
  overlay?: Overlay;
  /** The overlay text at the baseline or the last check ('' for none): a different one is an update. */
  lastOverlay: string;
  /** The DOM mutation counter (WATCH) at the baseline or the last check, and its document. */
  watch: { loaderId: string | undefined; count: number };
  /** Where the last check ended: the next one waits for an update after it. */
  checked?: { seq: number; at: number };
}

/** Baselines per `${sessionId}\0${tabId}`, the most recently used last; at most 10. */
export class ChangeBaselines {
  private readonly map = new Map<string, Baseline>();

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
    this.map.set(key, baseline);
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
  }

  dropSession(sessionId: string): void {
    for (const key of [...this.map.keys()]) if (key.startsWith(`${sessionId}\u0000`)) this.map.delete(key);
  }

  get size(): number {
    return this.map.size;
  }

  private prune(): void {
    for (const [key, b] of [...this.map]) if (!this.tabExists(b.tabId)) this.map.delete(key);
  }
}

/**
 * Isolated world. Counts DOM mutations of the document (not the bridge's own UI) from the first call
 * on, and returns the count and how long the DOM has been quiet.
 */
export const WATCH = `function () {
  let w = window.__copaneChangeWatch;
  let fresh = false;
  if (!w || w.doc !== document) {
    fresh = true;
    w = window.__copaneChangeWatch = { count: 0, last: Date.now(), doc: document };
    const ours = (n) => {
      const el = n && (n.nodeType === 1 ? n : n.parentElement);
      return !!(el && el.closest && el.closest('[data-copane-ui]'));
    };
    new MutationObserver((records) => {
      for (const r of records) {
        if (ours(r.target)) continue;
        if (r.type === 'childList' && [...r.addedNodes, ...r.removedNodes].every(ours)) continue;
        w.count++;
        w.last = Date.now();
        return;
      }
    }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  }
  return { count: w.count, quietMs: Date.now() - w.last, fresh };
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
  count: number;
  quietMs: number;
  fresh: boolean;
}

/** Errors a check must pass on: cancellation and dialogs. Anything else means the page could not be read now. */
function rethrowFatal(err: unknown): void {
  if (err instanceof DialogInterrupt || (err instanceof ToolError && err.code === 'cancelled')) throw err;
}

async function readWatch(call: PageCall): Promise<WatchState | undefined> {
  if (call.state.crashed) return undefined;
  try {
    return await call.evaluate<WatchState>(WATCH, [], { timeoutMs: 1500 });
  } catch (err) {
    rethrowFatal(err);
    return undefined;
  }
}

interface Overlay {
  kind: string;
  text: string;
}

async function readOverlay(call: PageCall): Promise<Overlay | undefined> {
  if (call.state.crashed) return undefined;
  try {
    return (await call.evaluate<Overlay | null>(OVERLAY_TEXT, [], { timeoutMs: 1500 })) ?? undefined;
  } catch (err) {
    rethrowFatal(err);
    return undefined;
  }
}

/** Runs `fn` with the bridge's own page UI hidden (it never shows in screenshots). */
async function withoutBridgeUi<T>(call: PageCall, fn: () => Promise<T>): Promise<T> {
  let hidden = 0;
  try {
    hidden = await call.evaluate<number>(TOGGLE_BRIDGE_UI, [true], { timeoutMs: 2000 });
  } catch (err) {
    rethrowFatal(err);
  }
  try {
    return await fn();
  } finally {
    if (hidden > 0 && !call.state.dialog) await call.evaluate(TOGGLE_BRIDGE_UI, [false]).catch(() => undefined);
  }
}

interface DiffCapture {
  view: ViewState;
  image?: { img: RgbaImage; scale: number };
  /** The PNG as captured (base64), sized like browser_screenshot's: what the agent can be shown. */
  png?: string;
  problem?: string;
}

/**
 * A PNG of the viewport sized like browser_screenshot's, decoded and shrunk to at most 800 px width for
 * comparing. One capture serves both, because a capture of a tab in the background takes about a second.
 */
async function captureForDiff(call: PageCall): Promise<DiffCapture> {
  const vp = await viewport(call);
  const view: ViewState = { width: vp.width, height: vp.height, scrollX: vp.pageX, scrollY: vp.pageY };
  let png: string;
  try {
    png = await withoutBridgeUi(call, async () => {
      for (const hook of call.env.hooks ?? []) {
        const shot = await hook.screenshot?.(call, { target: undefined, fullPage: false, format: 'png' });
        if (!shot) continue;
        const img = shot.find(c => c.type === 'image');
        if (img?.type === 'image' && img.mimeType === 'image/png') return img.data;
        break;
      }
      const s = screenshotScale(vp.width, vp.height);
      const { data } = await call.send<{ data: string }>('Page.captureScreenshot', { format: 'png', clip: { x: vp.pageX, y: vp.pageY, width: vp.width, height: vp.height, scale: s / vp.dpr }, fromSurface: true });
      return data;
    });
  } catch (err) {
    rethrowFatal(err);
    return { view, problem: `the screenshot failed: ${clip(err instanceof Error ? err.message : String(err), 200)}` };
  }
  try {
    const img = downscale(decodePng(Buffer.from(png, 'base64')), DIFF_WIDTH);
    return { view, png, image: { img, scale: img.width / Math.max(1, vp.width) } };
  } catch (err) {
    if (err instanceof UnsupportedPng) return { view, problem: 'unsupported image' };
    throw err;
  }
}

/** The screenshot the agent gets when the PNG is too big: a JPEG of the viewport, sized like browser_screenshot's. */
async function afterImage(call: PageCall): Promise<ToolContent | undefined> {
  try {
    for (const hook of call.env.hooks ?? []) {
      const shot = await hook.screenshot?.(call, { target: undefined, fullPage: false, format: 'jpeg' });
      if (shot) return shot.find(c => c.type === 'image');
    }
    const vp = await viewport(call);
    const scale = screenshotScale(vp.width, vp.height);
    const { data } = await withoutBridgeUi(call, () =>
      call.send('Page.captureScreenshot', { format: 'jpeg', quality: 80, clip: { x: vp.pageX, y: vp.pageY, width: vp.width, height: vp.height, scale: scale / vp.dpr }, fromSurface: true }),
    );
    return image(data, 'image/jpeg');
  } catch (err) {
    rethrowFatal(err);
    return undefined;
  }
}

/** `seq` of the navigation that created the current document (0 when it was before recording began). */
function documentStartSeq(state: PageState): number {
  const navs = state.navigations.all();
  for (let i = navs.length - 1; i >= 0; i--) if (!navs[i]!.sameDocument && navs[i]!.loaderId === state.loaderId) return navs[i]!.seq;
  return 0;
}

/** The error entries, without the browser's "Failed to load resource" lines for requests listed as failed anyway. */
function consoleErrors(entries: ConsoleEntry[], failures: NetworkEntry[]): ConsoleEntry[] {
  const urls = new Set(failures.map(f => f.url));
  return entries.filter(e => e.level === 'error' && !repeatsFailedRequest(e, urls));
}

function failureKey(e: NetworkEntry): string {
  return `${e.method} ${e.failed ?? e.status} ${withheldUrl(e.url)}`;
}

export async function takeBaseline(call: PageCall, store: ChangeBaselines): Promise<string> {
  const { state } = call;
  // A page still loading is compared once it has loaded (bounded).
  if (state.loading || !state.lifecycleOf().has('load') || state.networkIdleFor() < 500) {
    const r = await state.waitFor(() => !state.loading && state.lifecycleOf().has('load') && state.networkIdleFor() >= 500, { timeoutMs: 5000, signal: call.signal, pollMs: 100 });
    if (!r.ok && r.reason === 'dialog') throw new ToolError('failed', dialogMessage(call.tab.id, state.dialog!));
  }
  const first = await readWatch(call);
  await call.sleep(300);
  const second = await readWatch(call);
  const churn = Boolean(first && second && second.count > first.count);
  const shot = await captureForDiff(call);
  const watched = await readWatch(call);
  const overlay = await readOverlay(call);
  const docSeq = documentStartSeq(state);
  const failures = state.network.entries.after(docSeq).filter(isFailure);
  const errors = consoleErrors(state.console.entries.after(docSeq), failures);
  const baseline: Baseline = {
    tabId: call.tab.id,
    seq: state.seq,
    loaderId: state.loaderId,
    url: state.url,
    takenAt: Date.now(),
    docErrors: errors.map(e => e.text),
    docFailures: failures.map(failureKey),
    view: shot.view,
    image: shot.image,
    imageProblem: shot.problem,
    churn,
    overlay,
    lastOverlay: overlay?.text ?? '',
    watch: { loaderId: state.loaderId, count: watched?.count ?? 0 },
  };
  store.set(call.sessionTabKey, baseline);
  return formatBaseline({ tabId: call.tab.id, url: state.url, view: shot.view, errors: errors.length, failures: failures.length, churn, imageProblem: shot.problem, overlay });
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
  const failDialog = () => {
    throw new ToolError('failed', dialogMessage(call.tab.id, state.dialog!));
  };
  if (options.reload && !state.crashed) {
    try {
      await call.send('Page.reload', { ignoreCache: false });
    } catch (err) {
      if (!(err instanceof DialogInterrupt)) throw err;
    }
  }

  // 1. Wait for a sign that an update arrived (it may have come before this call).
  const deadline = started + options.timeoutMs;
  const signalled = (): boolean =>
    state.crashed ||
    state.navigations.after(sinceSeq).length > 0 ||
    state.console.entries.after(sinceSeq).some(e => e.level === 'error' || isHmrConsole(e.text)) ||
    state.network.entries.after(sinceSeq).some(e => isHmrRequest(e.url));
  let domChanged = false;
  for (;;) {
    if (signalled()) break;
    // An overlay that appeared, changed or went away (one already there at the last look is not news).
    if (((await readOverlay(call))?.text ?? '') !== base.lastOverlay) break;
    if (!base.churn) {
      const w = await readWatch(call);
      if (w && !w.fresh && state.loaderId === base.watch.loaderId && w.count > base.watch.count) {
        domChanged = true;
        break;
      }
    }
    const left = deadline - Date.now();
    if (left <= 0) {
      return formatTimeout({ tabId: call.tab.id, timeoutMs: options.timeoutMs, sinceMs: Date.now() - sinceAt, since: base.checked ? 'last check' : 'baseline', churn: base.churn, devServerLost: devServerLost(state, sinceSeq) });
    }
    const r = await state.waitFor(signalled, { timeoutMs: Math.min(200, left), signal: call.signal });
    if (!r.ok && r.reason === 'dialog') failDialog();
  }
  const signalAt = Date.now();

  // 2. Wait for the page to settle: loaded, network quiet, DOM quiet, no update half-applied.
  const settleUntil = signalAt + Math.min(MAX_SETTLE_MS, Math.max(MIN_SETTLE_MS, deadline - signalAt));
  let blocker: SettleBlocker | undefined;
  for (;;) {
    if (state.crashed) break;
    let domQuietMs = 0;
    if (!state.loading && state.lifecycleOf().has('DOMContentLoaded')) {
      const w = await readWatch(call);
      // Quiet counts from the update on: a DOM quiet since long before it has not received it yet.
      if (w) domQuietMs = Math.min(w.quietMs, Date.now() - signalAt);
    }
    blocker = settleBlocker({
      loading: state.loading,
      documentChanged: state.loaderId !== base.loaderId,
      loaded: state.lifecycleOf().has('load'),
      networkIdleMs: state.networkIdleFor(),
      domQuietMs,
      churn: base.churn,
      sinceSignalMs: Date.now() - signalAt,
      hmrPending: hmrPending(state.console.entries.after(sinceSeq).map(e => e.text)),
    });
    if (!blocker || Date.now() >= settleUntil) break;
    const r = await state.waitFor(() => state.crashed, { timeoutMs: 150, signal: call.signal });
    if (!r.ok && r.reason === 'dialog') failDialog();
  }

  // 3. Compare with the baseline.
  const documentChanged = state.loaderId !== base.loaderId;
  const docSeq = documentChanged ? documentStartSeq(state) : Infinity;
  const consoleNew = state.console.entries.after(sinceSeq);
  const networkNew = state.network.entries.after(sinceSeq);
  const failures = networkNew.filter(isFailure);
  const errors = consoleErrors(consoleNew, failures);
  const inNewDoc = errors.filter(e => e.seq > docSeq);
  const errorSplit = dedupeErrors(inNewDoc, base.docErrors, documentChanged);
  const freshErrors = [...errors.filter(e => e.seq <= docSeq), ...errorSplit.fresh];
  const failuresBefore = new Map<string, number>();
  for (const k of base.docFailures) failuresBefore.set(k, (failuresBefore.get(k) ?? 0) + 1);
  const freshFailures: NetworkEntry[] = [];
  let stillFailures = 0;
  for (const f of failures) {
    const n = f.seq > docSeq ? (failuresBefore.get(failureKey(f)) ?? 0) : 0;
    if (n > 0) {
      failuresBefore.set(failureKey(f), n - 1);
      stillFailures++;
    } else freshFailures.push(f);
  }
  const earlierFailureList = state.network.entries.after(base.seq).filter(e => e.seq <= sinceSeq && isFailure(e));
  const earlierErrors = consoleErrors(state.console.entries.after(base.seq).filter(e => e.seq <= sinceSeq), earlierFailureList).length;
  const earlierFailures = earlierFailureList.length;
  const now = Date.now();
  const errorLines = await Promise.all(freshErrors.slice(0, MAX_LISTED).map(e => formatError(call, e, options.locate)));
  const failureLines = freshFailures.slice(0, MAX_LISTED).map(f => formatNetworkEntry(f, now));
  const navigated = state.url !== base.url ? { from: base.url, to: state.url } : undefined;
  const crashed = state.crashed;
  const overlay = crashed ? undefined : await readOverlay(call);

  let screenshot: ScreenshotOutcome | undefined;
  let scrolled: { from: ViewState; to: ViewState } | undefined;
  let attach: ToolContent | undefined;
  if (!crashed) {
    const after = await captureForDiff(call);
    const resized = Math.abs(after.view.width - base.view.width) > 1 || Math.abs(after.view.height - base.view.height) > 1;
    if (resized) screenshot = { kind: 'resized', from: base.view, to: after.view };
    else if (!base.image) screenshot = { kind: 'skipped', reason: base.imageProblem ?? 'no baseline screenshot' };
    else if (!after.image) screenshot = { kind: 'skipped', reason: after.problem ?? 'no screenshot' };
    else if (after.image.img.width !== base.image.img.width || after.image.img.height !== base.image.img.height) screenshot = { kind: 'skipped', reason: 'the screenshots differ in size' };
    else screenshot = { kind: 'diff', ...regions(diffImages(base.image.img, after.image.img), after.image.scale) };
    if (Math.abs(after.view.scrollX - base.view.scrollX) >= 1 || Math.abs(after.view.scrollY - base.view.scrollY) >= 1) scrolled = { from: base.view, to: after.view };
    if ((screenshot.kind === 'diff' && screenshot.changed > 0) || screenshot.kind === 'resized' || navigated) {
      attach = after.png && after.png.length <= MAX_PNG_ATTACH ? image(after.png, 'image/png') : await afterImage(call);
    }
  }

  const update = describeUpdate({
    documentChanged,
    urlChanged: Boolean(navigated),
    consoleTexts: consoleNew.map(e => e.text),
    requestUrls: networkNew.map(e => e.url),
    overlay: Boolean(overlay) && overlay?.text !== base.lastOverlay,
    newErrors: freshErrors.length,
    domChanged,
  });
  const report = formatChange({
    tabId: call.tab.id,
    update,
    elapsedMs: Date.now() - started,
    errors: errorLines,
    moreErrors: Math.max(0, freshErrors.length - MAX_LISTED),
    failures: failureLines,
    moreFailures: Math.max(0, freshFailures.length - MAX_LISTED),
    still: { errors: errorSplit.still.length, failures: stillFailures },
    earlier: { errors: earlierErrors, failures: earlierFailures },
    warnings: consoleNew.filter(e => e.level === 'warning').length,
    navigated,
    overlay: overlay && overlay.text !== base.overlay?.text ? overlay : undefined,
    // A different overlay is listed as new; the baseline's one is then replaced, not gone.
    overlayBefore: !base.overlay ? undefined : !overlay ? 'gone' : overlay.text === base.overlay.text ? 'still' : undefined,
    crashed,
    screenshot,
    scrolled,
    imageAttached: Boolean(attach),
    unsettled: blocker && !crashed ? { blocker, ms: Date.now() - signalAt } : undefined,
    devServerLost: devServerLost(state, sinceSeq),
  });

  // The next check waits for an update after this one.
  const w = crashed ? undefined : await readWatch(call);
  base.checked = { seq: state.seq, at: Date.now() };
  base.lastOverlay = overlay?.text ?? '';
  base.watch = { loaderId: state.loaderId, count: w?.count ?? 0 };
  return attach ? [text(report), attach] : report;
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

