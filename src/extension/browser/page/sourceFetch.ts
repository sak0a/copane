// Fetching scripts and source maps for browser_inspect (source.ts), and the per-tab cache of parsed
// maps.
//
// Scripts and maps are loaded by the browser itself (CDP `Network.loadNetworkResource`, read through
// `IO.read`), through VS Code's remote tunnel, so a dev server only the browser can reach works. These
// loads do not appear in the tab's network log (verified through VS Code's CDP proxy). Where the method
// is missing, a `fetch` in the bridge's isolated world takes over; those requests are visible in the
// log and are annotated there as the bridge's own.
//
// URLs come from the page (stack strings, map comments), so only http(s) is loaded (the browser
// refuses `file:` here anyway: "Unsupported URL scheme"), cookies go only to the document's own
// origin, and every load has a time limit that includes reading the body. Loads run on their own,
// not tied to one tool call, because their result is cached for later calls.
import type { PageCall } from './call';
import type { PageState } from './pageState';
import { decodeDataUrl, findSourceMapUrl, parseSourceMap, SourceMapError, type ParsedMap } from './sourceMap';

/** Largest script or map read. */
const MAX_BYTES = 8 * 1024 * 1024;
const CHUNK = 1024 * 1024;
/** Time limit for one script or map, from the request to the last byte. */
export const RESOURCE_TIMEOUT_MS = 5000;
const CACHE_ENTRIES = 30;
/** Bytes of decoded maps kept per tab. */
const CACHE_BYTES = 64_000_000;
/** A failed load is retried after this long (a dev server may be rebuilding). */
const FAILURE_TTL_MS = 3000;
/** Said in the network log for requests the bridge made itself (fallback path only). */
export const BRIDGE_FETCH_NOTE = 'fetched by the bridge (source map)';

export type Fetched = { ok: true; text: string; headers: Record<string, string> } | { ok: false; why: string };

/** A script's map, or why there is none (`missing`: the script has no map reference). */
export type MapResult = { map: ParsedMap; mapUrl: string; scriptModified?: number } | { error: string; missing?: boolean };

interface Entry {
  promise: Promise<MapResult>;
  size: number;
  loaderId: string;
  frameKey: string;
  /** Set for a failure: dropped after this time. */
  expires?: number;
}
interface Cache {
  entries: Map<string, Entry>;
  bytes: number;
}
const caches = new WeakMap<PageState, Cache>();

/** The tab's cache (exported for tests). */
export function cacheStats(state: PageState): { entries: number; bytes: number } {
  const cache = caches.get(state);
  return { entries: cache?.entries.size ?? 0, bytes: cache?.bytes ?? 0 };
}

/**
 * The map of a script, from the tab's cache or loaded. Keyed by frame, document (loaderId) and script
 * URL; entries of a frame's earlier documents are dropped. Never rejects.
 */
export function scriptMap(call: PageCall, scriptUrl: string): Promise<MapResult> {
  let cache = caches.get(call.state);
  if (!cache) caches.set(call.state, (cache = { entries: new Map(), bytes: 0 }));
  const c = cache;
  const frameKey = call.frame?.id ?? 'top';
  const loaderId = (call.frame ? call.frame.loaderId : call.state.loaderId) ?? '';
  const key = `${frameKey}\u0000${loaderId}\u0000${scriptUrl}`;
  for (const [k, e] of c.entries) if ((e.frameKey === frameKey && e.loaderId !== loaderId) || (e.expires !== undefined && e.expires < Date.now())) drop(c, k);
  const hit = c.entries.get(key);
  if (hit) {
    c.entries.delete(key);
    c.entries.set(key, hit);
    return hit.promise;
  }
  const entry: Entry = { promise: loadMap(call, scriptUrl).catch(err => ({ error: `could not be loaded (${err instanceof Error ? err.message : String(err)})` })), size: 0, loaderId, frameKey };
  c.entries.set(key, entry);
  void entry.promise.then(r => {
    if (c.entries.get(key) !== entry) return;
    if ('map' in r) {
      entry.size = r.map.size;
      c.bytes += entry.size;
    } else entry.expires = Date.now() + FAILURE_TTL_MS;
    trim(c);
  });
  trim(c);
  return entry.promise;
}

