// browser_check_change (page/change*.ts, png.ts, imageDiff.ts) against a running dev host:
//
//   node scripts/dev-host.mjs --name change
//   node test/e2e/browser-change.e2e.mjs --name change [--only <text>]
//
// The fixture (test/fixtures/browser-change) is a fake dev server: POST /edit?mode=… pushes an
// "edit" to app.html over an event stream, which applies it the way Vite's client does.
import { startChangeServer } from '../fixtures/browser-change/server.mjs';
import { agent, assert, run, test } from './harness.mjs';

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
  assert.match(baseline, /^Baseline of tab-\d+ taken: http:\/\/127\.0\.0\.1:\d+\/\w+\.html, viewport \d+×\d+ at scroll 0,0; /);
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
  assert.match(text, /- Build error shown in the page \(Vite error overlay\): \[plugin:vite:vue\] src\/components\/Cart\.vue: Unexpected token \(31:18\)/);
  assert.match(text, /Fix the file; the page updates by itself once it compiles\./);
});

test('a baseline with a build error showing: the check waits for the fix and says the error is gone', async () => {
  await open();
  await site.edit('overlay');
  await a.ok('browser_wait_for', { selector: 'vite-error-overlay', state: 'attached' });
  const baseline = await a.ok('browser_check_change', { action: 'baseline' });
  assert.match(baseline, /The page shows a build error \(Vite error overlay\): \[plugin:vite:vue\]/);
  const waiting = await a.ok('browser_check_change', { action: 'check', timeout: 1 });
  assert.match(waiting, /^No update reached/, 'an overlay already there is not an update');
  await site.edit('hmr');
  const fixed = await a.ok('browser_check_change', { action: 'check' });
  assert.match(fixed, /after a hot update \(Vite: \/src\/app\.js\)/);
  assert.match(fixed, /- The build error shown at the baseline is gone\./);
});

test('a CSS-only change: a region from DOM changes alone', async () => {
  await open();
  const { text } = await change('css');
  assert.match(text, /after DOM changes \(no hot-update message seen\)/);
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

test('cleanup: close the last tab', async () => {
  if (previous) await a.ok('browser_close_tab', { tab: previous });
});

try {
  await run();
} finally {
  await site.close();
}
