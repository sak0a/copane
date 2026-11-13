// A short, persistent record of every change Agent Bridge made (or tried to make) to an agent's
// configuration, with the reason: `<bridge home>/registration-history.json`. Shared by all windows and
// VS Code builds using the bridge home, shown in the status report, and kept to the last few entries.
import * as fs from 'node:fs';
import { writeFileAtomic } from './files';

export type Trigger = 'startup' | 'repair' | 'turn-on' | 'turn-off' | 'settings';

export interface HistoryRecord {
  /** ISO time. */
  at: string;
  agent: string;
  /** What was attempted: "add", "update", "replace", "remove". */
  action: string;
  trigger: Trigger;
  /** Why, in words. */
  reason: string;
  /** ChangeOutcome kind: changed, unchanged, failed, conflict. */
  outcome: string;
  detail: string;
  /** The command registered before the change, if any. */
  before?: string;
  /** Which VS Code made the change (app name and version, window id). */
  by?: string;
}

export const MAX_HISTORY = 40;

export function readHistory(file: string): HistoryRecord[] {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(value) ? value.filter(r => r && typeof r.at === 'string') : [];
  } catch {
    return [];
  }
}

/** Appends a record, keeping the newest `max`. Never throws: the history is an aid, not a requirement. */
export function appendHistory(file: string, record: HistoryRecord, max = MAX_HISTORY): void {
  try {
    const records = [...readHistory(file), record].slice(-max);
    writeFileAtomic(file, JSON.stringify(records, null, 2) + '\n', 0o600);
  } catch {
    // See above.
  }
}

/** How often the startup check re-added this agent's missing entry within `windowMs` before `now`. */
export function recentReAdds(records: HistoryRecord[], agent: string, now: number, windowMs = 24 * 3600_000): number {
  return records.filter(r => r.agent === agent && r.trigger === 'startup' && r.action === 'add' && r.outcome === 'changed' && now - Date.parse(r.at) < windowMs).length;
}

export function formatRecord(r: HistoryRecord): string {
  const before = r.before ? `; was: ${r.before}` : '';
  return `${r.at} · ${r.agent} · ${r.action} (${r.trigger}) → ${r.outcome}: ${r.detail}. Why: ${r.reason}${before}${r.by ? ` · by ${r.by}` : ''}`;
}
