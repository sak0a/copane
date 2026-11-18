// Device and media emulation (browser_emulate): what the page sees, screenshots and clicks by
// coordinates under emulation, what the user sees in VS Code, and that emulation ends with the
// session's control of the tab or when the user resets it.
//
//   node scripts/dev-host.mjs --name <n>
//   node test/e2e/browser-emulation.e2e.mjs --name <n> [--only <text>]
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { startEmulationServer } from '../fixtures/browser-emulation/server.mjs';
import { agent, assert, hostName, root, run, sleep, test, until } from './harness.mjs';

const server = await startEmulationServer();
let sessions = 0;
const session = name => agent({ session: `emulation-${name}-${Date.now()}-${++sessions}` });

const report = async a => JSON.parse(await a.ok('browser_evaluate', { function: '() => JSON.stringify(report())' }));
/**
 * The page's report once its size has settled. A tab starts at VS Code's placeholder size (1024×768)
 * and gets the editor's real size a moment after it is shown; reading the "normal" size too early
 * made later comparisons fail.
 */
async function settledReport(a) {
  let last = await report(a);
  for (let same = 0, i = 0; same < 3 && i < 40; i++) {
    await sleep(150);
    const next = await report(a);
    same = next.width === last.width && next.height === last.height ? same + 1 : 0;
    last = next;
  }
  return last;
}
/** Clicks the centre of grid cell (row, col) by viewport coordinates and returns the cell the page saw. */
async function clickCell(a, row, col) {
  const r = await report(a);
  await a.ok('browser_evaluate', { function: '() => { window.lastClick = undefined; }' });
  await a.ok('browser_click', { x: ((col + 0.5) / 4) * r.width, y: ((row + 0.5) / 4) * r.height });
  return a.ok('browser_evaluate', { function: '() => String(window.lastClick)' });
}
/** Evaluates in the dev host's workbench page. */
function workbench(expression) {
  return JSON.parse(execFileSync(process.execPath, [join(root, 'scripts', 'ui.mjs'), '--name', hostName, 'eval', `JSON.stringify(${expression})`], { encoding: 'utf8' }));
}
const toolbar = () =>
  workbench(`(() => { const t = [...document.querySelectorAll('.browser-emulation-toolbar')].find(e => e.offsetParent); return t ? [...t.querySelectorAll('input')].map(i => i.value) : null; })()`);
const titleActions = () => workbench(`[...document.querySelectorAll('.editor-actions .action-label')].map(e => e.getAttribute('aria-label') || '')`);

