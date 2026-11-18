import { describe, expect, it } from 'vitest';
import {
  collapseOthers,
  collapsedCounts,
  EMPTY_GROUPING,
  expandAll,
  matchStrip,
  planGroupBySession,
  planGrouping,
  setCollapsed,
  type GroupingState,
  type GroupingTab,
  type PinOp,
} from '../../src/extension/ui/tabGroups';

// A tab bar that behaves like VS Code's: a pinned tab moves to the end of the pinned area, an unpinned
// one to right after it. Each group is a list of tab ids; `pinned` holds the pinned ones. A tab's view
// id is "view-<tab id>" unless `viewIds` says otherwise (a tab replaced after a reload).
class Strip {
  groups: string[][];
  viewIds = new Map<string, string | undefined>();
  pinned = new Set<string>();
  owners = new Map<string, string | undefined>();
  waiting = new Set<string>();
  /** Tabs whose pin state the planner cannot see. */
  unknown = new Set<string>();

  constructor(groups: Array<Array<[string, string | undefined]>>, pinned: string[] = []) {
    this.groups = groups.map(g => g.map(([v]) => v));
    for (const g of groups) for (const [v, owner] of g) this.owners.set(v, owner);
    for (const v of pinned) this.pinned.add(v);
    // pinned tabs given must already be at the start of their group
  }

  tabs(): GroupingTab[] {
    return this.groups.flatMap((g, gi) =>
      g.map((v, index) => ({
        tabId: v,
        viewId: this.viewIds.has(v) ? this.viewIds.get(v) : `view-${v}`,
        ownerId: this.owners.get(v),
        waiting: this.waiting.has(v) || undefined,
        pinned: this.unknown.has(v) ? undefined : this.pinned.has(v),
        group: this.unknown.has(v) ? undefined : gi + 1,
        index: this.unknown.has(v) ? undefined : index,
      })),
    );
  }

  apply(ops: PinOp[]): void {
    for (const o of ops) {
      const g = this.groups.find(x => x.includes(o.tabId))!;
      const isPinned = this.pinned.has(o.tabId);
      if (o.op === 'pin' && isPinned) continue;
      if (o.op === 'unpin' && !isPinned) continue;
      g.splice(g.indexOf(o.tabId), 1);
      if (o.op === 'pin') this.pinned.add(o.tabId);
      else this.pinned.delete(o.tabId);
      const pinnedCount = g.filter(v => this.pinned.has(v)).length;
      g.splice(pinnedCount, 0, o.tabId);
    }
  }

  text(): string {
    return this.groups.map(g => g.map(v => (this.pinned.has(v) ? `${v}*` : v)).join(' ')).join(' | ');
  }
}

const sessions = ['A', 'B', 'C'];

function step(strip: Strip, state: GroupingState, restoring = false, live = sessions): GroupingState {
  const plan = planGrouping({ sessions: live, tabs: strip.tabs(), state, restoring });
  strip.apply(plan.ops);
  // Idempotent: planning again on the result does nothing.
  const again = planGrouping({ sessions: live, tabs: strip.tabs(), state: plan.state, restoring });
  expect(again.ops).toEqual([]);
  return plan.state;
}

const collapse = (strip: Strip, state: GroupingState, id: string) => step(strip, setCollapsed(state, id, true, strip.tabs()));
const expand = (strip: Strip, state: GroupingState, id: string) => step(strip, setCollapsed(state, id, false, strip.tabs()));

