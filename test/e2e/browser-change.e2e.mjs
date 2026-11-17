// browser_check_change (page/change*.ts, png.ts, imageDiff.ts) against a running dev host:
//
//   node scripts/dev-host.mjs --name change
//   node test/e2e/browser-change.e2e.mjs --name change [--only <text>]
//
// The fixture (test/fixtures/browser-change) is a fake dev server: POST /edit?mode=… pushes an
// "edit" to app.html over an event stream, which applies it the way Vite's client does.
import { startChangeServer } from '../fixtures/browser-change/server.mjs';
import { agent, assert, run, sleep, test, until } from './harness.mjs';

const site = await startChangeServer();
const a = await agent({ session: `browser-change-${Date.now()}` });
const hasDebugCdp = (await a.tools()).some(t => t.name === 'debug_cdp');

let previous;
async function open(path = '/app.html') {
  if (previous) await a.call('browser_close_tab', { tab: previous });
  const text = await a.ok('browser_open', { url: `${site.url}${path}`, background: true });
  const id = /Opened (tab-\d+)/.exec(text)?.[1];
  assert.ok(id, `no tab id in: ${text}`);
  previous = id;
  await a.ok('browser_wait_for', { loadState: 'networkidle' });
  return id;
}

/** Takes a baseline, applies the edit, checks; returns the check's result. */
async function change(mode, checkArgs = {}, who = a) {
  const baseline = await who.ok('browser_check_change', { action: 'baseline' });
  assert.match(baseline, /^Baseline of tab-\d+ taken: http:\/\/127\.0\.0\.1:\d+\/\S+, viewport \d+×\d+ at scroll 0,0; /);
  const edited = await site.edit(mode);
  if (mode !== 'none') assert.ok(edited.clients >= 1, `no page listens for edits: ${JSON.stringify(edited)}`);
  const started = Date.now();
  const result = await who.call('browser_check_change', { action: 'check', ...checkArgs });
  assert.ok(!result.isError, `check failed: ${result.text}`);
  return { ...result, ms: Date.now() - started };
}

/** The regions of a check's screenshot line as [x0, x1, y0, y1]. */
function regionsOf(text) {
  const line = /^- Screenshot: .*$/m.exec(text)?.[0];
  assert.ok(line, `no screenshot line in:\n${text}`);
  return [...line.matchAll(/x (\d+)–(\d+) y (\d+)–(\d+)/g)].map(m => m.slice(1, 5).map(Number));
}

const near = (actual, expected, what) => assert.ok(actual.every((v, i) => Math.abs(v - expected[i]) <= 2), `${what}: ${JSON.stringify(actual)} is not ${JSON.stringify(expected)}`);

test('hot update: one region where the panel changed, an image, no errors', async () => {
  const tab = await open();
  const { text, images } = await change('hmr');
  assert.match(text, new RegExp(`^Change in ${tab} after a hot update \\(Vite: /src/app\\.js\\), settled after [\\d.]+ m?s:`));
  assert.match(text, /- No new errors or failed requests\./);
  const regions = regionsOf(text);
  assert.equal(regions.length, 1, text);
  near(regions[0], [40, 340, 120, 240], 'the panel');
  assert.match(text, /After-screenshot attached\./);
  assert.equal(images.length, 1);
  // The comparison's own PNG when it is small, else a JPEG.
  assert.match(images[0].mimeType, /^image\/(png|jpeg)$/);
  assert.ok(text.length < 600, `result too long (${text.length}):\n${text}`);
});

test('an update that throws: the exception with its location', async () => {
  await open();
  const { text } = await change('error');
  assert.match(text, /after a hot update \(Vite: \/src\/broken\.js\)/);
  // Before the merge with source mapping: the dev server's path; after it, the workspace path.
  assert.match(text, /- 1 new error:\n {2}\[exception\] Uncaught TypeError: Cannot read properties of undefined \(reading 'price'\) {2}\([^)]*src\/broken\.js:4:\d+\)/);
  assert.doesNotMatch(text, /\?t=\d/, 'the cache-busting query is left out');
});

