import { describe, expect, it } from 'vitest';
import type { BrowserTabInfo, TerminalInfo } from '../../src/extension/core/services';
import { SESSION_COLORS, type AgentSession } from '../../src/extension/core/sessions';
import { Cmd, ExternalCmd } from '../../src/extension/ui/ids';
import { buildViewModel, chromeSignature, diffModels, hostOf, md, tabState, tabTitle, terminalLabel, treeAsText, type UiInput } from '../../src/extension/ui/model';

function session(n: number, extra: Partial<AgentSession> = {}): AgentSession {
  return {
    id: `s${n}`,
    client: { name: 'claude-code', version: '2.1.0', kind: 'claude-code' },
    number: n,
    label: `Claude ${n}`,
    badge: `C${n}`,
    color: SESSION_COLORS[(n - 1) % SESSION_COLORS.length]!,
    title: undefined,
    pid: 1000 + n,
    cwd: '/work/app',
    createdAt: n,
    lastActivityAt: n,
    connected: true,
    ...extra,
  };
}

function tab(id: string, extra: Partial<BrowserTabInfo> = {}): BrowserTabInfo {
  return {
    id,
    url: 'http://localhost:3000/login',
    title: 'Login',
    active: false,
    origin: 'agent',
    openedBy: undefined,
    controlledBy: undefined,
    allowedSessions: [],
    paused: false,
    ...extra,
  };
}

function terminal(id: string, extra: Partial<TerminalInfo> = {}): TerminalInfo {
  return {
    id,
    name: 'zsh',
    origin: 'agent',
    ownedBy: undefined,
    state: 'idle',
    shellIntegration: true,
    cwd: '/work/app',
    currentCommand: undefined,
    lastExitCode: undefined,
    ...extra,
  };
}

function input(extra: Partial<UiInput> = {}): UiInput {
  return { sessions: [], tabs: [], terminals: [], browserAvailable: true, graceSeconds: 20, ...extra };
}

const row = (model: ReturnType<typeof buildViewModel>, id: string) => {
  const node = model.nodes.get(id);
  if (!node) throw new Error(`no row ${id}; have ${[...model.nodes.keys()].join(', ')}`);
  return node;
};

describe('empty and setup states', () => {
  it('has no rows and a hidden status bar item without sessions', () => {
    const model = buildViewModel(input());
    expect(model.roots).toEqual([]);
    expect(model.status.visible).toBe(false);
    expect(model.badge).toBeUndefined();
    expect(model.viewDescription).toBeUndefined();
  });

  it('leaves the "browser not enabled" message to welcome content while nothing is connected', () => {
    expect(buildViewModel(input({ browserAvailable: false })).roots).toEqual([]);
  });

  it('shows a clickable notice row on top when sessions exist but the browser API is off', () => {
    const model = buildViewModel(input({ browserAvailable: false, sessions: [session(1)] }));
    const notice = model.roots[0]!;
    expect(notice.kind).toBe('notice');
    expect(notice.command?.command).toBe(ExternalCmd.enableBrowser);
    expect(model.roots[1]!.kind).toBe('session');
  });
});

describe('session rows', () => {
  it('shows label, title, color and connection state', () => {
    const model = buildViewModel(input({ sessions: [session(1, { title: 'fixing login' }), session(2, { connected: false })] }));
    const a = row(model, 'session:s1#empty');
    expect(a.label).toBe('Claude 1');
    expect(a.description).toBe('fixing login');
    expect(a.icon).toEqual({ id: 'circle-filled', color: 'terminal.ansiBlue' });
    expect(a.contextValue.split(' ')).toContain('connected');
    const b = row(model, 'session:s2#empty');
    expect(b.description).toBe('disconnected');
    expect(b.icon).toEqual({ id: 'circle-outline', color: 'terminal.ansiMagenta' });
    expect(b.tooltip).toContain('within 20 s');
    expect(b.accessibilityLabel).toContain('waiting to reconnect');
    expect(model.viewDescription).toBe('1 connected, 1 reconnecting');
  });

  it('keeps sessions in the order they connected', () => {
    const model = buildViewModel(input({ sessions: [session(1), session(2), session(3)] }));
    expect(model.roots.map(r => r.label)).toEqual(['Claude 1', 'Claude 2', 'Claude 3']);
  });

  it('says "needs you" on the session when one of its terminals waits for the user', () => {
    const model = buildViewModel(input({ sessions: [session(1, { title: 'deploy' })], terminals: [terminal('term-1', { ownedBy: 's1', state: 'waiting-for-user' })] }));
    expect(row(model, 'session:s1').description).toBe('deploy · needs you');
  });

  it('escapes agent-provided text in tooltips', () => {
    const model = buildViewModel(input({ sessions: [session(1, { title: '**bold** [x](command:evil)' })] }));
    const tooltip = row(model, 'session:s1#empty').tooltip;
    expect(tooltip).not.toContain('[x](command:evil)');
    expect(tooltip).toContain('\\[x\\]\\(command:evil\\)');
  });
});

