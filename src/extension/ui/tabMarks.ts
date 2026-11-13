// Short markers for things an agent has turned on in a tab that change how the page looks or behaves
// for the user too: device emulation, mocked requests, a download in progress. Shown in both views.
import type { BrowserTabInfo } from '../core/services';

export function tabMarks(tab: BrowserTabInfo): string[] {
  const marks: string[] = [];
  if (tab.emulation) marks.push(`emulating ${tab.emulation.label}`);
  const rules = (tab.requestRules ?? []).reduce((sum, r) => sum + r.rules, 0);
  if (rules > 0) marks.push(`${rules} mocked ${rules === 1 ? 'request rule' : 'request rules'}`);
  const active = (tab.downloads ?? []).find(d => d.state === 'downloading' || d.state === 'waiting-for-user');
  if (active) marks.push(active.state === 'waiting-for-user' ? `download waiting for you: ${active.name}` : `downloading ${active.name}${active.progress !== undefined ? ` ${Math.round(active.progress)}%` : ''}`);
  return marks;
}

/**
 * The login profile of a tab, short, for a row: "profile dev", "private profile" (on the row of the
 * session it is private to), "own login store". Undefined for the window's default store.
 */
export function profileMark(tab: BrowserTabInfo, rowSessionId?: string): string | undefined {
  const p = tab.profile;
  if (!p) return undefined;
  if (p.kind === 'detached') return 'own login store';
  if (p.kind === 'private' && rowSessionId !== undefined && p.name === `private:${rowSessionId}`) return 'private profile';
  return `profile ${p.label}`;
}
