// browser_audit type "keyboard" (page/keyboard.ts) against a running dev host:
//
//   node scripts/dev-host.mjs --name kbd
//   node test/e2e/browser-keyboard.e2e.mjs --name kbd [--only <text>]
//
// The fixture pages (test/fixtures/browser-keyboard) have known problems: no skip link, focus that does
// not show, controls Tab never reaches, a positive tabindex, keyboard traps, a modal dialog, a broken
// skip link, 400 links for the step limit, and pages for the walk's edge cases (closed shadow roots,
// frames it cannot read, aria-modal, hidden inputs, focus handlers that navigate or alert). The main
// site is 127.0.0.1; the cross-origin frame comes from localhost (another site, so another process: a
// frame target); opaque.html is served from a second localhost port, so its frame is cross-origin but
// the same site (same process, not readable from the page).
import { startKeyboardServers } from '../fixtures/browser-keyboard/server.mjs';
import { agent, assert, run, test } from './harness.mjs';

const servers = await startKeyboardServers();
const { site, sameSite } = servers;

const a = await agent({ session: `browser-keyboard-${Date.now()}` });

let tab;
async function open(url) {
  const full = url.startsWith('http') ? url : `${site.url}${url}`;
  if (!tab) {
    const text = await a.ok('browser_open', { url: full, background: true });
    tab = /Opened (tab-\d+)/.exec(text)?.[1];
    assert.ok(tab, `no tab id in: ${text}`);
    await a.ok('browser_wait_for', { loadState: 'load' });
    return text;
  }
  const text = await a.ok('browser_navigate', { url: full });
  await a.ok('browser_wait_for', { loadState: 'load' });
  return text;
}

// The cross-origin frame is a separate frame target only with site isolation; the bridge says so when it attaches.
const opened = await open('/index.html');
const isolated = /A frame navigated to http:\/\/localhost/.test(opened) ? undefined : 'needs site isolation (localhost and 127.0.0.1 as separate sites)';

const has = (text, part) => assert.ok(text.includes(part), `expected the result to contain\n  ${part}\nbut it is:\n${text}`);
const hasNot = (text, part) => assert.ok(!text.includes(part), `expected the result not to contain\n  ${part}\nbut it is:\n${text}`);
const refOf = (line) => /\[ref=(e\d+)\]/.exec(line)?.[1];
const problemLine = (text, id) => {
  const lines = text.split('\n');
  const i = lines.findIndex(l => l.startsWith(`- `) && l.includes(` ${id} `));
  return i < 0 ? '' : `${lines[i]}\n${lines[i + 1] ?? ''}`;
};

let whole;

test('whole page: every planted problem with its WCAG criterion, shadow DOM and frames in the order', async () => {
  await open('/index.html');
  whole = await a.ok('browser_audit', { type: 'keyboard' });
  const lines = whole.split('\n');
  assert.match(lines[0], /^Keyboard walk of tab-\d+ \(whole page, 3 documents\): 14 Tab stops, back to the start, [\d.]+ s; 7 problems in 4 checks, all fail WCAG A\/AA\. Focus and scroll restored\.$/);
  has(whole, '1 textbox "Email"');
  has(whole, 'tabindex=3 (focused by script)');
  has(whole, 'button "Voice search"');
  has(whole, 'button "Image search"');
  has(whole, 'link "Frame link"');
  has(whole, '- serious focus-not-visible ×2 [WCAG 2.4.7 AA]');
  has(whole, '- serious not-focusable ×2 [WCAG 2.1.1 A]');
  has(whole, 'button "Add to cart"');
  has(whole, '(role=button, no tabindex)');
  has(whole, '<span id="filters"> Filters');
  has(whole, '(click handler, cursor: pointer)');
  has(whole, '- moderate skip-link-missing ×1 [WCAG 2.4.1 A]: 10 stops before the main content');
  has(whole, '- moderate focus-order ×2 [WCAG 2.4.3 A]');
  has(whole, '(jumps ');
  const search = lines.find(l => /^\d+ button "Search"/.test(l));
  assert.ok(search, `no Search stop:\n${whole}`);
  has(problemLine(whole, 'focus-not-visible'), `button "Search" [ref=${refOf(search)}]`);
});

