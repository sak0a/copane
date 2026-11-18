// Collapsing an agent session's browser tabs in the editor tab bar (ui/tabGrouping.ts), against a
// running dev host. Agents "alpha" and "beta" open tabs with a click counter; "user" stands in for the
// person at the window (runs commands through debug_vscode_command, pins tabs, answers prompts). The
// tab bar is read from `vscode.window.tabGroups` (labels and isPinned), the planner's view from
// `debug_ui_state.tabGroups`, the width of a collapsed tab from the workbench DOM (scripts/ui.mjs).
//
//   node scripts/dev-host.mjs --name ui-tab-groups
//   node test/e2e/ui-tab-groups.e2e.mjs --name ui-tab-groups
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { startCounterServer } from '../fixtures/ui-tab-groups.mjs';
import { agent, assert, hostDir, hostName, root, run, sleep, test, until } from './harness.mjs';

const exec = promisify(execFile);

// Tools renamed on another branch are called through these helpers only.
const closeTab = (a, tab) => a.ok('browser_tab', { action: 'close', tab });

const RUN = Date.now().toString(36).slice(-4);
const ALPHA = `tg-e2e-alpha-${RUN}`;
const BETA = `tg-e2e-beta-${RUN}`;
const pages = await startCounterServer();
const user = await agent({ session: `tg-e2e-user-${RUN}` });
let alpha = await agent({ session: ALPHA });
let beta = await agent({ session: BETA });
/** Tab ids by short name ("A1"). */
const t = {};
const title = name => `${name} ${RUN}`;

const command = async (name, ...args) => {
  const text = await user.ok('debug_vscode_command', { command: name, args });
  return text === 'ok' ? undefined : JSON.parse(text);
};
const extEval = async code => JSON.parse(await user.ok('debug_extension_eval', { code }));
const uiState = async () => JSON.parse(await user.ok('debug_ui_state'));
const prompts = async (answers = []) => JSON.parse(await user.ok('debug_answer_prompts', answers.length ? { answers, clear: true } : {}));
const tabOf = text => /tab-\d+/.exec(text)?.[0];

/** This run's tabs in the editor tab bar by short name, "A1*" when pinned; groups joined by " | ". */
async function strip() {
  const groups = await extEval(`return vscode.window.tabGroups.all.map(g => g.tabs.map(t => ({ label: t.label, pinned: t.isPinned })))`);
  return groups
    .map(g => g.filter(x => x.label.endsWith(` ${RUN}`)).map(x => x.label.slice(0, -RUN.length - 1) + (x.pinned ? '*' : '')).join(' '))
    .filter(Boolean)
    .join(' | ');
}

async function untilStrip(expected) {
  try {
    await until(async () => (await strip()) === expected, `the tab bar "${expected}"`);
  } catch (err) {
    throw new Error(`${err.message}; it is "${await strip()}"`);
  }
}

/** Pinned names first in their present order, then the others in theirs: how the tab bar looks after pinning `names`. */
function pinnedFirst(order, names, mark = '*') {
  const list = order.split(' ').map(n => n.replace('*', ''));
  return [...list.filter(n => names.includes(n)).map(n => n + mark), ...list.filter(n => !names.includes(n))].join(' ');
}

async function open(a, name) {
  t[name] = tabOf(await a.ok('browser_open', { url: pages.url(title(name)), background: true }));
  assert.ok(t[name], `no tab id for ${name}`);
  await until(async () => (await strip()).split(/[ |]+/).some(n => n.replace('*', '') === name), `${name} in the tab bar`);
}

const groupTab = async name => (await uiState()).tabGroups.tabs.find(x => x.tabId === t[name]);
const viewId = name => until(async () => (await groupTab(name))?.viewId, `the view id of ${name}`);

/** Pins or unpins a tab as the user does: the editor's pin command on that tab. */
async function userPin(name, pin) {
  const v = await viewId(name);
  await extEval(`await vscode.commands.executeCommand('workbench.action.${pin ? 'pinEditor' : 'unpinEditor'}', vscode.Uri.from({ scheme: 'vscode-browser', path: '/${v}' })); return null;`);
}

