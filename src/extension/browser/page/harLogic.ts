// A tab's recorded requests (networkLog.ts) as a HAR 1.2 log (http://www.softwareishard.com/blog/har-12-spec/),
// with secrets masked unless asked otherwise. Pure; harExport.ts gathers bodies and writes the file.
//
// What the network log does not record, and how it shows in the HAR:
// - header sizes (headersSize -1), the decoded body size unless the body is included (content.size -1),
//   the response's body size apart from headers (bodySize -1; `_transferSize` is the bytes received);
// - header values are cut at 1000 characters and a request's headers at 8000; URLs at 2000 and request
//   bodies at 20000 characters (a comment says so on the entry);
// - timings come from Chromium's resource timing when the response had it; otherwise (cache, failed,
//   mocked, redirects) only wait and receive are known, from when the events arrived;
// - Authorization and Proxy-Authorization are never recorded (only their scheme), whatever is asked;
// - Set-Cookie response headers are usually missing: Chromium reports them only in
//   `Network.responseReceivedExtraInfo`, which the log does not record (request Cookie headers it has);
// - requests sent while the user had the tab (`withheld`, privacy.ts) have no query, headers or bodies.
import type { NetworkEntry } from './networkLog';

export const MASKED = '(masked)';

/** Names of query parameters, form and JSON fields and headers whose values are treated as secrets. */
const SECRET_NAME =
  /^(?:.*[-_.])?(?:token|access[-_]?token|id[-_]?token|refresh[-_]?token|auth|auth[-_]?token|code|password|passwd|pwd|pass|passphrase|secret|client[-_]?secret|api[-_]?key|apikey|key|private[-_]?key|sig|signature|session|session[-_]?id|sid|jwt|otp|credentials?|ticket|csrf|xsrf|csrf[-_]?token|xsrf[-_]?token|nonce|pin|cvv|cvc|card[-_]?number)$/i;
/** A JSON Web Token anywhere in a value. */
const JWT = /\beyJ[\w-]{6,}\.eyJ[\w-]{6,}\.[\w-]+/g;

export function isSecretName(name: string): boolean {
  return SECRET_NAME.test(name.trim());
}

/** What was masked, by kind, for the agent's summary. */
export class MaskReport {
  readonly names = new Map<string, Set<string>>();
  jwts = 0;
  add(kind: string, name: string): void {
    let set = this.names.get(kind);
    if (!set) this.names.set(kind, (set = new Set()));
    set.add(name);
  }
  get empty(): boolean {
    return this.names.size === 0 && this.jwts === 0;
  }
  /** "cookies (sid, theme); query parameters (token); 2 token-like values". */
  summary(): string {
    const parts = [...this.names].map(([kind, names]) => {
      const list = [...names];
      return `${kind} (${list.slice(0, 6).join(', ')}${list.length > 6 ? `, +${list.length - 6}` : ''})`;
    });
    if (this.jwts) parts.push(`${this.jwts} token-like value${this.jwts === 1 ? '' : 's'} (JWT)`);
    return parts.join('; ');
  }
}

function maskJwts(text: string, report: MaskReport): string {
  return text.replace(JWT, () => {
    report.jwts++;
    return MASKED;
  });
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
}

/** `a=1&token=x` with secret values masked; keeps everything else as it was written. */
export function maskQuery(query: string, report: MaskReport, kind = 'query parameters'): string {
  return query
    .split('&')
    .map(pair => {
      const eq = pair.indexOf('=');
      if (eq < 0) return pair;
      const name = safeDecode(pair.slice(0, eq));
      const value = pair.slice(eq + 1);
      if (value && isSecretName(name)) {
        report.add(kind, name);
        return `${pair.slice(0, eq)}=${MASKED}`;
      }
      return `${pair.slice(0, eq)}=${maskJwts(value, report)}`;
    })
    .join('&');
}

/** A URL with secret query parameters (and token-like values) masked. */
export function maskUrl(url: string, report: MaskReport): string {
  const q = url.indexOf('?');
  if (q < 0) return url;
  const hash = url.indexOf('#', q);
  const query = url.slice(q + 1, hash < 0 ? undefined : hash);
  return `${url.slice(0, q + 1)}${maskQuery(query, report)}${hash < 0 ? '' : url.slice(hash)}`;
}

