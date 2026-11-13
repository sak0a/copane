// Login prompts for sites and proxies (HTTP authentication) in tabs an agent drives: the user is asked,
// the agent never sees the login, declines and wrong logins do not loop, logins can be saved.
//
//   node scripts/dev-host.mjs --name <n> --test-proxy     (--test-proxy for the proxy cases)
//   node test/e2e/browser-auth.e2e.mjs --name <n>
//
// Every case uses its own fixture server (its own origin), because the browser keeps logins it was
// given in its own cache for as long as VS Code runs. The window-reload case runs last.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startAuthProxy, startAuthServer } from '../fixtures/browser-auth/server.mjs';
import { startSelfSignedServer } from '../fixtures/browser-certs/server.mjs';
import { agent, assert, hostDir, run, sleep, test, until } from './harness.mjs';

const settingsFile = join(hostDir, 'ud', 'User', 'settings.json');
const original = readFileSync(settingsFile, 'utf8');
async function setSettings(values) {
  writeFileSync(settingsFile, JSON.stringify({ ...JSON.parse(original), ...values }, null, 2));
  await sleep(3000); // VS Code picks up the file change.
}
const shown = async a => JSON.parse(await a.ok('debug_answer_prompts', {})).shown;
const queue = (a, answers) => a.ok('debug_answer_prompts', { answers, clear: true });
const servers = [];
async function fresh() {
  const s = await startAuthServer();
  servers.push(s);
  return s;
}
const LOGIN = ['Log In…', 'alice', 'open sesame'];
const SECRET = 'open sesame';
const SECRET_B64 = Buffer.from(`alice:${SECRET}`).toString('base64');

/** Runs `fn` with a new agent session that has a blank tab of its own. */
async function withAgent(name, fn) {
  const a = await agent({ session: `auth-${name}-${Date.now()}` });
  try {
    await a.ok('browser_open', { url: 'about:blank' });
    await fn(a);
    await a.call('browser_close_tab', {});
  } finally {
    await a.close();
  }
}

