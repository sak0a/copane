import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { moveUnique } from '../../src/extension/browser/page/downloadFiles';
import { candidateNames, describeDownload, isFinished, resolveDownloadsFolder, sanitizeFileName, systemDownloadsDir, type DownloadEntry } from '../../src/extension/browser/page/downloadLogic';

describe('file names', () => {
  it('keeps ordinary names and makes hostile ones safe', () => {
    expect(sanitizeFileName('report.csv')).toBe('report.csv');
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFileName('C:\\Windows\\evil.exe')).toBe('evil.exe');
    expect(sanitizeFileName('a:b*c?.txt')).toBe('a_b_c_.txt');
    expect(sanitizeFileName('...')).toBe('download');
    expect(sanitizeFileName('')).toBe('download');
    expect(sanitizeFileName('CON.txt')).toBe('_CON.txt');
    expect(sanitizeFileName(`${'x'.repeat(300)}.pdf`)).toMatch(/^x{196}\.pdf$/);
  });

  it('numbers names that are taken', () => {
    const take = (name: string, n: number) => [...candidateNames(name, n)];
    expect(take('report.csv', 2)).toEqual(['report.csv', 'report (1).csv', 'report (2).csv']);
    expect(take('archive.tar.gz', 1)).toEqual(['archive.tar.gz', 'archive.tar (1).gz']);
    expect(take('.env', 1)).toEqual(['.env', '.env (1)']);
    expect(take('README', 1)).toEqual(['README', 'README (1)']);
  });
});

describe('downloads folder', () => {
  const env = { home: '/home/u', downloadsDir: '/home/u/Downloads', workspaceFolder: '/work/app' };
  it('defaults to a Copane folder in Downloads and resolves ~ and relative paths', () => {
    // Native separators: on Windows the folder is joined with backslashes.
    expect(resolveDownloadsFolder('', env)).toEqual({ folder: join('/home/u/Downloads', 'Copane') });
    expect(resolveDownloadsFolder('~/agent-files', env)).toEqual({ folder: join('/home/u', 'agent-files') });
    expect(resolveDownloadsFolder('/tmp/x', env)).toEqual({ folder: '/tmp/x' });
    expect(resolveDownloadsFolder('out/downloads', env)).toEqual({ folder: join('/work/app', 'out', 'downloads') });
    expect(resolveDownloadsFolder('out', { ...env, workspaceFolder: undefined })).toMatchObject({ error: expect.stringMatching(/no workspace folder/) });
  });

  it('honours XDG_DOWNLOAD_DIR on Linux only', () => {
    const dirs = '# comment\nXDG_DOWNLOAD_DIR="$HOME/Herunterladen"\n';
    expect(systemDownloadsDir('/home/u', 'linux', dirs)).toBe('/home/u/Herunterladen');
    expect(systemDownloadsDir('/home/u', 'linux', 'XDG_DOWNLOAD_DIR="$HOME/"')).toBe(join('/home/u', 'Downloads'));
    expect(systemDownloadsDir('/Users/u', 'darwin', dirs)).toBe(join('/Users/u', 'Downloads'));
  });
});

describe('describeDownload', () => {
  const base: DownloadEntry = {
    id: 'dl-1',
    tabId: 'tab-1',
    guid: 'g',
    url: 'http://x/report',
    name: 'report.csv',
    sessionId: 's1',
    seq: 1,
    startedAt: 0,
    captured: true,
    received: 0,
    maxReceived: 0,
    total: 0,
    phase: 'downloading',
  };

  it('says where a saved file is and why it was renamed', () => {
    expect(describeDownload({ ...base, phase: 'saved', path: '/d/report.csv', total: 2048, maxReceived: 2048 })).toBe('dl-1 report.csv: saved to /d/report.csv (2.0 kB).');
    expect(describeDownload({ ...base, phase: 'saved', path: '/d/report (1).csv', total: 2048 })).toMatch(/renamed because report\.csv already existed/);
  });

  it('reports progress, failures with what arrived, and refusals', () => {
    expect(describeDownload({ ...base, received: 500, maxReceived: 500, total: 1000 })).toBe('dl-1 report.csv: downloading, 50% (500 B of 1.0 kB).');
    expect(describeDownload({ ...base, phase: 'failed', received: 0, maxReceived: 1000, total: 100_000 })).toMatch(/failed after 1\.0 kB of 100\.0 kB: the browser cancelled it/);
    expect(describeDownload({ ...base, phase: 'denied', reason: 'the user declined it' })).toBe('dl-1 report.csv: not saved, the user declined it.');
    expect(describeDownload({ ...base, phase: 'awaiting-user', total: 10 })).toMatch(/waiting for the user to allow saving it/);
  });

  it('is honest about files the agent cannot reach', () => {
    const remote = describeDownload({ ...base, phase: 'remote', remoteName: 'ssh-remote', captured: false, endedAt: 5, total: 10 });
    expect(remote).toMatch(/remote window \(ssh-remote; you run in [^)]*\).*not reachable from where you run \(finished/);
    expect(describeDownload({ ...base, phase: 'user-dialog', captured: false })).toMatch(/VS Code asked the user where to save it.*wait: true/);
    expect(isFinished({ ...base, phase: 'user-dialog' })).toBe(false);
    expect(isFinished({ ...base, phase: 'user-dialog', endedAt: 1 })).toBe(true);
    expect(isFinished({ ...base, phase: 'awaiting-user' })).toBe(false);
  });
});

describe('moveUnique', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('never replaces an existing file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'copane-move-'));
    dirs.push(dir);
    const dest = join(dir, 'out');
    for (const content of ['one', 'two', 'three']) {
      const src = join(dir, `staged-${content}`);
      writeFileSync(src, content);
      await moveUnique(src, dest, 'report.csv');
    }
    expect(readdirSync(dest).sort()).toEqual(['report (1).csv', 'report (2).csv', 'report.csv']);
    expect(readFileSync(join(dest, 'report.csv'), 'utf8')).toBe('one');
    expect(readFileSync(join(dest, 'report (2).csv'), 'utf8')).toBe('three');
    expect(readdirSync(dir).filter(n => n.startsWith('staged'))).toEqual([]);
  });
});