/** `Cookie: a=1; b=2` → `a=(masked); b=(masked)`: every cookie value. */
export function maskCookieHeader(value: string, report: MaskReport): string {
  return value
    .split(/;\s*/)
    .map(pair => {
      const eq = pair.indexOf('=');
      if (eq < 0) return pair;
      report.add('cookies', pair.slice(0, eq).trim());
      return `${pair.slice(0, eq)}=${MASKED}`;
    })
    .join('; ');
}

/** `Set-Cookie` (several lines in one value, as CDP gives them): each cookie's value; attributes stay. */
export function maskSetCookie(value: string, report: MaskReport): string {
  return value
    .split('\n')
    .map(line => {
      const eq = line.indexOf('=');
      const semi = line.indexOf(';');
      if (eq < 0 || (semi >= 0 && semi < eq)) return line;
      report.add('Set-Cookie', line.slice(0, eq).trim());
      return `${line.slice(0, eq)}=${MASKED}${semi >= 0 ? line.slice(semi) : ''}`;
    })
    .join('\n');
}

export function maskHeader(name: string, value: string, report: MaskReport): string {
  const n = name.toLowerCase();
  if (n === 'cookie') return maskCookieHeader(value, report);
  if (n === 'set-cookie') return maskSetCookie(value, report);
  if (n === 'authorization' || n === 'proxy-authorization') return value; // never recorded beyond the scheme
  if (n === 'referer' || n === 'location' || n === ':path' || n === 'content-location') return maskUrl(value, report);
  if (isSecretName(n)) {
    report.add('headers', name);
    return MASKED;
  }
  return maskJwts(value, report);
}

function maskJson(value: unknown, report: MaskReport): unknown {
  if (Array.isArray(value)) return value.map(v => maskJson(v, report));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (isSecretName(k) && (typeof v === 'string' || typeof v === 'number') && v !== '') {
        report.add('form and JSON fields', k);
        out[k] = MASKED;
      } else out[k] = maskJson(v, report);
    }
    return out;
  }
  if (typeof value === 'string') return maskJwts(value, report);
  return value;
}

/** A request or response body with secret fields masked: forms, JSON, multipart; token-like values in anything textual. */
export function maskBody(text: string, mimeType: string | undefined, report: MaskReport): string {
  const type = (mimeType ?? '').toLowerCase();
  if (type.includes('x-www-form-urlencoded')) return maskQuery(text, report, 'form and JSON fields');
  if (type.includes('json') || /^\s*[{[]/.test(text)) {
    try {
      return JSON.stringify(maskJson(JSON.parse(text), report));
    } catch {
      // not JSON after all
    }
  }
  if (type.includes('multipart/form-data')) {
    text = text.replace(/(name="([^"]*)"[^\r\n]*\r?\n(?:[^\r\n]+\r?\n)*\r?\n)([^\r\n]*)/g, (all, head: string, name: string, value: string) => {
      if (!value || !isSecretName(name)) return all;
      report.add('form and JSON fields', name);
      return head + MASKED;
    });
  }
  return maskJwts(text, report);
}

// ------------------------------------------------------------------ HAR

export interface HarPageInfo {
  /** Loader id of the page's document, to give the current one its title and load timings. */
  loaderId: string | undefined;
  /** When its navigation started (ms since epoch): makes it a page even when its document request is not in the log. */
  startedAt?: number;
  url?: string;
  title?: string;
  /** ms after the page's start, from the page's Navigation Timing. */
  onContentLoad?: number;
  onLoad?: number;
}

export type BodyResult = { text: string; base64: boolean; size: number } | { missing: string };

export interface HarInput {
  entries: NetworkEntry[];
  mainFrameId: string | undefined;
  /** The current document (title, load timings). */
  current?: HarPageInfo;
  /** Response bodies, by entry id; absent = not asked for. */
  bodies?: Map<string, BodyResult>;
  /** Request bodies read again in full, by entry id. */
  postData?: Map<string, string>;
  secrets: boolean;
  creator: { name: string; version: string };
  browser?: { name: string; version: string };
  comment?: string;
}

