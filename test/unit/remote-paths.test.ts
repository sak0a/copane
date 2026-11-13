import { describe, expect, it } from 'vitest';
import { describeDownload, type DownloadEntry } from '../../src/extension/browser/page/downloadLogic';
import {
  argvJsonPath,
  describeRemote,
  homeFromArgvJson,
  joinLocal,
  localPath,
  mayBeHome,
  nativePath,
  platformOfPath,
  stagingFolder,
  wslHomeHints,
} from '../../src/extension/remote/uiPaths';

describe('paths on the user machine', () => {
  it('converts between vscode-local paths and native ones', () => {
    expect(nativePath('/c:/Users/me/AppData')).toBe('C:\\Users\\me\\AppData');
    expect(nativePath('/C:/')).toBe('C:\\');
    expect(nativePath('/Users/me/Downloads')).toBe('/Users/me/Downloads');
    expect(localPath('C:\\Users\\me')).toBe('/C:/Users/me');
    expect(localPath('/home/me')).toBe('/home/me');
    expect(joinLocal('/c:/Users/me/', '/.vscode/', 'argv.json')).toBe('/c:/Users/me/.vscode/argv.json');
  });

  it('tells the platform from a home path', () => {
    expect(platformOfPath('/c:/Users/me')).toBe('win32');
    expect(platformOfPath('/Users/me')).toBe('darwin');
    expect(platformOfPath('/home/me')).toBe('linux');
  });

  it('stages downloads in the user\'s own temp or cache folder', () => {
    expect(nativePath(stagingFolder('/c:/Users/me', 'win32'))).toBe('C:\\Users\\me\\AppData\\Local\\Temp\\copane-downloads');
    expect(stagingFolder('/Users/me', 'darwin')).toBe('/Users/me/Library/Caches/Copane/downloads');
    expect(stagingFolder('/home/me', 'linux')).toBe('/home/me/.cache/copane/downloads');
  });

  it('finds the Windows home in what a WSL distribution inherits', () => {
    const env = {
      VSCODE_WSL_EXT_LOCATION: '/mnt/c/Users/Ana Lopez/.vscode/extensions/ms-vscode-remote.remote-wsl-0.88.0',
      PATH: '/usr/bin:/mnt/c/Users/Public/bin:/mnt/c/Users/Ana Lopez/AppData/Local/Programs/Microsoft VS Code/bin:/c/Users/other/bin',
    };
    expect(wslHomeHints(env)).toEqual(['/c:/Users/Ana Lopez', '/c:/Users/other']);
    expect(wslHomeHints({ PATH: '/usr/bin' })).toEqual([]);
    expect(mayBeHome('Public')).toBe(false);
    expect(mayBeHome('Default User')).toBe(false);
    expect(mayBeHome('me')).toBe(true);
  });

  it('derives the home from argv.json as VS Code opened it', () => {
    expect(homeFromArgvJson(argvJsonPath('/c:/Users/me', '.vscode'), '.vscode')).toBe('/c:/Users/me');
    expect(homeFromArgvJson('/Users/me/.vscode-insiders/argv.json', '.vscode-insiders')).toBe('/Users/me');
    expect(homeFromArgvJson('/d:/portable/data/argv.json', '.vscode')).toBeUndefined();
  });

  it('names the remote side for messages', () => {
    expect(describeRemote('wsl', { WSL_DISTRO_NAME: 'Ubuntu' }, 'x')).toBe('WSL (Ubuntu)');
    expect(describeRemote('ssh-remote', {}, 'build-1')).toBe('the SSH host build-1');
    expect(describeRemote('dev-container', {}, 'x')).toBe('the container');
  });
});

describe('downloads in a remote window, as the agent is told', () => {
  const entry = (over: Partial<DownloadEntry>): DownloadEntry => ({
    id: 'dl-1',
    tabId: 'tab-1',
    guid: 'g',
    url: 'https://example.com/a.csv',
    name: 'a.csv',
    sessionId: 's1',
    seq: 1,
    startedAt: 0,
    endedAt: 1,
    captured: false,
    received: 10,
    maxReceived: 10,
    total: 10,
    phase: 'remote',
    remoteName: 'wsl',
    remoteWhere: 'WSL (Ubuntu)',
    ...over,
  });

  it('says where the file is, why it was not saved for the agent, and what to do', () => {
    const text = describeDownload(entry({ notCapturedBecause: "could not find the user's home folder on their computer" }));
    expect(text).toContain('you run in WSL (Ubuntu)');
    expect(text).toContain("on the user's computer");
    expect(text).toContain("could not find the user's home folder");
    expect(text).toContain('ask the user to save it into the workspace folder');
  });

  it('says a file VS Code asked the user about is on their computer', () => {
    expect(describeDownload(entry({ phase: 'user-dialog' }))).toContain('on their computer (not where you run)');
  });

  it('marks the user\'s own download as being on their computer', () => {
    expect(describeDownload(entry({ phase: 'saved', sessionId: undefined, path: 'C:\\Users\\me\\Downloads\\a.csv' }))).toContain("on the user's computer");
    expect(describeDownload(entry({ phase: 'saved', path: '/home/me/Downloads/Copane/a.csv' }))).toBe('dl-1 a.csv: saved to /home/me/Downloads/Copane/a.csv (10 B).');
  });
});
