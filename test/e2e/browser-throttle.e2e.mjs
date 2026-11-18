// Network and CPU throttling (browser_emulate network/cpu, page/throttle*.ts): that it reaches the page
// and its cross-origin frame, that the bridge keeps working while a tab is offline, how it combines
// with device emulation and request mocks, that browser_audit says so, that it ends with the session's
// control of the tab or the user's reset, and that nothing stays throttled after the extension host
// restarts.
//
//   node scripts/dev-host.mjs --name <n>
//   node test/e2e/browser-throttle.e2e.mjs --name <n> [--only <text>]
//
// The last case restarts the extension host.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { startThrottleServers } from '../fixtures/browser-throttle/server.mjs';
import { agent, assert, hostName, root, run, sleep, test, until } from './harness.mjs';

const server = await startThrottleServers();
let sessions = 0;
const session = name => agent({ session: `throttle-${name}-${Date.now()}-${++sessions}` });

/** Evaluates a function in the page and parses its JSON result (without the notes about failed requests that follow it). */
const page = async (a, fn, tab) => JSON.parse((await a.ok('browser_evaluate', { function: `async () => JSON.stringify(await (${fn})())`, ...(tab ? { tab } : {}) })).split('\n---\n')[0]);
const median = xs => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)];
/** Busy-loop time in the page and in its cross-origin frame (median of 3, ms). */
async function cpu(a, tab) {
  const r = await page(a, `async () => { const p = [], f = []; for (let i = 0; i < 3; i++) { p.push(cpu()); f.push(await frame('cpu')); } return { p, f }; }`, tab);
  return { page: median(r.p), frame: median(r.f) };
}
/** Fetch time of 100 kB in the page and in the frame (each from its own site). */
const net = (a, tab) => page(a, `async () => ({ page: await measure(100), frame: await frame('measure', 100), online: navigator.onLine, frameOnline: await frame('online') })`, tab);
const tabOf = text => /(tab-\d+)/.exec(text)?.[1];
const emulationLabel = async (a, tab) => JSON.parse(await a.ok('debug_extension_eval', { code: `return services.browser.getTab(${JSON.stringify(tab)})?.emulation?.label ?? null;` }));
function titleActions() {
  const out = execFileSync(process.execPath, [join(root, 'scripts', 'ui.mjs'), '--name', hostName, 'eval', `JSON.stringify([...document.querySelectorAll('.editor-actions .action-label')].map(e => e.getAttribute('aria-label') || ''))`], { encoding: 'utf8' });
  return JSON.parse(out);
}

let baseline;

