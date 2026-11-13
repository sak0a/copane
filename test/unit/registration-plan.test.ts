// The rules for when a registration is added, updated, left alone or reported: the only paths by
// which the startup check and "Check and Repair" change an agent's configuration.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { appendHistory, formatRecord, MAX_HISTORY, readHistory, recentReAdds, type HistoryRecord } from '../../src/extension/registration/history';
import { MAX_AUTO_READDS, planAgent, type PlanInput } from '../../src/extension/registration/plan';

const base: PlanInput = { agent: 'Claude Code', state: { kind: 'absent' }, mode: 'ask', consent: undefined, detected: true, snoozed: false, recentReAdds: 0 };
const plan = (over: Partial<PlanInput>, trigger: 'startup' | 'repair' = 'startup') => planAgent({ ...base, ...over }, trigger);

describe('startup check', () => {
  it('leaves a current entry alone', () => {
    expect(plan({ state: { kind: 'ours', current: true, command: 'x' } })).toMatchObject({ action: 'none' });
  });

  it('updates its own outdated entry, with the reason, unless the mode is manual', () => {
    const state = { kind: 'ours', current: false, command: 'x', reason: 'the runtime it starts no longer exists (C:\\old\\Code.exe)' } as const;
    const p = plan({ state, consent: 'granted' });
    expect(p).toMatchObject({ action: 'update' });
    expect(p.action === 'update' && p.reason).toContain('no longer exists');
    expect(plan({ state, mode: 'manual' })).toMatchObject({ action: 'report' });
  });

  it('re-adds a missing entry the user agreed to (the entry "got removed" and never came back)', () => {
    const p = plan({ consent: 'granted', consentAt: '2026-11-01T10:00:00Z' });
    expect(p).toMatchObject({ action: 'add' });
    expect(p.action === 'add' && p.reason).toMatch(/missing although registration was agreed to on 2026-11-01/);
    expect(p.action === 'add' && p.reason).toMatch(/Turn Off/);
  });

  it('stops re-adding when something keeps removing it, and says so', () => {
    const p = plan({ consent: 'granted', recentReAdds: MAX_AUTO_READDS });
    expect(p).toMatchObject({ action: 'report' });
    expect(p.action === 'report' && p.problem).toMatch(/keeps disappearing/);
  });

  it('never adds after Turn Off, nor when the agent is not installed', () => {
    expect(plan({ consent: 'declined' })).toMatchObject({ action: 'none' });
    expect(plan({ consent: 'declined', mode: 'automatic' })).toMatchObject({ action: 'none' });
    expect(plan({ consent: 'granted', detected: false })).toMatchObject({ action: 'none' });
  });

  it('asks once in mode "ask", adds in "automatic", does nothing in "manual"', () => {
    expect(plan({})).toEqual({ action: 'ask' });
    expect(plan({ snoozed: true })).toMatchObject({ action: 'none' });
    expect(plan({ mode: 'automatic' })).toMatchObject({ action: 'add' });
    expect(plan({ mode: 'manual' })).toMatchObject({ action: 'none' });
    expect(plan({ mode: 'manual', consent: 'granted' })).toMatchObject({ action: 'report' });
  });

  it('never touches another server of the same name or an unreadable config', () => {
    expect(plan({ state: { kind: 'foreign', command: 'npx x' }, consent: 'granted' })).toMatchObject({ action: 'report' });
    expect(plan({ state: { kind: 'unreadable', error: 'bad' }, consent: 'granted' })).toMatchObject({ action: 'report' });
  });

  it('does nothing in a blocked development host', () => {
    expect(plan({ blocked: 'dev host', consent: 'granted' })).toMatchObject({ action: 'none' });
  });
});

describe('Check and Repair', () => {
  it('registers a missing entry, updates an outdated one, and offers to replace another server', () => {
    expect(plan({}, 'repair')).toMatchObject({ action: 'add' });
    expect(plan({ consent: 'granted', recentReAdds: 10 }, 'repair')).toMatchObject({ action: 'add' });
    expect(plan({ state: { kind: 'ours', current: false, command: 'x' }, mode: 'manual' }, 'repair')).toMatchObject({ action: 'update' });
    expect(plan({ state: { kind: 'foreign', command: 'npx x' } }, 'repair')).toEqual({ action: 'ask-replace', command: 'npx x' });
  });

  it('respects Turn Off and says how to turn it back on', () => {
    const p = plan({ consent: 'declined' }, 'repair');
    expect(p).toMatchObject({ action: 'report' });
    expect(p.action === 'report' && p.problem).toMatch(/turned off; run "Agent Bridge: Turn On"/);
  });
});

describe('registration history', () => {
  const record = (over: Partial<HistoryRecord> = {}): HistoryRecord => ({
    at: new Date().toISOString(),
    agent: 'Claude Code',
    action: 'add',
    trigger: 'startup',
    reason: 'missing',
    outcome: 'changed',
    detail: 'registered',
    ...over,
  });

  it('keeps the newest records and survives a damaged file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-hist-'));
    try {
      const file = path.join(dir, 'h.json');
      expect(readHistory(file)).toEqual([]);
      for (let i = 0; i < MAX_HISTORY + 5; i++) appendHistory(file, record({ detail: `n${i}` }));
      const all = readHistory(file);
      expect(all).toHaveLength(MAX_HISTORY);
      expect(all.at(-1)!.detail).toBe(`n${MAX_HISTORY + 4}`);
      fs.writeFileSync(file, '{ broken');
      expect(readHistory(file)).toEqual([]);
      appendHistory(file, record());
      expect(readHistory(file)).toHaveLength(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('counts the startup check\'s recent re-adds per agent', () => {
    const now = Date.now();
    const records = [
      record(),
      record({ at: new Date(now - 2 * 24 * 3600_000).toISOString() }),
      record({ trigger: 'repair' }),
      record({ outcome: 'failed' }),
      record({ agent: 'Codex' }),
      record(),
    ];
    expect(recentReAdds(records, 'Claude Code', now)).toBe(2);
  });

  it('formats a record with its reason and what was there before', () => {
    expect(formatRecord(record({ action: 'update', before: 'C:\\old\\Code.exe x', by: 'Code 1.146, window 7' }))).toMatch(
      /Claude Code · update \(startup\) → changed: registered\. Why: missing; was: C:\\old\\Code\.exe x · by Code 1\.146, window 7/,
    );
  });
});
