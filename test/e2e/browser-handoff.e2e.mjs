// Handing a browser tab to the user (browser_request_user_input): the user signs in, solves or
// decides something in the agent's tab, and the agent continues there. Covers every way a hand-off
// ends, what the agent can and cannot do meanwhile, what stays private afterwards, and how the views
// show a tab waiting for the user.
//
//   node scripts/dev-host.mjs --name <n>
//   node test/e2e/browser-handoff.e2e.mjs --name <n>
//
// The user is played through the dev host's own DevTools port (test/fixtures/browser-handoff/user.mjs):
// real clicks and typing in the page, separate from the bridge. Each case uses its own fixture site.
import { startHandoffServer } from '../fixtures/browser-handoff/server.mjs';
import { asUser } from '../fixtures/browser-handoff/user.mjs';
import { agent, assert, hostDir, run, sleep, test, until } from './harness.mjs';

const servers = [];
async function site() {
  const s = await startHandoffServer();
  servers.push(s);
  return s;
}

const MESSAGE = 'Sign in to Fixture Corp with your account.';

/** Runs `fn` with a new agent session that has its own tab on `url`. */
async function withAgent(name, url, fn) {
  const a = await agent({ session: `handoff-${name}-${Date.now()}` });
  try {
    const opened = await a.ok('browser_open', { url });
    const tabId = /Opened (tab-\d+)/.exec(opened)[1];
    await fn(a, tabId, opened);
    await a.call('browser_close_tab', { tab: tabId });
  } finally {
    await a.close();
  }
}

/** Starts a hand-off without waiting for it; resolves to `{ text, isError }` when it ends. */
function handOff(a, args) {
  return a.call('browser_request_user_input', { message: MESSAGE, ...args }, { timeoutMs: 300_000 });
}

/** Waits until the page indicator shows the request, and returns the user's connection to the page. */
async function userSees(url, message = MESSAGE) {
  const user = await asUser(hostDir, url);
  await until(async () => {
    const i = await user.indicator();
    return i.text.includes(`needs you: ${message}`) && i.buttons.some(b => b.text === 'Done' && b.x !== undefined) && i.buttons.some(b => b.text === "Won't do");
  }, 'the request in the page indicator');
  return user;
}

const uiState = async a => JSON.parse(await a.ok('debug_ui_state', {}));
const tabInfo = async (a, tabId) => (await a.ok('browser_list_tabs', {})).split('\n').find(l => l.includes(` ${tabId} `) || l.startsWith(`* ${tabId} `) || l.startsWith(`  ${tabId} `));
const shownPrompts = async a => JSON.parse(await a.ok('debug_answer_prompts', {})).shown;

/** Everything the agent can read about the tab's traffic and console, joined. */
async function everythingReadable(a, tabId) {
  const texts = [];
  const list = await a.ok('browser_network_requests', { includeStatic: true, allPages: true, tab: tabId });
  texts.push(list);
  for (const id of new Set(list.match(/\br\d+\b/g) ?? [])) texts.push(await a.ok('browser_network_requests', { id, tab: tabId }));
  texts.push(await a.ok('browser_console_messages', { level: 'debug', allPages: true, tab: tabId }));
  texts.push(await a.ok('browser_snapshot', { tab: tabId }));
  return texts.join('\n');
}

function assertNoSecrets(text, secrets) {
  for (const secret of secrets) {
    for (const form of new Set([secret, encodeURIComponent(secret), encodeURIComponent(secret).replace(/%20/g, '+')])) {
      assert.ok(!text.includes(form), `"${secret}" is readable by the agent: …${text.slice(Math.max(0, text.indexOf(form) - 200), text.indexOf(form) + 100)}…`);
    }
  }
}