describe('planGrouping', () => {
  it('does nothing while no session is collapsed', () => {
    const strip = new Strip([[['a1', 'A'], ['b1', 'B']]]);
    expect(planGrouping({ sessions, tabs: strip.tabs(), state: EMPTY_GROUPING }).ops).toEqual([]);
  });

  it('collapsing pins the session tabs in tab bar order; expanding unpins them from the right, leaving them together', () => {
    const strip = new Strip([[['x', undefined], ['a1', 'A'], ['b1', 'B'], ['a2', 'A'], ['b2', 'B'], ['a3', 'A']]]);
    let state = collapse(strip, EMPTY_GROUPING, 'A');
    expect(strip.text()).toBe('a1* a2* a3* x b1 b2');
    expect(collapsedCounts(strip.tabs(), state).get('A')).toBe(3);
    state = expand(strip, state, 'A');
    expect(strip.text()).toBe('a1 a2 a3 x b1 b2');
    expect(state).toEqual({ collapsed: [], pinnedByUs: [], optedOut: [] });
  });

  it('two collapsed sessions form two runs; expanding the first leaves the second in place', () => {
    const strip = new Strip([[['a1', 'A'], ['b1', 'B'], ['a2', 'A'], ['b2', 'B']]]);
    let state = collapse(strip, EMPTY_GROUPING, 'A');
    state = collapse(strip, state, 'B');
    expect(strip.text()).toBe('a1* a2* b1* b2*');
    const plan = planGrouping({ sessions, tabs: strip.tabs(), state: setCollapsed(state, 'A', false, strip.tabs()) });
    expect(plan.ops.map(o => `${o.op} ${o.tabId}`)).toEqual(['unpin a2', 'unpin a1']);
    state = expand(strip, state, 'A');
    expect(strip.text()).toBe('b1* b2* a1 a2');
  });

  it("never unpins a tab the user pinned, and does not count it as collapsed", () => {
    const strip = new Strip([[['u', 'A'], ['a1', 'A'], ['b1', 'B']]], ['u']);
    let state = collapse(strip, EMPTY_GROUPING, 'A');
    expect(strip.text()).toBe('u* a1* b1');
    expect(state.pinnedByUs).toEqual(['a1']);
    expect(collapsedCounts(strip.tabs(), state).get('A')).toBe(1);
    state = expand(strip, state, 'A');
    expect(strip.text()).toBe('u* a1 b1');
    // A user pin of another tab after collapsing is left alone too.
    state = collapse(strip, state, 'A');
    strip.apply([{ op: 'pin', viewId: 'b1', tabId: 'b1' }]);
    state = step(strip, state);
    state = expand(strip, state, 'A');
    expect(strip.pinned.has('b1')).toBe(true);
    expect(strip.pinned.has('u')).toBe(true);
  });

  it('pins a new tab of a collapsed session into its run, before runs collapsed later', () => {
    const strip = new Strip([[['a1', 'A'], ['b1', 'B']]]);
    let state = collapse(strip, EMPTY_GROUPING, 'A');
    state = collapse(strip, state, 'B');
    expect(strip.text()).toBe('a1* b1*');
    strip.groups[0]!.push('a2');
    strip.owners.set('a2', 'A');
    state = step(strip, state);
    expect(strip.text()).toBe('a1* a2* b1*');
    expect(collapsedCounts(strip.tabs(), state)).toEqual(new Map([['A', 2], ['B', 1]]));
  });

  it('a tab the user unpins leaves the run and is not pinned again until the session is collapsed anew', () => {
    const strip = new Strip([[['a1', 'A'], ['a2', 'A'], ['b1', 'B']]]);
    let state = collapse(strip, EMPTY_GROUPING, 'A');
    strip.apply([{ op: 'unpin', viewId: 'a1', tabId: 'a1' }]); // the user
    state = step(strip, state);
    expect(strip.text()).toBe('a2* a1 b1');
    expect(state.optedOut).toEqual(['a1']);
    expect(state.pinnedByUs).toEqual(['a2']);
    state = collapse(strip, state, 'A'); // again: all of its tabs
    expect(strip.text()).toBe('a2* a1* b1');
    expect(state.optedOut).toEqual([]);
  });

  it('after a reload, re-pins tabs that lost their pin, keeping the run together', () => {
    const strip = new Strip([[['a1', 'A'], ['a2', 'A'], ['a3', 'A'], ['b1', 'B']]]);
    let state = collapse(strip, EMPTY_GROUPING, 'A');
    // The reload dropped a2's pin and moved a3 first.
    strip.groups[0] = ['a3', 'a1', 'a2', 'b1'];
    strip.pinned = new Set(['a3', 'a1']);
    state = step(strip, state, true);
    expect(strip.text()).toBe('a3* a1* a2* b1');
    expect(state.optedOut).toEqual([]);
    expect(new Set(state.pinnedByUs)).toEqual(new Set(['a1', 'a2', 'a3']));
  });

  it('after a reload, unpins what Copane pinned for a session that is no longer collapsed', () => {
    const strip = new Strip([[['a1', 'A'], ['b1', 'B']]], ['a1']);
    const state = step(strip, { collapsed: [], pinnedByUs: ['a1'], optedOut: [] }, true);
    expect(strip.text()).toBe('a1 b1');
    expect(state.pinnedByUs).toEqual([]);
  });

  it('while restoring, forgets no tab that is not back yet; a collapsed session that is gone is dropped', () => {
    const plan = planGrouping({ sessions: ['A'], tabs: [], state: { collapsed: ['A'], pinnedByUs: ['a1'], optedOut: ['a2'] }, restoring: true });
    expect(planGrouping({ sessions: [], tabs: [], state: { collapsed: ['A'], pinnedByUs: ['a1'], optedOut: [] }, restoring: true }).state.collapsed).toEqual([]);
    expect(plan).toEqual({ ops: [], base: ['a1'], state: { collapsed: ['A'], pinnedByUs: ['a1'], optedOut: ['a2'] } });
  });

  it('a session that ends drops out, and its tabs are unpinned; one in its grace period stays collapsed', () => {
    const strip = new Strip([[['a1', 'A'], ['b1', 'B']]]);
    let state = collapse(strip, EMPTY_GROUPING, 'A');
    expect(step(strip, state, false, sessions)).toEqual(state); // still live (grace period included)
    strip.owners.set('a1', undefined); // the tab belongs to nobody now
    state = step(strip, state, false, ['B', 'C']);
    expect(strip.text()).toBe('a1 b1');
    expect(state.collapsed).toEqual([]);
  });

  it('a tab that moves to another session leaves the run, or joins that session run when it is collapsed', () => {
    const strip = new Strip([[['a1', 'A'], ['a2', 'A'], ['b1', 'B']]]);
    let state = collapse(strip, EMPTY_GROUPING, 'A');
    strip.owners.set('a2', 'B');
    state = step(strip, state);
    expect(strip.text()).toBe('a1* a2 b1');
    state = collapse(strip, state, 'B');
    expect(strip.text()).toBe('a1* a2* b1*');
    strip.owners.set('a1', 'B'); // B now has a1 too: B's run is a1 a2 b1 at the place of A's old run
    state = step(strip, state);
    expect(strip.text()).toBe('a1* a2* b1*');
    expect(collapsedCounts(strip.tabs(), state)).toEqual(new Map([['A', 0], ['B', 3]]));
  });

  it('lifts a tab an agent waits on out of the run, and puts it back into its place afterwards', () => {
    const strip = new Strip([[['a1', 'A'], ['a2', 'A'], ['b1', 'B']]]);
    let state = collapse(strip, EMPTY_GROUPING, 'A');
    state = collapse(strip, state, 'B');
    strip.waiting.add('a1');
    state = step(strip, state);
    expect(strip.text()).toBe('a2* b1* a1');
    expect(state.optedOut).toEqual([]);
    strip.waiting.delete('a1');
    state = step(strip, state);
    expect(strip.text()).toBe('a2* a1* b1*');
  });

  it('plans each editor group on its own', () => {
    const strip = new Strip([
      [['a1', 'A'], ['b1', 'B']],
      [['b2', 'B'], ['a2', 'A']],
    ]);
    let state = collapse(strip, EMPTY_GROUPING, 'A');
    expect(strip.text()).toBe('a1* b1 | a2* b2');
    state = expand(strip, state, 'A');
    expect(strip.text()).toBe('a1 b1 | a2 b2');
  });

  it('leaves tabs whose pin state it cannot see alone, unless it pinned them', () => {
    const strip = new Strip([[['a1', 'A'], ['a2', 'A']]]);
    strip.unknown.add('a2');
    let state = collapse(strip, EMPTY_GROUPING, 'A');
    expect(strip.text()).toBe('a1* a2');
    strip.unknown.clear();
    state = step(strip, state);
    expect(strip.text()).toBe('a1* a2*');
    strip.unknown.add('a2'); // now ambiguous, but Copane pinned it: still unpinned on expand
    state = expand(strip, state, 'A');
    expect(strip.pinned.size).toBe(0);
  });

  it('forgets tabs that closed, but keeps a tab whose view id is not known yet', () => {
    const state: GroupingState = { collapsed: ['A'], pinnedByUs: ['gone', 'tab-2'], optedOut: ['gone2'] };
    const tabs: GroupingTab[] = [
      { tabId: 'tab-1', viewId: 'v1', ownerId: 'B', pinned: false, group: 1, index: 0 },
      { tabId: 'tab-2', ownerId: 'A' },
    ];
    const plan = planGrouping({ sessions, tabs, state });
    expect(plan.ops).toEqual([]);
    expect(plan.state).toEqual({ collapsed: ['A'], pinnedByUs: ['tab-2'], optedOut: [] });
  });

  it('a tab replaced after a reload (same tab id, new view id, unpinned) is pinned again by its new view id', () => {
    const strip = new Strip([[['a1', 'A'], ['a2', 'A'], ['b1', 'B']]]);
    let state = collapse(strip, EMPTY_GROUPING, 'A');
    // The reload replaced a2: a new editor at the end, unpinned, with a new view id; not attached yet.
    strip.groups[0] = ['a1', 'b1', 'a2'];
    strip.pinned.delete('a2');
    strip.viewIds.set('a2', undefined);
    const waiting = planGrouping({ sessions, tabs: strip.tabs(), state, restoring: true });
    expect(waiting.ops).toEqual([]);
    expect(waiting.state.pinnedByUs.sort()).toEqual(['a1', 'a2']);
    strip.viewIds.set('a2', 'view-new');
    const plan = planGrouping({ sessions, tabs: strip.tabs(), state, restoring: true });
    expect(plan.ops).toEqual([{ op: 'pin', viewId: 'view-new', tabId: 'a2' }]);
    state = step(strip, state, true);
    expect(strip.text()).toBe('a1* a2* b1');
  });

  it('collapseOthers collapses every other session with tabs and expands this one', () => {
    const strip = new Strip([[['a1', 'A'], ['b1', 'B'], ['c1', 'C'], ['b2', 'B']]]);
    let state = collapse(strip, EMPTY_GROUPING, 'A');
    state = step(strip, collapseOthers(state, 'A', sessions, strip.tabs()));
    expect(state.collapsed).toEqual(['B', 'C']);
    expect(strip.text()).toBe('b1* b2* c1* a1');
    state = step(strip, expandAll(state));
    expect(strip.pinned.size).toBe(0);
    expect(state.collapsed).toEqual([]);
  });
});

