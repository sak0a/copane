// The change check's judgement over plain facts: which console lines and requests mean a dev server
// pushed an update (Vite, webpack, Next.js), which DOM changes the page makes on its own, when the page
// has settled after an update, how to name the update, and which errors and failed requests after a
// reload are the same as before it. Pure.
import { WITHHELD_MESSAGE } from './privacy';

// ---------------------------------------------------------------- dev server console lines
//
// Verified against the clients' sources and real dev servers: Vite 8 ("[vite] hot updated: /src/a.js
// via /src/main.js", also for CSS), webpack 5 with webpack-dev-server 5.2 ("[webpack-dev-server] App
// updated. Recompiling...", "[HMR] Updated modules:") and 6.1 (whose client is webpack-dev-middleware's:
// "[webpack-dev-server] bundle rebuilding (<file> changed)", "Hot updated 1 modules.").

/** Console lines a dev server's client prints when an update starts, arrives or completes. */
export const HMR_CONSOLE = [
  /^\[vite\] (\(client\) )?(hot updated|css hot updated|page reload|invalidate)/,
  /^\[HMR\] (Updated modules|Nothing hot updated|Cannot apply update|Cannot find update|App is up to date|Update applied|Checking for updates)/,
  /^\[webpack-dev-server\] (App updated|App hot update|Nothing changed|Errors while compiling|Warnings while compiling|bundle rebuilding|bundle rebuilt|bundle has \d+ (errors|warnings)|Checking for updates|Hot updated \d+ modules|Nothing hot updated|App is up to date|Reloading page|"[^"]*" changed\. Reloading)/,
  /^\[Fast Refresh\] (done|rebuilding)/,
  /^\[hmr\]/i,
];
/** An update has started; a later HMR_CONSOLE line that is not one of these ends it. */
export const HMR_PENDING = [
  /^\[HMR\] Checking for updates/,
  /^\[Fast Refresh\] rebuilding/,
  /^\[webpack-dev-server\] (App updated\. Recompiling|bundle rebuilding|Checking for updates)/,
];
/** The update ended without changing anything. */
export const HMR_NOTHING = [/^\[webpack-dev-server\] Nothing changed\./, /^\[(HMR|webpack-dev-server)\] Nothing hot updated/];
/**
 * A started update with no later line for this long has ended without a word (webpack-dev-server 6
 * prints "bundle rebuilding" and nothing more when the rebuilt bundle is identical).
 */
export const HMR_SILENT_MS = 5000;
export const DEV_SERVER_LOST = /^\[vite\] server connection lost|^\[webpack-dev-server\] Disconnected/;

export function isHmrConsole(text: string): boolean {
  return HMR_CONSOLE.some(re => re.test(text));
}

export function isHmrPending(text: string): boolean {
  return HMR_PENDING.some(re => re.test(text));
}

/**
 * Where the dev server's update cycle stands after these lines: "pending" (started, not finished),
 * "nothing" (finished without a change: an identical rebuild), "silent" (started, then no word for
 * HMR_SILENT_MS), "done", or "none" (no update line at all).
 */
export function hmrState(lines: Array<{ text: string; time: number }>, now: number): 'none' | 'pending' | 'done' | 'nothing' | 'silent' {
  let any = false;
  let pending = false;
  let last = 0;
  // Per update cycle (from a start line on): did it end with a change, or with "nothing changed"?
  let cycleDone = false;
  let cycleNothing = false;
  let real = false;
  let nothing = false;
  const close = () => {
    if (cycleNothing) nothing = true;
    else if (cycleDone) real = true;
    cycleDone = cycleNothing = false;
  };
  for (const l of lines) {
    if (!isHmrConsole(l.text)) continue;
    any = true;
    last = l.time;
    if (isHmrPending(l.text)) {
      close();
      pending = true;
    } else {
      pending = false;
      if (HMR_NOTHING.some(re => re.test(l.text))) cycleNothing = true;
      else cycleDone = true;
    }
  }
  close();
  if (!any) return 'none';
  if (pending) return now - last >= HMR_SILENT_MS ? (real ? 'done' : 'silent') : 'pending';
  if (real) return 'done';
  return nothing ? 'nothing' : 'done';
}

// ---------------------------------------------------------------- update requests

/** Requests a dev server's client makes to load an update. */
export const HMR_NETWORK = [/\.hot-update\.(json|js)(\?|$)/, /[?&]t=\d{10,}(&|$)/, /[?&]import&t=\d+/];
/** webpack-hot-middleware's event stream: always open, never an update by itself. */
const LONG_LIVED_HMR = /\/__webpack_hmr(\?|$)/;