test('whole page: the cross-origin frame is walked into and its invisible focus found', async () => {
  if (!whole) whole = await a.ok('browser_audit', { type: 'keyboard' });
  assert.match(whole, /\d+ button "Open chat" \[ref=e\d+\] \(\d+,\d+\) in the frame http:\/\/localhost:\d+\/frame\.html/);
  assert.match(problemLine(whole, 'focus-not-visible'), /button "Open chat" \[ref=e\d+\]/);
}, { skip: isolated });

test('a cross-origin frame that had focus before (a click inside it) is still walked', async () => {
  await open('/index.html');
  await a.ok('browser_click', { selector: "iframe[title='Cross-origin frame'] >>> #chat" });
  await a.ok('browser_evaluate', { function: '() => { document.activeElement.blur(); return 1; }' });
  const text = await a.ok('browser_audit', { type: 'keyboard' });
  assert.match(text.split('\n')[0], /\(whole page, 3 documents\): 14 Tab stops, back to the start/);
  assert.match(problemLine(text, 'focus-not-visible'), /button "Open chat"/);
  hasNot(problemLine(text, 'not-focusable'), 'Open chat');
}, { skip: isolated });

test('refs from the result work with browser_click', async () => {
  await open('/index.html');
  const text = await a.ok('browser_audit', { type: 'keyboard' });
  const ref = refOf(text.split('\n').find(l => /^\d+ button "Search"/.test(l)) ?? '');
  assert.ok(ref, `no ref for Search:\n${text}`);
  await a.ok('browser_click', { ref });
  await a.ok('browser_wait_for', { text: 'Searched 1 times' });
});

test('focus, scroll and selection are put back', async () => {
  await open('/index.html');
  const before = await a.ok('browser_evaluate', { function: "() => { scrollTo(0, 300); document.getElementById('start').focus({ preventScroll: true }); return JSON.stringify([scrollY, document.activeElement.id]); }" });
  assert.equal(before, '[300,"start"]');
  await a.ok('browser_audit', { type: 'keyboard' });
  const after = await a.ok('browser_evaluate', { function: '() => JSON.stringify([scrollY, document.activeElement.id])' });
  assert.equal(after, '[300,"start"]');
  // Nothing focused before: nothing focused after.
  await a.ok('browser_evaluate', { function: '() => { document.activeElement.blur(); scrollTo(0, 0); return 1; }' });
  await a.ok('browser_audit', { type: 'keyboard' });
  const none = await a.ok('browser_evaluate', { function: '() => JSON.stringify([scrollY, document.activeElement === document.body])' });
  assert.equal(none, '[0,true]');
});

test('a closed shadow root and a same-site frame: their stops are seen, not taken for a trap', async () => {
  await open(`${sameSite.url}/opaque.html`);
  const text = await a.ok('browser_audit', { type: 'keyboard' });
  assert.match(text.split('\n')[0], /: 6 Tab stops, back to the start/);
  for (const name of ['First', 'One', 'Two', 'Three', 'Open chat', 'Last']) assert.match(text, new RegExp(`\\n\\d+ button "${name}"`));
  has(text, 'button "Open chat" [ref=');
  hasNot(text, 'keyboard-trap');
});

test('keyboard trap: Tab and Shift+Tab stay inside the widget', async () => {
  await open('/trap.html');
  const text = await a.ok('browser_audit', { type: 'keyboard' });
  has(text, 'stopped at a keyboard trap (stop 2)');
  assert.match(text, /- critical keyboard-trap ×1 \[WCAG 2\.1\.2 A\]: Tab cycles inside group "Chat" \[ref=e\d+\] through 3 stops; Shift\+Tab cannot leave it either\./);
  has(text, 'textbox "Message"');
  has(text, 'button "Close"');
  hasNot(text, 'DOM change');
});

test('a trap that holds stop 1 is a trap, not a complete walk', async () => {
  await open('/trap.html?first');
  const text = await a.ok('browser_audit', { type: 'keyboard' });
  has(text, 'stopped at a keyboard trap (stop 1)');
  has(text, 'Shift+Tab cannot leave it either');
  hasNot(text, 'not-focusable');
  hasNot(text, 'back to the start');
});

test('a large trap stays readable: 8 members and "+N more", under 5,000 characters', async () => {
  await open('/bigtrap.html');
  const text = await a.ok('browser_audit', { type: 'keyboard' }, { timeoutMs: 90_000 });
  has(text, 'keyboard-trap');
  has(text, '; +92 more');
  assert.ok(text.length <= 5000, `${text.length} characters`);
});

