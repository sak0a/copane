// Re-reading a page: what an agent session was last given by a full browser_snapshot of a tab, and
// how the next one differs from it. An unchanged page is answered with one line instead of the whole
// snapshot again, a small change with the changed lines only. Pure: no CDP, no vscode.
//
// This is deliberately not the baseline action results compare against (PageEnv.baselines): that one
// advances on every action, whose result shows the change only clipped to a small budget. This one
// advances only on what a snapshot result actually delivered, so "unchanged" is never claimed for
// lines the agent was not shown.
//
// One record per ref table, i.e. per (agent session, tab): the RefStore drops a table when its tab
// closes or its session ends, and the record goes with it. Comparing lines with their refs filled in
// means a line whose ref changed (a node replaced, a frame reloaded, a ref trimmed) counts as changed.
import { clip } from './ringBuffer';
import { diffLines } from './snapshot';

/** What one full snapshot result showed (see SnapshotOutput.shown), and what it was a snapshot of. */
export interface Delivered {
  loaderId: string | undefined;
  url: string;
  maxChars: number;
  urls: boolean;
  /** Snapshot lines shown, refs filled in. */
  lines: string[];
  /** The cut summary shown under them (empty when the snapshot was not cut). */
  footer: string[];
  /** Lines below the cut, not shown (ref placeholders still in). */
  below: string[];
}

export type SnapshotDelta =
  | { kind: 'full' }
  | { kind: 'unchanged' }
  /** `lines`: changed lines with the line each sits under; `gone`: what is no longer there; `footer`: the new cut summary, when it changed. */
  | { kind: 'changed'; lines: string[]; changed: number; gone: string[]; footer: string[] };

/** A short form is used only while it is at most this share of the full result. */
export const DELTA_SHARE = 0.25;
const MAX_GONE = 8;

const store = new WeakMap<object, Delivered>();

/** What the session owning `refTable` was last shown by a full snapshot of its tab. */
export function lastDelivered(refTable: object): Delivered | undefined {
  return store.get(refTable);
}

export function setDelivered(refTable: object, delivered: Delivered): void {
  store.set(refTable, delivered);
}

const REF = / \[ref=[^\]]*\]/g;
const PLACEHOLDER_REF = / \[ref=\u0001[^\u0001]*\u0001\]/g;
/** A line as it reads without refs and the focus marker: what identifies it when looking for gone ones. */
const bare = (l: string) => l.replace(PLACEHOLDER_REF, '').replace(REF, '').replace(/ \[active\]/g, '').trim();
const chars = (lines: string[]) => lines.reduce((n, l) => n + l.length + 1, 0);
const sameLines = (a: string[], b: string[]) => a.length === b.length && a.every((l, i) => l === b[i]);

/** Decides how to answer a full snapshot, given what the session was last shown of the tab. */
export function compareDelivered(prev: Delivered | undefined, next: Delivered): SnapshotDelta {
  // Another document, another URL (also a same-document route change) or other options: all of it anew.
  if (!prev || prev.loaderId !== next.loaderId || prev.url !== next.url || prev.maxChars !== next.maxChars || prev.urls !== next.urls) return { kind: 'full' };
  if (next.lines.length === 0) return { kind: 'full' };
  const diff = diffLines(prev.lines, next.lines);
  const gone = goneLines(prev.lines, next.lines, next.below, diff.added);
  const footerSame = sameLines(prev.footer, next.footer);
  if (diff.addedCount === 0 && gone.length === 0 && footerSame) return { kind: 'unchanged' };
  const footer = footerSame ? [] : newFooter(prev.footer, next.footer);
  const short = chars(diff.added) + chars(gone.slice(0, MAX_GONE)) + chars(footer);
  if (short > DELTA_SHARE * chars([...next.lines, ...next.footer])) return { kind: 'full' };
  return { kind: 'changed', lines: diff.added, changed: diff.addedCount, gone, footer };
}

/**
 * The cut summary to show again. When only its numbers moved (where the cut is, how long the page
 * is) and the parts it lists are the same, just its first and last line: the agent has the list.
 */
function newFooter(before: string[], after: string[]): string[] {
  if (after.length > 2 && before.length === after.length && sameLines(before.slice(1, -1), after.slice(1, -1))) return [after[0]!, after[after.length - 1]!];
  return after;
}

/**
 * Elements and text of `before` that are no longer on the page: not in `after` nor below the cut,
 * not changed in place (same ref, or same role and name, among the changed lines), and not inside
 * something that is itself gone. Each as a short description.
 */
function goneLines(before: string[], after: string[], below: string[], added: string[]): string[] {
  const remaining = new Map<string, number>();
  for (const l of [...after, ...below]) remaining.set(bare(l), (remaining.get(bare(l)) ?? 0) + 1);
  const refsNow = new Set(added.flatMap(l => [...l.matchAll(/\[ref=(e\d+)\]/g)].map(m => m[1])));
  const headOf = (l: string) => /^\s*- (\w+(?: "(?:[^"\\]|\\.)*")?)/.exec(l)?.[1];
  const headsNow = new Set(added.map(headOf).filter(Boolean));
  const indentOf = (l: string) => l.length - l.trimStart().length;
  const out: string[] = [];
  let goneIndent: number | undefined;
  for (const l of before) {
    const ind = indentOf(l);
    if (goneIndent !== undefined && ind > goneIndent) continue;
    goneIndent = undefined;
    const key = bare(l);
    const n = remaining.get(key) ?? 0;
    if (n > 0) {
      remaining.set(key, n - 1);
      continue;
    }
    const ref = /\[ref=(e\d+)\]/.exec(l)?.[1];
    if (ref && refsNow.has(ref)) continue;
    const h = headOf(l);
    // Named elements whose line changed (a button's state, a status message) are changed, not gone.
    if (h && h.includes('"') && !h.startsWith('text ') && headsNow.has(h)) continue;
    goneIndent = ind;
    out.push(clip(key.replace(/^- /, '').replace(/:$/, ''), 80));
  }
  return out;
}

/** The result for a short form of a snapshot of `tabId`; `next` is what a full one would show. */
export function describeDelta(delta: Exclude<SnapshotDelta, { kind: 'full' }>, tabId: string, next: Delivered): string {
  const again = 'Pass offset: 0 to get it in full again.';
  if (delta.kind === 'unchanged') {
    // After a compaction the agent may not remember that the snapshot was cut, nor where.
    const cut = /showing characters 0-(\d+) of (\d+)/.exec(next.footer[0] ?? '');
    const where = cut ? ` (it was cut at character ${cut[1]} of ${cut[2]}: pass offset ${cut[1]} to read on)` : '';
    return `- Snapshot of ${tabId}: unchanged since your last snapshot of it${where}; its refs are still valid. ${again}`;
  }
  const out: string[] = [];
  if (delta.changed > 0) {
    out.push(
      `- Snapshot of ${tabId}: ${delta.changed} line${delta.changed === 1 ? '' : 's'} changed since your last snapshot of it (each with the line it sits under); everything else and its refs are as they were. ${again}`,
      '```yaml',
      ...delta.lines,
      '```',
    );
  } else {
    out.push(`- Snapshot of ${tabId}: nothing was added or changed since your last snapshot of it; everything else and its refs are as they were. ${again}`);
  }
  if (delta.gone.length) {
    const more = delta.gone.length > MAX_GONE ? ` and ${delta.gone.length - MAX_GONE} more` : '';
    out.push(`Gone since then: ${delta.gone.slice(0, MAX_GONE).join('; ')}${more}.`);
  }
  if (delta.footer.length) out.push(...delta.footer);
  return out.join('\n');
}