describe('planGroupBySession', () => {
  it('puts every session tabs side by side in session order, after the pinned area, nothing collapsed', () => {
    const strip = new Strip([[['u', undefined], ['b1', 'B'], ['x', undefined], ['a1', 'A'], ['b2', 'B'], ['a2', 'A']]], ['u']);
    const plan = planGroupBySession({ sessions, tabs: strip.tabs(), state: EMPTY_GROUPING });
    strip.apply(plan.ops);
    expect(strip.text()).toBe('u* a1 a2 b1 b2 x');
    expect(plan.state).toEqual({ collapsed: [], pinnedByUs: [], optedOut: [] });
  });

  it('expands collapsed sessions on the way and keeps the user pins', () => {
    const strip = new Strip([[['u', 'B'], ['a1', 'A'], ['b1', 'B'], ['a2', 'A']]], ['u']);
    let state = collapse(strip, EMPTY_GROUPING, 'B');
    expect(strip.text()).toBe('u* b1* a1 a2');
    const plan = planGroupBySession({ sessions, tabs: strip.tabs(), state });
    strip.apply(plan.ops);
    state = plan.state;
    expect(strip.text()).toBe('u* a1 a2 b1');
    expect(planGrouping({ sessions, tabs: strip.tabs(), state }).ops).toEqual([]);
  });
});

