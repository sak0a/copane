// Downloads an agent starts in a browser tab: saved under a unique name in the agent downloads folder,
// reported with their path, waited for, refused when the user or the setting says no.
//
//   node scripts/dev-host.mjs --name <n>
//   node test/e2e/browser-downloads.e2e.mjs --name <n> [--only <text>]
//
// The downloads folder is pointed at a temporary folder of the dev host for the run, so nothing lands in
// the real Downloads folder; the last case checks that.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDownloadServer } from '../fixtures/browser-downloads/server.mjs';
import { agent, assert, hostDir, run, sleep, test } from './harness.mjs';

const server = await startDownloadServer();
const folder = mkdtempSync(join(hostDir, 'downloads-'));
const staging = () => {
  const dir = join(tmpdir(), 'copane-downloads');
  return existsSync(dir) ? readdirSync(dir).flatMap(pid => readdirSync(join(dir, pid))) : [];
};
const realDownloads = join(homedir(), 'Downloads');
const realBefore = existsSync(realDownloads) ? new Set(readdirSync(realDownloads)) : new Set();

const settingsFile = join(hostDir, 'ud', 'User', 'settings.json');
const baseSettings = JSON.parse(readFileSync(settingsFile, 'utf8'));
async function setSettings(values) {
  writeFileSync(settingsFile, JSON.stringify({ ...baseSettings, 'copane.browser.downloadsFolder': folder, ...values }, null, 2));
  await sleep(2500); // VS Code picks up the file change asynchronously.
}
const shown = async a => JSON.parse(await a.ok('debug_answer_prompts', {})).shown;
let sessions = 0;
const session = name => agent({ session: `downloads-${name}-${Date.now()}-${++sessions}` });
const savedPath = text => /saved to (.+) \([\d.]+ k?B\)/.exec(text)?.[1];

test('a click that downloads reports the saved file; the same name again gets a new name', async () => {
  await setSettings({ 'copane.browser.agentDownloads': 'allow' });
  const a = await session('click');
  try {
    await a.ok('browser_open', { url: server.url('/') });
    const first = await a.ok('browser_click', { selector: '#report' });
    assert.match(first, /Download dl-\d+ report\.csv: saved to .*report\.csv \(2\.0 kB\)\./);
    const path = savedPath(first);
    assert.equal(path, join(folder, 'report.csv'));
    assert.equal(statSync(path).size, 2048);
    const second = await a.ok('browser_click', { selector: '#report' });
    assert.equal(savedPath(second), join(folder, 'report (1).csv'));
    assert.match(second, /renamed because report\.csv already existed/);
    assert.equal(readFileSync(path, 'utf8'), readFileSync(savedPath(second), 'utf8'), 'the first file is untouched');
    await a.ok('browser_tab', { action: 'close' });
  } finally {
    await a.close();
  }
});

test('a file the page generates (blob URL) is saved under the name the page gave it', async () => {
  const a = await session('blob');
  try {
    await a.ok('browser_open', { url: server.url('/') });
    const result = await a.ok('browser_click', { selector: '#blob' });
    const path = savedPath(result);
    assert.ok(path?.endsWith('generated.csv'), result);
    assert.equal(readFileSync(path, 'utf8'), 'made,in,page\n1,2,3\n');
    await a.ok('browser_tab', { action: 'close' });
  } finally {
    await a.close();
  }
});

test('a broken download fails with how much arrived; a slow one can be waited for', async () => {
  const a = await session('slow');
  try {
    await a.ok('browser_open', { url: server.url('/') });
    assert.match(await a.ok('browser_click', { selector: '#broken' }), /broken\.bin: failed after 1\.0 kB of 100\.0 kB: the browser cancelled it/);
    const slow = await a.ok('browser_click', { selector: '#slow' });
    assert.match(slow, /slow\.bin: downloading, \d+% .*browser_downloads with wait: true/);
    const waited = await a.ok('browser_downloads', { wait: true });
    assert.match(waited, /slow\.bin: saved to .*slow\.bin \(65\.5 kB\)/);
    assert.equal(statSync(savedPath(waited)).size, 65536);
    const list = await a.ok('browser_downloads', {});
    assert.match(list, /^dl-\d+ slow\.bin: saved[^\n]*\ndl-\d+ broken\.bin: failed/);
    await a.ok('browser_tab', { action: 'close' });
  } finally {
    await a.close();
  }
});

