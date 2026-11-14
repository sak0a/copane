// What the browser module remembers about tabs across a window reload, so that "tab-3" still means
// the same tab when an agent session resumes: its id, who opened it, and the session's current tab.
// Tabs are recognised by VS Code's browser view id (`vscodeBrowserViewId` on the CDP target), which
// survives reloads and restarts, or else by their URL (tabRestore.ts). No `vscode` dependency.
import type { ConsentSnapshot } from './consent';
import type { RetiredTab } from './tabRestore';

export interface PersistedTab {
  id: string;
  /** Known once the bridge has attached to the tab; tabs nobody used are remembered by URL only. */
  viewId?: string;
  origin: 'agent' | 'user';
  openedBy?: string;
  openerTab?: string;
  paused?: boolean;
  /** Last known URL: restored tabs are only identified (which costs a CDP attach) when one matches. */
  url: string;
}

export interface PersistedBrowserState {
  version: 1;
  nextNumber: number;
  tabs: PersistedTab[];
  currentTab: Record<string, string>;
  consent?: ConsentSnapshot;
  /** Ids that were given up at a reload (see tabRestore.ts), newest first; never handed out again. */
  retired?: RetiredTab[];
}

export function emptyState(): PersistedBrowserState {
  return { version: 1, nextNumber: 1, tabs: [], currentTab: {} };
}

/** Accepts whatever was stored (possibly from an older or newer build) and returns a valid state. */
export function parseState(raw: unknown): PersistedBrowserState {
  const state = emptyState();
  if (!raw || typeof raw !== 'object' || (raw as any).version !== 1) return state;
  const r = raw as Partial<PersistedBrowserState>;
  if (typeof r.nextNumber === 'number' && r.nextNumber >= 1) state.nextNumber = Math.floor(r.nextNumber);
  if (Array.isArray(r.tabs)) {
    state.tabs = r.tabs.filter(
      t => t && typeof t.id === 'string' && /^tab-\d+$/.test(t.id) && (t.viewId === undefined || typeof t.viewId === 'string') && (t.origin === 'agent' || t.origin === 'user') && typeof t.url === 'string',
    );
  }
  if (Array.isArray(r.retired)) {
    state.retired = r.retired.filter(t => t && typeof t.id === 'string' && /^tab-\d+$/.test(t.id) && typeof t.url === 'string' && (t.reason === 'closed' || t.reason === 'ambiguous'));
  }
  if (r.currentTab && typeof r.currentTab === 'object') {
    for (const [k, v] of Object.entries(r.currentTab)) if (typeof v === 'string') state.currentTab[k] = v;
  }
  if (r.consent && typeof r.consent === 'object') state.consent = r.consent;
  // Never hand out an id that a remembered tab still has.
  for (const t of [...state.tabs, ...(state.retired ?? [])]) state.nextNumber = Math.max(state.nextNumber, tabNumber(t.id) + 1);
  return state;
}

export function tabNumber(id: string): number {
  const n = Number(id.slice(4));
  return Number.isFinite(n) ? n : 0;
}

/** Ids by number, so "tab-10" sorts after "tab-9". */
export function compareTabIds(a: string, b: string): number {
  return tabNumber(a) - tabNumber(b);
}

/** Remembered tabs with a view id that a restored tab showing `url` could be (worth reading its view id for). */
export function candidatesFor(state: PersistedBrowserState, url: string, taken: ReadonlySet<string>): PersistedTab[] {
  return state.tabs.filter(t => t.viewId !== undefined && !taken.has(t.viewId) && (t.url === url || url === '' || url === 'about:blank'));
}
