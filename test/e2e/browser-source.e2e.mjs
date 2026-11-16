// browser_inspect (src/extension/browser/page/source*.ts) against a running dev host:
//
//   node scripts/dev-host.mjs --name source
//   node test/e2e/browser-source.e2e.mjs --name source [--only <text>]
//
// The fixture pages (test/fixtures/browser-source) fake the development data of React 18 and 19, Vue 2
// and 3, Svelte 4 and 5 and inspector plugins in the page's own world; the project files they name
// (test/fixtures/browser-source/project/src) are copied into the dev host's workspace folder first, as
// <workspace>/source-app/src/..., so the answers can be checked against real workspace paths. The
// second origin (localhost) serves the cross-origin frame.
import { cpSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { startSourceServer } from '../fixtures/browser-source/server.mjs';
import { agent, assert, hostDir, root, run, test } from './harness.mjs';

const a = await agent({ session: `browser-source-${Date.now()}` });
// The window's own workspace folder: /tmp/copane-dev/<name>/ws in a local dev host, /ws in a remote one
// (where this test runs inside the container, next to the files).
const workspace = JSON.parse(await a.ok('debug_extension_eval', { code: 'return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;' })) ?? join(hostDir, 'ws');
mkdirSync(join(workspace, 'source-app'), { recursive: true });
cpSync(join(root, 'test', 'fixtures', 'browser-source', 'project', 'src'), join(workspace, 'source-app', 'src'), { recursive: true });

const site = await startSourceServer();
const other = await startSourceServer({ host: 'localhost' });
const page = (name, extra = {}) => `${site.url}/${name}?${new URLSearchParams({ root: workspace, ...extra })}`;

/** Result sizes, printed at the end (they are read by a model). */
const sizes = [];

let previous;
async function open(url) {
  if (previous) await a.call('browser_close_tab', { tab: previous });
  const text = await a.ok('browser_open', { url, background: true });
  const id = /Opened (tab-\d+)/.exec(text)?.[1];
  assert.ok(id, `no tab id in: ${text}`);
  previous = id;
  return id;
}

async function inspect(args, what) {
  const text = await a.ok('browser_inspect', args);
  sizes.push(`${what}: ${text.length} chars`);
  return text;
}

/** Asserts the numbered entries, in order, as "<n>. <rest>" prefixes. */
function entries(text, expected) {
  const lines = text.split('\n').filter(l => /^\d+\. /.test(l));
  assert.equal(lines.length, expected.length, `expected ${expected.length} entries in:\n${text}`);
  expected.forEach((e, i) => assert.ok(lines[i].startsWith(`${i + 1}. ${e}`), `entry ${i + 1} should start with "${i + 1}. ${e}" in:\n${text}`));
}

test('Vue 3: the inspector attribute first, then the components innermost first; a foreign path maps by suffix', async () => {
  await open(page('vue3.html'));
  const text = await inspect({ selector: '#save' }, 'Vue 3');
  assert.match(text, /^Source of button "Save" \(selector "#save"\) \(Vue 3, development build\):/);
  entries(text, [
    '<button> source-app/src/components/SaveButton.vue:14:5 (data-v-inspector)',
    'SaveButton source-app/src/components/SaveButton.vue',
    'EditorToolbar source-app/src/components/EditorToolbar.vue',
    // __file is /home/build/app/src/components/Toolbar.vue: matched by its trailing segments.
    'Toolbar source-app/src/components/Toolbar.vue',
    'App source-app/src/App.vue',
  ]);
  assert.match(text, /Paths are relative to the workspace folder "ws"\. Vue gives files, not lines, for components\./);
});

test('Vue 3: a path that is in no workspace folder is shown as given and said so', async () => {
  await open(page('vue3.html'));
  const text = await inspect({ selector: '#lone' }, 'Vue 3, not found');
  entries(text, ['Gone /home/build/app/src/components/Gone.vue (not found in the workspace folders)', 'App source-app/src/App.vue']);
});

test('Vue 2: __vue__ and $options.__file, up the $parent chain', async () => {
  await open(page('vue2.html'));
  const text = await inspect({ selector: '#hint' }, 'Vue 2');
  assert.match(text, /\(Vue 2, development build\):/);
  entries(text, ['LegacyPanel source-app/src/components/LegacyPanel.vue', 'App source-app/src/App.vue', 'Root']);
});

test('React 18: _debugSource along the owners; a wrapper rendering children is not credited with the element', async () => {
  await open(page('react18.html'));
  const text = await inspect({ selector: '#add' }, 'React 18');
  assert.match(text, /\(React, development build\):/);
  entries(text, ['Card source-app/src/components/Card.jsx:7:7 (where the element is written)', 'List source-app/src/components/List.jsx:8:11', 'App source-app/src/App.jsx:6:7']);
  assert.doesNotMatch(text, /Layout/);
});

test('React 19: _debugStack through the source map; library components are counted, not listed', async () => {
  await open(page('react19.html'));
  const snap = await a.ok('browser_snapshot');
  const ref = /button "Add to cart" \[ref=(e\d+)\]/.exec(snap)?.[1];
  assert.ok(ref, snap);
  const text = await inspect({ ref }, 'React 19');
  assert.match(text, new RegExp(`^Source of button "Add to cart" \\[ref=${ref}\\] \\(React 19, development build; lines from source maps\\):`));
  entries(text, ['Card source-app/src/components/Card.jsx:7:7 (where the element is written)', 'List source-app/src/components/List.jsx:8:11', 'App source-app/src/App.jsx:6:7']);
  assert.match(text, /\n1 library component left out \(node_modules\)\./);
  // After a reload (a new document, so the maps are loaded again), the page's own requests are in the
  // tab's network log, and the bridge's loads of scripts and maps are not.
  await a.ok('browser_history', { action: 'reload' });
  await inspect({ selector: '#add' }, 'React 19 after reload');
  const log = await a.ok('browser_network_requests', { includeStatic: true });
  assert.match(log, /bundle\.js/);
  assert.doesNotMatch(log, /bundle\.js\.map/);
});

test('React 19: a missing source map leaves the bundled locations and says why once', async () => {
  await open(page('react19.html'));
  const text = await inspect({ selector: '#add-nomap' }, 'React 19, map 404');
  assert.match(text, /\(React 19, development build\):/);
  entries(text, ['Card /assets/bundle-nomap.js:3:28 (where the element is written)', 'List /assets/bundle-nomap.js:4:28', 'App /assets/bundle-nomap.js:5:27']);
  assert.match(text, /\nSource map not found: \/assets\/bundle-nomap\.js\.map answered 404, so those lines are in the bundled script; search the workspace for the component names\./);
});

test('Svelte 4 (0-based lines) and Svelte 5 (1-based, with the component chain)', async () => {
  await open(page('svelte.html'));
  const v4 = await inspect({ selector: '#s4' }, 'Svelte 4');
  assert.match(v4, /\(Svelte 4, development build\):/);
  entries(v4, ['Child source-app/src/Child.svelte:7:3 (where the element is written)']);
  const v5 = await inspect({ selector: '#s5' }, 'Svelte 5');
  assert.match(v5, /\(Svelte 5, development build\):/);
  entries(v5, ['Child source-app/src/Child.svelte:7:3 (where the element is written)', 'App source-app/src/App.svelte:8:5 (renders <Child>)']);
  const prod = await inspect({ selector: '#sprod' }, 'Svelte production');
  assert.match(prod, /^No source locations for button "Buy \(production\)".*Svelte is present \(svelte-xxxx classes, no __svelte_meta\), but this is a production build.*"Buy \(production\)"/);
});

test('inspector attributes alone: data-insp-path, and react-dev-inspector on an ancestor', async () => {
  await open(page('attrs.html'));
  const insp = await inspect({ selector: '#insp' }, 'data-insp-path');
  assert.match(insp, /\(inspector attribute data-insp-path\):/);
  entries(insp, ['<button> source-app/src/components/Card.jsx:7:7 (data-insp-path)']);
  const rdi = await inspect({ selector: '#inner' }, 'react-dev-inspector');
  entries(rdi, ['<section> source-app/src/components/Layout.jsx:4:5 (react-dev-inspector, on an ancestor)']);
});

test('production builds say so and suggest the text to search for', async () => {
  await open(`${site.url}/prod-react.html`);
  const react = await inspect({ selector: '#add' }, 'React production');
  assert.equal(
    react,
    'No source locations for button "Add to cart" (selector "#add"): React is present, but this is a production build (no file locations; component names are minified). Open the app from its development server for locations, or search the workspace for the element\'s text: "Add to cart" (id "add", data-testid "add-to-cart").',
  );
  await open(`${site.url}/prod-vue.html`);
  const vue = await inspect({ selector: '#buy' }, 'Vue production');
  assert.match(vue, /Vue 3 is present \(data-v-app\), but this is a production build.*"Buy now" \(id "buy"\)\.$/);
});

test('no framework information: says so and suggests the text (ref from a snapshot)', async () => {
  await open(`${site.url}/plain.html`);
  const snap = await a.ok('browser_snapshot');
  const ref = /heading "Pricing plans for teams" \[level=1\] \[ref=(e\d+)\]/.exec(snap)?.[1];
  assert.ok(ref, snap);
  const text = await inspect({ ref }, 'none');
  assert.equal(
    text,
    `No framework information for heading "Pricing plans for teams" [ref=${ref}]: neither it nor its ancestors carry React, Vue or Svelte development data or inspector attributes (plain or server-rendered HTML, another framework, or a production build). Search the workspace for its text instead: "Pricing plans for teams" (classes "hero-title").`,
  );
});

test('an element in a cross-origin frame', async () => {
  await open(`${site.url}/xframe.html?${new URLSearchParams({ root: workspace, other: other.url })}`);
  await a.ok('browser_wait_for', { selector: '#save', state: 'visible' });
  const text = await inspect({ selector: '#save' }, 'cross-origin frame');
  assert.match(text, /^Source of button "Save" \(selector "#save" in the frame .*localhost.*\) \(Vue 3, development build\):/);
  entries(text, [
    '<button> source-app/src/components/SaveButton.vue:14:5 (data-v-inspector)',
    'SaveButton source-app/src/components/SaveButton.vue',
    'EditorToolbar source-app/src/components/EditorToolbar.vue',
    'Toolbar source-app/src/components/Toolbar.vue',
    'App source-app/src/App.vue',
  ]);
});

test('source maps of a script in a cross-origin frame are loaded through that frame', async () => {
  // react19.html served by the second origin, inside a frame of the first.
  await open(`${site.url}/xframe.html?${new URLSearchParams({ root: workspace, other: other.url, page: 'react19.html' })}`);
  await a.ok('browser_wait_for', { selector: '#add', state: 'visible' });
  const text = await inspect({ selector: '#add' }, 'React 19 in a frame');
  assert.match(text, /in the frame .*localhost.*\(React 19, development build; lines from source maps\):/);
  entries(text, ['Card source-app/src/components/Card.jsx:7:7 (where the element is written)', 'List source-app/src/components/List.jsx:8:11', 'App source-app/src/App.jsx:6:7']);
});

test('paths written with backslashes (as on a Windows dev server) map too', async () => {
  await open(page('vue3.html', { win: '1' }));
  const text = await inspect({ selector: '#save' }, 'backslashes');
  entries(text, [
    '<button> source-app/src/components/SaveButton.vue:14:5',
    'SaveButton source-app/src/components/SaveButton.vue',
    'EditorToolbar source-app/src/components/EditorToolbar.vue',
    'Toolbar source-app/src/components/Toolbar.vue',
    'App source-app/src/App.vue',
  ]);
});

test('without ref or selector: a clear error', async () => {
  await open(`${site.url}/plain.html`);
  const result = await a.call('browser_inspect', {});
  assert.ok(result.isError);
  assert.equal(result.text, 'Pass the element: ref (from browser_snapshot) or selector.');
});

test('the tool is read-only: another session inspects while the first controls the tab', async () => {
  const tab = await open(page('vue3.html'));
  await a.ok('browser_click', { selector: '#title' });
  const b = await agent({ session: `browser-source-b-${Date.now()}` });
  try {
    const listed = await b.ok('browser_list_tabs');
    assert.match(listed, new RegExp(tab));
    const result = await b.call('browser_inspect', { selector: '#save', tab });
    // Another session's tab may need consent; it must never be refused as busy.
    assert.doesNotMatch(result.text, /busy|controlled by/i, result.text);
    assert.ok(!result.isError, result.text);
    assert.match(result.text, /^Source of button "Save"/);
  } finally {
    await b.close();
  }
});

test('Svelte 5.0-5.35 (no parent chain, no char) is read as Svelte 5 with 1-based lines', async () => {
  await open(page('svelte.html'));
  const text = await inspect({ selector: '#s5old' }, 'Svelte 5.0');
  assert.match(text, /\(Svelte 5, development build\):/);
  entries(text, ['Child source-app/src/Child.svelte:7:3 (where the element is written)']);
});

test('mixed frameworks: the Svelte element inside a shadow root comes before the Vue component on its host', async () => {
  await open(page('svelte.html'));
  const text = await inspect({ selector: '#mixed' }, 'mixed');
  assert.match(text, /\(Vue 3 \+ Svelte 5, development build\):|\(Svelte 5 \+ Vue 3, development build\):/);
  entries(text, ['Child source-app/src/Child.svelte:7:3 (where the element is written)', 'App source-app/src/App.vue']);
});

test('Vue 3: a parent cycle is listed once', async () => {
  await open(page('vue3.html'));
  const text = await inspect({ selector: '#cycle' }, 'Vue 3 cycle');
  entries(text, ['Loop source-app/src/App.vue']);
});

test('Vue 2: a root instance without files is not called a minified production build', async () => {
  await open(page('vue2.html'));
  const text = await inspect({ selector: '#rootonly' }, 'Vue 2 root');
  assert.match(text, /Vue 2 is present \(only its root instance, no component files\), but without file locations/);
  assert.doesNotMatch(text, /minified/);
});

test('form controls named like DOM properties do not confuse the probe', async () => {
  await open(page('form.html'));
  const vue = await inspect({ selector: '#vform' }, 'form with Vue');
  entries(vue, ['<form> source-app/src/components/SaveButton.vue:14:5 (data-v-inspector)', 'SaveButton source-app/src/components/SaveButton.vue']);
  const plain = await inspect({ selector: '#pform' }, 'plain form');
  assert.match(plain, /^No framework information for form "Plain form".*Search the workspace for its text instead: id "pform", classes "plain-form"\.$/);
});

test('page-controlled names and paths cannot forge lines or blow up the result', async () => {
  await open(page('hostile.html'));
  const evil = await inspect({ selector: '#evil' }, 'forged name');
  entries(evil, ['Evil 2. Forged src/x.tsx:1:1 source-app/src/App.jsx:6 (where the element is written)']);
  const many = await inspect({ selector: '#many' }, '40 long owners');
  assert.ok(many.length < 2000, `${many.length} chars:\n${many}`);
  assert.match(many, /\n1\. N{59}… source-app\/src\/App\.jsx:6:7/);
  assert.match(many, /\+3 outer components not listed\./);
  const svelte = await inspect({ selector: '#badsvelte' }, 'malformed Svelte meta');
  assert.match(svelte, /^No framework information for button "Bad Svelte"/);
});

test('a malformed source map is a note on its entry; the other entries stay', async () => {
  await open(page('hostile.html'));
  const text = await inspect({ selector: '#badmap' }, 'malformed map');
  entries(text, ['Card /assets/bad.js:2:5 (where the element is written; unusable source map: invalid character in source map mappings: "!")', 'List source-app/src/components/List.jsx:8:11']);
  // Again: the broken map stays a note, not a failed tool.
  entries(await inspect({ selector: '#badmap' }, 'malformed map again'), ['Card /assets/bad.js:2:5 (where the element is written; unusable source map', 'List']);
});

test('a script that never answers is a note after about 5 s, not a failed tool', async () => {
  await open(page('hostile.html'));
  const started = Date.now();
  const text = await inspect({ selector: '#hang' }, 'hanging script');
  const took = Date.now() - started;
  assert.ok(took < 9000, `took ${took} ms`);
  entries(text, ['Card /assets/hang.js:1:1 (where the element is written; script not readable: did not load within 5 s)', 'List source-app/src/components/List.jsx:8:11']);
});

test('a navigation while a script is still loading ends the call at once with a clear message', async () => {
  await open(page('hostile.html', { nav: '1500' }));
  const started = Date.now();
  const result = await a.call('browser_inspect', { selector: '#hang' });
  const took = Date.now() - started;
  sizes.push(`navigation during the call: answered after ${took} ms`);
  assert.ok(result.isError, result.text);
  assert.match(result.text, /navigated while its source maps were loading, so the element is gone\. Take a snapshot and inspect again\./);
  assert.ok(took < 2500, `took ${took} ms (the page navigates 1.5 s after loading)`);
});

test('React bundled into the app: createElement mapping to node_modules gives way to the component', async () => {
  await open(page('hostile.html'));
  const text = await inspect({ selector: '#bundled' }, 'React bundled');
  entries(text, ['App source-app/src/App.jsx:6:7 (where the element is written)']);
  assert.doesNotMatch(text, /library component/);
});

process.on('exit', () => {
  if (sizes.length) console.log(`\nresult sizes: ${sizes.join('; ')}`);
});
await run();