test('an update that fetches a missing resource: one failed request, not repeated as a console error', async () => {
  await open();
  const { text } = await change('404');
  assert.match(text, /- 1 new failed request: r\d+ {2}GET 404 fetch {2}http:\/\/127\.0\.0\.1:\d+\/api\/missing/);
  assert.doesNotMatch(text, /new error/);
  assert.doesNotMatch(text, /Failed to load resource/);
});

test('a full reload from the dev server: the new document and the changed heading', async () => {
  await open();
  const { text } = await change('reload');
  assert.match(text, /after a full reload \(new document\), settled after/);
  assert.doesNotMatch(text, /Navigated:/, 'same URL');
  // Only the version number in the heading changes.
  const regions = regionsOf(text);
  assert.equal(regions.length, 1, text);
  assert.ok(regions[0][2] >= 15 && regions[0][3] <= 60, `the heading: ${JSON.stringify(regions[0])}`);
});

test('a navigation: the navigated line', async () => {
  await open();
  const { text } = await change('navigate');
  assert.match(text, /after a navigation \(new document\)/);
  assert.match(text, /- Navigated: http:\/\/127\.0\.0\.1:\d+\/app\.html → http:\/\/127\.0\.0\.1:\d+\/app\.html\?page=2/);
});

test('a build error overlay: its text, found without a console line', async () => {
  await open();
  const { text } = await change('overlay');
  assert.match(text, /- Error shown in the page by the dev server \(Vite error overlay\): \[plugin:vite:vue\] src\/components\/Cart\.vue: Unexpected token \(31:18\)/);
  assert.match(text, /Fix the cause; the overlay goes away with the next update that works\./);
});

test('a baseline with a build error showing: the check waits for the fix and says the error is gone', async () => {
  await open();
  await site.edit('overlay');
  await a.ok('browser_wait_for', { selector: 'vite-error-overlay', state: 'attached' });
  const baseline = await a.ok('browser_check_change', { action: 'baseline' });
  assert.match(baseline, /The page shows an error from the dev server \(Vite error overlay\): \[plugin:vite:vue\]/);
  const waiting = await a.ok('browser_check_change', { action: 'check', timeout: 1 });
  assert.match(waiting, /^No update reached/, 'an overlay already there is not an update');
  await site.edit('hmr');
  const fixed = await a.ok('browser_check_change', { action: 'check' });
  assert.match(fixed, /after a hot update \(Vite: \/src\/app\.js\)/);
  assert.match(fixed, /- The error overlay shown at the baseline is gone\./);
});

test('a CSS-only change: a region from DOM changes alone', async () => {
  await open();
  const { text } = await change('css');
  assert.match(text, /after DOM changes only, no dev-server message/);
  const regions = regionsOf(text);
  assert.equal(regions.length, 1, text);
  near(regions[0], [400, 520, 120, 240], 'the box');
});

test('nothing happens: the timeout text, on time', async () => {
  const tab = await open();
  const { text, images, ms } = await change('none', { timeout: 2 });
  assert.match(text, new RegExp(`^No update reached ${tab} within 2\\.0 s \\(no hot update, reload, DOM change or error since the baseline [\\d.]+ m?s ago\\)\\.`));
  assert.match(text, /A page without hot reload needs check with reload: true\./);
  assert.equal(images.length, 0);
  assert.ok(ms < 3000, `took ${ms} ms`);
});

test('a page without hot reload: reload: true works and needs control', async () => {
  const tab = await open('/plain.html');
  const { text } = await change('none', { reload: true });
  assert.match(text, /after a full reload \(new document\)/);
  assert.equal(regionsOf(text).length, 1, text);
  const b = await agent({ session: `browser-change-b-${Date.now()}` });
  try {
    const busy = await b.call('browser_check_change', { action: 'check', reload: true, tab });
    assert.ok(busy.isError && /is being controlled by/.test(busy.text), busy.text);
  } finally {
    await b.close();
  }
});

