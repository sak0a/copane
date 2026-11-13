// The UI as data: sessions, tabs and terminals in; the Sessions tree, the status bar item, the view
// badge and the list of things that need the user out. No `vscode` here, so every state is unit-tested
// with fixture data (test/unit/ui-model.test.ts); the glue in tree.ts / statusBar.ts only maps it.
import type { BrowserTabInfo, TerminalInfo } from '../core/services';
import type { AgentSession } from '../core/sessions';
import { Cmd, ExternalCmd } from './ids';

export interface UiInput {
  sessions: readonly AgentSession[];
  tabs: readonly BrowserTabInfo[];
  terminals: readonly TerminalInfo[];
  browserAvailable: boolean;
  /** `agentBridge.sessionGraceSeconds`, for explaining what "disconnected" means. */
  graceSeconds: number;
}

export interface ViewIcon {
  /** Codicon id, e.g. "globe" or "loading~spin". */
  id: string;
  /** Theme color id, e.g. "terminal.ansiBlue". */
  color?: string;
}

export interface ViewCommand {
  command: string;
  title: string;
  args: unknown[];
}

export type NodeKind = 'session' | 'tab' | 'terminal' | 'notice';

export interface ViewNode {
  /** Stable across updates: the tree keeps expansion and selection by it. */
  id: string;
  kind: NodeKind;
  label: string;
  description: string | undefined;
  /** Markdown. */
  tooltip: string;
  icon: ViewIcon;
  /** Space-separated flags matched by `viewItem =~ /\bflag\b/` in contributes/ui.json. */
  contextValue: string;
  accessibilityLabel: string;
  /** What a click on the row does. */
  command: ViewCommand | undefined;
  children: ViewNode[];
  /** What the row is about. */
  ref: { sessionId?: string; tabId?: string; terminalId?: string };
}

export interface AttentionItem {
  kind: 'terminal' | 'tab';
  /** Terminal or tab id. */
  targetId: string;
  icon: ViewIcon;
  label: string;
  description: string;
  detail: string | undefined;
  /** Sessions that wait on it. */
  sessionIds: string[];
}

export interface StatusModel {
  /** Hidden while no agent session exists: the bridge stays out of the way until it is used. */
  visible: boolean;
  text: string;
  /** Markdown, with theme icons and links to UI commands. */
  tooltip: string;
  accessibilityLabel: string;
  /** Uses the warning background: an agent explicitly asked the user for something. */
  warning: boolean;
}

export interface ViewModel {
  roots: ViewNode[];
  nodes: Map<string, ViewNode>;
  parents: Map<string, string>;
  attention: AttentionItem[];
  status: StatusModel;
  /** The view (and activity bar) badge: how many things an agent is blocked on the user for. */
  badge: { value: number; tooltip: string } | undefined;
  /** Shown next to the view title. */
  viewDescription: string | undefined;
}

const WARNING = 'list.warningForeground';
const DISABLED = 'disabledForeground';

// ------------------------------------------------------------------------------------- building

