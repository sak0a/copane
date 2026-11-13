// The logic behind the GitHub workflows (.github/workflows/), which lives in scripts/ so it can be
// tested here instead of in YAML.
import { describe, expect, it } from 'vitest';
import { assess, fingerprintOf, issueBody, plan } from '../../scripts/canary-issue.mjs';
import { compareTypings, normalize, report } from '../../scripts/check-proposed-api.mjs';
import { parseSuiteOutput, selectSuites, SUITES, summarize } from '../../scripts/e2e.mjs';
import { changelogSection, isPrerelease, tagProblem } from '../../scripts/release-notes.mjs';

describe('release notes', () => {
  const changelog = '# Changelog\r\n\r\n## 0.3.0\r\n\r\n- New thing.\r\n- Other thing.\r\n\r\n## 0.2.1\n\n- Fix.\n\n## 0.2.0\n\nOld.\n';

  it('takes the section of the version, up to the next one', () => {
    expect(changelogSection(changelog, '0.3.0')).toBe('- New thing.\n- Other thing.');
    expect(changelogSection(changelog, '0.2.1')).toBe('- Fix.');
    expect(changelogSection(changelog, '0.2.0')).toBe('Old.');
    expect(changelogSection(changelog, '0.2')).toBeUndefined();
    expect(changelogSection(changelog, '1.0.0')).toBeUndefined();
    expect(changelogSection('## [1.0.0] - 2026-01-01\nNotes\n## 0.9.0\n', '1.0.0')).toBe('Notes');
    expect(changelogSection('## 1.0.0\n\n## 0.9.0\nx', '1.0.0')).toBeUndefined();
  });

  it('the tag must be v + the package version', () => {
    expect(tagProblem('v0.2.1', '0.2.1')).toBeUndefined();
    expect(tagProblem('v1.0.0-beta.1', '1.0.0-beta.1')).toBeUndefined();
    expect(tagProblem('v0.2.2', '0.2.1')).toMatch(/does not match package.json's version 0\.2\.1/);
    expect(tagProblem('0.2.1', '0.2.1')).toMatch(/does not match/);
    expect(tagProblem('v0.2', '0.2')).toMatch(/not a semantic version/);
  });

  it('is a pre-release below 1.0 or with a suffix', () => {
    expect(isPrerelease('0.2.1')).toBe(true);
    expect(isPrerelease('1.0.0')).toBe(false);
    expect(isPrerelease('1.2.0-rc.1')).toBe(true);
    expect(isPrerelease('10.0.0')).toBe(false);
  });

  it("the repository's own changelog has the current version", async () => {
    const { readFileSync } = await import('node:fs');
    const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(changelogSection(readFileSync('CHANGELOG.md', 'utf8'), version)).toBeTruthy();
  });
});

describe('proposed-API comparison', () => {
  it('ignores line endings and trailing spaces, reports differences and removals', async () => {
    const vendored = { 'a.d.ts': 'x\r\nfoo  \r\ny\r\n', 'b.d.ts': 'one\ntwo\n', 'c.d.ts': 'q\n' };
    const upstream = { 'a.d.ts': 'x\nfoo\ny\n', 'b.d.ts': 'one\nthree\n', 'c.d.ts': null };
    const result = await compareTypings(vendored, async name => upstream[name]);
    expect(result.status).toBe('changed');
    expect(result.files.map(f => [f.name, f.status])).toEqual([
      ['a.d.ts', 'same'],
      ['b.d.ts', 'differs'],
      ['c.d.ts', 'gone'],
    ]);
    expect(result.files[1].diff).toMatch(/^--- vendored\/b\.d\.ts\n\+\+\+ upstream\/b\.d\.ts\n@@ .* @@\n one\n-two\n\+three$/);
    const text = report(result, 'main');
    expect(text).toMatch(/changed in microsoft\/vscode `main`/);
    expect(text).toMatch(/`c\.d\.ts`: \*\*no longer exists upstream\*\*/);
  });

  it('a fetch error is "error", not "changed"', async () => {
    const result = await compareTypings({ 'a.d.ts': 'x' }, async () => {
      throw new Error('HTTP 503');
    });
    expect(result).toEqual({ status: 'error', files: [{ name: 'a.d.ts', status: 'error', error: 'HTTP 503' }] });
    expect(normalize('a \r\nb\n\n')).toBe('a\nb\n');
  });
});

describe('e2e runner', () => {
  it('reads PASS, FAIL and SKIP lines with their details', () => {
    const out = 'dev host\r\nPASS  opens a tab  (120 ms)\nFAIL  clicks\n      AssertionError\nSKIP  certs  (needs `openssl` on the PATH)\n\n1 failed, 1 skipped\n';
    expect(parseSuiteOutput(out)).toEqual([
      { status: 'pass', name: 'opens a tab', detail: '120 ms' },
      { status: 'fail', name: 'clicks', detail: undefined },
      { status: 'skip', name: 'certs', detail: 'needs `openssl` on the PATH' },
    ]);
  });

  it('picks the CI set per platform and says why a suite is left out', () => {
    // On Linux everything runs except the suite that needs a remote window in a container.
    const linux = selectSuites([], 'ci', 'linux');
    expect(linux.run).toEqual(Object.keys(SUITES).filter(s => s !== 'remote'));
    expect(linux.left.map(l => l.suite)).toEqual(['remote']);
    const win = selectSuites([], 'ci', 'win32');
    expect(win.run).toContain('core');
    expect(win.run).not.toContain('terminal');
    expect(win.left.find(l => l.suite === 'terminal').reason).toMatch(/POSIX/);
    expect(selectSuites(['core'], 'ci', 'win32')).toEqual({ run: ['core'], left: [] });
    expect(() => selectSuites(['nope'], 'ci')).toThrow(/unknown suite "nope"/);
  });

  it('every suite in the table has a test file, and every test file is in the table', async () => {
    const { readdirSync } = await import('node:fs');
    const files = readdirSync('test/e2e').filter(f => f.endsWith('.e2e.mjs')).map(f => f.replace('.e2e.mjs', ''));
    expect(Object.keys(SUITES).sort()).toEqual(files.sort());
  });

  it('summarizes as a Markdown table', () => {
    const md = summarize(
      [
        { suite: 'core', ok: true, ms: 4200, cases: [{ status: 'pass', name: 'a' }] },
        { suite: 'browser-certs', ok: false, ms: 1000, problem: 'dev host did not start', cases: [{ status: 'skip', name: 'x', detail: 'needs openssl' }] },
      ],
      { vscode: 'stable 1.146.0', left: [{ suite: 'terminal', reason: 'POSIX only' }] },
    );
    expect(md).toContain('### End-to-end tests (VS Code stable 1.146.0)');
    expect(md).toContain('| core | ✅ | 1 | 0 | 0 | 4 s |');
    expect(md).toContain('| browser-certs | ❌ dev host did not start | 0 | 0 | 1 | 1 s |');
    expect(md).toContain('| terminal | ⏭️ not run here: POSIX only |');
    expect(md).toContain('- ⏭️ **browser-certs**: x (needs openssl)');
  });
});

describe('canary issue', () => {
  const okReport = { vscodeVersion: '1.147.0-insider (abc)', results: [{ suite: 'core', ok: true, cases: [{ status: 'pass', name: 'a' }] }] };
  const failing = { vscodeVersion: '1.147.0-insider (abc)', results: [{ suite: 'browser-page', ok: false, cases: [{ status: 'pass', name: 'a' }, { status: 'fail', name: 'clicks' }] }, { suite: 'ui', ok: false, problem: 'dev host did not start', cases: [] }] };
  const apiOk = { exit: 0, text: 'match' };
  const apiChanged = { exit: 1, text: 'Proposed-API typings ... differs' };

  it('all fine: nothing to do, or close the open issue', () => {
    const state = assess({ e2e: okReport, api: apiOk });
    expect(state).toMatchObject({ e2eState: 'ok', apiState: 'ok', broken: false, allOk: true });
    expect(plan(state, undefined)).toEqual({ kind: 'none' });
    expect(plan(state, { number: 7, body: '' })).toMatchObject({ kind: 'close' });
  });

  it('broken: opens one issue, then updates it, commenting only when what is broken changed', () => {
    const state = assess({ e2e: failing, api: apiOk });
    expect(state.failures).toEqual(['browser-page: clicks', 'ui: dev host did not start']);
    expect(plan(state, undefined)).toEqual({ kind: 'create' });
    const body = issueBody(state, { e2e: failing, api: apiOk, runUrl: 'https://run', now: new Date('2026-11-14T04:00:00Z') });
    expect(body).toContain('VS Code Insiders 1.147.0-insider (abc)');
    expect(body).toContain('- ❌ browser-page: clicks');
    expect(fingerprintOf(body)).toBe(state.fingerprint);
    expect(plan(state, { number: 7, body })).toEqual({ kind: 'update', comment: undefined });
    const worse = assess({ e2e: failing, api: apiChanged });
    expect(plan(worse, { number: 7, body }).comment).toMatch(/changed since the last report/);
  });

  it('unknown results never open or close the issue', () => {
    const noReport = assess({ e2e: undefined, api: apiOk });
    expect(noReport).toMatchObject({ e2eState: 'unknown', broken: false, allOk: false });
    expect(plan(noReport, { number: 7, body: '' })).toEqual({ kind: 'none' });
    expect(plan(assess({ e2e: okReport, api: { exit: 2, text: 'could not be compared' } }), { number: 7, body: '' })).toEqual({ kind: 'none' });
    // A real change still counts when the other half is unknown.
    expect(plan(assess({ e2e: undefined, api: apiChanged }), undefined)).toEqual({ kind: 'create' });
  });
});
