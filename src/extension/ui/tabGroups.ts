// "Collapse a session's tabs": the planning half, as data. VS Code has no tab groups an extension can
// fold, so a collapsed session's browser tabs are pinned (with `workbench.editor.pinnedTabSizing`
// "compact" a pinned tab is its icon only), one contiguous run per session at the left of the tab bar.
// Pinned tabs sort in pin order, and a tab that is unpinned lands right after the pinned area, so
// pinning and unpinning in the right order also moves tabs without activating any of them.
//
// Inputs: the live sessions, the browser tabs (whose session each is shown under, VS Code's view id,
// where it sits in the tab bar and whether it is pinned), and what Copane did so far: the collapsed
// sessions, the tabs Copane pinned itself, and tabs the user took out of a collapsed run. Output: the
// pin / unpin operations to run in order, and the new state. No `vscode` here (unit-tested in
// test/unit/ui-tab-groups.test.ts); tabGrouping.ts reads the inputs and runs the operations.
//
// Rules:
// - Only tabs Copane pinned are ever unpinned. A tab that was already pinned (by the user) stays theirs.
// - A tab Copane pinned that turns up unpinned left its run because the user unpinned it: it is not
//   pinned again while its session stays collapsed. After a window reload (`restoring`) VS Code may
//   have dropped the pin itself, so there it is pinned again.
// - A tab of a collapsed session that an agent is waiting on (a hand-off) is lifted out of the run
//   while it waits, so the tab bar shows its title and badge; it goes back when the request ends.
// - Each editor group is planned on its own; the pin commands act on the tab in its own group.
// - Tabs are remembered by Copane's tab id, not VS Code's view id: a tab an agent held when the window
//   reloaded is replaced by a new one (new view id) under the same tab id (browser/service.ts).

export interface GroupingTab {
  tabId: string;
  /** VS Code's view id: the editor's resource is `vscode-browser:/<viewId>`. Tabs without one cannot be pinned. */
  viewId?: string;
  /** The session the tab is shown under (`tabOwner` of panelModel.ts), if a live one. */
  ownerId?: string;
  /** An agent handed the tab to the user and waits for them. */
  waiting?: boolean;
  /** Undefined when the tab bar does not tell (two tabs with the same label). */
  pinned?: boolean;
  /** The editor group (view column) the tab is in, when known. */
  group?: number;
  /** Position in its group, when known. */
  index?: number;
}

export interface GroupingState {
  /** Collapsed sessions, in the order they were collapsed. */
  collapsed: string[];
  /** Tab ids of the tabs Copane pinned. */
  pinnedByUs: string[];
  /** Tab ids of tabs the user unpinned while their session was collapsed: left alone until it is expanded. */
  optedOut: string[];
}

export interface PinOp {
  op: 'pin' | 'unpin';
  viewId: string;
  tabId: string;
}

export interface GroupingPlan {
  ops: PinOp[];
  /** The tabs Copane pinned before the operations (what is left of them when some fail: `applyOps(base, succeeded)`). */
  base: string[];
  /** The state once every operation succeeded. */
  state: GroupingState;
}

export interface PlanInput {
  /** Live session ids (connected or in their grace period), in session order. */
  sessions: readonly string[];
  tabs: readonly GroupingTab[];
  state: GroupingState;
  /**
   * Right after a window reload: a tab Copane pinned that is unpinned now lost its pin to the reload
   * and is pinned again; tabs that are missing are not forgotten (they may still be coming back).
   */
  restoring?: boolean;
}

export const EMPTY_GROUPING: GroupingState = Object.freeze({ collapsed: [], pinnedByUs: [], optedOut: [] }) as GroupingState;

export function isEmptyGrouping(state: GroupingState): boolean {
  return !state.collapsed.length && !state.pinnedByUs.length && !state.optedOut.length;
}

// ------------------------------------------------------------------------------------- state changes

/**
 * Collapses (or expands) a session. Either way the user's earlier "take this tab out" choices for its
 * tabs are forgotten: the command is about all of its tabs now.
 */
export function setCollapsed(state: GroupingState, sessionId: string, collapsed: boolean, tabs: readonly GroupingTab[]): GroupingState {
  const own = new Set(tabs.filter(t => t.ownerId === sessionId).map(t => t.tabId));
  const list = state.collapsed.filter(id => id !== sessionId);
  return {
    collapsed: collapsed ? [...list, sessionId] : list,
    pinnedByUs: state.pinnedByUs,
    optedOut: state.optedOut.filter(v => !own.has(v)),
  };
}

/** "Show only this session's tabs": every other session that has tabs is collapsed, this one expanded. */
export function collapseOthers(state: GroupingState, keep: string, sessions: readonly string[], tabs: readonly GroupingTab[]): GroupingState {
  let next = setCollapsed(state, keep, false, tabs);
  const withTabs = new Set(tabs.map(t => t.ownerId).filter((id): id is string => !!id));
  for (const id of sessions) if (id !== keep && withTabs.has(id) && !next.collapsed.includes(id)) next = setCollapsed(next, id, true, tabs);
  return next;
}

