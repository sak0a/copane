// The Agent Tabs view in the bottom panel, against a running dev host. Agents "alpha" and "beta" open
// tabs; "user" stands in for the person at the window (runs commands through debug_vscode_command,
// answers prompts). Rows are checked in the view model the extension renders (`debug_ui_state`,
// `panel`) and in the real workbench DOM (scripts/ui.mjs). Row actions get a row handle `{ id }`, as
// VS Code passes it from an inline button or the context menu.
//
//   node scripts/dev-host.mjs --name ui-panel
//   node test/e2e/ui-panel.e2e.mjs --name ui-panel
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { startPageServer } from '../fixtures/ui-pages.mjs';
import { agent, assert, hostName, root, run, test, until } from './harness.mjs';

const exec = promisify(execFile);

async function dom(expression) {
  const { stdout } = await exec(process.execPath, [join(root, 'scripts', 'ui.mjs'), '--name', hostName, 'eval', `JSON.stringify(${expression})`]);
  return JSON.parse(stdout.trim());
}

/** The panel view in the workbench: row aria labels, their inline action titles, welcome text, the panel tab. */
const workbench = () =>
  dom(`(() => {
    const view = document.getElementById('workbench.view.extension.copaneTabs');
    const tab = [...document.querySelectorAll('.part.panel .composite-bar .action-label')].find(a => a.textContent.trim() === 'Agent Tabs' || a.getAttribute('aria-label')?.startsWith('Agent Tabs'));
    return {
      panelTab: !!tab,
      rows: view ? [...view.querySelectorAll('.monaco-list-row')].map(r => ({ aria: r.getAttribute('aria-label'), actions: [...r.querySelectorAll('.actions .action-label')].map(a => a.getAttribute('aria-label')) })) : null,
      welcome: view?.querySelector('.welcome-view-content')?.innerText ?? null,
    };
  })()`);

const run_ = Date.now();
const ALPHA = `panel-e2e-alpha-${run_}`;
const BETA = `panel-e2e-beta-${run_}`;
const TERM = `panel-e2e-term-${run_}`;
const pages = await startPageServer();
const user = await agent({ session: `panel-e2e-user-${run_}` });
const launcher = await agent({ session: `panel-e2e-launcher-${run_}` });
const state = async () => JSON.parse(await user.ok('debug_ui_state'));
const command = (name, ...args) => user.ok('debug_vscode_command', { command: name, args });
const panelRow = (s, tabId) => s.panel.rows.find(r => r.id === `tab:${tabId}`);
const handle = tabId => ({ id: `tab:${tabId}` });
const tabOf = text => /tab-\d+/.exec(text)?.[0];

let alpha, beta, alphaInfo, betaInfo;
const tabs = {};

test('the view sits in the panel and shows its welcome while no agent uses a tab', async () => {
  await command('copane.tabs.focus');
  const w = await until(async () => {
    const w = await workbench();
    return w.panelTab && w.rows && w;
  }, 'the Agent Tabs panel view');
  // Other suites may have left sessions behind on this host; only check the welcome when empty.
  if (w.rows.length === 0) assert.match(w.welcome, /No agent session is using a browser tab/);
});