test('a modal dialog given as the region keeps focus inside, as it should', async () => {
  await open('/trap.html?dialog');
  const snap = await a.ok('browser_snapshot');
  const ref = /dialog "Delete project\?"[^\n]*\[ref=(e\d+)\]/.exec(snap)?.[1];
  assert.ok(ref, `no dialog ref in:\n${snap}`);
  const text = await a.ok('browser_audit', { type: 'keyboard', ref });
  has(text, `(only dialog "Delete project?" [ref=${ref}]): 2 Tab stops; focus stays inside the modal dialog, as it should`);
  has(text, 'No problems found.');
  hasNot(text, 'keyboard-trap');
});

test('an aria-modal dialog: contained, and the page behind it is not reported unreachable', async () => {
  await open('/modal.html');
  const text = await a.ok('browser_audit', { type: 'keyboard' });
  has(text, 'focus stays inside the modal dialog, as it should');
  hasNot(text, 'not-focusable');
  hasNot(text, 'Behind');
});

test('forms: disabled fieldsets are not unreachable; hidden inputs judged by their label; selections kept', async () => {
  await open('/forms.html');
  const text = await a.ok('browser_audit', { type: 'keyboard' });
  hasNot(text, 'Disabled inside');
  hasNot(text, 'Disabled field');
  const invisible = problemLine(text, 'focus-not-visible');
  has(invisible, 'checkbox "Bad switch"');
  has(invisible, '(the input itself is visually hidden; nothing near it shows focus)');
  hasNot(invisible, 'Good switch');
  const selection = await a.ok('browser_evaluate', { function: "() => { const t = document.getElementById('text'); return JSON.stringify([t.selectionStart, t.selectionEnd]); }" });
  assert.equal(selection, '[2,5]');
});

test('pixel checks are repeatable (10 walks): invisible focus in a same-origin frame, a ring only pixels show', async () => {
  await open('/forms.html');
  let found = 0;
  let wrong = 0;
  for (let i = 0; i < 10; i++) {
    const text = await a.ok('browser_audit', { type: 'keyboard' });
    const invisible = problemLine(text, 'focus-not-visible');
    if (invisible.includes('button "Pair button"')) found++;
    else console.log(`      run ${i + 1} missed the Pair button:\n${text}`);
    // Its ring is drawn by a great-grandparent (:focus-within), which only the pictures show.
    if (invisible.includes('Deep ring')) {
      wrong++;
      console.log(`      run ${i + 1} flagged Deep ring:\n${text}`);
    }
  }
  console.log(`      Pair button flagged in ${found} of 10 walks; Deep ring wrongly flagged in ${wrong} of 10`);
  assert.equal(found, 10);
  assert.equal(wrong, 0);
});

test('a page with nothing focusable: no Tab stops (the bridge\'s own indicator is never one)', async () => {
  await open('/empty.html');
  const text = await a.ok('browser_audit', { type: 'keyboard' });
  has(text, 'no Tab stops: nothing on the page takes focus with Tab');
  hasNot(text, 'Focus order');
  has(problemLine(text, 'not-focusable'), 'Pretend button');
});

test('a skip link whose target does not exist', async () => {
  await open('/skip.html');
  const text = await a.ok('browser_audit', { type: 'keyboard' });
  assert.match(text, /- moderate skip-link-broken ×1 \[WCAG 2\.4\.1 A\]: the skip link goes nowhere: nothing on the page has id "content"\./);
  assert.match(text, /\n {2}link "Skip to content" \[ref=e\d+\]/);
  hasNot(text, 'skip-link-missing');
});

test('a long page stops at the step limit and says so', async () => {
  await open('/many.html');
  const text = await a.ok('browser_audit', { type: 'keyboard' }, { timeoutMs: 90_000 });
  has(text, 'stopped after 250 Tab stops (the limit)');
  has(text, 'Focus order (page CSS px): first 40 of 250');
  has(text, '… 210 more stops');
  assert.ok(text.length < 5000, `${text.length} characters`);
});

test('a focus handler that navigates: the error names the last stop, and the tab stays usable', async () => {
  await open('/nav.html');
  const r = await a.call('browser_audit', { type: 'keyboard' });
  assert.ok(r.isError, r.text);
  has(r.text, 'navigated while Tab was pressed after stop 1 (link "One" [ref=');
  await a.ok('browser_wait_for', { loadState: 'load' });
  const snap = await a.ok('browser_snapshot');
  has(snap, 'skip.html');
});

