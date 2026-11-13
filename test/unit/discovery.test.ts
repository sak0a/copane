import { describe, expect, it } from 'vitest';
import { explainNoMatch, isInside, sameFolders, selectInstance } from '../../src/mcp/discovery';
import type { InstanceInfo } from '../../src/shared/protocol';

function instance(id: string, folders: string[], lastFocusedAt = 0, startedAt = 0): InstanceInfo {
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
    startedAt,
    lastFocusedAt,
  };
}

describe('selectInstance', () => {
  const a = instance('100', ['/work/a']);
  const b = instance('200', ['/work/b', '/work/a/packages/web'], 5);

  it('returns nothing when no window is open', () => {
    expect(selectInstance({ instances: [], env: {}, cwd: '/work/a', ancestors: [] })).toBeUndefined();
  });

  it('prefers the terminal environment variable over the working directory', () => {
    const r = selectInstance({ instances: [a, b], env: { COPANE_INSTANCE: '200' }, cwd: '/work/a', ancestors: [] });
    expect(r).toMatchObject({ instance: b, matchedBy: 'env' });
  });

  it('trusts the extension-host ancestor over an inherited environment variable', () => {
    // VS Code started from a terminal of another VS Code inherits that window's id.
    const r = selectInstance({ instances: [a, b], env: { COPANE_INSTANCE: '200' }, cwd: '/work/b', ancestors: [55, 100] });
    expect(r).toMatchObject({ instance: a, matchedBy: 'ancestor' });
  });

  it('an explicit choice wins while that window is open', () => {
    expect(selectInstance({ instances: [a, b], env: {}, cwd: '/work/a', ancestors: [100], explicit: '200' })).toMatchObject({ instance: b, matchedBy: 'explicit' });
    expect(selectInstance({ instances: [a, b], env: {}, cwd: '/work/a', ancestors: [], explicit: '999' })).toMatchObject({ instance: a, matchedBy: 'cwd' });
  });

  it('after a reload finds the window with the same folders before looking at the cwd', () => {
    // A terminal keeps the old window id in its environment; the reloaded window has a new id.
    const reloaded = instance('300', ['/work/b', '/work/a/packages/web'], 0, 10);
    const r = selectInstance({
      instances: [a, reloaded],
      env: { COPANE_INSTANCE: '200' },
      cwd: '/work/a',
      ancestors: [],
      previous: { id: '200', workspaceFolders: ['/work/a/packages/web', '/work/b'] },
    });
    expect(r).toMatchObject({ instance: reloaded, matchedBy: 'reconnect' });
  });

  it('ignores an environment variable that points at a window that is gone', () => {
    const r = selectInstance({ instances: [a, b], env: { COPANE_INSTANCE: '999' }, cwd: '/work/a', ancestors: [] });
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

  it('breaks a tie between equal folders by most recent focus, and says so', () => {
    const older = instance('300', ['/work/c'], 1);
    const newer = instance('400', ['/work/c'], 2);
    const r = selectInstance({ instances: [older, newer], env: {}, cwd: '/work/c', ancestors: [] });
    expect(r?.instance).toBe(newer);
    expect(r?.note).toMatch(/2 windows/);
    expect(selectInstance({ instances: [a, b], env: {}, cwd: '/work/a/x', ancestors: [] })?.note).toBeUndefined();
  });

  it('falls back to the only window, but never guesses between several', () => {
    expect(selectInstance({ instances: [a], env: {}, cwd: '/elsewhere', ancestors: [] })).toMatchObject({ matchedBy: 'single' });
    expect(selectInstance({ instances: [a, b], env: {}, cwd: '/elsewhere', ancestors: [] })).toBeUndefined();
  });
});

describe('explainNoMatch', () => {
  it('distinguishes no window from several unrelated windows and names a stale terminal id', () => {
    expect(explainNoMatch({ instances: [], cwd: '/x', env: {} })).toMatch(/No VS Code window/);
    const text = explainNoMatch({ instances: [instance('1', ['/a']), instance('2', ['/b'])], cwd: '/x', env: { COPANE_INSTANCE: '9' } });
    expect(text).toMatch(/2 VS Code windows/);
    expect(text).toMatch(/COPANE_INSTANCE=9/);
  });
});

describe('sameFolders', () => {
  it('compares folder sets regardless of order', () => {
    expect(sameFolders(['/a', '/b'], ['/b', '/a/'])).toBe(true);
    expect(sameFolders(['/a'], ['/a', '/b'])).toBe(false);
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

describe('selectInstance with symbolic links', () => {
  const inst = (id: string, folders: string[], lastFocusedAt = 0) =>
    ({ id, pid: Number(id), socketPath: '', token: '', workspaceName: id, workspaceFolders: folders, remoteName: null, extensionVersion: '0', startedAt: 0, lastFocusedAt }) as never;

  it('matches a resolved working directory to a workspace folder opened through a link', () => {
    // macOS: /tmp is a link to /private/tmp; process.cwd() and Codex report the resolved path.
    const realpath = (p: string) => p.replace(/^\/tmp(?=\/|$)/, '/private/tmp');
    const a = inst('1', ['/tmp/ws']);
    const b = inst('2', ['/work/other']);
    const r = selectInstance({ instances: [a, b], env: {}, cwd: '/private/tmp/ws/src', ancestors: [], realpath });
    expect(r).toMatchObject({ matchedBy: 'cwd' });
    expect(r?.instance).toBe(a);
  });

  it('keeps working when a folder cannot be resolved', () => {
    const realpath = () => {
      throw new Error('ENOENT');
    };
    const a = inst('1', ['/work/a']);
    const b = inst('2', ['/work/b']);
    expect(selectInstance({ instances: [a, b], env: {}, cwd: '/work/b/x', ancestors: [], realpath })?.instance).toBe(b);
  });
});
