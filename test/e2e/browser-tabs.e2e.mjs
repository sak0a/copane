// Browser tabs: consent, leases, pause/resume, attribution, closing, the page indicator, the editor tab
// badge and reveal, against a running dev host:
//
//   rm -rf /tmp/agent-bridge-dev/browser-tabs && node scripts/dev-host.mjs --name browser-tabs
//   node test/e2e/browser-tabs.e2e.mjs --name browser-tabs [--only <text>]
//
// "The user" is played by `debug_vscode_command` (opening tabs, running commands), `debug_answer_prompts`
// (answering consent prompts), the dev host's settings.json, and the dev host's own DevTools port for
// looking into pages and clicking there (test/fixtures/browser-tabs/pages.mjs).
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openPage } from '../fixtures/browser-tabs/pages.mjs';
import { startFixtureServer } from '../fixtures/browser-tabs/server.mjs';
import { agent, assert, hostDir, hostName, root, run, sleep, test, until } from './harness.mjs';

const server = await startFixtureServer();
let caseNumber = 0;
/** A URL no other case uses, so tabs and page targets are easy to tell apart. */
const fresh = (path = '/plain') => `${server.url(path)}${path.includes('?') ? '&' : '?'}case=${Date.now()}-${++caseNumber}`;

const settingsFile = join(hostDir, 'ud', 'User', 'settings.json');
const baseSettings = JSON.parse(readFileSync(settingsFile, 'utf8'));
async function setSettings(values) {
  writeFileSync(settingsFile, JSON.stringify({ ...baseSettings, ...values }, null, 2));
  await sleep(1500); // VS Code picks up the file change asynchronously.
}

/** Parses browser_list_tabs into { id, url, notes, current }. */
async function tabs(a) {
  const text = await a.ok('browser_list_tabs');
  return text
    .split('\n')
    .filter(l => /^[* ] tab-\d+/.test(l))
    .map(l => {
      const m = l.match(/^([* ]) (tab-\d+)\s+(\S+)\s+".*"\s+\((.*)\)$/);
      return { current: m[1] === '*', id: m[2], url: m[3], notes: m[4] };
    });
}

async function tabByUrl(a, url) {
  return until(async () => (await tabs(a)).find(t => t.url === url), `a tab for ${url}`);
}

/** Opens a tab as the user would (title-bar globe / command palette). Returns its tab id. */
async function userOpens(a, url) {
  await a.ok('debug_vscode_command', { command: 'workbench.action.browser.open', args: [url] });
  const tab = await tabByUrl(a, url);
  assert.match(tab.notes, /opened by the user/);
  return tab.id;
}

async function prompts(a, answers, clear = true) {
  return JSON.parse(await a.ok('debug_answer_prompts', { answers, clear }));
}

async function label(a) {
  return JSON.parse(await a.ok('session_info')).you.label;
}

/** The editor tabs of the workbench: label, whether it has a decoration badge, and its badge class. */
function editorTabs() {
  const out = execFileSync(process.execPath, [join(root, 'scripts', 'ui.mjs'), '--name', hostName, 'eval',
    "JSON.stringify([...document.querySelectorAll('.tabs-container .tab')].map(t => { const l = t.querySelector('.monaco-icon-label'); return { label: t.querySelector('.label-name')?.textContent, badge: !!l && l.classList.contains('monaco-decoration-badge'), active: t.classList.contains('active') }; }))"],
    { encoding: 'utf8' });
  return JSON.parse(out);
}

const evaluate = (a, tab, expression) => a.call('browser_evaluate', { tab, function: expression });

// ---------------------------------------------------------------------------------------------------

