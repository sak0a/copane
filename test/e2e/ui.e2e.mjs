// The Sessions view and the status bar item, against a running dev host. Two agents: "agent" does what
// an agent does (connect, name itself, open a tab), "user" stands in for the person at the window
// (runs the UI commands through debug_vscode_command, answers prompts). Every state is checked twice:
// in the view model the extension renders (`debug_ui_state`) and in the real workbench DOM (scripts/ui.mjs).
//
//   node scripts/dev-host.mjs --name ui
//   node test/e2e/ui.e2e.mjs --name ui
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { startPageServer } from '../fixtures/ui-pages.mjs';
import { agent, assert, hostName, root, run, test, until } from './harness.mjs';

const exec = promisify(execFile);
const STATUS_ID = 'sak0a.vscode-agent-bridge.agentBridge.status';

/** Evaluates a JS expression in the dev host's workbench page and returns its (JSON) value. */
async function dom(expression) {
  const { stdout } = await exec(process.execPath, [join(root, 'scripts', 'ui.mjs'), '--name', hostName, 'eval', `JSON.stringify(${expression})`]);
  return JSON.parse(stdout.trim()); // ui.mjs prints strings as they are
}

/** What the workbench shows: Sessions rows (aria labels), the status bar item, the activity bar badge, welcome text. */
const workbench = () =>
  dom(`(() => {
    const view = document.getElementById('workbench.view.extension.agentBridge');
    const status = document.getElementById(${JSON.stringify(STATUS_ID)});
    const container = [...document.querySelectorAll('.action-item')].find(a => /^Agent Bridge/.test(a.querySelector('.action-label')?.getAttribute('aria-label') ?? ''));
    return {
      rows: view ? [...view.querySelectorAll('.monaco-list-row')].map(r => r.getAttribute('aria-label')) : null,
      welcome: view?.querySelector('.welcome-view-content')?.innerText ?? null,
      status: status && status.offsetParent !== null ? { text: status.innerText.trim(), aria: status.querySelector('[aria-label]')?.getAttribute('aria-label'), warning: status.classList.contains('warning-kind') } : null,
      badge: container?.querySelector('.badge-content')?.textContent || null,
    };
  })()`);

const pages = await startPageServer();
const user = await agent({ session: 'ui-e2e-user' });
const state = async () => JSON.parse(await user.ok('debug_ui_state'));
const command = (name, ...args) => user.ok('debug_vscode_command', { command: name, args });
const row = (s, id) => s.rows.find(r => r.id === id);

let alpha; // the agent under test
let alphaLabel;
let tabId;

test('a connecting session appears in the view and in the status bar', async () => {
  await command('workbench.view.extension.agentBridge');
  alpha = await agent({ session: 'ui-e2e-alpha' });
  await alpha.ok('session_set_title', { title: 'ui e2e alpha' });
  alphaLabel = JSON.parse(await alpha.ok('session_info')).you.label;

  const s = await until(async () => {
    const s = await state();
    return row(s, 'session:ui-e2e-alpha#empty')?.description === 'ui e2e alpha' && s;
  }, 'the session row');
  assert.equal(row(s, 'session:ui-e2e-alpha#empty').label, alphaLabel);
  assert.equal(row(s, 'session:ui-e2e-alpha#empty').icon.id, 'circle-filled');
  assert.match(s.status.shown.text, /^\$\(robot\) \d+$/);
  assert.equal(s.badge, null);

  const w = await until(async () => {
    const w = await workbench();
    return w.rows?.some(r => r.startsWith(`${alphaLabel} agent session, ui e2e alpha, connected`)) && w.status && w;
  }, 'the session row and status bar item in the workbench');
  assert.match(w.status.aria, /agent sessions? connected/);
  assert.equal(w.status.warning, false);
});

test('a tab the agent opens is listed under it as controlling', async () => {
  const opened = await alpha.ok('browser_open', { url: pages.url('UI Checkout'), background: true });
  tabId = /tab-\d+/.exec(opened)?.[0];
  assert.ok(tabId, `no tab id in: ${opened}`);

  const s = await until(async () => {
    const s = await state();
    return row(s, `session:ui-e2e-alpha/tab:${tabId}`)?.description?.startsWith('controlling') && s;
  }, 'the controlling tab row');
  const tab = row(s, `session:ui-e2e-alpha/tab:${tabId}`);
  assert.equal(tab.label, 'UI Checkout');
  assert.equal(tab.icon.id, 'globe');
  assert.equal(tab.icon.color, row(s, 'session:ui-e2e-alpha').icon.color, 'the tab row uses the session color');
  assert.match(tab.contextValue, /\breleasable\b/);

  await until(async () => (await workbench()).rows?.some(r => r.startsWith('Browser tab UI Checkout, controlling')), 'the tab row in the workbench');
});

