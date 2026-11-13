import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tildify, withFileLock, writeFileAtomic } from '../../src/extension/registration/files';

let dir: string;
beforeEach(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-files-'))));
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('writeFileAtomic', () => {
  it('creates files with the given mode and keeps the mode of existing ones', () => {
    const file = path.join(dir, 'sub', 'a.json');
    writeFileAtomic(file, 'one', 0o600);
    expect(fs.readFileSync(file, 'utf8')).toBe('one');
    if (process.platform !== 'win32') {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      fs.chmodSync(file, 0o640);
      writeFileAtomic(file, 'two', 0o600);
      expect(fs.statSync(file).mode & 0o777).toBe(0o640);
    }
    expect(fs.readdirSync(path.dirname(file))).toEqual(['a.json']);
  });

  it.skipIf(process.platform === 'win32')('replaces the target of a symlinked dotfile, keeping the link', () => {
    const real = path.join(dir, 'real.json');
    const link = path.join(dir, 'link.json');
    fs.writeFileSync(real, 'old');
    fs.symlinkSync(real, link);
    writeFileAtomic(link, 'new');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(real, 'utf8')).toBe('new');
  });
});

describe('withFileLock', () => {
  it('waits for a lock held by someone else and removes it afterwards', async () => {
    const file = path.join(dir, 'c.json');
    fs.mkdirSync(`${file}.lock`);
    const started = Date.now();
    setTimeout(() => fs.rmdirSync(`${file}.lock`), 200);
    const value = await withFileLock(file, () => {
      expect(fs.existsSync(`${file}.lock`)).toBe(true);
      return 42;
    });
    expect(value).toBe(42);
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
  });

  it('takes over a stale lock and gives up on a live one after the timeout', async () => {
    const file = path.join(dir, 'c.json');
    fs.mkdirSync(`${file}.lock`);
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(`${file}.lock`, old, old);
    expect(await withFileLock(file, () => 'ok')).toBe('ok');
    fs.mkdirSync(`${file}.lock`);
    await expect(withFileLock(file, () => 'never', { timeoutMs: 100 })).rejects.toThrow(/locked/);
  });
});

describe('tildify', () => {
  it('shortens paths in the home folder only', () => {
    expect(tildify(path.join('/h', '.claude.json'), '/h')).toBe(`~${path.sep}.claude.json`);
    expect(tildify('/elsewhere/x', '/h')).toBe('/elsewhere/x');
  });
});
