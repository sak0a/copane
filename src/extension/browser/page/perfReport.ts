// browser_audit type "performance": the numbers, summarised for an agent. Pure (fed with what perf.ts
// read from the page and the tab's network log), unit-tested.
import type { NetworkEntry } from './networkLog';
import { clip, formatBytes, formatMs } from './ringBuffer';

export interface PageTimings {
  /** Navigation timing, ms from navigation start. */
  nav?: { ttfb: number; domContentLoaded: number; load: number; type: string; protocol: string; redirects: number; transferSize: number; serverTiming: string[] };
  fcp?: number;
  lcp?: { time: number; element?: string; url?: string; ref?: string };
  /** CLS as Core Web Vitals defines it: the largest session window of unexpected shifts. */
  cls?: { value: number; shifts: number; largest?: { value: number; time: number; source?: string } };
  /** Event Timing keeps only interactions of 104 ms or more for late observers like this one. */
  interactions: { slowest?: { event: string; target?: string; duration: number; inputDelay: number; processing: number; presentation: number; time: number }; slow: number; firstInput?: { event: string; delay: number }; hadInput?: boolean };
  /** undefined: the browser did not report long tasks. */
  longTasks?: { count: number; total: number; longest: number; longestAt: number; blocking: number };
  /** Scripts that ran in long animation frames, longest first. */
  scripts: Array<{ source: string; invoker: string; duration: number }>;
  renderBlocking: Array<{ url: string; duration: number }>;
  /** From resource timing, for when the network log missed the start of the load. */
  resources: { count: number; transferred: number };
}

export interface NetworkSummary {
  /** The log has the document request of this load, so it saw the load from the start. */
  complete: boolean;
  requests: number;
  transferred: number;
  failed: number;
  pending: number;
  fromCache: number;
  byType: Array<{ type: string; count: number; bytes: number }>;
  slowest: Array<{ id: string; label: string; ms: number }>;
  largest: Array<{ id: string; label: string; bytes: number }>;
  uncompressed: Array<{ id: string; label: string; bytes: number }>;
}

const LONG_LIVED = new Set(['EventSource', 'WebSocket']);
const TEXTUAL = /^(text\/|application\/(javascript|json|xml|.*\+json|.*\+xml)|image\/svg)/;

/** A request in a line: method only when not GET, URL without query, shortened. */
function requestLabel(e: NetworkEntry, pageUrl: string): string {
  let shown = e.url;
  try {
    const u = new URL(e.url);
    const page = new URL(pageUrl);
    shown = (u.origin === page.origin ? '' : u.host) + u.pathname + (u.search.length > 1 && u.search.length <= 30 ? u.search : u.search ? '?…' : '');
  } catch {
    // keep as is
  }
  return `${e.method === 'GET' ? '' : `${e.method} `}${clip(shown, 90)}`;
}

/** The requests of the current page load (the document and everything since), summarised. */
export function summarizeNetwork(entries: NetworkEntry[], loaderId: string | undefined, pageUrl: string): NetworkSummary {
  const doc = loaderId ? entries.find(e => e.requestId === loaderId) : undefined;
  // Everything since the document request (subresources, fetches, frames); without it, what belongs to this document.
  const mine = entries.filter(e => !e.redirectedTo && (doc ? e.seq >= doc.seq : e.loaderId === loaderId));
  const done = mine.filter(e => e.end !== undefined && !LONG_LIVED.has(e.type));
  const byType = new Map<string, { count: number; bytes: number }>();
  for (const e of mine) {
    const t = byType.get(e.type) ?? { count: 0, bytes: 0 };
    t.count++;
    t.bytes += e.size ?? 0;
    byType.set(e.type, t);
  }
  const header = (e: NetworkEntry, name: string) => Object.entries(e.responseHeaders ?? {}).find(([k]) => k.toLowerCase() === name)?.[1];
  return {
    complete: !!doc,
    requests: mine.length,
    transferred: mine.reduce((n, e) => n + (e.size ?? 0), 0),
    failed: mine.filter(e => e.failed !== undefined || (e.status ?? 0) >= 400).length,
    pending: mine.filter(e => e.end === undefined && e.failed === undefined && !LONG_LIVED.has(e.type)).length,
    fromCache: mine.filter(e => e.fromCache).length,
    byType: [...byType.entries()].map(([type, v]) => ({ type: type.toLowerCase(), ...v })).sort((a, b) => b.bytes - a.bytes || b.count - a.count),
    slowest: [...done]
      .sort((a, b) => b.end! - b.start - (a.end! - a.start))
      .slice(0, 5)
      .map(e => ({ id: e.id, label: requestLabel(e, pageUrl), ms: Math.round((e.end! - e.start) * 1000) })),
    largest: mine
      .filter(e => (e.size ?? 0) > 0)
      .sort((a, b) => (b.size ?? 0) - (a.size ?? 0))
      .slice(0, 5)
      .map(e => ({ id: e.id, label: requestLabel(e, pageUrl), bytes: e.size! })),
    uncompressed: mine
      .filter(e => (e.size ?? 0) > 20_000 && TEXTUAL.test(e.mimeType ?? '') && !header(e, 'content-encoding') && !e.fromCache)
      .sort((a, b) => (b.size ?? 0) - (a.size ?? 0))
      .slice(0, 3)
      .map(e => ({ id: e.id, label: requestLabel(e, pageUrl), bytes: e.size! })),
  };
}

