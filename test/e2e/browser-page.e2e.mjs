// Page automation tools (src/extension/browser/page/) against a running dev host:
//
//   node scripts/dev-host.mjs --name browser-page
//   node test/e2e/browser-page.e2e.mjs --name browser-page [--only <text>]
//
// Serves the fixture pages in test/fixtures/pages/ from two local servers on free ports (127.0.0.1 and
// localhost, i.e. two origins, for cross-origin iframes). Every case opens its own background tab.
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureServer } from '../fixtures/pages/server.mjs';
import { agent, assert, run, sleep, test } from './harness.mjs';

const site = await startFixtureServer();
const other = await startFixtureServer({ host: 'localhost' });
const url = path => `${site.url}${path}`;

const a = await agent({ session: 'browser-page-a' });
const opened = [];

/** Opens a background tab on a fixture path; returns its id. */
async function open(path) {
  const text = await a.ok('browser_open', { url: path.startsWith('http') || path.startsWith('about:') ? path : url(path), background: true });
  const id = /Opened (tab-\d+)/.exec(text)?.[1];
  assert.ok(id, `no tab id in: ${text}`);
  opened.push(id);
  return id;
}

/** The ref of the first snapshot line matching `pattern` (a regex source matched before "[ref="). */
function refOf(snapshot, pattern) {
  const m = new RegExp(`${pattern}[^\\n]*?\\[ref=(e\\d+)\\]`).exec(snapshot);
  assert.ok(m, `no line matching /${pattern}/ in snapshot:\n${snapshot}`);
  return m[1];
}

async function fails(tool, args, pattern) {
  const r = await a.call(tool, args);
  assert.ok(r.isError, `${tool} should have failed but returned: ${r.text}`);
  if (pattern) assert.match(r.text, pattern);
  return r.text;
}

const evaluate = async (fn, tab) => a.ok('browser_evaluate', { function: fn, ...(tab ? { tab } : {}) });

// ---------------------------------------------------------------- navigation