test('done by condition: the user signs in, the hand-off ends by itself, the agent continues on the logged-in page', async () => {
  const s = await site();
  await withAgent('condition', s.url('/'), async (a, tabId, opened) => {
    assert.match(opened, /\/login\?next=\/dashboard/);
    assert.match(opened, /This looks like a sign-in page\. .*browser_request_user_input/, 'opening a login page points at the hand-off');
    const pending = handOff(a, { done_when: { url: '/dashboard' } });
    const user = await userSees(s.url('/login'));
    try {
      await user.type('#user', s.user);
      await user.type('#pass', s.password);
      await user.clickOn('#submit');
      const result = await pending;
      assert.ok(!result.isError, result.text);
      assert.match(result.text, /^done_when matched after \d+ s: the user finished in tab-\d+, which is yours again\./);
      assert.match(result.text, /Page now: http:\/\/127\.0\.0\.1:\d+\/dashboard — "Dashboard — Fixture Corp", heading "Welcome, alice"\./);
      assert.match(result.text, /While the user had the tab, the \d+ requests it sent are listed without URL query, headers or bodies/);
      assert.deepEqual(s.logins.map(l => [l.user, l.password]), [[s.user, s.password]], 'the site got what the user typed');
      // The agent goes on in the same tab, signed in.
      assert.match(await a.ok('browser_snapshot', { tab: tabId, mode: 'text' }), /Welcome, alice/);
      assert.match(await a.ok('browser_navigate', { url: s.url('/dashboard') }), /Dashboard — Fixture Corp/);
      const readable = await everythingReadable(a, tabId);
      assertNoSecrets(readable, [s.password]);
      assert.match(readable, /POST 302 → document {2}http:\/\/127\.0\.0\.1:\d+\/login .*sent while the user had the tab: details withheld/);
    } finally {
      user.close();
    }
  });
});

