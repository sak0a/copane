// HAR export (browser_network_requests with har, page/har*.ts): a valid HAR 1.2 file of the page and
// its cross-origin frame, secrets masked by default, bodies on request, requests from a hand-off kept
// withheld, and the rules for where the file may be written.
//
//   node scripts/dev-host.mjs --name <n>
//   node test/e2e/browser-har.e2e.mjs --name <n> [--only <text>]
//
// Files are written into the dev host's workspace (<dev host>/ws/har-e2e/) and removed at the end.
// With HAR_VALIDATOR=<dir with node_modules/har-validator> each file is also checked by that
// independent validator (npm i har-validator in a temporary directory).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SECRETS, startHarServers } from '../fixtures/browser-har/server.mjs';
import { agent, assert, hostDir, run, test } from './harness.mjs';

const server = await startHarServers();
const dir = join(hostDir, 'ws', 'har-e2e');
rmSync(dir, { recursive: true, force: true });
const validator = process.env.HAR_VALIDATOR ? createRequire(join(process.env.HAR_VALIDATOR, 'x.js'))('har-validator') : undefined;

const a = await agent({ session: `har-${Date.now()}` });
const read = name => readFileSync(join(dir, name), 'utf8');
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

/** The HAR 1.2 structure (required fields and types), plus the independent validator when given. */
async function checkHar(text) {
  const har = JSON.parse(text);
  const log = har.log;
  assert.equal(log.version, '1.2');
  assert.equal(log.creator.name, 'Copane');
  assert.equal(typeof log.creator.version, 'string');
  assert.ok(Array.isArray(log.pages) && Array.isArray(log.entries));
  for (const p of log.pages) {
    assert.match(p.startedDateTime, ISO);
    assert.equal(typeof p.id, 'string');
    assert.equal(typeof p.title, 'string');
    for (const k of ['onContentLoad', 'onLoad']) assert.ok(p.pageTimings[k] === -1 || p.pageTimings[k] >= 0, k);
  }
  const pageIds = new Set(log.pages.map(p => p.id));
  for (const e of log.entries) {
    assert.match(e.startedDateTime, ISO);
    if (e.pageref !== undefined) assert.ok(pageIds.has(e.pageref), e.pageref);
    assert.ok(e.time >= 0);
    for (const k of ['method', 'url', 'httpVersion']) assert.equal(typeof e.request[k], 'string', k);
    for (const k of ['cookies', 'headers', 'queryString']) assert.ok(Array.isArray(e.request[k]), k);
    for (const k of ['headersSize', 'bodySize']) assert.equal(typeof e.request[k], 'number', k);
    assert.equal(typeof e.response.status, 'number');
    for (const k of ['statusText', 'httpVersion', 'redirectURL']) assert.equal(typeof e.response[k], 'string', k);
    for (const k of ['cookies', 'headers']) assert.ok(Array.isArray(e.response[k]), k);
    assert.equal(typeof e.response.content.size, 'number');
    assert.equal(typeof e.response.content.mimeType, 'string');
    assert.deepEqual(e.cache, {});
    for (const k of ['send', 'wait', 'receive']) assert.ok(e.timings[k] >= 0, `${k} ${e.timings[k]}`);
    for (const k of ['blocked', 'dns', 'connect', 'ssl']) assert.ok(e.timings[k] === -1 || e.timings[k] >= 0, `${k} ${e.timings[k]}`);
  }
  if (validator) await validator.har(har);
  return log;
}

const byPath = (log, path) => log.entries.filter(e => new URL(e.request.url).pathname === path);
const noSecrets = (text, except = []) => {
  for (const [kind, value] of Object.entries(SECRETS)) if (!except.includes(kind)) assert.ok(!text.includes(value), `${kind} secret ${value} is in the file`);
};

