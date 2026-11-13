// Which agent sessions the user allowed to use which of their browser tabs. No `vscode` dependency,
// so the rules are unit-tested.
//
// What the user is asked, and how long the answer counts:
//   "Allow"            this session may use this tab until the tab closes or the session ends.
//   "Allow on <site>"  this session may use every user tab while it shows that site (e.g. all
//                      localhost:3000 tabs), until the session ends.
//   "Deny"             this session is refused this tab, without asking again, until the tab closes,
//                      the session ends or the user shares the tab explicitly.
//   dismissed          (notification closed without an answer) refused for a short cool-down, after
//                      which the session may ask again; the user may simply have missed it.

export type ConsentAnswer = 'tab' | 'site' | 'deny' | 'dismissed';

export type ConsentState =
  | { kind: 'allowed'; scope: 'tab' | 'site' }
  | { kind: 'declined' }
  | { kind: 'dismissed'; retryAfterMs: number }
  | { kind: 'unknown' };

interface TabDecision {
  sessionId: string;
  tabId: string;
  decision: 'allow' | 'deny';
}

interface Dismissal {
  sessionId: string;
  tabId: string;
  until: number;
}

export interface ConsentSnapshot {
  tabs: TabDecision[];
  sites: Array<{ sessionId: string; site: string }>;
}

/** The site a URL belongs to, as the user would name it ("localhost:3000", "github.com"). Undefined for about:, data: and the like. */
export function siteOf(url: string): string | undefined {
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.host;
    if (u.protocol === 'file:') return 'local files';
    return undefined;
  } catch {
    return undefined;
  }
}

export interface ConsentStoreOptions {
  /** How long a dismissed prompt keeps the session from asking again. */
  dismissCooldownMs?: number;
  now?: () => number;
}

export class ConsentStore {
  private tabs: TabDecision[] = [];
  private sites: Array<{ sessionId: string; site: string }> = [];
  private dismissals: Dismissal[] = [];
  private readonly cooldownMs: number;
  private readonly now: () => number;

  constructor(options: ConsentStoreOptions = {}) {
    this.cooldownMs = options.dismissCooldownMs ?? 60_000;
    this.now = options.now ?? Date.now;
  }

  /** What the user has said about `sessionId` using `tabId`, which currently shows `url`. */
  check(sessionId: string, tabId: string, url: string): ConsentState {
    const decision = this.tabs.find(d => d.sessionId === sessionId && d.tabId === tabId)?.decision;
    if (decision === 'deny') return { kind: 'declined' };
    if (decision === 'allow') return { kind: 'allowed', scope: 'tab' };
    const site = siteOf(url);
    if (site && this.sites.some(s => s.sessionId === sessionId && s.site === site)) return { kind: 'allowed', scope: 'site' };
    const now = this.now();
    this.dismissals = this.dismissals.filter(d => d.until > now);
    const dismissal = this.dismissals.find(d => d.sessionId === sessionId && d.tabId === tabId);
    if (dismissal) return { kind: 'dismissed', retryAfterMs: dismissal.until - now };
    return { kind: 'unknown' };
  }

  /** Records the user's answer to "may `sessionId` use `tabId` (showing `url`)?". */
  record(sessionId: string, tabId: string, url: string, answer: ConsentAnswer): void {
    this.dismissals = this.dismissals.filter(d => !(d.sessionId === sessionId && d.tabId === tabId));
    if (answer === 'dismissed') {
      this.dismissals.push({ sessionId, tabId, until: this.now() + this.cooldownMs });
      return;
    }
    if (answer === 'site') {
      const site = siteOf(url);
      if (site && !this.sites.some(s => s.sessionId === sessionId && s.site === site)) this.sites.push({ sessionId, site });
      if (site) return;
    }
    this.setTabDecision(sessionId, tabId, answer === 'deny' ? 'deny' : 'allow');
  }

  /** The user shares a tab with a session explicitly (overrides an earlier "Deny"). */
  grant(sessionId: string, tabId: string): void {
    this.dismissals = this.dismissals.filter(d => !(d.sessionId === sessionId && d.tabId === tabId));
    this.setTabDecision(sessionId, tabId, 'allow');
  }

  /** Withdraws what the user allowed or denied: for one session and/or one tab, or everything. Site grants of the session go too. */
  revoke(filter: { sessionId?: string; tabId?: string } = {}): void {
    const match = (d: { sessionId: string; tabId?: string }) =>
      (filter.sessionId === undefined || d.sessionId === filter.sessionId) && (filter.tabId === undefined || d.tabId === filter.tabId);
    this.tabs = this.tabs.filter(d => !match(d));
    this.dismissals = this.dismissals.filter(d => !match(d));
    if (filter.tabId === undefined) this.sites = this.sites.filter(s => filter.sessionId !== undefined && s.sessionId !== filter.sessionId);
  }

  /** Sessions currently allowed to use the tab. */
  allowedSessions(tabId: string, url: string): string[] {
    const site = siteOf(url);
    const ids = new Set<string>();
    for (const d of this.tabs) if (d.tabId === tabId && d.decision === 'allow') ids.add(d.sessionId);
    if (site) for (const s of this.sites) if (s.site === site && !this.tabs.some(d => d.tabId === tabId && d.sessionId === s.sessionId && d.decision === 'deny')) ids.add(s.sessionId);
    return [...ids];
  }

  /** The tab closed: its decisions no longer mean anything. */
  forgetTab(tabId: string): void {
    this.revoke({ tabId });
  }

  forgetSession(sessionId: string): void {
    this.revoke({ sessionId });
  }

  snapshot(): ConsentSnapshot {
    return { tabs: this.tabs.map(d => ({ ...d })), sites: this.sites.map(s => ({ ...s })) };
  }

  restore(snapshot: ConsentSnapshot | undefined): void {
    if (!snapshot) return;
    this.tabs = Array.isArray(snapshot.tabs) ? snapshot.tabs.filter(d => d && typeof d.sessionId === 'string' && typeof d.tabId === 'string' && (d.decision === 'allow' || d.decision === 'deny')) : [];
    this.sites = Array.isArray(snapshot.sites) ? snapshot.sites.filter(s => s && typeof s.sessionId === 'string' && typeof s.site === 'string') : [];
  }

  private setTabDecision(sessionId: string, tabId: string, decision: 'allow' | 'deny'): void {
    const existing = this.tabs.find(d => d.sessionId === sessionId && d.tabId === tabId);
    if (existing) existing.decision = decision;
    else this.tabs.push({ sessionId, tabId, decision });
  }
}
