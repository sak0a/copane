import { describe, expect, it } from 'vitest';
import { RESTORE_GRACE_MS, SessionManager, type RememberedSession, type SessionMemory } from '../../src/extension/core/sessions';

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
    expect([a.label, b.label]).toEqual(['Claude 1', 'Claude 2']);
    before.dispose(); // the reload: the extension host goes away without disconnecting anyone

    now += 5_000;
    const after = new SessionManager({ memory, now: () => now });
    // Restored, waiting for their agents: their numbers are not handed to anyone else meanwhile.
    expect(after.list().map(s => [s.label, s.connected])).toEqual([
      ['Claude 1', false],
      ['Claude 2', false],
    ]);
    const newcomer = after.connect({ sessionKey: 'c', client: claude });
    expect(newcomer.label).toBe('Claude 3');
    const b2 = after.connect({ sessionKey: 'b', client: claude });
    const a2 = after.connect({ sessionKey: 'a', client: claude });
    expect([a2.label, a2.color.id, b2.label, b2.color.id, b2.title]).toEqual(['Claude 1', a.color.id, 'Claude 2', b.color.id, 'dev server']);
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