let tab;
test('default: a valid HAR 1.2 of the page and its cross-origin frame, secrets masked, no bodies', async () => {
  tab = /Opened (tab-\d+)/.exec(await a.ok('browser_open', { url: server.url('/') }))[1];
  // A reload, so the log also has the document request (the first load starts before the bridge attaches).
  await a.ok('browser_navigate', { action: 'reload' });
  assert.equal(await a.ok('browser_evaluate', { function: '() => window.done' }), 'done');
  const result = await a.ok('browser_network_requests', { har: 'har-e2e/default.har' });
  assert.match(result, /^Wrote har-e2e[\\/]default\.har \([\d.]+ kB\): \d+ requests \(\d+ from cross-origin frames\) on \d+ pages?, HAR 1\.2\./);
  assert.match(result, /Masked: .*cookies \(sid, theme\).*Authorization headers are never recorded\. harInclude \["secrets"\] keeps the values, which you can then read too\./);
  assert.match(result, /query parameters \(access_token\)/);
  assert.match(result, /headers \(X-Api-Key\)/);
  assert.match(result, /form and JSON fields \(password\)/);
  assert.match(result, /Response bodies are not included; harInclude \["bodies"\] adds/);
  assert.ok(result.length < 1200, 'the result is a summary, not the content');
  const text = read('default.har');
  noSecrets(text);
  const log = await checkHar(text);

  const page = log.pages.at(-1);
  assert.equal(page.title, 'HAR fixture');
  assert.ok(page.pageTimings.onContentLoad > 0 && page.pageTimings.onLoad >= page.pageTimings.onContentLoad, JSON.stringify(page.pageTimings));
  const [doc] = byPath(log, '/').filter(e => e.pageref === page.id);
  assert.equal(doc._resourceType, 'document');
  assert.equal(doc.response.status, 200);
  // Chromium reports Set-Cookie only in an extra event the network log does not record; if it is there, it is masked.
  assert.ok(doc.response.cookies.every(c => c.value === '(masked)'));
  const [api] = byPath(log, '/api/items').filter(e => e.pageref === page.id);
  assert.deepEqual(api.request.queryString, [{ name: 'q', value: 'shoes' }, { name: 'access_token', value: '(masked)' }]);
  assert.equal(api.request.headers.find(h => h.name === 'Authorization')?.value, 'Bearer (credentials hidden)');
  assert.equal(api.request.headers.find(h => h.name === 'X-Api-Key')?.value, '(masked)');
  assert.ok(api.request.cookies.every(c => c.value === '(masked)') && api.request.cookies.some(c => c.name === 'sid'));
  assert.ok(api.timings.wait >= 0 && api.time > 0);
  const [login] = byPath(log, '/login').filter(e => e.pageref === page.id);
  assert.equal(login.request.postData.text, 'user=ann&password=(masked)&remember=1');
  const [frameApi] = byPath(log, '/frame-api').filter(e => e.pageref === page.id);
  assert.ok(frameApi._frameId, 'the frame request is marked with its frame');
  assert.ok(log.entries.every(e => e.response.content.text === undefined), 'no bodies by default');
});

