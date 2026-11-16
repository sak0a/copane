// browser_audit type "keyboard" (page/keyboard.ts) against a running dev host:
//
//   node scripts/dev-host.mjs --name kbd
//   node test/e2e/browser-keyboard.e2e.mjs --name kbd [--only <text>]
//
// The fixture pages (test/fixtures/browser-keyboard) have known problems: no skip link, focus that does
// not show, controls Tab never reaches, a positive tabindex, a keyboard trap, a modal dialog, a broken
// skip link, and 400 links for the step limit. They are served on 127.0.0.1, with the cross-origin
// frame on localhost (another site, so another process: a frame target).
import { startKeyboardServer } from '../fixtures/browser-keyboard/server.mjs';
import { agent, assert, run, test } from './harness.mjs';

const other = await startKeyboardServer({ host: 'localhost' });
const site = await startKeyboardServer({ other: other.url });

const a = await agent({ session: `browser-keyboard-${Date.now()}` });

let tab;
async function open(path) {
  if (!tab) {
    const text = await a.ok('browser_open', { url: `${site.url}${path}`, background: true });
    tab = /Opened (tab-\d+)/.exec(text)?.[1];
    assert.ok(tab, `no tab id in: ${text}`);
    await a.ok('browser_wait_for', { loadState: 'load' });
    return text;
  }
  const text = await a.ok('browser_navigate', { url: `${site.url}${path}` });
  await a.ok('browser_wait_for', { loadState: 'load' });
  return text;
}

// The cross-origin frame is a separate frame target only with site isolation; the bridge says so when it attaches.
const opened = await open('/index.html');
const isolated = /A frame navigated to http:\/\/localhost/.test(opened) ? undefined : 'needs site isolation (localhost and 127.0.0.1 as separate sites)';

const has = (text, part) => assert.ok(text.includes(part), `expected the result to contain\n  ${part}\nbut it is:\n${text}`);
const refOf = (line) => /\[ref=(e\d+)\]/.exec(line)?.[1];

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
  const invisible = lines[lines.findIndex(l => l.includes('focus-not-visible')) + 1];
  has(invisible, `button "Search" [ref=${refOf(search)}]`);
});

test('whole page: the cross-origin frame is walked into, its focus style checked by style', async () => {
  if (!whole) whole = await a.ok('browser_audit', { type: 'keyboard' });
  assert.match(whole, /\d+ button "Open chat" \[ref=e\d+\] \(\d+,\d+\) in the frame http:\/\/localhost:\d+\/frame\.html/);
  assert.match(whole, /button "Open chat" \[ref=e\d+\] \(in the frame http:\/\/localhost:\d+\/frame\.html; style check only\)/);
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

test('keyboard trap: Tab and Shift+Tab stay inside the widget', async () => {
  await open('/trap.html');
  const text = await a.ok('browser_audit', { type: 'keyboard' });
  has(text, 'stopped at a keyboard trap (stop 2)');
  assert.match(text, /- critical keyboard-trap ×1 \[WCAG 2\.1\.2 A\]: Tab cycles inside group "Chat" \[ref=e\d+\] through 3 stops; Shift\+Tab cannot leave it either\./);
  has(text, 'textbox "Message"');
  has(text, 'button "Close"');
});

test('a modal dialog given as the region keeps focus inside, as it should', async () => {
  await open('/trap.html?dialog');
  const snap = await a.ok('browser_snapshot');
  const ref = /dialog "Delete project\?"[^\n]*\[ref=(e\d+)\]/.exec(snap)?.[1];
  assert.ok(ref, `no dialog ref in:\n${snap}`);
  const text = await a.ok('browser_audit', { type: 'keyboard', ref });
  has(text, `(only dialog "Delete project?" [ref=${ref}]): 2 Tab stops; focus stays inside the modal dialog, as it should`);
  has(text, 'No problems found.');
  assert.ok(!text.includes('keyboard-trap'), text);
});

test('a skip link whose target does not exist', async () => {
  await open('/skip.html');
  const text = await a.ok('browser_audit', { type: 'keyboard' });
  assert.match(text, /- moderate skip-link-broken ×1 \[WCAG 2\.4\.1 A\]: the skip link goes nowhere: nothing on the page has id "content"\./);
  assert.match(text, /\n {2}link "Skip to content" \[ref=e\d+\]/);
  assert.ok(!text.includes('skip-link-missing'), text);
});

test('a long page stops at the step limit and says so', async () => {
  await open('/many.html');
  const text = await a.ok('browser_audit', { type: 'keyboard' }, { timeoutMs: 90_000 });
  has(text, 'stopped after 250 Tab stops (the limit)');
  has(text, 'Focus order (page CSS px): first 40 of 250');
  has(text, '… 210 more stops');
  assert.ok(text.length < 5000, `${text.length} characters`);
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
    assert.match(busy.text, /Claude|session|control|busy|using/i);
    // Reading stays open to it.
    await b.ok('browser_audit', { type: 'accessibility', tab });
  } finally {
    await b.close();
  }
});

test('cleanup: close the tab', async () => {
  if (tab) await a.ok('browser_close_tab', { tab });
});

try {
  await run();
} finally {
  await Promise.all([site.close(), other.close()]);
}