test('a login the user types loads the page; nothing the agent can read contains it', async () => {
  const s = await fresh();
  await withAgent('basic', async a => {
    await queue(a, LOGIN);
    const before = (await shown(a)).length;
    const nav = await a.ok('browser_navigate', { url: s.url('/basic/x') });
    assert.match(nav, /"Basic ok" \(HTTP 200/);
    assert.match(nav, /The site 127\.0\.0\.1:\d+ \(realm "Fixture Basic", Basic\) asked for a login; the user entered one and the page continues loading\./);
    assert.doesNotMatch(nav, /is being asked/, 'the waiting note is replaced by the outcome');
    const prompts = (await shown(a)).slice(before);
    assert.equal(prompts.length, 3, JSON.stringify(prompts));
    assert.match(prompts[0].message, /^127\.0\.0\.1:\d+ asks for a login \(realm "Fixture Basic"\) in the tab Claude \d+ is using\. The agent will not see what you type\.$/);
    assert.deepEqual(prompts[0].choices, ['Log In…', 'Log In and Remember…', 'Cancel']);
    assert.deepEqual(prompts[1].input, { prompt: 'User name', password: false });
    assert.deepEqual(prompts[2].input, { prompt: 'Password for alice', password: true });
    assert.equal(prompts[2].answer, '(hidden)');
    assert.equal(s.authorization('/basic/x'), `Basic ${SECRET_B64}`, 'the site got the login');

    const texts = [nav, JSON.stringify(await shown(a))];
    const list = await a.ok('browser_network_requests', { includeStatic: true });
    texts.push(list);
    for (const id of new Set(list.match(/\br\d+\b/g))) texts.push(await a.ok('browser_network_requests', { id }));
    texts.push(await a.ok('browser_console_messages', { level: 'debug' }));
    for (const t of texts) assert.ok(!t.includes(SECRET) && !t.includes(SECRET_B64), `the login leaked into: ${t.slice(0, 300)}`);

    // Another page in the same realm: the browser reuses the login, nobody is asked.
    assert.match(await a.ok('browser_navigate', { url: s.url('/basic/y') }), /"Basic ok"/);
    assert.equal((await shown(a)).length, before + 3);
  });
});

test('a declined login shows the 401 page, tells the agent not to retry, and is not asked again right away', async () => {
  const s = await fresh();
  await withAgent('decline', async a => {
    await queue(a, ['Cancel']);
    const before = (await shown(a)).length;
    const nav = await a.ok('browser_navigate', { url: s.url('/basic/x') });
    assert.match(nav, /HTTP 401/);
    assert.match(nav, /asked for a login and the user declined or did not answer; the page shows the error the site sent \(HTTP 401\)\. Do not retry in a loop/);
    const again = await a.ok('browser_navigate', { url: s.url('/basic/x') });
    assert.match(again, /the user declined a moment ago, so it was cancelled without asking/);
    assert.equal((await shown(a)).length, before + 1, 'asked exactly once');
  });
});

test('a wrong login is asked for once more, then the bridge stops asking', async () => {
  const s = await fresh();
  await withAgent('wrong', async a => {
    await queue(a, ['Log In…', 'alice', 'wrong', 'Log In…', 'alice', 'still wrong']);
    const before = (await shown(a)).length;
    const nav = await a.ok('browser_navigate', { url: s.url('/basic/x') });
    assert.match(nav, /HTTP 401/);
    assert.match(nav, /rejected the login the user entered again, so the bridge stopped asking/);
    const prompts = (await shown(a)).slice(before);
    assert.equal(prompts.length, 6, JSON.stringify(prompts.map(p => p.message)));
    assert.match(prompts[3].message, /^The login for "alice" was not accepted\. 127\.0\.0\.1:\d+ asks for a login/);
    assert.equal(prompts[4].input.value, 'alice', 'the user name is pre-filled');
    assert.equal(s.hits('/basic/x'), 3, 'one request without and two with a login, no more');
  });
  const s2 = await fresh();
  await withAgent('wrong-then-right', async a => {
    await queue(a, ['Log In…', 'alice', 'wrong', 'Log In…', 'alice', SECRET]);
    assert.match(await a.ok('browser_navigate', { url: s2.url('/basic/x') }), /"Basic ok"/);
  });
});

test('a login asked for by a script request of the page is handled too', async () => {
  const s = await fresh();
  await withAgent('xhr', async a => {
    await queue(a, LOGIN);
    await a.ok('browser_navigate', { url: s.url('/xhr') });
    await a.ok('browser_wait_for', { text: '200 {"ok":true' });
    assert.equal(s.authorization('/basic-api'), `Basic ${SECRET_B64}`);
    assert.match((await shown(a)).at(-3).message, /realm "Fixture API"/);
  });
});

test('Digest and NTLM work with typed logins; Negotiate (Kerberos) is never asked', async () => {
  const s = await fresh();
  await withAgent('schemes', async a => {
    await queue(a, LOGIN);
    assert.match(await a.ok('browser_navigate', { url: s.url('/digest/x') }), /"Digest ok"/);
    await queue(a, ['Log In…', 'CORP\\alice', 'any']);
    assert.match(await a.ok('browser_navigate', { url: s.url('/ntlm') }), /"NTLM ok"/);
    assert.match(await a.ok('browser_snapshot', {}), /CORP\\alice/);
    assert.equal((await shown(a)).at(-2).input.prompt, 'User name (DOMAIN\\user or user@domain)');
    await queue(a, []);
    const before = (await shown(a)).length;
    assert.match(await a.ok('browser_navigate', { url: s.url('/negotiate') }), /HTTP 401/);
    assert.equal((await shown(a)).length, before, 'the browser does not ask for typed Kerberos logins');
  });
});

test('a tab opened straight onto a protected page is loaded again so the user can log in', async () => {
  const s = await fresh();
  const a = await agent({ session: `auth-open-${Date.now()}` });
  try {
    await queue(a, LOGIN);
    await a.ok('browser_open', { url: s.url('/basic/open') });
    await a.ok('browser_wait_for', { text: 'Basic ok', timeout: 15 });
    assert.equal(s.authorization('/basic/open'), `Basic ${SECRET_B64}`);
    await a.ok('browser_close_tab', {});
  } finally {
    await a.close();
  }
});

const proxyPortFile = join(hostDir, 'test-proxy-port');
if (existsSync(proxyPortFile)) {
  test('a proxy that asks for a login (407), over HTTP and for an HTTPS tunnel', async () => {
    const tls = await startSelfSignedServer();
    // The browser keeps proxy logins for as long as VS Code runs: realms and passwords of this run's own.
    const run = Date.now().toString(36);
    const realm = name => `${name} ${run}`;
    const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const proxy = await startAuthProxy({ port: Number(readFileSync(proxyPortFile, 'utf8')), tlsPort: Number(new URL(tls.url('127.0.0.1')).port), realm: realm('Fixture Proxy'), password: `pass ${run}` });
    try {
      await withAgent('proxy', async a => {
        await queue(a, ['Log In…', 'proxyuser', `pass ${run}`]);
        const before = (await shown(a)).length;
        const nav = await a.ok('browser_navigate', { url: 'http://intranet.proxy.test/' });
        assert.match(nav, /"Through the proxy"/);
        assert.match(nav, new RegExp(`The proxy 127\\.0\\.0\\.1:\\d+ \\(realm "${esc(realm('Fixture Proxy'))}", Basic\\) asked for a login; the user entered one`));
        assert.match((await shown(a))[before].message, new RegExp(`^The proxy 127\\.0\\.0\\.1:\\d+ asks for a login \\(realm "${esc(realm('Fixture Proxy'))}"\\) while Claude \\d+ loads intranet\\.proxy\\.test\\.`));

        // The proxy now wants another login: declining leaves its error page.
        proxy.setLogin('proxyuser', `second ${run}`, realm('Fixture Proxy 2'));
        await queue(a, ['Cancel']);
        const declined = await a.ok('browser_navigate', { url: 'http://other.proxy.test/' });
        assert.match(declined, /407/);
        assert.match(declined, new RegExp(`the proxy 127\\.0\\.0\\.1:\\d+ \\(realm "${esc(realm('Fixture Proxy 2'))}", Basic\\) asked for a login and the user declined`, 'i'));

        // An HTTPS page through the proxy: the login is asked for the CONNECT tunnel.
        proxy.setLogin('proxyuser', `tls ${run}`, realm('Fixture Proxy TLS'));
        await queue(a, ['Log In…', 'proxyuser', `tls ${run}`, 'Proceed']);
        const tunnel = await a.call('browser_navigate', { url: 'https://secure.proxy.test/' });
        const asked = (await shown(a)).map(p => p.message).join('\n');
        assert.match(asked, new RegExp(`The proxy 127\\.0\\.0\\.1:\\d+ asks for a login \\(realm "${esc(realm('Fixture Proxy TLS'))}"\\)`), `prompts: ${asked}\nresult: ${tunnel.text}`);
        assert.match(tunnel.text, /Self-signed fixture/);
      });
    } finally {
      await proxy.close();
      // The browser may keep its TLS connection open; do not wait for it.
      await Promise.race([tls.close(), sleep(2000)]);
    }
  });
} else {
  test('proxy logins (SKIPPED: start the dev host with --test-proxy to run them)', () => {});
}

test('a saved login is used after a window reload without asking, and can be forgotten', async () => {
  const s = await fresh();
  await withAgent('save', async a => {
    await queue(a, ['Log In and Remember…', 'alice', SECRET]);
    assert.match(await a.ok('browser_navigate', { url: s.url('/basic/x') }), /the user entered one \(saved for later\)/);
  });
  const reloader = await agent({ session: `auth-reload-${Date.now()}` });
  await reloader.call('debug_vscode_command', { command: 'workbench.action.reloadWindow' }, { timeoutMs: 5000 }).catch(() => {});
  await reloader.close().catch(() => {});
  await sleep(3000);
  const b = await until(
    async () => {
      const candidate = await Promise.race([agent({ session: `auth-after-reload-${Date.now()}` }), sleep(10_000).then(() => undefined)]).catch(() => undefined);
      if (!candidate) return undefined;
      const r = await candidate.call('browser_list_tabs', {}, { timeoutMs: 5000 }).catch(() => ({ isError: true }));
      if (!r.isError) return candidate;
      await candidate.close().catch(() => {});
      return undefined;
    },
    'the window to come back after the reload',
    { timeoutMs: 60_000, intervalMs: 1000 },
  );
  try {
    await queue(b, []);
    await b.ok('browser_open', { url: 'about:blank' });
    // The browser still has the login cached; the site rejects it once, so the browser asks the bridge,
    // which (in a fresh extension host) only has the saved login.
    s.rejectNextLogin();
    assert.match(await b.ok('browser_navigate', { url: s.url('/basic/after-reload') }), /"Basic ok"/);
    assert.equal((await shown(b)).length, 0, 'the saved login was used without asking');

    assert.equal(JSON.parse(await b.ok('debug_vscode_command', { command: 'copane.browser.forgetLogins' })), 1);
    s.rejectNextLogin();
    await queue(b, ['Cancel']);
    assert.match(await b.ok('browser_navigate', { url: s.url('/basic/forgotten') }), /HTTP 401/);
    assert.equal((await shown(b)).length, 1, 'after forgetting, the user is asked again');
    await b.ok('browser_close_tab', {});
  } finally {
    await b.close();
  }
});

test('the setting turns login prompts off', async () => {
  const s = await fresh();
  await setSettings({ 'copane.browser.loginPrompts': false });
  try {
    await withAgent('off', async a => {
      // Should a prompt appear anyway, it is answered at once instead of waiting for a person.
      await queue(a, ['Cancel']);
      const before = (await shown(a)).length;
      assert.match(await a.ok('browser_navigate', { url: s.url('/basic/x') }), /HTTP 401/);
      assert.equal((await shown(a)).length, before, 'no prompt');
      await queue(a, []);
    });
  } finally {
    await setSettings({});
  }
});

test('cleanup', async () => {
  writeFileSync(settingsFile, original);
  for (const s of servers) await s.close();
});

await run();
