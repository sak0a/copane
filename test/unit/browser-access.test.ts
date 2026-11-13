import { describe, expect, it } from 'vitest';
import { consentPrompt, decideAccess, deniedMessage, formatAge, pageTitle, relation, type AccessInput } from '../../src/extension/browser/access';
import { ConsentStore, siteOf } from '../../src/extension/browser/consent';

const live = new Set(['s1', 's2']);
const isLive = (id: string) => live.has(id);

function input(overrides: Omit<Partial<AccessInput>, 'tab'> & { tab?: Partial<AccessInput['tab']> } = {}): AccessInput {
  return {
    sessionId: 's1',
    access: 'control',
    isLive,
    consent: { kind: 'unknown' },
    setting: 'ask',
    ...overrides,
    tab: { id: 'tab-1', origin: 'user', openedBy: undefined, paused: false, ...overrides.tab },
  };
}

describe('relation', () => {
  it('tells own, other live, ended and user tabs apart', () => {
    expect(relation({ origin: 'agent', openedBy: 's1' }, 's1', isLive)).toBe('own');
    expect(relation({ origin: 'agent', openedBy: 's2' }, 's1', isLive)).toBe('other-session');
    expect(relation({ origin: 'agent', openedBy: 'gone' }, 's1', isLive)).toBe('ended-session');
    expect(relation({ origin: 'agent', openedBy: undefined }, 's1', isLive)).toBe('ended-session');
    expect(relation({ origin: 'user', openedBy: undefined }, 's1', isLive)).toBe('user');
  });
});

describe('decideAccess', () => {
  it('lets a session use its own, other sessions\' and ended sessions\' tabs without consent', () => {
    for (const openedBy of ['s1', 's2', 'gone']) {
      expect(decideAccess(input({ tab: { origin: 'agent', openedBy } })).kind).toBe('ok');
    }
  });

  it('asks for a user tab under the default setting', () => {
    expect(decideAccess(input())).toEqual({ kind: 'ask' });
  });

  it('follows the setting for user tabs', () => {
    expect(decideAccess(input({ setting: 'allow' }))).toEqual({ kind: 'ok', reason: 'setting' });
    expect(decideAccess(input({ setting: 'deny' }))).toEqual({ kind: 'denied', why: 'setting' });
  });

  it('uses remembered answers', () => {
    expect(decideAccess(input({ consent: { kind: 'allowed', scope: 'tab' } })).kind).toBe('ok');
    expect(decideAccess(input({ consent: { kind: 'declined' } }))).toEqual({ kind: 'denied', why: 'declined' });
    expect(decideAccess(input({ consent: { kind: 'dismissed', retryAfterMs: 5000 } }))).toEqual({ kind: 'denied', why: 'dismissed', retryAfterMs: 5000 });
  });

  it('refuses everything, own tabs included, while the user has paused the tab', () => {
    expect(decideAccess(input({ tab: { origin: 'agent', openedBy: 's1', paused: true } }))).toEqual({ kind: 'paused' });
    expect(decideAccess(input({ access: 'read', tab: { paused: true }, setting: 'allow' }))).toEqual({ kind: 'paused' });
  });
});

describe('messages', () => {
  it('tell the agent not to retry in a loop', () => {
    expect(deniedMessage({ kind: 'paused' }, 'tab-2')).toMatch(/tab-2.*Do not retry in a loop/s);
    expect(deniedMessage({ kind: 'denied', why: 'declined' }, 'tab-2')).toMatch(/Do not ask again/);
    expect(deniedMessage({ kind: 'denied', why: 'setting' }, 'tab-2')).toMatch(/browser_open/);
    expect(deniedMessage({ kind: 'denied', why: 'dismissed', retryAfterMs: 42_100 }, 'tab-2')).toMatch(/in 43 s/);
  });

  it('builds a prompt naming the session, the page and the site', () => {
    const p = consentPrompt('Claude 2 · checkout', { title: 'Shop (http://localhost:3000/cart)', url: 'http://localhost:3000/cart?x=1' }, 'localhost:3000');
    expect(p.message).toBe('Claude 2 · checkout wants to use your browser tab "Shop" (localhost:3000): read the page and act in it.');
    expect(p.choices).toEqual(['Allow', 'Allow on localhost:3000', 'Deny']);
    const blank = consentPrompt('Claude 1', { title: 'about:blank', url: 'about:blank' }, undefined);
    expect(blank.choices).toEqual(['Allow', 'Deny']);
    expect(blank.allowSite).toBeUndefined();
  });

  it('formats ages', () => {
    expect(formatAge(12_400)).toBe('12 s');
    expect(formatAge(5 * 60_000)).toBe('5 min');
  });
});

describe('pageTitle', () => {
  it('strips the URL VS Code appends to the title', () => {
    expect(pageTitle('Shop (http://localhost:3000/cart)', 'http://localhost:3000/cart?x=1#y')).toBe('Shop');
    expect(pageTitle('Shop', 'http://localhost:3000/')).toBe('Shop');
  });

  it('returns nothing when the title is only the URL', () => {
    expect(pageTitle('http://localhost:3000/', 'http://localhost:3000/')).toBe('');
    expect(pageTitle('http://localhost:3000/a', 'http://localhost:3000/a?b')).toBe('');
  });
});

