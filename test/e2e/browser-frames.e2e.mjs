// Cross-origin (out-of-process) iframes against a running dev host (src/extension/browser/page/frames*.ts):
//
//   node scripts/dev-host.mjs --name frames
//   node test/e2e/browser-frames.e2e.mjs --name frames [--only <text>]
//
// Serves test/fixtures/pages/ from three local servers on free ports: 127.0.0.1, localhost and [::1]
// are three sites, so their frames are separate CDP targets. The last case loads a real public page
// (MDN's <iframe> reference, whose live example and the map inside it come from two other sites) and
// is skipped when that page cannot be reached.
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureServer } from '../fixtures/pages/server.mjs';
import { agent, assert, missingIpv6Loopback, offline, run, sleep, test as testCase, until } from './harness.mjs';

// The third site is [::1]; a machine without IPv6 loopback skips the cases with local frames and says so.
const noIpv6 = await missingIpv6Loopback();
const test = (name, fn, { skip } = {}) => testCase(name, fn, { skip: skip ?? noIpv6 });
const site = await startFixtureServer();
const second = await startFixtureServer({ host: 'localhost' });
const third = noIpv6 ? second : await startFixtureServer({ host: '::1' });
const query = `b=${encodeURIComponent(second.url)}&c=${encodeURIComponent(third.url)}`;
const xframes = `${site.url}/xframes.html?${query}`;
const xmany = `${site.url}/xmany.html?${query}`;

const a = await agent({ session: 'browser-frames-a' });