describe('tab rows', () => {
  const s1 = session(1);
  const s2 = session(2);

  it('lists the tabs a session opened, with live state', () => {
    const model = buildViewModel(
      input({
        sessions: [s1],
        tabs: [
          tab('tab-1', { openedBy: 's1', controlledBy: 's1' }),
          tab('tab-2', { openedBy: 's1', title: '', url: 'https://example.com/a' }),
          tab('tab-10', { openedBy: 's1', paused: true }),
        ],
      }),
    );
    expect(row(model, 'session:s1').children.map(c => c.id)).toEqual(['session:s1/tab:tab-1', 'session:s1/tab:tab-2', 'session:s1/tab:tab-10']);
    const controlling = row(model, 'session:s1/tab:tab-1');
    expect(controlling.description).toBe('controlling · localhost:3000');
    expect(controlling.icon).toEqual({ id: 'globe', color: 'terminal.ansiBlue' });
    expect(controlling.contextValue.split(' ')).toEqual(expect.arrayContaining(['tab', 'notPaused', 'releasable']));
    expect(controlling.command).toEqual({ command: Cmd.revealTab, title: 'Show Tab', args: ['tab-1'] });

    const idle = row(model, 'session:s1/tab:tab-2');
    expect(idle.label).toBe('example.com');
    expect(idle.description).toBe('idle');
    expect(idle.icon).toEqual({ id: 'globe' });
    expect(idle.contextValue.split(' ')).not.toContain('releasable');

    const paused = row(model, 'session:s1/tab:tab-10');
    expect(paused.description).toBe('paused by you · localhost:3000');
    expect(paused.icon.id).toBe('debug-pause');
    expect(paused.contextValue.split(' ')).toContain('paused');
    expect(paused.contextValue.split(' ')).not.toContain('notPaused');
  });

  it('shows user tabs a session may use as "your tab"', () => {
    const model = buildViewModel(input({ sessions: [s1], tabs: [tab('tab-1', { origin: 'user', allowedSessions: ['s1'] })] }));
    const r = row(model, 'session:s1/tab:tab-1');
    expect(r.description).toBe('idle · your tab · localhost:3000');
    expect(r.tooltip).toContain('You allowed Claude 1 to use it');
    expect(r.contextValue.split(' ')).toContain('userTab');
  });

  it('does not list user tabs no agent may use', () => {
    const model = buildViewModel(input({ sessions: [s1], tabs: [tab('tab-1', { origin: 'user' })] }));
    expect(row(model, 'session:s1#empty').children).toEqual([]);
  });

  it('lists a tab under both its opener and the session controlling it', () => {
    const model = buildViewModel(input({ sessions: [s1, s2], tabs: [tab('tab-1', { openedBy: 's1', controlledBy: 's2', allowedSessions: ['s1', 's2'] })] }));
    expect(row(model, 'session:s1/tab:tab-1').description).toBe('controlled by Claude 2 · localhost:3000');
    expect(row(model, 'session:s2/tab:tab-1').description).toBe("controlling · Claude 1's tab · localhost:3000");
    expect(row(model, 'session:s2/tab:tab-1').icon.color).toBe(s2.color.themeColor);
  });

  it('computes the tab state per session', () => {
    expect(tabState(tab('t', { paused: true, controlledBy: 's1' }), 's1')).toBe('paused');
    expect(tabState(tab('t', { controlledBy: 's1' }), 's1')).toBe('controlling');
    expect(tabState(tab('t', { controlledBy: 's1' }), 's2')).toBe('controlled-by-other');
    expect(tabState(tab('t'), 's1')).toBe('idle');
  });
});

