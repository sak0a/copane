// Login profiles: tabs in separate login stores, against a running dev host:
//
//   rm -rf /tmp/copane-dev/browser-profiles && node scripts/dev-host.mjs --name browser-profiles
//   node test/e2e/browser-profiles.e2e.mjs --name browser-profiles [--only <text>]
//
// The fixture app (test/fixtures/browser-profiles/server.mjs) logs in with a cookie and shows who is
// logged in in the page title, so every page load says which store the tab uses. Profile names carry
// a per-run suffix, so the test can run again against the same dev host. The window reload case runs
// last.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startProfileServer } from '../fixtures/browser-profiles/server.mjs';
import { agent, assert, hostDir, run, sleep, test, until } from './harness.mjs';

const server = await startProfileServer();
const runId = Date.now().toString(36).slice(-5);
const name = base => `${base}-${runId}`;
const DEV = name('dev');
const TEST = name('test');

const settingsFile = join(hostDir, 'ud', 'User', 'settings.json');
const baseSettings = JSON.parse(readFileSync(settingsFile, 'utf8'));
async function setSettings(values) {
  writeFileSync(settingsFile, JSON.stringify({ ...baseSettings, ...values }, null, 2));
  await sleep(3000); // VS Code picks up the file change asynchronously.
}

async function tabs(a) {
  const text = await a.ok('browser_list_tabs');
  return text
    .split('\n')
    .filter(l => /^[* ] tab-\d+/.test(l))
    .map(l => {
      const m = l.match(/^([* ]) (tab-\d+)\s+(\S+)\s+"(.*)"\s+\((.*)\)$/);
      return { id: m[2], url: m[3], title: m[4], notes: m[5] };
    });
}
const tabInfo = async (a, id) => (await tabs(a)).find(t => t.id === id);
const openedId = text => text.match(/^Opened (tab-\d+)/m)?.[1] ?? assert.fail(`no tab id in: ${text}`);
/** Who the fixture app says is logged in, after (re)loading `/` in the tab. */
async function who(a, tab) {
  const text = await a.ok('browser_navigate', { tab, url: server.url(`/?t=${Date.now()}`) });
  return text.match(/"(Logged in as [^"]+|Not logged in)"/)?.[1] ?? assert.fail(`no login state in: ${text}`);
}
const localStorageOf = (a, tab) => a.ok('browser_evaluate', { tab, function: '() => localStorage.getItem("user")' });
const uiState = async a => JSON.parse(await a.ok('debug_ui_state'));

// One agent session for most cases; profiles are shared across sessions anyway.
const a = await agent({ session: `bp-main-${runId}` });

test('a profile is separate from the default store and from other profiles; tabs of one profile share logins', async () => {
  const plain = openedId(await a.ok('browser_open', { url: server.url('/login?user=default-user') }));
  assert.equal((await tabInfo(a, plain)).notes.includes('login profile'), false);

  const opened = await a.ok('browser_open', { url: server.url('/'), profile: DEV });
  assert.match(opened, /"Not logged in"/, 'a new profile starts logged out, without the default store\'s cookie');
  assert.match(opened, new RegExp(`It is in the login profile "${DEV}", new and empty`));
  assert.match(opened, /never on disk/);
  const dev1 = openedId(opened);
  assert.match((await tabInfo(a, dev1)).notes, new RegExp(`login profile "${DEV}"`));

  assert.match(await a.ok('browser_navigate', { tab: dev1, url: server.url('/login?user=dev-user') }), /"Logged in as dev-user"/);
  assert.equal(await who(a, plain), 'Logged in as default-user', 'logging in in the profile did not touch the default store');
  assert.equal(await localStorageOf(a, plain), 'default-user');

  const dev2Text = await a.ok('browser_open', { url: server.url('/'), profile: DEV.toUpperCase() });
  assert.match(dev2Text, /"Logged in as dev-user"/, 'a second tab of the profile shares its login (names are case-insensitive)');
  assert.match(dev2Text, new RegExp(`shared with ${dev1}\\.`));
  const dev2 = openedId(dev2Text);
  assert.equal(await localStorageOf(a, dev2), 'dev-user', 'local storage is shared within the profile');

  // Another session opening the same profile gets the same login.
  const b = await agent({ session: `bp-other-${runId}` });
  try {
    assert.match(await b.ok('browser_open', { url: server.url('/'), profile: DEV }), /"Logged in as dev-user"/);
    const testTab = openedId(await b.ok('browser_open', { url: server.url('/'), profile: TEST }));
    assert.equal(await who(b, testTab), 'Not logged in', 'another profile has its own store');
    assert.equal(await localStorageOf(b, testTab), 'null');
    assert.match(await b.ok('browser_open', { url: server.url('/'), profile: 'default' }), /"Logged in as default-user"/, '"default" is the shared store');
  } finally {
    await b.close();
  }

  assert.match((await a.call('browser_open', { url: server.url('/'), profile: 'not a name' })).text, /not a valid profile name/);
});

