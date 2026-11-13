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
