import { describe, expect, it } from 'vitest';
import { isInside, selectInstance } from '../../src/mcp/discovery';
import type { InstanceInfo } from '../../src/shared/protocol';

function instance(id: string, folders: string[], lastFocusedAt = 0): InstanceInfo {
  return {
    id,
    pid: Number(id),
    socketPath: `/tmp/${id}.sock`,
    token: 't',
    protocolVersion: 1,
    extensionVersion: '0.0.0',
    workspaceName: null,
    workspaceFolders: folders,
    remoteName: null,
    appName: 'Visual Studio Code',
    startedAt: 0,
    lastFocusedAt,
  };
}

describe('selectInstance', () => {
  const a = instance('100', ['/work/a']);
  const b = instance('200', ['/work/b', '/work/a/packages/web'], 5);

  it('returns nothing when no window is open', () => {
    expect(selectInstance({ instances: [], env: {}, cwd: '/work/a', ancestors: [] })).toBeUndefined();
  });

  it('prefers the terminal environment variable', () => {
    const r = selectInstance({ instances: [a, b], env: { AGENT_BRIDGE_INSTANCE: '200' }, cwd: '/work/a', ancestors: [100] });
    expect(r).toMatchObject({ instance: b, matchedBy: 'env' });
  });

  it('ignores an environment variable that points at a window that is gone', () => {
    const r = selectInstance({ instances: [a, b], env: { AGENT_BRIDGE_INSTANCE: '999' }, cwd: '/work/a', ancestors: [] });
    expect(r).toMatchObject({ instance: a, matchedBy: 'cwd' });
  });

  it('matches the extension host among the ancestors before looking at the cwd', () => {
    const r = selectInstance({ instances: [a, b], env: {}, cwd: '/work/a', ancestors: [7, 200, 1] });
    expect(r).toMatchObject({ instance: b, matchedBy: 'ancestor' });
  });

  it('picks the window with the deepest workspace folder containing the cwd', () => {
    const r = selectInstance({ instances: [a, b], env: {}, cwd: '/work/a/packages/web/src', ancestors: [] });
    expect(r).toMatchObject({ instance: b, matchedBy: 'cwd' });
  });

  it('breaks a tie between equal folders by most recent focus', () => {
    const older = instance('300', ['/work/c'], 1);
    const newer = instance('400', ['/work/c'], 2);
    expect(selectInstance({ instances: [older, newer], env: {}, cwd: '/work/c', ancestors: [] })?.instance).toBe(newer);
  });

  it('falls back to the only window, but never guesses between several', () => {
    expect(selectInstance({ instances: [a], env: {}, cwd: '/elsewhere', ancestors: [] })).toMatchObject({ matchedBy: 'single' });
    expect(selectInstance({ instances: [a, b], env: {}, cwd: '/elsewhere', ancestors: [] })).toBeUndefined();
  });
});

describe('isInside', () => {
  it('treats a folder as inside itself and rejects siblings with a common prefix', () => {
    expect(isInside('/work/a', '/work/a')).toBe(true);
    expect(isInside('/work/a/src', '/work/a')).toBe(true);
    expect(isInside('/work/ab', '/work/a')).toBe(false);
    expect(isInside('/work', '/work/a')).toBe(false);
  });
});