let previous;
/** Opens a background tab (closing the previous case's), waits until it has loaded; returns its id. */
async function open(url) {
  if (previous) await a.call('browser_close_tab', { tab: previous });
  const text = await a.ok('browser_open', { url, background: true });
  const id = /Opened (tab-\d+)/.exec(text)?.[1];
  assert.ok(id, `no tab id in: ${text}`);
  previous = id;
  await a.ok('browser_wait_for', { loadState: 'load' });
  await sleep(500);
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

/** Runs a function on an element (selector may reach into frames with >>>) and returns its result. */
const read = (selector, fn = 'el => el.textContent') => a.ok('browser_evaluate', { selector, function: fn });

// ---------------------------------------------------------------- snapshot

test('snapshot: cross-origin frames in place, nested ones too, with refs', async () => {
  await open(xframes);
  const started = Date.now();
  const snap = await a.ok('browser_snapshot');
  const ms = Date.now() - started;
  assert.doesNotMatch(snap, /cannot be read|not read|not available/);
  assert.match(snap, /- iframe "Login frame" \[ref=e\d+\]:\n {2}- form \[ref=e\d+\]:\n {4}- textbox "Username" \[ref=e\d+\]/);
  assert.match(snap, /- iframe "Scaled frame" \[ref=e\d+\]:\n {2}- paragraph: Top of the long frame\n {2}- button "Deep button"/);
  assert.match(snap, /- iframe "Nested frame" \[ref=e\d+\]:\n(?: {2}.*\n)*? {2}- iframe "Inner frame" \[ref=e\d+\]:\n {4}- paragraph: Innermost text/);
  assert.match(snap, /- iframe "Navigating frame" \[ref=e\d+\]:\n {2}- paragraph: Navigating frame start/);
  // Refs are unique although each frame target numbers its nodes from 1.
  const refs = [...snap.matchAll(/\[ref=(e\d+)\]/g)].map(m => m[1]);
  assert.equal(new Set(refs).size, refs.length, 'duplicate refs');
  assert.ok(ms < 3000, `snapshot took ${ms} ms`);
  // A snapshot rooted inside a frame, and one rooted at an iframe.
  const form = await a.ok('browser_snapshot', { ref: refOf(snap, 'form') });
  assert.match(form, /- Part of the page: form/);
  assert.match(form, /button "Sign in"/);
  assert.doesNotMatch(form, /Deep button/);
  const nested = await a.ok('browser_snapshot', { ref: refOf(snap, 'iframe "Nested frame"') });
  assert.match(nested, /button "Innermost button"/);
  assert.doesNotMatch(nested, /Sign in/);
});

// ---------------------------------------------------------------- acting by ref and selector

test('forms inside a frame: fill, select, check, submit; effects come back', async () => {
  await open(xframes);
  const snap = await a.ok('browser_snapshot');
  const filled = await a.ok('browser_fill_form', {
    fields: [
      { ref: refOf(snap, 'textbox "Username"'), value: 'alice' },
      { ref: refOf(snap, 'textbox "Password"'), value: 's3cret' },
      { ref: refOf(snap, 'combobox "Role"'), value: 'Admin' },
      { ref: refOf(snap, 'checkbox "Remember me"'), value: true },
    ],
  });
  assert.match(filled, /Filled 4 fields/);
  const clicked = await a.ok('browser_click', { ref: refOf(snap, 'button "Sign in"') });
  assert.match(clicked, /Console: \[error\] frame error after login/);
  assert.match(clicked, /Request failed: GET http:\/\/localhost:\d+\/status\/503 → HTTP 503/);
  assert.equal(await read('#login >>> #result'), 'Signed in as alice (Admin, remember=true)');
  // select_option on a ref in the frame.
  assert.match(await a.ok('browser_fill_form', { fields: [{ ref: refOf(snap, 'combobox "Role"'), value: 'Editor' }] }), /Editor/);
  assert.equal(await read('#login >>> #role', 'el => el.value'), 'Editor');
});

test('typing and keys inside frames; focus is followed into the frame', async () => {
  await open(xframes);
  const snap = await a.ok('browser_snapshot');
  await a.ok('browser_type', { ref: refOf(snap, 'textbox "Keys"'), text: 'ab', slowly: true });
  assert.equal(await read('#login >>> #keylog'), 'a b ');
  const pressed = await a.ok('browser_press_key', { key: 'Tab' });
  assert.match(pressed, /Focus is on button "Sign in"/);
  await a.ok('browser_type', { ref: refOf(snap, 'generic "Notes"'), text: 'note in a frame' });
  assert.equal(await read('#login >>> #notes'), 'note in a frame');
  // Without a target, typing goes to whatever has focus, also inside a frame.
  await a.ok('browser_click', { ref: refOf(snap, 'textbox "Username"') });
  assert.match(await a.ok('browser_type', { text: 'bob' }), /into the focused textbox "Username"/);
  assert.equal(await read('#login >>> #user', 'el => el.value'), 'bob');
});

test('clicks land on the element in a scaled, rotated, offset and scrolled frame below the fold', async () => {
  await open(xframes);
  const snap = await a.ok('browser_snapshot');
  // Use another frame first: input routing into a frame right after a scroll is what goes wrong.
  await a.ok('browser_click', { selector: '#scaled >>> p' });
  await a.ok('browser_click', { ref: refOf(snap, 'button "Sign in"') });
  const clicked = await a.ok('browser_click', { ref: refOf(snap, 'button "Deep button"') });
  assert.match(clicked, /It is now button "Deep clicked"/);
  const where = await read('#scaled >>> #where');
  const m = /click at (\d+),(\d+) of (\d+)x(\d+)/.exec(where);
  assert.ok(m, where);
  const [x, y, w, h] = m.slice(1).map(Number);
  assert.ok(Math.abs(x - w / 2) <= 3 && Math.abs(y - h / 2) <= 3, `click not centred: ${where}`);
  // The page and the frame were both scrolled to bring the button into view.
  assert.ok(Number(await a.ok('browser_evaluate', { function: '() => scrollY' })) > 500);
  assert.ok(Number(await read('#scaled >>> #deep', 'el => scrollY')) > 1000);
});

test('nested cross-origin frames: click and type in the innermost one', async () => {
  await open(xframes);
  const snap = await a.ok('browser_snapshot');
  assert.match(await a.ok('browser_click', { ref: refOf(snap, 'button "Middle button"') }), /It is now button "Middle clicked"/);
  assert.match(await a.ok('browser_click', { ref: refOf(snap, 'button "Innermost button"') }), /It is now button "Innermost clicked"/);
  await a.ok('browser_type', { ref: refOf(snap, 'textbox "Inner field"'), text: 'three levels down' });
  assert.equal(await read('#nested >>> #inner >>> #inner-field', 'el => el.value'), 'three levels down');
  // A same-origin child of a cross-origin frame lives in that frame's target.
  assert.match(snap, /- iframe "Same-site child" \[ref=e\d+\]:\n {4}- paragraph: Inside frame/);
  const childButton = /- iframe "Same-site child"[\s\S]*?button "Frame button" \[ref=(e\d+)\]/.exec(snap)[1];
  assert.match(await a.ok('browser_click', { ref: childButton }), /It is now button "Frame clicked"/);
  assert.equal(await read('#nested >>> #same-site >>> button'), 'Frame clicked');
});

test('hover, scroll, drag and upload inside a frame', async () => {
  await open(xframes);
  // Hover twice with a move elsewhere in between: the frame must see the pointer arrive again.
  for (let i = 0; i < 2; i++) {
    await read('#login >>> #hover', 'el => { el.textContent = "Hover me"; }');
    await a.ok('browser_hover', { selector: '#top-status' });
    await a.ok('browser_hover', { selector: '#login >>> #hover' });
    assert.equal(await read('#login >>> #hover'), 'Hovered', `hover ${i + 1}`);
  }
  const scrolled = await a.ok('browser_scroll', { selector: '#scaled >>> #deep', direction: 'up', amount: 400 });
  assert.match(scrolled, /Scrolled up\. The scrollable document of the frame http:\/\/localhost:\d+\/xlong\.html is at y=\d+/);
  assert.match(await a.ok('browser_scroll', { selector: '#scaled >>> p', to: 'top' }), /is at y=0 /);

  assert.match(await a.ok('browser_drag', { fromSelector: '#login >>> #drag', toSelector: '#login >>> #drop' }), /Dragged/);
  assert.equal(await read('#login >>> #drop'), 'Dropped dragged');

  const file = join(tmpdir(), 'copane-frames-upload.txt');
  writeFileSync(file, 'frame upload');
  assert.match(await a.ok('browser_upload_file', { selector: '#login >>> #file', paths: [file] }), /Set 1 file on .*copane-frames-upload\.txt/);
  assert.equal(await read('#login >>> #files'), 'copane-frames-upload.txt');
  // A button that opens the file chooser from inside the frame.
  assert.match(await a.ok('browser_upload_file', { selector: '#login >>> #pick', paths: [file] }), /and chose copane-frames-upload\.txt in the file chooser/);
  assert.equal(await read('#login >>> #picked'), 'copane-frames-upload.txt');
});

// ---------------------------------------------------------------- selectors, waits, evaluate, screenshots

test('selectors reach into frames; >>> scopes to one frame', async () => {
  await open(xframes);
  // A plain selector that only matches inside a frame is found there.
  assert.match(await a.ok('browser_click', { selector: '#signin' }), /Clicked button "Sign in" \(selector "#signin" in the frame http:\/\/localhost:\d+\/xlogin\.html\)/);
  // Scoped: the same selector exists in two frames (paragraphs); >>> picks the frame.
  assert.equal(await read('#nested >>> p'), 'Middle frame text');
  assert.equal(await read('#nested >>> #inner >>> p'), 'Innermost text');
  await fails('browser_click', { selector: '#nested >>> #nope' }, /No element matches the selector "#nested >>> #nope"/);
  await fails('browser_click', { selector: '#nope >>> p' }, /no iframe matches "#nope"/);
  await fails('browser_click', { selector: '#top-status >>> p' }, /must select an <iframe>/);
  await fails('browser_click', { selector: '#login >>> [[' }, /not a valid CSS selector \(in "\[\["\)/);
});

test('wait_for sees text and selectors inside frames', async () => {
  await open(xframes);
  await read('#login >>> #result', 'el => setTimeout(() => (el.textContent = "Late frame text"), 700)');
  assert.match(await a.ok('browser_wait_for', { text: 'Late frame text', timeout: 5 }), /"Late frame text" is visible/);
  assert.match(await a.ok('browser_wait_for', { textGone: 'Not signed in' }), /is gone/);
  assert.match(await a.ok('browser_wait_for', { selector: '#inner-field' }), /"#inner-field" is visible/);
  assert.match(await a.ok('browser_wait_for', { selector: '#nested >>> #inner >>> #inner-field', state: 'attached' }), /is attached/);
  await fails('browser_wait_for', { selector: '#login >>> #inner-field', timeout: 1 }, /is not visible \(0 in the DOM/);
});

test('evaluate runs in the frame of the element; element screenshots inside frames', async () => {
  await open(xframes);
  const snap = await a.ok('browser_snapshot');
  assert.match(await a.ok('browser_evaluate', { ref: refOf(snap, 'button "Innermost button"'), function: 'el => location.origin + " " + el.tagName' }), /^http:\/\/\[::1\]:\d+ BUTTON$/);
  // Without an element it runs in the top page.
  assert.match(await a.ok('browser_evaluate', { function: 'location.origin' }), /^http:\/\/127\.0\.0\.1:\d+$/);
  // The session indicator is in the top page only, never inside frames.
  assert.equal(await a.ok('browser_evaluate', { function: `document.querySelectorAll('[data-copane-ui]').length` }), '1');
  for (const frame of ['#login >>> body', '#nested >>> body', '#nested >>> #inner >>> body']) {
    assert.equal(await read(frame, `el => document.querySelectorAll('[data-copane-ui]').length`), '0', frame);
  }
  const shot = await a.call('browser_screenshot', { ref: refOf(snap, 'button "Sign in"') });
  assert.ok(!shot.isError, shot.text);
  assert.equal(shot.images.length, 1);
  const size = await read('#login >>> #signin', 'el => { const r = el.getBoundingClientRect(); return Math.round(r.width) + "×" + Math.round(r.height); }');
  assert.match(shot.text, new RegExp(`Screenshot of button "Sign in" \\[ref=e\\d+\\] in tab-\\d+, ${size} px`));
});

// ---------------------------------------------------------------- logs

test('console and network of frames are recorded; request bodies come from the frame', async () => {
  await open(xframes);
  await a.ok('browser_type', { selector: '#user', text: 'carol', submit: true });
  const consoleText = await a.ok('browser_console_messages');
  assert.match(consoleText, /\[log\] frame login carol {2}\(localhost:\d+\/xlogin\.html:\d+:\d+\)/);
  const failed = await a.ok('browser_network_requests', { status: 'failed' });
  const id = /(r\d+) +GET 503/.exec(failed)?.[1];
  assert.ok(id, failed);
  const detail = await a.ok('browser_network_requests', { id });
  assert.match(detail, /Response body[^\n]*:\n {2}\{\n {4}"status": "503"/);
  // Documents of frames are listed too.
  assert.match(await a.ok('browser_network_requests', { filter: 'xinner.html', types: ['document'] }), /GET 200 document {2}http:\/\/\[::1\]:\d+\/xinner\.html/);
});

// ---------------------------------------------------------------- frames that change

test('refs into a frame that navigated, went same-origin or was removed are stale', async () => {
  await open(xframes);
  let snap = await a.ok('browser_snapshot');
  const reloadSoon = refOf(snap, 'button "Reload soon"');
  // A cross-site navigation inside the frame: same frame target, new document.
  const nav = await a.ok('browser_click', { ref: refOf(snap, 'link "Go to third site"') });
  assert.match(nav, /A frame navigated to http:\/\/\[::1\]:\d+\/xinner\.html/);
  await fails('browser_click', { ref: reloadSoon }, /Ref e\d+ \(button "Reload soon"\) belongs to a document that is gone: the frame http:\/\/\[::1\]:\d+\/xinner\.html has navigated since your snapshot/);
  snap = await a.ok('browser_snapshot');
  assert.match(snap, /- iframe "Navigating frame" \[ref=e\d+\]:\n {2}- paragraph: Innermost text/);
  const inner = /- iframe "Navigating frame"[\s\S]*?button "Innermost button" \[ref=(e\d+)\]/.exec(snap)[1];

  // To the page's own site: the frame leaves its target and is read through the page instead.
  const moved = await a.ok('browser_evaluate', { function: `() => { document.getElementById('nav').src = location.origin + '/xinner.html'; }` });
  await until(async () => /Innermost text/.test(await a.ok('browser_evaluate', { function: `() => document.getElementById('nav').contentDocument?.body?.innerText ?? ''` })), 'same-origin frame');
  assert.ok(moved !== undefined);
  await fails('browser_click', { ref: inner }, /was inside a frame that is gone/);
  snap = await a.ok('browser_snapshot', { offset: 0 });
  assert.match(snap, /- iframe "Navigating frame" \[ref=e\d+\]:\n {2}- paragraph: Innermost text/);
  assert.match(await a.ok('browser_click', { ref: /- iframe "Navigating frame"[\s\S]*?button "Innermost button" \[ref=(e\d+)\]/.exec(snap)[1] }), /It is now button "Innermost clicked"/);

  // Removed: refs inside it fail, the snapshot no longer shows it.
  const user = refOf(snap, 'textbox "Username"');
  await a.ok('browser_evaluate', { function: `() => document.getElementById('login').remove()` });
  await fails('browser_type', { ref: user, text: 'x' }, /Ref e\d+ \(textbox "Username"\) (was inside a frame that is gone|no longer exists|was removed)/);
  assert.doesNotMatch(await a.ok('browser_snapshot', { offset: 0 }), /Login frame/);
});

test('a frame that goes away while a call uses it fails at once instead of hanging', async () => {
  await open(xframes);
  await a.ok('browser_evaluate', { function: `() => { setTimeout(() => document.getElementById('login').remove(), 600); }` });
  const started = Date.now();
  const r = await a.call('browser_evaluate', { selector: '#login >>> #user', function: 'el => new Promise(resolve => setTimeout(resolve, 8000))' });
  const ms = Date.now() - started;
  assert.ok(r.isError, `should fail: ${r.text}`);
  assert.match(r.text, /went away|was closed|gone/);
  assert.ok(ms < 4000, `took ${ms} ms`);
  // A frame that reloads while a wait runs: the wait keeps working and sees the new document.
  await a.ok('browser_evaluate', { selector: '#nav >>> button', function: 'el => el.click()' });
  assert.match(await a.ok('browser_wait_for', { text: 'Navigating frame start', timeout: 5 }), /is visible/);
});

// ---------------------------------------------------------------- cost

test('many frames: the snapshot is bounded, fast, and says how to read the rest', async () => {
  await open(xmany);
  await a.ok('browser_wait_for', { selector: '#login >>> #user' });
  const times = [];
  let snap;
  for (let i = 0; i < 3; i++) {
    const started = Date.now();
    snap = await a.ok('browser_snapshot', { offset: 0 });
    times.push(Date.now() - started);
  }
  const read = [...snap.matchAll(/- iframe "[^"]*" \[ref=e\d+\]:\n {2}- /g)].length;
  const skipped = [...snap.matchAll(/\[frame not read \(limit 10 cross-origin frames\); snapshot this ref to read it\]/g)].length;
  assert.equal(read, 10, snap);
  assert.equal(skipped, 11, snap);
  assert.equal([...snap.matchAll(/\[frame not read: 1×1 px\]/g)].length, 2, snap);
  // The largest frame (the login form) is read first, although twenty ads come before it.
  assert.match(snap, /- iframe "Login frame" \[ref=e\d+\]:\n {2}- form/);
  assert.ok(Math.min(...times) < 1000, `snapshots took ${times.join(', ')} ms`);
  console.log(`      24 frames: snapshot ${times.join(' / ')} ms, ${snap.length} characters`);
  // A skipped frame is read by rooting a snapshot at it.
  const ad20 = await a.ok('browser_snapshot', { ref: refOf(snap, 'iframe "Ad 20"') });
  assert.match(ad20, /link "Buy now 20"/);
});

// ---------------------------------------------------------------- sessions

test('two sessions on one tab keep their own refs inside frames', async () => {
  const tab = await open(xframes);
  const b = await agent({ session: 'browser-frames-b' });
  try {
    const mine = await a.ok('browser_snapshot');
    const theirs = await b.ok('browser_snapshot', { tab });
    const myRef = refOf(mine, 'button "Innermost button"');
    const theirRef = refOf(theirs, 'button "Innermost button"');
    await a.ok('browser_release_tab', { tab }).catch(() => {});
    assert.match(await b.ok('browser_click', { tab, ref: theirRef }), /It is now button "Innermost clicked"/);
    await b.ok('browser_release_tab', { tab }).catch(() => {});
    // Each session resolves only its own refs; the role changed underneath, which both see as stale.
    const r = await a.call('browser_click', { tab, ref: myRef });
    assert.match(r.text, /has changed: it was button "Innermost button"/);
  } finally {
    await b.close();
  }
});

// ---------------------------------------------------------------- a real page

test('real public page: MDN live example in a cross-origin frame, with a map frame inside', async () => {
  const url = 'https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe';
  try {
    const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    console.log(`      skipped: ${url} is not reachable (${err.message})`);
    return;
  }
  await open(url);
  // A plain selector searches every frame, nested ones included.
  await a.ok('browser_wait_for', { selector: '[class*=ctrl-zoom-in]', timeout: 20 });
  const snap = await a.ok('browser_snapshot', { maxChars: 60000 });
  // The live example (another site) holds the example's own <iframe> with an OpenStreetMap map (a third site).
  const example = /- iframe "runner" \[ref=e\d+\]:\n {2,}- iframe "Inline Frame Example" \[ref=e\d+\]:\n(?: {4,}.*\n)*? {4,}- button "[^"]+" \[ref=(e\d+)\]/.exec(snap);
  assert.ok(example, `no map controls inside the example frame:\n${snap.slice(0, 4000)}`);
  const clicked = await a.ok('browser_click', { ref: example[1] });
  assert.match(clicked, /^Clicked button/);
  assert.match(await read('[class*=ctrl-zoom-in]', 'el => location.host'), /openstreetmap\.org$/);
}, { skip: offline ?? false });

await run();