test('an agent tab shows the indicator and editor badge while controlled; release removes both', async () => {
  const a = await agent({ session: 'bt-mark' });
  const title = `Marked ${Date.now()}`;
  const url = fresh(`/titled?t=${encodeURIComponent(title)}`);
  try {
    await a.ok('session_set_title', { title: 'marking check' });
    const me = await label(a);
    const opened = await a.ok('browser_open', { url });
    assert.match(opened, /opened by you, controlled by you/);
    const page = await openPage(hostDir, url);
    try {
      const shown = await until(async () => {
        const i = await page.indicator();
        return i.count === 1 && i.text.includes(`${me} · marking check`) ? i : undefined;
      }, 'the indicator with the session label');
      assert.match(shown.text, /Take over/);
      await until(() => editorTabs().find(t => t.label === title)?.badge, 'a badge on the editor tab');

      // Navigation and reload: the indicator comes back in the new document.
      await evaluate(a, undefined, `location.href = ${JSON.stringify(url + '&nav=1')}; 1`);
      page.close();
      const page2 = await until(() => openPage(hostDir, url + '&nav=1').catch(() => undefined), 'the navigated page');
      await until(async () => (await page2.indicator()).count === 1, 'the indicator after navigation');
      await page2.send('Page.reload');
      await sleep(500);
      await until(async () => (await page2.indicator()).count === 1, 'the indicator after reload');

      const released = await a.ok('browser_release_tab');
      assert.match(released, /Released tab-\d+/);
      await until(async () => (await page2.indicator()).count === 0, 'the indicator to go away on release');
      // The editor tab still says who used it.
      assert.ok(editorTabs().find(t => t.label === title)?.badge);
      page2.close();
    } finally {
      page.close();
    }
  } finally {
    await a.close();
  }
});

test('the indicator is isolated from a hostile page (CSP, Trusted Types, removal, name clash)', async () => {
  const a = await agent({ session: 'bt-hostile' });
  const url = fresh('/hostile');
  try {
    await a.ok('browser_open', { url });
    const page = await openPage(hostDir, url);
    try {
      await until(async () => (await page.indicator()).count === 1, 'the indicator on a hostile page');
      await sleep(500);
      const i = await page.indicator();
      assert.equal(i.count, 1, 'the page removed the indicator for good');
      assert.match(i.text, /Take over/);
      // The page's own global of the same name is untouched: the indicator lives in another world.
      assert.equal(await page.evaluate('window.__agentBridgeMarker'), 'page');
      assert.equal(await page.evaluate('typeof window.__agentBridgeUi'), 'undefined');
    } finally {
      page.close();
    }
  } finally {
    await a.close();
  }
});

test('consent: Allow lets the session use the user tab and is not asked again', async () => {
  const a = await agent({ session: 'bt-allow' });
  try {
    const url = fresh();
    const id = await userOpens(a, url);
    const before = (await prompts(a, ['Allow'])).shown.length;
    const selected = await a.ok('browser_select_tab', { tab: id });
    assert.match(selected, new RegExp(`${id} is now your current tab`));
    const after = await prompts(a, [], false);
    assert.equal(after.shown.length, before + 1);
    assert.match(after.shown.at(-1).message, /wants to use your browser tab/);
    assert.deepEqual(after.shown.at(-1).choices.slice(0, 2), ['Allow', `Allow on ${server.host}`]);
    // Control works, and no second prompt.
    assert.equal((await evaluate(a, id, '1 + 1')).text, '2');
    assert.equal((await prompts(a, [], false)).shown.length, before + 1);
    assert.match((await tabs(a)).find(t => t.id === id).notes, /shared with you, controlled by you/);
  } finally {
    await a.close();
  }
});

test('consent: Deny is remembered, never asked twice, and the error says not to retry', async () => {
  const a = await agent({ session: 'bt-deny' });
  try {
    const id = await userOpens(a, fresh());
    const before = (await prompts(a, ['Deny'])).shown.length;
    const first = await evaluate(a, id, '1');
    assert.ok(first.isError);
    assert.match(first.text, /declined.*Do not ask again/s);
    const second = await a.call('browser_select_tab', { tab: id });
    assert.ok(second.isError);
    assert.match(second.text, /declined/);
    assert.equal((await prompts(a, [], false)).shown.length, before + 1, 'asked more than once');
    // The user shares it after all, from the command palette.
    await a.ok('debug_vscode_command', { command: 'agentBridge.browser.shareTab', args: [id, 'bt-deny'] });
    assert.equal((await evaluate(a, id, '2')).text, '2');
  } finally {
    await a.close();
  }
});

test('consent: a dismissed prompt cools down; "Allow on site" covers other tabs of that site', async () => {
  const a = await agent({ session: 'bt-site' });
  try {
    const first = await userOpens(a, fresh());
    await prompts(a, [null]);
    const dismissed = await a.call('browser_select_tab', { tab: first });
    assert.ok(dismissed.isError);
    assert.match(dismissed.text, /closed the request .* without answering/);
    const again = await a.call('browser_select_tab', { tab: first });
    assert.match(again.text, /without answering/, 'asked again during the cool-down');

    const second = await userOpens(a, fresh());
    const before = (await prompts(a, [`Allow on ${server.host}`])).shown.length;
    await a.ok('browser_select_tab', { tab: second });
    const third = await userOpens(a, fresh());
    await a.ok('browser_select_tab', { tab: third });
    assert.equal((await prompts(a, [], false)).shown.length, before + 1, 'the site answer did not cover the third tab');
  } finally {
    await a.close();
  }
});