describe('terminal rows', () => {
  const s1 = session(1);
  const build = (t: Partial<TerminalInfo>) => row(buildViewModel(input({ sessions: [s1], terminals: [terminal('term-1', { ownedBy: 's1', ...t })] })), 'session:s1/terminal:term-1');

  it('running: shows the command, in the session color, and can be interrupted', () => {
    const r = build({ state: 'running', currentCommand: 'npm test -- --watch' });
    expect(r.description).toBe('running npm test -- --watch');
    expect(r.icon).toEqual({ id: 'terminal', color: 'terminal.ansiBlue' });
    expect(r.contextValue.split(' ')).toEqual(expect.arrayContaining(['terminal', 'interruptible', 'open']));
    expect(r.command).toEqual({ command: Cmd.revealTerminal, title: 'Show Terminal', args: ['term-1', { preserveFocus: true }] });
  });

  it('idle: shows the last exit code', () => {
    expect(build({ state: 'idle', lastExitCode: 1 }).description).toBe('idle · exit 1');
    expect(build({ state: 'idle' }).description).toBe('idle');
    expect(build({ state: 'idle' }).contextValue.split(' ')).not.toContain('interruptible');
  });

  it('waiting for the user: stands out, says what is needed, and gives focus when clicked', () => {
    const r = build({ state: 'waiting-for-user', currentCommand: 'npm login', userInputRequest: 'Log in to npm' });
    expect(r.description).toBe('waiting for you: Log in to npm');
    expect(r.icon).toEqual({ id: 'bell-dot', color: 'list.warningForeground' });
    expect(r.command?.args).toEqual(['term-1', { preserveFocus: false }]);
  });

  it('starting and closed', () => {
    expect(build({ state: 'starting' }).icon.id).toBe('loading~spin');
    const closed = build({ state: 'closed', lastExitCode: 0 });
    expect(closed.description).toBe('closed · exit 0');
    expect(closed.contextValue.split(' ')).toContain('closed');
    expect(closed.contextValue.split(' ')).not.toContain('open');
  });

  it('truncates long commands to one line', () => {
    const r = build({ state: 'running', currentCommand: `echo ${'x'.repeat(100)}\nnext` });
    expect(r.description!.length).toBeLessThanOrEqual('running '.length + 60);
    expect(r.description).toMatch(/…$/);
  });

  it('mentions missing shell integration in the tooltip', () => {
    expect(build({ shellIntegration: false }).tooltip).toContain('Shell integration is not active');
  });

  it('shows user terminals a session may use as "your terminal", without the session color', () => {
    const model = buildViewModel(input({ sessions: [s1], terminals: [terminal('term-2', { origin: 'user', allowedSessions: ['s1'] }), terminal('term-3', { origin: 'user' })] }));
    expect(row(model, 'session:s1').children.map(c => c.id)).toEqual(['session:s1/terminal:term-2']);
    const r = row(model, 'session:s1/terminal:term-2');
    expect(r.description).toBe('idle · your terminal');
    expect(r.icon).toEqual({ id: 'terminal' });
  });

  it('lists tabs before terminals', () => {
    const model = buildViewModel(input({ sessions: [s1], tabs: [tab('tab-1', { openedBy: 's1' })], terminals: [terminal('term-1', { ownedBy: 's1' })] }));
    expect(row(model, 'session:s1').children.map(c => c.kind)).toEqual(['tab', 'terminal']);
  });
});

