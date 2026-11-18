// Request interception inside cross-origin (out-of-process) iframes (browser/interception.ts with
// page/frames.ts): request rules (browser_route) and login prompts reach requests a frame makes,
// nested frames and frames added later included, from a frame's very first request on; frames that
// go away leave nothing behind; and the cost on a page with many frames stays bounded.
//
//   node scripts/dev-host.mjs --name <n>
//   node test/e2e/browser-frame-requests.e2e.mjs --name <n> [--only <text>]
//
// 127.0.0.1, localhost and [::1] are three sites, so their frames are separate CDP targets
// (test/fixtures/pages/xfetches.html embeds xfetch.html, which fetches /json at once and on a click).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startAuthServer } from '../fixtures/browser-auth/server.mjs';
import { startFixtureServer } from '../fixtures/pages/server.mjs';
import { agent, assert, hostDir, run, sleep, test, until } from './harness.mjs';

const site = await startFixtureServer();
const second = await startFixtureServer({ host: 'localhost' });
const third = await startFixtureServer({ host: '::1' });
const page = (n = 0) => `${site.url}/xfetches.html?b=${encodeURIComponent(second.url)}&c=${encodeURIComponent(third.url)}&n=${n}`;

const settingsFile = join(hostDir, 'ud', 'User', 'settings.json');
const original = readFileSync(settingsFile, 'utf8');
async function setSettings(values) {
  writeFileSync(settingsFile, JSON.stringify({ ...JSON.parse(original), ...values }, null, 2));
  await sleep(3000); // VS Code picks up the file change.
}

/** Runs `fn` with a new agent session that has a blank tab of its own. */
async function withAgent(name, fn) {
  const a = await agent({ session: `frame-req-${name}-${Date.now()}` });
  try {
    await a.ok('browser_open', { url: 'about:blank', background: true });
    await fn(a);
    await a.call('browser_tab', { action: 'close' });
  } finally {
    await a.close();
  }
}

/** Text of an element; the selector may reach into frames with >>>. */
const read = (a, selector) => a.ok('browser_evaluate', { selector, function: 'el => el.textContent' });
const readUntil = (a, selector, pattern, what = `${selector} to match ${pattern}`) =>
  until(async () => {
    const r = await a.call('browser_evaluate', { selector, function: 'el => el.textContent' });
    return !r.isError && pattern.test(r.text) && r.text;
  }, what, { timeoutMs: 15_000, intervalMs: 200 });

test("a rule answers requests of a cross-origin frame and of the frame inside it, from the frame's first request on", async () => {
  await withAgent('mock', async a => {
    const added = await a.ok('browser_route', { action: 'add', url: '*/json?from=*', status: 418, body: '{"mocked":true}' });
    const rule = added.match(/m\d+/)[0];
    await a.ok('browser_navigate', { url: page() });
    // Requested while the frame documents were still being parsed.
    assert.equal(await readUntil(a, '#outer >>> #early', /status/), 'early outer: status 418 {"mocked":true}');
    assert.equal(await readUntil(a, '#outer >>> #inner >>> #early', /status/), 'early outer-inner: status 418 {"mocked":true}');
    // And later, on a click inside the nested frame.
    await a.ok('browser_click', { selector: '#outer >>> #inner >>> #go' });
    assert.equal(await readUntil(a, '#outer >>> #inner >>> #late', /status/), 'late outer-inner: status 418 {"mocked":true}');
    const log = await a.ok('browser_network_requests', { filter: 'from=outer' });
    assert.match(log, new RegExp(`GET 418 fetch  http://\\[::1\\]:\\d+/json\\?from=outer-inner&when=late  \\(.*mocked by ${rule}`), log);
    assert.match(log, new RegExp(`http://localhost:\\d+/json\\?from=outer&when=early  \\(.*mocked by ${rule}`), log);
    assert.match(await a.ok('browser_route', { action: 'list' }), /\(3 hits\)/);
    // Without the rule, the same frames reach the network again.
    await a.ok('browser_route', { action: 'remove' });
    await a.ok('browser_click', { selector: '#outer >>> #go' });
    assert.equal(await readUntil(a, '#outer >>> #late', /status/), 'late outer: status 200 {"items":[1,2,3],"name":"fixture"}');
  });
});

