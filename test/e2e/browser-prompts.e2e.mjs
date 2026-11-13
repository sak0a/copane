// Questions about browser tabs (consent, certificates, downloads, logins) wait in the status bar
// (core/promptStatus.ts) instead of a notification, because VS Code pauses a browser view while a
// notification covers it. Checks that asking pauses no view, that a tab opened meanwhile gets its real
// size, and that the user answers through VS Code's own modal dialog.
//
//   node scripts/dev-host.mjs --name <n>
//   node test/e2e/browser-prompts.e2e.mjs --name <n>
//
// Looks at the dev host's workbench through scripts/ui.mjs; the only thing it clicks there is the
// dialog button a user would click, which no tool can do.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { startFixtureServer } from '../fixtures/pages/server.mjs';
import { agent, assert, hostName, root, run, sleep, test, until } from './harness.mjs';

const site = await startFixtureServer();
const stamp = Date.now();

const ui = expression => execFileSync(process.execPath, [join(root, 'scripts', 'ui.mjs'), '--name', hostName, 'eval', expression], { encoding: 'utf8' }).trim();
/** What the workbench shows: toasts, paused browser views, our status bar item, an open dialog. */
function workbench() {
  return JSON.parse(
    ui(`JSON.stringify({
      toasts: [...document.querySelectorAll('.notification-toast-container .notification-toast')].map(t => t.textContent),
      paused: [...document.querySelectorAll('.browser-overlay-paused')].filter(e => e.classList.contains('visible') && e.getClientRects().length > 0).map(e => e.textContent),
      toastsShown: document.querySelector('.notifications-toasts')?.className ?? '',
      centre: document.querySelector('.notifications-center')?.className ?? '',
      item: [...document.querySelectorAll('.statusbar-item')].map(e => e.textContent + ' | ' + (e.querySelector('[aria-label]')?.getAttribute('aria-label') ?? e.getAttribute('aria-label') ?? '')).find(t => /asks to use|agent questions/.test(t)) ?? null,
      dialog: document.querySelector('.monaco-dialog-box') ? { text: document.querySelector('.monaco-dialog-box').textContent, buttons: [...document.querySelectorAll('.monaco-dialog-box .dialog-buttons .monaco-button')].map(b => b.textContent) } : null,
    })`),
  );
}
const clickDialogButton = label =>
  ui(`(() => { const b = [...document.querySelectorAll('.monaco-dialog-box .dialog-buttons .monaco-button')].find(b => b.textContent === ${JSON.stringify(label)}); if (b) b.click(); return !!b; })()`);

const debugPrompts = async a => JSON.parse(await a.ok('debug_answer_prompts', {}));
const size = a => a.ok('browser_evaluate', { function: '() => innerWidth + "x" + innerHeight' });

/** Opens a tab as the user would and returns its id. */
async function userOpens(a, url) {
  await a.ok('debug_vscode_command', { command: 'workbench.action.browser.open', args: [url] });
  return until(async () => new RegExp(`(tab-\\d+)\\s+${url.replace(/[.?*+^$()|[\]\\]/g, '\\$&')}\\s`).exec(await a.ok('browser_list_tabs'))?.[1], `a tab for ${url}`);
}

