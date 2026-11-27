import { afterEach, describe, expect, it, vi } from 'vitest';
import { AWAY_SETTLE_MS, normalizeSessionName, RESTORE_GRACE_MS, SessionManager, sessionDisplayName, type RememberedSession, type SessionChange, type SessionMemory } from '../../src/extension/core/sessions';

const claude = { name: 'claude-code', kind: 'claude-code' as const };

/** One window's workspace state, shared by the extension hosts before and after a reload. */
function store(): SessionMemory & { list: RememberedSession[] } {
  const s = {
    list: [] as RememberedSession[],
    load: () => s.list,
    save: (list: RememberedSession[]) => {
      s.list = JSON.parse(JSON.stringify(list));
    },
  };
  return s;
}

describe('SessionManager memory across window reloads', () => {
  it('gives sessions their label, color and title back whatever order they reconnect in', () => {
    const memory = store();
    let now = 1_000_000;
    const before = new SessionManager({ memory, now: () => now });
    const a = before.connect({ sessionKey: 'a', client: claude });
    const b = before.connect({ sessionKey: 'b', client: claude });
    before.setTitle('b', 'dev server');
    expect([a.label, b.label, b.autoLabel]).toEqual(['Claude 1', 'dev server', 'Claude 2']);
    before.dispose(); // the reload: the extension host goes away without disconnecting anyone

    now += 5_000;
    const after = new SessionManager({ memory, now: () => now });
    // Restored, waiting for their agents: their numbers are not handed to anyone else meanwhile.
    expect(after.list().map(s => [s.label, s.connected])).toEqual([
      ['Claude 1', false],
      ['dev server', false],
    ]);
    const newcomer = after.connect({ sessionKey: 'c', client: claude });
    expect(newcomer.label).toBe('Claude 3');
    const b2 = after.connect({ sessionKey: 'b', client: claude });
    const a2 = after.connect({ sessionKey: 'a', client: claude });
    expect([a2.label, a2.color.id, b2.autoLabel, b2.color.id, b2.label, b2.titleBy]).toEqual(['Claude 1', a.color.id, 'Claude 2', b.color.id, 'dev server', 'agent']);
    expect(b2.connected).toBe(true);
    after.dispose();
  });

  it('ends restored sessions whose agent does not come back', async () => {
    const memory = store();
    const before = new SessionManager({ memory, graceMs: () => 5 });
    before.connect({ sessionKey: 'a', client: claude });
    before.dispose();
    const after = new SessionManager({ memory, graceMs: () => 5 });
    expect(after.get('a')?.connected).toBe(false);
    expect(RESTORE_GRACE_MS).toBeGreaterThanOrEqual(5);
    after.dispose();
  });

  it('does not restore sessions of a window closed long ago, but gives a returning one its number when free', () => {
    const memory = store();
    let now = 1_000_000;
    const before = new SessionManager({ memory, now: () => now });
    before.connect({ sessionKey: 'a', client: claude });
    const b = before.connect({ sessionKey: 'b', client: claude });
    before.dispose();
    now += 60 * 60_000;
    const after = new SessionManager({ memory, now: () => now });
    expect(after.list()).toEqual([]);
    const b2 = after.connect({ sessionKey: 'b', client: claude });
    expect([b2.label, b2.color.id]).toEqual(['Claude 2', b.color.id]);
    after.dispose();
  });

  it('gives a late returner a new number but its color when its number was taken meanwhile', () => {
    const memory = store();
    const m = new SessionManager({ memory, graceMs: () => 0 });
    const a = m.connect({ sessionKey: 'a', client: claude });
    m.disconnect('a'); // ended
    const other = m.connect({ sessionKey: 'x', client: claude });
    expect(other.label).toBe('Claude 1');
    const back = m.connect({ sessionKey: 'a', client: claude });
    expect([back.label, back.color.id]).toEqual(['Claude 2', a.color.id]);
    m.dispose();
  });

  it('survives a corrupt memory', () => {
    const memory = { load: () => [null, { id: 3 }] as unknown as RememberedSession[], save: () => undefined };
    const m = new SessionManager({ memory });
    expect(m.connect({ sessionKey: 'a', client: claude }).label).toBe('Claude 1');
    m.dispose();
  });
});

