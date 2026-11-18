// The rules of handing a browser tab to the user (browser_request_user_input), without `vscode`, so
// they are unit-tested: the condition that ends a hand-off by itself, the page probe that checks it,
// what the agent is told at the end, and when a page looks like a sign-in page.
import { formatAge } from './access';
import { urlMatcher } from './page/networkLog';

/** Ends the hand-off by itself once every given part holds. */
export interface DoneWhen {
  /**
   * The tab's URL without query and fragment contains this or matches this glob (*), or the full URL
   * matches /regex/flags. Without the query, because sign-in URLs carry the address to return to.
   */
  url?: string;
  /** This text is visible on the page (case-insensitive). */
  text?: string;
  /** This text is no longer visible on the page (case-insensitive). */
  gone?: string;
  /** An element matching this CSS selector exists. */
  selector?: string;
}

export type HandoffOutcome =
  | { kind: 'condition' }
  | { kind: 'done'; via: 'page' | 'command' | 'notification' | 'resume' }
  | { kind: 'declined'; via: 'page' | 'command' | 'notification' }
  | { kind: 'timeout' }
  | { kind: 'closed' }
  | { kind: 'cancelled' }
  | { kind: 'session-ended' };

/** What the page probe reports. Fields of parts that were not asked for are absent. */
export interface PageProbe {
  href: string;
  title: string;
  ready: string;
  /** The tab is on screen (not behind another editor, not covered). */
  visible: boolean;
  text?: boolean;
  gone?: boolean;
  /** "invalid" when the selector does not parse. */
  selector?: boolean | 'invalid';
  heading?: string;
  /** Visible password fields. */
  passwords?: number;
}

