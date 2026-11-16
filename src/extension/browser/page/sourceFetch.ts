// Fetching scripts and source maps for browser_inspect (source.ts), and the per-tab cache of parsed
// maps.
//
// Scripts and maps are loaded by the browser itself (CDP `Network.loadNetworkResource`, read through
// `IO.read`), with the page's cookies and through VS Code's remote tunnel, so a dev server only the
// browser can reach works. These loads do not appear in the tab's network log (verified through VS
// Code's CDP proxy). Where the method is missing, a `fetch` in the bridge's isolated world takes over;
// those requests are visible in the log and are annotated there as the bridge's own.
import { ToolError } from '../../core/errors';
import type { PageCall } from './call';
import { DialogInterrupt, type PageState } from './pageState';
import { decodeDataUrl, findSourceMapUrl, parseSourceMap, SourceMapError, type ParsedMap } from './sourceMap';

/** Largest script or map read. */
const MAX_BYTES = 8 * 1024 * 1024;
const CHUNK = 1024 * 1024;
const CACHE_ENTRIES = 30;
const CACHE_CHARS = 64_000_000;
/** Said in the network log for requests the bridge made itself (fallback path only). */
export const BRIDGE_FETCH_NOTE = 'fetched by the bridge (source map)';

export type Fetched = { ok: true; text: string; headers: Record<string, string> } | { ok: false; why: string };

/** A script's map, or why there is none (`missing`: the script has no map reference). */
export type MapResult = { map: ParsedMap; mapUrl: string; scriptModified?: number } | { error: string; missing?: boolean };

interface Cache {
  entries: Map<string, { promise: Promise<MapResult>; size: number }>;
  chars: number;
}
const caches = new WeakMap<PageState, Cache>();

/** The map of a script, from the tab's cache or fetched. Keyed by the document (loaderId) and script URL. */
export function scriptMap(call: PageCall, scriptUrl: string): Promise<MapResult> {
  let cache = caches.get(call.state);
  if (!cache) caches.set(call.state, (cache = { entries: new Map(), chars: 0 }));
  const loaderId = call.frame ? call.frame.loaderId : call.state.loaderId;
  const key = `${loaderId ?? ''}\u0000${scriptUrl}`;
  const hit = cache.entries.get(key);
  if (hit) {
    cache.entries.delete(key);
    cache.entries.set(key, hit);
    return hit.promise;
  }
  const entry = { promise: loadMap(call, scriptUrl), size: 0 };
  cache.entries.set(key, entry);
  const c = cache;
  entry.promise.then(
    r => {
      if ('map' in r && c.entries.get(key) === entry) {
        entry.size = r.map.size;
        c.chars += entry.size;
      }
      trim(c);
    },
    () => c.entries.get(key) === entry && c.entries.delete(key),
  );
  trim(c);
  return entry.promise;
}

function trim(cache: Cache): void {
  for (const [key, entry] of cache.entries) {
    if (cache.entries.size <= CACHE_ENTRIES && cache.chars <= CACHE_CHARS) break;
    cache.entries.delete(key);
    cache.chars -= entry.size;
  }
}

async function loadMap(call: PageCall, scriptUrl: string): Promise<MapResult> {
  const script = await fetchText(call, scriptUrl);
  if (!script.ok) return { error: `script not readable: ${script.why}` };
  const mapRef = findSourceMapUrl(scriptUrl, script.text, script.headers);
  if (!mapRef) return { error: 'no source map', missing: true };
  const inline = mapRef.startsWith('data:');
  const mapText = inline ? decodeDataUrl(mapRef) : undefined;
  let text: string;
  if (inline) {
    if (mapText === undefined) return { error: 'inline source map not readable' };
    text = mapText;
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
    if (err instanceof SourceMapError) return { error: err.message };
    throw err;
  }
}

/** The map URL as said in a note: its path when on the script's origin. */
function shortRef(mapUrl: string, scriptUrl: string): string {
  try {
    const m = new URL(mapUrl);
    return m.origin === new URL(scriptUrl).origin ? m.pathname : mapUrl;
  } catch {
    return mapUrl;
  }
}