describe('away sessions: restored sessions that still own tabs or terminals', () => {
  afterEach(() => vi.useRealTimers());

  /** A window with sessions "a" and "b" connected, then gone without a goodbye (a reload or restart). */
  function reloaded(options: { closedForMs?: number } = {}) {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const memory = store();
    const before = new SessionManager({ memory });
    const a = before.connect({ sessionKey: 'a', client: claude });
    before.connect({ sessionKey: 'b', client: claude });
    before.setTitle('a', 'dev server');
    before.dispose();
    vi.setSystemTime(1_000_000 + (options.closedForMs ?? 5_000));
    const owned = new Set(['a']);
    const changes: string[] = [];
    const after = new SessionManager({ memory, holds: id => owned.has(id) });
    after.onDidChange((c: SessionChange) => changes.push(`${c.type} ${c.session.autoLabel}${c.session.away ? ' away' : ''}`));
    return { memory, after, owned, changes, colorOfA: a.color.id };
  }
  const states = (m: SessionManager) => m.list().map(s => `${s.autoLabel}${s.connected ? ' connected' : s.away ? ' away' : ' disconnected'}`);

  it('keeps a restored session whose agent has not come back, for as long as it owns something', () => {
    const { after, owned, changes } = reloaded();
    expect(states(after)).toEqual(['Claude 1 disconnected', 'Claude 2 disconnected']);
    // The grace period is over. What they own may still be turning up (terminals are revived one
    // by one), so neither is ended yet.
    vi.advanceTimersByTime(RESTORE_GRACE_MS + 100);
    expect(states(after)).toEqual(['Claude 1 away', 'Claude 2 away']);
    // The window has settled: the one that owns nothing ends, the other stays, with no time limit.
    vi.advanceTimersByTime(AWAY_SETTLE_MS);
    expect(states(after)).toEqual(['Claude 1 away']);
    vi.advanceTimersByTime(24 * 60 * 60_000);
    expect(states(after)).toEqual(['Claude 1 away']);
    expect(after.connect({ sessionKey: 'new', client: claude }).label, 'its number stays its own').toBe('Claude 2');
    // The user closed its last tab or terminal.
    owned.clear();
    after.reviewAway();
    expect(states(after)).toEqual(['Claude 2 connected']);
    expect(changes).toEqual(['updated Claude 1 away', 'updated Claude 2 away', 'removed Claude 2', 'added Claude 2', 'removed Claude 1']);
    after.dispose();
  });

  it('gives an away session back to its agent, and then treats it like any session of this run', () => {
    const { after, colorOfA } = reloaded();
    vi.advanceTimersByTime(RESTORE_GRACE_MS + AWAY_SETTLE_MS);
    const back = after.connect({ sessionKey: 'a', client: claude });
    expect([back.autoLabel, back.label, back.color.id, back.connected, back.away]).toEqual(['Claude 1', 'dev server', colorOfA, true, undefined]);
    // Its agent exits: the session ends after the usual grace period, whatever it still owns.
    after.disconnect('a');
    vi.advanceTimersByTime(20_100);
    expect(after.list()).toEqual([]);
    after.dispose();
  });

  it('brings sessions of a window closed for long back away at once, and those that were away', () => {
    const { memory, after, owned } = reloaded({ closedForMs: 3 * 24 * 60 * 60_000 });
    // No agent is about to reconnect after days: not shown as reconnecting first.
    expect(states(after)).toEqual(['Claude 1 away', 'Claude 2 away']);
    vi.advanceTimersByTime(AWAY_SETTLE_MS + 100);
    expect(states(after)).toEqual(['Claude 1 away']);
    after.dispose();

    // The next start, moments later: still away, not "reconnecting" for a grace period.
    vi.advanceTimersByTime(5_000);
    const again = new SessionManager({ memory, holds: id => owned.has(id) });
    expect(states(again)).toEqual(['Claude 1 away']);
    again.dispose();
  });

  it('does not end an away session for owning nothing while the window is still starting', () => {
    const { after, owned } = reloaded({ closedForMs: 60 * 60_000 });
    owned.clear();
    after.reviewAway(); // a tab or terminal changed, seconds after the start
    expect(states(after)).toEqual(['Claude 1 away', 'Claude 2 away']);
    owned.add('b'); // its terminal was revived
    vi.advanceTimersByTime(AWAY_SETTLE_MS + 100);
    expect(states(after)).toEqual(['Claude 2 away']);
    after.dispose();
  });

  it('ends an away session when the user ends it, and never keeps one without `holds` or with no grace period', () => {
    const { memory, after } = reloaded();
    vi.advanceTimersByTime(RESTORE_GRACE_MS + AWAY_SETTLE_MS);
    after.remove('a');
    expect(after.list()).toEqual([]);
    after.dispose();

    const plain = new SessionManager({ memory: { load: () => [{ id: 'z', client: claude, number: 1, colorId: 'blue', createdAt: 1, seenAt: Date.now(), live: true }], save: () => undefined } });
    vi.advanceTimersByTime(RESTORE_GRACE_MS + 100);
    expect(plain.list()).toEqual([]);
    plain.dispose();
    const noGrace = new SessionManager({ memory, graceMs: () => 0, holds: () => true });
    expect(noGrace.list()).toEqual([]);
    noGrace.dispose();
  });
});