test('logins survive closing every tab of a profile', async () => {
  const p = name('closed');
  const t1 = openedId(await a.ok('browser_open', { url: server.url('/login?user=kept'), profile: p }));
  await a.ok('browser_close_tab', { tab: t1 });
  await sleep(1000);
  assert.match(await a.ok('browser_profiles'), new RegExp(`- ${p}: no tab open, logins kept`));
  assert.match(await a.ok('browser_open', { url: server.url('/'), profile: p }), /"Logged in as kept"/);
});

test('a session default: set by the agent, overridden by the user from the Sessions view, cleared again', async () => {
  const key = `bp-default-${runId}`;
  const s = await agent({ session: key });
  try {
    assert.match(await s.ok('browser_profiles', { default: TEST }), new RegExp(`Your new tabs open in the profile "${TEST}" from now on\\.`));
    const t = await s.ok('browser_open', { url: server.url('/') });
    assert.match(t, new RegExp(`It is in the login profile "${TEST}" \\(your default\\)`));
    assert.match((await tabInfo(s, openedId(t))).notes, new RegExp(`login profile "${TEST}"`));

    // The user picks DEV for this session (Sessions view row → "Set Login Profile for Agent Session…").
    await s.ok('debug_vscode_command', { command: 'copane.browser.setSessionProfile', args: [{ id: `session:${key}` }, DEV] });
    const listed = await s.ok('browser_profiles');
    assert.match(listed, new RegExp(`Your new tabs open in "${DEV}" \\(set by the user; it wins over yours\\)\\.`));
    assert.match(listed, new RegExp(`Your own choice "${TEST}" applies only once the user clears theirs`));
    assert.match(await s.ok('browser_open', { url: server.url('/') }), /"Logged in as dev-user"[\s\S]*the default the user set for your session/);
    // An explicit profile still wins for one tab.
    assert.match(await s.ok('browser_open', { url: server.url('/'), profile: TEST }), new RegExp(`login profile "${TEST}", shared with`));

    const ui = await until(async () => {
      const state = await uiState(s);
      return state.rows.find(r => r.kind === 'session' && r.id.startsWith(`session:${key}`) && /profile/.test(r.description ?? '')) ? state : undefined;
    }, 'the session row to show its profile');
    const row = ui.rows.find(r => r.kind === 'session' && r.id.startsWith(`session:${key}`));
    assert.match(row.description, new RegExp(`profile ${DEV}`));
    assert.ok(ui.rows.some(r => r.kind === 'tab' && r.id.startsWith(`session:${key}/`) && r.description.includes(`profile ${TEST}`)), 'tab rows show their profile');
    assert.ok(ui.panel.rows.some(r => r.description.includes(`profile ${DEV}`)), 'the Agent Tabs panel shows profiles');

    await s.ok('debug_vscode_command', { command: 'copane.browser.setSessionProfile', args: [key, ''] });
    assert.match(await s.ok('browser_profiles'), new RegExp(`Your new tabs open in "${TEST}" \\(set by you\\)`));
    await s.ok('browser_profiles', { default: '' });
    assert.match(await s.ok('browser_profiles'), /Your new tabs open in the shared default store \(the user's setting\)/);
  } finally {
    await s.close();
  }
});

test('the setting "private" gives every session its own profile and keeps agents out of the default store', async () => {
  await setSettings({ 'copane.browser.agentLoginStore': 'private' });
  const s = await agent({ session: `bp-private-${runId}` });
  try {
    const t = await s.ok('browser_open', { url: server.url('/') });
    assert.match(t, /"Not logged in"/);
    assert.match(t, /It is in your private login profile \(the setting for agent sessions\), new and empty/);
    assert.match((await tabInfo(s, openedId(t))).notes, /login profile "private to Claude \d+"/);
    assert.match(await s.ok('browser_open', { url: server.url('/login?user=mine') }), /shared with tab-\d+/);
    const refused = await s.call('browser_open', { url: server.url('/'), profile: 'default' });
    assert.ok(refused.isError);
    assert.match(refused.text, /agentLoginStore is "private"/);
    // Named profiles stay available.
    assert.match(await s.ok('browser_open', { url: server.url('/'), profile: DEV }), /"Logged in as dev-user"/);
    // Another session's private profile is not this one's.
    const other = await agent({ session: `bp-private2-${runId}` });
    try {
      assert.match(await other.ok('browser_open', { url: server.url('/') }), /"Not logged in"/);
    } finally {
      await other.close();
    }
  } finally {
    await s.close();
    await setSettings({});
  }
});

test('the user opens a tab in a profile with the command; it shows as theirs, in that profile', async () => {
  const url = server.url(`/?user-cmd=${runId}`);
  await a.ok('debug_vscode_command', { command: 'copane.browser.openInProfile', args: [DEV, url] });
  const tab = await until(async () => (await tabs(a)).find(t => t.url === url && t.notes.includes('login profile') && t.title), 'the user tab in the profile, loaded');
  assert.match(tab.notes, /opened by the user/);
  assert.match(tab.notes, new RegExp(`login profile "${DEV}"`));
  assert.equal(tab.title, 'Logged in as dev-user');
  // The agent opening the same profile afterwards joins the user's tab.
  assert.match(await a.ok('browser_open', { url: server.url('/'), profile: DEV }), new RegExp(`shared with [^\\n]*${tab.id}`));
});

test('popups and target=_blank tabs of a profile tab stay in the profile', async () => {
  const opener = openedId(await a.ok('browser_open', { url: server.url('/opener'), profile: DEV }));
  const blank = (await a.ok('browser_click', { tab: opener, selector: '#blank' })).match(/A new tab opened: (tab-\d+)/)?.[1];
  const script = (await a.ok('browser_click', { tab: opener, selector: '#open' })).match(/A new tab opened: (tab-\d+)/)?.[1];
  assert.ok(blank && script, 'both popups were reported');
  for (const id of [blank, script]) {
    const info = await until(async () => {
      const t = await tabInfo(a, id);
      return t?.notes.includes('login profile') ? t : undefined;
    }, `${id} to be recognised as a profile tab`);
    assert.match(info.notes, new RegExp(`login profile "${DEV}"`));
    assert.equal(await who(a, id), 'Logged in as dev-user');
  }
});

test('login prompts, request mocking and cross-origin frames work in a profile tab', async () => {
  const t = openedId(await a.ok('browser_open', { url: server.url('/'), profile: DEV }));
  // HTTP authentication goes through the bridge's prompt.
  await a.ok('debug_answer_prompts', { answers: ['Log In…', 'alice', 'secret'], clear: true });
  const basic = await a.ok('browser_navigate', { tab: t, url: server.url('/basic') });
  assert.match(basic, /"Basic ok"/);
  assert.match(basic, /asked for a login; the user entered one/);
  assert.equal(await a.ok('browser_evaluate', { tab: t, function: '() => document.getElementById("cookie").textContent' }), 'dev-user');

  // Request mocking.
  await a.ok('browser_route', { tab: t, action: 'add', url: '*/api/whoami', body: '{"user":"mocked"}' });
  await a.ok('browser_navigate', { tab: t, url: server.url('/fetcher') });
  const api = await until(async () => {
    const v = await a.ok('browser_evaluate', { tab: t, function: '() => document.getElementById("api").textContent' });
    return v !== '...' ? v : undefined;
  }, 'the fetch');
  assert.equal(api, '{"user":"mocked"}');
  await a.ok('browser_route', { tab: t, action: 'remove' });

  // A cross-origin frame is read in place.
  await a.ok('browser_navigate', { tab: t, url: server.url('/framed') });
  const snap = await until(async () => {
    const s = await a.ok('browser_snapshot', { tab: t });
    return /iframe[^\n]*\n\s+- heading "(Not logged in|Logged in as [^"]+)"/.test(s) ? s : undefined;
  }, 'the frame in the snapshot');
  assert.doesNotMatch(snap, /cannot be read|not read/);
});