export function buildViewModel(input: UiInput): ViewModel {
  const sessionsById = new Map(input.sessions.map(s => [s.id, s]));
  const name = (id: string | undefined) => (id ? (sessionsById.get(id)?.label ?? 'an ended session') : undefined);
  const tabs = [...input.tabs].sort((a, b) => naturalCompare(a.id, b.id));
  const terminals = [...input.terminals].sort((a, b) => naturalCompare(a.id, b.id));

  const roots: ViewNode[] = [];
  if (!input.browserAvailable && input.sessions.length > 0) roots.push(browserNotice());

  for (const session of input.sessions) {
    const sessionTabs = tabs.filter(t => tabBelongsTo(t, session.id));
    const sessionTerminals = terminals.filter(t => terminalBelongsTo(t, session.id));
    const children = [
      ...sessionTabs.map(t => tabNode(t, session, name)),
      ...sessionTerminals.map(t => terminalNode(t, session)),
    ];
    roots.push(sessionNode(session, sessionTabs, sessionTerminals, children, input.graceSeconds));
  }

  const nodes = new Map<string, ViewNode>();
  const parents = new Map<string, string>();
  const index = (node: ViewNode, parent: ViewNode | undefined) => {
    nodes.set(node.id, node);
    if (parent) parents.set(node.id, parent.id);
    for (const child of node.children) index(child, node);
  };
  for (const root of roots) index(root, undefined);

  const attention = collectAttention(input, tabs, terminals);
  const pausedCount = attention.filter(a => a.kind === 'tab').length;
  const waitingCount = attention.length - pausedCount;
  const badgeParts = [
    waitingCount ? plural(waitingCount, 'terminal is', 'terminals are') + ' waiting for you' : undefined,
    pausedCount ? plural(pausedCount, 'tab is', 'tabs are') + ' paused' : undefined,
  ].filter(isString);

  const connected = input.sessions.filter(s => s.connected).length;
  const disconnected = input.sessions.length - connected;
  return {
    roots,
    nodes,
    parents,
    attention,
    status: buildStatus(input, attention, waitingCount, pausedCount, sessionsById),
    badge: attention.length ? { value: attention.length, tooltip: badgeParts.join(', ') } : undefined,
    viewDescription: input.sessions.length
      ? [connected ? `${connected} connected` : undefined, disconnected ? `${disconnected} reconnecting` : undefined].filter(isString).join(', ')
      : undefined,
  };
}

/** The tree id of a session row. */
export function sessionNodeId(sessionId: string, hasChildren: boolean): string {
  return hasChildren ? `session:${sessionId}` : `session:${sessionId}#empty`;
}

/** A tab is listed under a session that opened it, controls it, or was allowed to use it. */
export function tabBelongsTo(tab: BrowserTabInfo, sessionId: string): boolean {
  return (tab.origin === 'agent' && tab.openedBy === sessionId) || tab.controlledBy === sessionId || tab.allowedSessions.includes(sessionId);
}

/** A terminal is listed under the session that owns it, or under sessions allowed to use it. */
export function terminalBelongsTo(terminal: TerminalInfo, sessionId: string): boolean {
  return (terminal.origin === 'agent' && terminal.ownedBy === sessionId) || (terminal.allowedSessions ?? []).includes(sessionId);
}

function browserNotice(): ViewNode {
  return {
    id: 'notice:browser',
    kind: 'notice',
    label: 'Integrated browser not enabled',
    description: 'agents can use terminals only',
    tooltip:
      "Agent Bridge cannot use VS Code's integrated browser yet, so agents cannot open or control browser tabs.\n\nClick to enable it (VS Code restarts once).",
    icon: { id: 'warning', color: WARNING },
    contextValue: 'notice browserNotice',
    accessibilityLabel: 'Integrated browser not enabled. Agents can use terminals only. Activate to enable it.',
    command: { command: ExternalCmd.enableBrowser, title: 'Enable Integrated Browser', args: [] },
    children: [],
    ref: {},
  };
}