export function expandAll(state: GroupingState): GroupingState {
  return { collapsed: [], pinnedByUs: state.pinnedByUs, optedOut: [] };
}

// ------------------------------------------------------------------------------------- planning

/** Brings the tab bar in line with the collapsed sessions. Idempotent: planning again after it ran gives no operations. */
export function planGrouping(input: PlanInput): GroupingPlan {
  const restoring = input.restoring === true;
  const live = new Set(input.sessions);
  // Sessions come back from workspace state before this runs, so a collapsed session not listed has ended.
  const collapsed = input.state.collapsed.filter(id => live.has(id));
  const collapsedSet = new Set(collapsed);
  const ours = new Set(input.state.pinnedByUs);
  const optedOut = new Set(input.state.optedOut);
  // Only tabs whose view id is known can be pinned or unpinned; the others keep their state.
  const tabs = operable(input.tabs);

  // Forget tabs that closed (while restoring, they may still be coming back).
  if (!restoring) {
    const open = new Set(input.tabs.map(t => t.tabId));
    for (const id of [...ours]) if (!open.has(id)) ours.delete(id);
    for (const id of [...optedOut]) if (!open.has(id)) optedOut.delete(id);
  }

  const owned = (t: GroupingTab) => !!t.ownerId && collapsedSet.has(t.ownerId);
  for (const t of tabs) {
    const v = t.tabId;
    if (!owned(t) && !restoring) optedOut.delete(v);
    if (ours.has(v) && t.pinned === false) {
      // Not pinned any more although Copane pinned it: the user unpinned it (or a reload dropped the pin).
      ours.delete(v);
      if (!restoring && owned(t) && !t.waiting) optedOut.add(v);
    }
  }

  // Whether Copane wants the tab pinned. A tab pinned by someone else, or whose pin state is unknown
  // and that Copane did not pin, is left alone.
  const wanted = (t: GroupingTab) => owned(t) && !t.waiting && !optedOut.has(t.tabId) && (ours.has(t.tabId) || t.pinned === false);

  const ops: PinOp[] = [];
  const collapseOrder = new Map(collapsed.map((id, i) => [id, i]));
  for (const groupTabs of byGroup(tabs).values()) {
    const current = groupTabs.filter(t => ours.has(t.tabId)).sort(byPosition);
    const desiredSet = new Set(groupTabs.filter(wanted));
    const ordered = [...current, ...desiredSet].every(t => t.index !== undefined);
    let unpin: GroupingTab[];
    let pin: GroupingTab[];
    if (ordered) {
      // Sessions keep the place their run has; newly collapsed ones go after, in collapse order.
      const rank = new Map<string, number>();
      for (const t of current) if (desiredSet.has(t) && !rank.has(t.ownerId!)) rank.set(t.ownerId!, t.index!);
      const desired = [...desiredSet].sort(
        (a, b) =>
          compareNumbers(rank.get(a.ownerId!), rank.get(b.ownerId!)) ||
          collapseOrder.get(a.ownerId!)! - collapseOrder.get(b.ownerId!)! ||
          byPosition(a, b),
      );
      const kept = current.filter(t => desiredSet.has(t));
      let k = 0;
      while (k < kept.length && kept[k] === desired[k]) k++;
      const moved = new Set(kept.slice(k));
      unpin = current.filter(t => !desiredSet.has(t) || moved.has(t));
      pin = desired.slice(k);
    } else {
      unpin = current.filter(t => !desiredSet.has(t)).sort(byTabId);
      pin = [...desiredSet].filter(t => !ours.has(t.tabId)).sort((a, b) => collapseOrder.get(a.ownerId!)! - collapseOrder.get(b.ownerId!)! || byTabId(a, b));
    }
    // Unpinning from the right end keeps the unpinned tabs together, in their order, after the pinned area.
    for (const t of [...unpin].reverse()) ops.push({ op: 'unpin', viewId: t.viewId!, tabId: t.tabId });
    for (const t of pin) ops.push({ op: 'pin', viewId: t.viewId!, tabId: t.tabId });
  }

  return { ops, base: [...ours], state: { collapsed, pinnedByUs: applyOps(ours, ops), optedOut: [...optedOut] } };
}

/**
 * "Group tabs by session": every session's tabs side by side right after the pinned area, in session
 * order, nothing collapsed. Done by pinning them all in the wanted order and unpinning them again from
 * the right end. Tabs pinned by the user, of no live session, or whose pin state is unknown stay put.
 */