export interface HarStats {
  entries: number;
  pages: number;
  frameEntries: number;
  withheld: number;
  pending: number;
  cut: number;
  bodies: { included: number; missing: Map<string, number> };
  masked: MaskReport;
}

type Header = { name: string; value: string };
const round = (n: number) => Math.round(n * 1000) / 1000;

/** HAR timings for an entry: Chromium's resource timing when known, else what the events say. */
export function harTimings(e: NetworkEntry): { timings: Record<string, number>; time: number; approximate: boolean } {
  const t = e.timing;
  const endMs = e.end !== undefined ? e.end * 1000 : undefined;
  if (t && t.requestTime > 0 && t.receiveHeadersEnd >= 0 && t.sendEnd >= 0) {
    const queued = Math.max(0, (t.requestTime - e.start) * 1000);
    const starts = [t.dnsStart, t.connectStart, t.sendStart].filter(x => x >= 0);
    const blocked = queued + (starts.length ? Math.min(...starts) : 0);
    const dns = t.dnsStart >= 0 && t.dnsEnd >= 0 ? t.dnsEnd - t.dnsStart : -1;
    const connect = t.connectStart >= 0 && t.connectEnd >= 0 ? t.connectEnd - t.connectStart : -1;
    const ssl = t.sslStart >= 0 && t.sslEnd >= 0 ? t.sslEnd - t.sslStart : -1;
    const send = Math.max(0, t.sendEnd - Math.max(0, t.sendStart));
    const wait = Math.max(0, t.receiveHeadersEnd - t.sendEnd);
    const headersAt = t.requestTime * 1000 + t.receiveHeadersEnd;
    const receive = endMs !== undefined ? Math.max(0, endMs - headersAt) : 0;
    // ssl is part of connect (HAR 1.2), so it is not added again.
    const time = blocked + Math.max(0, dns) + Math.max(0, connect) + send + wait + receive;
    return { timings: { blocked: round(blocked), dns: round(dns), connect: round(connect), ssl: round(ssl), send: round(send), wait: round(wait), receive: round(receive) }, time: round(time), approximate: false };
  }
  const total = endMs !== undefined ? Math.max(0, endMs - e.start * 1000) : 0;
  const wait = e.respondedAt !== undefined ? Math.min(total || Infinity, Math.max(0, e.respondedAt - e.startedAt)) : total;
  const w = Number.isFinite(wait) ? wait : 0;
  return { timings: { blocked: -1, dns: -1, connect: -1, ssl: -1, send: 0, wait: round(w), receive: round(Math.max(0, total - w)) }, time: round(Math.max(total, w)), approximate: true };
}

function headerList(h: Record<string, string> | undefined, mask: ((n: string, v: string) => string) | undefined, cut: { value: boolean }): Header[] {
  if (!h) return [];
  const out: Header[] = [];
  for (const [name, value] of Object.entries(h)) {
    if (name === '…') {
      cut.value = true;
      continue;
    }
    if (value.endsWith('…') && value.length >= 1000) cut.value = true;
    const lines = name.toLowerCase() === 'set-cookie' ? value.split('\n') : [value];
    for (const line of lines) out.push({ name, value: mask ? mask(name, line) : line });
  }
  return out;
}

function headerValue(h: Header[], name: string): string | undefined {
  return h.find(x => x.name.toLowerCase() === name)?.value;
}

function queryString(url: string): Header[] {
  const q = url.indexOf('?');
  if (q < 0) return [];
  const hash = url.indexOf('#', q);
  return url
    .slice(q + 1, hash < 0 ? undefined : hash)
    .split('&')
    .filter(Boolean)
    .map(pair => {
      const eq = pair.indexOf('=');
      return eq < 0 ? { name: safeDecode(pair), value: '' } : { name: safeDecode(pair.slice(0, eq)), value: safeDecode(pair.slice(eq + 1)) };
    });
}