const count = async (a, name) => (await a.ok('browser_evaluate', { tab: t[name], function: "Number(document.querySelector('#count').textContent)" })).trim();
const click = (a, name) => a.ok('browser_click', { tab: t[name], selector: '#count' });

const settingsFile = join(hostDir, 'ud', 'User', 'settings.json');
const settings = () => JSON.parse(readFileSync(settingsFile, 'utf8'));
const setSizing = (pinned, copane) =>
  extEval(
    `await vscode.workspace.getConfiguration('workbench.editor').update('pinnedTabSizing', ${JSON.stringify(pinned)}, vscode.ConfigurationTarget.Global);` +
      `await vscode.workspace.getConfiguration('copane.ui').update('collapsedTabSizing', ${JSON.stringify(copane)}, vscode.ConfigurationTarget.Global); return null;`,
  );

async function dom(expression) {
  const { stdout } = await exec(process.execPath, [join(root, 'scripts', 'ui.mjs'), '--name', hostName, 'eval', `JSON.stringify(${expression})`]);
  return JSON.parse(stdout.trim());
}

/** Waits until the description of a session's row in the Sessions view passes `ok`. */
const untilRow = (key, ok, what) => until(async () => ok(sessionRow(await uiState(), key)?.description ?? ''), what);
const sessionRow = (s, key) => s.rows.find(r => r.id === `session:${key}` || r.id === `session:${key}#empty`);
/** The tab bar before alpha was collapsed the first time, without pins. */
let base;

test('setup: two sessions, each with two tabs, interleaved', async () => {
  await setSizing(undefined, undefined);
  await open(alpha, 'A1');
  await open(beta, 'B1');
  await open(alpha, 'A2');
  await open(beta, 'B2');
  base = await strip();
  assert.doesNotMatch(base, /\*/);
  for (let i = 0; i < 3; i++) await click(alpha, 'A1');
  assert.equal(await count(alpha, 'A1'), '3');
});

test('collapsing asks about compact pinned tabs; "Keep" changes only the Copane setting and says why nothing shrinks', async () => {
  const before = settings();
  await prompts(['Keep Current Size']);
  const message = await command('copane.ui.collapseSessionTabs', ALPHA);
  assert.match(message, /2 tabs collapsed into pinned tabs/);
  assert.match(message, /full size/, 'the message says pinned tabs take as much room as before');
  const shown = (await prompts()).shown.at(-1);
  assert.match(shown.message, /compact/);
  assert.deepEqual(shown.choices, ['Use Compact Pinned Tabs', 'Keep Current Size']);
  assert.equal(shown.answer, 'Keep Current Size');
  assert.deepEqual(settings(), { ...before, 'copane.ui.collapsedTabSizing': 'keep' });

  await untilStrip(pinnedFirst(base, ['A1', 'A2']));
  const s = await until(async () => {
    const s = await uiState();
    return /2 tabs collapsed/.test(sessionRow(s, ALPHA)?.description ?? '') && s;
  }, 'the session row to say so');
  assert.deepEqual(s.tabGroups.collapsed, [ALPHA]);
  assert.equal(s.tabGroups.pinnedByUs.length, 2);
  assert.match(sessionRow(s, ALPHA).contextValue, /\bcollapsed\b/);
  assert.match(sessionRow(s, BETA).contextValue, /\bcollapsible\b/);

  // "keep" is remembered: no question the next time.
  const asked = (await prompts()).shown.length;
  await command('copane.ui.expandSessionTabs', ALPHA);
  await untilStrip(pinnedFirst(base, ['A1', 'A2'], ''));
  await command('copane.ui.collapseSessionTabs', ALPHA);
  assert.equal((await prompts()).shown.length, asked);
  await command('copane.ui.expandSessionTabs', ALPHA);
  await untilStrip(pinnedFirst(base, ['A1', 'A2'], ''));
  await untilRow(ALPHA, d => !/collapsed/.test(d), 'the row to stop saying collapsed');
});

