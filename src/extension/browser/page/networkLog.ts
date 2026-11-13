// Network requests of one tab, recorded from CDP `Network.*` events into a bounded buffer, with
// filtering and formatting for the agent. Pure: fed with CDP event params.
import { clip, formatBytes, formatMs, RingBuffer } from './ringBuffer';

export interface NetworkEntry {
  seq: number;
  /** Short id shown to the agent, e.g. "r12". */
  id: string;
  /** CDP request id (several entries share one across redirects; the last one is the live one). */
  requestId: string;
  /** The navigation loader this request belongs to (equals `requestId` for document requests). */
  loaderId: string | undefined;
  method: string;
  url: string;
  type: string;
  frameId: string | undefined;
  /** Wall-clock start, ms since epoch. */
  startedAt: number;
  /** Wall-clock time the response headers arrived. */
  respondedAt: number | undefined;
  /** Monotonic CDP timestamps, seconds. */
  start: number;
  end: number | undefined;
  status: number | undefined;
  statusText: string | undefined;
  mimeType: string | undefined;
  /** Bytes received over the network (compressed). */
  size: number | undefined;
  fromCache: boolean;
  failed: string | undefined;
  canceled: boolean;
  /** The response was a redirect to the next entry with the same requestId. */
  redirectedTo: string | undefined;
  requestHeaders: Record<string, string> | undefined;
  responseHeaders: Record<string, string> | undefined;
  hasPostData: boolean;
  postData: string | undefined;
  /** The response body is gone (the request was replaced by a newer page, or redirected). */
  bodyUnavailable: boolean;
  /** Set when the bridge answered or changed the request itself, e.g. "mocked by m1 (Claude 1)" (browser_route). */
  intercepted?: string;
}

const MAX_URL = 2000;
const MAX_HEADERS_CHARS = 8000;
const MAX_POST_DATA = 20_000;
/** Resource types hidden by default, unless they failed. */
export const STATIC_TYPES = new Set(['Image', 'Font', 'Stylesheet', 'Media', 'Script', 'Manifest', 'TextTrack', 'Ping', 'Prefetch', 'CSPViolationReport', 'Other']);
/** Long-lived requests that never "finish" and must not keep the network busy. */
const LONG_LIVED = new Set(['EventSource', 'WebSocket']);

/** Headers that carry credentials (a login typed by the user): only their scheme is kept. */
const SECRET_HEADERS = /^(proxy-)?authorization$/i;

export function redactHeader(name: string, value: string): string {
  if (!SECRET_HEADERS.test(name)) return value;
  const scheme = /^\s*([A-Za-z][\w-]*)\s+\S/.exec(value)?.[1];
  return `${scheme ? `${scheme} ` : ''}(credentials hidden)`;
}

function capHeaders(headers: Record<string, unknown> | undefined): Record<string, string> | undefined {
  if (!headers) return undefined;
  const out: Record<string, string> = {};
  let used = 0;
  for (const [k, v] of Object.entries(headers)) {
    const value = clip(redactHeader(k, String(v)), 1000);
    used += k.length + value.length;
    if (used > MAX_HEADERS_CHARS) {
      out['…'] = 'more headers were cut';
      break;
    }
    out[k] = value;
  }
  return out;
}

export class NetworkLog {
  readonly entries: RingBuffer<NetworkEntry>;
  private readonly live = new Map<string, NetworkEntry>();
  /** Annotations that arrived before their request's entry. */
  private readonly earlyNotes = new Map<string, string>();
  private nextId = 1;

  constructor(
    capacity: number,
    private readonly nextSeq: () => number,
  ) {
    this.entries = new RingBuffer(capacity);
  }

