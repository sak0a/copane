// Who may read or control a tab, and the messages the agent gets when it may not. No `vscode`
// dependency, so the rules are unit-tested. Leases (one controller at a time) are checked by the
// service after this, through `services.tabLeases`.
import type { TabAccess } from '../core/services';
import type { ConsentState } from './consent';

export type UserTabsSetting = 'ask' | 'allow' | 'deny';

export interface AccessInput {
  sessionId: string;
  access: TabAccess;
  tab: { id: string; origin: 'agent' | 'user'; openedBy: string | undefined; paused: boolean };
  /** Whether a session id belongs to a live (connected or within its grace period) session. */
  isLive(sessionId: string): boolean;
  consent: ConsentState;
  setting: UserTabsSetting;
}

export type AccessDecision =
  | { kind: 'ok'; reason: 'own' | 'shared' | 'ended-session' | 'other-session' | 'consented' | 'setting' }
  | { kind: 'paused' }
  | { kind: 'ask' }
  | { kind: 'denied'; why: 'setting' | 'declined' | 'dismissed'; retryAfterMs?: number };

/** How a tab relates to the session asking for it. */
export function relation(tab: Pick<AccessInput['tab'], 'origin' | 'openedBy'>, sessionId: string, isLive: (id: string) => boolean): 'own' | 'other-session' | 'ended-session' | 'user' {
  if (tab.origin === 'user') return 'user';
  if (tab.openedBy === sessionId) return 'own';
  if (tab.openedBy && isLive(tab.openedBy)) return 'other-session';
  return 'ended-session';
}

export function decideAccess(input: AccessInput): AccessDecision {
  const { tab, sessionId } = input;
  if (tab.paused) return { kind: 'paused' };
  const rel = relation(tab, sessionId, input.isLive);
  if (rel !== 'user') return { kind: 'ok', reason: rel };
  // A user tab.
  if (input.consent.kind === 'allowed') return { kind: 'ok', reason: 'consented' };
  if (input.setting === 'allow') return { kind: 'ok', reason: 'setting' };
  if (input.setting === 'deny') return { kind: 'denied', why: 'setting' };
  if (input.consent.kind === 'declined') return { kind: 'denied', why: 'declined' };
  if (input.consent.kind === 'dismissed') return { kind: 'denied', why: 'dismissed', retryAfterMs: input.consent.retryAfterMs };
  return { kind: 'ask' };
}

const SHARE_COMMAND = '"Copane: Share Browser Tab with Agent Session"';

/** The error text for a refused decision, written for the agent. */
export function deniedMessage(decision: Exclude<AccessDecision, { kind: 'ok' } | { kind: 'ask' }>, tabId: string): string {
  if (decision.kind === 'paused') {
    return `The user has paused agent access to ${tabId}: they are using it themselves. Do not retry in a loop. Work on something else, or tell the user in chat what you need the tab for and wait until they resume it (from the tab's indicator or the Sessions view).`;
  }
  switch (decision.why) {
    case 'setting':
      return `The user's settings do not allow agents to use browser tabs the user opened (copane.browser.userTabs = "deny"), so ${tabId} is off limits. Open your own tab with browser_open instead.`;
    case 'declined':
      return `The user declined to let you use ${tabId}. Do not ask again or retry. Open your own tab with browser_open, or explain in chat why you need this one; the user can share it with the command ${SHARE_COMMAND}.`;
    case 'dismissed': {
      const seconds = Math.max(1, Math.ceil((decision.retryAfterMs ?? 0) / 1000));
      return `The user closed the request to use ${tabId} without answering. Do not retry right away: open your own tab with browser_open, or ask the user in chat first (you may ask the browser again in ${seconds} s).`;
    }
  }
}

/** The text of the consent prompt and its buttons. */
export function consentPrompt(sessionName: string, tab: { title: string; url: string }, site: string | undefined): { message: string; choices: string[]; allowTab: string; allowSite: string | undefined; deny: string } {
  const title = pageTitle(tab.title, tab.url);
  const name = title ? `"${truncate(title, 50)}" (${site ?? truncate(tab.url, 60)})` : `"${site ?? truncate(tab.url, 60)}"`;
  const allowTab = 'Allow';
  const allowSite = site ? `Allow on ${truncate(site, 30)}` : undefined;
  const deny = 'Deny';
  return {
    message: `${sessionName} wants to use your browser tab ${name}: read the page and act in it.`,
    choices: allowSite ? [allowTab, allowSite, deny] : [allowTab, deny],
    allowTab,
    allowSite,
    deny,
  };
}

/**
 * The page title of a tab. The proposed API reports the editor's long title, "<page title> (<url
 * without query>)", or the URL itself before the page has a title; this returns just the page title,
 * or '' when there is none.
 */
export function pageTitle(title: string, url: string): string {
  const bare = url.replace(/[?#].*$/, '');
  let t = title.trim();
  for (const suffix of [` (${bare})`, ` (${url})`]) if (t.endsWith(suffix)) t = t.slice(0, -suffix.length);
  return t === url || t === bare ? '' : t;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** "12 s", "3 min" */
export function formatAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 90 ? `${s} s` : `${Math.round(s / 60)} min`;
}
