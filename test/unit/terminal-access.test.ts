import { describe, expect, it } from 'vitest';
import { decideAccess, matchPersisted, parsePolicy, parseSessionEndPolicy, type AccessSubject } from '../../src/extension/terminal/access';

const subject = (over: Partial<AccessSubject>): AccessSubject => ({ origin: 'agent', ownerKey: 's1', ownerAlive: true, granted: new Set(), refusedUntil: new Map(), ...over });

describe('decideAccess', () => {
  it('lets a session use its own terminals and those of ended sessions', () => {
    expect(decideAccess(subject({}), 's1', 'ask', 0).kind).toBe('allowed');
    expect(decideAccess(subject({ ownerAlive: false }), 's2', 'deny', 0).kind).toBe('allowed');
  });

  it("asks before a session uses another live session's terminal", () => {
    expect(decideAccess(subject({}), 's2', 'allow', 0)).toEqual({ kind: 'ask', reason: 'other-session' });
    expect(decideAccess(subject({ granted: new Set(['s2']) }), 's2', 'ask', 0).kind).toBe('allowed');
  });

  it("follows the setting for the user's terminals", () => {
    const user = subject({ origin: 'user', ownerKey: undefined, ownerAlive: false });
    expect(decideAccess(user, 's1', 'ask', 0)).toEqual({ kind: 'ask', reason: 'user-terminal' });
    expect(decideAccess(user, 's1', 'allow', 0).kind).toBe('allowed');
    expect(decideAccess(user, 's1', 'deny', 0)).toEqual({ kind: 'denied', reason: 'policy' });
    expect(decideAccess({ ...user, granted: new Set(['s1']) }, 's1', 'deny', 0).kind).toBe('denied');
  });

  it('does not ask again right after a refusal', () => {
    const user = subject({ origin: 'user', ownerKey: undefined, refusedUntil: new Map([['s1', 1000]]) });
    expect(decideAccess(user, 's1', 'ask', 500)).toEqual({ kind: 'denied', reason: 'refused' });
    expect(decideAccess(user, 's1', 'ask', 1500).kind).toBe('ask');
  });

  it('parses settings defensively', () => {
    expect(parsePolicy('allow')).toBe('allow');
    expect(parsePolicy('nonsense')).toBe('ask');
    expect(parseSessionEndPolicy(undefined)).toBe('keep');
    expect(parseSessionEndPolicy('closeIdle')).toBe('closeIdle');
  });
});

describe('matchPersisted', () => {
  const records = [
    { id: 'term-1', pid: 100, name: 'Claude 1', ownerKey: 'a', createdAt: 0 },
    { id: 'term-2', pid: 200, name: 'Claude 2', ownerKey: 'b', createdAt: 0 },
    { id: 'term-3', pid: 300, name: 'Claude 2', ownerKey: 'b', createdAt: 0 },
  ];
  it('matches by process id first', () => {
    expect(matchPersisted(records, new Set(), 300, 'Claude 2')?.id).toBe('term-3');
  });
  it('falls back to a unique name, never to an ambiguous one', () => {
    expect(matchPersisted(records, new Set(), 999, 'Claude 1')?.id).toBe('term-1');
    expect(matchPersisted(records, new Set(), 999, 'Claude 2')).toBeUndefined();
    expect(matchPersisted(records, new Set(['term-2']), 999, 'Claude 2')?.id).toBe('term-3');
    expect(matchPersisted(records, new Set(), 999, 'zsh')).toBeUndefined();
  });
});