function drop(cache: Cache, key: string): void {
  const entry = cache.entries.get(key);
  if (!entry) return;
  cache.entries.delete(key);
  cache.bytes -= entry.size;
}

function trim(cache: Cache): void {
  for (const key of [...cache.entries.keys()]) {
    if (cache.entries.size <= CACHE_ENTRIES && cache.bytes <= CACHE_BYTES) break;
    drop(cache, key);
  }
}

/** The origin of the document the call runs in. */
function documentOrigin(call: PageCall): string | undefined {
  try {
    return new URL(call.frame?.url ?? call.state.url).origin;
  } catch {
    return undefined;
  }
}

async function loadMap(call: PageCall, scriptUrl: string): Promise<MapResult> {
  const script = await fetchText(call, scriptUrl);
  if (!script.ok) return { error: `script not readable: ${script.why}` };
  const mapRef = findSourceMapUrl(scriptUrl, script.text, script.headers);
  if (!mapRef) return { error: 'no source map', missing: true };
  const inline = mapRef.startsWith('data:');
  let text: string;
  if (inline) {
    const decoded = decodeDataUrl(mapRef);
    if (decoded === undefined) return { error: 'inline source map not readable' };
    text = decoded;
  } else {
    const fetched = await fetchText(call, mapRef);
    if (!fetched.ok) return { error: `source map not found: ${shortRef(mapRef, scriptUrl)} ${fetched.why}` };
    text = fetched.text;
  }
  try {
    const map = parseSourceMap(text, inline ? scriptUrl : mapRef);
    const modified = Date.parse(headerOf(script.headers, 'last-modified') ?? '');
    return { map, mapUrl: inline ? 'inline' : mapRef, ...(Number.isFinite(modified) ? { scriptModified: modified } : {}) };
  } catch (err) {
    if (err instanceof SourceMapError) return { error: `unusable source map: ${err.message}` };
    throw err;
  }
}

/** The map URL as said in a note: its path when on the script's origin. */
function shortRef(mapUrl: string, scriptUrl: string): string {
  try {
    const m = new URL(mapUrl);
    return m.origin === new URL(scriptUrl).origin ? m.pathname : mapUrl;
  } catch {
    return mapUrl.slice(0, 200);
  }
}

function headerOf(headers: Record<string, string>, name: string): string | undefined {
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === name && typeof v === 'string') return v;
  return undefined;
}

/** Text of a URL as the page would load it. `data:` URLs are decoded here; only http(s) is loaded. */
export async function fetchText(call: PageCall, url: string): Promise<Fetched> {
  const data = decodeDataUrl(url);
  if (data !== undefined) return { ok: true, text: data, headers: {} };
  let origin: string;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, why: `was not loaded (only http and https URLs are; this is ${u.protocol})` };
    origin = u.origin;
  } catch {
    return { ok: false, why: 'is not a valid URL' };
  }
  const sameOrigin = origin === documentOrigin(call);
  const result = (await loadNetworkResource(call, url, sameOrigin)) ?? (await fetchInPage(call, url, sameOrigin));
  // Without the page's cookies, a server that needs a login answers 401/403 or redirects to a login page.
  if (!result.ok && !sameOrigin) return { ok: false, why: `${result.why} (loaded without cookies: another origin than the page)` };
  return result;
}

const unsupported = new WeakSet<PageState>();

