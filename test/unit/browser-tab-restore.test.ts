// Recognising tabs after a window reload (tabRestore.ts): by view id when known, else by URL when
// that is unambiguous; ids that cannot be given back are retired, never reused or guessed.
import { describe, expect, it } from 'vitest';
import { matchRestoredTabs, retiredMessage } from '../../src/extension/browser/tabRestore';
import { candidatesFor, parseState } from '../../src/extension/browser/tabState';

const A = 'http://a.test/';
const B = 'http://b.test/';
const C = 'http://c.test/';

describe('matching restored tabs', () => {
  it('gives tabs nobody attached to their ids back by URL, whatever order VS Code lists them in', () => {
    const remembered = [
      { id: 'tab-1', url: A },
      { id: 'tab-2', url: B },
      { id: 'tab-3', url: C },
    ];
    const r = matchRestoredTabs(remembered, [{ url: C }, { url: A }, { url: B }]);
    expect(r.matches.map(m => m?.id)).toEqual(['tab-3', 'tab-1', 'tab-2']);
    expect(r).toMatchObject({ byUrl: 3, byViewId: 0, retired: [] });
  });

  it('uses view ids first, then lets URL matching settle the rest', () => {
    const remembered = [
      { id: 'tab-1', url: A, viewId: 'v1' },
      { id: 'tab-2', url: A, viewId: 'v2' },
      { id: 'tab-3', url: A },
    ];
    // Two of three tabs on the same URL were identified; the third can only be the one left.
    const r = matchRestoredTabs(remembered, [{ url: A, viewId: 'v2' }, { url: A }, { url: A, viewId: 'v1' }]);
    expect(r.matches.map(m => m?.id)).toEqual(['tab-2', 'tab-3', 'tab-1']);
    expect(r).toMatchObject({ byViewId: 2, byUrl: 1, retired: [] });
  });

  it('never guesses between tabs that show the same URL: their ids are retired', () => {
    const remembered = [
      { id: 'tab-1', url: A },
      { id: 'tab-4', url: A },
      { id: 'tab-5', url: B },
    ];
    const r = matchRestoredTabs(remembered, [{ url: A }, { url: B }, { url: A }]);
    expect(r.matches.map(m => m?.id)).toEqual([undefined, 'tab-5', undefined]);
    expect(r.retired).toEqual([
      { id: 'tab-1', url: A, reason: 'ambiguous' },
      { id: 'tab-4', url: A, reason: 'ambiguous' },
    ]);
  });

  it('does not match a tab whose view id says it is another one', () => {
    const r = matchRestoredTabs([{ id: 'tab-1', url: A, viewId: 'v1' }], [{ url: A, viewId: 'v9' }]);
    expect(r.matches).toEqual([undefined]);
    expect(r.retired).toEqual([{ id: 'tab-1', url: A, reason: 'closed' }]);
  });

  it('a restored tab with a URL nobody had, or a remembered one that is gone, stays unmatched', () => {
    const r = matchRestoredTabs([{ id: 'tab-1', url: A }, { id: 'tab-2', url: B }], [{ url: A }, { url: C }, { url: C }]);
    expect(r.matches.map(m => m?.id)).toEqual(['tab-1', undefined, undefined]);
    expect(r.retired).toEqual([{ id: 'tab-2', url: B, reason: 'closed' }]);
  });

  it('one remembered tab and two open ones with its URL: neither gets the id', () => {
    const r = matchRestoredTabs([{ id: 'tab-1', url: A }], [{ url: A }, { url: A }]);
    expect(r.matches).toEqual([undefined, undefined]);
    expect(r.retired).toEqual([{ id: 'tab-1', url: A, reason: 'ambiguous' }]);
  });

  it('tells the agent what happened to a retired id', () => {
    expect(retiredMessage({ id: 'tab-4', url: A, reason: 'ambiguous' })).toMatch(/^tab-4 was open before VS Code reloaded the window, but afterwards it could not be told apart from another tab showing the same page \(http:\/\/a\.test\/\).*browser_list_tabs/);
    expect(retiredMessage({ id: 'tab-4', url: A, reason: 'closed' }, true)).toMatch(/^Your current tab tab-4 was open before VS Code reloaded the window and is not open any more/);
  });
});

describe('persisted tab state', () => {
  it('keeps tabs without a view id and retired ids, and never hands out a retired number again', () => {
    const state = parseState({
      version: 1,
      nextNumber: 3,
      tabs: [{ id: 'tab-2', origin: 'user', url: A }],
      currentTab: {},
      retired: [{ id: 'tab-9', url: B, reason: 'ambiguous' }, { id: 'tab-x', url: B, reason: 'ambiguous' }, { id: 'tab-8', url: B, reason: 'odd' }],
    });
    expect(state.tabs.map(t => t.id)).toEqual(['tab-2']);
    expect(state.retired?.map(t => t.id)).toEqual(['tab-9']);
    expect(state.nextNumber).toBe(10);
    // A tab without a view id is matched by URL, not identified through CDP.
    expect(candidatesFor(state, A, new Set())).toEqual([]);
  });
});