test("each agent's tabs are listed in its color, sorted by session, with the title on the first row", async () => {
  alpha = await agent({ session: ALPHA });
  beta = await agent({ session: BETA });
  await alpha.ok('session_set_title', { title: 'panel alpha' });
  await beta.ok('session_set_title', { title: 'panel beta' });
  alphaInfo = JSON.parse(await alpha.ok('session_info')).you;
  betaInfo = JSON.parse(await beta.ok('session_info')).you;
  tabs.a1 = tabOf(await alpha.ok('browser_open', { url: pages.url('Panel Alpha One'), background: true }));
  tabs.b1 = tabOf(await beta.ok('browser_open', { url: pages.url('Panel Beta One'), background: true }));
  tabs.a2 = tabOf(await alpha.ok('browser_open', { url: pages.url('Panel Alpha Two'), background: true }));
  // A tab the user opens and no agent uses is not listed.
  await command('workbench.action.browser.open', pages.url('Panel User Own'));

  const s = await until(async () => {
    const s = await state();
    return [tabs.a1, tabs.a2, tabs.b1].every(t => panelRow(s, t)?.label?.startsWith('Panel')) && s;
  }, 'the three agent tab rows');
  const a1 = panelRow(s, tabs.a1);
  const a2 = panelRow(s, tabs.a2);
  const b1 = panelRow(s, tabs.b1);
  assert.equal(a1.label, 'Panel Alpha One');
  assert.match(a1.description, new RegExp(`^${alphaInfo.label} · panel alpha · controlling · 127\\.0\\.0\\.1:\\d+$`));
  assert.match(a2.description, new RegExp(`^${alphaInfo.label} · controlling · `), 'the title is on the first row of a session only');
  assert.match(b1.description, new RegExp(`^${betaInfo.label} · panel beta · controlling`));
  assert.deepEqual(a1.icon.id, 'circle-large-filled');
  assert.equal(a1.icon.color, a2.icon.color);
  assert.notEqual(a1.icon.color, b1.icon.color, 'two sessions, two colors');
  const order = s.panel.rows.map(r => r.id);
  assert.ok(order.indexOf(`tab:${tabs.a2}`) === order.indexOf(`tab:${tabs.a1}`) + 1, `alpha's tabs are next to each other: ${order.join(', ')}`);
  assert.ok(!s.panel.rows.some(r => r.label === 'Panel User Own'), "the user's own tab is not listed");

  const w = await until(async () => {
    const w = await workbench();
    return w.rows?.some(r => r.aria.startsWith(`Browser tab Panel Alpha One, ${alphaInfo.label} (panel alpha), controlling`)) && w;
  }, 'the rows in the workbench');
  const row = w.rows.find(r => r.aria.startsWith('Browser tab Panel Alpha One'));
  assert.deepEqual(row.actions, ['Show Agent Session', 'Pause Agents on Browser Tab', 'Release Browser Tab from Agent', 'Close Browser Tab']);
});

test('pausing from a row keeps the session color, swaps the inline action, and blocks the agent', async () => {
  await command('copane.ui.pauseTab', handle(tabs.a1));
  const s = await until(async () => {
    const s = await state();
    return panelRow(s, tabs.a1)?.icon.id === 'debug-pause' && s;
  }, 'the paused row');
  const row = panelRow(s, tabs.a1);
  assert.equal(row.icon.color, panelRow(s, tabs.a2).icon.color);
  assert.match(row.description, /paused by you/);
  await until(async () => (await workbench()).rows?.find(r => r.aria.includes('Panel Alpha One'))?.actions.includes('Resume Agents on Browser Tab'), 'the Resume action');
  const refused = await alpha.call('browser_evaluate', { tab: tabs.a1, function: 'document.title' });
  assert.ok(refused.isError && /paused/.test(refused.text), `the agent was not blocked: ${refused.text}`);

  await command('copane.ui.resumeTab', handle(tabs.a1));
  await until(async () => panelRow(await state(), tabs.a1)?.icon.id !== 'debug-pause', 'the row to resume');
});

test('releasing from a row turns it idle and removes the release action', async () => {
  await command('copane.ui.releaseTab', handle(tabs.b1));
  const s = await until(async () => {
    const s = await state();
    return panelRow(s, tabs.b1)?.description.includes(' · idle') && s;
  }, 'the idle row');
  assert.equal(panelRow(s, tabs.b1).icon.id, 'circle-large-outline');
  assert.doesNotMatch(panelRow(s, tabs.b1).contextValue, /\breleasable\b/);
});