test('a question about a tab waits in the status bar; no browser view is paused, and a tab opened meanwhile has its real size', async () => {
  const x = await agent({ session: `prompts-x-${stamp}` });
  const y = await agent({ session: `prompts-y-${stamp}` });
  let waitingCall;
  try {
    await x.ok('debug_vscode_command', { command: 'notifications.clearAll' });
    await x.ok('debug_answer_prompts', { clear: true });
    const userTab = await userOpens(x, `${site.url}/form.html?prompts=${stamp}`);
    // The agent's own tab in front, visible in the editor area.
    await x.ok('browser_open', { url: `${site.url}/long.html?prompts=${stamp}` });
    await sleep(1000);
    const visibleSize = await size(x);

    // Another agent asks to use the user's tab; nobody answers yet.
    waitingCall = y.call('browser_snapshot', { tab: userTab }, { timeoutMs: 200_000 });
    waitingCall.catch(() => {});
    await until(async () => ((await debugPrompts(x)).waiting?.length ?? 0) > 0 || workbench().toasts.length > 0, 'the question to be shown');
    await sleep(1500);
    const shown = workbench();
    assert.deepEqual(shown.toasts, [], 'a notification was shown');
    assert.deepEqual(shown.paused, [], `a browser view is paused: ${JSON.stringify(shown)}`);
    assert.match(shown.item ?? '', /asks to use/, `no status bar item: ${JSON.stringify(shown)}`);
    const waiting = (await debugPrompts(x)).waiting.find(w => /wants to use/.test(w.message));
    assert.match(waiting.summary, new RegExp(`^Claude \\d+ asks to use ${userTab} \\(127\\.0\\.0\\.1:\\d+\\)$`));

    // The agent's work in the visible tab is unaffected: a screenshot is quick, a new tab is laid out.
    const started = Date.now();
    const shot = await x.ok('browser_screenshot', {});
    assert.ok(Date.now() - started < 3000, `the screenshot took ${Date.now() - started} ms`);
    assert.match(shot, new RegExp(`${visibleSize.replace('x', '×')} px`));
    await x.ok('browser_open', { url: `${site.url}/long.html?prompts=${stamp}-second` });
    await sleep(1000);
    assert.equal(await size(x), visibleSize, 'a tab opened during the question did not get its real size');

    // The user answers: the status bar item opens the question in VS Code's modal dialog.
    const answering = x.call('debug_vscode_command', { command: 'copane.answerQuestion' }, { timeoutMs: 60_000 });
    answering.catch(() => {});
    const dialog = await until(() => workbench().dialog, 'the dialog');
    assert.match(dialog.text, /wants to use/);
    assert.deepEqual([...dialog.buttons].sort(), ['Allow', `Allow on 127.0.0.1:${site.port}`, 'Cancel', 'Deny']);
    assert.ok(clickDialogButton('Allow'));
    await answering;
    const result = await waitingCall;
    assert.ok(!result.isError, result.text);
    assert.match(result.text, /Snapshot of tab-\d+/);
    const last = (await debugPrompts(x)).shown.at(-1);
    assert.equal(last.answer, 'Allow');
    assert.equal(last.placement, 'statusBar');
    assert.equal(workbench().item, null, 'the status bar item stayed after the answer');
  } finally {
    clickDialogButton('Cancel');
    await x.call('debug_vscode_command', { command: 'workbench.action.closeAllEditors' });
    await waitingCall?.catch(() => {});
    await x.close();
    await y.close();
  }
});

test('a question that stops making sense leaves the status bar; closing the dialog dismisses it', async () => {
  const x = await agent({ session: `prompts-gone-${stamp}` });
  const y = await agent({ session: `prompts-gone-y-${stamp}` });
  try {
    await x.ok('debug_answer_prompts', { clear: true });
    const first = await userOpens(x, `${site.url}/table.html?gone=${stamp}`);
    const asking = y.call('browser_snapshot', { tab: first }, { timeoutMs: 200_000 });
    asking.catch(() => {});
    await until(async () => (await debugPrompts(x)).waiting.length === 1, 'the question');
    // The tab closes: the question goes away by itself.
    await x.ok('debug_vscode_command', { command: 'workbench.action.closeAllEditors' });
    const gone = await asking;
    assert.ok(gone.isError);
    assert.match(gone.text, /closed/);
    await until(async () => (await debugPrompts(x)).waiting.length === 0, 'the question to leave');
    assert.equal(workbench().item, null);

    const second = await userOpens(x, `${site.url}/table.html?dismiss=${stamp}`);
    const again = y.call('browser_snapshot', { tab: second }, { timeoutMs: 200_000 });
    again.catch(() => {});
    await until(async () => (await debugPrompts(x)).waiting.length === 1, 'the second question');
    const answering = x.call('debug_vscode_command', { command: 'copane.answerQuestion' }, { timeoutMs: 60_000 });
    answering.catch(() => {});
    await until(() => workbench().dialog, 'the dialog');
    assert.ok(clickDialogButton('Cancel'));
    await answering;
    const dismissed = await again;
    assert.ok(dismissed.isError);
    assert.match(dismissed.text, /closed the request to use tab-\d+ without answering/);
    assert.equal((await debugPrompts(x)).shown.at(-1).answer, undefined);
  } finally {
    clickDialogButton('Cancel');
    await x.call('debug_vscode_command', { command: 'workbench.action.closeAllEditors' });
    await x.close();
    await y.close();
  }
});

await run();