/** Checks the condition for mistakes before anything is handed over. Returns a message for the agent, or undefined. */
export function validateDoneWhen(c: DoneWhen | undefined): string | undefined {
  if (!c) return undefined;
  const given = (['url', 'text', 'gone', 'selector'] as const).filter(k => c[k] !== undefined && c[k] !== '');
  if (given.length === 0) return 'done_when needs at least one of url, text, gone or selector (or leave it out to wait for the user).';
  if (c.url) {
    try {
      urlMatcher(c.url);
    } catch (err) {
      return `done_when.url: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  // Attribute selectors on `value` could test what the user types (frameworks mirror it into the attribute).
  if (c.selector && /\[\s*value\b/i.test(c.selector)) return 'done_when.selector cannot test field values: what the user types stays private. Test for an element of the page after sign-in instead.';
  return undefined;
}

/** True when the probe says every given part of the condition holds. */
export function conditionHolds(c: DoneWhen, probe: Pick<PageProbe, 'href' | 'text' | 'gone' | 'selector'>): boolean {
  if (c.url && !urlHolds(c.url, probe.href)) return false;
  if (c.text && probe.text !== true) return false;
  if (c.gone && probe.gone !== true) return false;
  if (c.selector && probe.selector !== true) return false;
  return true;
}

/** See `DoneWhen.url`. */
export function urlHolds(pattern: string, href: string): boolean {
  const isRegex = /^\/.+\/[a-z]*$/.test(pattern);
  return urlMatcher(pattern)(isRegex ? href : href.replace(/[?#].*$/, ''));
}

/**
 * An expression for `Runtime.evaluate` (returnByValue) that reports the page's state as a JSON string
 * (see PageProbe): always URL, title, readiness and visibility; the condition's parts; with `describe`,
 * the main heading and how many password fields are visible. Reads no field values.
 */
export function probeExpression(c: DoneWhen | undefined, describe: boolean): string {
  const text = c?.text ? c.text.toLowerCase() : null;
  const gone = c?.gone ? c.gone.toLowerCase() : null;
  const selector = c?.selector || null;
  return `(() => {
  const r = { href: location.href, title: document.title, ready: document.readyState, visible: document.visibilityState === 'visible' };
  const TEXT = ${JSON.stringify(text)}, GONE = ${JSON.stringify(gone)}, SEL = ${JSON.stringify(selector)};
  if (TEXT !== null || GONE !== null) {
    const body = document.body ? document.body.innerText.toLowerCase() : '';
    if (TEXT !== null) r.text = body.includes(TEXT);
    if (GONE !== null) r.gone = !body.includes(GONE);
  }
  if (SEL !== null) { try { r.selector = !!document.querySelector(SEL); } catch { r.selector = 'invalid'; } }
  if (${describe}) {
    const h = document.querySelector('h1') || document.querySelector('h2') || document.querySelector('[role=heading]');
    r.heading = h ? h.innerText.replace(/\\s+/g, ' ').trim().slice(0, 120) : '';
    r.passwords = [...document.querySelectorAll('input[type=password i]')].filter(e => { const b = e.getBoundingClientRect(); return b.width > 2 && b.height > 2 && b.right > 0 && b.bottom > 0 && getComputedStyle(e).visibility !== 'hidden'; }).length;
  }
  return JSON.stringify(r);
})()`;
}

export function parseProbe(value: unknown): PageProbe | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const p = JSON.parse(value) as PageProbe;
    return typeof p.href === 'string' ? p : undefined;
  } catch {
    return undefined;
  }
}

/** The first sentence of the result: how the hand-off ended. */
export function describeOutcome(outcome: HandoffOutcome, tabId: string, waitedMs: number): string {
  const after = formatAge(waitedMs);
  switch (outcome.kind) {
    case 'condition':
      return `done_when matched after ${after}: the user finished in ${tabId}, which is yours again.`;
    case 'done':
      return `The user said they are done (after ${after}); ${tabId} is yours again.`;
    case 'declined':
      return `The user declined ("Won't do") after ${after}; ${tabId} is yours again. Do not ask again: continue without it, or ask the user in chat what they would prefer.`;
    case 'timeout':
      return `No answer from the user within ${after}; the request was withdrawn and ${tabId} is yours again. Ask the user in chat before trying again.`;
    case 'closed':
      return `The user closed ${tabId} (after ${after}). Open a new tab with browser_open if you still need the page.`;
    case 'cancelled':
    case 'session-ended':
      return 'Cancelled; the request to the user was withdrawn.';
  }
}

/** "Page now: <url> — "<title>", heading "…" (still loading)." plus a warning when a login form is still there. */
export function describePage(probe: PageProbe | undefined, fallbackUrl: string, outcome: HandoffOutcome): string {
  if (!probe) return `Page now: ${clip(fallbackUrl, 300)}.`;
  const title = probe.title.trim();
  const heading = probe.heading && probe.heading !== title ? `, heading "${clip(probe.heading, 100)}"` : '';
  const loading = probe.ready !== 'complete' ? ' (still loading)' : '';
  const lines = [`Page now: ${clip(probe.href || fallbackUrl, 300)}${title ? ` — "${clip(title, 120)}"` : ''}${heading}${loading}.`];
  if ((probe.passwords ?? 0) > 0 && (outcome.kind === 'done' || outcome.kind === 'condition')) {
    lines.push('It still shows a password field, so the sign-in may not be complete.');
  }
  return lines.join(' ');
}

/** Sentences about what was kept private, or '' when nothing was. */
export function describePrivacy(withheld: { requests: number; messages: number }, scrubbed: number): string {
  const parts: string[] = [];
  if (withheld.requests > 0) parts.push(`the ${withheld.requests === 1 ? 'request' : `${withheld.requests} requests`} it sent ${withheld.requests === 1 ? 'is' : 'are'} listed without URL query, headers or bodies`);
  if (withheld.messages > 0) parts.push(`${withheld.messages === 1 ? 'its console message is' : `its ${withheld.messages} console messages are`} withheld`);
  if (scrubbed > 0) parts.push(`${scrubbed === 1 ? 'a password or code field still on the page was' : `${scrubbed} password or code fields still on the page were`} emptied`);
  if (parts.length === 0) return '';
  const text = parts.join('; ');
  return `While the user had the tab, ${text}.`;
}

// ------------------------------------------------------------------------------------- sign-in pages

const IDP_HOSTS: RegExp[] = [
  /^login\.microsoftonline\.(com|us|de)$/,
  /^login\.(windows|chinacloudapi)\.net$/,
  /^login\.live\.com$/,
  /^accounts\.google\.com$/,
  /\.okta(preview)?\.com$/,
  /\.auth0\.com$/,
  /\.onelogin\.com$/,
  /\.pingone\.(com|eu)$/,
  /\.duosecurity\.com$/,
  /^(login|signin|sso|auth|adfs|sts|idp|keycloak)\./,
];

const IDP_PATHS = /\/(adfs\/ls|oauth2?\/(v2\.0\/)?authorize|protocol\/openid-connect\/auth|saml2?\/(sso|login)|idp\/sso|(log-?in|sign-?in|sso)(\.\w+)?\/?$)/i;

/** Whether a page looks like a place to sign in: a visible password field, an identity provider, or a login path. */
export function looksLikeSignIn(url: string, visiblePasswordFields: number): boolean {
  if (visiblePasswordFields > 0) return true;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  return IDP_HOSTS.some(re => re.test(u.hostname)) || IDP_PATHS.test(u.pathname);
}

export const SIGN_IN_HINT =
  "This looks like a sign-in page. Unless you were given test credentials for it, do not sign in yourself or ask for the user's credentials in chat: hand the tab to the user with browser_request_user_input, with done_when set to what you expect after sign-in.";
/** SIGN_IN_HINT once a session has had it in full. */
export const SIGN_IN_HINT_SHORT = 'This looks like a sign-in page: without test credentials, hand it to the user (browser_request_user_input with done_when).';

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
