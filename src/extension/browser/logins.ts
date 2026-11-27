// What the credential prompts remember, and how they decide, without VS Code: the logins entered in
// this window, which challenges the user declined a moment ago, and whether a challenge is the
// browser saying that the login it was just given is wrong.
//
// A login belongs to a protection space: who asks (site or proxy), its origin, the scheme and the
// realm, the way browsers key their own login cache. The browser only raises a challenge when it has
// nothing to try or what it tried was rejected; a second challenge on a request that was already
// answered is therefore a rejection, and so is any challenge for a space that was answered before in
// this window (the browser would otherwise have used its own cache).
import type { AuthChallenge } from './interception';

export interface Login {
  username: string;
  password: string;
}

/** Where a login came from: typed by the user just now, remembered in this window, or saved across restarts. */
export type LoginOrigin = 'typed' | 'window' | 'saved';

export function loginKey(c: AuthChallenge): string {
  return [c.source, c.origin.toLowerCase(), c.scheme.toLowerCase(), c.realm].join('\u0000');
}

/** "intranet.corp" or "intranet.corp:8080": the origin without scheme and default ports. */
export function displayHost(origin: string): string {
  try {
    const u = new URL(origin);
    return u.host || origin;
  } catch {
    return origin.replace(/^[a-z]+:\/\//i, '');
  }
}

const SCHEME_NAMES: Record<string, string> = { basic: 'Basic', digest: 'Digest', ntlm: 'NTLM', negotiate: 'Negotiate (Kerberos)' };

/** 'the site intranet.corp (realm "Staff", Basic)' / 'the proxy proxy.corp:8080 (realm "Corp", NTLM)' */
export function describeChallenge(c: AuthChallenge): string {
  const scheme = SCHEME_NAMES[c.scheme] ?? c.scheme;
  const details = [c.realm ? `realm "${c.realm}"` : '', scheme].filter(Boolean).join(', ');
  return `the ${c.source === 'Proxy' ? 'proxy' : 'site'} ${displayHost(c.origin)}${details ? ` (${details})` : ''}`;
}

/**
 * Whether this VS Code asks the user for a login itself, with a sign-in dialog over the page, when
 * nothing else answers a site's or proxy's login challenge: 1.148 and later. Before that the browser
 * cancelled every challenge and the page showed its 401. While that dialog waits the navigation
 * stays pending: the tab keeps its blank document and `Page.navigate` gets no answer.
 */
export function vscodeAsksForLogins(version: string): boolean {
  const match = /^(\d+)\.(\d+)/.exec(version);
  if (!match) return false;
  const [major, minor] = [Number(match[1]), Number(match[2])];
  return major > 1 || (major === 1 && minor >= 148);
}

/** True when a password would travel unencrypted: Basic over plain HTTP to another machine. */
export function sentInClear(c: AuthChallenge): boolean {
  if (c.scheme !== 'basic') return false;
  try {
    const u = new URL(c.origin);
    if (u.protocol !== 'http:') return false;
    const host = u.hostname.replace(/^\[|\]$/g, '');
    return !(host === 'localhost' || host === '::1' || /^127\./.test(host));
  } catch {
    return false;
  }
}

export type ChallengeVerdict =
  /** Nothing known: ask the user. `rejected` is set when a login for this space was just refused. */
  | { action: 'ask'; rejected?: { origin: LoginOrigin; username: string } }
  /** Answer with a login remembered earlier, without asking. */
  | { action: 'provide'; login: Login; origin: LoginOrigin }
  /** Do not ask: the user declined a moment ago, or the login entered after a rejection was refused too. */
  | { action: 'refuse'; reason: 'declined' | 'rejected-twice' };

interface Answered {
  key: string;
  /** Logins given to this request so far. */
  tries: number;
  /** The user was already asked again after a rejection on this request: a further rejection stops. */
  reasked: boolean;
}

export class LoginBook {
  private readonly window = new Map<string, { login: Login; origin: LoginOrigin }>();
  /** Spaces answered with a login at least once in this window. */
  private readonly answeredSpaces = new Set<string>();
  private readonly answeredRequests = new Map<string, Answered>();
  private readonly refusedUntil = new Map<string, { until: number; reason: 'declined' | 'rejected-twice' }>();
  /** Last user name per space, to pre-fill the next prompt (never the password). */
  private readonly lastUser = new Map<string, string>();

  /** `refuseMs`: how long a declined or twice-rejected space is not asked again. */
  constructor(
    private readonly refuseMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Decides about a challenge for `key` on request `requestId`. `saved` is the login saved across
   * restarts for the space, if any (looked up by the caller, since that is asynchronous).
   */
  onChallenge(key: string, requestId: string, saved?: Login): ChallengeVerdict {
    const refused = this.refusedUntil.get(key);
    if (refused && refused.until > this.now()) return { action: 'refuse', reason: refused.reason };
    if (refused) this.refusedUntil.delete(key);

    let request = this.answeredRequests.get(requestId);
    if (request && request.key !== key) request = undefined;
    const rejected = (request !== undefined && request.tries > 0) || this.answeredSpaces.has(key);
    if (rejected) {
      // What was tried is wrong: never offer it again.
      const known = this.window.get(key);
      this.window.delete(key);
      this.answeredSpaces.delete(key);
      if (request?.reasked) {
        this.refuse(key, 'rejected-twice');
        return { action: 'refuse', reason: 'rejected-twice' };
      }
      if (request) request.reasked = true;
      else this.track(requestId, { key, tries: 0, reasked: true });
      const username = known?.login.username ?? this.lastUser.get(key) ?? '';
      return { action: 'ask', rejected: { origin: known?.origin ?? 'window', username } };
    }
    const known = this.window.get(key);
    if (known) return { action: 'provide', login: known.login, origin: 'window' };
    if (saved) return { action: 'provide', login: saved, origin: 'saved' };
    return { action: 'ask' };
  }

  /** Records that `login` was given to the browser for `requestId`. */
  provided(key: string, requestId: string, login: Login, origin: LoginOrigin): void {
    const request = this.answeredRequests.get(requestId);
    if (request && request.key === key) request.tries++;
    else this.track(requestId, { key, tries: 1, reasked: false });
    this.answeredSpaces.add(key);
    this.window.set(key, { login, origin: origin === 'typed' ? 'window' : origin });
    this.lastUser.set(key, login.username);
  }

  private track(requestId: string, entry: Answered): void {
    this.answeredRequests.set(requestId, entry);
    if (this.answeredRequests.size > 500) this.answeredRequests.delete(this.answeredRequests.keys().next().value!);
  }

  /** The user declined (or did not answer): do not ask again for a while. */
  refuse(key: string, reason: 'declined' | 'rejected-twice' = 'declined'): void {
    this.refusedUntil.set(key, { until: this.now() + this.refuseMs, reason });
  }

  /** The user name entered last for the space, to pre-fill a prompt. */
  usernameFor(key: string): string | undefined {
    return this.lastUser.get(key);
  }

  /** Forgets every login of this window (or one space), and what was declined. */
  forget(key?: string): void {
    if (key === undefined) {
      this.window.clear();
      this.answeredSpaces.clear();
      this.answeredRequests.clear();
      this.refusedUntil.clear();
      return;
    }
    this.window.delete(key);
    this.answeredSpaces.delete(key);
    this.refusedUntil.delete(key);
  }
}
