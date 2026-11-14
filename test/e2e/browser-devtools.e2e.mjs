// browser_export_test (recorder.ts, locators.ts, testCode.ts) and browser_audit (a11y.ts, perf.ts)
// against a running dev host:
//
//   node scripts/dev-host.mjs --name devtools
//   node test/e2e/browser-devtools.e2e.mjs --name devtools [--only <text>] [--playwright <dir>]
//
// Flows are recorded on the fixture pages (test/fixtures/pages, test/fixtures/browser-devtools) and the
// exported code is checked for the locators it should use. With --playwright <dir> (a directory where
// `npm i @playwright/test && npx playwright install chromium` was run, outside this repository), the
// exported tests are also written there and run with Playwright, unmodified, while the fixture servers
// are still up; the last case reports how many passed.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startDevtoolsServer } from '../fixtures/browser-devtools/server.mjs';
import { startFixtureServer } from '../fixtures/pages/server.mjs';
import { agent, assert, hostDir, run, sleep, test } from './harness.mjs';

const site = await startFixtureServer();
const other = await startFixtureServer({ host: 'localhost' });
const third = await startFixtureServer({ host: '::1' });
const tools = await startDevtoolsServer();
const playwrightIndex = process.argv.indexOf('--playwright');
const playwrightDir = playwrightIndex >= 0 ? process.argv[playwrightIndex + 1] : undefined;

const a = await agent({ session: `browser-devtools-${Date.now()}` });
/** Exported test code per case, for the Playwright run. */
const exported = new Map();

let previous;
async function open(url) {
  if (previous) await a.call('browser_close_tab', { tab: previous });
  const text = await a.ok('browser_open', { url, background: true });
  const id = /Opened (tab-\d+)/.exec(text)?.[1];
  assert.ok(id, `no tab id in: ${text}`);
  previous = id;
  await a.ok('browser_wait_for', { loadState: 'load' });
  return id;
}

function refOf(snapshot, pattern) {
  const m = new RegExp(`${pattern}[^\\n]*?\\[ref=(e\\d+)\\]`).exec(snapshot);
  assert.ok(m, `no line matching /${pattern}/ in snapshot:\n${snapshot}`);
  return m[1];
}

/** Exports the current tab's recording and returns the code (asserting the result's shape). */
async function exportTest(name, args = {}) {
  const text = await a.ok('browser_export_test', { name, ...args });
  const code = /```ts\n([\s\S]*?)```/.exec(text)?.[1];
  assert.ok(code, `no code block in:\n${text}`);
  assert.match(code, /^\/\/ Recorded with Copane/);
  assert.match(code, /import \{ test(, expect)? \} from '@playwright\/test';/);
  exported.set(name, code);
  return { code, text };
}

const has = (code, line) => assert.ok(code.includes(line), `expected the test to contain\n  ${line}\nbut it is:\n${code}`);

// ---------------------------------------------------------------- export

test('export: a form filled with refs becomes role locators; the password is not in the test', async () => {
  await open(`${site.url}/form.html`);
  const snap = await a.ok('browser_snapshot');
  const r = p => refOf(snap, p);
  await a.ok('browser_fill_form', {
    fields: [
      { ref: r('textbox "Name"'), value: 'Ada' },
      { ref: r('textbox "Email"'), value: 'ada@example.com' },
      { ref: r('textbox "Password"'), value: 'hunter2-secret' },
      { ref: r('checkbox "I accept the terms"'), value: true },
      { ref: r('combobox "Country"'), value: 'France' },
      { ref: r('radio "Pro"'), value: true },
      { ref: r('listbox "Toppings"'), value: ['Ham', 'Olives'] },
    ],
  });
  await a.ok('browser_type', { ref: r('textbox "Bio"'), text: 'Hello there' });
  await a.ok('browser_press_key', { key: 'Tab' });
  await a.ok('browser_click', { ref: r('button "Create account"') });
  await a.ok('browser_wait_for', { text: 'Saved:' });
  const { code, text } = await exportTest('sign up form');
  has(code, `await page.goto('${site.url}/form.html');`);
  has(code, `await page.getByRole('textbox', { name: 'Name' }).fill('Ada');`);
  has(code, `await page.getByRole('textbox', { name: 'Password' }).fill(process.env.PASSWORD!);`);
  has(code, `await page.getByRole('checkbox', { name: 'I accept the terms' }).check();`);
  has(code, `await page.getByRole('combobox', { name: 'Country' }).selectOption('France');`);
  has(code, `await page.getByRole('radio', { name: 'Pro' }).check();`);
  has(code, `await page.getByRole('listbox', { name: 'Toppings' }).selectOption(['Ham', 'Olives']);`);
  has(code, `await page.keyboard.press('Tab');`);
  has(code, `await page.getByRole('button', { name: 'Create account' }).click();`);
  has(code, `await expect(page.getByText('Saved:').first()).toBeVisible();`);
  assert.ok(!text.includes('hunter2-secret'), 'the password must not appear in the export');
  assert.match(text, /Set PASSWORD before running it/);
});