test('"Use Compact" sets only workbench.editor.pinnedTabSizing (and the Copane setting); collapsed tabs are 28 px', async () => {
  await setSizing(undefined, undefined);
  const before = settings();
  await prompts(['Use Compact Pinned Tabs']);
  const message = await command('copane.ui.collapseSessionTabs', ALPHA);
  assert.doesNotMatch(message, /full size|no different/);
  assert.deepEqual(settings(), { ...before, 'workbench.editor.pinnedTabSizing': 'compact', 'copane.ui.collapsedTabSizing': 'compact' });
  base = pinnedFirst(base, ['A1', 'A2'], '');
  await untilStrip(pinnedFirst(base, ['A1', 'A2']));
  const widths = await until(async () => {
    const w = await dom(`[...document.querySelectorAll('.tabs-container .tab.sticky-compact')].filter(e => (e.getAttribute('aria-label') ?? '').includes(' ${RUN}')).map(e => Math.round(e.getBoundingClientRect().width))`);
    return w.length === 2 && w;
  }, 'two compact pinned tabs');
  assert.ok(widths.every(w => w <= 40), `compact tabs are narrow: ${widths}`);
});

test('the page survives collapsing and expanding; click, snapshot and evaluate work on a collapsed tab', async () => {
  assert.equal(await count(alpha, 'A1'), '3', 'the page was not reloaded by pinning');
  await click(alpha, 'A1');
  assert.equal(await count(alpha, 'A1'), '4');
  const snap = await alpha.ok('browser_snapshot', { tab: t.A1 });
  assert.match(snap, /button/);
  await command('copane.ui.expandSessionTabs', ALPHA);
  await untilStrip(base);
  assert.equal(await count(alpha, 'A1'), '4', 'the page was not reloaded by unpinning');
  await command('copane.ui.collapseSessionTabs', ALPHA);
  await untilStrip(pinnedFirst(base, ['A1', 'A2']));
});

test("a new tab of a collapsed session is pinned into its run; closing a collapsed tab works", async () => {
  await open(alpha, 'A3');
  await until(async () => (await strip()).startsWith('A1* A2* A3* '), "A3 pinned at the end of alpha's run");
  await until(async () => /3 tabs collapsed/.test(sessionRow(await uiState(), ALPHA)?.description ?? ''), 'three tabs collapsed');
  await closeTab(alpha, t.A3);
  await untilStrip(pinnedFirst(base, ['A1', 'A2']));
  await until(async () => (await uiState()).tabGroups.pinnedByUs.length === 2, 'the closed tab to be forgotten');
  await untilRow(ALPHA, d => /2 tabs collapsed/.test(d), 'two tabs collapsed');
});

test('a tab the user unpins leaves the collapsed run and is not pinned again', async () => {
  await userPin('A2', false);
  await sleep(1000); // a reconcile ran meanwhile
  const now = await strip();
  assert.match(now, /^A1\* /);
  assert.ok(!now.includes('A2*'), `A2 stayed unpinned: ${now}`);
  await untilRow(ALPHA, d => /1 tab collapsed/.test(d), 'one tab collapsed');
  assert.equal((await uiState()).tabGroups.optedOut.length, 1);
  // Collapsing again takes all of its tabs.
  await command('copane.ui.collapseSessionTabs', ALPHA);
  await until(async () => /A1\* A2\*/.test(await strip()), 'A2 back in the run');
  base = (await strip()).replace(/\*/g, '');
});

