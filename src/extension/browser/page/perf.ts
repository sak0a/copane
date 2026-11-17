// browser_audit type "performance": reads the page's own performance timeline (navigation and paint
// timing, and buffered PerformanceObserver entries for LCP, layout shifts, long tasks, long animation
// frames and slow interactions) in the bridge's isolated world, and the tab's network log. Slow
// interactions are reported by the browser only once their result is painted; a background tab is
// painted rarely, so they may be missing there (the result says so). With
// `reload` it first reloads the page bypassing the cache and measures that load.
import { ToolError } from '../../core/errors';
import type { PageCall } from './call';
import { markAction } from './effects';
import { DialogInterrupt } from './pageState';
import { clsOf, formatPerf, summarizeNetwork, type PageTimings } from './perfReport';

/** Isolated world, main frame. Everything the page's performance timeline holds, as [summary, LCP element]. */
const READ_TIMELINE = `async function (background) {
  const describe = (el) => {
    if (!el || el.nodeType !== 1) return undefined;
    const id = el.id ? '#' + el.id : '';
    const cls = !id && typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '';
    const text = (el.innerText || el.getAttribute('alt') || '').replace(/\\s+/g, ' ').trim();
    return '<' + el.localName + id + cls + '>' + (text ? ' "' + text.slice(0, 40) + (text.length > 40 ? '…' : '') + '"' : '');
  };
  // An interaction is reported once its result is painted (the caller forces a paint in a background
  // tab): if the page had input, give entries still on their way a moment to arrive.
  const counts = performance.eventCounts;
  const hadInput = counts && ['pointerdown', 'keydown', 'click'].some(t => (counts.get(t) || 0) > 0);
  if (background && hadInput) {
    await new Promise(resolve => {
      let quiet;
      const o = new PerformanceObserver(() => { clearTimeout(quiet); quiet = setTimeout(done, 100); });
      const done = () => { try { o.disconnect(); } catch {} resolve(); };
      try { o.observe({ type: 'event', durationThreshold: 16 }); } catch { return resolve(); }
      setTimeout(done, 400);
    });
  }
  const observe = (type, extra) => new Promise(resolve => {
    if (!PerformanceObserver.supportedEntryTypes || !PerformanceObserver.supportedEntryTypes.includes(type)) return resolve(null);
    let done = false;
    let o;
    const finish = (entries) => { if (done) return; done = true; try { o.disconnect(); } catch {} resolve(entries); };
    try {
      o = new PerformanceObserver(list => finish(list.getEntries()));
      o.observe(Object.assign({ type, buffered: true }, extra || {}));
    } catch { return resolve(null); }
    setTimeout(() => finish([]), 200);
  });
  const [lcp, shifts, longtasks, frames, events, firstInput] = await Promise.all([
    observe('largest-contentful-paint'), observe('layout-shift'), observe('longtask'), observe('long-animation-frame'), observe('event', { durationThreshold: 16 }), observe('first-input'),
  ]);
  const out = {};
  let lcpElement = null;
  const nav = performance.getEntriesByType('navigation')[0];
  if (nav) out.nav = {
    ttfb: nav.responseStart, domContentLoaded: nav.domContentLoadedEventEnd, load: nav.loadEventEnd, type: nav.type, protocol: nav.nextHopProtocol,
    redirects: nav.redirectCount, transferSize: nav.transferSize || 0,
    serverTiming: (nav.serverTiming || []).map(s => s.name + (s.duration ? ' ' + Math.round(s.duration) + ' ms' : '') + (s.description ? ' (' + s.description + ')' : '')),
  };
  const fcp = performance.getEntriesByType('paint').find(e => e.name === 'first-contentful-paint');
  if (fcp) out.fcp = fcp.startTime;
  if (lcp && lcp.length) {
    const last = lcp[lcp.length - 1];
    lcpElement = last.element || null;
    out.lcp = { time: last.renderTime || last.loadTime || last.startTime, element: describe(last.element), url: last.url || undefined };
  }
  if (shifts) {
    let largest;
    for (const s of shifts) if (!s.hadRecentInput && (!largest || s.value > largest.value)) largest = s;
    out.shifts = shifts.map(s => ({ value: s.value, time: s.startTime, recentInput: s.hadRecentInput }));
    if (largest) out.largestShift = { value: largest.value, time: largest.startTime, source: describe((largest.sources || []).map(x => x.node).find(Boolean)) };
  }
  if (longtasks) {
    const total = longtasks.reduce((n, t) => n + t.duration, 0);
    const longest = longtasks.reduce((m, t) => (t.duration > (m ? m.duration : 0) ? t : m), null);
    out.longTasks = { count: longtasks.length, total, longest: longest ? longest.duration : 0, longestAt: longest ? longest.startTime : 0, blocking: longtasks.reduce((n, t) => n + Math.max(0, t.duration - 50), 0) };
  }
  const scripts = new Map();
  for (const f of frames || []) for (const s of f.scripts || []) {
    const invoker = s.invoker && s.invoker !== s.sourceURL ? s.invoker : '';
    const key = (s.sourceURL || '') + '|' + invoker;
    const known = scripts.get(key) || { source: s.sourceURL || '', invoker, duration: 0 };
    known.duration += s.duration;
    scripts.set(key, known);
  }
  out.scripts = [...scripts.values()].sort((a, b) => b.duration - a.duration).slice(0, 5);
  // One interaction (a click) is several events (pointerdown, mouseup, click...) sharing an interactionId.
  const slow = new Map();
  for (const e of events || []) {
    if (!e.interactionId || e.duration < 104) continue;
    const i = slow.get(e.interactionId) || { event: e.name, target: e.target, start: e.startTime, end: 0, firstStart: e.processingStart, processingEnd: 0, processing: 0, top: -1 };
    const p = e.processingEnd - e.processingStart;
    i.processing += p;
    if (p > i.top) { i.top = p; i.event = e.name; i.target = e.target || i.target; }
    i.start = Math.min(i.start, e.startTime);
    i.firstStart = Math.min(i.firstStart, e.processingStart);
    i.end = Math.max(i.end, e.startTime + e.duration);
    i.processingEnd = Math.max(i.processingEnd, e.processingEnd);
    slow.set(e.interactionId, i);
  }
  // In a background tab every interaction waits about a second for its paint: rank by the time spent before it instead.
  const cost = (i) => (background ? i.processingEnd - i.start : i.end - i.start);
  const worst = [...slow.values()].sort((a, b) => cost(b) - cost(a))[0];
  out.interactions = { slow: slow.size, hadInput: !!hadInput };
  if (worst) out.interactions.slowest = { event: worst.event, target: describe(worst.target), duration: worst.end - worst.start, inputDelay: worst.firstStart - worst.start, processing: worst.processing, presentation: worst.end - worst.processingEnd, time: worst.start };
  if (firstInput && firstInput.length) out.interactions.firstInput = { event: firstInput[0].name, delay: firstInput[0].processingStart - firstInput[0].startTime };
  const resources = performance.getEntriesByType('resource');
  out.resources = { count: resources.length, transferred: resources.reduce((n, r) => n + (r.transferSize || 0), 0) };
  out.renderBlocking = resources.filter(r => r.renderBlockingStatus === 'blocking').map(r => ({ url: r.name, duration: r.duration })).sort((a, b) => b.duration - a.duration);
  out.timeOrigin = performance.timeOrigin;
  out.chrome = (/Chrome\\/(\\d+)/.exec(navigator.userAgent) || [])[1] || '';
  return [out, lcpElement];
}`;

