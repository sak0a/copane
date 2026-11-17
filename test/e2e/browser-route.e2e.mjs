// Request mocking (browser_route): canned responses, network errors, delays and changed headers, marked
// in the network log, owned by one session and one tab, and gone when the session lets go of the tab.
//
//   node scripts/dev-host.mjs --name <n>
//   node test/e2e/browser-route.e2e.mjs --name <n>
import { startAuthServer } from '../fixtures/browser-auth/server.mjs';
import { agent, assert, run, sleep, test, until } from './harness.mjs';

const server = await startAuthServer();
const out = async a => (await a.ok('browser_snapshot', {})).match(/paragraph[^:]*: (.*)/)?.[1] ?? '';
/** Clicks "Load cart" and waits until the page shows the outcome. Returns the click result and the outcome. */
async function loadCart(a) {
  const click = await a.ok('browser_click', { selector: '#load' });
  await a.ok('browser_wait_for', { textGone: 'loading', timeout: 20 });
  return { click, shown: await out(a) };
}
const tabOf = text => text.match(/\btab-\d+\b/)[0];

test('a mocked response is what the page gets, and is marked as mocked in the network log', async () => {
  const a = await agent({ session: `route-fulfil-${Date.now()}` });
  try {
    await a.ok('browser_open', { url: server.url('/app') });
    server.reset();
    const added = await a.ok('browser_route', { action: 'add', url: '*/api/cart*', status: 500, body: '{"error":"boom"}' });
    assert.match(added, /^Added m\d+  any \*\/api\/cart\*  → 500, application\/json, 16 B  \(0 hits\) on tab-\d+\./);
    const id = added.match(/m\d+/)[0];
    const { click, shown } = await loadCart(a);
    assert.equal(shown.replace(/ after \d+ ms/, ''), 'status 500 body {"error":"boom"}');
    assert.equal(server.hits('/api/cart'), 0, 'the server never saw the request');
    assert.match(click, new RegExp(`Request failed: GET http://127\\.0\\.0\\.1:\\d+/api/cart → HTTP 500 \\(r\\d+, mocked by ${id} \\(Claude \\d+\\)\\)`));
    const list = await a.ok('browser_network_requests', { filter: 'api/cart' });
    assert.match(list, new RegExp(`GET 500 fetch  /api/cart  \\(.*mocked by ${id}`));
    const detail = await a.ok('browser_network_requests', { id: list.match(/\br\d+\b/)[0] });
    assert.match(detail, new RegExp(`Not a real network response: mocked by ${id}`));
    assert.match(detail, /"error": "boom"/);
    assert.match(await a.ok('browser_route', { action: 'list' }), new RegExp(`${id}  any \\*/api/cart\\*  → 500, application/json, 16 B  \\(1 hit\\)`));
    await a.ok('browser_close_tab', {});
  } finally {
    await a.close();
  }
});

test('network errors, delays, changed request headers and one-shot rules', async () => {
  const a = await agent({ session: `route-kinds-${Date.now()}` });
  try {
    await a.ok('browser_open', { url: server.url('/app') });

    await a.ok('browser_route', { action: 'add', url: 'api/cart', fail: 'refused' });
    assert.match((await loadCart(a)).shown, /^network error/);
    assert.match(await a.ok('browser_network_requests', { filter: 'api/cart', onlyNew: true }), /FAILED \(net::ERR_CONNECTION_REFUSED\).*mocked by m\d+/);
    assert.match(await a.ok('browser_route', { action: 'remove' }), /^Removed m\d+ from tab-\d+\.$/);

    await a.ok('browser_route', { action: 'add', url: 'api/cart', delay: 1500 });
    const delayed = (await loadCart(a)).shown;
    assert.match(delayed, /^status 200 /);
    assert.ok(Number(delayed.match(/after (\d+) ms/)[1]) >= 1400, delayed);
    assert.match(await a.ok('browser_network_requests', { filter: 'api/cart', onlyNew: true }), /delayed by m\d+/);
    await a.ok('browser_route', { action: 'remove' });

    await a.ok('browser_route', { action: 'add', url: 'api/cart', setHeaders: { 'X-Injected': 'yes' } });
    assert.match((await loadCart(a)).shown, /"seenHeader":"yes"/);
    await a.ok('browser_route', { action: 'remove' });

    await a.ok('browser_route', { action: 'add', url: '*/api/cart', method: 'GET', status: 503, times: 1 });
    assert.match((await loadCart(a)).shown, /^status 503/);
    assert.match((await loadCart(a)).shown, /^status 200/, 'the rule removed itself after one request');
    assert.match(await a.ok('browser_route', { action: 'list' }), /You have no request rules on tab-\d+\./);

    const bad = await a.call('browser_route', { action: 'add', url: 'api/cart', status: 500, fail: 'refused' });
    assert.ok(bad.isError);
    assert.match(bad.text, /either a response \(status, headers, body\) or fail, not both/);
    await a.ok('browser_close_tab', {});
  } finally {
    await a.close();
  }
});