test('the agent cannot read or act in the tab meanwhile, and the views show the tab waiting for the user', async () => {
  const s = await site();
  const other = await agent({ session: `handoff-other-${Date.now()}` });
  try {
    await withAgent('blocked', s.url('/login'), async (a, tabId) => {
      const pending = handOff(a, { done_when: { url: '/dashboard' } });
      const user = await userSees(s.url('/login'));
      try {
        for (const [tool, args] of [
          ['browser_snapshot', {}],
          ['browser_screenshot', {}],
          ['browser_network_requests', {}],
          ['browser_evaluate', { function: '() => document.title' }],
          ['browser_type', { selector: '#user', text: 'x' }],
        ]) {
          const r = await a.call(tool, args);
          assert.ok(r.isError, `${tool} worked during the hand-off: ${r.text}`);
          assert.match(r.text, /is with the user for your request \("Sign in to Fixture Corp/, tool);
        }
        const r = await other.call('browser_snapshot', { tab: tabId });
        assert.ok(r.isError);
        assert.match(r.text, /is with the user for a request of Claude \d+/);
        assert.match(await tabInfo(other, tabId), /PAUSED by the user/);

        const ui = await until(async () => {
          const state = await uiState(a);
          return state.attention.some(item => item.kind === 'tab' && item.targetId === tabId) && state;
        }, 'the tab in the attention list');
        const item = ui.attention.find(i => i.targetId === tabId);
        assert.match(item.label, /^Claude \d+ is waiting for you$/);
        assert.equal(item.detail, MESSAGE);
        assert.equal(item.icon.id, 'bell-dot');
        assert.match(ui.status.text, /^\$\(bell-dot\) Claude \d+ needs you$|^\$\(bell-dot\) \d+ need you$/);
        assert.equal(ui.status.warning, true);
        assert.equal(ui.status.shown.backgroundColor, 'statusBarItem.warningBackground');
        assert.ok(ui.badge.value >= 1 && /tabs? (is|are) waiting for you/.test(ui.badge.tooltip), JSON.stringify(ui.badge));
        const row = ui.rows.find(r => r.id.endsWith(`/tab:${tabId}`));
        assert.match(row.description, /^waiting for you: Sign in to Fixture Corp/);
        assert.equal(row.icon.id, 'bell-dot');
        assert.ok(row.contextValue.split(' ').includes('waitingForUser') && !row.contextValue.split(' ').includes('paused'), row.contextValue);
        const panelRow = ui.panel.rows.find(r => r.ref.tabId === tabId);
        assert.match(panelRow.description, /waiting for you: Sign in to Fixture Corp/);
        assert.equal(panelRow.icon.id, 'bell-dot');

        await user.type('#user', s.user);
        await user.type('#pass', s.password);
        await user.clickOn('#submit');
        assert.ok(!(await pending).isError);
        await until(async () => !(await uiState(a)).attention.some(i => i.targetId === tabId), 'the attention item to go away');
        assert.doesNotMatch(await tabInfo(other, tabId), /PAUSED/);
        assert.ok(!(await other.call('browser_snapshot', { tab: tabId })).isError, 'other sessions can read the tab again');
      } finally {
        user.close();
      }
    });
  } finally {
    await other.close();
  }
});

test('the sign-in hint is given in full once per session, then in short', async () => {
  const s = await site();
  await withAgent('hint', s.url('/'), async (a, tabId, opened) => {
    assert.match(opened, /This looks like a sign-in page\. Unless you were given test credentials for it, do not sign in yourself/);
    const again = await a.ok('browser_open', { url: s.url('/spa'), background: true });
    const second = /Opened (tab-\d+)/.exec(again)[1];
    assert.match(again, /This looks like a sign-in page: without test credentials, hand it to the user \(browser_request_user_input with done_when\)\./);
    assert.doesNotMatch(again, /do not sign in yourself/);
    await a.call('browser_close_tab', { tab: second });
  });
  // Another session gets it in full again.
  await withAgent('hint2', s.url('/'), async (a, tabId, opened) => assert.match(opened, /This looks like a sign-in page\. Unless/));
});

test('done by the user on a single-page sign-in: nothing the user typed is readable afterwards', async () => {
  const s = await site();
  await withAgent('spa', s.url('/spa'), async (a, tabId, opened) => {
    assert.match(opened, /This looks like a sign-in page/, 'a visible password field marks a sign-in page');
    const pending = handOff(a, {});
    const user = await userSees(s.url('/spa'));
    try {
      await user.type('#user', s.user);
      await user.type('#pass', s.password);
      await user.type('#otp', s.code);
      await user.clickOn('#submit');
      await until(async () => (await user.evaluate("document.getElementById('status').textContent")) === `Signed in as ${s.user}`, 'the page to sign in');
      await user.clickIndicatorButton('Done');
      const result = await pending;
      assert.ok(!result.isError, result.text);
      assert.match(result.text, /^The user said they are done \(after \d+ s\); tab-\d+ is yours again\./);
      assert.match(result.text, /Page now: http:\/\/127\.0\.0\.1:\d+\/spa — "Fixture SPA"/);
      assert.match(result.text, /2 password or code fields still on the page were emptied/);
      assert.match(result.text, /its console message is withheld/);
      assert.equal(s.tokens.length, 1, 'the site signed the user in');
      assert.equal(s.logins.at(-1).password, s.password);
      // The page kept its form, but the fields are empty now, for the page's own state too.
      assert.match(await a.ok('browser_evaluate', { function: "() => JSON.stringify([document.querySelector('#pass').value, document.querySelector('#otp').value, document.querySelector('#user').value])" }), /\["",\s*"",\s*"alice"\]/);
      const readable = await everythingReadable(a, tabId);
      assertNoSecrets(readable, [s.password, s.code, s.tokens[0]]);
      assert.match(readable, /POST 200 fetch {2}http:\/\/127\.0\.0\.1:\d+\/api\/token .*details withheld/);
      assert.match(readable, /logged while the user had the tab; withheld/);
      assert.match(readable, /Signed in as alice/, 'the agent sees the page as it is now');
    } finally {
      user.close();
    }
  });
});

test('resuming the tab any other way ends the hand-off as done, after what the user typed is made private', async () => {
  const s = await site();
  for (const [how, command, arg] of [
    ['command', 'copane.browser.resumeTab', tabId => tabId],
    ['session', 'copane.ui.resumeSessionTabs', (_tabId, sessionId) => sessionId],
  ]) {
    await withAgent(`resume-${how}`, s.url(`/spa?${how}`), async (a, tabId) => {
      const sessionId = JSON.parse(await a.ok('debug_ui_state', {})).rows.find(r => r.id.endsWith(`/tab:${tabId}`)).id.split('/')[0].slice('session:'.length);
      const pending = handOff(a, {});
      const user = await userSees(s.url(`/spa?${how}`));
      try {
        await user.type('#pass', s.password);
        await a.ok('debug_vscode_command', { command, args: [arg(tabId, sessionId)] });
        const result = await pending;
        assert.ok(!result.isError, result.text);
        assert.match(result.text, /^The user said they are done/, how);
        assert.match(result.text, /a password or code field still on the page was emptied/, how);
        assert.equal(await a.ok('browser_evaluate', { function: "() => JSON.stringify(document.querySelector('#pass').value)" }), '""');
      } finally {
        user.close();
      }
    });
  }
});

test("declined: the user clicks Won't do; the agent is told not to ask again and has the tab back", async () => {
  const s = await site();
  await withAgent('declined', s.url('/plain'), async (a, tabId) => {
    const pending = handOff(a, { message: 'Pick the release to deploy.' });
    const user = await userSees(s.url('/plain'), 'Pick the release to deploy.');
    try {
      await user.clickIndicatorButton("Won't do");
      const result = await pending;
      assert.ok(!result.isError, result.text);
      assert.match(result.text, /^The user declined \("Won't do"\) after \d+ s; tab-\d+ is yours again\. Do not ask again/);
      assert.match(result.text, /Page now: .*\/plain — "Plain page"/);
      assert.ok(!(await a.call('browser_snapshot', { tab: tabId })).isError);
      await until(async () => !(await user.indicator()).text.includes('needs you'), 'the request to leave the indicator');
    } finally {
      user.close();
    }
  });
});

test('timeout: nobody answers, the request is withdrawn and the tab is the agent\'s again', async () => {
  const s = await site();
  await withAgent('timeout', s.url('/plain'), async (a, tabId) => {
    const started = Date.now();
    const result = await handOff(a, { timeout_seconds: 10 });
    assert.ok(!result.isError, result.text);
    assert.ok(Date.now() - started >= 9500, 'waited for the timeout');
    assert.match(result.text, /^No answer from the user within 1\d s; the request was withdrawn and tab-\d+ is yours again\. Ask the user in chat before trying again\./);
    assert.ok(!(await a.call('browser_click', { selector: 'h1', tab: tabId })).isError, 'the agent controls the tab again');
  });
});

test('the tab closes: the agent is told so', async () => {
  const s = await site();
  const a = await agent({ session: `handoff-closed-${Date.now()}` });
  try {
    const tabId = /Opened (tab-\d+)/.exec(await a.ok('browser_open', { url: s.url('/plain') }))[1];
    const pending = handOff(a, {});
    (await userSees(s.url('/plain'))).close();
    await a.ok('debug_vscode_command', { command: 'copane.ui.closeTab', args: [tabId] });
    const result = await pending;
    assert.ok(!result.isError, result.text);
    assert.match(result.text, new RegExp(`^The user closed ${tabId} \\(after \\d+ s\\)\\. Open a new tab with browser_open if you still need the page\\.$`));
  } finally {
    await a.close();
  }
});

test('the agent cancels, or its session ends: the request is withdrawn and the tab is no longer paused', async () => {
  const s = await site();
  const watcher = await agent({ session: `handoff-watch-${Date.now()}` });
  try {
    // Cancel: the agent's call is aborted (the user pressed Esc in the agent).
    await withAgent('cancel', s.url('/plain'), async (a, tabId) => {
      const controller = new AbortController();
      const call = a.mcp.callTool({ name: 'browser_request_user_input', arguments: { message: MESSAGE } }, undefined, { signal: controller.signal, timeout: 120_000 }).catch(err => err);
      (await userSees(s.url('/plain'))).close();
      controller.abort();
      await call;
      await until(async () => !/PAUSED/.test(await tabInfo(watcher, tabId)), 'the tab to be resumed');
      assert.ok(!(await a.call('browser_snapshot', { tab: tabId })).isError);
      const user = await asUser(hostDir, s.url('/plain'));
      await until(async () => !(await user.indicator()).text.includes('needs you'), 'the request to leave the indicator');
      user.close();
    });
    // Session ends: the agent's connection goes away in the middle of the hand-off.
    const b = await agent({ session: `handoff-ends-${Date.now()}` });
    const tabId = /Opened (tab-\d+)/.exec(await b.ok('browser_open', { url: s.url('/plain?b') }))[1];
    void handOff(b, {}).catch(() => {});
    (await userSees(s.url('/plain?b'))).close();
    await b.close();
    await until(async () => !/PAUSED/.test(await tabInfo(watcher, tabId)), 'the tab to be resumed after the session went away');
    await watcher.ok('debug_vscode_command', { command: 'copane.ui.closeTab', args: [tabId] });
  } finally {
    await watcher.close();
  }
});

test('out of sight: a notification asks for the user, and they can answer there', async () => {
  const s = await site();
  await withAgent('notify', s.url('/plain'), async a => {
    const before = (await shownPrompts(a)).length;
    await a.ok('debug_answer_prompts', { answers: ["Won't Do"], clear: true });
    const pending = handOff(a, { message: 'Approve the deployment.' });
    (await userSees(s.url('/plain'), 'Approve the deployment.')).close();
    assert.equal((await shownPrompts(a)).length, before, 'no notification while the tab is in sight');
    // The user opens a file over the tab.
    await a.ok('debug_vscode_command', { command: 'workbench.action.files.newUntitledFile' });
    try {
      const result = await pending;
      assert.ok(!result.isError, result.text);
      assert.match(result.text, /^The user declined/);
      const prompts = (await shownPrompts(a)).slice(before);
      assert.equal(prompts.length, 1, JSON.stringify(prompts));
      assert.match(prompts[0].message, /^Claude \d+ needs you in the browser tab "Plain page": Approve the deployment\.$/);
      assert.deepEqual(prompts[0].choices, ['Show Tab', 'Done', "Won't Do"]);
    } finally {
      await a.ok('debug_vscode_command', { command: 'workbench.action.revertAndCloseActiveEditor' });
    }
  });
});

test('Done from the Sessions view; and a condition that already holds hands nothing over', async () => {
  const s = await site();
  await withAgent('view', s.url('/plain'), async (a, tabId) => {
    const pending = handOff(a, { message: 'Check the page.' });
    (await userSees(s.url('/plain'), 'Check the page.')).close();
    await a.ok('debug_vscode_command', { command: 'copane.ui.finishTabRequest', args: [tabId] });
    assert.match((await pending).text, /^The user said they are done/);

    const started = Date.now();
    const already = await a.ok('browser_request_user_input', { message: MESSAGE, done_when: { url: '/plain', text: 'nothing to sign in' } });
    assert.match(already, /^done_when already holds in tab-\d+, so nothing was handed to the user\. Page now: .*\/plain — "Plain page"/);
    assert.ok(Date.now() - started < 5000);
    assert.doesNotMatch(await tabInfo(a, tabId), /PAUSED/);

    const bad = await a.call('browser_request_user_input', { message: MESSAGE, done_when: { selector: 'input[type=password][value^="a"]' } });
    assert.ok(bad.isError);
    assert.match(bad.text, /cannot test field values/);
  });
});

try {
  await run();
} finally {
  for (const s of servers) await s.close();
}