test('export: a single-page app: URL changes become assertions, hover, double and right clicks, late text', async () => {
  await open(`${site.url}/spa.html`);
  const snap = await a.ok('browser_snapshot');
  await a.ok('browser_click', { ref: refOf(snap, 'link "Items"') });
  await a.ok('browser_click', { ref: refOf(snap, 'button "Banana"') });
  await a.ok('browser_wait_for', { text: 'Picked Banana' });
  await a.ok('browser_hover', { selector: '#hoverme' });
  await a.ok('browser_wait_for', { text: 'Helpful tooltip' });
  await a.ok('browser_click', { ref: refOf(snap, 'button "Double target"'), doubleClick: true });
  await a.ok('browser_click', { ref: refOf(snap, 'button "Context target"'), button: 'right' });
  await a.ok('browser_wait_for', { text: 'context menu at button 2' });
  await a.ok('browser_click', { ref: refOf(snap, 'button "Load later"') });
  await a.ok('browser_wait_for', { text: 'Loaded later!' });
  const { code } = await exportTest('single-page app');
  has(code, `await page.getByRole('link', { name: 'Items' }).click();`);
  has(code, `await expect(page).toHaveURL('${site.url}/spa/items');`);
  has(code, `await page.getByRole('button', { name: 'Banana' }).click();`);
  has(code, `await page.getByText('Hover me').hover();`);
  has(code, `await page.getByRole('button', { name: 'Double target' }).dblclick();`);
  has(code, `await page.getByRole('button', { name: 'Context target' }).click({ button: 'right' });`);
  has(code, `await expect(page.getByText('Loaded later!').first()).toBeVisible();`);
});

test('export: iframes (same-origin and cross-origin) and shadow DOM get frameLocator chains', async () => {
  await open(`${site.url}/frames.html?other=${encodeURIComponent(other.url)}`);
  await sleep(500);
  const snap = await a.ok('browser_snapshot');
  await a.ok('browser_click', { ref: refOf(snap, 'button "Shadow button"') });
  await a.ok('browser_click', { selector: '#same >>> button' });
  await a.ok('browser_wait_for', { text: 'Frame clicked' });
  const fresh = await a.ok('browser_snapshot');
  const inputs = [...fresh.matchAll(/textbox "Frame input"[^\n]*?\[ref=(e\d+)\]/g)].map(m => m[1]);
  assert.equal(inputs.length, 2, `two frame inputs expected:\n${fresh}`);
  await a.ok('browser_type', { ref: inputs[1], text: 'cross-origin text' });
  const { code } = await exportTest('frames and shadow DOM');
  // "Nested shadow button" contains "Shadow button" too: only an exact match is unique.
  has(code, `await page.getByRole('button', { name: 'Shadow button', exact: true }).click();`);
  has(code, `await page.frameLocator('#same').getByRole('button', { name: 'Frame button' }).click();`);
  has(code, `await expect(page.frameLocator('#same').getByText('Frame clicked').first()).toBeVisible();`);
  has(code, `await page.frameLocator('#cross').getByRole('textbox', { name: 'Frame input' }).fill('cross-origin text');`);
});