test("a session's rules apply only to its tab, other sessions see them, and releasing the tab ends them", async () => {
  const a = await agent({ session: `route-owner-${Date.now()}` });
  const b = await agent({ session: `route-other-${Date.now()}` });
  try {
    const tabA = tabOf(await a.ok('browser_open', { url: server.url('/app') }));
    const id = (await a.ok('browser_route', { action: 'add', url: 'api/cart', status: 500 })).match(/m\d+/)[0];
    const tabB = tabOf(await b.ok('browser_open', { url: server.url('/app') }));
    assert.match((await loadCart(b)).shown, /^status 200/, "a's rule does not touch b's tab");
    assert.match(await b.ok('browser_route', { action: 'list', tab: tabA }), new RegExp(`Claude \\d+ has 1 rule here: ${id} `));
    assert.match(await b.ok('browser_list_tabs', {}), new RegExp(`${tabA} .*1 request rule by Claude \\d+ \\(browser_route\\)`));
    const steal = await b.call('browser_route', { action: 'add', url: 'api/cart', status: 404, tab: tabA });
    assert.ok(steal.isError);
    assert.match(steal.text, /is being controlled by Claude \d+/);

    assert.match(await a.ok('browser_release_tab', {}), new RegExp(`^Released ${tabA}\\. Your request rules there \\(${id}\\) were removed\\.$`));
    assert.match((await loadCart(a)).shown, /^status 200/);
    assert.doesNotMatch(await b.ok('browser_list_tabs', {}), /request rule/);
    await a.ok('browser_close_tab', { tab: tabA });
    await b.ok('browser_close_tab', { tab: tabB });
  } finally {
    await a.close();
    await b.close();
  }
});

test('the user can remove the rules of a tab, and the agent is told', async () => {
  const a = await agent({ session: `route-user-${Date.now()}` });
  try {
    const tab = tabOf(await a.ok('browser_open', { url: server.url('/app') }));
    await a.ok('browser_route', { action: 'add', url: 'api/cart', status: 500 });
    assert.equal(JSON.parse(await a.ok('debug_vscode_command', { command: 'copane.browser.removeRequestRules', args: [tab] })), 1);
    const { click, shown } = await loadCart(a);
    assert.match(shown, /^status 200/);
    assert.match(click, new RegExp(`The user removed your request rules on ${tab} \\(m\\d+\\)`));
    await a.ok('browser_close_tab', {});
  } finally {
    await a.close();
  }
});

test('rules end with their session', async () => {
  const a = await agent({ session: `route-ends-${Date.now()}` });
  const b = await agent({ session: `route-watcher-${Date.now()}` });
  try {
    const tab = tabOf(await a.ok('browser_open', { url: server.url('/app') }));
    await a.ok('browser_route', { action: 'add', url: 'api/cart', status: 500 });
    assert.match(await b.ok('browser_list_tabs', {}), /1 request rule by Claude \d+/);
    await a.close();
    // The session ends after its reconnect grace period (20 s).
    await until(async () => !/request rule/.test(await b.ok('browser_list_tabs', {})), 'the rules to end with the session', { timeoutMs: 40_000, intervalMs: 1000 });
    // The ended session's tab is free to use, and its requests reach the server again.
    await b.ok('browser_select_tab', { tab });
    assert.match((await loadCart(b)).shown, /^status 200/);
    await b.ok('browser_close_tab', { tab });
  } finally {
    await a.close().catch(() => {});
    await b.close();
  }
});

test('cleanup', async () => {
  await sleep(0);
  await server.close();
});

await run();