/** Largest session window of layout shifts (gap < 1 s, window < 5 s), as CLS is defined. */
export function clsOf(shifts: Array<{ value: number; time: number; recentInput: boolean }>): number {
  let max = 0;
  let current = 0;
  let first = -Infinity;
  let last = -Infinity;
  for (const s of shifts) {
    if (s.recentInput) continue;
    if (s.time - last > 1000 || s.time - first > 5000) {
      current = 0;
      first = s.time;
    }
    current += s.value;
    last = s.time;
    max = Math.max(max, current);
  }
  return max;
}

const ms = (n: number) => formatMs(Math.max(0, n));

/** A URL of the page's own origin as its path. */
function short(url: string, pageUrl: string): string {
  try {
    const u = new URL(url);
    return u.origin === new URL(pageUrl).origin ? u.pathname + u.search : url;
  } catch {
    return url;
  }
}

export interface PerfInput {
  tabId: string;
  url: string;
  browser: string;
  /** How long ago the page loaded, ms (to say how old the measurement is). */
  loadedAgo?: number;
  reloaded: boolean;
  /** The tab is not in front: the browser paints it rarely, so times that end at a paint are inflated. */
  background: boolean;
  timings: PageTimings;
  network: NetworkSummary;
  /** Lines about conditions the numbers were measured under (throttling); none: unthrottled. */
  conditions?: string[];
  /** The session was given the full caveat before: use the short one. */
  brief?: boolean;
}