interface Timeline {
  nav?: PageTimings['nav'];
  fcp?: number;
  lcp?: PageTimings['lcp'];
  shifts?: Array<{ value: number; time: number; recentInput: boolean }>;
  largestShift?: { value: number; time: number; source?: string };
  longTasks?: PageTimings['longTasks'];
  scripts: PageTimings['scripts'];
  interactions: PageTimings['interactions'];
  resources: PageTimings['resources'];
  renderBlocking: PageTimings['renderBlocking'];
  timeOrigin: number;
  chrome: string;
}

/** Reloads bypassing the cache and waits for the load to finish and the network to settle (bounded). */
async function reload(call: PageCall): Promise<void> {
  const { state } = call;
  const mark = markAction(call);
  await call.send('Page.reload', { ignoreCache: true });
  const loaded = await state.waitFor(() => state.loaderId !== mark.loaderId && state.lifecycleOf().has('load'), { timeoutMs: 30_000, signal: call.signal, pollMs: 100 });
  if (!loaded.ok) {
    if (loaded.reason === 'dialog') throw new ToolError('failed', `The reload of ${call.tab.id} stopped at a dialog; answer it with browser_handle_dialog, then check again.`);
    throw new ToolError('timeout', `${call.tab.id} did not finish loading within 30 s after the reload. Check again without reload once it has, or look at browser_network_requests for what hangs.`);
  }
  // Late requests, the LCP candidate and layout shifts settle after load: wait until the requests made
  // since the reload have been done for 500 ms (requests of the replaced page may never report an end).
  let quietSince = Date.now();
  await state.waitFor(
    () => {
      const busy = state.network.entries.after(mark.seq).some(e => e.end === undefined && e.failed === undefined && e.type !== 'EventSource' && e.type !== 'WebSocket');
      if (busy) quietSince = Date.now();
      return !busy && Date.now() - quietSince >= 500;
    },
    { timeoutMs: 5000, signal: call.signal, pollMs: 100 },
  );
  await call.sleep(300);
}

