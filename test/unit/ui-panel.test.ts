import { describe, expect, it } from 'vitest';
import type { BrowserTabInfo } from '../../src/extension/core/services';
import { SESSION_COLORS, type AgentSession } from '../../src/extension/core/sessions';
import { Cmd } from '../../src/extension/ui/ids';
import { diffModels } from '../../src/extension/ui/model';
import { buildPanelModel, panelAsText, panelTabNodeId, tabOwner, type PanelInput } from '../../src/extension/ui/panelModel';

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

const input = (extra: Partial<PanelInput> = {}): PanelInput => ({ sessions: [], tabs: [], ...extra });
const row = (model: ReturnType<typeof buildPanelModel>, tabId: string) => {
  const node = model.nodes.get(panelTabNodeId(tabId));
  if (!node) throw new Error(`no row for ${tabId}; have ${[...model.nodes.keys()].join(', ')}`);
  return node;
};

describe('which tabs are listed', () => {
  it('is empty (welcome content) without sessions, even with open tabs', () => {
    const model = buildPanelModel(input({ tabs: [tab('tab-1', { origin: 'user' })] }));
    expect(model.roots).toEqual([]);
    expect(model.description).toBeUndefined();
  });

  it('lists tabs a live session opened, controls or was allowed to use, and nothing else', () => {
    const s1 = session(1);
    const model = buildPanelModel(
      input({
        sessions: [s1],
        tabs: [
          tab('tab-1', { openedBy: 's1' }),
          tab('tab-2', { origin: 'user', allowedSessions: ['s1'] }),
          tab('tab-3', { origin: 'user' }), // the user's own, unused
          tab('tab-4', { openedBy: undefined }), // left behind by an ended session
          tab('tab-5', { origin: 'user', controlledBy: 's1', allowedSessions: ['s1'] }),
        ],
      }),
    );
    expect(model.roots.map(r => r.ref.tabId)).toEqual(['tab-1', 'tab-2', 'tab-5']);
    expect(model.description).toBe('3 tabs, 1 session');
  });

  it('lists every tab once, under the session that controls it, else its opener, else the first allowed session', () => {
    const [s1, s2, s3] = [session(1), session(2), session(3)];
    const sessions = [s1, s2, s3];
    expect(tabOwner(tab('t', { openedBy: 's1', controlledBy: 's2', allowedSessions: ['s1', 's2'] }), sessions)?.id).toBe('s2');
    expect(tabOwner(tab('t', { openedBy: 's3', allowedSessions: ['s1', 's3'] }), sessions)?.id).toBe('s3');
    expect(tabOwner(tab('t', { origin: 'user', allowedSessions: ['s3', 's2'] }), sessions)?.id).toBe('s2');
    // A controller that has ended does not count.
    expect(tabOwner(tab('t', { openedBy: 's1', controlledBy: 'gone' }), sessions)?.id).toBe('s1');

    const model = buildPanelModel(input({ sessions, tabs: [tab('tab-1', { openedBy: 's1', controlledBy: 's2', allowedSessions: ['s1', 's2'] })] }));
    expect(model.roots).toHaveLength(1);
    expect(row(model, 'tab-1').ref.sessionId).toBe('s2');
  });
});