export function formatPerf(p: PerfInput): string {
  const t = p.timings;
  const n = p.network;
  const lines: string[] = [];
  const when = p.reloaded ? 'just reloaded, bypassing the cache' : p.loadedAgo !== undefined ? `loaded ${ms(p.loadedAgo)} ago` : 'loaded earlier';
  lines.push(`Performance of ${p.tabId}: ${clip(p.url, 200)} (${when}${t.nav ? `, ${t.nav.protocol || 'unknown protocol'}${t.nav.redirects ? `, ${t.nav.redirects} redirect${t.nav.redirects > 1 ? 's' : ''}` : ''}` : ''}).`);
  if (t.nav) {
    const lcp = t.lcp ? `, LCP ${ms(t.lcp.time)}${t.lcp.element ? ` (${t.lcp.element}${t.lcp.ref ? ` [ref=${t.lcp.ref}]` : ''}${t.lcp.url ? ` ${clip(t.lcp.url, 80)}` : ''})` : ''}` : ', LCP not reported';
    lines.push(`Load: TTFB ${ms(t.nav.ttfb)}, FCP ${t.fcp !== undefined ? ms(t.fcp) : 'not reported'}, DOMContentLoaded ${ms(t.nav.domContentLoaded)}, load ${t.nav.load > 0 ? ms(t.nav.load) : 'not yet'}${lcp}.`);
    if (t.nav.serverTiming.length) lines.push(`Server timing: ${t.nav.serverTiming.slice(0, 5).join(', ')}.`);
  } else lines.push('Load: no navigation timing (the page has not finished loading, or it is not a web page).');
  if (t.cls) {
    const largest = t.cls.largest && t.cls.largest.value >= 0.01 ? `; largest shift ${t.cls.largest.value.toFixed(3)} at ${ms(t.cls.largest.time)}${t.cls.largest.source ? ` moving ${t.cls.largest.source}` : ''}` : '';
    lines.push(`Layout shift (CLS): ${t.cls.value.toFixed(3)} from ${t.cls.shifts} shift${t.cls.shifts === 1 ? '' : 's'}${largest}.`);
  }
  const i = t.interactions;
  if (i.slowest) {
    const s = i.slowest;
    if (p.background) {
      // Presentation waits for the next paint, which a background tab gets about once a second.
      lines.push(`Interactions: slowest ${s.event}${s.target ? ` on ${s.target}` : ''}: input delay ${ms(s.inputDelay)}, handlers ${ms(s.processing)}; the time until it was painted (${ms(s.presentation)}) is not meaningful while the tab is in the background, so INP cannot be read here.`);
    } else {
      lines.push(`Interactions: slowest ${s.event}${s.target ? ` on ${s.target}` : ''} took ${ms(s.duration)} (input delay ${ms(s.inputDelay)}, handlers ${ms(s.processing)}, until painted ${ms(s.presentation)}); ${i.slow} interaction${i.slow === 1 ? '' : 's'} took 104 ms or more. INP is at least ${ms(s.duration)}.`);
    }
  } else if (p.background && i.hadInput && !i.firstInput) {
    lines.push('Interactions: not reported yet. The browser reports them once it paints the tab, which it rarely does while the tab is in the background; bring it to the front (browser_show_tab) and check again. Long tasks below include slow event handlers.');
  } else {
    lines.push(`Interactions: none took 104 ms or more${i.firstInput ? ` (first input: ${i.firstInput.event}, delay ${ms(i.firstInput.delay)})` : ' (none happened yet)'}. The browser keeps only slower ones, so INP is below ~100 ms for what was done here.`);
  }
  if (t.longTasks) {
    const lt = t.longTasks;
    lines.push(lt.count ? `Main thread: ${lt.count} long task${lt.count === 1 ? '' : 's'} (over 50 ms), ${ms(lt.total)} in total, longest ${ms(lt.longest)} at ${ms(lt.longestAt)}; blocking time ${ms(lt.blocking)}.` : 'Main thread: no long tasks (over 50 ms).');
  } else lines.push('Main thread: long tasks are not reported by this browser.');
  if (t.scripts.length) lines.push(`Slow scripts (in long frames): ${t.scripts.slice(0, 4).map(s => `${clip(s.source || 'inline', 70)}${s.invoker ? ` (${clip(s.invoker, 50)})` : ''} ${ms(s.duration)}`).join('; ')}.`);
  if (n.requests || t.resources.count) {
    if (n.complete) {
      const types = n.byType.slice(0, 5).map(b => `${b.type} ${b.count} · ${formatBytes(b.bytes)}`).join(', ');
      lines.push(`Network: ${n.requests} requests, ${formatBytes(n.transferred)} transferred${n.fromCache ? ` (${n.fromCache} from cache)` : ''}${n.failed ? `, ${n.failed} failed` : ''}${n.pending ? `, ${n.pending} still pending` : ''}; ${types}.`);
    } else {
      lines.push(`Network: ${t.resources.count + 1} requests, ${formatBytes(t.resources.transferred + (t.nav?.transferSize ?? 0))} transferred (from resource timing: the bridge started watching this tab after the load began, so per-request details below are partial; reload: true measures a fresh load).`);
    }
    if (n.slowest.length) lines.push(`Slowest: ${n.slowest.map(r => `${r.id} ${r.label} ${ms(r.ms)}`).join(' · ')}.`);
    if (n.largest.length) lines.push(`Largest: ${n.largest.map(r => `${r.id} ${r.label} ${formatBytes(r.bytes)}`).join(' · ')}.`);
    if (n.uncompressed.length) lines.push(`Not compressed: ${n.uncompressed.map(r => `${r.id} ${r.label} ${formatBytes(r.bytes)}`).join(' · ')} (no Content-Encoding).`);
  }
  if (t.renderBlocking.length) lines.push(`Render-blocking: ${t.renderBlocking.slice(0, 5).map(r => `${clip(short(r.url, p.url), 70)} ${ms(r.duration)}`).join(' · ')}${t.renderBlocking.length > 5 ? `, +${t.renderBlocking.length - 5} more` : ''}.`);
  const throttled = !!p.conditions?.length;
  lines.push(...(p.conditions ?? []));
  const conditions = throttled ? 'with the throttling above' : 'without CPU or network throttling';
  lines.push(
    p.brief
      ? `Measured in ${p.browser} on this machine, ${conditions}: compare before and after a change; not comparable with Lighthouse or field data. Request details: browser_network_requests with id.`
      : `Measured in VS Code's embedded browser (${p.browser}) on this machine, ${conditions}: good for comparing before and after a change and for finding the biggest costs; not comparable with Lighthouse scores or field Core Web Vitals, which use slower devices and networks. Details of a request: browser_network_requests with id.`,
  );
  return lines.join('\n');
}