test('wrong use: check without a baseline, reload with a baseline', async () => {
  const tab = await open();
  const none = await a.call('browser_check_change', { action: 'check' });
  assert.ok(none.isError, none.text);
  assert.equal(none.text, `No baseline for ${tab} in this session. Call browser_check_change with action "baseline" before editing, then "check" after.`);
  const wrong = await a.call('browser_check_change', { action: 'baseline', timeout: 5 });
  assert.ok(wrong.isError && wrong.text === 'reload and timeout apply to "check" only.', wrong.text);
});

test("another session's baseline is its own", async () => {
  const tab = await open();
  const b = await agent({ session: `browser-change-c-${Date.now()}` });
  try {
    await a.ok('browser_check_change', { action: 'baseline' });
    await site.edit('hmr');
    await a.ok('browser_wait_for', { text: 'Panel updated' });
    await b.ok('browser_check_change', { action: 'baseline', tab });
    // b's baseline is after the update: nothing new for b, while a sees the update.
    const forB = await b.ok('browser_check_change', { action: 'check', tab, timeout: 1 });
    assert.match(forB, /^No update reached/);
    const forA = await a.ok('browser_check_change', { action: 'check' });
    assert.match(forA, /after a hot update \(Vite: \/src\/app\.js\)/);
  } finally {
    await b.close();
  }
});

test('a fix after an error: the next check waits for the next update and does not repeat the error', async () => {
  await open();
  await a.ok('browser_check_change', { action: 'baseline' });
  await site.edit('error');
  const first = await a.ok('browser_check_change', { action: 'check' });
  assert.match(first, /1 new error/);
  await site.edit('hmr');
  const second = await a.ok('browser_check_change', { action: 'check' });
  assert.match(second, /after a hot update \(Vite: \/src\/app\.js\)/);
  assert.match(second, /- No new errors or failed requests\./);
  assert.match(second, /- Reported by an earlier check of this baseline, not repeated: 1 error\./);
  // Compared with the baseline, the panel changed.
  near(regionsOf(second)[0], [40, 340, 120, 240], 'the panel');
});

test(
  'a crash: reported as such',
  async () => {
    const tab = await open();
    await a.ok('browser_check_change', { action: 'baseline' });
    await a.ok('debug_cdp', { commands: [{ method: 'Page.crash', noWait: true }], listenMs: 300 });
    const text = await a.ok('browser_check_change', { action: 'check', timeout: 5 });
    assert.match(text, new RegExp(`^The page in ${tab} crashed after the change \\(renderer gone\\)\\. Reload it with browser_history`));
  },
  { skip: hasDebugCdp ? undefined : 'debug_cdp is only available in a development host' },
);

// ---------------------------------------------------------------- pages that change on their own

test('a clock ticking every second: three checks without an edit all reach the timeout', async () => {
  await open('/app.html?clock=1000');
  await a.ok('browser_check_change', { action: 'baseline' });
  for (let i = 0; i < 3; i++) {
    const text = await a.ok('browser_check_change', { action: 'check', timeout: 4 });
    assert.match(text, /^No update reached/, `check ${i + 1}:\n${text}`);
  }
});

test('a clock ticking every 5 s: no false update either', async () => {
  await open('/app.html?clock=5000');
  await a.ok('browser_check_change', { action: 'baseline' });
  for (let i = 0; i < 2; i++) {
    const text = await a.ok('browser_check_change', { action: 'check', timeout: 6 });
    assert.match(text, /^No update reached/, `check ${i + 1}:\n${text}`);
  }
});