test('network and CPU throttling reach the page and its cross-origin frame; the user sees it', async () => {
  const a = await session('basic');
  try {
    await a.ok('debug_vscode_command', { command: 'notifications.clearAll' });
    const tab = tabOf(await a.ok('browser_open', { url: server.url('/') }));
    const before = await net(a);
    baseline = await cpu(a);
    assert.ok(before.page.ms < 400 && before.frame.ms < 400, JSON.stringify(before));

    const result = await a.ok('browser_emulate', { network: 'slow-4g', cpu: 4 });
    assert.match(result, /now emulates Slow 4G network \(1\.4 Mbit\/s down, 675 kbit\/s up, 563 ms latency\), CPU 4× slower\./);
    assert.match(result, /covers the page and its cross-origin frames; responses mocked with browser_route are not slowed/);
    const slow = await net(a);
    // 100 kB at 1.44 Mbit/s plus 563 ms latency: about 1.1 s.
    assert.ok(slow.page.ms > 800 && slow.frame.ms > 800, `not throttled: ${JSON.stringify(slow)}`);
    const c = await cpu(a);
    assert.ok(c.page > baseline.page * 2.5 && c.frame > baseline.frame * 2.5, `CPU not throttled: ${JSON.stringify({ baseline, c })}`);

    // The user sees it: the tab's label in the views and the editor title button.
    assert.equal(await emulationLabel(a, tab), 'Slow 4G · CPU 4×');
    await a.ok('browser_tab', { action: 'show' });
    assert.ok((await until(() => titleActions().find(l => /End Agent's Device Emulation and Throttling/.test(l)), 'the reset button')));
    assert.match(await a.ok('browser_emulate', {}), /emulates Slow 4G network .*, CPU 4× slower\./);

    assert.match(await a.ok('browser_emulate', { reset: true }), /back to normal/);
    const after = await net(a);
    assert.ok(after.page.ms < 400 && after.frame.ms < 400, JSON.stringify(after));
    const c2 = await cpu(a);
    assert.ok(c2.page < baseline.page * 1.8 && c2.frame < baseline.frame * 1.8, JSON.stringify({ baseline, c2 }));
    assert.equal(await emulationLabel(a, tab), null);
    await a.ok('browser_tab', { action: 'close' });
  } finally {
    await a.close();
  }
});

test('offline: requests fail, navigator.onLine is false in page and frame, and the tools and indicator keep working', async () => {
  const a = await session('offline');
  try {
    await a.ok('browser_open', { url: server.url('/') });
    assert.match(await a.ok('browser_emulate', { network: 'offline' }), /now emulates offline\..*which see navigator\.onLine false/s);
    const r = await net(a);
    assert.deepEqual([r.page.ok, r.frame.ok, r.online, r.frameOnline], [false, false, false, false], JSON.stringify(r));
    assert.match(r.page.error, /Failed to fetch/);
    // The bridge talks to the page over CDP, not the network: snapshot, click and evaluate still work.
    const snap = await a.ok('browser_snapshot', {});
    assert.match(snap, /paragraph: offline/);
    assert.match(snap, /Frame on another site/);
    const ref = /heading "Throttle fixture" \[level=1\] \[ref=(e\d+)\]/.exec(snap)?.[1];
    await a.ok('browser_click', { ref });
    assert.equal(await a.ok('browser_evaluate', { function: '() => String(!!document.querySelector("[data-copane-ui]"))' }), 'true');
    const failed = await a.ok('browser_network_requests', { status: 'failed' });
    assert.match(failed, /FAILED \(net::ERR_INTERNET_DISCONNECTED\)/);
    // Back online: the page fires "online".
    await a.ok('browser_emulate', { network: 'none' });
    assert.equal(await a.ok('browser_evaluate', { function: '() => document.getElementById("online").textContent' }), 'online');
    assert.equal((await net(a)).page.ok, true);
    await a.ok('browser_tab', { action: 'close' });
  } finally {
    await a.close();
  }
});

test('combines with device emulation; network, CPU and device end on their own and together', async () => {
  const a = await session('combine');
  try {
    await a.ok('browser_open', { url: server.url('/') });
    const all = await a.ok('browser_emulate', { preset: 'iphone-se', network: '3g', cpu: 6 });
    assert.match(all, /now emulates iPhone SE \(375×667 CSS px at 2×, mobile with touch\), 3G network \(400 kbit\/s down, 400 kbit\/s up, 2000 ms latency\), CPU 6× slower\. The viewport is 375×667/);
    assert.equal(await a.ok('browser_evaluate', { function: '() => String(screen.width)' }), '375');

    assert.match(await a.ok('browser_emulate', { cpu: 1 }), /now emulates iPhone SE .*, 3G network .*\.(?! CPU)/);
    const c = await cpu(a);
    assert.ok(c.page < baseline.page * 2, `CPU still throttled: ${JSON.stringify(c)}`);
    assert.ok((await net(a)).page.ms > 1800, 'network should still be 3G');

    assert.match(await a.ok('browser_emulate', { network: 'fast-4g', cpu: 4, preset: 'none' }), /now emulates Fast 4G network .*, CPU 4× slower\./);
    assert.notEqual(await a.ok('browser_evaluate', { function: '() => String(screen.width)' }), '375');
    assert.ok((await cpu(a)).page > baseline.page * 2.5);

    // Explicit numbers: 800 kbit/s down, 400 up, 300 ms latency.
    assert.match(await a.ok('browser_emulate', { network: '800/400/300' }), /throttled network \(800 kbit\/s down, 400 kbit\/s up, 300 ms latency\)/);
    const custom = await net(a);
    assert.ok(custom.page.ms > 1000, JSON.stringify(custom)); // 100 kB at 100 kB/s plus latency
    const bad = await a.call('browser_emulate', { network: '2g' });
    assert.ok(bad.isError);
    assert.match(bad.text, /use offline, 3g, slow-4g, fast-4g, none/);

    assert.match(await a.ok('browser_emulate', { reset: true }), /back to normal/);
    assert.ok((await net(a)).page.ms < 400);
    assert.ok((await cpu(a)).page < baseline.page * 1.8);
    await a.ok('browser_tab', { action: 'close' });
  } finally {
    await a.close();
  }
});

test('mocked responses (browser_route) are not slowed and still arrive offline; passed-through requests are throttled', async () => {
  const a = await session('route');
  try {
    await a.ok('browser_open', { url: server.url('/') });
    await a.ok('browser_route', { action: 'add', url: '*/blob?kb=1&*', body: 'mocked' });
    await a.ok('browser_emulate', { network: '3g' });
    const mocked = await page(a, `() => measure(1)`);
    assert.deepEqual([mocked.ok, mocked.bytes], [true, 6]);
    assert.ok(mocked.ms < 1000, `a mocked response was slowed: ${mocked.ms} ms`);
    const real = await page(a, `() => measure(2)`);
    assert.ok(real.ms > 1800, `a real request was not throttled: ${real.ms} ms`);
    await a.ok('browser_emulate', { network: 'offline' });
    const offline = await page(a, `() => measure(1)`);
    assert.deepEqual([offline.ok, offline.bytes], [true, 6], JSON.stringify(offline));
    assert.equal((await page(a, `() => measure(2)`)).ok, false);
    await a.ok('browser_route', { action: 'remove' });
    await a.ok('browser_emulate', { reset: true });
    await a.ok('browser_tab', { action: 'close' });
  } finally {
    await a.close();
  }
});

test('a performance audit says it was measured under throttling', async () => {
  const a = await session('audit');
  try {
    await a.ok('browser_open', { url: server.url('/') });
    assert.match(await a.ok('browser_audit', { type: 'performance' }), /without CPU or network throttling/);
    await a.ok('browser_emulate', { cpu: 4 });
    assert.match(await a.ok('browser_audit', { type: 'performance' }), /Throttled \(browser_emulate\) now: CPU 4× slower, but the page loaded before that, so the load numbers are not throttled/);
    await a.ok('browser_emulate', { network: 'slow-4g' });
    const reloaded = await a.ok('browser_audit', { type: 'performance', reload: true });
    assert.match(reloaded, /Throttled \(browser_emulate\): Slow 4G network .* and CPU 4× slower\. These numbers were measured under it/);
    assert.match(reloaded, /with the throttling above/);
    await a.ok('browser_emulate', { reset: true });
    await a.ok('browser_tab', { action: 'close' });
  } finally {
    await a.close();
  }
});

test('throttling ends when the session releases the tab, and when the user resets it', async () => {
  const a = await session('release');
  try {
    const tab = tabOf(await a.ok('browser_open', { url: server.url('/') }));
    await a.ok('browser_emulate', { network: 'offline', cpu: 4 });
    await a.ok('browser_tab', { action: 'release', tab });
    await until(async () => (await emulationLabel(a, tab)) === null, 'emulation to end on release');
    const r = await net(a, tab);
    assert.deepEqual([r.page.ok, r.frame.ok, r.online, r.frameOnline], [true, true, true, true], JSON.stringify(r));
    assert.ok((await cpu(a, tab)).frame < baseline.frame * 1.8);
    assert.match(await a.ok('browser_emulate', { tab }), /earlier emulation of tab-\d+ had ended: control of tab-\d+ ended/);

    await a.ok('browser_emulate', { tab, network: 'slow-4g', cpu: 4 });
    await a.ok('debug_vscode_command', { command: 'copane.browser.resetEmulation', args: [tab] });
    await until(async () => (await emulationLabel(a, tab)) === null, 'emulation to end on the user\'s reset');
    assert.ok((await net(a, tab)).frame.ms < 400);
    assert.ok((await cpu(a, tab)).page < baseline.page * 1.8);
    assert.match(await a.ok('browser_emulate', { tab }), /had ended: the user reset it/);
    await a.ok('browser_tab', { action: 'close', tab });
  } finally {
    await a.close();
  }
});

test('after the extension host restarts, no tab stays throttled or offline (also throttling it never undid)', async () => {
  const a = await session('restart');
  try {
    // "managed": throttled by browser_emulate. "raw": throttled behind the bridge's back on the page
    // and its frame, and marked as the bridge marks a tab before throttling it, as if the extension
    // host had crashed before it could undo it.
    const managed = tabOf(await a.ok('browser_open', { url: server.url('/?managed'), background: true }));
    const raw = tabOf(await a.ok('browser_open', { url: server.url('/?raw'), background: true }));
    await a.ok('browser_emulate', { tab: managed, network: 'offline', cpu: 4 });
    const targets = JSON.parse(await a.ok('debug_cdp', { tab: raw, commands: [{ method: 'Target.getTargets' }] })).out[0].result.targetInfos;
    const frameTarget = targets.find(t => t.type === 'iframe').targetId;
    const frameSession = JSON.parse(await a.ok('debug_cdp', { tab: raw, commands: [{ method: 'Target.attachToTarget', params: { targetId: frameTarget, flatten: true } }] })).out[0].result.sessionId;
    const offline = { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 };
    await a.ok('debug_cdp', {
      tab: raw,
      commands: [
        { method: 'Emulation.setCPUThrottlingRate', params: { rate: 4 } },
        { method: 'Network.emulateNetworkConditions', params: offline },
        { session: frameSession, method: 'Emulation.setCPUThrottlingRate', params: { rate: 4 } },
        { session: frameSession, method: 'Network.emulateNetworkConditions', params: offline },
      ],
    });
    await a.ok('debug_extension_eval', { code: `const k = 'copane.browser.throttledTabs'; await services.context.workspaceState.update(k, { ...services.context.workspaceState.get(k), ${JSON.stringify(raw)}: Date.now() });` });
    const state = tab => page(a, `async () => ({ cpu: cpu(), frameCpu: await frame('cpu'), online: navigator.onLine, frameOnline: await frame('online') })`, tab);
    for (const tab of [managed, raw]) {
      const s = await state(tab);
      assert.ok(s.cpu > baseline.page * 2.5 && s.frameCpu > baseline.frame * 2.5 && !s.online && !s.frameOnline, `${tab} not throttled before: ${JSON.stringify(s)}`);
    }

    await a.call('debug_vscode_command', { command: 'workbench.action.restartExtensionHost' });
    await sleep(3000);
    await until(async () => !(await a.call('browser_list_tabs', {})).isError, 'the extension host to come back', { timeoutMs: 60_000, intervalMs: 1000 });
    for (const tab of [managed, raw]) {
      const s = await until(async () => {
        const r = await a.call('browser_evaluate', { tab, function: `async () => JSON.stringify({ cpu: cpu(), frameCpu: await frame('cpu'), online: navigator.onLine, frameOnline: await frame('online') })` });
        if (r.isError) return undefined;
        const v = JSON.parse(r.text.split('\n---\n')[0]);
        return v.cpu < baseline.page * 1.8 && v.frameCpu < baseline.frame * 1.8 && v.online && v.frameOnline ? v : undefined;
      }, `${tab} to be neither throttled nor offline after the restart`, { timeoutMs: 20_000, intervalMs: 1000 });
      assert.ok(s);
    }
    assert.deepEqual(JSON.parse(await a.ok('debug_extension_eval', { code: `return services.context.workspaceState.get('copane.browser.throttledTabs') ?? {};` })), {});
    for (const tab of [managed, raw]) await a.call('browser_tab', { action: 'close', tab });
  } finally {
    await a.close();
  }
});

await run();