test('consent: two calls waiting on the same question share one prompt', async () => {
  const a = await agent({ session: 'bt-stack' });
  try {
    const id = await userOpens(a, fresh());
    await prompts(a, [], true);
    // No queued answer: a real notification shows and stays open while both calls wait on it.
    const calls = [a.call('browser_select_tab', { tab: id }, { timeoutMs: 60_000 }), evaluate(a, id, '6')];
    await sleep(1500);
    const shown = JSON.parse(
      execFileSync(process.execPath, [join(root, 'scripts', 'ui.mjs'), '--name', hostName, 'eval', "JSON.stringify([...document.querySelectorAll('.notification-list-item-message')].map(e => e.textContent))"], { encoding: 'utf8' }),
    );
    assert.equal(shown.filter(n => n.includes('wants to use your browser tab')).length, 1, `notifications: ${shown.join(' | ')}`);
    // The user shares the tab from the command palette instead of answering: both calls go ahead.
    await a.ok('debug_vscode_command', { command: 'agentBridge.browser.shareTab', args: [id, 'bt-stack'] });
    const [selected, evaluated] = await Promise.all(calls);
    assert.ok(!selected.isError, selected.text);
    assert.equal(evaluated.text, '6');
  } finally {
    await a.ok('debug_vscode_command', { command: 'notifications.clearAll' }).catch(() => {});
    await a.close();
  }
});

test('setting agentBridge.browser.userTabs: deny refuses without asking, allow needs no prompt', async () => {
  const a = await agent({ session: 'bt-setting' });
  try {
    const id = await userOpens(a, fresh());
    const before = (await prompts(a, [], true)).shown.length;
    await setSettings({ 'agentBridge.browser.userTabs': 'deny' });
    const denied = await evaluate(a, id, '1');
    assert.ok(denied.isError);
    assert.match(denied.text, /userTabs = "deny"/);
    await setSettings({ 'agentBridge.browser.userTabs': 'allow' });
    assert.equal((await evaluate(a, id, '3')).text, '3');
    assert.equal((await prompts(a, [], false)).shown.length, before, 'a prompt was shown');
  } finally {
    await setSettings({});
    await a.close();
  }
});

test('two sessions: the lease makes the second one busy until release; reads still work', async () => {
  const a = await agent({ session: 'bt-lease-a' });
  const b = await agent({ session: 'bt-lease-b' });
  try {
    const labelA = await label(a);
    const labelB = await label(b);
    const url = fresh();
    await a.ok('browser_open', { url });
    const id = (await tabByUrl(b, url)).id;
    const busy = await evaluate(b, id, '1');
    assert.ok(busy.isError);
    assert.match(busy.text, new RegExp(`${id} is being controlled by ${labelA}.*You can still read it`, 's'));
    // Another live session's tab is readable without asking anyone.
    const selected = await b.ok('browser_select_tab', { tab: id });
    assert.match(selected, new RegExp(`${labelA} controls it right now`));
    const closing = await b.call('browser_close_tab', { tab: id });
    assert.ok(closing.isError);
    assert.match(closing.text, /belongs to/);

    await a.ok('browser_release_tab', { tab: id });
    assert.equal((await evaluate(b, id, '5')).text, '5');
    const page = await openPage(hostDir, url);
    try {
      await until(async () => (await page.indicator()).text.includes(labelB), 'the indicator to show the second session');
    } finally {
      page.close();
    }
    const busyA = await evaluate(a, id, '1');
    assert.match(busyA.text, new RegExp(`controlled by ${labelB}`));
  } finally {
    await a.close();
    await b.close();
  }
});