test('expanding never unpins a tab the user pinned', async () => {
  await command('copane.ui.expandSessionTabs', ALPHA);
  await until(async () => !(await strip()).includes('*'), 'nothing pinned');
  await userPin('B1', true);
  await until(async () => (await strip()).includes('B1*'), 'B1 pinned by the user');
  await command('copane.ui.collapseSessionTabs', BETA);
  await until(async () => (await strip()).includes('B2*'), 'B2 collapsed');
  assert.match(await strip(), /^B1\* B2\* /);
  await untilRow(BETA, d => /1 tab collapsed/.test(d), 'one tab of beta collapsed');
  assert.deepEqual((await uiState()).tabGroups.pinnedByUs, [t.B2], "only B2 is Copane's");
  await command('copane.ui.expandSessionTabs', BETA);
  await until(async () => !(await strip()).includes('B2*'), 'B2 expanded');
  assert.match(await strip(), /^B1\* /, 'the user pin stays');
  await userPin('B1', false);
  await until(async () => !(await strip()).includes('*'), 'nothing pinned');
});

test("from the editor tab's context menu (its resource): collapse, show only this session, expand all", async () => {
  const uri = async name => `vscode.Uri.from({ scheme: 'vscode-browser', path: '/${await viewId(name)}' })`;
  // What the menu's when clauses read: the tab's view id is in copane.ui.collapsibleTabs, then in collapsedTabs.
  const b2 = await viewId('B2');
  assert.ok((await uiState()).tabGroups.contextKeys.collapsibleTabs.includes(b2));
  await extEval(`return await vscode.commands.executeCommand('copane.ui.collapseSessionTabs', ${await uri('B2')});`);
  await until(async () => /B1\* B2\*|B2\* B1\*/.test(await strip()), "beta's tabs collapsed");
  await until(async () => (await uiState()).tabGroups.contextKeys.collapsedTabs.includes(b2), 'the tab listed as collapsed for its menu');
  await extEval(`return await vscode.commands.executeCommand('copane.ui.collapseOtherSessions', ${await uri('A1')});`);
  const s = await until(async () => {
    const s = await uiState();
    return s.tabGroups.collapsed.length === 1 && s.tabGroups.collapsed[0] === BETA && !(await strip()).match(/A\d\*/) && s;
  }, 'only alpha expanded');
  assert.ok(s);
  await command('copane.ui.collapseOtherSessions', BETA);
  await until(async () => {
    const st = await strip();
    return /A1\*/.test(st) && /A2\*/.test(st) && !/B\d\*/.test(st);
  }, 'only beta expanded');
  await command('copane.ui.expandAllSessions');
  await until(async () => !(await strip()).includes('*'), 'everything expanded');
  assert.deepEqual((await uiState()).tabGroups.collapsed, []);
});

test("group by session puts each session's tabs side by side, nothing pinned", async () => {
  await command('copane.ui.groupTabsBySession');
  const now = await strip();
  assert.doesNotMatch(now, /\*/);
  assert.match(now, /A1 A2|A2 A1/);
  assert.match(now, /B1 B2|B2 B1/);
  base = now;
});

test('a tab an agent hands to the user is lifted out of the collapsed run while it waits', async () => {
  await command('copane.ui.collapseSessionTabs', ALPHA);
  await untilStrip(pinnedFirst(base, ['A1', 'A2']));
  const handoff = alpha.call('browser_request_user_input', { tab: t.A2, message: 'Check the counter, then click Done.', timeout_seconds: 60 }, { timeoutMs: 90_000 });
  await until(async () => {
    const st = await strip();
    return st.includes('A1*') && !st.includes('A2*');
  }, 'A2 lifted out');
  const s = await uiState();
  assert.ok(s.attention.some(a => a.targetId === t.A2), 'the views list it as waiting');
  await command('copane.ui.finishTabRequest', t.A2);
  const result = await handoff;
  assert.ok(!result.isError, result.text);
  await until(async () => /A1\* A2\*/.test(await strip()), 'A2 back in the run');
});

test('collapsing a session with no tab to pin is saved for a reload too', async () => {
  const USER = `tg-e2e-user-${RUN}`;
  const saved = () => extEval(`return services.context.workspaceState.get('copane.ui.tabGroups')?.collapsed ?? []`);
  await command('copane.ui.collapseSessionTabs', USER);
  await until(async () => (await saved()).includes(USER), 'the collapsed flag of a session without tabs to be saved');
  await command('copane.ui.expandSessionTabs', USER);
  await until(async () => !(await saved()).includes(USER), 'expanding it to be saved');
  assert.deepEqual((await uiState()).tabGroups.collapsed, [ALPHA]);
});

