// Fixture server for browser-source.e2e.mjs (browser_inspect). Serves the pages in this folder, which
// fake the development data of React, Vue and Svelte in the page's own world (no framework is loaded),
// plus scripts built at start:
//
//   /assets/bundle.js (+ .map)    functions at known lines that create React 19-style `_debugStack`
//                                 errors; the map points them at project/src/**/*.jsx
//   /assets/bundle-nomap.js       the same code; its map reference answers 404
//   /node_modules/fake-lib/index.js   a library component's stack (counted as library code)
//   /assets/bad.js (+ .map)       a map whose mappings are malformed on line 2
//   /assets/hang.js               never answers (until the server stops)
//
// The pages take ?root=<workspace folder> for absolute component paths (__file, _debugSource,
// data-insp-path) and ?other=<origin> for the cross-origin frame. Usable standalone:
// `node test/fixtures/browser-source/server.mjs` prints the URL.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.map': 'application/json' };

// ---------------------------------------------------------------- a small source map encoder

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function vlq(n) {
  let v = n < 0 ? (-n << 1) | 1 : n << 1;
  let out = '';
  do {
    let digit = v & 31;
    v >>>= 5;
    if (v > 0) digit |= 32;
    out += B64[digit];
  } while (v > 0);
  return out;
}

/** `mappings` from per-line segments [genCol, src, line, col] (absolute, 0-based). */
function encodeMappings(lines) {
  let src = 0, line = 0, col = 0;
  return lines
    .map(segments => {
      let gen = 0;
      return segments
        .map(([g, s, l, c]) => {
          const out = vlq(g - gen) + vlq(s - src) + vlq(l - line) + vlq(c - col);
          [gen, src, line, col] = [g, s, l, c];
          return out;
        })
        .join(',');
    })
    .join(';');
}

/**
 * The bundle: `Card`, `List` and `App` each "write JSX" (call jsxDEV, which creates the error React 19
 * keeps as `_debugStack`) on a known line. Where each call is in the original files (1-based):
 * Card.jsx 7:7 (<button>), List.jsx 8:11 (<Card>), App.jsx 6:7 (<List>).
 */
export const ORIGINAL = { button: 'src/components/Card.jsx:7:7', card: 'src/components/List.jsx:8:11', list: 'src/App.jsx:6:7' };

function buildBundle(global, mapName) {
  const lines = [
    '(function () {',
    "  function jsxDEV(type) { return new Error('react-stack-top-frame'); }",
    "  function Card() { return jsxDEV('button'); }",
    '  function List() { return jsxDEV(Card); }',
    '  function App() { return jsxDEV(List); }',
    "  const bottom = { 'react-stack-bottom-frame': fn => fn() };",
    `  window.${global} = { button: bottom['react-stack-bottom-frame'](Card), card: bottom['react-stack-bottom-frame'](List), list: bottom['react-stack-bottom-frame'](App) };`,
    '})();',
    `//# sourceMappingURL=${mapName}`,
  ];
  const sources = ['../src/components/Card.jsx', '../src/components/List.jsx', '../src/App.jsx'];
  // Generated line index → [source index, function line, JSX line, JSX column] (0-based).
  const at = { 2: [0, 3, 6, 6], 3: [1, 2, 7, 10], 4: [2, 2, 5, 6] };
  const segments = lines.map((text, i) => {
    const a = at[i];
    if (!a) return [];
    const call = text.indexOf('jsxDEV(');
    return [
      [0, a[0], a[1], 0],
      [call, a[0], a[2], a[3]],
    ];
  });
  const map = { version: 3, file: 'bundle.js', sources, names: [], mappings: encodeMappings(segments) };
  return { code: lines.join('\n') + '\n', map: JSON.stringify(map) };
}

const bundle = buildBundle('__stacks', 'bundle.js.map');
const bundleNomap = buildBundle('__stacksNomap', 'bundle-nomap.js.map');
const fakeLib = [
  '(function () {',
  "  function jsxDEV(type) { return new Error('react-stack-top-frame'); }",
  '  function Provider() { return jsxDEV(window.App); }',
  "  const bottom = { 'react-stack-bottom-frame': fn => fn() };",
  "  window.__libStack = bottom['react-stack-bottom-frame'](Provider);",
  '})();',
  '',
].join('\n');

export async function startSourceServer({ port = 0, host = '127.0.0.1' } = {}) {
  const hanging = new Set();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (status, body, type) => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(body);
    };
    try {
      if (url.pathname === '/assets/bundle.js') return send(200, bundle.code, types['.js']);
      if (url.pathname === '/assets/bundle.js.map') return send(200, bundle.map, types['.map']);
      if (url.pathname === '/assets/bundle-nomap.js') return send(200, bundleNomap.code, types['.js']);
      if (url.pathname === '/node_modules/fake-lib/index.js') return send(200, fakeLib, types['.js']);
      // A map whose mappings break on line 2, and a script that never answers (hostile.html points stacks at them).
      if (url.pathname === '/assets/bad.js') return send(200, 'void 0;\nfunction Card() {}\n//# sourceMappingURL=bad.js.map\n', types['.js']);
      if (url.pathname === '/assets/bad.js.map') return send(200, '{"version":3,"sources":["../src/a.jsx"],"mappings":"AAAA;!!!!"}', types['.map']);
      if (url.pathname === '/assets/hang.js') return void hanging.add(res);
      // React bundled into the app's script: line 1 is React's createElement, line 2 the app's App.jsx.
      if (url.pathname === '/assets/mixed.js') return send(200, 'function createElement() {}\nfunction App() {}\n//# sourceMappingURL=mixed.js.map\n', types['.js']);
      if (url.pathname === '/assets/mixed.js.map') return send(200, JSON.stringify({ version: 3, sources: ['../node_modules/react/cjs/react.development.js', '../src/App.jsx'], mappings: 'AAAA;ACKM' }), types['.map']);
      if (url.pathname.startsWith('/project/')) return send(404, 'not found', 'text/plain');
      const file = normalize(join(here, url.pathname === '/' ? 'plain.html' : url.pathname));
      if (!file.startsWith(here)) return send(403, 'forbidden', 'text/plain');
      send(200, await readFile(file), types[extname(file)] ?? 'application/octet-stream');
    } catch {
      send(404, 'not found', 'text/plain');
    }
  });
  await new Promise(resolve => server.listen(port, host, resolve));
  const actual = server.address().port;
  return { port: actual, url: `http://${host}:${actual}`, close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); }) };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const s = await startSourceServer({ port: Number(process.argv[2] ?? 0) });
  console.log(`source fixtures: ${s.url}`);
}