function requestCookies(headers: Header[]): Array<{ name: string; value: string }> {
  const cookie = headers.filter(h => h.name.toLowerCase() === 'cookie').map(h => h.value).join('; ');
  return cookie
    .split(/;\s*/)
    .filter(p => p.includes('='))
    .map(p => ({ name: p.slice(0, p.indexOf('=')).trim(), value: p.slice(p.indexOf('=') + 1) }));
}

function responseCookies(headers: Header[]): Array<Record<string, unknown>> {
  return headers
    .filter(h => h.name.toLowerCase() === 'set-cookie')
    .flatMap(h => h.value.split('\n'))
    .filter(line => line.includes('='))
    .map(line => {
      const [pair, ...attrs] = line.split(/;\s*/);
      const eq = pair!.indexOf('=');
      const cookie: Record<string, unknown> = { name: pair!.slice(0, eq).trim(), value: pair!.slice(eq + 1) };
      for (const attr of attrs) {
        const [k, ...v] = attr.split('=');
        const key = k!.trim().toLowerCase();
        const val = v.join('=').trim();
        if (key === 'path') cookie.path = val;
        else if (key === 'domain') cookie.domain = val;
        else if (key === 'expires') {
          const d = new Date(val);
          if (!Number.isNaN(d.getTime())) cookie.expires = d.toISOString();
        } else if (key === 'httponly') cookie.httpOnly = true;
        else if (key === 'secure') cookie.secure = true;
      }
      return cookie;
    });
}

const TEXTUAL = /^(text\/|application\/(json|javascript|ecmascript|xml|x-www-form-urlencoded|.*\+json|.*\+xml)|image\/svg)/i;

export function isTextual(mimeType: string | undefined): boolean {
  return TEXTUAL.test(mimeType ?? '');
}