function sessionNode(
  session: AgentSession,
  tabs: BrowserTabInfo[],
  terminals: TerminalInfo[],
  children: ViewNode[],
  graceSeconds: number,
): ViewNode {
  const waiting = terminals.filter(t => t.state === 'waiting-for-user').length;
  const paused = tabs.filter(t => t.paused).length;
  const state = !session.connected ? 'disconnected' : waiting ? 'needs you' : undefined;
  const contents = [tabs.length ? plural(tabs.length, 'tab') : undefined, terminals.length ? plural(terminals.length, 'terminal') : undefined]
    .filter(isString)
    .join(', ');
  const connection = session.connected
    ? 'Connected'
    : `Disconnected. If it does not reconnect within ${graceSeconds} s (for example after a window reload), the session ends and its tabs and terminals are released.`;
  const client = session.client.version ? `${session.client.name} ${session.client.version}` : session.client.name;
  const tooltip = [
    `$(${session.connected ? 'circle-filled' : 'circle-outline'}) **${md(session.label)}**${session.title ? ` · ${md(session.title)}` : ''}`,
    `${connection}  \n${md(client)}${session.pid ? ` · pid ${session.pid}` : ''}`,
    session.cwd ? code(session.cwd) : undefined,
    [
      contents || 'No tabs or terminals yet.',
      waiting ? `${plural(waiting, 'terminal')} waiting for you.` : undefined,
      paused ? `${plural(paused, 'tab')} paused by you.` : undefined,
    ]
      .filter(isString)
      .join(' '),
    `Its tabs and terminals are marked in ${session.color.id}.`,
  ]
    .filter(isString)
    .join('\n\n');
  const flags = [
    'session',
    session.connected ? 'connected' : 'disconnected',
    tabs.some(t => !t.paused) ? 'hasUnpausedTabs' : undefined,
    paused ? 'hasPausedTabs' : undefined,
  ];
  return {
    // A different id while the session has no rows under it: VS Code keeps a former leaf collapsed
    // when it gains children, so the first tab or terminal would otherwise appear hidden.
    id: sessionNodeId(session.id, children.length > 0),
    kind: 'session',
    label: session.label,
    description: [session.title, state].filter(isString).join(' · ') || undefined,
    tooltip,
    icon: { id: session.connected ? 'circle-filled' : 'circle-outline', color: session.color.themeColor },
    contextValue: flags.filter(isString).join(' '),
    accessibilityLabel: [
      `${session.label} agent session`,
      session.title,
      session.connected ? 'connected' : 'disconnected, waiting to reconnect',
      waiting ? `${plural(waiting, 'terminal')} waiting for you` : undefined,
      contents || 'no tabs or terminals',
    ]
      .filter(isString)
      .join(', '),
    command: undefined,
    children,
    ref: { sessionId: session.id },
  };
}

export type TabState = 'paused' | 'controlling' | 'controlled-by-other' | 'idle';

/** The state of a tab as seen from one session. */
export function tabState(tab: BrowserTabInfo, sessionId: string): TabState {
  if (tab.paused) return 'paused';
  if (tab.controlledBy === sessionId) return 'controlling';
  if (tab.controlledBy) return 'controlled-by-other';
  return 'idle';
}

function tabNode(tab: BrowserTabInfo, session: AgentSession, name: (id: string | undefined) => string | undefined): ViewNode {
  const state = tabState(tab, session.id);
  const host = hostOf(tab.url);
  const label = tabTitle(tab) || host || tab.url || 'New tab';
  const stateText = {
    paused: 'paused by you',
    controlling: 'controlling',
    'controlled-by-other': `controlled by ${name(tab.controlledBy)}`,
    idle: 'idle',
  }[state];
  const relation =
    tab.origin === 'user'
      ? 'your tab'
      : tab.openedBy && tab.openedBy !== session.id
        ? `${name(tab.openedBy)}'s tab`
        : tab.openedBy
          ? undefined
          : 'tab of an ended session';
  const description = [stateText, relation, host && host !== label ? host : undefined].filter(isString).join(' · ');
  const opened =
    tab.origin === 'user'
      ? `Your tab. You allowed ${session.label} to use it.`
      : tab.openedBy === session.id
        ? `Opened by ${session.label}.`
        : `Opened by ${name(tab.openedBy) ?? 'an ended session'}.`;
  const control = {
    paused: `**Paused by you.** Agents cannot act on it until you resume it.`,
    controlling: `${session.label} is controlling it.`,
    'controlled-by-other': `${name(tab.controlledBy)} is controlling it.`,
    idle: 'No agent is controlling it right now.',
  }[state];
  const flags = [
    'tab',
    tab.paused ? 'paused' : 'notPaused',
    tab.controlledBy === session.id ? 'releasable' : undefined,
    tab.origin === 'agent' ? 'agentTab' : 'userTab',
  ];
  return {
    id: `session:${session.id}/tab:${tab.id}`,
    kind: 'tab',
    label,
    description,
    tooltip: [`$(globe) **${md(label)}**`, md(tab.url), `${opened} ${control}`].join('\n\n'),
    icon:
      state === 'paused'
        ? { id: 'debug-pause', color: WARNING }
        : state === 'controlling'
          ? { id: 'globe', color: session.color.themeColor }
          : { id: 'globe' },
    contextValue: flags.filter(isString).join(' '),
    accessibilityLabel: [`Browser tab ${label}`, stateText, relation, `used by ${session.label}`].filter(isString).join(', '),
    command: { command: Cmd.revealTab, title: 'Show Tab', args: [tab.id] },
    children: [],
    ref: { sessionId: session.id, tabId: tab.id },
  };
}