test('after a window reload the collapsed session is collapsed again and the other one is not', async () => {
  const pinnedBefore = (await uiState()).tabGroups.pinnedByUs.slice().sort();
  await sleep(800);
  await user.call('debug_vscode_command', { command: 'workbench.action.reloadWindow' }, { timeoutMs: 5000 }).catch(() => {});
  await Promise.allSettled([alpha.close(), beta.close()]);
  // Back as the same sessions, once the reloaded window answers.
  const reconnect = key =>
    until(
      async () => {
        const a = await agent({ session: key }).catch(() => undefined);
        if (!a) return undefined;
        const r = await a.call('browser_list_tabs').catch(() => ({ isError: true }));
        if (r.isError || !r.text.includes(title('A1'))) {
          await a.close().catch(() => {});
          return undefined;
        }
        return a;
      },
      'the reloaded window',
      { timeoutMs: 60_000, intervalMs: 1000 },
    );
  alpha = await reconnect(ALPHA);
  beta = await reconnect(BETA);
  const s = await until(
    async () => {
      const s = JSON.parse(await alpha.ok('debug_ui_state'));
      const st = await (async () => {
        const groups = JSON.parse(await alpha.ok('debug_extension_eval', { code: `return vscode.window.tabGroups.all.map(g => g.tabs.map(t => ({ label: t.label, pinned: t.isPinned })))` }));
        return groups.flat().filter(x => x.label.endsWith(` ${RUN}`));
      })();
      const pinned = st.filter(x => x.pinned).map(x => x.label.slice(0, 2)).sort().join(' ');
      return pinned === 'A1 A2' && s;
    },
    "alpha's tabs pinned again and beta's not",
    { timeoutMs: 30_000, intervalMs: 500 },
  );
  assert.deepEqual(s.tabGroups.collapsed, [ALPHA]);
  assert.deepEqual(s.tabGroups.pinnedByUs.slice().sort(), pinnedBefore);
  assert.deepEqual(JSON.parse(await alpha.ok('debug_ui_state')).tabGroups.tabs.filter(x => x.pinnedByUs).map(x => x.tabId).sort(), [t.A1, t.A2].sort(), 'the same tab ids');
});

test('when the session ends, the tabs Copane pinned for it are unpinned', async () => {
  // `user` was closed by the reload; act through alpha's connection.
  const u = await agent({ session: `tg-e2e-user2-${RUN}` });
  try {
    await u.ok('debug_answer_prompts', { answers: ['End Session'], clear: true });
    await u.ok('debug_vscode_command', { command: 'copane.ui.endSession', args: [ALPHA] });
    await until(async () => {
      const groups = JSON.parse(await u.ok('debug_extension_eval', { code: `return vscode.window.tabGroups.all.flatMap(g => g.tabs.filter(t => t.label.endsWith(' ${RUN}') && t.isPinned).map(t => t.label))` }));
      return groups.length === 0;
    }, 'no tab of this run pinned');
    const s = JSON.parse(await u.ok('debug_ui_state'));
    assert.deepEqual(s.tabGroups.collapsed, []);
    assert.deepEqual(s.tabGroups.pinnedByUs, []);
    // Clean up this run's tabs and the sizing setting.
    for (const name of Object.keys(t)) await u.call('debug_vscode_command', { command: 'copane.ui.closeTab', args: [t[name]] });
    await u.ok('debug_extension_eval', {
      code: `await vscode.workspace.getConfiguration('workbench.editor').update('pinnedTabSizing', undefined, vscode.ConfigurationTarget.Global); await vscode.workspace.getConfiguration('copane.ui').update('collapsedTabSizing', undefined, vscode.ConfigurationTarget.Global); return null;`,
    });
  } finally {
    await u.close();
  }
});

try {
  await run();
} finally {
  await Promise.allSettled([alpha?.close(), beta?.close(), user.close()]);
  await pages.close();
}