test('a focus handler that opens an alert: the error says where the walk stopped', async () => {
  await open('/alert.html');
  const r = await a.call('browser_audit', { type: 'keyboard' });
  assert.ok(r.isError, r.text);
  has(r.text, 'alert dialog');
  has(r.text, 'The keyboard walk stopped after stop 1 (button "One" [ref=');
  has(r.text, 'focus and scroll were not restored');
  await a.ok('browser_handle_dialog', { accept: true });
});

test('under device emulation, focus is judged by style only and the emulation stays', async () => {
  await open('/index.html');
  await a.ok('browser_emulate', { preset: 'pixel-8' });
  try {
    const before = await a.ok('browser_evaluate', { function: '() => innerWidth' });
    const text = await a.ok('browser_audit', { type: 'keyboard' });
    has(problemLine(text, 'focus-not-visible'), 'style check only: device emulation');
    const after = await a.ok('browser_evaluate', { function: '() => innerWidth' });
    assert.equal(after, before);
  } finally {
    await a.ok('browser_emulate', { reset: true });
  }
});

test('reload is refused; a second session is refused while the first holds the tab', async () => {
  await open('/skip.html');
  const reload = await a.call('browser_audit', { type: 'keyboard', reload: true });
  assert.ok(reload.isError, reload.text);
  has(reload.text, 'reload applies to the performance check only.');
  await a.ok('browser_audit', { type: 'keyboard' });
  const b = await agent({ session: `browser-keyboard-b-${Date.now()}` });
  try {
    const busy = await b.call('browser_audit', { type: 'keyboard', tab });
    assert.ok(busy.isError, `the second session was let in:\n${busy.text}`);
    assert.match(busy.text, /is being controlled by/);
    // Reading stays open to it.
    await b.ok('browser_audit', { type: 'accessibility', tab });
  } finally {
    await b.close();
  }
});

test('a page with one Tab stop: a complete walk of 1 stop (whole page and as a region)', async () => {
  await open('/one.html');
  const text = await a.ok('browser_audit', { type: 'keyboard' });
  assert.match(text.split('\n')[0], /\(whole page\): 1 Tab stop, back to the start, [\d.]+ s; no problems found\./);
  hasNot(text, 'Tab presses');
  const region = await a.ok('browser_audit', { type: 'keyboard', selector: '#solo' });
  assert.match(region.split('\n')[0], /: 1 Tab stop, back to the start/);
  hasNot(region, 'keyboard-trap');
});

test('a modal dialog with one control contains focus, as it should (native and aria-modal, page and region)', async () => {
  await open('/onemodal.html');
  const text = await a.ok('browser_audit', { type: 'keyboard' });
  has(text, '1 Tab stop; focus stays inside the modal dialog, as it should');
  hasNot(text, 'keyboard-trap');
  const region = await a.ok('browser_audit', { type: 'keyboard', selector: '#d' });
  has(region, '1 Tab stop; focus stays inside the modal dialog, as it should');
  hasNot(region, 'keyboard-trap');
  await open('/onemodal.html?aria');
  const aria = await a.ok('browser_audit', { type: 'keyboard' });
  has(aria, '1 Tab stop; focus stays inside the modal dialog, as it should');
  hasNot(aria, 'keyboard-trap');
  hasNot(aria, 'not-focusable');
});

test('one element that takes focus back by script is still a trap (another control is reachable)', async () => {
  await open('/trap1.html');
  const text = await a.ok('browser_audit', { type: 'keyboard' });
  has(text, 'stopped at a keyboard trap (stop 1)');
  has(text, 'keyboard-trap');
  has(text, 'button "Trap"');
});

test('focus on a far ancestor is seen; focus clipped away by an ancestor is hidden', async () => {
  await open('/clip.html');
  const text = await a.ok('browser_audit', { type: 'keyboard' });
  const invisible = problemLine(text, 'focus-not-visible');
  hasNot(invisible, 'Far ring');
  has(invisible, 'button "No ring"');
  assert.match(invisible, /button "Clipped away" \[ref=e\d+\] \(hidden or off-screen when focused\)/);
  assert.match(invisible, /button "Off slide" \[ref=e\d+\] \(hidden or off-screen when focused\)/);
  hasNot(invisible, 'Normal');
});

test('cleanup: close the tab', async () => {
  if (tab) await a.ok('browser_close_tab', { tab });
});

try {
  await run();
} finally {
  await servers.close();
}
