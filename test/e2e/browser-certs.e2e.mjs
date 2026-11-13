// Certificate errors in tabs an agent drives: asked once per host, remembered, never accepted silently.
//
//   node scripts/dev-host.mjs --name <n>
//   node test/e2e/browser-certs.e2e.mjs --name <n>
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startSelfSignedServer } from '../fixtures/browser-certs/server.mjs';
import { agent, assert, hostDir, run, sleep, test } from './harness.mjs';

const server = await startSelfSignedServer();
const settingsFile = join(hostDir, 'ud', 'User', 'settings.json');
const original = readFileSync(settingsFile, 'utf8');
async function setSettings(values) {
  writeFileSync(settingsFile, JSON.stringify({ ...JSON.parse(original), ...values }, null, 2));
  await sleep(1500); // VS Code picks up the file change.
}
const shown = async a => JSON.parse(await a.ok('debug_answer_prompts', {})).shown;
const queue = (a, answers) => a.ok('debug_answer_prompts', { answers, clear: true });
const unique = () => `/?t=${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

test('a declined certificate fails with the reason and is not asked again right away', async () => {
  await setSettings({ 'copane.browser.trustedCertificateHosts': [] });
  const a = await agent({ session: `certs-decline-${Date.now()}` });
  try {
    await queue(a, ['Cancel']);
    await a.ok('browser_open', { url: 'about:blank' });
    const before = (await shown(a)).length;
    const first = await a.call('browser_navigate', { url: server.url('127.0.0.1', unique()) });
    assert.ok(first.isError);
    assert.match(first.text, /certificate is not trusted and the user declined/);
    const prompt = (await shown(a)).at(-1);
    assert.match(prompt.message, /is opening 127\.0\.0\.1, whose security certificate is not trusted: it is self-signed/);
    assert.deepEqual(prompt.choices, ['Proceed', 'Always Trust 127.0.0.1', 'Cancel']);
    const second = await a.call('browser_navigate', { url: server.url('127.0.0.1', unique()) });
    assert.ok(second.isError);
    assert.match(second.text, /asked a moment ago/);
    assert.equal((await shown(a)).length, before + 1, 'the user was asked exactly once');
    await a.ok('browser_close_tab', {});
  } finally {
    await a.close();
  }
});

test('"Always Trust" loads the page, saves the host, and later sessions are not asked', async () => {
  await setSettings({ 'copane.browser.trustedCertificateHosts': [] });
  const a = await agent({ session: `certs-always-${Date.now()}` });
  const b = await agent({ session: `certs-later-${Date.now()}` });
  try {
    await queue(a, ['Always Trust localhost']);
    await a.ok('browser_open', { url: 'about:blank' });
    assert.match(await a.ok('browser_navigate', { url: server.url('localhost', unique()) }), /Self-signed fixture/);
    await sleep(1000);
    assert.deepEqual(JSON.parse(readFileSync(settingsFile, 'utf8'))['copane.browser.trustedCertificateHosts'], ['localhost']);
    const before = (await shown(a)).length;
    await b.ok('browser_open', { url: 'about:blank' });
    assert.match(await b.ok('browser_navigate', { url: server.url('localhost', unique()) }), /Self-signed fixture/);
    assert.equal((await shown(b)).length, before, 'a trusted host does not ask');
    await a.ok('browser_close_tab', {});
    await b.ok('browser_close_tab', {});
  } finally {
    await a.close();
    await b.close();
  }
});

test('the "block" setting refuses without asking, even for a host in the trusted list', async () => {
  const a = await agent({ session: `certs-settings-${Date.now()}` });
  try {
    await setSettings({ 'copane.browser.trustedCertificateHosts': ['127.0.0.1'], 'copane.browser.certificateErrors': 'block' });
    await queue(a, []);
    await a.ok('browser_open', { url: 'about:blank' });
    const before = (await shown(a)).length;
    const blocked = await a.call('browser_navigate', { url: server.url('127.0.0.1', unique()) });
    assert.ok(blocked.isError, blocked.text);
    assert.match(blocked.text, /certificate is not trusted/);
    assert.equal((await shown(a)).length, before, '"block" never asks');
    await a.ok('browser_close_tab', {});
  } finally {
    await a.close();
    await setSettings({});
  }
});

test('cleanup', async () => {
  writeFileSync(settingsFile, original);
  await server.close();
});

await run();