/** Rejects after `ms` with a "did not load" message; the work goes on and its result is dropped. */
function within<T>(ms: number, work: (deadline: number) => Promise<T>): Promise<T> {
  const deadline = Date.now() + ms;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new LoadTimeout()), ms);
    work(deadline).then(
      v => {
        clearTimeout(timer);
        resolve(v);
      },
      e => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
class LoadTimeout extends Error {}

/** Through the browser's network stack; undefined when the method is not available here. */
async function loadNetworkResource(call: PageCall, url: string, credentials: boolean): Promise<Fetched | undefined> {
  if (unsupported.has(call.state)) return undefined;
  const frameId = call.frame?.id ?? call.state.mainFrameId;
  if (!frameId) return undefined;
  const cdp = call.cdp;
  let stream: string | undefined;
  try {
    return await within(RESOURCE_TIMEOUT_MS, async deadline => {
      const left = () => Math.max(1, deadline - Date.now());
      const { resource } = await cdp.send<{ resource: { success: boolean; httpStatusCode?: number; netErrorName?: string; stream?: string; headers?: Record<string, string> } }>(
        'Network.loadNetworkResource',
        { frameId, url, options: { disableCache: false, includeCredentials: credentials } },
        { timeoutMs: left() },
      );
      stream = resource.stream;
      if (!resource.success || !resource.stream) {
        const status = resource.httpStatusCode;
        return { ok: false, why: status ? `answered ${status}` : `failed (${resource.netErrorName ?? 'network error'})` } as Fetched;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      for (;;) {
        const r = await cdp.send<{ data: string; base64Encoded?: boolean; eof: boolean }>('IO.read', { handle: resource.stream, size: CHUNK }, { timeoutMs: left() });
        const chunk = r.base64Encoded ? Buffer.from(r.data, 'base64') : Buffer.from(r.data, 'utf8');
        total += chunk.length;
        if (total > MAX_BYTES) return { ok: false, why: `is larger than ${MAX_BYTES / 1024 / 1024} MB` } as Fetched;
        chunks.push(chunk);
        if (r.eof) break;
        if (Date.now() >= deadline) throw new LoadTimeout();
      }
      return { ok: true, text: Buffer.concat(chunks).toString('utf8'), headers: resource.headers ?? {} } as Fetched;
    });
  } catch (err) {
    if (err instanceof LoadTimeout || (err instanceof Error && /did not answer|timed? ?out/i.test(err.message))) return { ok: false, why: `did not load within ${RESOURCE_TIMEOUT_MS / 1000} s` };
    const message = err instanceof Error ? err.message : String(err);
    // Only the browser saying the method does not exist ("'Network.loadNetworkResource' wasn't found")
    // switches to the fallback; any other error ("Frame not found", ...) is about this load only.
    if (/'Network\.loadNetworkResource' wasn't found|method not found/i.test(message)) {
      unsupported.add(call.state);
      return undefined;
    }
    return { ok: false, why: `could not be loaded (${message.replace(/^Error: /, '').slice(0, 200)})` };
  } finally {
    if (stream) void cdp.send('IO.close', { handle: stream }, { timeoutMs: 5000 }).then(undefined, () => undefined);
  }
}

const FETCH_IN_PAGE = `async function (url, max, credentials, ms) {
  try {
    const res = await fetch(url, { credentials: credentials ? 'include' : 'omit', signal: AbortSignal.timeout(ms) });
    if (!res.ok) return { ok: false, why: 'answered ' + res.status };
    const text = await res.text();
    if (text.length > max) return { ok: false, why: 'is too large' };
    const headers = {};
    for (const name of ['sourcemap', 'x-sourcemap', 'last-modified']) { const v = res.headers.get(name); if (v) headers[name] = v; }
    return { ok: true, text, headers };
  } catch (e) {
    return { ok: false, why: e && e.name === 'TimeoutError' ? 'did not load within ' + (ms / 1000) + ' s' : 'could not be fetched (' + String(e && e.message || e).slice(0, 200) + ')' };
  }
}`;

/** Fallback: `fetch` in the bridge's isolated world; the request is marked as the bridge's in the network log. */
async function fetchInPage(call: PageCall, url: string, credentials: boolean): Promise<Fetched> {
  const since = call.state.seq;
  try {
    const result = await call.evaluate<Fetched>(FETCH_IN_PAGE, [url, MAX_BYTES, credentials, RESOURCE_TIMEOUT_MS], { timeoutMs: RESOURCE_TIMEOUT_MS + 2000 });
    return result && typeof result === 'object' ? result : { ok: false, why: 'could not be fetched' };
  } finally {
    for (const entry of call.state.network.entries.after(since)) {
      if (entry.url === url) call.state.network.annotate(entry.requestId, BRIDGE_FETCH_NOTE);
    }
  }
}