test('export: nested cross-origin frames, a login inside a frame', async () => {
  await open(`${site.url}/xframes.html?b=${encodeURIComponent(other.url)}&c=${encodeURIComponent(third.url)}`);
  await sleep(800);
  const snap = await a.ok('browser_snapshot');
  await a.ok('browser_fill_form', { fields: [{ ref: refOf(snap, 'textbox "Username"'), value: 'ada' }, { ref: refOf(snap, 'textbox "Password"'), value: 'pa55word' }] });
  await a.ok('browser_click', { ref: refOf(snap, 'button "Sign in"') });
  await a.ok('browser_click', { ref: refOf(snap, 'button "Innermost button"') });
  await a.ok('browser_wait_for', { text: 'Innermost clicked' });
  const { code, text } = await exportTest('nested frames');
  has(code, `await page.frameLocator('#login').getByRole('textbox', { name: 'Username' }).fill('ada');`);
  has(code, `await page.frameLocator('#login').getByRole('textbox', { name: 'Password' }).fill(process.env.PASSWORD!);`);
  has(code, `await page.frameLocator('#nested').frameLocator('#inner').getByRole('button', { name: 'Innermost button' }).click();`);
  has(code, `await expect(page.frameLocator('#nested').frameLocator('#inner').getByText('Innermost clicked').first()).toBeVisible();`);
  assert.ok(!text.includes('pa55word'));
});

test('export: typing into a focused secret field in a cross-origin frame keeps the value out', async () => {
  await open(`${site.url}/xframes.html?b=${encodeURIComponent(other.url)}&c=${encodeURIComponent(third.url)}`);
  await sleep(800);
  const snap = await a.ok('browser_snapshot');
  await a.ok('browser_click', { ref: refOf(snap, 'textbox "Password"') });
  await a.ok('browser_type', { text: 'focus-typed-secret' });
  await a.ok('browser_press_key', { key: 'x' });
  await a.ok('browser_press_key', { key: 'Enter' });
  const { code, text } = await exportTest('focused secret');
  assert.ok(!text.includes('focus-typed-secret'), text);
  has(code, `await page.keyboard.type(process.env.PASSWORD!);`);
  has(code, '// Left out: a key pressed in a secret field.');
  has(code, `await page.keyboard.press('Enter');`);
  exported.delete('focused secret');
});

test('export: identical buttons in table rows are scoped to their row', async () => {
  await open(`${site.url}/table.html`);
  const found = await a.ok('browser_snapshot', { find: 'Widget 37' });
  await a.ok('browser_click', { ref: refOf(found, 'button "Order"') });
  const { code } = await exportTest('order from a table row');
  has(code, `await page.getByRole('row', { name: 'Widget 37' }).getByRole('button', { name: 'Order' }).click();`);
});

test('export: drag and drop; dragging by coordinates is flagged', async () => {
  await open(`${site.url}/dnd.html`);
  const snap = await a.ok('browser_snapshot');
  await a.ok('browser_drag', { fromSelector: '#card-a', toRef: refOf(snap, 'region "Drop zone"') });
  await a.ok('browser_wait_for', { text: 'Dropped card-a' });
  const { code, text } = await exportTest('drag a card');
  has(code, `await page.getByText('Card A').dragTo(page.getByRole('region', { name: 'Drop zone' }));`);
  has(code, `await expect(page.getByText('Dropped card-a').first()).toBeVisible();`);
  assert.doesNotMatch(text, /coordinates/);
  await a.ok('browser_export_test', { reset: true });
  await a.ok('browser_click', { x: 20, y: 20 });
  const coords = await a.ok('browser_export_test', { name: 'coordinates' });
  assert.match(coords, /await page\.mouse\.click\(20, 20\);/);
  assert.match(coords, /Note: step 1 acted on coordinates/);
});

test('export: uploads (file input and file chooser), form submit navigates', async () => {
  const ws = join(hostDir, 'ws');
  writeFileSync(join(ws, 'upload-a.txt'), 'first file');
  writeFileSync(join(ws, 'upload-b.txt'), 'second file');
  await open(`${site.url}/upload.html`);
  const snap = await a.ok('browser_snapshot');
  await a.ok('browser_upload_file', { ref: refOf(snap, 'button "Documents"'), paths: ['upload-a.txt'] });
  await a.ok('browser_upload_file', { ref: refOf(snap, 'button "Choose avatar…"'), paths: ['upload-b.txt'] });
  await a.ok('browser_wait_for', { text: 'upload-b.txt' });
  await a.ok('browser_click', { ref: refOf(snap, 'button "Upload"') });
  await a.ok('browser_wait_for', { text: 'Uploaded' });
  const { code } = await exportTest('upload files');
  has(code, `await page.getByRole('button', { name: 'Documents' }).setInputFiles('upload-a.txt');`);
  has(code, `page.waitForEvent('filechooser');`);
  has(code, `await page.getByRole('button', { name: 'Choose avatar…' }).click();`);
  has(code, `.setFiles('upload-b.txt');`);
  has(code, `await expect(page).toHaveURL('${site.url}/upload');`);
});