describe('attention, badge and status bar', () => {
  const s1 = session(1, { title: 'deploy' });
  const s2 = session(2);

  it('shows the connected count quietly when nothing needs the user', () => {
    const model = buildViewModel(input({ sessions: [s1, s2] }));
    expect(model.status).toMatchObject({ visible: true, text: '$(robot) 2', warning: false });
    expect(model.status.accessibilityLabel).toBe('Copane: 2 agent sessions connected');
    expect(model.attention).toEqual([]);
    expect(model.badge).toBeUndefined();
  });

  it('counts disconnected sessions separately', () => {
    const model = buildViewModel(input({ sessions: [s1, session(2, { connected: false })] }));
    expect(model.status.text).toBe('$(robot) 1 $(debug-disconnect) 1');
    expect(model.status.tooltip).toContain('1 reconnecting');
  });

  it('a waiting terminal names the session, uses the warning background and is first in the list', () => {
    const model = buildViewModel(
      input({
        sessions: [s1, s2],
        tabs: [tab('tab-1', { openedBy: 's1', paused: true })],
        terminals: [terminal('term-1', { ownedBy: 's2', state: 'waiting-for-user', userInputRequest: 'Enter the 2FA code' })],
      }),
    );
    expect(model.status.text).toBe('$(bell-dot) Claude 2 needs you');
    expect(model.status.warning).toBe(true);
    expect(model.attention.map(a => [a.kind, a.targetId])).toEqual([
      ['terminal', 'term-1'],
      ['tab', 'tab-1'],
    ]);
    expect(model.attention[0]).toMatchObject({ label: 'Claude 2 is waiting for you', description: 'zsh', detail: 'Enter the 2FA code', sessionIds: ['s2'] });
    expect(model.attention[1]).toMatchObject({ label: '"Login" is paused', description: 'Claude 1 cannot use it until you resume it' });
    expect(model.badge).toEqual({ value: 2, tooltip: '1 terminal is waiting for you, 1 tab is paused' });
    expect(model.status.accessibilityLabel).toBe('Copane: 2 agent sessions connected, 1 terminal waiting for you, 1 tab paused');
    expect(model.status.tooltip).toContain(`command:${Cmd.showAttention}`);
  });

  it('several waiting terminals are counted', () => {
    const model = buildViewModel(
      input({
        sessions: [s1, s2],
        terminals: [terminal('term-1', { ownedBy: 's1', state: 'waiting-for-user' }), terminal('term-2', { ownedBy: 's2', state: 'waiting-for-user' })],
      }),
    );
    expect(model.status.text).toBe('$(bell-dot) 2 need you');
  });

  it('a paused tab is listed and counted but does not turn the status bar into a warning', () => {
    const model = buildViewModel(input({ sessions: [s1], tabs: [tab('tab-1', { openedBy: 's1', paused: true })] }));
    expect(model.status.text).toBe('$(robot) 1 $(debug-pause) 1');
    expect(model.status.warning).toBe(false);
    expect(model.badge?.value).toBe(1);
  });

  it('a tab shared by two sessions is one attention item naming both', () => {
    const model = buildViewModel(input({ sessions: [s1, s2], tabs: [tab('tab-1', { openedBy: 's1', allowedSessions: ['s1', 's2'], paused: true })] }));
    expect(model.attention).toHaveLength(1);
    expect(model.attention[0]!.description).toBe('Claude 1 and Claude 2 cannot use it until you resume it');
  });

  it('ignores paused tabs and waiting terminals no current session uses', () => {
    const model = buildViewModel(input({ sessions: [s1], tabs: [tab('tab-1', { origin: 'user', paused: true })], terminals: [terminal('term-1', { ownedBy: 'gone', state: 'waiting-for-user' })] }));
    expect(model.attention).toEqual([]);
  });
});