function terminalNode(terminal: TerminalInfo, session: AgentSession): ViewNode {
  const label = terminalLabel(terminal.name, session.label);
  const command = terminal.currentCommand ? truncate(terminal.currentCommand.trim(), 60) : undefined;
  const exit = terminal.lastExitCode !== undefined ? `exit ${terminal.lastExitCode}` : undefined;
  const stateText = (() => {
    switch (terminal.state) {
      case 'waiting-for-user':
        return terminal.userInputRequest ? `waiting for you: ${truncate(terminal.userInputRequest, 60)}` : 'waiting for you';
      case 'running':
        return command ? `running ${command}` : 'running';
      case 'idle':
        return exit ? `idle · ${exit}` : 'idle';
      case 'starting':
        return 'starting';
      case 'closed':
        return exit ? `closed · ${exit}` : 'closed';
    }
  })();
  const own = terminal.origin === 'agent';
  const relation = own ? undefined : 'your terminal';
  const icon: ViewIcon =
    terminal.state === 'waiting-for-user'
      ? { id: 'bell-dot', color: WARNING }
      : terminal.state === 'starting'
        ? { id: 'loading~spin' }
        : terminal.state === 'closed'
          ? { id: 'terminal', color: DISABLED }
          : own
            ? { id: 'terminal', color: session.color.themeColor }
            : { id: 'terminal' };
  const interruptible = terminal.state === 'running' || terminal.state === 'waiting-for-user';
  const details = [
    terminal.state === 'waiting-for-user'
      ? `**${md(session.label)} is waiting for you** in this terminal${terminal.userInputRequest ? `: ${md(terminal.userInputRequest)}` : '.'} Click to go there; the agent continues when the command finishes or you say you are done.`
      : undefined,
    terminal.currentCommand ? `Running: ${code(terminal.currentCommand)}` : undefined,
    terminal.state !== 'running' && exit ? `Last command: ${exit}` : undefined,
    terminal.cwd ? code(terminal.cwd) : undefined,
    own ? `Owned by ${md(session.label)}.` : `Your terminal. You allowed ${md(session.label)} to use it.`,
    terminal.shellIntegration ? undefined : 'Shell integration is not active: output and exit codes are not available to the agent.',
  ];
  return {
    id: `session:${session.id}/terminal:${terminal.id}`,
    kind: 'terminal',
    label,
    description: [stateText, relation].filter(isString).join(' · '),
    tooltip: [`$(terminal) **${md(terminal.name)}**`, ...details.filter(isString)].join('\n\n'),
    icon,
    contextValue: ['terminal', interruptible ? 'interruptible' : undefined, terminal.state === 'closed' ? 'closed' : 'open', own ? 'agentTerminal' : 'userTerminal']
      .filter(isString)
      .join(' '),
    accessibilityLabel: [`Terminal ${label}`, stateText, relation, `used by ${session.label}`].filter(isString).join(', '),
    command: {
      command: Cmd.revealTerminal,
      title: 'Show Terminal',
      // Someone clicking a terminal that waits for them wants to type in it.
      args: [terminal.id, { preserveFocus: terminal.state !== 'waiting-for-user' }],
    },
    children: [],
    ref: { sessionId: session.id, terminalId: terminal.id },
  };
}

// ------------------------------------------------------------------------------------- attention

/**
 * What an agent is blocked on the user for. A terminal waiting for the user is an explicit request
 * (warning color in the status bar). A paused tab is the user's own doing, but an agent cannot use it
 * until it is resumed, so it is listed and counted in the badge, without the warning background.
 * Disconnected sessions, failed commands and busy tabs are not the user's job and only show in rows.
 */
