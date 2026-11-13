// Request-mocking rules (browser_route), without VS Code: validating what the agent asked for,
// matching requests, turning a rule into an interception decision, and describing rules in one line.
import type { FetchPattern, PausedRequest, RequestDecision } from './interception';
import { clip, formatBytes } from './page/ringBuffer';
import { urlMatcher } from './page/networkLog';

/** Network errors an agent can ask for, and the CDP `Network.ErrorReason` each one maps to. */
export const FAIL_REASONS = {
  failed: 'Failed',
  aborted: 'Aborted',
  timedout: 'TimedOut',
  refused: 'ConnectionRefused',
  reset: 'ConnectionReset',
  dns: 'NameNotResolved',
  offline: 'InternetDisconnected',
  blocked: 'BlockedByClient',
} as const;
export type FailReason = keyof typeof FAIL_REASONS;

export const MAX_DELAY_MS = 60_000;
const MAX_BODY = 1_000_000;

export interface RouteInput {
  url?: string;
  method?: string;
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  fail?: FailReason;
  delay?: number;
  setHeaders?: Record<string, string | null>;
  times?: number;
}

export interface RouteRule {
  id: string;
  sessionId: string;
  tabId: string;
  url: string;
  method: string | undefined;
  kind: 'fulfill' | 'fail' | 'continue';
  status: number;
  headers: Record<string, string>;
  body: string;
  fail: FailReason | undefined;
  delayMs: number;
  setHeaders: Record<string, string | null> | undefined;
  /** Requests left before the rule removes itself; undefined = unlimited. */
  remaining: number | undefined;
  hits: number;
  matches(url: string): boolean;
  /** Aborted when the rule is removed, so requests it is still holding go on unchanged. */
  ended?: AbortController;
}

export type RouteValidation = { ok: true; rule: Omit<RouteRule, 'id' | 'sessionId' | 'tabId'> } | { ok: false; error: string };