export function planGroupBySession(input: PlanInput): GroupingPlan {
  const order = new Map(input.sessions.map((id, i) => [id, i]));
  const ours = new Set(input.state.pinnedByUs);
  const tabs = operable(input.tabs);
  const ops: PinOp[] = [];
  for (const groupTabs of byGroup(tabs).values()) {
    const current = groupTabs.filter(t => ours.has(t.tabId) && t.pinned !== false).sort(byPosition);
    const run = groupTabs
      .filter(t => t.ownerId !== undefined && order.has(t.ownerId) && (ours.has(t.tabId) || t.pinned === false))
      .sort((a, b) => order.get(a.ownerId!)! - order.get(b.ownerId!)! || byPosition(a, b));
    for (const t of [...current].reverse()) ops.push({ op: 'unpin', viewId: t.viewId!, tabId: t.tabId });
    for (const t of run) ops.push({ op: 'pin', viewId: t.viewId!, tabId: t.tabId });
    for (const t of [...run].reverse()) ops.push({ op: 'unpin', viewId: t.viewId!, tabId: t.tabId });
  }
  return { ops, base: [...ours], state: { collapsed: [], pinnedByUs: applyOps(ours, ops), optedOut: [] } };
}

/** How many tabs of each collapsed session are collapsed (pinned by Copane) under the given state. */
export function collapsedCounts(tabs: readonly GroupingTab[], state: GroupingState): Map<string, number> {
  const ours = new Set(state.pinnedByUs);
  const counts = new Map<string, number>(state.collapsed.map(id => [id, 0]));
  for (const t of tabs) if (t.ownerId && counts.has(t.ownerId) && ours.has(t.tabId)) counts.set(t.ownerId, counts.get(t.ownerId)! + 1);
  return counts;
}

/** The tab ids pinned by Copane after `ops` ran on top of `ours`. */
export function applyOps(ours: Iterable<string>, ops: readonly PinOp[]): string[] {
  const set = new Set(ours);
  for (const o of ops) {
    if (o.op === 'pin') set.add(o.tabId);
    else set.delete(o.tabId);
  }
  return [...set];
}

// ------------------------------------------------------------------------------------- the tab bar

/** One editor tab without an input (`window.tabGroups`): how a browser editor appears to extensions. */
export interface StripEntry {
  label: string;
  pinned: boolean;
  group: number;
  index: number;
}

/**
 * Which editor tab is which browser tab. Browser editors have no input in `window.tabGroups`, so they
 * are matched by label (the page title, or the host without one), as `columnOf` in browser/service.ts
 * does. Exact when one tab and one editor tab share a label; with several, only a pin state they all
 * share is known.
 */
export function matchStrip(tabs: ReadonlyArray<{ tabId: string; labels: readonly string[] }>, entries: readonly StripEntry[]): Map<string, Pick<GroupingTab, 'pinned' | 'group' | 'index'>> {
  const claims = new Map<StripEntry, number>();
  const matches = tabs.map(t => {
    const labels = new Set(t.labels.filter(Boolean));
    const found = entries.filter(e => labels.has(e.label));
    for (const e of found) claims.set(e, (claims.get(e) ?? 0) + 1);
    return found;
  });
  const out = new Map<string, Pick<GroupingTab, 'pinned' | 'group' | 'index'>>();
  tabs.forEach((t, i) => {
    const found = matches[i]!;
    if (found.length === 1 && claims.get(found[0]!) === 1) {
      const e = found[0]!;
      out.set(t.tabId, { pinned: e.pinned, group: e.group, index: e.index });
    } else if (found.length > 0 && found.every(e => e.pinned === found[0]!.pinned)) {
      out.set(t.tabId, { pinned: found[0]!.pinned });
    } else {
      out.set(t.tabId, {});
    }
  });
  return out;
}

// ------------------------------------------------------------------------------------- helpers

/** Tabs that can be pinned: with a view id, one tab per view id and per tab id. */
function operable(tabs: readonly GroupingTab[]): GroupingTab[] {
  const seen = new Set<string>();
  return tabs.filter(t => {
    if (!t.viewId || seen.has(t.viewId) || seen.has(`#${t.tabId}`)) return false;
    seen.add(t.viewId);
    seen.add(`#${t.tabId}`);
    return true;
  });
}

function byGroup(tabs: readonly GroupingTab[]): Map<number, GroupingTab[]> {
  const groups = new Map<number, GroupingTab[]>();
  for (const t of [...tabs].sort((a, b) => compareNumbers(a.group, b.group))) {
    const key = t.group ?? -1;
    const list = groups.get(key) ?? [];
    list.push(t);
    groups.set(key, list);
  }
  return groups;
}

function byPosition(a: GroupingTab, b: GroupingTab): number {
  return compareNumbers(a.index, b.index) || byTabId(a, b);
}

/** Ascending, unknown (undefined) last. */
function compareNumbers(a: number | undefined, b: number | undefined): number {
  if (a === b) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  return a - b;
}

function byTabId(a: GroupingTab, b: GroupingTab): number {
  return a.tabId.localeCompare(b.tabId, undefined, { numeric: true });
}