test('frames added later are covered; a frame removed while a request of it is held leaves nothing stuck', async () => {
  await withAgent('later', async a => {
    await a.ok('browser_navigate', { url: page() });
    await readUntil(a, '#outer >>> #early', /status 200/);
    // Hold the outer frame's next request, then remove every frame while it is held.
    await a.ok('browser_route', { action: 'add', url: '*when=late*', delay: 30_000 });
    await a.ok('browser_click', { selector: '#outer >>> #go' });
    await readUntil(a, '#outer >>> #late', /late pending/);
    await a.ok('browser_click', { selector: '#remove' });
    await a.ok('browser_route', { action: 'remove' });
    // A frame added now is served at once, from its first request.
    await a.ok('browser_route', { action: 'add', url: '*from=later*', fail: 'refused' });
    const started = Date.now();
    await a.ok('browser_click', { selector: '#add' });
    assert.match(await readUntil(a, '#later >>> #early', /early later: /), /^early later: error /);
    assert.ok(Date.now() - started < 8000, `the new frame took ${Date.now() - started} ms`);
    assert.match(await a.ok('browser_network_requests', { filter: 'from=later' }), /FAILED \(net::ERR_CONNECTION_REFUSED\).*mocked by m\d+/);
    await a.ok('browser_route', { action: 'remove' });
    await a.ok('browser_click', { selector: '#later >>> #go' });
    assert.match(await readUntil(a, '#later >>> #late', /status/), /status 200/);
  });
});

test('a login asked for by a request inside a cross-origin frame is asked of the user', async () => {
  const s = await startAuthServer();
  try {
    await withAgent('login', async a => {
      await a.ok('debug_answer_prompts', { answers: ['Log In…', 'alice', 'open sesame'], clear: true });
      const before = JSON.parse(await a.ok('debug_answer_prompts', {})).shown.length;
      // The frame (localhost) is another site than the page (127.0.0.1); its script fetches /basic-api.
      await a.ok('browser_navigate', { url: s.url(`/frame?src=${encodeURIComponent(s.url('/xhr', 'localhost'))}`) });
      await until(() => s.authorization('/basic-api'), 'the frame request to carry the login', { timeoutMs: 15_000 });
      assert.equal(s.authorization('/basic-api'), `Basic ${Buffer.from('alice:open sesame').toString('base64')}`);
      const shown = JSON.parse(await a.ok('debug_answer_prompts', {})).shown.slice(before);
      assert.match(shown[0]?.message ?? '', /^localhost:\d+ asks for a login \(realm "Fixture API"\)/, JSON.stringify(shown));
      assert.match(await readUntil(a, 'iframe >>> #out', /^200 /), /"ok":true/);
    });
  } finally {
    await s.close();
  }
});

test('many frames: interception in every frame costs little, and nothing is intercepted while nobody needs it', async () => {
  const FRAMES = 40;
  /** Loads the page with FRAMES extra frames and waits until the last one has its first answer. Returns ms. */
  async function load(a) {
    await a.ok('browser_navigate', { url: 'about:blank' });
    const started = Date.now();
    await a.ok('browser_navigate', { url: page(FRAMES) });
    await readUntil(a, `#extra${FRAMES} >>> #early`, /status/);
    await readUntil(a, '#outer >>> #inner >>> #early', /status/);
    return Date.now() - started;
  }
  const median = xs => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)];
  try {
    await withAgent('cost', async a => {
      await load(a); // warm up (servers, caches)
      // No interception at all: login prompts off, no rules.
      await setSettings({ 'copane.browser.loginPrompts': false });
      const off = [await load(a), await load(a), await load(a)];
      // Every request of every frame paused and decided (a rule matching all of them).
      await a.ok('browser_route', { action: 'add', url: '*', setHeaders: { 'x-probe': '1' } });
      const all = [await load(a), await load(a), await load(a)];
      const requests = (await a.ok('browser_network_requests', { filter: 'json', onlyNew: false })).split('\n').filter(l => /headers changed by/.test(l)).length;
      console.log(`      ${FRAMES + 2} frames, load until all answered: no interception ${off.join('/')} ms, everything intercepted ${all.join('/')} ms (${requests} frame requests decided)`);
      assert.ok(requests >= FRAMES, `only ${requests} requests were intercepted`);
      assert.ok(median(all) < median(off) * 2 + 1500, `interception made the page much slower: ${median(off)} → ${median(all)} ms`);
      await a.ok('browser_route', { action: 'remove' });
    });
  } finally {
    writeFileSync(settingsFile, original);
  }
});

await run();