describe('session names', () => {
  const codex = { name: 'codex-mcp-client', kind: 'codex' as const };

  it('shows a name instead of the automatic label, and the automatic label again without one', () => {
    const m = new SessionManager();
    const a = m.connect({ sessionKey: 'a', client: claude });
    const changes: string[] = [];
    m.onDidChange(c => changes.push(`${c.type} ${c.session.label}`));
    expect(m.setTitle('a', '  checkout\n tests ')).toBeUndefined();
    expect([a.label, a.autoLabel, a.title, a.titleBy, a.badge]).toEqual(['checkout tests', 'Claude 1', 'checkout tests', 'agent', 'C1']);
    expect(sessionDisplayName(a)).toBe('checkout tests (Claude 1)');
    m.setTitle('a', 'checkout tests'); // unchanged: no event
    m.setTitle('a', 'claude 1'); // its own automatic label: no name
    expect([a.label, a.title, a.titleBy]).toEqual(['Claude 1', undefined, undefined]);
    expect(sessionDisplayName(a)).toBe('Claude 1');
    m.setTitle('a', 'deploy');
    m.setTitle('a', '');
    expect(a.label).toBe('Claude 1');
    expect(changes).toEqual(['updated checkout tests', 'updated Claude 1', 'updated deploy', 'updated Claude 1']);
    m.dispose();
  });

  it('keeps the name the user gave: the agent cannot change or clear it, the user can', () => {
    const m = new SessionManager();
    const a = m.connect({ sessionKey: 'a', client: claude });
    m.setTitle('a', 'tests');
    expect(m.setTitle('a', 'OpenShift Pod Disruption Inspection', 'user')).toBeUndefined();
    expect([a.label, a.titleBy]).toEqual(['OpenShift Pod Disruption Inspection', 'user']);
    expect(m.setTitle('a', 'something else')).toEqual({ reason: 'named-by-user', name: 'OpenShift Pod Disruption Inspection' });
    expect(m.setTitle('a', '')).toEqual({ reason: 'named-by-user', name: 'OpenShift Pod Disruption Inspection' });
    expect(a.label).toBe('OpenShift Pod Disruption Inspection');
    // The agent's own name, taken over by the user, is the user's from then on.
    m.setTitle('a', 'PDB check', 'user');
    m.setTitle('a', '', 'user');
    expect([a.label, a.titleBy]).toEqual(['Claude 1', undefined]);
    expect(m.setTitle('a', 'tests')).toBeUndefined();
    expect([a.label, a.titleBy]).toEqual(['tests', 'agent']);
    m.setTitle('a', 'tests', 'user');
    expect(a.titleBy).toBe('user');
    m.dispose();
  });

  it('keeps names unique in the window and never like another session\'s automatic label', () => {
    const m = new SessionManager();
    m.connect({ sessionKey: 'a', client: claude });
    const b = m.connect({ sessionKey: 'b', client: claude });
    m.connect({ sessionKey: 'c', client: codex });
    m.setTitle('a', 'Tests');
    expect(m.setTitle('b', 'tests')).toMatchObject({ reason: 'taken', by: { id: 'a' } });
    m.setTitle('c', 'api');
    expect(m.setTitle('b', 'API', 'user')).toMatchObject({ reason: 'taken', by: { id: 'c' } });
    for (const name of ['Claude 1', 'claude  7', 'Codex 1', 'Copilot 3', 'Agent 2']) expect(m.setTitle('b', name, 'user'), name).toEqual({ reason: 'automatic' });
    expect(b.label).toBe('Claude 2');
    expect(m.setTitle('b', 'Claude 2 tests')).toBeUndefined();
    expect(b.label).toBe('Claude 2 tests');
    m.dispose();
  });

  it('makes names one line, without control characters or direction overrides, of at most 60 characters', () => {
    expect(normalizeSessionName('a\tb\r\nc\u0007d')).toBe('a b c d');
    expect(normalizeSessionName('safe\u202Etxt.exe\u202C')).toBe('safetxt.exe');
    expect(normalizeSessionName('   ')).toBeUndefined();
    expect(normalizeSessionName('x'.repeat(80))).toHaveLength(60);
    expect(normalizeSessionName('👩‍💻 dev')).toBe('👩‍💻 dev');
  });

  it('remembers who gave a name across a reload, and drops a remembered name another session took meanwhile', () => {
    const memory = store();
    let now = 1_000_000;
    const before = new SessionManager({ memory, now: () => now });
    before.connect({ sessionKey: 'a', client: claude });
    before.connect({ sessionKey: 'b', client: claude });
    before.setTitle('a', 'PDB check', 'user');
    before.setTitle('b', 'api tests');
    before.dispose();

    now += 5_000;
    const after = new SessionManager({ memory, now: () => now });
    expect(after.list().map(s => [s.label, s.titleBy])).toEqual([
      ['PDB check', 'user'],
      ['api tests', 'agent'],
    ]);
    expect(after.setTitle('a', 'mine now')).toEqual({ reason: 'named-by-user', name: 'PDB check' });
    after.remove('b'); // ended, its name remembered
    after.setTitle('a', 'api tests', 'user');
    const back = after.connect({ sessionKey: 'b', client: claude });
    expect([back.label, back.title]).toEqual(['Claude 2', undefined]);
    after.dispose();
  });

  it('does not restore a name that reads like an automatic label (titles of older versions)', () => {
    const remembered: RememberedSession[] = [{ id: 'z', client: claude, number: 2, colorId: 'blue', title: 'Claude 5', createdAt: 1, seenAt: 1_000_000, live: true }];
    const m = new SessionManager({ memory: { load: () => remembered, save: () => undefined }, now: () => 1_000_100 });
    expect(m.get('z')?.label).toBe('Claude 2');
    m.dispose();
  });
});