describe('updates', () => {
  const base = input({ sessions: [session(1)], tabs: [tab('tab-1', { openedBy: 's1' })], terminals: [terminal('term-1', { ownedBy: 's1' })] });

  it('reports nothing when the same state is built twice', () => {
    const a = buildViewModel(base);
    const b = buildViewModel(base);
    expect(diffModels(a, b)).toEqual({ full: false, changed: [] });
    expect(chromeSignature(a)).toBe(chromeSignature(b));
  });

  it('refreshes only the row whose state changed', () => {
    const a = buildViewModel(base);
    const b = buildViewModel({ ...base, tabs: [tab('tab-1', { openedBy: 's1', controlledBy: 's1' })] });
    expect(diffModels(a, b)).toEqual({ full: false, changed: ['session:s1/tab:tab-1'] });
  });

  it('refreshes the parent when a child appears or disappears', () => {
    const a = buildViewModel(base);
    const b = buildViewModel({ ...base, tabs: [] });
    expect(diffModels(a, b).changed).toContain('session:s1');
    expect(diffModels(b, a).changed).toContain('session:s1');
  });

  it('gives an empty session row its own id, so its first child shows up expanded', () => {
    const empty = buildViewModel({ ...base, tabs: [], terminals: [] });
    expect(empty.roots.map(r => r.id)).toEqual(['session:s1#empty']);
    const filled = buildViewModel(base);
    expect(filled.roots.map(r => r.id)).toEqual(['session:s1']);
    expect(diffModels(empty, filled).full).toBe(true);
  });

  it('refreshes the whole tree when sessions come or go', () => {
    const a = buildViewModel(base);
    const b = buildViewModel({ ...base, sessions: [session(1), session(2)] });
    expect(diffModels(a, b).full).toBe(true);
    expect(diffModels(undefined, a).full).toBe(true);
  });

  it('keeps node ids stable across rebuilds', () => {
    const a = buildViewModel(base);
    const b = buildViewModel({ ...base, terminals: [terminal('term-1', { ownedBy: 's1', state: 'running', currentCommand: 'make' })] });
    expect([...a.nodes.keys()]).toEqual([...b.nodes.keys()]);
    expect(b.parents.get('session:s1/terminal:term-1')).toBe('session:s1');
  });
});

describe('helpers', () => {
  it('renders the tree as text', () => {
    const model = buildViewModel(input({ sessions: [session(1, { title: 'x' })], tabs: [tab('tab-1', { openedBy: 's1', controlledBy: 's1' })] }));
    expect(treeAsText(model)).toBe('Claude 1 — x  [circle-filled:terminal.ansiBlue]\n  Login — controlling · localhost:3000  [globe:terminal.ansiBlue]');
  });

  it('extracts hosts', () => {
    expect(hostOf('http://localhost:3000/a')).toBe('localhost:3000');
    expect(hostOf('file:///tmp/page.html')).toBe('page.html');
    expect(hostOf('not a url')).toBeUndefined();
  });

  it('drops the url suffix from page titles', () => {
    expect(tabTitle({ title: 'Checkout (http://x/c)', url: 'http://x/c' })).toBe('Checkout');
    expect(tabTitle({ title: 'A (b)', url: 'http://x/c' })).toBe('A (b)');
  });

  it('drops the session label from terminal names under its row', () => {
    expect(terminalLabel('Claude 1 · tests', 'Claude 1')).toBe('tests');
    expect(terminalLabel('Claude 1: dev server', 'Claude 1')).toBe('dev server');
    expect(terminalLabel('Claude 12', 'Claude 1')).toBe('Claude 12');
    expect(terminalLabel('Claude 1', 'Claude 1')).toBe('Claude 1');
    expect(terminalLabel('zsh', 'Claude 1')).toBe('zsh');
  });

  it('escapes markdown and theme icon syntax', () => {
    expect(md('$(alert) *x*')).toBe('\\$\\(alert\\) \\*x\\*');
  });
});

describe('tab marks', () => {
  it('names emulation, mocked requests and an active download; nothing for a plain tab', async () => {
    const { tabMarks } = await import('../../src/extension/ui/tabMarks');
    const plain = { id: 'tab-1', url: 'http://x/', title: 'X', active: true, origin: 'agent' as const, openedBy: 'a', controlledBy: 'a', allowedSessions: ['a'], paused: false };
    expect(tabMarks(plain)).toEqual([]);
    expect(
      tabMarks({
        ...plain,
        emulation: { sessionId: 'a', label: 'iPhone 15 Pro · dark', description: '' },
        requestRules: [{ sessionId: 'a', rules: 2 }, { sessionId: 'b', rules: 1 }],
        downloads: [{ id: 'dl-1', name: 'report.csv', sessionId: 'a', state: 'downloading', progress: 40.2 }],
      }),
    ).toEqual(['emulating iPhone 15 Pro · dark', '3 mocked request rules', 'downloading report.csv 40%']);
    expect(tabMarks({ ...plain, downloads: [{ id: 'dl-1', name: 'a.zip', sessionId: 'a', state: 'saved', path: '/x/a.zip' }] })).toEqual([]);
  });
});