function collectAttention(input: UiInput, tabs: BrowserTabInfo[], terminals: TerminalInfo[]): AttentionItem[] {
  const label = (id: string) => input.sessions.find(s => s.id === id)?.label ?? id;
  const items: AttentionItem[] = [];
  for (const terminal of terminals) {
    if (terminal.state !== 'waiting-for-user') continue;
    const sessionIds = input.sessions.filter(s => terminalBelongsTo(terminal, s.id)).map(s => s.id);
    if (!sessionIds.length) continue;
    items.push({
      kind: 'terminal',
      targetId: terminal.id,
      icon: { id: 'bell-dot', color: WARNING },
      label: `${joinNames(sessionIds.map(label))} ${sessionIds.length > 1 ? 'are' : 'is'} waiting for you`,
      description: terminal.name,
      detail: terminal.userInputRequest ?? (terminal.currentCommand ? `in: ${terminal.currentCommand}` : undefined),
      sessionIds,
    });
  }
  for (const tab of tabs) {
    if (!tab.paused) continue;
    const sessionIds = input.sessions.filter(s => tabBelongsTo(tab, s.id)).map(s => s.id);
    if (!sessionIds.length) continue;
    const title = tabTitle(tab) || hostOf(tab.url) || tab.url;
    items.push({
      kind: 'tab',
      targetId: tab.id,
      icon: { id: 'debug-pause', color: WARNING },
      label: `"${title}" is paused`,
      description: `${joinNames(sessionIds.map(label))} cannot use it until you resume it`,
      detail: tab.url,
      sessionIds,
    });
  }
  return items;
}

function buildStatus(
  input: UiInput,
  attention: AttentionItem[],
  waiting: number,
  paused: number,
  sessionsById: Map<string, AgentSession>,
): StatusModel {
  const total = input.sessions.length;
  const connected = input.sessions.filter(s => s.connected).length;
  const disconnected = total - connected;
  if (total === 0) {
    return { visible: false, text: '$(robot) 0', tooltip: '**Agent Bridge**\n\nNo agent session is connected to this window.', accessibilityLabel: 'Agent Bridge: no agent sessions', warning: false };
  }

  let text: string;
  if (waiting) {
    const first = attention.find(a => a.kind === 'terminal')!;
    const who = sessionsById.get(first.sessionIds[0]!)?.label ?? 'An agent';
    text = waiting === 1 ? `$(bell-dot) ${who} needs you` : `$(bell-dot) ${waiting} need you`;
  } else {
    text = `$(robot) ${connected}`;
    if (disconnected) text += ` $(debug-disconnect) ${disconnected}`;
    if (paused) text += ` $(debug-pause) ${paused}`;
  }

  const sessionLines = input.sessions.map(s => {
    const parts = [
      s.title ? md(s.title) : undefined,
      s.connected ? undefined : 'disconnected',
      ...(() => {
        const tabs = input.tabs.filter(t => tabBelongsTo(t, s.id)).length;
        const terms = input.terminals.filter(t => terminalBelongsTo(t, s.id)).length;
        return [tabs ? plural(tabs, 'tab') : undefined, terms ? plural(terms, 'terminal') : undefined];
      })(),
    ].filter(isString);
    return `$(${s.connected ? 'circle-filled' : 'circle-outline'}) **${md(s.label)}**${parts.length ? ` · ${parts.join(' · ')}` : ''}`;
  });
  const attentionLines = attention.map(a => `$(${a.icon.id}) ${md(a.label)}: ${md(a.description)}`);
  const links = [
    `[Show Sessions](command:${Cmd.focusSessions})`,
    attention.length ? `[Go to What Needs You](command:${Cmd.showAttention})` : undefined,
  ].filter(isString);
  const tooltip = [
    `**Agent Bridge** · ${plural(connected, 'session')} connected${disconnected ? `, ${disconnected} reconnecting` : ''}`,
    sessionLines.join('  \n'),
    attentionLines.length ? attentionLines.join('  \n') : undefined,
    links.join(' · '),
  ]
    .filter(isString)
    .join('\n\n');

  const accessibilityLabel = [
    `Agent Bridge: ${plural(connected, 'agent session')} connected`,
    disconnected ? `${disconnected} reconnecting` : undefined,
    waiting ? `${plural(waiting, 'terminal')} waiting for you` : undefined,
    paused ? `${plural(paused, 'tab')} paused` : undefined,
  ]
    .filter(isString)
    .join(', ');

  return { visible: true, text, tooltip, accessibilityLabel, warning: waiting > 0 };
}