/** Builds the HAR log. Masks secrets unless `secrets`; never adds anything a withheld entry lost. */
export function buildHar(input: HarInput): { har: { log: Record<string, unknown> }; stats: HarStats } {
  const report = new MaskReport();
  const stats: HarStats = { entries: 0, pages: 0, frameEntries: 0, withheld: 0, pending: 0, cut: 0, bodies: { included: 0, missing: new Map() }, masked: report };
  const maskH = input.secrets ? undefined : (n: string, v: string) => maskHeader(n, v, report);
  const maskU = (u: string) => (input.secrets ? u : maskUrl(u, report));
  const maskB = (text: string, mime: string | undefined) => (input.secrets ? text : maskBody(text, mime, report));

  // Pages: the main-frame documents in the log, each starting at its first hop, and the current
  // document also when its request was made before recording started. A request belongs to the last
  // page that started before it.
  const docs = new Map<string, { loaderId: string; start: number; url: string }>();
  for (const e of input.entries) {
    if (e.type !== 'Document' || e.requestId !== e.loaderId || (input.mainFrameId && e.frameId !== input.mainFrameId)) continue;
    const d = docs.get(e.requestId);
    if (d) d.url = e.url;
    else docs.set(e.requestId, { loaderId: e.requestId, start: e.startedAt, url: e.url });
  }
  const cur = input.current;
  if (cur?.loaderId && !docs.has(cur.loaderId) && cur.startedAt !== undefined) docs.set(cur.loaderId, { loaderId: cur.loaderId, start: cur.startedAt, url: cur.url ?? '' });
  const pages = [...docs.values()].sort((a, b) => a.start - b.start).map((p, i) => ({ ...p, id: `page_${i + 1}` }));
  const harPages = pages.map(p => {
    const current = cur && cur.loaderId === p.loaderId ? cur : undefined;
    return {
      startedDateTime: new Date(p.start).toISOString(),
      id: p.id,
      title: current?.title || maskU(p.url),
      pageTimings: { onContentLoad: current?.onContentLoad !== undefined ? round(current.onContentLoad) : -1, onLoad: current?.onLoad !== undefined ? round(current.onLoad) : -1 },
    };
  });
  stats.pages = harPages.length;
  const pageOf = (e: NetworkEntry): string | undefined => {
    let id: string | undefined;
    for (const p of pages) if (p.start <= e.startedAt + 1) id = p.id;
    return id;
  };

  const entries = input.entries.map(e => {
    stats.entries++;
    const cut = { value: e.url.length >= 2000 && e.url.endsWith('…') };
    const comments: string[] = [];
    const frame = e.frameId && input.mainFrameId && e.frameId !== input.mainFrameId ? e.frameId : undefined;
    if (frame) stats.frameEntries++;
    const reqHeaders = e.withheld ? [] : headerList(e.requestHeaders, maskH, cut);
    const resHeaders = e.withheld ? [] : headerList(e.responseHeaders, maskH, cut);
    const url = e.withheld ? e.url : maskU(e.url);
    const request: Record<string, unknown> = {
      method: e.method,
      url,
      httpVersion: e.protocol ?? '',
      cookies: requestCookies(reqHeaders),
      headers: reqHeaders,
      queryString: e.withheld ? [] : queryString(url),
      headersSize: -1,
      bodySize: 0,
    };
    if (e.hasPostData && !e.withheld) {
      const full = input.postData?.get(e.id);
      const raw = full ?? e.postData;
      const mime = headerValue(reqHeaders, 'content-type') ?? '';
      if (raw !== undefined) {
        if (full === undefined && raw.length >= 20_000 && raw.endsWith('…')) cut.value = true;
        const text = maskB(raw, mime);
        request.postData = { mimeType: mime, text };
        request.bodySize = Buffer.byteLength(raw);
      } else {
        request.postData = { mimeType: mime, text: '' };
        request.bodySize = -1;
        comments.push('request body not recorded');
      }
    }
    const { timings, time, approximate } = harTimings(e);
    const content: Record<string, unknown> = { size: -1, mimeType: e.mimeType ?? 'x-unknown' };
    const body = input.bodies?.get(e.id);
    if (body && 'text' in body) {
      content.size = body.size;
      content.text = body.base64 ? body.text : maskB(body.text, e.mimeType);
      if (body.base64) content.encoding = 'base64';
      stats.bodies.included++;
    } else if (body) {
      content.comment = `body not included: ${body.missing}`;
      stats.bodies.missing.set(body.missing, (stats.bodies.missing.get(body.missing) ?? 0) + 1);
    }
    const response: Record<string, unknown> = {
      status: e.failed ? 0 : (e.status ?? 0),
      statusText: e.failed ? '' : (e.statusText ?? ''),
      httpVersion: e.protocol ?? '',
      cookies: responseCookies(resHeaders),
      headers: resHeaders,
      content,
      redirectURL: e.redirectedTo ? (e.withheld ? e.redirectedTo : maskU(e.redirectedTo)) : '',
      headersSize: -1,
      bodySize: -1,
    };
    if (e.failed) response._error = e.failed;
    if (e.end === undefined && !e.failed) {
      stats.pending++;
      comments.push('not finished when exported');
    }
    if (e.withheld) {
      stats.withheld++;
      comments.push('sent while the user had the tab (browser_request_user_input): URL query, headers and bodies are withheld');
    }
    if (e.intercepted) comments.push(`not a real network response: ${e.intercepted} (browser_route)`);
    if (approximate && e.end !== undefined) comments.push('approximate timings');
    if (cut.value) {
      stats.cut++;
      comments.push('some header values, the URL or the request body were cut when recorded');
    }
    const entry: Record<string, unknown> = {
      ...(pageOf(e) ? { pageref: pageOf(e) } : {}),
      startedDateTime: new Date(e.startedAt).toISOString(),
      time,
      request,
      response,
      cache: {},
      timings,
    };
    if (e.remoteAddress) entry.serverIPAddress = e.remoteAddress.replace(/^\[|\]$/g, '');
    entry._resourceType = e.type.toLowerCase();
    if (e.size !== undefined) entry._transferSize = e.size;
    if (e.fromCache) entry._fromCache = 'disk';
    if (frame) entry._frameId = frame;
    if (comments.length) entry.comment = comments.join('; ');
    return entry;
  });

  const log: Record<string, unknown> = {
    version: '1.2',
    creator: input.creator,
    ...(input.browser ? { browser: input.browser } : {}),
    pages: harPages,
    entries,
  };
  if (input.comment) log.comment = input.comment;
  return { har: { log }, stats };
}