describe('ConsentStore', () => {
  it('remembers "Allow" per tab and session', () => {
    const c = new ConsentStore();
    c.record('s1', 'tab-1', 'http://a.test/', 'tab');
    expect(c.check('s1', 'tab-1', 'http://other.test/')).toEqual({ kind: 'allowed', scope: 'tab' });
    expect(c.check('s2', 'tab-1', 'http://a.test/')).toEqual({ kind: 'unknown' });
    expect(c.check('s1', 'tab-2', 'http://a.test/')).toEqual({ kind: 'unknown' });
    expect(c.allowedSessions('tab-1', 'http://a.test/')).toEqual(['s1']);
  });

  it('remembers "Allow on site" for every tab of the session showing that site', () => {
    const c = new ConsentStore();
    c.record('s1', 'tab-1', 'http://localhost:3000/a', 'site');
    expect(c.check('s1', 'tab-9', 'http://localhost:3000/b')).toEqual({ kind: 'allowed', scope: 'site' });
    expect(c.check('s1', 'tab-9', 'http://localhost:4000/b')).toEqual({ kind: 'unknown' });
    expect(c.allowedSessions('tab-9', 'http://localhost:3000/')).toEqual(['s1']);
  });

  it('treats "Allow on site" without a site as "Allow"', () => {
    const c = new ConsentStore();
    c.record('s1', 'tab-1', 'about:blank', 'site');
    expect(c.check('s1', 'tab-1', 'about:blank')).toEqual({ kind: 'allowed', scope: 'tab' });
  });

  it('keeps "Deny" until the tab is shared explicitly, and it wins over a site grant', () => {
    const c = new ConsentStore();
    c.record('s1', 'tab-1', 'http://a.test/', 'site');
    c.record('s1', 'tab-2', 'http://a.test/', 'deny');
    expect(c.check('s1', 'tab-2', 'http://a.test/')).toEqual({ kind: 'declined' });
    expect(c.allowedSessions('tab-2', 'http://a.test/')).toEqual([]);
    c.grant('s1', 'tab-2');
    expect(c.check('s1', 'tab-2', 'http://a.test/').kind).toBe('allowed');
  });

  it('cools down after a dismissed prompt, then asks again', () => {
    let now = 1000;
    const c = new ConsentStore({ dismissCooldownMs: 60_000, now: () => now });
    c.record('s1', 'tab-1', 'http://a.test/', 'dismissed');
    expect(c.check('s1', 'tab-1', 'http://a.test/')).toEqual({ kind: 'dismissed', retryAfterMs: 60_000 });
    now += 60_000;
    expect(c.check('s1', 'tab-1', 'http://a.test/')).toEqual({ kind: 'unknown' });
  });

  it('forgets a closed tab and an ended session', () => {
    const c = new ConsentStore();
    c.record('s1', 'tab-1', 'http://a.test/', 'tab');
    c.record('s2', 'tab-1', 'http://a.test/', 'tab');
    c.record('s2', 'tab-3', 'http://b.test/', 'site');
    c.forgetTab('tab-1');
    expect(c.check('s1', 'tab-1', 'http://a.test/').kind).toBe('unknown');
    expect(c.check('s2', 'tab-4', 'http://b.test/').kind).toBe('allowed');
    c.forgetSession('s2');
    expect(c.check('s2', 'tab-4', 'http://b.test/').kind).toBe('unknown');
  });

  it('revokes everything, and survives a snapshot round trip', () => {
    const c = new ConsentStore();
    c.record('s1', 'tab-1', 'http://a.test/', 'tab');
    c.record('s1', 'tab-2', 'http://b.test/', 'site');
    c.record('s2', 'tab-3', 'http://b.test/', 'deny');
    const copy = new ConsentStore();
    copy.restore(JSON.parse(JSON.stringify(c.snapshot())));
    expect(copy.check('s1', 'tab-1', 'http://a.test/').kind).toBe('allowed');
    expect(copy.check('s1', 'tab-7', 'http://b.test/').kind).toBe('allowed');
    expect(copy.check('s2', 'tab-3', 'http://b.test/').kind).toBe('declined');
    copy.revoke();
    expect(copy.snapshot()).toEqual({ tabs: [], sites: [] });
    copy.restore({ tabs: [{ junk: true } as any], sites: 'nope' as any });
    expect(copy.snapshot()).toEqual({ tabs: [], sites: [] });
  });

  it('names sites the way a user would', () => {
    expect(siteOf('http://localhost:3000/x')).toBe('localhost:3000');
    expect(siteOf('https://github.com/a/b')).toBe('github.com');
    expect(siteOf('file:///tmp/a.html')).toBe('local files');
    expect(siteOf('about:blank')).toBeUndefined();
    expect(siteOf('not a url')).toBeUndefined();
  });
});