describe('matchStrip', () => {
  const entry = (label: string, pinned: boolean, group: number, index: number) => ({ label, pinned, group, index });

  it('matches a tab by title, or by host when the editor shows that', () => {
    const m = matchStrip(
      [
        { tabId: 't1', labels: ['Docs', 'example.com'] },
        { tabId: 't2', labels: ['', 'localhost:3000'] },
      ],
      [entry('Docs', true, 1, 0), entry('localhost:3000', false, 2, 0)],
    );
    expect(m.get('t1')).toEqual({ pinned: true, group: 1, index: 0 });
    expect(m.get('t2')).toEqual({ pinned: false, group: 2, index: 0 });
  });

  it('with tabs sharing a label, only a pin state they all share is known', () => {
    const tabs = [
      { tabId: 't1', labels: ['Same'] },
      { tabId: 't2', labels: ['Same'] },
    ];
    expect(matchStrip(tabs, [entry('Same', false, 1, 0), entry('Same', false, 1, 1)]).get('t1')).toEqual({ pinned: false });
    expect(matchStrip(tabs, [entry('Same', true, 1, 0), entry('Same', false, 1, 1)]).get('t2')).toEqual({});
    // Two browser tabs claim the one editor tab with that label: neither is sure.
    expect(matchStrip(tabs, [entry('Same', true, 1, 0)]).get('t1')).toEqual({ pinned: true });
  });

  it('an unmatched tab has nothing known', () => {
    expect(matchStrip([{ tabId: 't1', labels: ['Gone'] }], [entry('Other', true, 1, 0)]).get('t1')).toEqual({});
  });
});