test('export: answered dialogs are set up before the action that opens them', async () => {
  await open(`${site.url}/dialogs.html`);
  const snap = await a.ok('browser_snapshot');
  await a.ok('browser_click', { ref: refOf(snap, 'button "Confirm"') });
  await a.ok('browser_handle_dialog', { accept: true });
  await a.ok('browser_wait_for', { text: 'confirm: true' });
  await a.ok('browser_click', { ref: refOf(snap, 'button "Confirm"') });
  await a.ok('browser_handle_dialog', { accept: false });
  await a.ok('browser_wait_for', { text: 'confirm: false' });
  const { code } = await exportTest('dialogs');
  const lines = code.split('\n').map(l => l.trim());
  const clicks = lines.flatMap((l, i) => (l === `await page.getByRole('button', { name: 'Confirm' }).click();` ? [i] : []));
  assert.equal(clicks.length, 2, code);
  assert.equal(lines[clicks[0] - 1], `page.once('dialog', dialog => dialog.accept());`, code);
  assert.equal(lines[clicks[1] - 1], `page.once('dialog', dialog => dialog.dismiss());`, code);
});

test('export: failed actions are left out; reset starts over; path writes a file', async () => {
  await open(`${site.url}/actionability.html?overlay=60000`);
  const snap = await a.ok('browser_snapshot');
  const failed = await a.call('browser_click', { ref: refOf(snap, 'button "Never enabled"') });
  assert.ok(failed.isError, 'clicking a disabled button should fail');
  await a.ok('browser_export_test', { reset: true });
  const empty = await a.ok('browser_export_test');
  assert.match(empty, /Nothing is recorded/);
  await a.ok('browser_navigate', { url: `${site.url}/long.html` });
  const found = await a.ok('browser_snapshot', { find: 'Item 25.3 ' });
  await a.ok('browser_click', { ref: refOf(found, 'link "Item 25\\.3 ') });
  const written = await a.ok('browser_export_test', { name: 'long page', path: 'tests/copane-long.spec.ts' });
  assert.match(written, /Wrote tests[\\/]copane-long\.spec\.ts \(\d+ steps\)/);
  const code = readFileSync(join(hostDir, 'ws', 'tests', 'copane-long.spec.ts'), 'utf8');
  exported.set('long page', code);
  assert.doesNotMatch(code, /Never enabled/);
  has(code, `await page.goto('${site.url}/long.html');`);
  has(code, `await page.getByRole('link', { name: 'Item 25.3 with some descriptive text' }).click();`);
  has(code, `await expect(page).toHaveURL('${site.url}/long.html#item-25-3');`);
  // A file the tool did not write is never overwritten; paths outside the project are refused.
  writeFileSync(join(hostDir, 'ws', 'tests', 'mine.spec.ts'), '// mine\n');
  const refused = await a.call('browser_export_test', { path: 'tests/mine.spec.ts' });
  assert.ok(refused.isError && /never overwritten/.test(refused.text), refused.text);
  const outside = await a.call('browser_export_test', { path: '/tmp/copane-outside.spec.ts' });
  assert.ok(outside.isError && /outside your working directory/.test(outside.text), outside.text);
});

test('export: each session records only its own actions', async () => {
  const tab = await open(`${site.url}/spa.html`);
  const b = await agent({ session: `browser-devtools-b-${Date.now()}` });
  try {
    const snap = await a.ok('browser_snapshot');
    await a.ok('browser_click', { ref: refOf(snap, 'button "Cherry"') });
    const other = await b.ok('browser_export_test', { tab });
    assert.match(other, /Nothing is recorded/);
  } finally {
    await b.close();
  }
});

// ---------------------------------------------------------------- audit