/** Runs READ_TIMELINE in the bridge's isolated world (the page neither sees nor can disturb it). */
async function readTimeline(call: PageCall, background: boolean): Promise<{ t: Timeline; lcp?: string }> {
  const remote = await call.evaluateHandle(READ_TIMELINE, [background], { timeoutMs: 10_000 });
  if (!remote?.objectId) throw new ToolError('failed', `Could not read the performance timeline of ${call.tab.id}.`);
  const t = await call.callOn<Timeline>(remote.objectId, 'function () { return this[0]; }');
  const el = await call.callOn<{ objectId?: string }>(remote.objectId, 'function () { return this[1]; }', [], { returnByValue: false });
  return { t, lcp: el?.objectId };
}

async function lcpRef(call: PageCall, objectId: string): Promise<string | undefined> {
  try {
    const { node } = await call.send('DOM.describeNode', { objectId });
    const ax = await call.describeAx(node.backendNodeId);
    if (!ax || ax.ignored) return undefined;
    return call.refs.assign({ backendNodeId: node.backendNodeId, frameId: call.state.mainFrameId ?? '', role: ax.role, name: ax.name }, call.state.loaderId);
  } catch (err) {
    if (err instanceof DialogInterrupt || (err instanceof ToolError && err.code === 'cancelled')) throw err;
    return undefined;
  }
}

export async function performanceAudit(call: PageCall, options: { reload: boolean }): Promise<string> {
  if (options.reload) await reload(call);
  // A background tab is painted about once a second or less, and interactions are reported only once
  // their result is painted: a 1-pixel capture makes the browser paint now. (Not after a reload: there
  // were no interactions since, and a capture right after one can wait for a frame that does not come.)
  if (!call.tab.active && !options.reload) {
    await call.send('Page.captureScreenshot', { format: 'jpeg', quality: 10, clip: { x: 0, y: 0, width: 1, height: 1, scale: 1 }, fromSurface: true }, { timeoutMs: 1000 }).catch(err => {
      if (err instanceof DialogInterrupt || (err instanceof ToolError && err.code === 'cancelled')) throw err;
    });
  }
  const { t, lcp } = await readTimeline(call, !call.tab.active);
  const timings: PageTimings = {
    nav: t.nav,
    fcp: t.fcp,
    lcp: t.lcp,
    cls: t.shifts ? { value: clsOf(t.shifts), shifts: t.shifts.filter(s => !s.recentInput).length, largest: t.largestShift } : undefined,
    interactions: t.interactions,
    longTasks: t.longTasks,
    scripts: t.scripts,
    renderBlocking: t.renderBlocking,
    resources: t.resources,
  };
  if (timings.lcp && lcp) timings.lcp.ref = await lcpRef(call, lcp);
  const network = summarizeNetwork(call.state.network.entries.all(), call.state.loaderId, call.state.url);
  const loadedAgo = t.nav ? Date.now() - (t.timeOrigin + t.nav.load) : undefined;
  const conditions = (call.env.hooks ?? []).map(h => h.measurementNote?.(call, t.timeOrigin)).filter((n): n is string => !!n);
  return formatPerf({
    conditions, tabId: call.tab.id, url: call.state.url, browser: t.chrome ? `Chromium ${t.chrome}` : 'Chromium', loadedAgo: loadedAgo !== undefined && loadedAgo >= 0 ? loadedAgo : undefined, reloaded: options.reload, background: !call.tab.active, timings, network, brief: !call.env.notices.first(call.ctx.session.id, 'perf-caveat') });
}
