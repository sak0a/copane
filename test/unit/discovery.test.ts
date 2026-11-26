import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { explainNoMatch, isInside, sameFolders, selectInstance, worktreeOf } from '../../src/mcp/discovery';
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

  it('uses the folder the agent session works in before the working directory of the server process', () => {
    // Copilot may start the server somewhere else (a host shared by all windows) and says where its session works.
    expect(selectInstance({ instances: [a, b], env: {}, cwd: '/somewhere/else', sessionCwd: '/work/b/src', ancestors: [] })).toMatchObject({ instance: b, matchedBy: 'cwd' });
    expect(selectInstance({ instances: [a, b], env: {}, cwd: '/work/a', sessionCwd: '/work/b', ancestors: [] })).toMatchObject({ instance: b, matchedBy: 'cwd' });
    // A session folder no window has open: the process's own directory still counts.
    expect(selectInstance({ instances: [a, b], env: {}, cwd: '/work/a', sessionCwd: '/not/open', ancestors: [] })).toMatchObject({ instance: a, matchedBy: 'cwd' });
    // The terminal variable and the extension-host ancestor still come first.
    expect(selectInstance({ instances: [a, b], env: { COPANE_INSTANCE: '100' }, cwd: '/x', sessionCwd: '/work/b', ancestors: [] })).toMatchObject({ instance: a, matchedBy: 'env' });
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

describe('selectInstance from a git worktree', () => {
  // Real files, laid out as `git worktree add` leaves them.
  let tmp: string;
  let repo: string;
  let wt: string;
  const readFile = (p: string) => fs.readFileSync(p, 'utf8');
  const realpath = (p: string) => fs.realpathSync.native(p);

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'copane-wt-'));
    repo = path.join(tmp, 'repo');
    wt = path.join(tmp, 'elsewhere', 'feature');
    fs.mkdirSync(path.join(repo, '.git', 'worktrees', 'feature'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'packages', 'web'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.git', 'worktrees', 'feature', 'commondir'), '../..\n');
    fs.mkdirSync(path.join(wt, 'packages', 'web', 'src'), { recursive: true });
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(repo, '.git', 'worktrees', 'feature')}\n`);
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('finds the worktree and its main checkout, and nothing for other layouts', () => {
    expect(worktreeOf(path.join(wt, 'packages', 'web'), readFile)).toEqual({ root: wt, mainCheckout: repo });
    expect(worktreeOf(path.join(repo, 'packages'), readFile)).toBeUndefined(); // the main checkout itself
    expect(worktreeOf(tmp, readFile)).toBeUndefined(); // no repository (unless tmp is inside one)
    // A submodule: `.git` file without commondir.
    const sub = path.join(tmp, 'sub');
    fs.mkdirSync(path.join(repo, '.git', 'modules', 'sub'), { recursive: true });
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, '.git'), 'gitdir: ../repo/.git/modules/sub\n');
    expect(worktreeOf(sub, readFile)).toBeUndefined();
    // Garbage, an empty commondir, a bare repository, and a reader that fails oddly: no match, no throw.
    fs.writeFileSync(path.join(sub, '.git'), 'not a gitdir line');
    expect(worktreeOf(sub, readFile)).toBeUndefined();
    fs.writeFileSync(path.join(wt, '.git'), 'gitdir: /nonexistent/x');
    expect(worktreeOf(wt, readFile)).toBeUndefined();
    fs.mkdirSync(path.join(tmp, 'bare.git', 'worktrees', 'b'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'bare.git', 'worktrees', 'b', 'commondir'), '../..');
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(tmp, 'bare.git', 'worktrees', 'b')}`);
    expect(worktreeOf(wt, readFile)).toBeUndefined();
    expect(
      worktreeOf(wt, () => {
        throw 'odd';
      }),
    ).toBeUndefined();
  });

  it('matches the window that has the main checkout open, as the deepest folder', () => {
    const a = instance('1', [repo]);
    const b = instance('2', [path.join(repo, 'packages', 'web')]);
    const c = instance('3', [path.join(tmp, 'other')]);
    const cwd = path.join(wt, 'packages', 'web', 'src');
    const r = selectInstance({ instances: [a, b, c], env: {}, cwd, ancestors: [], realpath, readFile });
    expect(r).toMatchObject({ instance: b, matchedBy: 'worktree' });
    expect(r?.note).toContain(`main checkout is ${repo}`);
    expect(selectInstance({ instances: [a, c], env: {}, cwd: wt, ancestors: [], realpath, readFile })).toMatchObject({ instance: a, matchedBy: 'worktree' });
    // Without the reader, the rule is off: no match among several windows, as before.
    expect(selectInstance({ instances: [a, c], env: {}, cwd: wt, ancestors: [], realpath })).toBeUndefined();
  });

  it('ranks below the working directory, the environment and the other exact rules', () => {
    const main = instance('1', [repo]);
    const holder = instance('2', [path.join(tmp, 'elsewhere')]);
    expect(selectInstance({ instances: [main, holder], env: {}, cwd: wt, ancestors: [], realpath, readFile })).toMatchObject({ instance: holder, matchedBy: 'cwd' });
    const other = instance('3', [path.join(tmp, 'x')]);
    expect(selectInstance({ instances: [main, other], env: { COPANE_INSTANCE: '3' }, cwd: wt, ancestors: [], realpath, readFile })).toMatchObject({ instance: other, matchedBy: 'env' });
    expect(selectInstance({ instances: [main, other], env: {}, cwd: wt, ancestors: [3], realpath, readFile })).toMatchObject({ instance: other, matchedBy: 'ancestor' });
  });

  it('breaks a tie between windows with the main checkout open as the working-directory rule does, and says so', () => {
    const a = instance('1', [repo], 1);
    const b = instance('2', [repo], 9);
    const r = selectInstance({ instances: [a, b], env: {}, cwd: wt, ancestors: [], realpath, readFile });
    expect(r).toMatchObject({ instance: b, matchedBy: 'worktree' });
    expect(r?.note).toContain('2 windows have this folder open');
  });
});