test('pausing the tab as the user shows it, counts it and blocks the agent; resuming clears it', async () => {
  await command('agentBridge.ui.pauseTab', tabId);
  const s = await until(async () => {
    const s = await state();
    return row(s, `session:ui-e2e-alpha/tab:${tabId}`)?.description?.startsWith('paused by you') && s;
  }, 'the paused tab row');
  assert.equal(row(s, `session:ui-e2e-alpha/tab:${tabId}`).icon.id, 'debug-pause');
  assert.ok(s.badge.value >= 1);
  assert.ok(s.attention.some(a => a.kind === 'tab' && a.targetId === tabId));
  assert.match(s.status.shown.text, /\$\(debug-pause\) \d+/);
  assert.equal(s.status.warning, false, 'a paused tab is not a warning');

  const w = await until(async () => {
    const w = await workbench();
    return w.rows?.some(r => r.startsWith('Browser tab UI Checkout, paused by you')) && w.badge && w;
  }, 'the paused row and the badge in the workbench');
  assert.match(w.status.aria, /1 tab paused/);
  // Owned by the page tools; skipped if that tool is renamed.
  const refused = await alpha.call('browser_evaluate', { tab: tabId, expression: 'document.title' });
  if (!/Unknown tool/.test(refused.text)) assert.ok(refused.isError && /paused/.test(refused.text), `the agent was not blocked: ${refused.text}`);

  await command('agentBridge.ui.resumeTab', tabId);
  await until(async () => {
    const s = await state();
    return !row(s, `session:ui-e2e-alpha/tab:${tabId}`).description.startsWith('paused') && !s.attention.some(a => a.targetId === tabId);
  }, 'the tab to be resumed');
});

test('a terminal waiting for the user turns the status bar into a warning until it is handled', async () => {
  await user.ok('debug_ui_fixtures', {
    terminals: [{ id: 'fx-e2e', name: 'deploy', ownedBy: 'ui-e2e-alpha', state: 'waiting-for-user', currentCommand: 'npm login', userInputRequest: 'Log in to npm' }],
  });
  const s = await until(async () => {
    const s = await state();
    return s.status.warning && s;
  }, 'the warning status');
  assert.equal(s.status.shown.text, `$(bell-dot) ${alphaLabel} needs you`);
  assert.equal(s.status.shown.backgroundColor, 'statusBarItem.warningBackground');
  assert.equal(row(s, 'session:ui-e2e-alpha').description, 'ui e2e alpha · needs you');
  assert.equal(row(s, 'session:ui-e2e-alpha/terminal:fx-e2e').description, 'waiting for you: Log in to npm');

  const w = await until(async () => {
    const w = await workbench();
    return w.status?.warning && w.rows?.some(r => r.startsWith('Terminal deploy, waiting for you: Log in to npm')) && w;
  }, 'the warning status bar item and the waiting terminal row in the workbench');
  assert.match(w.status.text, /needs you/);

  await command('agentBridge.ui.interruptTerminal', 'fx-e2e');
  const after = await until(async () => {
    const s = await state();
    return !s.status.warning && s;
  }, 'the warning to clear');
  assert.equal(row(after, 'session:ui-e2e-alpha/terminal:fx-e2e').description, 'idle · exit 130');
  await user.ok('debug_ui_fixtures', { terminals: [] });
});

test('ending the session asks first, then removes it and releases its tab', async () => {
  await user.ok('debug_ui_fixtures', { terminals: [] });
  await user.ok('debug_answer_prompts', { answers: ['End Session'], clear: true });
  await command('agentBridge.ui.endSession', 'ui-e2e-alpha');
  const prompts = JSON.parse(await user.ok('debug_answer_prompts', {})).shown;
  const prompt = prompts.at(-1);
  assert.equal(prompt.message, `End ${alphaLabel} (ui e2e alpha)?`);
  assert.deepEqual(prompt.choices, ['End Session', 'End and Close Its Tabs']);
  assert.equal(prompt.answer, 'End Session');

  await until(async () => !(await state()).rows.some(r => r.id.startsWith('session:ui-e2e-alpha')), 'the session to disappear');
  await until(async () => !(await workbench()).rows?.some(r => r.startsWith(`${alphaLabel} agent session`)), 'the session row to disappear from the workbench');
  const tabs = await user.ok('browser_list_tabs');
  const line = tabs.split('\n').find(l => l.startsWith(`${tabId} `));
  assert.ok(line && !/controlled by/.test(line), `the tab is still controlled: ${line}`);
  await command('agentBridge.ui.closeTab', tabId);
  await until(async () => !(await user.ok('browser_list_tabs')).includes(`${tabId} `), 'the tab to close');
});

test('with no session left the view shows its welcome and the status bar item hides', async () => {
  await alpha.close().catch(() => {});
  await user.close();
  // The observer's own session ends after the grace period (agentBridge.sessionGraceSeconds, 20 s by default).
  const w = await until(
    async () => {
      const w = await workbench();
      return w.welcome?.includes('No agent is connected to this window') && !w.status && w;
    },
    'the welcome content and a hidden status bar item',
    { timeoutMs: 45_000, intervalMs: 1000 },
  );
  assert.equal(w.badge, null);
});

try {
  await run();
} finally {
  await pages.close();
}