test('clicking a row brings its tab to the front', async () => {
  await command('copane.ui.revealTab', tabs.a2);
  await until(async () => panelRow(await state(), tabs.a2) && (await dom(`document.querySelector('.editor-group-container.active .tab.active')?.getAttribute('aria-label') ?? ''`)).includes('Panel Alpha Two'), 'the tab in front');
});

test('"Show Agent Session" for an agent outside the terminals selects its row in the Sessions view', async () => {
  await command('copane.ui.showSession', handle(tabs.b1));
  const s = await until(async () => {
    const s = await state();
    return s.sessionsViewVisible && s.sessionsSelection.includes(`session:${BETA}`) && s;
  }, 'the selected session row');
  assert.ok(s);
  await command('copane.tabs.focus');
});

test('"Show Agent Session" for an agent running in a terminal of the window shows that terminal', async () => {
  const started = await launcher.ok('terminal_run', {
    command: `node ${JSON.stringify(join(root, 'test', 'fixtures', 'terminal-agent.mjs'))} --name ${hostName} --session ${TERM} --url ${JSON.stringify(pages.url('Panel Terminal Agent'))}`,
    timeout_seconds: 5,
  });
  const terminalId = /term-\d+/.exec(started)?.[0];
  assert.ok(terminalId, `no terminal id in: ${started}`);
  let output = started;
  if (!/ready tab-\d+/.test(output)) output += await launcher.ok('terminal_wait', { terminal: terminalId, for_text: 'ready tab-', timeout_seconds: 30 });
  tabs.t = /ready (tab-\d+)/.exec(output)?.[1];
  assert.ok(tabs.t, `the terminal agent did not open a tab: ${output}`);
  await until(async () => panelRow(await state(), tabs.t), 'the terminal agent row');

  // Make another terminal the active one, then ask for the session.
  await command('workbench.action.terminal.new');
  const before = (await state()).activeTerminal;
  await command('copane.ui.showSession', handle(tabs.t));
  const after = await until(async () => {
    const s = await state();
    return s.activeTerminal && s.activeTerminal.pid !== before?.pid && s.activeTerminal;
  }, 'another terminal to become active');
  if (process.platform !== 'win32') {
    const pids = (await exec('ps', ['-A', '-o', 'pid=,ppid=,command='])).stdout;
    const agentLine = pids.split('\n').find(l => l.includes('terminal-agent.mjs') && l.includes(TERM));
    assert.ok(agentLine, 'the terminal agent process');
    const [, ppid] = agentLine.trim().split(/\s+/).map(Number);
    assert.equal(after.pid, ppid, 'the terminal shown is the one whose shell runs the agent');
  }

  await launcher.ok('terminal_send', { terminal: terminalId, keys: ['Ctrl+C'] });
  await command('copane.ui.closeTab', tabs.t);
});

test('closing a tab from its row removes the row; ending sessions empties the view', async () => {
  await command('copane.ui.closeTab', handle(tabs.a2));
  await until(async () => !panelRow(await state(), tabs.a2), 'the closed row to disappear');

  await user.ok('debug_answer_prompts', { answers: ['End and Close Its Tabs', 'End and Close Its Tabs'], clear: true });
  await command('copane.ui.endSession', ALPHA);
  await command('copane.ui.endSession', BETA);
  const s = await until(async () => {
    const s = await state();
    return !s.panel.rows.some(r => [tabs.a1, tabs.b1].includes(r.ref.tabId)) && s;
  }, 'the ended sessions to leave the view');
  assert.ok(!s.panel.rows.some(r => r.label?.startsWith('Panel Alpha') || r.label?.startsWith('Panel Beta')));
  if (s.panel.rows.length === 0) {
    await command('copane.tabs.focus'); // the terminal case left the Terminal panel in front
    await until(async () => (await workbench()).welcome?.includes('No agent session is using a browser tab'), 'the welcome content');
  }
});

try {
  await run();
} finally {
  await Promise.allSettled([alpha?.close(), beta?.close(), launcher.close(), user.close()]);
  await pages.close();
}
