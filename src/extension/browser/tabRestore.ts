// Which tab restored after a window reload is which tab from before, so "tab-3" keeps meaning the same
// tab for agents that listed tabs before the reload. No `vscode` dependency, so it is unit-tested.
//
// What identifies a tab across a reload:
// - VS Code's browser view id (`vscodeBrowserViewId`), known for tabs the bridge attached to before
//   (agent tabs, tabs the user shared) and readable again from the tab's browser target. Exact.
// - The URL. A window reload keeps the browser views (and their pages) alive in VS Code's main
//   process, so a tab comes back showing the same URL; a full restart reloads each tab from the URL
//   VS Code saved with the editor. The title is not reliable (it is often still empty, or the URL,
//   while VS Code restores the editor), and the order of `window.browserTabs` follows whichever part
//   of VS Code registered the views first, not the tab order.
// Nothing else about a tab (its editor tab, label, position) is visible to extensions: browser editors
// have no tab input in `window.tabGroups`, and `BrowserTab` has no id.
//
// So a restored tab gets back the id of a remembered tab when their view ids are equal, or when the URL
// is the same and no other remembered or restored tab could pair up the same way. Tabs that cannot be
// told apart (two tabs showing the same URL, never attached) are not guessed: they get new ids, and
// the old ids are retired, so a stale id fails with a message instead of acting on another tab.

export interface RememberedTab {
  id: string;
  url: string;
  viewId?: string;
}

export interface RestoredTab {
  url: string;
  /** Read from the tab's browser target, when that was tried and worked. */
  viewId?: string;
}

/** A remembered tab whose id was not given back (it closed, or could not be told apart from another). */
export interface RetiredTab {
  id: string;
  url: string;
  /** "ambiguous": a tab with this URL is still open but could not be told apart from another one. */
  reason: 'closed' | 'ambiguous';
}

export interface RestoreMatch<T extends RememberedTab> {
  /** Per restored tab (same index), the remembered tab it is, if known. */
  matches: Array<T | undefined>;
  retired: RetiredTab[];
  byViewId: number;
  byUrl: number;
}

export function matchRestoredTabs<T extends RememberedTab>(remembered: readonly T[], restored: readonly RestoredTab[]): RestoreMatch<T> {
  const matches: Array<T | undefined> = restored.map(() => undefined);
  const free = new Set(remembered);
  let byViewId = 0;
  let byUrl = 0;
  restored.forEach((tab, i) => {
    if (!tab.viewId) return;
    const entry = [...free].find(e => e.viewId === tab.viewId);
    if (!entry) return;
    matches[i] = entry;
    free.delete(entry);
    byViewId++;
  });
  // Both view ids known and different: certainly not the same tab.
  const compatible = (entry: T, tab: RestoredTab) => entry.url === tab.url && !(entry.viewId && tab.viewId && entry.viewId !== tab.viewId);
  for (let changed = true; changed; ) {
    changed = false;
    restored.forEach((tab, i) => {
      if (matches[i]) return;
      const candidates = [...free].filter(e => compatible(e, tab));
      if (candidates.length !== 1) return;
      const entry = candidates[0]!;
      const rivals = restored.filter((other, j) => !matches[j] && compatible(entry, other));
      if (rivals.length !== 1) return;
      matches[i] = entry;
      free.delete(entry);
      byUrl++;
      changed = true;
    });
  }
  const open = (entry: T) => restored.some((tab, i) => !matches[i] && compatible(entry, tab));
  const retired = [...free].map(e => ({ id: e.id, url: e.url, reason: open(e) ? ('ambiguous' as const) : ('closed' as const) }));
  return { matches, retired, byViewId, byUrl };
}

/** At most this many retired ids are remembered (newest first). */
export const MAX_RETIRED = 50;

/** The message for an agent that uses an id retired at a window reload. */
export function retiredMessage(tab: RetiredTab, current = false): string {
  const which = current ? `Your current tab ${tab.id}` : `${tab.id}`;
  if (tab.reason === 'ambiguous') {
    return `${which} was open before VS Code reloaded the window, but afterwards it could not be told apart from another tab showing the same page (${clip(tab.url)}), so it has a new id now and ${tab.id} is no longer used. Call browser_list_tabs and pick the tab again.`;
  }
  return `${which} was open before VS Code reloaded the window and is not open any more. Call browser_list_tabs for the open tabs.`;
}

function clip(url: string): string {
  return url.length > 120 ? `${url.slice(0, 119)}…` : url || 'a blank page';
}
