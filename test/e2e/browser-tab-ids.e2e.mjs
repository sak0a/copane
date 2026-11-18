// Tab ids across a window reload (browser/tabRestore.ts): tabs the user opened and no agent ever used
// keep their ids without the bridge attaching to them; tabs that cannot be told apart get new ids and
// their old ids fail with a clear message instead of reaching another tab.
//
//   node scripts/dev-host.mjs --name <n>
//   node test/e2e/browser-tab-ids.e2e.mjs --name <n>
//
// Reloads the dev host's window.
import { startFixtureServer } from '../fixtures/pages/server.mjs';
import { agent, assert, run, sleep, test, until } from './harness.mjs';

const site = await startFixtureServer();
const stamp = Date.now();
const url = name => `${site.url}/table.html?ids=${stamp}-${name}`;

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
const number = id => Number(id.slice(4));

/** Waits for the reloaded window and comes back as the same session. */
async function reconnect(key, expectUrl) {
  return until(
    async () => {
      const candidate = await agent({ session: key }).catch(() => undefined);
      if (!candidate) return undefined;
      const r = await candidate.call('browser_list_tabs').catch(() => ({ isError: true }));
      if (r.isError || !r.text.includes(expectUrl)) {
        await candidate.close().catch(() => {});
        return undefined;
      }
      return candidate;
    },
    'the reloaded window',
    { timeoutMs: 60_000, intervalMs: 1000 },
  );
}

test('user tabs no agent used keep their ids after a reload; tabs showing the same page get new ids and old ids fail clearly', async () => {
  const key = `tab-ids-${stamp}`;
  const a = await agent({ session: key });
  let before;
  try {
    await a.ok('browser_open', { url: url('agent'), background: true });
    for (const name of ['first', 'second', 'twin', 'twin']) {
      await a.ok('debug_vscode_command', { command: 'workbench.action.browser.open', args: [url(name)] });
    }
    before = await until(async () => {
      const list = (await tabs(a)).filter(t => t.url.includes(`ids=${stamp}`));
      return list.length === 5 && list;
    }, 'the five tabs');
    assert.equal(before.filter(t => /opened by the user/.test(t.notes)).length, 4);
    await sleep(800); // state is saved shortly after changes
    await a.call('debug_vscode_command', { command: 'workbench.action.reloadWindow' }, { timeoutMs: 5000 }).catch(() => {});
  } finally {
    await a.close().catch(() => {});
  }
  const again = await reconnect(key, url('first'));
  try {
    const after = (await tabs(again)).filter(t => t.url.includes(`ids=${stamp}`));
    const id = (list, name) => list.filter(t => t.url === url(name)).map(t => t.id);
    for (const name of ['agent', 'first', 'second']) assert.deepEqual(id(after, name), id(before, name), `the ${name} tab got another id`);
    // The two tabs showing the same page cannot be told apart: new ids, higher than any id before.
    const oldTwins = id(before, 'twin');
    const newTwins = id(after, 'twin');
    assert.equal(newTwins.length, 2);
    const highest = Math.max(...before.map(t => number(t.id)));
    for (const t of newTwins) assert.ok(number(t) > highest, `a twin tab got ${t}, an id from before the reload`);
    for (const old of oldTwins) {
      const r = await again.call('browser_snapshot', { tab: old });
      assert.ok(r.isError, `${old} still worked: ${r.text}`);
      assert.match(r.text, new RegExp(`^${old} was open before VS Code reloaded the window, but afterwards it could not be told apart from another tab showing the same page`));
    }
    assert.ok(after.find(t => t.url === url('agent')).current, 'the current tab was not restored');
    // Nobody was asked about the user tabs: recognising them needed no access to them.
    const shown = JSON.parse(await again.ok('debug_answer_prompts', {})).shown;
    assert.ok(!shown.some(p => /wants to use/.test(p.message)), JSON.stringify(shown));
  } finally {
    // Closing a user tab asks for consent first, like any use of it.
    const left = (await tabs(again)).filter(t => t.url.includes(`ids=${stamp}`));
    await again.ok('debug_answer_prompts', { answers: left.map(() => 'Allow'), clear: true });
    for (const t of left) await again.call('browser_tab', { action: 'close', tab: t.id });
    await again.ok('debug_answer_prompts', { clear: true });
    await again.close();
  }
});

await run();