test('navigate: loads the page and reports URL, title and status', async () => {
  const tab = await open('about:blank');
  const text = await a.ok('browser_navigate', { url: url('/form.html') });
  assert.match(text, new RegExp(`Navigated ${tab} to http://127\\.0\\.0\\.1:\\d+/form\\.html — "Form fixture" \\(HTTP 200, loaded in`));
  // Scheme-less URLs, redirects, error statuses.
  assert.match(await a.ok('browser_navigate', { url: url('/redirect?to=/spa.html').replace('http://', '') }), /to http:\/\/127\.0\.0\.1:\d+\/spa\.html — "SPA fixture" \(HTTP 200/);
  assert.match(await a.ok('browser_navigate', { url: url('/status/404') }), /HTTP 404 \(error page\)/);
});

test('navigate: unreachable server fails with a hint', async () => {
  await open('about:blank');
  const port = (await startFixtureServer().then(async s => (await s.close(), s.port)));
  await fails('browser_navigate', { url: `http://127.0.0.1:${port}/` }, /Could not load .*ERR_CONNECTION_REFUSED.*is the server running/i);
});

test('navigate: waitUntil, slow loads and resources that never finish', async () => {
  await open('about:blank');
  let started = Date.now();
  assert.match(await a.ok('browser_navigate', { url: url('/slow.html?ms=2500'), waitUntil: 'domcontentloaded' }), /"Slow page fixture"/);
  assert.ok(Date.now() - started < 2000, 'domcontentloaded should not wait for the slow image');
  assert.match(await a.ok('browser_wait_for', { loadState: 'load' }), /page reached load/);
  started = Date.now();
  assert.match(await a.ok('browser_navigate', { url: url('/slow.html?ms=hang'), timeout: 2 }), /still loading resources after .*usable/);
  assert.ok(Date.now() - started < 6000);
});

test('history: back, forward, reload, and same-document SPA routes', async () => {
  await open('/spa.html');
  await a.ok('browser_navigate', { url: url('/form.html') });
  assert.match(await a.ok('browser_history', { action: 'back' }), /Went back in tab-\d+: .*spa\.html — "SPA fixture"/);
  assert.match(await a.ok('browser_history', { action: 'forward' }), /form\.html — "Form fixture"/);
  assert.match(await a.ok('browser_history', { action: 'reload' }), /Reloaded tab-\d+: .*form\.html/);
  await a.ok('browser_history', { action: 'back' });
  assert.match(await a.ok('browser_click', { selector: 'a[data-route=items]' }), /URL changed to .*\/spa\/items \(same page, no reload\)/);
  assert.match(await a.ok('browser_history', { action: 'back' }), /the URL is now .*\/spa\.html \(same page, no reload\)/);
  await a.ok('browser_history', { action: 'forward' });
  await a.ok('browser_history', { action: 'forward' }).catch(() => {});
  await fails('browser_history', { action: 'forward' }, /no next page/);
});

// ---------------------------------------------------------------- snapshot and refs

test('snapshot: same-origin iframes, cross-origin marker, shadow DOM, bridge UI left out', async () => {
  await open(`/frames.html?other=${encodeURIComponent(other.url)}`);
  await a.ok('browser_wait_for', { loadState: 'load' });
  await sleep(300);
  const snap = await a.ok('browser_snapshot');
  assert.match(snap, /- Page Title: Frames fixture/);
  assert.match(snap, /- iframe "Same origin frame" \[ref=e\d+\]:\n {2}- paragraph \[ref=e\d+\]: Inside frame\n {2}- button "Frame button"/);
  assert.match(snap, /- iframe "Other origin frame" \[ref=e\d+\]: \[cross-origin frame/);
  assert.match(snap, /button "Nested shadow button"/);
  assert.match(snap, /button "Closed shadow button"/);
  // Acting inside a same-origin frame and a closed shadow root by ref.
  assert.match(await a.ok('browser_click', { ref: refOf(snap, 'button "Frame button"') }), /It is now button "Frame clicked"/);
  assert.match(await a.ok('browser_click', { ref: refOf(snap, 'button "Closed shadow button"') }), /It is now button "Closed clicked"/);
  // Selectors pierce open shadow roots.
  assert.match(await a.ok('browser_click', { selector: '#shadow-btn' }), /Clicked button "Shadow button"/);

  await a.ok('browser_navigate', { url: url('/actionability.html?overlay=0') });
  const plain = await a.ok('browser_snapshot');
  assert.doesNotMatch(plain, /AGENT INDICATOR|Indicator button/);
});

test('snapshot: large pages are cut with a summary, and ref/selector narrow it', async () => {
  await open('/long.html');
  const snap = await a.ok('browser_snapshot', { maxChars: 5000 });
  assert.ok(snap.length < 5600, `snapshot too long: ${snap.length}`);
  assert.match(snap, /\[Snapshot cut: showing the first \d+ of \d+ characters/);
  assert.match(snap, /contentinfo \[ref=e\d+\]/);
  const section = refOf(snap, 'region "Section 10"');
  const part = await a.ok('browser_snapshot', { ref: section });
  assert.match(part, /- Part of the page: region "Section 10" \[ref=e\d+\]/);
  assert.match(part, /heading "Section 10"/);
  assert.doesNotMatch(part, /Section 11/);
  assert.match(await a.ok('browser_snapshot', { selector: 'footer' }), /button "Bottom button"/);
  const full = await a.ok('browser_snapshot', { maxChars: 60000 });
  assert.ok(full.length <= 61000, `max snapshot too long: ${full.length}`);
});

test('refs fail clearly when the page changed underneath', async () => {
  const tab = await open('/spa.html');
  let snap = await a.ok('browser_snapshot');
  const apple = refOf(snap, 'button "Apple"');
  const rename = refOf(snap, 'button "Rename me"');
  const shuffle = refOf(snap, 'button "Shuffle"');
  await a.ok('browser_click', { ref: shuffle });
  await fails('browser_click', { ref: apple }, /Ref e\d+ \(button "Apple"\) was removed from the page.*new snapshot/);
  // Changed in place by someone else (here: through a selector, standing in for the user).
  await a.ok('browser_click', { selector: '#rename' });
  await fails('browser_click', { ref: rename }, /has changed: it was button "Rename me" in your snapshot and is now button "Renamed"/);
  // Our own action changing a ref's label keeps it usable.
  snap = await a.ok('browser_snapshot');
  const later = refOf(snap, 'button "Load later"');
  await a.ok('browser_click', { ref: later });
  await a.ok('browser_click', { ref: later });
  await fails('browser_click', { ref: 'e99999' }, /no ref "e99999" for tab-\d+/);
  await a.ok('browser_navigate', { url: url('/form.html') });
  await fails('browser_click', { ref: later }, new RegExp(`belongs to a page that is gone: ${tab} has navigated`));
});

// ---------------------------------------------------------------- acting

test('click: reports navigation, console errors, failed requests and new tabs', async () => {
  await open('/spa.html');
  assert.match(await a.ok('browser_click', { selector: '#fetch-500' }), /Request failed: GET http:\/\/127\.0\.0\.1:\d+\/status\/500 → HTTP 500 \(r\d+\)/);
  assert.match(await a.ok('browser_click', { selector: '#log-error' }), /Console: \[error\] Something broke \{code: 42, items: Array\(2\)\}/);
  assert.match(await a.ok('browser_click', { selector: '#throw' }), /Console: \[exception\] Uncaught TypeError: kaboom from click/);
  assert.match(await a.ok('browser_click', { selector: '#fetch-down' }), /Request failed: GET http:\/\/127\.0\.0\.1:9\/nothing/);
  assert.match(await a.ok('browser_click', { selector: '#popup' }), /A new tab opened: (tab-\d+)/);
  const nav = await a.ok('browser_click', { selector: "nav a[href='/form.html']" });
  assert.match(nav, /Navigated to http:\/\/127\.0\.0\.1:\d+\/form\.html — "Form fixture"\./);
  assert.doesNotMatch(nav, /still loading/);
});

test('click: double, right, modifiers and coordinates', async () => {
  await open('/spa.html');
  const status = async () => JSON.parse(await evaluate("JSON.stringify(document.getElementById('status').textContent)"));
  await a.ok('browser_click', { selector: '#dbl', doubleClick: true });
  assert.equal(await status(), 'double clicked');
  await a.ok('browser_click', { selector: '#ctx', button: 'right' });
  assert.equal(await status(), 'context menu at button 2');
  assert.match(await a.ok('browser_click', { selector: '#mods', modifiers: ['Shift', 'Alt'] }), /with Shift\+Alt/);
  assert.equal(await status(), 'mods:shiftalt');
  const box = JSON.parse(await evaluate("JSON.stringify(document.getElementById('rename').getBoundingClientRect())"));
  assert.match(await a.ok('browser_click', { x: box.x + box.width / 2, y: box.y + box.height / 2 }), /Clicked the point/);
  assert.equal(JSON.parse(await evaluate("JSON.stringify(document.getElementById('rename').textContent)")), 'Renamed');
  await fails('browser_click', { x: 10 }, /both x and y/);
  await fails('browser_click', { ref: 'e1', selector: 'a' }, /only one of/);
});

test('click: waits until the element is actionable, and says why not', async () => {
  await open('/actionability.html?overlay=2500');
  const started = Date.now();
  assert.match(await a.ok('browser_click', { selector: '#covered' }), /Clicked button "Covered button"/);
  assert.ok(Date.now() - started > 1000, 'should have waited for the overlay to go');
  assert.match(await a.ok('browser_click', { selector: '#enabled-later' }), /Clicked button "Enabled later"/);
  assert.match(await a.ok('browser_click', { selector: '#mover' }), /Clicked button "Moving button"/);
  assert.equal(JSON.parse(await evaluate("JSON.stringify(document.getElementById('out').textContent)")), 'mover clicked');
  await fails('browser_click', { selector: '#never' }, /it is disabled \(waited 5 s\)/);
  await fails('browser_click', { selector: '#hidden' }, /it is not visible/);
  await fails('browser_click', { selector: '#missing' }, /No element matches the selector "#missing"/);
  await fails('browser_click', { selector: '[[' }, /not a valid CSS selector/);
  await a.ok('browser_navigate', { url: url('/actionability.html?overlay=600000') });
  await fails('browser_click', { selector: '#covered' }, /is covered by <div id="overlay">/);
});

test('type, fill_form, select_option and press_key', async () => {
  await open('/form.html');
  const value = async sel => JSON.parse(await evaluate(`JSON.stringify(document.querySelector(${JSON.stringify(sel)}).value)`));
  const snap = await a.ok('browser_snapshot');
  await a.ok('browser_type', { ref: refOf(snap, 'textbox "Name"'), text: 'Ada' });
  assert.equal(await value('#name'), 'Ada');
  await a.ok('browser_type', { selector: '#name', text: ' Lovelace', clear: false, slowly: true });
  assert.equal(await value('#name'), 'Ada Lovelace');
  assert.match(await a.ok('browser_type', { selector: '#zip', text: '1234567' }), /now holds "12345", not exactly what was typed/);
  await fails('browser_type', { selector: '#ro', text: 'x' }, /read-only/);
  await fails('browser_type', { selector: '#terms', text: 'x' }, /not a text field.*browser_click/);
  const filled = await a.ok('browser_fill_form', {
    fields: [
      { selector: '#email', value: 'ada@example.com' },
      { selector: '#terms', value: true },
      { selector: 'input[value=pro]', value: true },
      { selector: '#country', value: 'France' },
      { selector: '#tops', value: ['Cheese', 'Olives'] },
      { selector: '#bday', value: '1990-12-10' },
      { selector: '#vol', value: '7' },
      { selector: '#notes', value: 'multi\nline' },
    ],
  });
  assert.match(filled, /Filled 8 fields/);
  assert.equal(await value('#country'), 'fr');
  assert.equal(await value('#bday'), '1990-12-10');
  assert.equal(await evaluate("document.getElementById('terms').checked"), 'true');
  await fails('browser_fill_form', { fields: [{ selector: '#email', value: 'x@y.z' }, { selector: '#terms', value: 'yes' }] }, /Field 2 failed: .*pass true or false\.\nFilled before it: textbox "Email"/);
  await fails('browser_select_option', { selector: '#country', values: ['Spain'] }, /no option "Spain". Options: Choose…/);
  await fails('browser_select_option', { selector: '#country', values: ['us'] }, /is disabled/);
  await fails('browser_select_option', { selector: '#name', values: ['x'] }, /not a <select>/);
  assert.match(await a.ok('browser_select_option', { selector: '#country', values: ['de'] }), /Selected "Germany"/);
  // Keys: chords reach the page with the right modifiers; Tab moves focus.
  await a.ok('browser_press_key', { key: 'Control+Shift+K', selector: '#bio' });
  await a.ok('browser_press_key', { key: 'ArrowDown', count: 2 });
  assert.match(await evaluate("document.getElementById('keys').textContent"), /Ctrl\+K ArrowDown ArrowDown$/);
  assert.match(await a.ok('browser_press_key', { key: 'Tab' }), /Focus is on textbox "Readonly"/);
  await a.ok('browser_type', { selector: '#bio', text: 'select me' });
  await a.ok('browser_press_key', { key: 'ControlOrMeta+a' });
  await a.ok('browser_press_key', { key: 'Backspace' });
  assert.equal(await value('#bio'), '');
  await fails('browser_press_key', { key: 'Hyper+x' }, /not a modifier/);
  // Submitting: the form posts with fetch and shows the echoed body.
  const submitted = await a.ok('browser_type', { selector: '#name', text: 'Grace', submit: true });
  assert.match(submitted, /and pressed Enter/);
  assert.match(await a.ok('browser_wait_for', { text: 'Saved:' }), /is visible/);
  assert.match(await a.ok('browser_snapshot', { selector: '#result' }), /\\"name\\":\\"Grace\\".*\\"plan\\":\\"pro\\".*\\"notes\\":\\"multi\\\\nline\\"/);
});

test('hover shows hover content', async () => {
  await open('/spa.html');
  assert.doesNotMatch(await a.ok('browser_snapshot'), /Helpful tooltip/);
  assert.match(await a.ok('browser_hover', { selector: '#hoverme' }), /Hovering over/);
  assert.match(await a.ok('browser_snapshot'), /tooltip "Helpful tooltip"/);
});

test('scroll: wheel, edges, inner scrollers and into view', async () => {
  await open('/long.html');
  assert.match(await a.ok('browser_scroll', { direction: 'down' }), /Scrolled down\. The page is at y=[1-9]\d* of \d+ \(\d+ px more below\)/);
  assert.match(await a.ok('browser_scroll', { to: 'bottom' }), /at the bottom/);
  assert.match(await a.ok('browser_scroll', { to: 'top' }), /The page is at y=0 of/);
  assert.match(await a.ok('browser_scroll', { selector: '#scroller', direction: 'down', amount: 300 }), /The scrollable <div id="scroller"> is at y=300 of \d+/);
  assert.match(await a.ok('browser_scroll', { selector: '#bottom' }), /Scrolled button "Bottom button" .* into view/);
  assert.ok(Number(await evaluate('scrollY')) > 1000);
  await fails('browser_scroll', {}, /Say how to scroll/);
});

test('drag: HTML5 drag and drop, and pointer dragging', async () => {
  await open('/dnd.html');
  assert.match(await a.ok('browser_drag', { fromSelector: '#card-a', toSelector: '#zone' }), /Dragged .* to region "Drop zone"/);
  assert.equal(await evaluate("document.getElementById('out').textContent"), 'Dropped card-a');
  const track = JSON.parse(await evaluate("JSON.stringify(document.getElementById('track').getBoundingClientRect())"));
  await a.ok('browser_drag', { fromSelector: '#knob', toX: track.x + 200, toY: track.y + 10 });
  assert.match(await evaluate("document.getElementById('out').textContent"), /^Slider at (6\d|7\d)$/);
});

test('upload: file input, hidden input behind a button, label, and missing files', async () => {
  await open('/upload.html');
  const dir = tmpdir();
  const f1 = join(dir, 'agent-bridge-e2e-a.txt');
  const f2 = join(dir, 'agent-bridge-e2e-b.txt');
  writeFileSync(f1, 'hello upload\n');
  writeFileSync(f2, 'second');
  assert.match(await a.ok('browser_upload_file', { selector: '#docs', paths: [f1, f2] }), /Set 2 files on .*agent-bridge-e2e-a\.txt, agent-bridge-e2e-b\.txt/);
  assert.match(await a.ok('browser_upload_file', { selector: '#pick', paths: [f1] }), /chose agent-bridge-e2e-a\.txt in the file chooser/);
  assert.match(await evaluate("document.getElementById('chosen').textContent"), /agent-bridge-e2e-a\.txt \(13 B\), agent-bridge-e2e-b\.txt \(6 B\), agent-bridge-e2e-a\.txt \(13 B\)/);
  await fails('browser_upload_file', { selector: '#pick', paths: [f1, f2] }, /accepts one file/);
  await fails('browser_upload_file', { selector: '#docs', paths: [join(dir, 'does-not-exist.txt')] }, /There is no file at/);
  assert.match(await a.ok('browser_click', { selector: 'button[type=submit]' }), /Navigated to .*\/upload — "Uploaded"/);
  assert.match(await a.ok('browser_snapshot'), /agent-bridge-e2e-a\.txt, agent-bridge-e2e-b\.txt, agent-bridge-e2e-a\.txt/);
});

// ---------------------------------------------------------------- waiting

test('wait_for: text, textGone, selector states, url, network idle, time, and timeouts', async () => {
  await open('/spa.html');
  await a.ok('browser_click', { selector: '#later' });
  assert.match(await a.ok('browser_wait_for', { text: 'loaded LATER!' }), /Done after .*"loaded LATER!" is visible/);
  await a.ok('browser_click', { selector: '#hide-banner' });
  assert.match(await a.ok('browser_wait_for', { textGone: 'Welcome banner', selector: '#banner', state: 'detached' }), /"Welcome banner" is gone, "#banner" is detached/);
  assert.match(await a.ok('browser_wait_for', { selector: '#status' }), /"#status" is visible/);
  await a.ok('browser_click', { selector: 'a[data-route=items]' });
  assert.match(await a.ok('browser_wait_for', { url: '*/spa/items' }), /URL is .*\/spa\/items/);
  await a.ok('browser_click', { selector: '#fetch-slow' });
  const started = Date.now();
  assert.match(await a.ok('browser_wait_for', { loadState: 'networkidle' }), /network ?idle|reached networkidle/);
  assert.ok(Date.now() - started < 5000);
  assert.match(await a.ok('browser_wait_for', { time: 0.3 }), /Waited 300 ms/);
  const t = await fails('browser_wait_for', { text: 'never there', timeout: 1 }, /Gave up after 1\.0 s: text "never there" did not appear\./);
  assert.match(t, /The page \(.*\) shows: Home \| Items/);
  await fails('browser_wait_for', { selector: '#status', state: 'hidden', timeout: 0.5 }, /is not hidden \(1 in the DOM, 1 visible\)/);
  await fails('browser_wait_for', {}, /at least one condition/);
});

// ---------------------------------------------------------------- screenshots

test('screenshot: viewport, element, full page, png, and the bridge UI hidden', async () => {
  await open('/actionability.html?overlay=0');
  const shot = await a.call('browser_screenshot');
  assert.ok(!shot.isError, shot.text);
  assert.equal(shot.images.length, 1);
  assert.equal(shot.images[0].mimeType, 'image/jpeg');
  assert.match(shot.text, /Screenshot of the viewport in tab-\d+ \((\d+)×(\d+) px; viewport \d+×\d+ CSS px\)/);
  // The page records the indicator's visibility changes: hidden for the capture, then restored.
  assert.deepEqual(JSON.parse(await evaluate('JSON.stringify(indicatorLog)')), ['hidden', 'visible']);
  const el = await a.call('browser_screenshot', { selector: '#covered', format: 'png' });
  assert.equal(el.images[0].mimeType, 'image/png');
  const [, w, h] = /\((\d+)×(\d+) px/.exec(el.text).map(Number);
  const box = JSON.parse(await evaluate("JSON.stringify(document.getElementById('covered').getBoundingClientRect())"));
  assert.ok(Math.abs(w - box.width) <= 2 && Math.abs(h - box.height) <= 2, `element shot ${w}×${h}, element ${box.width}×${box.height}`);
  await a.ok('browser_navigate', { url: url('/long.html') });
  const full = await a.call('browser_screenshot', { fullPage: true });
  assert.match(full.text, /The page is \d+ px tall; only the top \d+ px were captured/);
  const [, fw, fh] = /\((\d+)×(\d+) px/.exec(full.text).map(Number);
  assert.ok(Math.max(fw, fh) <= 1568 && fw * fh <= 1_150_000 + 2000, `full page ${fw}×${fh}`);
  assert.ok(Buffer.from(full.images[0].data, 'base64').length < 1_500_000);
});

// ---------------------------------------------------------------- console and network

test('console: levels, filter, onlyNew, page loads, bounded output', async () => {
  await open('/spa.html');
  await a.ok('browser_click', { selector: '#log-error' });
  await a.ok('browser_click', { selector: '#warn' });
  await evaluate("console.log('plain log'); console.debug('debug detail')");
  const all = await a.ok('browser_console_messages');
  assert.match(all, /\[error\] Something broke/);
  assert.match(all, /\[warning\] careful now/);
  assert.match(all, /\[log\] plain log/);
  assert.doesNotMatch(all, /debug detail/);
  assert.match(await a.ok('browser_console_messages', { level: 'debug' }), /\[debug\] debug detail/);
  const errors = await a.ok('browser_console_messages', { level: 'error' });
  assert.match(errors, /Something broke/);
  assert.doesNotMatch(errors, /careful/);
  assert.match(await a.ok('browser_console_messages', { filter: '/care+ful/' }), /1 console message/);
  await a.ok('browser_console_messages', { onlyNew: true });
  assert.match(await a.ok('browser_console_messages', { onlyNew: true }), /No console messages .* new since your last read/);
  await a.ok('browser_history', { action: 'reload' });
  await evaluate("console.info('after reload')");
  assert.match(await a.ok('browser_console_messages', { onlyNew: true }), /--- page loaded: .*spa\.html ---\n.*\[info\] after reload/);
  // A flood stays within the output budget and says what was left out.
  await evaluate("for (let i = 0; i < 3000; i++) console.log('flood line ' + i + ' ' + 'x'.repeat(120))");
  const flood = await a.ok('browser_console_messages', { limit: 500 });
  assert.ok(flood.length < 25_000, `console output ${flood.length} chars`);
  assert.match(flood, /older messages not shown/);
  assert.match(flood, /flood line 2999/);
});

test('network: listing, filters, onlyNew and request details with headers and bodies', async () => {
  await open('/spa.html');
  // Recording starts when the bridge attaches to the tab (its first tool call), so load the page again.
  await a.ok('browser_history', { action: 'reload' });
  await a.ok('browser_click', { selector: '#fetch-ok' });
  await a.ok('browser_click', { selector: '#fetch-500' });
  await evaluate("fetch('/echo', { method: 'POST', headers: { 'content-type': 'application/json', 'x-agent': 'yes' }, body: JSON.stringify({ hello: 'world' }) }).then(r => r.text())");
  await a.ok('browser_wait_for', { loadState: 'networkidle' });
  const list = await a.ok('browser_network_requests');
  assert.match(list, /r\d+ {2}GET 200 document {2}http:\/\/127\.0\.0\.1:\d+\/spa\.html/);
  assert.match(list, /r\d+ {2}GET 200 fetch {2}http:\/\/127\.0\.0\.1:\d+\/json/);
  assert.match(list, /r\d+ {2}GET 500 fetch/);
  const failed = await a.ok('browser_network_requests', { status: 'failed' });
  assert.match(failed, /500/);
  assert.doesNotMatch(failed, /\/json/);
  const post = await a.ok('browser_network_requests', { method: 'POST', filter: '/echo' });
  const id = /(r\d+) {2}POST 200 fetch/.exec(post)?.[1];
  assert.ok(id, post);
  const details = await a.ok('browser_network_request', { id });
  assert.match(details, /Request headers:\n(.*\n)*? {2}x-agent: yes/i);
  assert.match(details, /Request body:\n {2}\{\n {4}"hello": "world"\n {2}\}/);
  assert.match(details, /Response body \(\d+ B\):\n {2}\{\n {4}"method": "POST"/);
  await a.ok('browser_network_requests', { onlyNew: true });
  assert.match(await a.ok('browser_network_requests', { onlyNew: true }), /No matching requests/);
  await fails('browser_network_request', { id: 'r99999' }, /No request "r99999"/);
});

// ---------------------------------------------------------------- dialogs

test('dialogs: reported by the action, other tools fail fast, then answered', async () => {
  await open('/dialogs.html');
  assert.match(await a.ok('browser_click', { selector: '#alert' }), /It opened an alert dialog: "Hello from alert"\. The page is blocked until you answer it with browser_handle_dialog/);
  for (const [tool, args] of [['browser_snapshot', {}], ['browser_screenshot', {}], ['browser_evaluate', { function: '1' }], ['browser_click', { selector: '#confirm' }], ['browser_wait_for', { time: 1 }]]) {
    const started = Date.now();
    await fails(tool, args, /shows an alert dialog: "Hello from alert"\. The page is blocked until it is answered/);
    assert.ok(Date.now() - started < 3000, `${tool} should fail fast while a dialog is open`);
  }
  // Reading recorded logs still works.
  assert.match(await a.ok('browser_console_messages'), /a dialog is open|console message/);
  assert.match(await a.ok('browser_handle_dialog', { accept: true }), /Accepted the alert dialog "Hello from alert"/);
  assert.equal(await evaluate("document.getElementById('out').textContent"), 'alert closed');
  await a.ok('browser_click', { selector: '#confirm' });
  assert.match(await a.ok('browser_handle_dialog', { accept: false }), /Dismissed the confirm dialog "Delete everything\?"/);
  assert.equal(await evaluate("document.getElementById('out').textContent"), 'confirm: false');
  await a.ok('browser_click', { selector: '#confirm' });
  await a.ok('browser_handle_dialog', { accept: true });
  assert.equal(await evaluate("document.getElementById('out').textContent"), 'confirm: true');
  // A dialog opened by a timer, not by an action, is found by the next tool.
  await a.ok('browser_click', { selector: '#later' });
  await sleep(1500); // timers of a background tab may be throttled to once a second
  await fails('browser_snapshot', {}, /Delayed alert/);
  await a.ok('browser_handle_dialog', { accept: true });
  await fails('browser_handle_dialog', { accept: true }, /No dialog is open/);
  // Electron does not implement prompt(); it throws in the page instead of opening a dialog.
  assert.match(await a.ok('browser_click', { selector: '#prompt' }), /Uncaught Error: prompt\(\) is not supported|It opened a prompt dialog/);
  if (/prompt dialog/.test(await a.call('browser_snapshot').then(r => r.text))) await a.ok('browser_handle_dialog', { accept: true, promptText: 'Bob' });
});

test('dialogs: "leave this page?" does not block navigation', async () => {
  await open('/dialogs.html');
  await a.ok('browser_click', { selector: '#guard' });
  assert.match(await a.ok('browser_navigate', { url: url('/form.html') }), /"Form fixture"[\s\S]*confirm(ed)? leaving/);
  await a.ok('browser_history', { action: 'back' });
  await a.ok('browser_click', { selector: '#guard' });
  assert.match(await a.ok('browser_history', { action: 'reload' }), /Reloaded/);
});

// ---------------------------------------------------------------- evaluate

test('evaluate: expressions, statements, functions, element argument, errors, big results', async () => {
  await open('/spa.html');
  assert.equal(await evaluate('1 + 1'), '2');
  assert.equal(await evaluate('document.title'), 'SPA fixture');
  assert.equal(await evaluate('const x = 5; x * 2'), '10');
  assert.equal(await evaluate("function f() { return 'declared'; }"), 'declared');
  assert.equal(await evaluate('async () => { await new Promise(r => setTimeout(r, 50)); return 7; }'), '7');
  assert.equal(await evaluate('new Promise(r => setTimeout(() => r(8), 50))'), '8', 'a promise the expression evaluates to is awaited');
  assert.match((await a.call('browser_evaluate', { function: 'Promise.reject(new Error("nope"))' })).text, /rejected.*nope/s);
  const obj = JSON.parse(await evaluate('({ a: 1, list: [1, 2], el: document.querySelector("h1"), u: undefined })'));
  assert.deepEqual(obj, { a: 1, list: [1, 2], el: '<h1 id="title"> Home', u: '(undefined)' });
  const nodes = JSON.parse(await evaluate("document.querySelectorAll('#list button')"));
  assert.deepEqual(nodes, ['<button> Apple', '<button> Banana', '<button> Cherry']);
  assert.equal(await a.ok('browser_evaluate', { function: '(el) => el.textContent.toUpperCase()', selector: '#title' }), 'HOME');
  const cyclic = await evaluate('(() => { const o = { name: "loop" }; o.self = o; return o; })()');
  assert.match(cyclic, /"self": "\(circular\)"/);
  await fails('browser_evaluate', { function: "throw new Error('nope')" }, /The script threw: Error: nope/);
  await fails('browser_evaluate', { function: 'this is not js' }, /SyntaxError/);
  const big = await evaluate("'x'.repeat(100000)");
  assert.ok(big.length < 21_000);
  assert.match(big, /cut: 100000 characters in total/);
  // Effects of the script are reported like an action's.
  assert.match(await evaluate("location.href = '/form.html'"), /Navigated to .*form\.html/);
});

// ---------------------------------------------------------------- sessions, cancellation, closing

test('sessions: a second session reads a tab the first controls, with its own refs', async () => {
  const tab = await open('/spa.html');
  const snapA = await a.ok('browser_snapshot');
  const b = await agent({ session: 'browser-page-b' });
  try {
    const snapB = await b.call('browser_snapshot', { tab });
    assert.ok(!snapB.isError, snapB.text);
    assert.match(snapB.text, /button "Shuffle"/);
    const refB = refOf(snapB.text, 'button "Shuffle"');
    const shotB = await b.call('browser_screenshot', { tab });
    assert.ok(!shotB.isError && shotB.images.length === 1, shotB.text);
    const clickB = await b.call('browser_click', { tab, ref: refB });
    assert.ok(clickB.isError, 'the second session should not control a tab the first one holds');
    assert.match(clickB.text, /controlled by|busy|another/i);
    // Refs are per session: B's ref numbers mean nothing to A unless A handed them out.
    const consoleB = await b.call('browser_console_messages', { tab });
    assert.ok(!consoleB.isError, consoleB.text);
  } finally {
    await b.close();
  }
});

test('cancellation: a cancelled wait ends and the tab stays usable', async () => {
  await open('/spa.html');
  const controller = new AbortController();
  const pending = a.mcp.callTool({ name: 'browser_wait_for', arguments: { text: 'never appears', timeout: 60 } }, undefined, { signal: controller.signal, timeout: 120_000 });
  await sleep(500);
  const started = Date.now();
  controller.abort();
  await assert.rejects(pending);
  assert.equal(await evaluate('1 + 2'), '3');
  assert.ok(Date.now() - started < 3000);
});

test('tab closed in the middle of a call fails clearly instead of hanging', async () => {
  const text = await a.ok('browser_open', { url: url('/spa.html') });
  const tab = /Opened (tab-\d+)/.exec(text)[1];
  const started = Date.now();
  const pending = a.call('browser_wait_for', { text: 'never appears', timeout: 60, tab });
  await sleep(800);
  await a.ok('debug_vscode_command', { command: 'workbench.action.closeActiveEditor' });
  const r = await pending;
  assert.ok(r.isError, r.text);
  assert.match(r.text, new RegExp(`${tab} was closed|There is no tab "${tab}"`));
  assert.ok(Date.now() - started < 15_000, 'should not wait for the full timeout');
  await fails('browser_snapshot', { tab }, new RegExp(`no tab "${tab}"|${tab} was closed`, 'i'));
});

test('tools are listed with descriptions and input schemas', async () => {
  const tools = await a.tools();
  const names = tools.map(t => t.name);
  for (const name of [
    'browser_navigate', 'browser_history', 'browser_snapshot', 'browser_screenshot', 'browser_click', 'browser_type', 'browser_fill_form',
    'browser_press_key', 'browser_hover', 'browser_select_option', 'browser_scroll', 'browser_drag', 'browser_upload_file', 'browser_wait_for',
    'browser_console_messages', 'browser_network_requests', 'browser_network_request', 'browser_handle_dialog', 'browser_evaluate',
  ]) {
    assert.ok(names.includes(name), `missing tool ${name}`);
    const t = tools.find(x => x.name === name);
    assert.ok(t.description.length > 60, `${name} needs a description`);
  }
});

test('cleanup: close the tabs this test opened', async () => {
  await a.ok('debug_vscode_command', { command: 'workbench.action.closeAllEditors' });
  await a.close();
  await site.close();
  await other.close();
});

await run();