test('audit accessibility: rules with refs and fixes; part of the page; refs act', async () => {
  await open(`${tools.url}/a11y.html`);
  const text = await a.ok('browser_audit', { type: 'accessibility' });
  for (const rule of ['button-name', 'image-alt', 'color-contrast', 'html-has-lang', 'heading-order']) assert.match(text, new RegExp(`- \\w+ ${rule} ×\\d`), `${rule} missing:\n${text}`);
  assert.match(text, /color-contrast[^\n]*\n[^\n]*\(1\.\d+:1, needs 4\.5:1; #bbbbbb on #ffffff/);
  assert.match(text, /Fix: give it text, or aria-label for an icon button/);
  const ref = /button-name[^\n]*\n\s+button \[ref=(e\d+)\]/.exec(text)?.[1];
  assert.ok(ref, `no ref for the unnamed button:\n${text}`);
  await a.ok('browser_click', { ref });
  const part = await a.ok('browser_audit', { type: 'accessibility', selector: '#clean' });
  assert.match(part, /only region "Fine part"[^\n]*: no problems found by the automated checks\./);
  assert.ok(text.length < 3000, `result too long: ${text.length}`);
});

test('audit accessibility: inside frames', async () => {
  await open(`${site.url}/frames.html?other=${encodeURIComponent(other.url)}`);
  await sleep(500);
  const text = await a.ok('browser_audit', { type: 'accessibility' });
  // frame.html's input has only a placeholder and the page has no main landmark; both frames are checked.
  assert.match(text, /3 documents/, text);
});

test('audit performance: load timing, vitals, requests, long tasks, render-blocking', async () => {
  await open(`${tools.url}/perf.html`);
  const text = await a.ok('browser_audit', { type: 'performance', reload: true });
  assert.match(text, /^Performance of tab-\d+: .*perf\.html \(just reloaded, bypassing the cache/);
  assert.match(text, /Load: TTFB \d+ ms, FCP [\d.]+ m?s, DOMContentLoaded [\d.]+ m?s, load [\d.]+ m?s, LCP [\d.]+ m?s/);
  assert.match(text, /Layout shift \(CLS\): \d\.\d{3}/);
  assert.match(text, /Main thread: 1 long task[^\n]*25\d ms/);
  assert.match(text, /Slow scripts[^\n]*big\.js/);
  assert.match(text, /Network: 4 requests/);
  assert.match(text, /Slowest: r\d+ \/api\?ms=600 6\d\d ms/);
  assert.match(text, /Largest: r\d+ \/big\.js\?kb=300 30\d\.\d kB/);
  assert.match(text, /Not compressed: r\d+ \/big\.js/);
  assert.match(text, /Render-blocking: \/slow\.css\?ms=400 4\d\d ms/);
  assert.match(text, /not comparable with Lighthouse/);
  // In front, the tab is painted and its interactions are reported (in the background they may not be).
  await a.ok('browser_show_tab');
  await a.ok('browser_click', { selector: '#heavy' });
  const after = await a.ok('browser_audit', { type: 'performance' });
  assert.match(after, /Interactions: slowest click on <button#heavy>[^\n]*handlers 2\d\d ms/);
});

// ---------------------------------------------------------------- run the exported tests

test('exported tests run green in Playwright (with --playwright <dir>)', async () => {
  if (!playwrightDir) return console.log('      (skipped: pass --playwright <dir> to run the exported tests)');
  const dir = join(playwrightDir, 'copane-exported');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(playwrightDir, 'upload-a.txt'), 'first file');
  writeFileSync(join(playwrightDir, 'upload-b.txt'), 'second file');
  for (const [name, code] of exported) writeFileSync(join(dir, `${name.replace(/\W+/g, '-')}.spec.ts`), code);
  writeFileSync(join(playwrightDir, 'playwright.config.mjs'), `export default { testDir: './copane-exported', workers: 1, timeout: 20000, use: { headless: true }, reporter: [['json', { outputFile: 'copane-results.json' }]] };\n`);
  // Asynchronously: the fixture servers in this process must keep answering while Playwright runs.
  await promisify(execFile)('npx', ['playwright', 'test', '--config', 'playwright.config.mjs'], { cwd: playwrightDir, env: { ...process.env, PASSWORD: 'pa55word' } }).catch(() => undefined);
  const report = JSON.parse(readFileSync(join(playwrightDir, 'copane-results.json'), 'utf8'));
  const results = report.suites.flatMap(s => s.specs).map(s => ({ title: s.title, ok: s.ok, error: s.tests[0]?.results[0]?.error?.message }));
  const passed = results.filter(r => r.ok);
  console.log(`      Playwright: ${passed.length} of ${results.length} exported tests passed unmodified`);
  for (const r of results.filter(r => !r.ok)) console.log(`      FAILED ${r.title}: ${String(r.error).split('\n').slice(0, 3).join(' | ')}`);
  assert.equal(passed.length, results.length);
});

test('cleanup: close the last tab', async () => {
  if (previous) await a.ok('browser_close_tab', { tab: previous });
});

try {
  await run();
} finally {
  await Promise.all([site.close(), other.close(), third.close(), tools.close()]);
}