test('an idle lease can be taken over after agentBridge.browser.leaseIdleSeconds', async () => {
  const a = await agent({ session: 'bt-idle-a' });
  const b = await agent({ session: 'bt-idle-b' });
  try {
    await setSettings({ 'agentBridge.browser.leaseIdleSeconds': 5 });
    const url = fresh();
    await a.ok('browser_open', { url });
    const id = (await tabByUrl(b, url)).id;
    assert.ok((await evaluate(b, id, '1')).isError);
    await sleep(5500);
    assert.equal((await evaluate(b, id, '7')).text, '7');
  } finally {
    await setSettings({});
    await a.close();
    await b.close();
  }
});

test('pause from the page indicator refuses agents until the user resumes', async () => {
  const a = await agent({ session: 'bt-pause' });
  const url = fresh();
  try {
    await a.ok('browser_open', { url });
    const id = (await tabByUrl(a, url)).id;
    const page = await openPage(hostDir, url);
    try {
      const shown = await until(async () => {
        const i = await page.indicator();
        return i.buttonCenter && i.text.includes('Take over') ? i : undefined;
      }, 'the Take over button');
      await page.click(shown.buttonCenter.x, shown.buttonCenter.y);
      await until(async () => (await tabs(a)).find(t => t.id === id)?.notes.includes('PAUSED'), 'the tab to be paused');
      const refused = await evaluate(a, id, '1');
      assert.ok(refused.isError);
      assert.match(refused.text, /paused agent access.*Do not retry in a loop/s);
      assert.ok((await a.call('browser_select_tab', { tab: id })).isError, 'reads must be refused while paused');
      // The page click did not reach the page's own button underneath.
      assert.equal(await page.evaluate("document.getElementById('clicks').textContent"), '0');

      const paused = await until(async () => {
        const i = await page.indicator();
        return i.text.includes('Resume') ? i : undefined;
      }, 'the Resume button');
      await page.click(paused.buttonCenter.x, paused.buttonCenter.y);
      await until(async () => !(await evaluate(a, id, '1')).isError, 'the agent to get the tab back');

      // The same through the command (Sessions view, editor title bar, palette).
      await a.ok('debug_vscode_command', { command: 'agentBridge.browser.pauseTab', args: [id] });
      assert.ok((await evaluate(a, id, '1')).isError);
      await a.ok('debug_vscode_command', { command: 'agentBridge.browser.resumeTab', args: [id] });
      assert.equal((await evaluate(a, id, '4')).text, '4');
    } finally {
      page.close();
    }
  } finally {
    await a.close();
  }
});

test('attribution: agent tabs, user tabs and popups of a controlled page', async () => {
  const a = await agent({ session: 'bt-attr' });
  const b = await agent({ session: 'bt-attr-b' });
  try {
    const labelA = await label(a);
    const openerUrl = fresh('/opener');
    await a.ok('browser_open', { url: openerUrl });
    const opener = (await tabByUrl(a, openerUrl)).id;
    assert.match((await tabByUrl(b, openerUrl)).notes, new RegExp(`opened by ${labelA}`));

    await until(async () => (await evaluate(a, opener, "!!document.getElementById('blank')")).text === 'true', 'the opener page to load');
    await evaluate(a, opener, "document.getElementById('blank').click(); 1");
    const link = await until(async () => (await tabs(a)).find(t => t.url.endsWith('/popup')), 'the target=_blank tab');
    assert.match(link.notes, new RegExp(`opened by you from ${opener}, controlled by you`));
    await evaluate(a, opener, "window.open('/popup?script'); 1");
    const scripted = await until(async () => (await tabs(a)).find(t => t.url.endsWith('/popup?script')), 'the window.open tab');
    assert.match(scripted.notes, new RegExp(`opened by you from ${opener}`));
    // The opener stays the current tab.
    assert.ok((await tabs(a)).find(t => t.id === opener).current);

    const userUrl = fresh();
    await userOpens(a, userUrl);
    for (const t of [link, scripted]) await a.ok('browser_close_tab', { tab: t.id });
  } finally {
    await a.close();
    await b.close();
  }
});