test('bodies: included for the current page, still masked in JSON; too large or gone ones are listed as missing', async () => {
  const result = await a.ok('browser_network_requests', { har: 'har-e2e/bodies.har', harInclude: ['bodies'] });
  assert.match(result, /Response bodies: \d+ included; not included: .*1 over 2\.0 MB each/);
  assert.match(result, /HTML, scripts and other text are as the server sent them/);
  const text = read('bodies.har');
  noSecrets(text);
  const log = await checkHar(text);
  const page = log.pages.at(-1).id;
  const api = byPath(log, '/api/items').find(e => e.pageref === page);
  assert.deepEqual(JSON.parse(api.response.content.text), { items: [1, 2, 3], access_token: '(masked)' });
  const config = byPath(log, '/config').find(e => e.pageref === page);
  assert.deepEqual(Object.values(JSON.parse(config.response.content.text)), ['(masked)', '(masked)', '(masked)', '(masked)']);
  const pixel = byPath(log, '/pixel.png').find(e => e.pageref === page);
  assert.equal(pixel.response.content.encoding, 'base64');
  assert.equal(Buffer.from(pixel.response.content.text, 'base64').subarray(1, 4).toString(), 'PNG');
  assert.match(byPath(log, '/big').find(e => e.pageref === page).response.content.comment, /over 2\.0 MB each/);

  // After another page has loaded, the browser no longer has the earlier page's bodies.
  await a.ok('browser_navigate', { url: server.url('/second') });
  const later = await a.ok('browser_network_requests', { har: 'har-e2e/later.har', harInclude: ['bodies'], filter: 'api/items' });
  assert.match(later, /not included: \d+ no longer kept by the browser \(an earlier page/);
  await checkHar(read('later.har'));
});

test('secrets: kept when asked (Authorization is never recorded), and the result says so', async () => {
  await a.ok('browser_navigate', { url: server.url('/') });
  assert.equal(await a.ok('browser_evaluate', { function: '() => window.done' }), 'done');
  const result = await a.ok('browser_network_requests', { har: 'har-e2e/secrets.har', harInclude: ['secrets', 'bodies'] });
  assert.match(result, /Nothing was masked \(Authorization headers are never recorded, only their scheme\)\. Treat the file as secret\./);
  const text = read('secrets.har');
  for (const kind of ['cookie', 'query', 'header', 'password', 'bodyToken']) assert.ok(text.includes(SECRETS[kind]), `${kind} is kept`);
  const log = await checkHar(text);
  const api = byPath(log, '/api/items').at(-1);
  assert.equal(api.request.headers.find(h => h.name === 'Authorization')?.value, 'Bearer (credentials hidden)');
});

test('filters apply: only the matching requests are written', async () => {
  const result = await a.ok('browser_network_requests', { har: 'har-e2e/fetches.har', types: ['fetch'], filter: '127.0.0.1' });
  assert.match(result, /Wrote har-e2e[\\/]fetches\.har .*: \d+ requests on/);
  const log = await checkHar(read('fetches.har'));
  assert.ok(log.entries.length >= 4);
  assert.ok(log.entries.every(e => e._resourceType === 'fetch' && e.request.url.includes('127.0.0.1')), JSON.stringify(log.entries.map(e => e.request.url)));
});

test('requests sent while the user had the tab stay withheld in the HAR, also with secrets', async () => {
  await a.ok('browser_navigate', { url: server.url('/handoff') });
  const handoff = await a.ok('browser_request_user_input', { message: 'Please sign in', done_when: { text: 'Signed in' }, timeout_seconds: 30 }, { timeoutMs: 60_000 });
  assert.match(handoff, /yours again/);
  const result = await a.ok('browser_network_requests', { har: 'har-e2e/handoff.har', harInclude: ['secrets', 'bodies'] });
  assert.match(result, /\d+ requests? (was|were) sent while the user had the tab: in the file without URL query, headers or bodies\./);
  const text = read('handoff.har');
  assert.ok(!text.includes(SECRETS.handoff), 'the hand-off secret is in the file');
  const log = await checkHar(text);
  const token = byPath(log, '/api/token').at(-1);
  assert.equal(token.request.url, `${server.url('/api/token')}?…`);
  assert.deepEqual([token.request.headers, token.request.queryString, token.response.headers, token.request.postData, token.response.content.text], [[], [], [], undefined, undefined]);
  assert.match(token.comment, /withheld/);
});

test('where it may be written: inside the workspace, .har, never over a file it did not write', async () => {
  const outside = await a.call('browser_network_requests', { har: join(tmpdir(), `copane-har-e2e-${Date.now()}.har`) });
  assert.ok(outside.isError);
  assert.match(outside.text, /is outside your working directory and the workspace folders/);
  const ext = await a.call('browser_network_requests', { har: 'har-e2e/network.json' });
  assert.match(ext.text, /must end in \.har/);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'theirs.har'), '{"log":{"version":"1.2","creator":{"name":"Chrome"}}}');
  const theirs = await a.call('browser_network_requests', { har: 'har-e2e/theirs.har' });
  assert.ok(theirs.isError);
  assert.match(theirs.text, /exists and was not written by browser_network_requests; pick another path \(it is never overwritten\)/);
  assert.equal(read('theirs.har'), '{"log":{"version":"1.2","creator":{"name":"Chrome"}}}');
  // Its own file it overwrites.
  assert.match(await a.ok('browser_network_requests', { har: 'har-e2e/default.har' }), /^Wrote har-e2e[\\/]default\.har/);
  const stray = await a.call('browser_network_requests', { harInclude: ['bodies'] });
  assert.match(stray.text, /harInclude applies only with har/);
  assert.ok(!existsSync(join(tmpdir(), 'har-e2e')));
});

test('cleanup', async () => {
  await a.call('browser_tab', { action: 'close', tab });
  rmSync(dir, { recursive: true, force: true });
  await a.close();
});

await run();