/** Checks the arguments of an "add" and builds the rule (without its id and owner). */
export function validateRoute(input: RouteInput): RouteValidation {
  const url = input.url?.trim();
  if (!url) return { ok: false, error: 'Pass url: the requests to match, e.g. "*/api/cart*" (a glob over the whole URL), "/api\\/cart$/" (a regex) or "api/cart" (a substring).' };
  let matches: (u: string) => boolean;
  try {
    matches = urlMatcher(url);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const responds = input.status !== undefined || input.body !== undefined || input.headers !== undefined;
  if (responds && input.fail) return { ok: false, error: 'Use either a response (status, headers, body) or fail, not both.' };
  if (input.setHeaders && (responds || input.fail)) return { ok: false, error: 'setHeaders changes a request that is then sent on; it cannot be combined with a mocked response or fail.' };
  if (!responds && !input.fail && !input.setHeaders && !input.delay) {
    return { ok: false, error: 'Say what to do with matching requests: respond (status, headers, body), fail (a network error), or pass them on after delay and/or with setHeaders.' };
  }
  if (input.body !== undefined && input.body.length > MAX_BODY) return { ok: false, error: `body is too long (${input.body.length} characters; at most ${MAX_BODY}).` };
  if (input.delay !== undefined && (input.delay < 0 || input.delay > MAX_DELAY_MS)) return { ok: false, error: `delay must be between 0 and ${MAX_DELAY_MS} ms.` };
  const kind = responds ? 'fulfill' : input.fail ? 'fail' : 'continue';
  const body = input.body ?? '';
  const status = input.status ?? 200;
  const headers: Record<string, string> = { ...(input.headers ?? {}) };
  if (kind === 'fulfill' && !Object.keys(headers).some(h => h.toLowerCase() === 'content-type') && body) headers['content-type'] = guessContentType(body);
  return {
    ok: true,
    rule: {
      url,
      method: input.method?.trim().toUpperCase() || undefined,
      kind,
      status,
      headers,
      body,
      fail: input.fail,
      delayMs: input.delay ?? 0,
      setHeaders: input.setHeaders,
      remaining: input.times,
      hits: 0,
      matches,
    },
  };
}

export function guessContentType(body: string): string {
  const t = body.trimStart();
  if (/^[{[]/.test(t)) {
    try {
      JSON.parse(body);
      return 'application/json';
    } catch {
      // not JSON
    }
  }
  if (/^<(!doctype|html|head|body|div|p|h\d)\b/i.test(t)) return 'text/html; charset=utf-8';
  return 'text/plain; charset=utf-8';
}

/** The `Fetch` pattern that pauses at least every request the rule matches (the rule re-checks exactly). */
export function fetchPatternFor(url: string): FetchPattern {
  if (/^\/.+\/[a-z]*$/.test(url)) return { urlPattern: '*' };
  // `Fetch` globs know * and ?, both wider than or equal to ours; a backslash escapes, so drop it.
  const glob = url.replace(/\\/g, '*');
  return { urlPattern: url.includes('*') ? glob : `*${glob}*` };
}

export function ruleMatches(rule: RouteRule, request: Pick<PausedRequest, 'url' | 'method'>): boolean {
  if (rule.method && rule.method !== request.method.toUpperCase()) return false;
  return rule.matches(request.url);
}

/** What the interception does with a request the rule matched. */
export function decisionFor(rule: RouteRule, request: Pick<PausedRequest, 'headers'>, owner: string): RequestDecision {
  const note = `${rule.kind === 'continue' ? (rule.setHeaders ? 'headers changed' : 'delayed') : 'mocked'} by ${rule.id}${owner ? ` (${owner})` : ''}`;
  const delayMs = rule.delayMs || undefined;
  if (rule.kind === 'fulfill') return { kind: 'fulfill', status: rule.status, headers: rule.headers, body: rule.body, delayMs, note };
  if (rule.kind === 'fail') return { kind: 'fail', reason: FAIL_REASONS[rule.fail!], delayMs, note };
  return { kind: 'continue', headers: rule.setHeaders ? applyHeaderChanges(request.headers, rule.setHeaders) : undefined, delayMs, note };
}

/** Request headers with `changes` applied, matching names case-insensitively; null removes a header. */
export function applyHeaderChanges(headers: Record<string, string>, changes: Record<string, string | null>): Record<string, string> {
  const out: Record<string, string> = {};
  const changed = new Map(Object.entries(changes).map(([k, v]) => [k.toLowerCase(), { name: k, value: v }]));
  for (const [k, v] of Object.entries(headers)) if (!changed.has(k.toLowerCase())) out[k] = v;
  for (const { name, value } of changed.values()) if (value !== null) out[name] = value;
  return out;
}

// One line per rule, e.g. "m1  GET */api/cart*  → 500, application/json, 27 B, after 2 s  (3 hits, 2 left)"
export function describeRule(rule: RouteRule): string {
  let what: string;
  if (rule.kind === 'fulfill') {
    const type = Object.entries(rule.headers).find(([k]) => k.toLowerCase() === 'content-type')?.[1]?.split(';')[0];
    what = `→ ${rule.status}${type ? `, ${type}` : ''}, ${formatBytes(Buffer.byteLength(rule.body))}`;
  } else if (rule.kind === 'fail') {
    what = `→ network error "${rule.fail}" (${FAIL_REASONS[rule.fail!]})`;
  } else {
    const changes = Object.entries(rule.setHeaders ?? {}).map(([k, v]) => (v === null ? `-${k}` : `${k}: ${clip(v, 40)}`));
    what = `→ sent on${changes.length ? ` with ${changes.join(', ')}` : ''}`;
  }
  const delay = rule.delayMs ? `, after ${rule.delayMs >= 1000 ? `${rule.delayMs / 1000} s` : `${rule.delayMs} ms`}` : '';
  const counts = `${rule.hits} hit${rule.hits === 1 ? '' : 's'}${rule.remaining !== undefined ? `, ${rule.remaining} left` : ''}`;
  return `${rule.id}  ${rule.method ?? 'any'} ${clip(rule.url, 200)}  ${what}${delay}  (${counts})`;
}