describe('rows', () => {
  const s1 = session(1, { title: 'fixing login' });
  const s2 = session(2);

  it('sorts by session (in session order), then by tab number, so each session is a band of its color', () => {
    const model = buildPanelModel(
      input({
        sessions: [s1, s2],
        tabs: [tab('tab-10', { openedBy: 's1' }), tab('tab-3', { openedBy: 's2' }), tab('tab-2', { openedBy: 's1' }), tab('tab-9', { openedBy: 's2' })],
      }),
    );
    expect(model.roots.map(r => r.ref.tabId)).toEqual(['tab-2', 'tab-10', 'tab-3', 'tab-9']);
    expect(model.roots.map(r => r.icon.color)).toEqual([s1.color.themeColor, s1.color.themeColor, s2.color.themeColor, s2.color.themeColor]);
    expect(model.description).toBe('4 tabs, 2 sessions');
  });

  it('shows the page title, then whose it is and what the session is doing, then the host', () => {
    const model = buildPanelModel(
      input({
        sessions: [s1, s2],
        tabs: [
          tab('tab-1', { openedBy: 's1', controlledBy: 's1', allowedSessions: ['s1'], title: 'Checkout' }),
          tab('tab-2', { openedBy: 's2', allowedSessions: ['s2'], title: 'Docs', url: 'https://example.com/docs' }),
          tab('tab-3', { openedBy: 's1', paused: true, allowedSessions: ['s1'], title: '' }),
        ],
      }),
    );
    expect(panelAsText(model)).toBe(
      [
        'Checkout — Claude 1 · fixing login · controlling · localhost:3000  [circle-large-filled:terminal.ansiBlue]',
        'localhost:3000 — Claude 1 · paused by you  [debug-pause:terminal.ansiBlue]',
        'Docs — Claude 2 · idle · example.com  [circle-large-outline:terminal.ansiMagenta]',
      ].join('\n'),
    );
    expect(row(model, 'tab-1').command).toEqual({ command: Cmd.revealTab, title: 'Show Tab', args: ['tab-1'] });
    expect(row(model, 'tab-1').accessibilityLabel).toBe('Browser tab Checkout, Claude 1 (fixing login), controlling, localhost:3000');
    // The title is on the first row of a session only; screen readers get it on every row.
    expect(row(model, 'tab-3').accessibilityLabel).toBe('Browser tab localhost:3000, Claude 1 (fixing login), paused by you');
  });

  it('keeps the session color while paused, and says who else is involved', () => {
    const model = buildPanelModel(
      input({
        sessions: [s1, s2],
        tabs: [
          tab('tab-1', { openedBy: 's1', controlledBy: 's2', allowedSessions: ['s1', 's2'], title: 'Shop' }),
          tab('tab-2', { origin: 'user', allowedSessions: ['s2', 's1'], paused: true, title: 'Mail' }),
        ],
      }),
    );
    expect(row(model, 'tab-1').description).toBe('Claude 2 · controlling · opened by Claude 1 · shared with Claude 1 · localhost:3000');
    expect(row(model, 'tab-2').description).toBe('Claude 1 · fixing login · paused by you · your tab · shared with Claude 2 · localhost:3000');
    expect(row(model, 'tab-2').icon).toEqual({ id: 'debug-pause', color: s1.color.themeColor });
  });

  it('marks tabs of a session that is away', () => {
    const model = buildPanelModel(input({ sessions: [session(1, { connected: false, away: true })], tabs: [tab('tab-1', { openedBy: 's1' })] }));
    expect(row(model, 'tab-1').description).toBe('Claude 1 · away · idle · localhost:3000');
    expect(row(model, 'tab-1').tooltip).toContain('(away)');
  });

  it('marks tabs of a session that is reconnecting', () => {
    const model = buildPanelModel(input({ sessions: [session(1, { connected: false })], tabs: [tab('tab-1', { openedBy: 's1' })] }));
    expect(row(model, 'tab-1').description).toBe('Claude 1 · reconnecting · idle · localhost:3000');
    expect(row(model, 'tab-1').tooltip).toContain('(reconnecting)');
  });

  it('sets context flags for the inline actions', () => {
    const model = buildPanelModel(
      input({
        sessions: [s1],
        tabs: [tab('tab-1', { openedBy: 's1', controlledBy: 's1' }), tab('tab-2', { origin: 'user', allowedSessions: ['s1'], paused: true })],
      }),
    );
    expect(row(model, 'tab-1').contextValue).toBe('tab notPaused releasable agentTab');
    expect(row(model, 'tab-2').contextValue).toBe('tab paused userTab');
  });

  it('escapes page titles and URLs in the Markdown tooltip', () => {
    const model = buildPanelModel(input({ sessions: [s1], tabs: [tab('tab-1', { openedBy: 's1', title: '*bold* [x](y)' })] }));
    expect(row(model, 'tab-1').tooltip).toContain('\\*bold\\* \\[x\\]\\(y\\)');
  });
});

describe('updates', () => {
  const s1 = session(1);
  const base = input({ sessions: [s1], tabs: [tab('tab-1', { openedBy: 's1' }), tab('tab-2', { openedBy: 's1' })] });

  it('refreshes one row when only its state changes, and keeps its id', () => {
    const before = buildPanelModel(base);
    const after = buildPanelModel({ ...base, tabs: [tab('tab-1', { openedBy: 's1', controlledBy: 's1' }), tab('tab-2', { openedBy: 's1' })] });
    expect(diffModels(before, after)).toEqual({ full: false, changed: [panelTabNodeId('tab-1')] });
  });

  it('changes nothing when nothing rendered changed', () => {
    expect(diffModels(buildPanelModel(base), buildPanelModel(base))).toEqual({ full: false, changed: [] });
  });

  it('refreshes the list when a tab comes or goes', () => {
    const after = buildPanelModel({ ...base, tabs: base.tabs.slice(0, 1) });
    expect(diffModels(buildPanelModel(base), after).full).toBe(true);
  });
});