function headerOf(headers: Record<string, string>, name: string): string | undefined {
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === name) return v;
  return undefined;
}

/** Text of a URL as the page would load it. `data:` URLs are decoded here. */
export async function fetchText(call: PageCall, url: string): Promise<Fetched> {
  const data = decodeDataUrl(url);
  if (data !== undefined) return { ok: true, text: data, headers: {} };
  const viaCdp = await loadNetworkResource(call, url);
  if (viaCdp) return viaCdp;
  return fetchInPage(call, url);
}

const unsupported = new WeakSet<PageState>();

/** Through the browser's network stack; undefined when the method is not available here. */
async function loadNetworkResource(call: PageCall, url: string): Promise<Fetched | undefined> {
  if (unsupported.has(call.state)) return undefined;
  const frameId = call.frame?.id ?? call.state.mainFrameId;
  if (!frameId) return undefined;
  let resource: { success: boolean; httpStatusCode?: number; netErrorName?: string; stream?: string; headers?: Record<string, string> };
  try {
    ({ resource } = await call.send('Network.loadNetworkResource', { frameId, url, options: { disableCache: false, includeCredentials: true } }, { timeoutMs: 10_000 }));
  } catch (err) {
    if (err instanceof DialogInterrupt || err instanceof ToolError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    if (/wasn't found|not found|unknown method|not supported|not allowed/i.test(message)) {
      unsupported.add(call.state);
      return undefined;
    }
    return { ok: false, why: `could not be loaded (${message.replace(/^Network\.loadNetworkResource: /, '')})` };
  }
  if (!resource.success || !resource.stream) {
    if (resource.stream) void closeStream(call, resource.stream);
    const status = resource.httpStatusCode;
    return { ok: false, why: status ? `answered ${status}` : `failed (${resource.netErrorName ?? 'network error'})` };
  }
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const r = await call.send<{ data: string; base64Encoded?: boolean; eof: boolean }>('IO.read', { handle: resource.stream, size: CHUNK }, { timeoutMs: 10_000 });
      const chunk = r.base64Encoded ? Buffer.from(r.data, 'base64') : Buffer.from(r.data, 'utf8');
      total += chunk.length;
      if (total > MAX_BYTES) return { ok: false, why: `is larger than ${MAX_BYTES / 1024 / 1024} MB` };
      chunks.push(chunk);
      if (r.eof) break;
    }
  } finally {
    void closeStream(call, resource.stream);
  }
  return { ok: true, text: Buffer.concat(chunks).toString('utf8'), headers: resource.headers ?? {} };
}

function closeStream(call: PageCall, handle: string): Promise<void> {
  return call.cdp.send('IO.close', { handle }, { timeoutMs: 5000 }).then(
    () => undefined,
    () => undefined,
  );
}

const FETCH_IN_PAGE = `async function (url, max) {
  try {
    const res = await fetch(url, { credentials: 'include', signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { ok: false, why: 'answered ' + res.status };
    const text = await res.text();
    if (text.length > max) return { ok: false, why: 'is too large' };
    const headers = {};
    for (const name of ['sourcemap', 'x-sourcemap', 'last-modified']) { const v = res.headers.get(name); if (v) headers[name] = v; }
    return { ok: true, text, headers };
  } catch (e) {
    return { ok: false, why: 'could not be fetched (' + (e && e.message || e) + ')' };
  }
}`;

/** Fallback: `fetch` in the bridge's isolated world; the request is marked as the bridge's in the network log. */
async function fetchInPage(call: PageCall, url: string): Promise<Fetched> {
  const since = call.state.seq;
  const result = await call.evaluate<Fetched>(FETCH_IN_PAGE, [url, MAX_BYTES], { timeoutMs: 8000 });
  for (const entry of call.state.network.entries.after(since)) {
    if (entry.url === url) call.state.network.annotate(entry.requestId, BRIDGE_FETCH_NOTE);
  }
  return result;
}
