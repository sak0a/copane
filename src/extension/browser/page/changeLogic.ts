// The change check's judgement over plain facts: which console lines and requests mean a dev server
// pushed an update (Vite, webpack, Next.js), when the page has settled after it, how to name the
// update, and which errors after a reload are the same as before it. Pure.

/** Console lines a dev server's client prints when an update arrives or completes. */
export const HMR_CONSOLE = [
  /^\[vite\] (\(client\) )?(hot updated|css hot updated|page reload|invalidate)/,
  /^\[HMR\] (Updated modules|Nothing hot updated|Cannot apply update|App is up to date)/,
  /^\[webpack-dev-server\] (App updated|App hot update|Errors while compiling|Warnings while compiling)/,
  /^\[Fast Refresh\] (done|rebuilding)/,
  /^\[hmr\]/i,
];
/** An update has started; a later completion line (any other HMR_CONSOLE line) ends it. */
export const HMR_PENDING = [/^\[HMR\] Checking for updates/, /^\[Fast Refresh\] rebuilding/, /^\[webpack-dev-server\] App updated\. Recompiling/];
/** Requests a dev server's client makes to load an update. */
export const HMR_NETWORK = [/\.hot-update\.(json|js)(\?|$)/, /[?&]t=\d{10,}(&|$)/, /[?&]import&t=\d+/];
/** webpack-hot-middleware's event stream: always open, never an update by itself. */
const LONG_LIVED_HMR = /\/__webpack_hmr(\?|$)/;
export const DEV_SERVER_LOST = /^\[vite\] server connection lost|^\[webpack-dev-server\] Disconnected/;

export function isHmrConsole(text: string): boolean {
  return HMR_CONSOLE.some(re => re.test(text));
}

export function isHmrPending(text: string): boolean {
  return HMR_PENDING.some(re => re.test(text));
}

export function isHmrRequest(url: string): boolean {
  if (LONG_LIVED_HMR.test(url)) return false;
  return HMR_NETWORK.some(re => re.test(url));
}

/** True while the last update-start line has no completion line after it. */
export function hmrPending(texts: string[]): boolean {
  let pending = false;
  for (const t of texts) {
    if (isHmrPending(t)) pending = true;
    else if (isHmrConsole(t)) pending = false;
  }
  return pending;
}

/** What the check saw between its start and the report, for naming the update. */
export interface UpdateFacts {
  /** The main document was replaced. */
  documentChanged: boolean;
  /** The URL differs from the baseline's. */
  urlChanged: boolean;
  /** Console texts since the check started waiting. */
  consoleTexts: string[];
  /** Request URLs since the check started waiting. */
  requestUrls: string[];
  overlay: boolean;
  newErrors: number;
  domChanged: boolean;
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
    const webpack = unique(f.consoleTexts.flatMap(l => /^\[HMR\]\s+-\s+(\S+)/.exec(l)?.[1] ?? []));
    if (webpack.length) return `a hot update (webpack: ${list(webpack)})`;
    if (lines.some(l => l.startsWith('[Fast Refresh]'))) return 'a hot update (Next.js Fast Refresh)';
    if (lines.some(l => /^\[(HMR|webpack-dev-server)\]/.test(l))) return 'a hot update (webpack)';
    if (lines.some(l => l.startsWith('[vite]'))) return 'a hot update (Vite)';
    return 'a hot update';
  }
  const modules = unique(f.requestUrls.filter(isHmrRequest).map(modulePath));
  if (modules.length) return `a hot update (${list(modules)} reloaded)`;
  if (f.overlay) return 'a build error shown by the dev server';
  if (f.newErrors) return 'a new error (no hot-update message seen)';
  if (f.domChanged) return 'DOM changes (no hot-update message seen)';
  return 'a change';
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

/** What the settle loop observed at one moment. */
export interface SettleFacts {
  /** The main frame is loading. */
  loading: boolean;
  /** The document was replaced since the baseline (then `load` must have fired). */
  documentChanged: boolean;
  loaded: boolean;
  /** How long no request has been in flight. */
  networkIdleMs: number;
  /** Time since the last DOM mutation (Infinity when there was none). */
  domQuietMs: number;
  /** The page changed on its own at baseline (animation, polling): DOM quiet is not waited for. */
  churn: boolean;
  /** Time since the update signal. */
  sinceSignalMs: number;
  /** An HMR update started and has not completed. */
  hmrPending: boolean;
}

export type SettleBlocker = 'loading' | 'network' | 'dom' | 'hmr';

/** What still keeps the page from counting as settled, or undefined when it has settled. */
export function settleBlocker(f: SettleFacts): SettleBlocker | undefined {
  if (f.loading || (f.documentChanged && !f.loaded)) return 'loading';
  if (f.hmrPending) return 'hmr';
  if (f.networkIdleMs < 500) return 'network';
  if (f.churn ? f.sinceSignalMs < 1000 : f.domQuietMs < 500) return 'dom';
  return undefined;
}

/**
 * Splits errors seen after a reload into new ones and ones the page already had before (same text,
 * each earlier one matched once). Without a new document every error is new.
 */
export function dedupeErrors<T extends { text: string }>(errors: T[], before: string[], documentChanged: boolean): { fresh: T[]; still: T[] } {
  if (!documentChanged || before.length === 0) return { fresh: errors, still: [] };
  const left = new Map<string, number>();
  for (const t of before) left.set(errorKey(t), (left.get(errorKey(t)) ?? 0) + 1);
  const fresh: T[] = [];
  const still: T[] = [];
  for (const e of errors) {
    const k = errorKey(e.text);
    const n = left.get(k) ?? 0;
    if (n > 0) {
      left.set(k, n - 1);
      still.push(e);
    } else fresh.push(e);
  }
  return { fresh, still };
}

/**
 * The browser's own "Failed to load resource" console error for a request that is listed as a failed
 * request anyway (`location` is that request's URL).
 */
export function repeatsFailedRequest(entry: { source: string; text: string; location: string | undefined }, failedUrls: Set<string>): boolean {
  if (entry.source !== 'browser' || !entry.location || !/^Failed to load resource\b/.test(entry.text)) return false;
  return failedUrls.has(entry.location) || failedUrls.has(entry.location.replace(/(:\d+)+$/, ''));
}

/** An error's identity across reloads: its first line, without cache-busting queries. */
export function errorKey(text: string): string {
  return text.split('\n')[0]!.replace(/\?(?:import&)?(?:t|v)=\w+/g, '').trim();
}
