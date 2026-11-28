// The "Agent Tabs" view in the bottom panel, as data: every browser tab an agent session uses, one row
// per tab, in the color of the session it belongs to. Tab-first, where the Sessions view is
// session-first: rows are not nested under sessions but sorted by them, so a session's tabs sit
// together and its color runs down the list as a band. Tabs no live session uses are left out: they
// belong to nobody here and the editor area already shows them. No `vscode` here (unit-tested in
// test/unit/ui-panel.test.ts); panel.ts maps it to a TreeView.
import { profileMark, tabMarks } from './tabMarks';
import type { BrowserTabInfo } from '../core/services';
import type { AgentSession } from '../core/sessions';
import { Cmd } from './ids';
import { hostOf, md, plural, tabBelongsTo, tabTitle, withImage, type ViewIcon, type ViewNode } from './model';

export interface PanelInput {
  sessions: readonly AgentSession[];
  tabs: readonly BrowserTabInfo[];
  /** Key of the checked site icon of each tab that has one, by tab id (see `UiInput.tabIcons`). */
  tabIcons?: ReadonlyMap<string, string>;
}

export interface PanelModel {
  /** Flat: one row per tab, no children. */
  roots: ViewNode[];
  nodes: Map<string, ViewNode>;
  /** Shown next to the view title, e.g. "5 tabs, 3 sessions". Undefined while empty. */
  description: string | undefined;
}

export type PanelTabState = 'controlling' | 'idle' | 'paused' | 'waiting';

/** The id of a tab's row in the panel. Stable while the tab exists, whichever session it moves to. */
export function panelTabNodeId(tabId: string): string {
  return `tab:${tabId}`;
}

/**
 * The session a tab is shown under: the one waiting for the user in it, the one controlling it, else the live session that opened it,
 * else the first live session (in session order) the user allowed to use it. Undefined when no live
 * session uses it.
 */
export function tabOwner(tab: BrowserTabInfo, sessions: readonly AgentSession[]): AgentSession | undefined {
  const live = (id: string | undefined) => (id ? sessions.find(s => s.id === id) : undefined);
  return live(tab.request?.sessionId) ?? live(tab.controlledBy) ?? (tab.origin === 'agent' ? live(tab.openedBy) : undefined) ?? sessions.find(s => tabBelongsTo(tab, s.id));
}

export function panelTabState(tab: BrowserTabInfo): PanelTabState {
  if (tab.request) return 'waiting';
  if (tab.paused) return 'paused';
  return tab.controlledBy ? 'controlling' : 'idle';
}

const STATE_TEXT: Record<PanelTabState, string> = { controlling: 'controlling', idle: 'idle', paused: 'paused by you', waiting: 'waiting for you' };

/**
 * The shape says what the session is doing with the tab, the color says which session it is: a filled
 * dot while it controls the tab, a ring while it only has it, a pause sign while the user holds it.
 */
const STATE_ICON: Record<PanelTabState, string> = { controlling: 'circle-large-filled', idle: 'circle-large-outline', paused: 'debug-pause', waiting: 'bell-dot' };

export function buildPanelModel(input: PanelInput): PanelModel {
  const order = new Map(input.sessions.map((s, i) => [s.id, i]));
  const rows: Array<{ tab: BrowserTabInfo; owner: AgentSession }> = [];
  for (const tab of input.tabs) {
    const owner = tabOwner(tab, input.sessions);
    if (owner) rows.push({ tab, owner });
  }
  rows.sort((a, b) => order.get(a.owner.id)! - order.get(b.owner.id)! || naturalCompare(a.tab.id, b.tab.id));

  // The session's title only on the first row of its band: repeated on every row it is noise, and the
  // label and color already say whose the following rows are.
  const roots = rows.map(({ tab, owner }, i) => tabRow(tab, owner, input.sessions, i === 0 || rows[i - 1]!.owner.id !== owner.id, input.tabIcons?.get(tab.id)));
  const sessionCount = new Set(rows.map(r => r.owner.id)).size;
  return {
    roots,
    nodes: new Map(roots.map(n => [n.id, n])),
    description: rows.length ? `${plural(rows.length, 'tab')}, ${plural(sessionCount, 'session')}` : undefined,
  };
}