  /** `Network.requestWillBeSent` */
  onRequest(p: {
    requestId: string;
    loaderId?: string;
    request: { url: string; method: string; headers?: Record<string, unknown>; postData?: string; hasPostData?: boolean };
    timestamp: number;
    wallTime?: number;
    type?: string;
    frameId?: string;
    redirectResponse?: { status: number; statusText?: string; headers?: Record<string, unknown>; mimeType?: string; encodedDataLength?: number };
  }): NetworkEntry | undefined {
    const url = p.request.url;
    if (url.startsWith('data:') || url.startsWith('blob:')) return undefined;
    const previous = this.live.get(p.requestId);
    if (previous && p.redirectResponse) {
      previous.status = p.redirectResponse.status;
      previous.statusText = p.redirectResponse.statusText;
      previous.responseHeaders = capHeaders(p.redirectResponse.headers);
      previous.mimeType = p.redirectResponse.mimeType;
      previous.end = p.timestamp;
      previous.redirectedTo = url;
      previous.bodyUnavailable = true;
    }
    const entry: NetworkEntry = {
      seq: this.nextSeq(),
      id: `r${this.nextId++}`,
      requestId: p.requestId,
      loaderId: p.loaderId,
      method: p.request.method,
      url: clip(url, MAX_URL),
      type: p.type ?? 'Other',
      frameId: p.frameId,
      startedAt: p.wallTime ? p.wallTime * 1000 : Date.now(),
      start: p.timestamp,
      respondedAt: undefined,
      end: undefined,
      status: undefined,
      statusText: undefined,
      mimeType: undefined,
      size: undefined,
      fromCache: false,
      failed: undefined,
      canceled: false,
      redirectedTo: undefined,
      requestHeaders: capHeaders(p.request.headers),
      responseHeaders: undefined,
      hasPostData: Boolean(p.request.hasPostData || p.request.postData),
      postData: p.request.postData !== undefined ? clip(p.request.postData, MAX_POST_DATA) : undefined,
      bodyUnavailable: false,
    };
    const early = this.earlyNotes.get(p.requestId);
    if (early) {
      entry.intercepted = early;
      this.earlyNotes.delete(p.requestId);
    }
    this.live.set(p.requestId, entry);
    this.entries.push(entry);
    return entry;
  }

  /** `Network.requestWillBeSentExtraInfo`: the headers actually sent (cookies included). */
  onRequestExtra(p: { requestId: string; headers?: Record<string, unknown> }): void {
    const entry = this.live.get(p.requestId);
    if (entry && p.headers) entry.requestHeaders = capHeaders({ ...entry.requestHeaders, ...p.headers });
  }

  /** `Network.responseReceived` */
  onResponse(p: { requestId: string; type?: string; response: { status: number; statusText?: string; headers?: Record<string, unknown>; mimeType?: string; fromDiskCache?: boolean; fromServiceWorker?: boolean; fromPrefetchCache?: boolean; encodedDataLength?: number } }): void {
    const entry = this.live.get(p.requestId);
    if (!entry) return;
    const r = p.response;
    entry.status = r.status;
    entry.respondedAt = Date.now();
    entry.statusText = r.statusText;
    entry.mimeType = r.mimeType;
    entry.responseHeaders = capHeaders(r.headers);
    entry.fromCache ||= Boolean(r.fromDiskCache || r.fromPrefetchCache);
    if (p.type) entry.type = p.type;
  }

  /** `Network.loadingFinished` */
  onFinished(p: { requestId: string; timestamp: number; encodedDataLength?: number }): void {
    const entry = this.live.get(p.requestId);
    if (!entry) return;
    entry.end = p.timestamp;
    entry.size = p.encodedDataLength;
  }

  /** `Network.loadingFailed` */
  onFailed(p: { requestId: string; timestamp: number; errorText?: string; canceled?: boolean; blockedReason?: string; corsErrorStatus?: { corsError?: string } }): void {
    const entry = this.live.get(p.requestId);
    if (!entry) return;
    entry.end = p.timestamp;
    entry.canceled = Boolean(p.canceled);
    entry.failed = p.blockedReason ? `blocked: ${p.blockedReason}` : p.corsErrorStatus?.corsError ? `CORS: ${p.corsErrorStatus.corsError}` : (p.errorText || 'failed');
  }

  /** `Network.requestServedFromCache` */
  onServedFromCache(p: { requestId: string }): void {
    const entry = this.live.get(p.requestId);
    if (entry) entry.fromCache = true;
  }

  /** Marks the request (CDP `Network` id) as answered or changed by the bridge. */
  annotate(requestId: string, note: string): void {
    const entry = this.live.get(requestId);
    if (entry) {
      entry.intercepted = note;
      return;
    }
    this.earlyNotes.set(requestId, note);
    if (this.earlyNotes.size > 200) this.earlyNotes.delete(this.earlyNotes.keys().next().value!);
  }

  /** The entry for a CDP request id (the latest, after redirects). */
  byRequestId(requestId: string): NetworkEntry | undefined {
    return this.live.get(requestId);
  }

  byId(id: string): NetworkEntry | undefined {
    return this.entries.all().find(e => e.id === id);
  }