test('closing a tab during use fails pending and later calls fast with a useful message', async () => {
  const a = await agent({ session: 'bt-close' });
  try {
    const url = fresh();
    await a.ok('browser_open', { url });
    const id = (await tabByUrl(a, url)).id;
    const started = Date.now();
    const slow = evaluate(a, id, 'new Promise(resolve => setTimeout(() => resolve(1), 20000))');
    await sleep(500);
    await a.ok('browser_show_tab', { tab: id });
    await a.ok('debug_vscode_command', { command: 'workbench.action.closeActiveEditor' });
    const result = await slow;
    assert.ok(result.isError);
    assert.match(result.text, new RegExp(`${id} was closed`));
    assert.ok(Date.now() - started < 10_000, `took ${Date.now() - started} ms`);
    const later = await evaluate(a, undefined, '1');
    assert.ok(later.isError);
    assert.match(later.text, new RegExp(`current tab ${id} was closed`));
    assert.ok(!(await tabs(a)).some(t => t.id === id));
  } finally {
    await a.close();
  }
});

test('browser_show_tab brings a tab to the front without opening a duplicate', async () => {
  const a = await agent({ session: 'bt-show' });
  try {
    const title1 = `Show one ${Date.now()}`;
    const title2 = `Show two ${Date.now()}`;
    await a.ok('browser_open', { url: fresh(`/titled?t=${encodeURIComponent(title1)}`) });
    await a.ok('browser_open', { url: fresh(`/titled?t=${encodeURIComponent(title2)}`) });
    const first = (await tabs(a)).find(t => t.url.includes(encodeURIComponent(title1))).id;
    await until(() => editorTabs().find(t => t.label === title2)?.active, 'the second tab in front');
    await a.ok('browser_show_tab', { tab: first });
    await until(() => editorTabs().find(t => t.label === title1)?.active, 'the first tab in front');
    assert.equal(editorTabs().filter(t => t.label === title1).length, 1);
  } finally {
    await a.close();
  }
});

test('a session that ends frees its tabs for others', async () => {
  const b = await agent({ session: 'bt-end-b' });
  try {
    await setSettings({ 'agentBridge.sessionGraceSeconds': 1 });
    const a = await agent({ session: `bt-end-${Date.now()}` });
    const url = fresh();
    await a.ok('browser_open', { url });
    const id = (await tabByUrl(b, url)).id;
    assert.ok((await evaluate(b, id, '1')).isError);
    await a.close();
    await until(async () => (await tabs(b)).find(t => t.id === id)?.notes.includes('opened by an ended session'), 'the session to end', { timeoutMs: 15_000, intervalMs: 500 });
    assert.equal((await evaluate(b, id, '8')).text, '8');
    assert.ok(!(await b.call('browser_close_tab', { tab: id })).isError, 'an ended session\'s tab can be closed');
  } finally {
    await setSettings({});
    await b.close();
  }
});

test('tab ids, ownership, consent and the current tab survive a window reload', async () => {
  const key = `bt-reload-${Date.now()}`;
  const url = fresh();
  const userUrl = fresh();
  let id;
  let userId;
  const a = await agent({ session: key });
  try {
    await a.ok('browser_open', { url });
    id = (await tabByUrl(a, url)).id;
    userId = await userOpens(a, userUrl);
    await prompts(a, ['Allow']);
    await a.ok('browser_select_tab', { tab: userId });
    await a.ok('browser_select_tab', { tab: id });
    await sleep(800); // state is saved shortly after changes
    await a.call('debug_vscode_command', { command: 'workbench.action.reloadWindow' }, { timeoutMs: 5000 }).catch(() => {});
  } finally {
    await a.close().catch(() => {});
  }
  // Wait for the reloaded window's bridge, then come back as the same session.
  const again = await until(
    async () => {
      const candidate = await agent({ session: key }).catch(() => undefined);
      if (!candidate) return undefined;
      const r = await candidate.call('browser_list_tabs').catch(() => ({ isError: true }));
      if (r.isError || !r.text.includes(url)) {
        await candidate.close().catch(() => {});
        return undefined;
      }
      return candidate;
    },
    'the reloaded window',
    { timeoutMs: 60_000, intervalMs: 1000 },
  );
  try {
    const list = await tabs(again);
    const mine = list.find(t => t.url === url);
    assert.equal(mine?.id, id, 'the agent tab got another id');
    assert.match(mine.notes, /opened by you/);
    assert.ok(mine.current, 'the current tab was not restored');
    const user = list.find(t => t.url === userUrl);
    assert.equal(user?.id, userId, 'the user tab got another id');
    const before = (await prompts(again, [], true)).shown.length;
    assert.equal((await evaluate(again, userId, '9')).text, '9');
    assert.equal((await prompts(again, [], false)).shown.length, before, 'asked again after the reload');
  } finally {
    await again.close();
  }
});

await run();