// ------------------------------------------------------------------------------------- updates

/** Which tree elements changed between two models: the whole tree (`full`) or these node ids. */
export function diffModels(prev: ViewModel | undefined, next: ViewModel): { full: boolean; changed: string[] } {
  if (!prev) return { full: true, changed: [] };
  const rootIds = (m: ViewModel) => m.roots.map(r => r.id).join('\n');
  if (rootIds(prev) !== rootIds(next)) return { full: true, changed: [] };
  const changed: string[] = [];
  for (const [id, node] of next.nodes) {
    const before = prev.nodes.get(id);
    if (!before) continue; // new nodes appear through their parent's change
    if (nodeSignature(before) !== nodeSignature(node)) changed.push(id);
  }
  return { full: false, changed };
}

/** Everything about a node that is rendered, including the ids (not contents) of its children. */
export function nodeSignature(node: ViewNode): string {
  const { children, ...rest } = node;
  return JSON.stringify({ ...rest, children: children.map(c => c.id) });
}

/** A signature of the parts of the model outside the tree. */
export function chromeSignature(model: ViewModel): string {
  return JSON.stringify({ status: model.status, badge: model.badge, description: model.viewDescription, attention: model.attention });
}

/** Renders the tree as indented text (debug tool output and tests). */
export function treeAsText(model: ViewModel): string {
  const lines: string[] = [];
  const walk = (node: ViewNode, depth: number) => {
    const icon = node.icon.color ? `${node.icon.id}:${node.icon.color}` : node.icon.id;
    lines.push(`${'  '.repeat(depth)}${node.label}${node.description ? ` — ${node.description}` : ''}  [${icon}]`);
    for (const child of node.children) walk(child, depth + 1);
  };
  for (const root of model.roots) walk(root, 0);
  return lines.join('\n');
}

// ------------------------------------------------------------------------------------- helpers

/** The page title without the " (url)" suffix the browser adds to some titles. */
export function tabTitle(tab: { title: string; url: string }): string {
  const title = tab.title.trim();
  const suffix = ` (${tab.url})`;
  return title.endsWith(suffix) ? title.slice(0, -suffix.length).trim() : title;
}

/**
 * A terminal's name under its session's row, without a leading session label ("Claude 1 · tests"
 * becomes "tests"): the row above already says whose it is.
 */
export function terminalLabel(name: string, sessionLabel: string): string {
  if (!name.startsWith(sessionLabel)) return name;
  const rest = name.slice(sessionLabel.length).replace(/^\s*[·:|\-–—]\s*/, '');
  return rest && rest !== name.slice(sessionLabel.length) ? rest : name;
}

export function hostOf(url: string): string | undefined {
  try {
    const u = new URL(url);
    return u.host || (u.protocol === 'file:' ? u.pathname.split('/').pop() : undefined) || undefined;
  } catch {
    return undefined;
  }
}

export function plural(n: number, one: string, many?: string): string {
  return `${n} ${n === 1 ? one : (many ?? `${one}s`)}`;
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function truncate(value: string, max: number): string {
  const oneLine = value.replace(/\s+/g, ' ');
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/** Escapes text for Markdown tooltips (titles and URLs come from agents and web pages). */
export function md(value: string): string {
  return value.replace(/[\\`*_{}[\]()#+\-.!|<>$~]/g, ch => `\\${ch}`);
}

/** A Markdown code span (backslash escapes do not apply inside one). */
function code(value: string): string {
  const oneLine = value.replace(/\s+/g, ' ');
  return oneLine.includes('`') ? `\`\` ${oneLine} \`\`` : `\`${oneLine}\``;
}

function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true });
}

function isString(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}