test('a window reload keeps profiles with open tabs (and their tab ids); a profile without tabs is lost', async () => {
  const key = `bp-reload-${runId}`;
  const r = await agent({ session: key });
  const keep = name('keep');
  const drop = name('drop');
  let kept;
  try {
    kept = openedId(await r.ok('browser_open', { url: server.url('/login?user=keeper'), profile: keep }));
    const dropped = openedId(await r.ok('browser_open', { url: server.url('/login?user=dropper'), profile: drop }));
    await r.ok('browser_close_tab', { tab: dropped });
    // Tabs a session still controls come back stuck loading after a reload when login prompts are on:
    // the previous extension host's CDP Fetch interception is never turned off (not specific to
    // profiles; see docs/browser-profiles.md). Releasing first avoids it.
    await r.ok('browser_release_tab', { all: true });
    await a.ok('browser_release_tab', { all: true });
    await sleep(1000); // state is saved shortly after changes
    await r.call('debug_vscode_command', { command: 'workbench.action.reloadWindow' }, { timeoutMs: 5000 }).catch(() => {});
  } finally {
    await r.close().catch(() => {});
  }
  const again = await until(
    async () => {
      const candidate = await agent({ session: key }).catch(() => undefined);
      if (!candidate) return undefined;
      const res = await candidate.call('browser_list_tabs').catch(() => ({ isError: true }));
      if (res.isError || !res.text.includes(`login profile "${keep}"`)) {
        await candidate.close().catch(() => {});
        return undefined;
      }
      return candidate;
    },
    'the reloaded window with its profile tabs',
    { timeoutMs: 60_000, intervalMs: 1000 },
  );
  try {
    assert.match((await tabInfo(again, kept)).notes, new RegExp(`login profile "${keep}"`), 'the tab kept its id and profile');
    assert.equal(await who(again, kept), 'Logged in as keeper', 'its login survived the reload');
    assert.match(await again.ok('browser_open', { url: server.url('/'), profile: keep }), new RegExp(`"Logged in as keeper"[\\s\\S]*shared with ${kept}`));
    assert.match(await again.ok('browser_profiles'), new RegExp(`- ${drop}: logins lost \\(none of its tabs was open when the window reloaded`));
    const reopened = await again.ok('browser_open', { url: server.url('/'), profile: drop });
    assert.match(reopened, /"Not logged in"/);
    assert.match(reopened, /starts empty again: its earlier logins are gone because none of its tabs was open/);
  } finally {
    await again.close();
  }
});

try {
  await run();
} finally {
  await a.close().catch(() => {});
  await server.close();
}
