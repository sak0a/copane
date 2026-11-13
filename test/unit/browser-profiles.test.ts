import { describe, expect, it } from 'vitest';
import {
  agentMayUseDefault,
  classifyRestoredTab,
  DEFAULT_PROFILE,
  isPrivate,
  parseProfileName,
  parseProfiles,
  privateKey,
  privateOwner,
  profileLabel,
  resolveProfile,
  touchRecent,
} from '../../src/extension/browser/profiles/model';

describe('profile names', () => {
  it('accepts simple names case-insensitively', () => {
    expect(parseProfileName(' ZTBDEV ')).toEqual({ ok: true, key: 'ztbdev' });
    expect(parseProfileName('ztb-pre.2')).toEqual({ ok: true, key: 'ztb-pre.2' });
  });
  it('maps default, shared and none to the default store', () => {
    for (const n of ['default', 'Shared', 'none']) expect(parseProfileName(n)).toEqual({ ok: true, key: DEFAULT_PROFILE });
  });
  it('maps private to the session of the caller', () => {
    expect(parseProfileName('private', 's1')).toEqual({ ok: true, key: 'private:s1' });
    expect(parseProfileName('private').ok).toBe(false);
  });
  it('rejects names that are not simple', () => {
    for (const n of ['', 'a b', '-dev', 'private:s2', 'x'.repeat(33), 'dév']) expect(parseProfileName(n).ok).toBe(false);
  });
  it('labels profiles for people', () => {
    const label = (id: string) => (id === 's1' ? 'Claude 1' : undefined);
    expect(profileLabel('dev', label)).toBe('dev');
    expect(profileLabel(privateKey('s1'), label)).toBe('private to Claude 1');
    expect(profileLabel(privateKey('gone'), label)).toBe('private to an ended session');
    expect(profileLabel(DEFAULT_PROFILE, label)).toBe('default store');
    expect(isPrivate(privateKey('s1'))).toBe(true);
    expect(privateOwner(privateKey('s1'))).toBe('s1');
    expect(privateOwner('dev')).toBeUndefined();
  });
});

describe('which profile a new tab uses', () => {
  const base = { sessionId: 's1', setting: 'shared' as const };
  it('argument, then the user default, then the agent default, then the setting', () => {
    const defaults = { user: 'prod', agent: 'dev' };
    expect(resolveProfile({ ...base, explicit: 'test', defaults })).toEqual({ key: 'test', source: 'argument' });
    expect(resolveProfile({ ...base, defaults })).toEqual({ key: 'prod', source: 'user' });
    expect(resolveProfile({ ...base, defaults: { agent: 'dev' } })).toEqual({ key: 'dev', source: 'agent' });
    expect(resolveProfile(base)).toEqual({ key: DEFAULT_PROFILE, source: 'setting' });
    expect(resolveProfile({ ...base, setting: 'private' })).toEqual({ key: 'private:s1', source: 'setting' });
  });
  it('keeps agents out of the default store under the private setting unless the user chose it', () => {
    expect(agentMayUseDefault('shared', 'argument')).toBe(true);
    expect(agentMayUseDefault('private', 'argument')).toBe(false);
    expect(agentMayUseDefault('private', 'agent')).toBe(false);
    expect(agentMayUseDefault('private', 'user')).toBe(true);
  });
});

describe('remembered state', () => {
  it('drops what it does not understand', () => {
    expect(parseProfiles(undefined).tabs).toEqual([]);
    expect(parseProfiles({ version: 2, tabs: [{}] }).tabs).toEqual([]);
    const state = parseProfiles({
      version: 1,
      contexts: { dev: 'cdp-created:1', 'bad name': 'x', default: 'global', 'private:s1': 'cdp-created:2' },
      tabs: [
        { viewId: 'v1', profile: 'dev', contextId: 'cdp-created:1' },
        { viewId: 'v2', profile: 'default', contextId: 'global' },
        { viewId: 'v3', profile: 'dev', contextId: 'ephemeral:v3', detached: true },
        { viewId: 4, profile: 'dev', contextId: 'x' },
      ],
      defaults: { s1: { user: 'prod', agent: 'not ok!' }, s2: { agent: 'private:s2' }, s3: {} },
      recent: ['dev', 'private:s1', 'test', 'default'],
    });
    expect(state.contexts).toEqual({ dev: 'cdp-created:1', 'private:s1': 'cdp-created:2' });
    expect(state.tabs).toEqual([
      { viewId: 'v1', profile: 'dev', contextId: 'cdp-created:1' },
      { viewId: 'v3', profile: 'dev', contextId: 'ephemeral:v3', detached: true },
    ]);
    expect(state.defaults).toEqual({ s1: { user: 'prod' }, s2: { agent: 'private:s2' } });
    expect(state.recent).toEqual(['dev', 'test']);
  });
  it('keeps recent names unique, newest first, without private or default', () => {
    expect(touchRecent(['a', 'b'], 'b')).toEqual(['b', 'a']);
    expect(touchRecent(['a'], privateKey('s1'))).toEqual(['a']);
    expect(touchRecent(['a'], DEFAULT_PROFILE)).toEqual(['a']);
  });
});

describe('tabs restored after a reload or restart', () => {
  const remembered = { viewId: 'v1', profile: 'dev', contextId: 'cdp-created:1' };
  it('a reload keeps the tab in its profile (same store)', () => {
    expect(classifyRestoredTab(remembered, 'cdp-created:1')).toEqual({ kind: 'profile', profile: 'dev' });
  });
  it('a restart leaves the tab with a store of its own', () => {
    expect(classifyRestoredTab(remembered, 'ephemeral:v1')).toEqual({ kind: 'detached', formerProfile: 'dev' });
    expect(classifyRestoredTab({ ...remembered, contextId: 'ephemeral:v1', detached: true }, 'ephemeral:v1')).toEqual({ kind: 'detached', formerProfile: 'dev' });
  });
  it('knows nothing about tabs it did not remember', () => {
    expect(classifyRestoredTab(undefined, 'cdp-created:1')).toBeUndefined();
    expect(classifyRestoredTab(remembered, undefined)).toBeUndefined();
  });
});