/**
 * A request that loads an update: from the page's own origin, and a module or stylesheet with a
 * cache-busting timestamp (Vite) or webpack's hot-update manifest or chunk. A timestamped API call or
 * image (`/api/status?t=1731750000000`) is not one.
 */
export function isHmrRequest(e: { url: string; type: string }, pageUrl: string): boolean {
  if (LONG_LIVED_HMR.test(e.url) || !sameOrigin(e.url, pageUrl)) return false;
  if (/\.hot-update\.(json|js)(\?|$)/.test(e.url)) return e.type === 'Fetch' || e.type === 'XHR' || e.type === 'Script';
  if (e.type !== 'Script' && e.type !== 'Stylesheet') return false;
  return /[?&]t=\d{10,}(&|$)/.test(e.url) || /[?&]import&t=\d+/.test(e.url);
}

function sameOrigin(url: string, pageUrl: string): boolean {
  try {
    return new URL(url).origin === new URL(pageUrl).origin;
  } catch {
    return false;
  }
}

/** A request's identity without its query: "http://x/api/status". */
export function requestKey(url: string): string {
  return url.replace(/[?#].*$/, '');
}

const BACKGROUND_TYPES = new Set(['EventSource', 'WebSocket', 'Ping', 'CSPViolationReport']);
const POLLABLE_TYPES = new Set(['Fetch', 'XHR', 'Other', 'Image', 'Ping']);

/**
 * Requests the page makes on its own (event streams, sockets, polling): URLs fetched at least twice
 * before the update, as fetch/xhr/image. Scripts, stylesheets and documents are never background.
 */
export function recurringRequests(before: Array<{ url: string; type: string }>): Set<string> {
  const seen = new Map<string, number>();
  for (const e of before) {
    if (!POLLABLE_TYPES.has(e.type)) continue;
    const k = requestKey(e.url);
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  return new Set([...seen].filter(([, n]) => n >= 2).map(([k]) => k));
}

/** A request that does not belong to the update: long-lived, or one of the page's recurring ones. */
export function isBackgroundRequest(e: { url: string; type: string }, recurring: Set<string>): boolean {
  return BACKGROUND_TYPES.has(e.type) || LONG_LIVED_HMR.test(e.url) || (POLLABLE_TYPES.has(e.type) && recurring.has(requestKey(e.url)));
}

// ---------------------------------------------------------------- DOM changes the page makes on its own
//
// The page-side watch (WATCH in change.ts) keeps one record per mutated node and embeds these three
// functions' source, so they must stay self-contained: no imports, literal constants only.

export interface NodeRecord {
  /** Page time of the node's first and last mutation since the watch began. */
  first: number;
  last: number;
  /** Separate bursts of mutations (more than 250 ms apart). */
  bursts: number;
  /** Shortest pause between two bursts. */
  minGap: number;
}

/** The record after another mutation of the node at `now`. */
export function recordMutation(r: NodeRecord | undefined, now: number): NodeRecord {
  if (!r) return { first: now, last: now, bursts: 1, minGap: Infinity };
  const gap = now - r.last;
  if (gap > 250) return { first: r.first, last: now, bursts: r.bursts + 1, minGap: Math.min(r.minGap, gap) };
  return { first: r.first, last: now, bursts: r.bursts, minGap: r.minGap };
}

/** The node changes on its own: bursts again within 6 s (a clock, a carousel, polling), or keeps changing for a second (an animation). */
export function isRecurring(r: NodeRecord): boolean {
  return (r.bursts >= 2 && r.minGap <= 6000) || (r.bursts === 1 && r.last - r.first >= 1000);
}

/**
 * Whether a node's change counts as an update: "recurring" never does; "changed" does; "pending" is
 * not known yet. A node first changed within 5.5 s of the watch's start might be a clock or a poll
 * (period up to 5 s) that simply had not ticked yet: it counts once it has not changed again for 5.5 s.
 */
export function nodeVerdict(r: NodeRecord, now: number, start: number): 'recurring' | 'changed' | 'pending' {
  if (isRecurring(r)) return 'recurring';
  if (r.bursts >= 2) return 'changed';
  if (r.first - start >= 5500) return 'changed';
  if (now - r.last >= 5500) return 'changed';
  return 'pending';
}

// ---------------------------------------------------------------- frames

/**
 * Frames whose document was replaced since `before` (frame id → loader id): their URLs. A frame that
 * appeared or went away is a DOM change of its parent, not a frame reload.
 */
export function reloadedFrames(before: Record<string, { loaderId: string; url: string }>, now: Record<string, { loaderId: string; url: string }>): string[] {
  return Object.entries(now)
    .filter(([id, f]) => before[id] && before[id].loaderId !== f.loaderId)
    .map(([, f]) => f.url);
}

// ---------------------------------------------------------------- naming the update

/** What the check saw between its start and the report, for naming the update. */
export interface UpdateFacts {
  /** The main document was replaced. */
  documentChanged: boolean;
  /** The URL differs from the baseline's. */
  urlChanged: boolean;
  /** Console texts since the check started waiting. */
  consoleTexts: string[];
  /** Update requests (isHmrRequest) since the check started waiting. */
  requestUrls: string[];
  overlay: boolean;
  newErrors: number;
  domChanged: boolean;
  /** URLs of frames that loaded a new document. */
  frames: string[];
}

/** "a hot update (Vite: /src/x.vue)", "a full reload (new document)", "a navigation", ... */
export function describeUpdate(f: UpdateFacts): string {
  if (f.documentChanged) {
    if (f.urlChanged) return 'a navigation (new document)';
    return 'a full reload (new document)';
  }
  const lines = f.consoleTexts.filter(isHmrConsole);
  if (lines.length) {
    const vite = unique(lines.flatMap(l => /^\[vite\] (?:\(client\) )?(?:css )?hot updated: (\S+)/.exec(l)?.[1] ?? []));
    if (vite.length) return `a hot update (Vite: ${list(vite)})`;
    const webpack = unique(f.consoleTexts.flatMap(l => /^\[HMR\]\s+-\s+(\S+)/.exec(l)?.[1] ?? /^\[webpack-dev-server\] bundle rebuilding \((.+) changed\)$/.exec(l)?.[1] ?? []).map(shortPath));
    if (webpack.length) return `a hot update (webpack: ${list(webpack)})`;
    if (lines.some(l => l.startsWith('[Fast Refresh]'))) return 'a hot update (Next.js Fast Refresh)';
    if (lines.some(l => /^\[(HMR|webpack-dev-server)\]/.test(l))) return 'a hot update (webpack)';
    if (lines.some(l => l.startsWith('[vite]'))) return 'a hot update (Vite)';
    return 'a hot update';
  }
  const modules = unique(f.requestUrls.map(modulePath));
  if (modules.length) return `a hot update (${list(modules)} reloaded)`;
  if (f.frames.length) return `a reload of the frame ${list(unique(f.frames))}`;
  if (f.overlay) return 'an error shown by the dev server';
  if (f.newErrors) return 'a new error (no hot-update message seen)';
  if (f.domChanged) return 'DOM changes (no hot-update message seen)';
  return 'a change';
}

/** The last three segments of a long absolute path: "/home/me/app/src/a.js" → "…/app/src/a.js". */
function shortPath(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts.length > 4 ? `…/${parts.slice(-3).join('/')}` : p;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function list(values: string[]): string {
  return values.length > 3 ? `${values.slice(0, 3).join(', ')} and ${values.length - 3} more` : values.join(', ');
}

/** "http://localhost:5173/src/app.js?t=1712" → "/src/app.js". */
export function modulePath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url.replace(/[?#].*$/, '');
  }
}

/** Removes the cache-busting query a dev server adds ("?t=1712345678901", "?import&t=…", "?v=ab12") from a "url:line:col". */
export function cleanLocation(location: string): string {
  return location.replace(/\?(?:import&)?(?:t|v)=[\w]+(?:&[^:#]*)?(?=[:#]|$)/, '').replace(/\?import(?=[:#]|$)/, '');
}

// ---------------------------------------------------------------- settling

/** What the settle loop observed at one moment. */
export interface SettleFacts {
  /** The main frame is loading. */
  loading: boolean;
  /** The document was replaced since the baseline (then `load` must have fired). */
  documentChanged: boolean;
  loaded: boolean;
  /** How long no request of the update has been in flight (the page's own polling is left out). */
  networkIdleMs: number;
  /** Time since the last DOM mutation that was not the page's own recurring change. */
  domQuietMs: number;
  /** An HMR update started and has not completed. */
  hmrPending: boolean;
}

export type SettleBlocker = 'loading' | 'network' | 'dom' | 'hmr';

/** What still keeps the page from counting as settled, or undefined when it has settled. */
export function settleBlocker(f: SettleFacts): SettleBlocker | undefined {
  if (f.loading || (f.documentChanged && !f.loaded)) return 'loading';
  if (f.hmrPending) return 'hmr';
  if (f.networkIdleMs < 500) return 'network';
  if (f.domQuietMs < 500) return 'dom';
  return undefined;
}

// ---------------------------------------------------------------- errors and failed requests

/**
 * Splits errors seen after a reload into new ones and ones the page already had before (same text,
 * each earlier one matched once). Without a new document every error is new.
 */
export function dedupeErrors<T extends { text: string }>(errors: T[], before: string[], documentChanged: boolean): { fresh: T[]; still: T[] } {
  return splitByKey(errors, before.map(errorKey), e => errorKey(e.text), documentChanged);
}

/** Like dedupeErrors, for failed requests by URL (without query). */
export function dedupeFailures<T extends { url: string }>(failures: T[], beforeUrls: string[], documentChanged: boolean): { fresh: T[]; still: T[] } {
  return splitByKey(failures, beforeUrls.map(requestKey), f => requestKey(f.url), documentChanged);
}

function splitByKey<T>(items: T[], before: string[], key: (item: T) => string, documentChanged: boolean): { fresh: T[]; still: T[] } {
  if (!documentChanged || before.length === 0) return { fresh: items, still: [] };
  const left = new Map<string, number>();
  for (const k of before) left.set(k, (left.get(k) ?? 0) + 1);
  const fresh: T[] = [];
  const still: T[] = [];
  for (const item of items) {
    const k = key(item);
    const n = left.get(k) ?? 0;
    if (n > 0) {
      left.set(k, n - 1);
      still.push(item);
    } else fresh.push(item);
  }
  return { fresh, still };
}

interface ConsoleLike {
  source: string;
  level: string;
  text: string;
  location: string | undefined;
}

/** The browser's own "Failed to load resource" console line, which names the request in its location. */
export function isFailedResourceLine(e: ConsoleLike): boolean {
  return e.source === 'browser' && /^Failed to load resource\b/.test(e.text) && Boolean(e.location);
}

/** The URL a "Failed to load resource" line is about. */
export function failedResourceUrl(e: ConsoleLike): string {
  return (e.location ?? '').replace(/(:\d+)+$/, '');
}

/**
 * The error entries, without the browser's "Failed to load resource" lines for requests that are listed
 * as failed anyway. Lines logged while the user had the tab are withheld (no text, no location): as
 * many of them as there are withheld failed requests are taken to be those requests' lines.
 */
export function errorsWithoutFailedRequests<T extends ConsoleLike>(entries: T[], failures: Array<{ url: string; withheld?: boolean }>): T[] {
  const urls = new Set(failures.map(f => requestKey(f.url)));
  let withheldPairs = failures.filter(f => f.withheld).length;
  return entries.filter(e => {
    if (e.level !== 'error') return false;
    if (isFailedResourceLine(e) && urls.has(requestKey(failedResourceUrl(e)))) return false;
    if (e.source === 'browser' && e.text === WITHHELD_MESSAGE && withheldPairs > 0) {
      withheldPairs--;
      return false;
    }
    return true;
  });
}

/** An error's identity across reloads: its first line, without cache-busting queries. */
export function errorKey(text: string): string {
  return text.split('\n')[0]!.replace(/\?(?:import&)?(?:t|v)=\w+/g, '').trim();
}

/** Error texts the page logged more than once before (a failing poll): not a sign of an update when they come again. */
export function recurringErrors(entries: Array<{ text: string; count: number }>): Set<string> {
  const seen = new Map<string, number>();
  for (const e of entries) seen.set(errorKey(e.text), (seen.get(errorKey(e.text)) ?? 0) + e.count);
  return new Set([...seen].filter(([, n]) => n >= 2).map(([k]) => k));
}

// ---------------------------------------------------------------- screenshots taken by a hook

/**
 * The geometry of a viewport screenshot taken by the device-emulation hook (emulation.ts), read from
 * the sentences it writes next to the image: image px per CSS px, and the part of the image that is
 * the emulated viewport (a tab in the background is drawn larger than the device). Undefined when the
 * text does not say.
 */
export function hookGeometry(text: string): { scale: number; viewport?: { width: number; height: number } } | undefined {
  let scale: number | undefined;
  if (/Image pixels are viewport CSS pixels/.test(text)) scale = 1;
  const divide = /divide its image coordinates by (\d+(?:\.\d+)?)/.exec(text);
  if (divide && Number(divide[1]) > 0) scale = Number(divide[1]);
  if (scale === undefined) return undefined;
  const part = /emulated viewport is the top-left (\d+)×(\d+) px of the image/.exec(text);
  return { scale, viewport: part ? { width: Number(part[1]), height: Number(part[2]) } : undefined };
}