function tabRow(tab: BrowserTabInfo, owner: AgentSession, sessions: readonly AgentSession[], firstOfSession: boolean, image?: string): ViewNode {
  const state = panelTabState(tab);
  const host = hostOf(tab.url);
  const label = tabTitle(tab) || host || tab.url || 'New tab';
  const others = sessions.filter(s => s.id !== owner.id && tabBelongsTo(tab, s.id));
  const opener = tab.origin === 'agent' && tab.openedBy && tab.openedBy !== owner.id ? sessions.find(s => s.id === tab.openedBy) : undefined;

  // What the row is about first (whose, then what it is doing), the details that can be cut last:
  // a narrow panel truncates the description from the end.
  const relation = tab.origin === 'user' ? 'your tab' : opener ? `opened by ${opener.label}` : undefined;
  const description = [
    owner.label,
    firstOfSession && owner.title ? owner.autoLabel : undefined,
    owner.connected ? undefined : owner.away ? 'away' : 'reconnecting',
    state === 'waiting' ? `${STATE_TEXT[state]}: ${truncate(tab.request!.message, 60)}` : STATE_TEXT[state],
    profileMark(tab, owner.id),
    ...tabMarks(tab),
    relation,
    others.length ? `shared with ${others.map(s => s.label).join(', ')}` : undefined,
    host && host !== label ? host : undefined,
  ]
    .filter(isString)
    .join(' · ');

  // The site's icon replaces the state shape while the agent has or controls the tab (the description
  // says which); a tab paused by or waiting for the user keeps its sign.
  const base: ViewIcon = { id: STATE_ICON[state], color: owner.color.themeColor };
  const icon = state === 'controlling' || state === 'idle' ? withImage(base, image) : base;
  const control = {
    controlling: `**${md(owner.label)} is controlling it.**`,
    idle: `${md(owner.label)} is not controlling it right now.`,
    paused: `**Paused by you.** Agents cannot act on it until you resume it.`,
    waiting: `**${md(owner.label)} is waiting for you** in this tab: ${md(tab.request?.message ?? '')} Click Done in the page when you are finished.`,
  }[state];
  const opened =
    tab.origin === 'user'
      ? `Your tab, shared with ${md([owner, ...others].map(s => s.label).join(', '))}.`
      : `Opened by ${md(opener?.label ?? (tab.openedBy === owner.id ? owner.label : 'an ended session'))}.`;
  const tooltip = [
    `$(globe) **${md(label)}**`,
    md(tab.url),
    `$(circle-large-filled) ${md(owner.label)}${owner.title ? ` · ${md(owner.autoLabel)}` : ''}${owner.connected ? '' : owner.away ? ' (away)' : ' (reconnecting)'}`,
    `${control} ${opened}${others.length ? ` Also used by ${md(others.map(s => s.label).join(', '))}.` : ''}`,
    tab.profile ? `$(account) ${md(tab.profile.description)}` : undefined,
    'Click to show the tab.',
  ]
    .filter(isString)
    .join('\n\n');

  const flags = ['tab', tab.request ? 'waitingForUser' : tab.paused ? 'paused' : 'notPaused', tab.controlledBy ? 'releasable' : undefined, tab.origin === 'agent' ? 'agentTab' : 'userTab'];
  return {
    id: panelTabNodeId(tab.id),
    kind: 'tab',
    label,
    description,
    tooltip,
    icon,
    contextValue: flags.filter(isString).join(' '),
    accessibilityLabel: [
      `Browser tab ${label}`,
      `${owner.label}${owner.title ? ` (${owner.autoLabel})` : ''}`,
      owner.connected ? undefined : owner.away ? 'away' : 'reconnecting',
      STATE_TEXT[state],
      profileMark(tab, owner.id),
      relation,
      others.length ? `shared with ${others.map(s => s.label).join(', ')}` : undefined,
      host && host !== label ? host : undefined,
    ]
      .filter(isString)
      .join(', '),
    command: { command: Cmd.revealTab, title: 'Show Tab', args: [tab.id] },
    children: [],
    // `sessionId` is the session a row action is about: the controller for "release", the owner for "show session".
    ref: { sessionId: owner.id, tabId: tab.id },
  };
}

/** Renders the panel as text (debug tool output and tests). */
export function panelAsText(model: PanelModel): string {
  return model.roots.map(n => `${n.label} — ${n.description}  [${n.icon.id}:${n.icon.color}${n.icon.image ? ` ${n.icon.image}` : ''}]`).join('\n');
}

function truncate(value: string, max: number): string {
  const oneLine = value.replace(/\s+/g, ' ');
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true });
}

function isString(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}