test('on a clock page, a hot update and a CSS-only change still count, and the note says the page changes on its own', async () => {
  await open('/app.html?clock=1000');
  // The watch starts with the baseline and knows the clock after two of its ticks.
  await a.ok('browser_check_change', { action: 'baseline' });
  await sleep(2500);
  await site.edit('hmr');
  const hot = await a.ok('browser_check_change', { action: 'check' });
  assert.match(hot, /after a hot update \(Vite: \/src\/app\.js\)/);
  assert.match(hot, /The page changes on its own \(1 element keeps changing/);
  await a.ok('browser_check_change', { action: 'baseline' });
  await site.edit('css');
  const css = await a.ok('browser_check_change', { action: 'check' });
  assert.match(css, /after DOM changes only, no dev-server message/);
  assert.ok(regionsOf(css).some(r => Math.abs(r[0] - 400) <= 2 && Math.abs(r[2] - 120) <= 2), css);
});

test('a page that polls with a timestamp: no false update, and a real update settles without waiting for the polling', async () => {
  await open('/app.html?poll=700');
  await sleep(1600);
  await a.ok('browser_check_change', { action: 'baseline' });
  const idle = await a.ok('browser_check_change', { action: 'check', timeout: 3 });
  assert.match(idle, /^No update reached/, idle);
  assert.doesNotMatch(idle, /api\/status/);
  await site.edit('hmr');
  const hot = await a.ok('browser_check_change', { action: 'check' });
  assert.match(hot, /after a hot update \(Vite: \/src\/app\.js\), settled after ([\d.]+) (m?s)/);
  const [, n, unit] = /settled after ([\d.]+) (m?s)/.exec(hot);
  assert.ok((unit === 'ms' ? Number(n) : Number(n) * 1000) < 3000, hot);
  assert.doesNotMatch(hot, /requests were still running/);
});

// ---------------------------------------------------------------- what a check reports, exactly once

test('an error that lands while a check is finishing is listed by the next check, not lost', async () => {
  await open();
  await a.ok('browser_check_change', { action: 'baseline' });
  await site.edit('late');
  const first = await a.ok('browser_check_change', { action: 'check' });
  await sleep(1500);
  const second = await a.ok('browser_check_change', { action: 'check', timeout: 3 });
  const listed = [first, second].filter(t => /\[error\] late error after the update/.test(t)).length;
  assert.equal(listed, 1, `the late error must be listed exactly once:\n--- first\n${first}\n--- second\n${second}`);
  if (/late error/.test(second)) assert.doesNotMatch(second, /Reported by an earlier check/);
  else assert.match(second, /^No update reached/);
});

test('a request that fails after the check returned is listed by the next check', async () => {
  await open();
  await a.ok('browser_check_change', { action: 'baseline' });
  await site.edit('slowfail');
  const first = await a.ok('browser_check_change', { action: 'check', timeout: 3 });
  assert.doesNotMatch(first, /api\/slow/, first);
  await sleep(5000);
  const second = await a.ok('browser_check_change', { action: 'check', timeout: 3 });
  assert.match(second, /- 1 new failed request: r\d+ {2}GET 500 fetch {2}http:\/\/127\.0\.0\.1:\d+\/api\/slow\?ms=5000/, second);
});

test('a failed request from before the baseline is "still there" after a reload, not new', async () => {
  await open('/missing.html');
  const baseline = await a.ok('browser_check_change', { action: 'baseline' });
  assert.match(baseline, /0 console errors and 1 failed request/, baseline);
  const text = await a.ok('browser_check_change', { action: 'check', reload: true });
  assert.doesNotMatch(text, /- \d+ new (error|failed request)/, text);
  assert.match(text, /- No new errors or failed requests\./, text);
  assert.match(text, /- Still there from before the change: 1 failed request\./, text);
  // A later check does not count it as reported by an earlier one either.
  const again = await a.ok('browser_check_change', { action: 'check', reload: true });
  assert.doesNotMatch(again, /Reported by an earlier check/, again);
});

// ---------------------------------------------------------------- geometry, frames, a stuck tab, the user taking over

test('an emulated device in a background tab: regions in CSS px of the device', async () => {
  const tab = await open('/plain.html');
  await a.ok('browser_emulate', { width: 400, height: 4000, deviceScaleFactor: 3 });
  try {
    // A page loaded under the emulation can be laid out differently from one that was emulated after it
    // loaded (on the Linux CI runner the heading counted as changed), so load it under the emulation first.
    await a.ok('browser_history', { action: 'reload' });
    const { text } = await change('none', { reload: true });
    const regions = regionsOf(text);
    assert.equal(regions.length, 1, text);
    // The version number sits at CSS x 20, y 100 (16 px monospace, about 10 px per digit; only the
    // digits that changed show). The image may be as coarse as 0.36 px per CSS px.
    const [x0, x1, y0, y1] = regions[0];
    assert.ok(x0 >= 17 && x1 <= 55 && x1 > x0 && y0 >= 96 && y0 <= 106 && y1 >= 110 && y1 <= 124, `the version number: ${JSON.stringify(regions[0])}\n${text}`);
    assert.match(text, /About the after-screenshot: Screenshot of the viewport in tab-\d+/);
  } finally {
    await a.call('browser_emulate', { reset: true, tab });
  }
});

test('a reload inside a cross-origin frame counts as an update', async () => {
  const story = await startChangeServer({ host: 'localhost' });
  try {
    await open(`/frame.html?story=${encodeURIComponent(`${story.url}/story.html`)}`);
    await sleep(500);
    await a.ok('browser_check_change', { action: 'baseline' });
    await story.edit('frame');
    const text = await a.ok('browser_check_change', { action: 'check', timeout: 8 });
    assert.match(text, /after a reload of the frame http:\/\/localhost:\d+\/story\.html/, text);
    assert.match(text, /- The frame http:\/\/localhost:\d+\/story\.html loaded a new document\./);
  } finally {
    await story.close();
  }
});

test('a tab that stops answering: the check returns on time and says so', async () => {
  const tab = await open();
  await a.ok('browser_check_change', { action: 'baseline' });
  await site.edit('hang');
  const started = Date.now();
  const text = await a.ok('browser_check_change', { action: 'check', timeout: 3 });
  const ms = Date.now() - started;
  assert.match(text, new RegExp(`^${tab} did not respond while`), text);
  assert.ok(ms < 15_000, `took ${ms} ms`);
});

test('the user takes the tab over during a check: the check stops without reading on', async () => {
  const tab = await open();
  await a.ok('browser_check_change', { action: 'baseline' });
  const checking = a.call('browser_check_change', { action: 'check', timeout: 10 });
  await sleep(1500);
  const b = await agent({ session: `browser-change-user-${Date.now()}` });
  try {
    await b.ok('debug_vscode_command', { command: 'copane.browser.pauseTab', args: [tab] });
    await site.edit('error'); // what the user does now must not reach the agent
    const result = await checking;
    assert.ok(result.isError, result.text);
    assert.match(result.text, new RegExp(`The user has paused agent access to ${tab}`));
    assert.doesNotMatch(result.text, /price/);
    assert.equal(result.images.length, 0);
  } finally {
    await b.call('debug_vscode_command', { command: 'copane.browser.resumeTab', args: [tab] });
    await b.close();
  }
});

test('the page indicator is shown again after a check is cancelled while it captures', async () => {
  await open();
  const indicator = () => a.ok('browser_evaluate', { function: "() => [...document.querySelectorAll('[data-copane-ui]')].map(e => e.style.getPropertyValue('visibility') || 'shown').join(',')" });
  const before = await indicator();
  if (!before) return console.log('      (no page indicator on this tab; nothing to check)');
  for (const delay of [50, 150, 300, 600]) {
    const controller = new AbortController();
    const pending = a.mcp.callTool({ name: 'browser_check_change', arguments: { action: 'baseline' } }, undefined, { signal: controller.signal }).catch(() => undefined);
    await sleep(delay);
    controller.abort();
    await pending;
    await until(async () => !(await indicator()).includes('hidden'), `the indicator to be shown again (cancelled after ${delay} ms)`, { timeoutMs: 5000 });
  }
});

// ---------------------------------------------------------------- second review

test('the same element edited twice, 3 s apart, counts both times; a new baseline starts over', async () => {
  await open();
  await a.ok('browser_check_change', { action: 'baseline' });
  await sleep(6000);
  await site.edit('css');
  const first = await a.ok('browser_check_change', { action: 'check' });
  assert.match(first, /after DOM changes only, no dev-server message/, first);
  await sleep(3000);
  await site.edit('css');
  const second = await a.ok('browser_check_change', { action: 'check' });
  assert.match(second, /after DOM changes only, no dev-server message/, second);
  await a.ok('browser_check_change', { action: 'baseline' });
  await site.edit('css');
  const third = await a.ok('browser_check_change', { action: 'check' });
  assert.match(third, /after DOM changes only, no dev-server message/, third);
  for (const t of [first, second, third]) assert.doesNotMatch(t, /The page changes on its own/, t);
});

test('a request to an endpoint the page called before fails after the check: the next check lists it', async () => {
  await open('/app.html?slowcalls=2');
  await sleep(800);
  await a.ok('browser_check_change', { action: 'baseline' });
  await site.edit('slowpoll');
  const first = await a.ok('browser_check_change', { action: 'check' });
  await sleep(2500);
  const second = await a.ok('browser_check_change', { action: 'check', timeout: 4 });
  const failure = /new failed request: r\d+ {2}GET 500 fetch {2}http:\/\/127\.0\.0\.1:\d+\/api\/slow\?ms=2000&status=500&n=3/;
  const listed = [first, second].filter(t => failure.test(t)).length;
  assert.equal(listed, 1, `listed ${listed} times:\n--- first\n${first}\n--- second\n${second}`);
});

test("a request the previous document left unfinished does not hold the check open", async () => {
  await open();
  await a.ok('browser_check_change', { action: 'baseline' });
  await site.edit('stalereload');
  const text = await a.ok('browser_check_change', { action: 'check' });
  assert.match(text, /after a full reload \(new document\), settled after ([\d.]+) (m?s)/, text);
  const [, n, unit] = /settled after ([\d.]+) (m?s)/.exec(text);
  assert.ok((unit === 'ms' ? Number(n) : Number(n) * 1000) < 4000, text);
  assert.doesNotMatch(text, /requests were still running/, text);
});

test('after a reload, the next checks are named after what happened since the last check', async () => {
  await open();
  await a.ok('browser_check_change', { action: 'baseline' });
  await site.edit('reload');
  assert.match(await a.ok('browser_check_change', { action: 'check' }), /after a full reload \(new document\)/);
  await site.edit('hmr');
  const hot = await a.ok('browser_check_change', { action: 'check' });
  assert.match(hot, /after a hot update \(Vite: \/src\/app\.js\)/, hot);
  assert.doesNotMatch(hot, /Navigated:/);
  await site.edit('same');
  const same = await a.ok('browser_check_change', { action: 'check' });
  assert.match(same, /^No update in tab-\d+ after [\d.]+ m?s: the dev server rebuilt, but nothing changed \("\[webpack-dev-server\] Nothing changed\."\)/, same);
});

test('a page busy for 4 s after a real update: waited for, and said', async () => {
  await open();
  await a.ok('browser_check_change', { action: 'baseline' });
  await site.edit('busy');
  const text = await a.ok('browser_check_change', { action: 'check' });
  assert.match(text, /^Change in tab-\d+ after a hot update \(Vite: \/src\/app\.js\)/, text);
  assert.match(text, /Note: the page was busy \(not answering\) for [3-5]\.\d s after the update/, text);
});

test('a carousel (2 s) and a feed (1.5 s) change on their own: no false update', async () => {
  for (const page of ['/app.html?carousel=2000', '/app.html?feed=1500']) {
    await open(page);
    await a.ok('browser_check_change', { action: 'baseline' });
    for (let i = 0; i < 2; i++) {
      const text = await a.ok('browser_check_change', { action: 'check', timeout: 5 });
      assert.match(text, /^No update reached/, `${page}, check ${i + 1}:\n${text}`);
    }
  }
});

test('a slow ticker (7 s) without an edit: a timeout, or a DOM-only result that says it may not be the edit', async () => {
  await open('/app.html?ticker=7000');
  await a.ok('browser_check_change', { action: 'baseline' });
  for (let i = 0; i < 2; i++) {
    const text = await a.ok('browser_check_change', { action: 'check', timeout: 8 });
    assert.ok(/^No update reached/.test(text) || /DOM changes only, no dev-server message \(if this page changes on its own, this may not be your edit: check again, or use reload: true\)/.test(text), text);
  }
});

test('cleanup: close the last tab', async () => {
  if (previous) await a.ok('browser_close_tab', { tab: previous });
});

try {
  await run();
} finally {
  await site.close();
}