test('a phone preset with dark scheme, locale and time zone is what the page sees', async () => {
  const a = await session('preset');
  try {
    // A notification left on screen by an earlier suite makes VS Code pause browser views; a tab opened
    // then keeps its 1024×768 placeholder size, which is not the "normal" size this suite compares with.
    await a.ok('debug_vscode_command', { command: 'notifications.clearAll' });
    await a.ok('browser_open', { url: server.url('/') });
    const before = await settledReport(a);
    const scheme = before.dark ? 'light' : 'dark';
    const result = await a.ok('browser_emulate', { preset: 'iphone-15-pro', colorScheme: scheme, reducedMotion: true, locale: 'ja-JP', timezone: 'America/New_York' });
    assert.match(result, new RegExp(`now emulates iPhone 15 Pro \\(393×852 CSS px at 3×, mobile with touch\\), ${scheme} colour scheme, reduced motion, locale ja-JP, time zone America/New_York\\. The viewport is 393×852 CSS px\\.`));
    assert.match(result, /Clicks are sent as taps/);
    const r = await report(a);
    assert.deepEqual(
      { width: r.width, height: r.height, dpr: r.dpr, dark: r.dark, reducedMotion: r.reducedMotion, coarse: r.coarse, language: r.language, timeZone: r.timeZone },
      { width: 393, height: 852, dpr: 3, dark: scheme === 'dark', reducedMotion: true, coarse: true, language: 'ja-JP', timeZone: 'America/New_York' },
    );
    assert.match(r.userAgent, /iPhone/);
    // The device shows in VS Code's own device toolbar; the agent's overrides get a reset button.
    assert.deepEqual((await until(() => toolbar(), 'the device toolbar')).slice(0, 3), ['393', '852', '3']);
    assert.ok(titleActions().some(l => /End Agent's Device Emulation/.test(l)), 'reset button in the editor title');
    assert.match(await a.ok('browser_emulate', {}), /emulates iPhone 15 Pro/);

    assert.match(await a.ok('browser_emulate', { reset: true }), /back to normal: no emulation/);
    const after = await report(a);
    assert.deepEqual([after.width, after.dpr, after.dark, after.reducedMotion, after.language, after.timeZone, after.userAgent], [before.width, before.dpr, before.dark, before.reducedMotion, before.language, before.timeZone, before.userAgent]);
    await until(() => toolbar() === null, 'the device toolbar to close');
    assert.ok(!titleActions().some(l => /End Agent's Device Emulation/.test(l)));
    await a.ok('browser_tab', { action: 'close' });
  } finally {
    await a.close();
  }
});

test('screenshots show the emulated viewport and clicks by coordinates hit, also after a reset', async () => {
  const a = await session('coords');
  try {
    await a.ok('browser_open', { url: server.url('/') });
    await a.ok('browser_emulate', { preset: 'pixel-8' });
    const shot = await a.call('browser_screenshot', {});
    assert.equal(shot.images.length, 1);
    const [, w, h] = /\((\d+)×(\d+) px; viewport 412×915 CSS px\), emulating Pixel 8/.exec(shot.text) ?? [];
    assert.ok(w && Math.abs(Number(w) / Number(h) - 412 / 915) < 0.02, shot.text);
    assert.equal(await clickCell(a, 3, 3), 'r3c3');
    assert.equal(await clickCell(a, 0, 1), 'r0c1');
    // The page still has its emulated size: the screenshot did not disturb VS Code's emulation.
    assert.equal((await report(a)).width, 412);
    // A desktop size larger than the editor is scaled down by VS Code; coordinates still map.
    await a.ok('browser_emulate', { preset: 'desktop' });
    assert.deepEqual([(await report(a)).width, (await report(a)).height], [1920, 1080]);
    assert.equal(await clickCell(a, 2, 3), 'r2c3');
    // Default detail stays within ~0.8 MP / 1280 px; detail high gives the sharper image it points at.
    const normal = await a.call('browser_screenshot', {});
    const [, nw, nh] = /\((\d+)×(\d+) px; viewport/.exec(normal.text).map(Number);
    assert.ok(Math.max(nw, nh) <= 1282 && nw * nh <= 805_000, `default ${nw}×${nh}: ${normal.text}`);
    const high = await a.call('browser_screenshot', { detail: 'high' });
    const [, hw] = /\((\d+)×(\d+) px; viewport/.exec(high.text).map(Number);
    assert.ok(hw <= 1570, high.text);
    if (/Downscaled; detail: "high"/.test(normal.text)) assert.ok(hw > nw, `detail high ${hw} px wide, default ${nw}: ${high.text}`);
    assert.doesNotMatch(high.text, /Downscaled/);
    await a.ok('browser_emulate', { reset: true });
    assert.equal(await clickCell(a, 3, 3), 'r3c3');
    assert.equal(await clickCell(a, 1, 0), 'r1c0');
    await a.ok('browser_tab', { action: 'close' });
  } finally {
    await a.close();
  }
});

test('a background tab: the screenshot is the whole viewport or says what is cut off; clicks hit', async () => {
  const a = await session('background');
  try {
    await a.ok('browser_open', { url: server.url('/'), background: true });
    await a.ok('browser_emulate', { preset: 'pixel-8' });
    // VS Code sometimes draws a background tab at the emulated size and sometimes in a fixed area without
    // fitting the device; either the image is the whole viewport, or the result says what is cut off.
    const shot = await a.call('browser_screenshot', {});
    const [, w, h] = /\((\d+)×(\d+) px; viewport 412×915 CSS px\)/.exec(shot.text) ?? [];
    if (Math.abs(Number(w) / Number(h) - 412 / 915) > 0.02) assert.match(shot.text, /is in the background, where VS Code draws it in a \d+×\d+ px area without fitting the device: the emulated viewport is the top-left \d+×\d+ px of the image/);
    assert.equal(await clickCell(a, 3, 0), 'r3c0');
    await a.ok('browser_emulate', { reset: true });
    assert.equal(await clickCell(a, 3, 3), 'r3c3');
    await a.ok('browser_tab', { action: 'close' });
  } finally {
    await a.close();
  }
});

test('emulation ends when the session releases the tab, and the agent is told', async () => {
  const a = await session('release');
  try {
    await a.ok('browser_open', { url: server.url('/') });
    const width = (await settledReport(a)).width;
    await a.ok('browser_emulate', { preset: 'iphone-se', colorScheme: 'dark' });
    await a.ok('browser_tab', { action: 'release' });
    await until(async () => (await report(a)).width === width, 'the normal width again');
    assert.equal(toolbar(), null);
    assert.match(await a.ok('browser_emulate', {}), /your earlier emulation of tab-\d+ had ended: control of tab-\d+ ended.*\n.*is not emulating anything/);
    await a.ok('browser_tab', { action: 'close' });
  } finally {
    await a.close();
  }
});

test('the user can reset it, and another session cannot change it while the tab is controlled', async () => {
  const a = await session('owner');
  const b = await session('other');
  try {
    const tab = /Opened (tab-\d+)/.exec(await a.ok('browser_open', { url: server.url('/') }))[1];
    await a.ok('browser_emulate', { preset: 'ipad-mini', locale: 'de-DE' });
    const busy = await b.call('browser_emulate', { tab, colorScheme: 'dark' });
    assert.ok(busy.isError);
    assert.match(busy.text, /is being controlled by/);
    await a.ok('debug_vscode_command', { command: 'copane.browser.resetEmulation', args: [tab] });
    await until(async () => (await report(a)).width !== 768, 'the normal width again');
    assert.equal((await report(a)).language === 'de-DE', false);
    assert.match(await a.ok('browser_emulate', {}), /had ended: the user reset it/);
    await a.ok('browser_tab', { action: 'close' });
  } finally {
    await a.close();
    await b.close();
  }
});

test('bad input is refused with a message; touch mode refuses what a touch screen cannot do', async () => {
  const a = await session('input');
  try {
    await a.ok('browser_open', { url: server.url('/') });
    const bad = await a.call('browser_emulate', { timezone: 'Mars/Olympus' });
    assert.ok(bad.isError);
    assert.match(bad.text, /not a known time zone/);
    assert.match((await a.call('browser_emulate', { landscape: true })).text, /needs a device size/);
    await a.ok('browser_emulate', { preset: 'iphone-se', landscape: true });
    assert.deepEqual([(await report(a)).width, (await report(a)).height], [667, 375]);
    const right = await a.call('browser_click', { x: 100, y: 100, button: 'right' });
    assert.ok(right.isError);
    assert.match(right.text, /emulates a touch device, which has no right button/);
    await a.ok('browser_emulate', { mobile: false });
    assert.equal(await clickCell(a, 2, 2), 'r2c2');
    await a.ok('browser_emulate', { reset: true });
    await a.ok('browser_tab', { action: 'close' });
  } finally {
    await a.close();
  }
});

await run();
