import { describe, expect, it } from 'vitest';
import type { AuthChallenge } from '../../src/extension/browser/interception';
import { describeChallenge, displayHost, LoginBook, loginKey, sentInClear, vscodeAsksForLogins } from '../../src/extension/browser/logins';

const site: AuthChallenge = { source: 'Server', origin: 'http://intranet.corp:80', scheme: 'basic', realm: 'Staff' };
const proxy: AuthChallenge = { source: 'Proxy', origin: 'http://proxy.corp:8080', scheme: 'ntlm', realm: '' };
const alice = { username: 'alice', password: 'pw1' };
const bob = { username: 'bob', password: 'pw2' };

describe('login spaces', () => {
  it('knows from which VS Code on the browser asks for logins itself', () => {
    for (const v of ['1.148.0', '1.148.2', '1.149.0-insider', '1.200.0', '2.0.0']) expect(vscodeAsksForLogins(v), v).toBe(true);
    for (const v of ['1.147.0', '1.147.9', '1.140.0', '1.99.3', '', 'unknown']) expect(vscodeAsksForLogins(v), v).toBe(false);
  });

  it('keys by who asks, origin, scheme and realm', () => {
    expect(loginKey(site)).not.toBe(loginKey({ ...site, realm: 'Other' }));
    expect(loginKey(site)).not.toBe(loginKey({ ...site, source: 'Proxy' }));
    expect(loginKey(site)).toBe(loginKey({ ...site, origin: 'HTTP://INTRANET.CORP:80', scheme: 'Basic' }));
  });

  it('describes the site or proxy in plain words', () => {
    expect(describeChallenge(site)).toBe('the site intranet.corp (realm "Staff", Basic)');
    expect(describeChallenge(proxy)).toBe('the proxy proxy.corp:8080 (NTLM)');
    expect(displayHost('https://a.b:8443')).toBe('a.b:8443');
  });

  it('warns about Basic over plain HTTP, except to this machine', () => {
    expect(sentInClear(site)).toBe(true);
    expect(sentInClear({ ...site, origin: 'https://intranet.corp:443' })).toBe(false);
    expect(sentInClear({ ...site, scheme: 'digest' })).toBe(false);
    expect(sentInClear({ ...site, origin: 'http://127.0.0.1:3000' })).toBe(false);
    expect(sentInClear({ ...site, origin: 'http://localhost:3000' })).toBe(false);
  });
});

describe('LoginBook', () => {
  const key = loginKey(site);

  it('asks first, then reuses the login in the window without asking', () => {
    const book = new LoginBook();
    expect(book.onChallenge(key, 'r1')).toEqual({ action: 'ask' });
    book.provided(key, 'r1', alice, 'typed');
    // A new page load: the browser would normally use its own cache; if it asks, it is a rejection (see below).
    // A different window after reload starts empty and uses the saved login instead:
    const fresh = new LoginBook();
    expect(fresh.onChallenge(key, 'r9', alice)).toEqual({ action: 'provide', login: alice, origin: 'saved' });
  });

  it('treats a second challenge on an answered request as a rejection and re-asks once', () => {
    const book = new LoginBook();
    expect(book.onChallenge(key, 'r1').action).toBe('ask');
    book.provided(key, 'r1', alice, 'typed');
    expect(book.onChallenge(key, 'r1')).toEqual({ action: 'ask', rejected: { origin: 'window', username: 'alice' } });
    book.provided(key, 'r1', bob, 'typed');
    expect(book.onChallenge(key, 'r1')).toEqual({ action: 'refuse', reason: 'rejected-twice' });
    // ... and the space is left alone for a while, even for new requests.
    expect(book.onChallenge(key, 'r2')).toEqual({ action: 'refuse', reason: 'rejected-twice' });
  });

  it('re-asks when a saved login is rejected, telling where it came from', () => {
    const book = new LoginBook();
    const first = book.onChallenge(key, 'r1', alice);
    expect(first).toEqual({ action: 'provide', login: alice, origin: 'saved' });
    book.provided(key, 'r1', alice, 'saved');
    expect(book.onChallenge(key, 'r1', alice)).toEqual({ action: 'ask', rejected: { origin: 'saved', username: 'alice' } });
  });

  it('counts a challenge for an answered space on another request as a rejection', () => {
    const book = new LoginBook();
    book.onChallenge(key, 'r1');
    book.provided(key, 'r1', alice, 'typed');
    expect(book.onChallenge(key, 'r2')).toEqual({ action: 'ask', rejected: { origin: 'window', username: 'alice' } });
    book.provided(key, 'r2', bob, 'typed');
    expect(book.onChallenge(key, 'r2').action).toBe('refuse');
  });

  it('does not ask again for a declined space until the refusal expires', () => {
    let now = 1000;
    const book = new LoginBook(60_000, () => now);
    book.refuse(key);
    expect(book.onChallenge(key, 'r1')).toEqual({ action: 'refuse', reason: 'declined' });
    expect(book.onChallenge(loginKey({ ...site, realm: 'Other' }), 'r1').action).toBe('ask');
    now += 60_001;
    expect(book.onChallenge(key, 'r2').action).toBe('ask');
  });

  it('remembers the user name for the next prompt, and forgets everything on request', () => {
    const book = new LoginBook();
    book.provided(key, 'r1', alice, 'typed');
    expect(book.usernameFor(key)).toBe('alice');
    book.refuse(loginKey(proxy));
    book.forget();
    expect(book.onChallenge(key, 'r5')).toEqual({ action: 'ask' });
    expect(book.onChallenge(loginKey(proxy), 'r5')).toEqual({ action: 'ask' });
  });
});
