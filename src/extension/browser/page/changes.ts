// What an action changed on the page: the elements that appeared or changed since this session last
// looked at the page (its last snapshot, or the end of its last action), printed as snapshot lines with
// refs. It saves the snapshot an agent would otherwise take after most clicks and key presses. Bounded
// to a small budget; skipped when the action loaded a new page (that page is read anew anyway).
import { ToolError } from '../../core/errors';
import type { PageCall } from './call';
import { DialogInterrupt } from './pageState';
import { diffLines, fillRefs } from './snapshot';
import { capturePage, rememberPage } from './snapshotTools';

/** Characters of changed lines an action result may show. */
export const CHANGE_BUDGET = 1000;

export interface PageBefore {
  loaderId: string | undefined;
  lines: string[];
}

/** What this session last saw of the page; read now when it has not seen this document yet (unless `cachedOnly`). */
export async function pageBefore(call: PageCall, options: { cachedOnly?: boolean } = {}): Promise<PageBefore | undefined> {
  const known = call.env.baselines.get(call.sessionTabKey);
  if (known && known.loaderId === call.state.loaderId) return known;
  if (options.cachedOnly || call.state.dialog) return undefined;
  try {
    return rememberPage(call, await capturePage(call));
  } catch (err) {
    if (err instanceof DialogInterrupt || (err instanceof ToolError && err.code === 'cancelled')) throw err;
    return undefined;
  }
}

/**
 * Lines describing what changed since `before`, or nothing. `own` are elements whose change the
 * result already reports (the field typed into, the button clicked).
 */
export async function describeChanges(call: PageCall, before: PageBefore | undefined, own: Iterable<number> = []): Promise<string[]> {
  const { state } = call;
  if (!before || call.page.closed || state.dialog || state.loaderId !== before.loaderId) return [];
  let after: PageBefore;
  let nodes;
  try {
    const capture = await capturePage(call);
    if (capture.loaderId !== before.loaderId) return [];
    after = rememberPage(call, capture);
    nodes = capture.tree.nodes;
  } catch (err) {
    if (err instanceof ToolError && err.code === 'cancelled') throw err;
    return [];
  }
  const ownIds = new Set(own);
  const ignore = new Set([...nodes].filter(([, n]) => ownIds.has(n.backendNodeId)).map(([key]) => key));
  const diff = diffLines(before.lines, after.lines, ignore);
  if (diff.added.length === 0 && diff.removed.length === 0) return [];
  const out: string[] = [];
  if (diff.added.length) {
    const shown: string[] = [];
    let used = 0;
    for (const line of diff.added) {
      if (used + line.length > CHANGE_BUDGET && shown.length > 0) break;
      shown.push(line);
      used += line.length + 1;
    }
    const refFor = (n: Parameters<typeof call.refs.assign>[0]) => call.refs.assign(n, after.loaderId);
    // Refs are filled in before clipping, so a cut never splits one.
    const filled = shown.map(l => fillRefs(l, nodes, refFor)).map(l => (l.length > CHANGE_BUDGET ? `${l.slice(0, CHANGE_BUDGET)}…` : l));
    out.push('Changed on the page:', ...filled);
    const rest = diff.added.length - shown.length;
    if (rest > 0) out.push(`… and ${rest} more changed lines (browser_snapshot shows the whole page).`);
  }
  if (diff.removed.length) {
    const names = diff.removed.slice(0, 5).join(', ');
    out.push(`Gone from the page: ${names}${diff.removed.length > 5 ? ` and ${diff.removed.length - 5} more` : ''}.`);
  }
  return out;
}
