import { describe, expect, it } from 'vitest';
import type { BrowserTabInfo } from '../../src/extension/core/services';
import { SESSION_COLORS, type AgentSession } from '../../src/extension/core/sessions';
import { buildViewModel, type UiInput } from '../../src/extension/ui/model';
import { buildPanelModel } from '../../src/extension/ui/panelModel';
import { profileMark } from '../../src/extension/ui/tabMarks';

const session = (n: number): AgentSession => ({
  id: `s${n}`,
  client: { name: 'claude-code', version: '2.1.0', kind: 'claude-code' },
  number: n,
  label: `Claude ${n}`,
  autoLabel: `Claude ${n}`,
  badge: `C${n}`,
  color: SESSION_COLORS[n - 1]!,
  title: undefined,
  pid: undefined,
  cwd: undefined,
  createdAt: n,
  lastActivityAt: n,
  connected: true,
});

const tab = (id: string, extra: Partial<BrowserTabInfo> = {}): BrowserTabInfo => ({
  id,
  url: 'https://jira.example/browse/X-1',
  title: 'X-1',
  active: false,
  origin: 'agent',
  openedBy: 's1',
  controlledBy: undefined,
  allowedSessions: [],
  paused: false,
  ...extra,
});

const dev: BrowserTabInfo['profile'] = { name: 'dev', label: 'dev', kind: 'named', description: 'In the login profile "dev".' };
const priv: BrowserTabInfo['profile'] = { name: 'private:s1', label: 'private to Claude 1', kind: 'private', description: 'Private.' };
const detached: BrowserTabInfo['profile'] = { name: 'dev', label: 'own login store', kind: 'detached', description: 'Own store.' };

describe('login profiles in the views', () => {
  it('short marks', () => {
    expect(profileMark(tab('tab-1'))).toBeUndefined();
    expect(profileMark(tab('tab-1', { profile: dev }), 's1')).toBe('profile dev');
    expect(profileMark(tab('tab-1', { profile: priv }), 's1')).toBe('private profile');
    expect(profileMark(tab('tab-1', { profile: priv }), 's2')).toBe('profile private to Claude 1');
    expect(profileMark(tab('tab-1', { profile: detached }), 's1')).toBe('own login store');
  });

  it('tab rows and tooltips in the Sessions view and the Agent Tabs panel, and the session default on its row', () => {
    const input: UiInput = {
      sessions: [session(1)],
      tabs: [tab('tab-1', { profile: dev }), tab('tab-2')],
      terminals: [],
      browserAvailable: true,
      graceSeconds: 20,
      sessionProfiles: new Map([['s1', { label: 'prod', setBy: 'user' as const }]]),
    };
    const model = buildViewModel(input);
    const withProfile = model.nodes.get('session:s1/tab:tab-1')!;
    expect(withProfile.description).toBe('idle · profile dev · jira.example');
    expect(withProfile.tooltip).toContain('In the login profile "dev"');
    expect(model.nodes.get('session:s1/tab:tab-2')!.description).toBe('idle · jira.example');
    const sessionRow = model.nodes.get('session:s1')!;
    expect(sessionRow.description).toBe('profile prod');
    expect(sessionRow.tooltip).toContain('New tabs open in the login profile **prod** (chosen by you).');

    const panel = buildPanelModel(input);
    expect(panel.nodes.get('tab:tab-1')!.description).toBe('Claude 1 · idle · profile dev · jira.example');
    expect(panel.nodes.get('tab:tab-1')!.tooltip).toContain('In the login profile');
  });
});