  /**
   * Requests still in flight that count against "network idle". Long-lived ones (event streams, web
   * sockets), very old ones, and responses whose body has stalled for a second (often a body the page
   * never reads) do not count.
   */
  inflight(now: number, ignoreOlderThanMs: number): NetworkEntry[] {
    return this.entries
      .all()
      .filter(e => e.end === undefined && !e.failed && !LONG_LIVED.has(e.type) && now - e.startedAt < ignoreOlderThanMs && (e.respondedAt === undefined || now - e.respondedAt < 1000));
  }

  /** Forget request ids that can no longer receive events, keeping the buffer. */
  prune(): void {
    if (this.live.size < this.entries.capacity * 2) return;
    const keep = new Set(this.entries.all().map(e => e.requestId));
    for (const id of this.live.keys()) if (!keep.has(id)) this.live.delete(id);
  }
}

export function isFailure(e: NetworkEntry): boolean {
  return (e.failed !== undefined && !e.canceled) || (e.status !== undefined && e.status >= 400);
}

export interface NetworkFilter {
  /** Substring of the URL, or /regex/flags. */
  url?: string;
  method?: string;
  /** "failed" (network errors and HTTP >= 400), "2xx", "4xx", "5xx", or an exact code like "404". */
  status?: string;
  /** CDP resource types, case-insensitive: fetch, xhr, document, script, ... */
  types?: string[];
  includeStatic?: boolean;
}

/** Throws an Error with a readable message for an invalid regex. */
export function urlMatcher(pattern: string | undefined): (url: string) => boolean {
  if (!pattern) return () => true;
  const re = /^\/(.+)\/([a-z]*)$/.exec(pattern);
  if (re) {
    let regex: RegExp;
    try {
      regex = new RegExp(re[1]!, re[2]);
    } catch (err) {
      throw new Error(`Invalid regular expression ${pattern}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return url => regex.test(url);
  }
  if (pattern.includes('*')) {
    const regex = new RegExp(`^${pattern.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
    return url => regex.test(url);
  }
  return url => url.includes(pattern);
}

export function filterNetwork(entries: NetworkEntry[], f: NetworkFilter): { matched: NetworkEntry[]; hiddenStatic: number } {
  const matchUrl = urlMatcher(f.url);
  const types = f.types?.map(t => t.toLowerCase());
  let hiddenStatic = 0;
  const matched = entries.filter(e => {
    if (!matchUrl(e.url)) return false;
    if (f.method && e.method.toUpperCase() !== f.method.toUpperCase()) return false;
    if (f.status && !statusMatches(e, f.status)) return false;
    if (types?.length) return types.includes(e.type.toLowerCase());
    if (!f.includeStatic && STATIC_TYPES.has(e.type) && !isFailure(e)) {
      hiddenStatic++;
      return false;
    }
    return true;
  });
  return { matched, hiddenStatic };
}

function statusMatches(e: NetworkEntry, status: string): boolean {
  const s = status.trim().toLowerCase();
  if (s === 'failed' || s === 'error' || s === 'errors') return isFailure(e);
  if (s === 'pending') return e.end === undefined && !e.failed;
  if (/^[1-5]xx$/.test(s)) return e.status !== undefined && Math.floor(e.status / 100) === Number(s[0]);
  if (/^\d{3}$/.test(s)) return e.status === Number(s);
  if (/^>=?\d{3}$/.test(s)) return e.status !== undefined && e.status >= Number(s.replace(/[>=]/g, '')) + (s.includes('=') ? 0 : 1);
  return true;
}

/** "r12  GET 200 fetch  http://…/api/items  34 ms, 1.2 kB" */
export function formatNetworkEntry(e: NetworkEntry, now: number): string {
  let state: string;
  if (e.failed) state = e.canceled ? 'CANCELED' : `FAILED (${e.failed})`;
  else if (e.status !== undefined) state = `${e.status}${e.redirectedTo ? ' →' : ''}`;
  else state = 'pending';
  const timing =
    e.end !== undefined ? formatMs((e.end - e.start) * 1000)
    : e.failed ? ''
    : e.respondedAt !== undefined ? `headers after ${formatMs(e.respondedAt - e.startedAt)}, body not finished`
    : `${formatMs(now - e.startedAt)} so far`;
  const details = [timing, e.size !== undefined && !e.failed ? formatBytes(e.size) : '', e.fromCache ? 'cache' : '', e.intercepted ?? ''].filter(Boolean).join(', ');
  return `${e.id}  ${e.method} ${state} ${e.type.toLowerCase()}  ${clip(e.url, 300)}${details ? `  (${details})` : ''}`;
}