test('a download that starts well after the click is caught by waiting for it', async () => {
  const a = await session('late');
  try {
    await a.ok('browser_open', { url: server.url('/?delay=2500') });
    const click = await a.ok('browser_click', { selector: '#late' });
    assert.doesNotMatch(click, /Download/);
    const waited = await a.ok('browser_downloads', { wait: true, timeoutSeconds: 20 });
    assert.match(waited, /export\.txt: saved to /);
    assert.equal(statSync(savedPath(waited)).size, 50);
    assert.match(await a.ok('browser_downloads', { wait: true, timeoutSeconds: 2 }), /No download started in tab-\d+ within 2 s\./);
    await a.ok('browser_tab', { action: 'close' });
  } finally {
    await a.close();
  }
});

test('"ask": the user denies (file deleted) or allows once per session', async () => {
  await setSettings({ 'copane.browser.agentDownloads': 'ask' });
  const a = await session('deny');
  const b = await session('allow');
  try {
    await a.ok('debug_answer_prompts', { answers: ['Deny'], clear: true });
    await a.ok('browser_open', { url: server.url('/') });
    const before = new Set(readdirSync(folder));
    const denied = await a.ok('browser_click', { selector: '#report' });
    assert.match(denied, /report\.csv: not saved, the user declined it/);
    const prompt = (await shown(a)).at(-1);
    assert.match(prompt.message, /is downloading "report\.csv" from 127\.0\.0\.1:\d+\. Save it, and further downloads of this session, to /);
    assert.deepEqual(prompt.choices, ['Allow', 'Always Allow', 'Deny']);
    assert.deepEqual(new Set(readdirSync(folder)), before, 'nothing was saved');
    await a.ok('browser_tab', { action: 'close' });

    await b.ok('debug_answer_prompts', { answers: ['Allow'], clear: true });
    await b.ok('browser_open', { url: server.url('/') });
    const count = (await shown(b)).length;
    assert.match(await b.ok('browser_click', { selector: '#report' }), /report.*\.csv: saved to /);
    assert.match(await b.ok('browser_click', { selector: '#same' }), /same.*\.txt: saved to /);
    assert.equal((await shown(b)).length, count + 1, 'asked once for the session');
    await b.ok('browser_tab', { action: 'close' });
  } finally {
    await a.close();
    await b.close();
  }
});

test('"deny": nothing is saved and the agent is told why', async () => {
  await setSettings({ 'copane.browser.agentDownloads': 'deny' });
  const a = await session('setting');
  try {
    await a.ok('browser_open', { url: server.url('/') });
    const count = (await shown(a)).length;
    assert.match(await a.ok('browser_click', { selector: '#same' }), /same\.txt: not saved, the setting copane\.browser\.agentDownloads is "deny"/);
    assert.equal((await shown(a)).length, count, 'the user was not asked');
    await a.ok('browser_tab', { action: 'close' });
  } finally {
    await a.close();
    await setSettings({ 'copane.browser.agentDownloads': 'allow' });
  }
});

test('nothing went to the real Downloads folder and the staging folder is empty', async () => {
  await sleep(6000); // Capture ends a few seconds after the last action.
  const added = existsSync(realDownloads) ? readdirSync(realDownloads).filter(n => !realBefore.has(n)) : [];
  assert.deepEqual(added.filter(n => /report|same|slow|broken|generated|export/.test(n)), []);
  assert.deepEqual(staging(), []);
});

// run() ends the process; put the settings back and remove the folder however it ends (also with --only).
process.on('exit', () => {
  writeFileSync(settingsFile, JSON.stringify(baseSettings, null, 2));
  rmSync(folder, { recursive: true, force: true });
});

await run();
