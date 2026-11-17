import * as nodeFs from 'node:fs';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { elementSource, originalLocation } from '../../src/extension/browser/page/source';
import { cacheStats, scriptMap } from '../../src/extension/browser/page/sourceFetch';
import { decodeDataUrl, decodeVlq, findSourceMapUrl, MAX_LINES, MAX_MAPPINGS_CHARS, parseSourceMap, resolveUrl, SourceMapError } from '../../src/extension/browser/page/sourceMap';
import { elementCreationFrame, elementCreationFrames, parseInspectorPath, parseStack, splitLocation, svelteLocation } from '../../src/extension/browser/page/stackFrames';
import { displayPath, mapToWorkspace, MAX_STATS_PER_PATH, normalizeSourcePath, type WorkspaceFs } from '../../src/extension/browser/page/workspacePaths';
import { clean, formatSource, grepPhrase, MAX_RESULT, sanitizeProbe, type SourceEntry } from '../../src/extension/browser/page/sourceReport';

// Counts directory listings (item: the workspace view is shared for a few seconds).
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readdirSync: vi.fn(actual.readdirSync) };
});

// ---------------------------------------------------------------- a small encoder for test maps

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function vlq(n: number): string {
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
/** Encodes lines of segments [genCol, src, line, col] (absolute, 0-based) as `mappings`. */
function encode(lines: number[][][]): string {
  let src = 0;
  let line = 0;
  let col = 0;
  return lines
    .map(segs => {
      let gen = 0;
      return segs
        .map(s => {
          const out = vlq(s[0]! - gen) + (s.length > 1 ? vlq(s[1]! - src) + vlq(s[2]! - line) + vlq(s[3]! - col) : '');
          gen = s[0]!;
          if (s.length > 1) [src, line, col] = [s[1]!, s[2]!, s[3]!];
          return out;
        })
        .join(',');
    })
    .join(';');
}

describe('VLQ', () => {
  it('decodes known vectors', () => {
    expect(decodeVlq('AAAA')).toEqual([0, 0, 0, 0]);
    expect(decodeVlq('AACA')).toEqual([0, 0, 1, 0]);
    expect(decodeVlq('gBAAgB')).toEqual([16, 0, 0, 16]);
    expect(decodeVlq('D')).toEqual([-1]);
    expect(decodeVlq('F')).toEqual([-2]);
    expect(decodeVlq('2Hw+BO')).toEqual([123, 1000, 7]);
    expect(decodeVlq('/////D')).toEqual([-67108863]);
  });

  it('round-trips with the encoder, including large and negative numbers', () => {
    for (const n of [0, 1, -1, 15, 16, -16, 31, 32, 1000, -1000, 123456, -987654, 2 ** 30]) expect(decodeVlq(vlq(n))).toEqual([n]);
  });

  it('rejects bad characters and truncated numbers', () => {
    expect(() => decodeVlq('A!')).toThrow(SourceMapError);
    expect(() => decodeVlq('g')).toThrow(/truncated/);
  });
});

describe('source maps', () => {
  const mappings = encode([
    [
      [0, 0, 0, 0],
      [10, 0, 4, 2],
      [20, 1, 9, 4],
    ],
    [],
    [
      [4, 1, 20, 0],
      [8],
    ],
  ]);
  const map = parseSourceMap(JSON.stringify({ version: 3, sources: ['a.ts', 'b.ts'], sourceRoot: '../src', mappings, x_google_ignoreList: [1] }), 'http://localhost:5173/assets/app.js.map');

  it('looks up the segment with the largest generated column on the same line', () => {
    expect(map.lookup(0, 0)).toEqual({ source: 'http://localhost:5173/src/a.ts', line: 1, column: 1, ignored: false });
    expect(map.lookup(0, 9)).toMatchObject({ line: 1, column: 1 });
    expect(map.lookup(0, 10)).toMatchObject({ line: 5, column: 3 });
    expect(map.lookup(0, 500)).toEqual({ source: 'http://localhost:5173/src/b.ts', line: 10, column: 5, ignored: true });
  });

  it('does not cross line boundaries; unmapped segments map to nothing', () => {
    expect(map.lookup(1, 0)).toBeUndefined();
    expect(map.lookup(2, 3)).toBeUndefined();
    expect(map.lookup(2, 5)).toMatchObject({ line: 21, column: 1 });
    expect(map.lookup(2, 9)).toBeUndefined();
    expect(map.lookup(7, 0)).toBeUndefined();
  });

  it('keeps absolute and bundler sources, resolves relative ones against the map URL', () => {
    const m = parseSourceMap(
      JSON.stringify({ version: 3, sources: ['webpack://app/./src/x.tsx', '/home/build/app/src/y.ts', 'C:\\proj\\z.ts', 'w.ts'], mappings: encode([[[0, 0, 0, 0], [1, 1, 0, 0], [2, 2, 0, 0], [3, 3, 0, 0]]]) }),
      'http://h:1/static/js/main.js.map',
    );
    expect([0, 1, 2, 3].map(c => m.lookup(0, c)?.source)).toEqual(['webpack://app/./src/x.tsx', 'http://h:1/home/build/app/src/y.ts', 'C:\\proj\\z.ts', 'http://h:1/static/js/w.ts']);
  });

  it('supports index maps with sections and offsets', () => {
    const section = (src: string) => ({ version: 3, sources: [src], mappings: encode([[[0, 0, 0, 0], [5, 0, 2, 0]]]) });
    const m = parseSourceMap(
      JSON.stringify({ version: 3, sections: [{ offset: { line: 0, column: 0 }, map: section('one.ts') }, { offset: { line: 3, column: 10 }, map: section('two.ts') }, { offset: { line: 9, column: 0 }, url: 'x.map' }] }),
      'http://h/a.js.map',
    );
    expect(m.lookup(0, 6)).toMatchObject({ source: 'http://h/one.ts', line: 3 });
    expect(m.lookup(3, 9)).toBeUndefined(); // section one has no line 3
    expect(m.lookup(3, 10)).toMatchObject({ source: 'http://h/two.ts', line: 1 });
    expect(m.lookup(3, 16)).toMatchObject({ source: 'http://h/two.ts', line: 3 });
  });

  it('refuses maps that are too large or not maps', () => {
    expect(() => parseSourceMap(JSON.stringify({ version: 3, sources: [], mappings: 'A'.repeat(MAX_MAPPINGS_CHARS + 1) }), 'http://h/a.map')).toThrow('source map too large');
    expect(() => parseSourceMap('<html>', 'http://h/a.map')).toThrow(/not valid JSON/);
    expect(() => parseSourceMap('{"version":2}', 'http://h/a.map')).toThrow(/version 2/);
  });

  it('finds the map reference: header first, else the last comment; inline data URLs decode', () => {
    expect(findSourceMapUrl('http://h/a/b.js', 'x\n//# sourceMappingURL=b.js.map')).toBe('http://h/a/b.js.map');
    expect(findSourceMapUrl('http://h/a/b.js', 'var s="//# sourceMappingURL=wrong.map";\n//@ sourceMappingURL=/maps/b.map\n')).toBe('http://h/maps/b.map');
    expect(findSourceMapUrl('http://h/a/b.js', '/*# sourceMappingURL=c.map */')).toBe('http://h/a/c.map');
    expect(findSourceMapUrl('http://h/a/b.js', '//# sourceMappingURL=b.js.map', { SourceMap: '/x.map' })).toBe('http://h/x.map');
    expect(findSourceMapUrl('http://h/a/b.js', 'nothing here')).toBeUndefined();
    const json = '{"version":3,"sources":["s.ts"],"mappings":"AAAA"}';
    const b64 = `data:application/json;charset=utf-8;base64,${Buffer.from(json).toString('base64')}`;
    expect(findSourceMapUrl('http://h/a.js', `x\n//# sourceMappingURL=${b64}`)).toBe(b64);
    expect(decodeDataUrl(b64)).toBe(json);
    expect(decodeDataUrl(`data:application/json,${encodeURIComponent(json)}`)).toBe(json);
    expect(decodeDataUrl('http://h/x')).toBeUndefined();
    expect(parseSourceMap(decodeDataUrl(b64)!, 'http://h/src/a.js').lookup(0, 0)?.source).toBe('http://h/src/s.ts');
  });

  it('resolves URLs only against hierarchical bases', () => {
    expect(resolveUrl('x.map', 'http://h/a/b.js')).toBe('http://h/a/x.map');
    expect(resolveUrl('x.map', 'webpack://app/b.js')).toBe('x.map');
    expect(resolveUrl('/abs/x.ts', 'file:///proj/b.js')).toBe('file:///abs/x.ts');
  });
});

// ---------------------------------------------------------------- stacks

const REACT_190_VITE = `Error: react-stack-top-frame
    at exports.jsxDEV (http://localhost:5173/node_modules/.vite/deps/react_jsx-dev-runtime.js?v=7c2a1b3e:250:30)
    at ProductCard (http://localhost:5173/src/components/ProductCard.tsx?t=1731770000000:42:9)
    at Object.react-stack-bottom-frame (http://localhost:5173/node_modules/.vite/deps/react-dom_client.js?v=7c2a1b3e:16242:20)
    at renderWithHooks (http://localhost:5173/node_modules/.vite/deps/react-dom_client.js?v=7c2a1b3e:4404:24)`;

const REACT_191_NEXT = `Error: react-stack-top-frame
    at jsxDEV (webpack-internal:///(app-pages-browser)/./node_modules/next/dist/compiled/react/cjs/react-jsx-dev-runtime.development.js:346:13)
    at Card (webpack-internal:///(app-pages-browser)/./src/components/Card.tsx:12:87)
    at react-stack-bottom-frame (webpack-internal:///(app-pages-browser)/./node_modules/next/dist/compiled/react-dom/cjs/react-dom-client.development.js:22974:20)`;

describe('stacks', () => {
  it('parses named, anonymous, async, aliased and webpack-internal frames', () => {
    const frames = parseStack(`Error: boom
    at Foo (http://h:5173/src/a.js:1:2)
    at http://h:5173/src/b.js:3:4
    at async Bar (http://h/src/c.js:5:6)
    at Object.baz [as qux] (webpack-internal:///./src/d.tsx:7:8)
    at eval (eval at f (http://h/x.js:1:1), <anonymous>:1:1)
    at new Thing (C:\\proj\\e.js:9:10)
    fn@http://h/f.js:11:12`);
    expect(frames).toEqual([
      { fn: 'Foo', url: 'http://h:5173/src/a.js', line: 1, column: 2 },
      { fn: undefined, url: 'http://h:5173/src/b.js', line: 3, column: 4 },
      { fn: 'Bar', url: 'http://h/src/c.js', line: 5, column: 6 },
      { fn: 'Object.baz', url: 'webpack-internal:///./src/d.tsx', line: 7, column: 8 },
      { fn: 'new Thing', url: 'C:\\proj\\e.js', line: 9, column: 10 },
      { fn: 'fn', url: 'http://h/f.js', line: 11, column: 12 },
    ]);
  });

  it('finds the frame where React 19 created the element (19.0 with Vite, 19.1 with Next)', () => {
    expect(elementCreationFrame(REACT_190_VITE)).toEqual({ fn: 'ProductCard', url: 'http://localhost:5173/src/components/ProductCard.tsx?t=1731770000000', line: 42, column: 9 });
    expect(elementCreationFrame(REACT_191_NEXT)).toMatchObject({ fn: 'Card', url: 'webpack-internal:///(app-pages-browser)/./src/components/Card.tsx', line: 12 });
  });

  it('returns a library frame as is, and nothing when only React frames are left', () => {
    const lib = `Error: react-stack-top-frame
    at exports.jsxDEV (http://h/node_modules/.vite/deps/chunk-ABC.js?v=1:100:10)
    at ButtonBase (http://h/node_modules/.vite/deps/@mui_material.js?v=1:5000:7)
    at react-stack-bottom-frame (http://h/node_modules/.vite/deps/react-dom_client.js:1:1)`;
    expect(elementCreationFrame(lib)?.fn).toBe('ButtonBase');
    expect(elementCreationFrame(`Error: react-stack-top-frame\n    at react-stack-bottom-frame (http://h/node_modules/.vite/deps/react-dom_client.js:1:1)`)).toBeUndefined();
  });

  it('splits locations from the right', () => {
    expect(splitLocation('http://localhost:5173/src/a.ts:12:5')).toEqual({ url: 'http://localhost:5173/src/a.ts', line: 12, column: 5 });
    expect(splitLocation('C:\\x\\a.ts:3')).toEqual({ url: 'C:\\x\\a.ts', line: 3, column: 1 });
    expect(splitLocation('nothing')).toBeUndefined();
  });

  it('reads inspector attributes', () => {
    expect(parseInspectorPath('/home/me/app/src/App.vue:12:5:div')).toEqual({ file: '/home/me/app/src/App.vue', line: 12, column: 5 });
    expect(parseInspectorPath('src/components/SaveButton.vue:14:5')).toEqual({ file: 'src/components/SaveButton.vue', line: 14, column: 5 });
    expect(parseInspectorPath('C:\\proj\\src\\A.tsx:3:7:button')).toEqual({ file: 'C:\\proj\\src\\A.tsx', line: 3, column: 7 });
    expect(parseInspectorPath('src/only/path.vue')).toEqual({ file: 'src/only/path.vue' });
  });

  it('converts Svelte 4 (0-based) and Svelte 5 (1-based) lines; columns are 0-based in both', () => {
    // svelte 4.2: add_location(div, file, 4, 0, 58) for <div> on line 5, column 1.
    expect(svelteLocation({ file: 'src/App.svelte', line: 4, column: 0 }, 4)).toEqual({ file: 'src/App.svelte', line: 5, column: 1 });
    // svelte 5: add_locations(..., [[5, 0]]) for the same <div>.
    expect(svelteLocation({ file: 'src/App.svelte', line: 5, column: 0 }, 5)).toEqual({ file: 'src/App.svelte', line: 5, column: 1 });
    expect(svelteLocation({ line: 1 }, 5)).toBeUndefined();
  });
});

// ---------------------------------------------------------------- workspace paths

/** A fake file system: a set of files, with the folders derived from them. */
function fakeFs(files: string[], platform: 'posix' | 'win32' = 'posix'): WorkspaceFs & { stats: number } {
  const norm = (p: string) => (platform === 'win32' ? p.replace(/\\/g, '/').toLowerCase() : p);
  const set = new Set(files.map(norm));
  const fs = {
    stats: 0,
    exists(p: string) {
      fs.stats++;
      return set.has(norm(p));
    },
    folders(root: string) {
      const r = norm(root).replace(/\/$/, '');
      const out = new Set<string>();
      for (const f of set) {
        if (!f.startsWith(r + '/')) continue;
        const parts = f.slice(r.length + 1).split('/').slice(0, -1);
        for (let i = 1; i <= Math.min(parts.length, 3); i++) out.add(parts.slice(0, i).join('/'));
      }
      return [...out];
    },
  };
  return fs;
}

describe('mapToWorkspace', () => {
  const roots = ['/home/me/shop'];
  const fs = () => fakeFs(['/home/me/shop/src/components/Card.tsx', '/home/me/shop/src/App.vue', '/home/me/shop/README.md', '/home/me/shop/apps/web/src/main.ts']);

  it('maps an absolute path inside a root with one file check', () => {
    const f = fs();
    expect(mapToWorkspace('/home/me/shop/src/App.vue', roots, f, 'linux')).toEqual({ root: '/home/me/shop', rel: 'src/App.vue', library: false });
    expect(f.stats).toBe(1);
  });

  it('claims nothing under a root that does not exist there, and nothing that escapes it', () => {
    expect(mapToWorkspace('/home/me/shop/does/not/exist.tsx', roots, fs(), 'linux')).toEqual({ unmapped: '/home/me/shop/does/not/exist.tsx', library: false });
    // A folder is not a file.
    expect(mapToWorkspace('/home/me/shop/src', roots, fs(), 'linux')).toHaveProperty('unmapped');
    expect(mapToWorkspace('/home/me/shop/../../../../etc/passwd', roots, fs(), 'linux')).toEqual({ unmapped: '/etc/passwd', library: false });
    expect(mapToWorkspace('/home/me/shop/src/../src/App.vue', roots, fs(), 'linux')).toMatchObject({ rel: 'src/App.vue' });
    expect(normalizeSourcePath('C:/a/../../b.ts')).toBe('C:/b.ts');
    expect(normalizeSourcePath('../x/../y.ts')).toBe('../y.ts');
  });

  it('maps container, Vite, webpack, /@fs/ and file:// paths by suffix', () => {
    for (const raw of [
      '/app/src/components/Card.tsx', // container mount
      'http://localhost:5173/src/components/Card.tsx?t=123', // Vite URL
      'webpack://shop/./src/components/Card.tsx',
      'webpack-internal:///(app-pages-browser)/./src/components/Card.tsx',
      '/@fs/build/shop/src/components/Card.tsx',
      'file:///build/shop/src/components/Card.tsx',
      'src/components/Card.tsx',
    ]) {
      expect(mapToWorkspace(raw, roots, fs(), 'linux'), raw).toEqual({ root: '/home/me/shop', rel: 'src/components/Card.tsx', library: false });
    }
  });

  it('finds a path under a folder of the root (monorepo app)', () => {
    expect(mapToWorkspace('http://localhost:5173/src/main.ts', roots, fs(), 'linux')).toEqual({ root: '/home/me/shop', rel: 'apps/web/src/main.ts', library: false });
  });

  it('maps Windows paths against a win32 root, case-insensitively', () => {
    const winRoots = ['C:\\Users\\me\\proj'];
    const f = fakeFs(['C:\\Users\\me\\proj\\src\\a.tsx'], 'win32');
    expect(mapToWorkspace('C:\\Users\\me\\proj\\src\\a.tsx', winRoots, f, 'win32')).toMatchObject({ rel: 'src/a.tsx' });
    expect(mapToWorkspace('/c:/users/me/proj/src/a.tsx', winRoots, f, 'win32')).toMatchObject({ rel: 'src/a.tsx' });
    expect(mapToWorkspace('file:///C:/Users/me/proj/src/a.tsx', winRoots, f, 'win32')).toMatchObject({ rel: 'src/a.tsx' });
    // A dev server elsewhere (another drive, a container) by suffix, joined with backslashes.
    expect(mapToWorkspace('D:\\build\\proj\\src\\a.tsx', winRoots, f, 'win32')).toMatchObject({ rel: 'src/a.tsx' });
  });

  it('maps WSL paths both ways by suffix', () => {
    // A Windows dev server, the extension in WSL.
    const f = fakeFs(['/home/me/proj/src/a.tsx']);
    expect(mapToWorkspace('C:\\Users\\me\\proj\\src\\a.tsx', ['/home/me/proj'], f, 'linux')).toMatchObject({ rel: 'src/a.tsx' });
    expect(mapToWorkspace('\\\\wsl.localhost\\Ubuntu\\home\\me\\proj\\src\\a.tsx', ['/home/me/proj'], f, 'linux')).toMatchObject({ rel: 'src/a.tsx' });
    // A WSL dev server, the extension on Windows.
    const w = fakeFs(['C:\\Users\\me\\proj\\src\\a.tsx'], 'win32');
    expect(mapToWorkspace('/mnt/c/Users/me/proj/src/a.tsx', ['C:\\Users\\me\\proj'], w, 'win32')).toMatchObject({ rel: 'src/a.tsx' });
  });

  it('with several roots: the root whose file exists, shown with its name', () => {
    const two = ['/w/api', '/w/web'];
    const f = fakeFs(['/w/web/src/App.tsx', '/w/api/src/server.ts']);
    const mapped = mapToWorkspace('/build/web/src/App.tsx', two, f, 'linux');
    expect(mapped).toEqual({ root: '/w/web', rel: 'src/App.tsx', library: false });
    expect(displayPath(mapped, two)).toBe('web/src/App.tsx');
    expect(displayPath(mapped, ['/w/web'])).toBe('src/App.tsx');
  });

  it('needs at least 2 matching segments, unless the path has only one', () => {
    expect(mapToWorkspace('/elsewhere/other/README.md', roots, fs(), 'linux')).toEqual({ unmapped: '/elsewhere/other/README.md', library: false });
    expect(mapToWorkspace('README.md', roots, fs(), 'linux')).toMatchObject({ rel: 'README.md' });
  });

  it('checks at most MAX_STATS_PER_PATH files per path', () => {
    const many = Array.from({ length: 30 }, (_, i) => `/r${i}`);
    const f = fakeFs([]);
    expect(mapToWorkspace('/a/b/c/d/e/f/g/h/i/j/k/l/m/n.ts', many, f, 'linux')).toHaveProperty('unmapped');
    expect(f.stats).toBeLessThanOrEqual(MAX_STATS_PER_PATH);
  });

  it('marks library code and does not look it up', () => {
    const f = fs();
    expect(mapToWorkspace('/home/me/shop/node_modules/vue/dist/x.js', roots, f, 'linux')).toEqual({ unmapped: '/home/me/shop/node_modules/vue/dist/x.js', library: true });
    expect(mapToWorkspace('webpack://shop/./src/a.ts', roots, f, 'linux', { ignored: true })).toMatchObject({ library: true });
    expect(f.stats).toBe(0);
  });

  it('normalizes what pages report', () => {
    expect(normalizeSourcePath('webpack://my-app/./src/x.tsx?abcd')).toBe('src/x.tsx');
    expect(normalizeSourcePath('webpack:///./src/x.tsx')).toBe('src/x.tsx');
    expect(normalizeSourcePath('http://h:3000/src/a%20b.vue?vue&type=style#x')).toBe('/src/a b.vue');
    expect(normalizeSourcePath('/@fs/C:/proj/x.ts')).toBe('C:/proj/x.ts');
    expect(normalizeSourcePath('vite:/src/x.ts')).toBe('/src/x.ts');
    expect(normalizeSourcePath('./src/x.ts')).toBe('src/x.ts');
  });
});

// ---------------------------------------------------------------- report

describe('formatSource', () => {
  const grep = { text: 'Add to cart', id: 'add', testId: 'add-to-cart' };

  it('lists a Vue 3 chain with the inspector attribute first', () => {
    const entries: SourceEntry[] = [
      { tag: 'button', location: 'src/components/SaveButton.vue:14:5', note: 'data-v-inspector' },
      { name: 'SaveButton', location: 'src/components/SaveButton.vue' },
      { name: 'EditorToolbar', location: 'src/components/EditorToolbar.vue' },
      { name: 'Toolbar', location: '/home/build/app/src/Toolbar.vue', outside: true },
      { name: 'App', location: 'src/App.vue' },
    ];
    expect(formatSource({ kind: 'found', label: 'button "Save" [ref=e12]', frameworks: ['Vue 3'], linesFromMaps: false, entries, roots: ['shop'], notes: ['Vue gives files, not lines, for components.'] })).toBe(
      [
        'Source of button "Save" [ref=e12] (Vue 3, development build):',
        '1. <button> src/components/SaveButton.vue:14:5 (data-v-inspector)',
        '2. SaveButton src/components/SaveButton.vue',
        '3. EditorToolbar src/components/EditorToolbar.vue',
        '4. Toolbar /home/build/app/src/Toolbar.vue (not found in the workspace folders)',
        '5. App src/App.vue',
        'Paths are relative to the workspace folder "shop". Vue gives files, not lines, for components.',
      ].join('\n'),
    );
  });

  it('lists React 19 lines from source maps and counts library components', () => {
    const text = formatSource({
      kind: 'found',
      label: 'button "Add to cart" [ref=e7]',
      frameworks: ['React 19'],
      linesFromMaps: true,
      entries: [
        { name: 'ButtonBase', library: true },
        { name: 'ProductCard', location: 'src/components/ProductCard.tsx:42:9', note: 'where the element is written' },
        { name: 'ProductList', location: 'src/components/ProductList.tsx:18:11' },
        { name: 'Provider', library: true },
        { name: 'App', location: '/assets/index-3f2a.js:1:20512', bundled: true, problem: 'source map not found: /assets/index-3f2a.js.map answered 404' },
      ],
      roots: ['shop', 'api'],
      notes: [],
    });
    expect(text).toBe(
      [
        'Source of button "Add to cart" [ref=e7] (React 19, development build; lines from source maps):',
        '1. ProductCard src/components/ProductCard.tsx:42:9 (where the element is written)',
        '2. ProductList src/components/ProductList.tsx:18:11',
        '3. App /assets/index-3f2a.js:1:20512 (source map not found: /assets/index-3f2a.js.map answered 404)',
        '2 library components left out (node_modules).',
        'Paths start with the workspace folder name.',
      ].join('\n'),
    );
  });

  it('says a problem several entries share once, after the list', () => {
    const problem = 'source map not found: /assets/b.js.map answered 404';
    const text = formatSource({
      kind: 'found',
      label: 'x',
      frameworks: ['React 19'],
      linesFromMaps: false,
      entries: [
        { name: 'Card', location: '/assets/b.js:3:28', bundled: true, problem, note: 'where the element is written' },
        { name: 'List', location: '/assets/b.js:4:28', bundled: true, problem },
      ],
      roots: ['p'],
      notes: [],
    });
    expect(text).toBe(
      [
        'Source of x (React 19, development build):',
        '1. Card /assets/b.js:3:28 (where the element is written)',
        '2. List /assets/b.js:4:28',
        'Source map not found: /assets/b.js.map answered 404, so those lines are in the bundled script; search the workspace for the component names.',
      ].join('\n'),
    );
  });

  it('caps the list', () => {
    const entries = Array.from({ length: 15 }, (_, i) => ({ name: `C${i}`, location: `src/C${i}.tsx:1` }));
    const text = formatSource({ kind: 'found', label: 'x', frameworks: ['React'], linesFromMaps: false, entries, roots: ['p'], notes: [] });
    expect(text).toContain('12. C11 src/C11.tsx:1');
    expect(text).not.toContain('C12 ');
    expect(text).toContain('+3 outer components not listed.');
  });

  it('names an attribute when no framework data exist', () => {
    const text = formatSource({ kind: 'found', label: 'div', frameworks: [], attribute: 'data-insp-path', linesFromMaps: false, entries: [{ tag: 'div', location: 'src/a.tsx:3:1', note: 'data-insp-path' }], roots: ['p'], notes: [] });
    expect(text.split('\n')[0]).toBe('Source of div (inspector attribute data-insp-path):');
  });

  it('says plainly when it is a production build, and what to search for', () => {
    expect(formatSource({ kind: 'production', label: 'button "Add to cart" [ref=e7]', evidence: 'React is present', grep })).toBe(
      'No source locations for button "Add to cart" [ref=e7]: React is present, but this is a production build (no file locations; component names are minified). Open the app from its development server for locations, or search the workspace for the element\'s text: "Add to cart" (id "add", data-testid "add-to-cart").',
    );
    expect(formatSource({ kind: 'production', label: 'x', evidence: 'Vue 3 is present (data-v-app)', grep: {} })).toMatch(/^No source locations for x: Vue 3 is present \(data-v-app\), but this is a production build.*no text, id or classes/);
  });

  it('says when there is no framework information, unsupported frameworks, and names-only chains', () => {
    expect(formatSource({ kind: 'none', label: 'heading "Pricing plans" [ref=e3]', grep: { text: 'Pricing plans for teams', classes: ['hero-title'] } })).toBe(
      'No framework information for heading "Pricing plans" [ref=e3]: neither it nor its ancestors carry React, Vue or Svelte development data or inspector attributes (plain or server-rendered HTML, another framework, or a production build). Search the workspace for its text instead: "Pricing plans for teams" (classes "hero-title").',
    );
    expect(formatSource({ kind: 'unsupported', label: 'x', framework: 'Angular', grep })).toMatch(/Angular is not supported\. Search the workspace for its text instead: "Add to cart"/);
    const names = formatSource({ kind: 'names-only', label: 'x', why: 'React development build without JSX source info', names: ['Card', 'List'], grep });
    expect(names).toBe(['Components of x (React development build without JSX source info; no file locations):', '1. Card', '2. List', 'Search the workspace for these component names, or for the element\'s text: "Add to cart" (id "add", data-testid "add-to-cart").'].join('\n'));
  });

  it('builds the search phrase from what the element has', () => {
    expect(grepPhrase({})).toBeUndefined();
    expect(grepPhrase({ id: 'a' })).toBe('id "a"');
    expect(grepPhrase({ text: 'Hi "there"' })).toBe('"Hi \\"there\\""');
  });
});

// ---------------------------------------------------------------- bounded and hostile input

describe('source maps from pages are bounded', () => {
  it('a malformed mappings string fails the lookup with SourceMapError, every time', () => {
    const map = parseSourceMap('{"version":3,"sources":["a.jsx"],"mappings":"AAAA;!!!!"}', 'http://h/a.js.map');
    expect(map.lookup(0, 0)).toMatchObject({ line: 1 });
    expect(() => map.lookup(1, 0)).toThrow(SourceMapError);
    expect(() => map.lookup(0, 0)).toThrow(/invalid character/);
    expect(() => parseSourceMap('{"version":3,"sources":["a"],"mappings":"AA"}', 'http://h/a.map').lookup(0, 0)).toThrow(/2 or 3 fields/);
  });

  it('refuses deeply nested or malformed index maps without overflowing the stack', () => {
    const open = '{"version":3,"sections":[{"offset":{"line":0,"column":0},"map":';
    const leaf = '{"version":3,"sources":["a"],"mappings":"AAAA"}';
    for (const depth of [4, 3000, 100_000]) {
      const text = open.repeat(depth) + leaf + '}]}'.repeat(depth);
      expect(() => parseSourceMap(text, 'http://h/a.map'), `depth ${depth}`).toThrow(SourceMapError);
      expect(() => parseSourceMap(text, 'http://h/a.map')).toThrow(/nested too deeply/);
    }
    const badOffset = { version: 3, sections: [{ offset: { line: '1', column: 0 }, map: { version: 3, sources: ['a'], mappings: 'AAAA' } }] };
    expect(() => parseSourceMap(JSON.stringify(badOffset), 'http://h/a.map')).toThrow(/valid offset/);
  });

  it('refuses a map of millions of empty lines quickly, before allocating, and says the limits', () => {
    const started = Date.now();
    expect(() => parseSourceMap(JSON.stringify({ version: 3, sources: ['a'], mappings: ';'.repeat(MAX_LINES + 1) }), 'http://h/a.map')).toThrow(/too large \(limits: .*lines/);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('decodes only as far as the line looked up; out-of-order segments are still found', () => {
    // Line 0 has segments at columns 10 and 0 (out of order); line 2 is malformed but never reached.
    const map = parseSourceMap(JSON.stringify({ version: 3, sources: ['a.ts'], mappings: 'UAAE,VAAC;AACA;!' }), 'http://h/a.js.map');
    // Segments: column 10 → original column 3, column 0 → original column 4 (1-based).
    expect(map.lookup(0, 5)).toMatchObject({ line: 1, column: 4 });
    expect(map.lookup(0, 12)).toMatchObject({ line: 1, column: 3 });
    expect(map.lookup(1, 0)).toMatchObject({ line: 2 });
    expect(() => map.lookup(2, 0)).toThrow(SourceMapError);
  });

  it('keeps only what lookups need: sourcesContent does not count', () => {
    const big = 'x'.repeat(2_000_000);
    const map = parseSourceMap(JSON.stringify({ version: 3, sources: ['a.ts'], sourcesContent: [big], names: ['n'], mappings: 'AAAA' }), 'http://h/a.js.map');
    expect(map.size).toBeLessThan(1000);
  });
});

describe('page strings are checked and bounded', () => {
  it('clean collapses newlines and control characters, clips, and drops non-strings', () => {
    expect(clean('Card\n2. Forged src/x.ts', 60)).toBe('Card 2. Forged src/x.ts');
    expect(clean('a\u202eb\u0000c\u061cd', 60)).toBe('a b c d');
    expect(clean('x'.repeat(100), 60)).toHaveLength(60);
    expect(clean({}, 60)).toBeUndefined();
    expect(clean('   ', 60)).toBeUndefined();
  });

  it('sanitizeProbe keeps only well-typed fields', () => {
    const p = sanitizeProbe({
      tag: 'button',
      react: { dev: true, depth: 0, chain: [{ name: 'A\nB', source: { fileName: '/x.tsx', lineNumber: 'NaN', columnNumber: Infinity } }, { name: { evil: 1 } }, 'junk'] },
      svelte: { depth: 'x', version: 4, loc: { file: {}, line: 1 }, parents: [{ file: 3 }] },
      vue3: { depth: 1, chain: [{ name: 'X'.repeat(500), file: 7 }] },
      grep: { text: 'ok', id: {}, classes: ['a', {}, 'b\nc'] },
    });
    expect(p.react!.chain).toEqual([{ name: 'A B', source: { fileName: '/x.tsx', lineNumber: undefined, columnNumber: undefined } }, { name: 'Anonymous' }]);
    expect(p.svelte).toEqual({ depth: 0, version: 4, parents: [] });
    expect(p.vue3!.chain[0]!.name).toHaveLength(60);
    expect(p.vue3!.chain[0]!.file).toBeUndefined();
    expect(p.grep).toEqual({ text: 'ok', classes: ['a', 'b c'] });
    expect(sanitizeProbe(null)).toEqual({ tag: 'element', grep: {} });
  });

  it('a forged name cannot add numbered entries, and the result is capped', () => {
    const entries = Array.from({ length: 40 }, () => ({ name: `N\n1. fake ${'y'.repeat(200)}`, location: `src/${'z'.repeat(400)}.tsx:1` }));
    const text = formatSource({ kind: 'found', label: 'x', frameworks: ['React'], linesFromMaps: false, entries, roots: ['p'], notes: [] });
    const numbered = text.split('\n').filter(l => /^\d+\. /.test(l));
    expect(numbered.length).toBeGreaterThan(5);
    expect(numbered.length).toBeLessThanOrEqual(12);
    expect(numbered.every((l, i) => l.startsWith(`${i + 1}. N 1. fake`))).toBe(true);
    expect(text.length).toBeLessThanOrEqual(MAX_RESULT);
  });

  it('Svelte 5 without a parent chain (5.0-5.35) reads 1-based lines', () => {
    expect(svelteLocation({ file: 'src/Child.svelte', line: 7, column: 2 }, 5)).toEqual({ file: 'src/Child.svelte', line: 7, column: 3 });
    expect(sanitizeProbe({ svelte: { version: 5, depth: 0, loc: { file: 'src/Child.svelte', line: 7, column: 2 } } }).svelte).toEqual({
      depth: 0,
      version: 5,
      loc: { file: 'src/Child.svelte', line: 7, column: 2 },
      parents: [],
    });
  });
});

describe('React frame filter', () => {
  it('does not take an app folder named scheduler for React, nor an app function named createElement', () => {
    const stack = `Error: react-stack-top-frame
    at exports.jsxDEV (http://localhost:5173/node_modules/.vite/deps/react_jsx-dev-runtime.js?v=1:250:30)
    at CalendarGrid (http://localhost:5173/src/features/scheduler/CalendarGrid.tsx:42:9)
    at Object.react-stack-bottom-frame (http://localhost:5173/node_modules/.vite/deps/react-dom_client.js?v=1:1:1)`;
    expect(elementCreationFrame(stack)?.fn).toBe('CalendarGrid');
    const own = `Error: react-stack-top-frame
    at jsxDEV (http://h/node_modules/react/cjs/react-jsx-dev-runtime.development.js:1:1)
    at createElement (http://h/src/dom/createElement.ts:5:3)`;
    expect(elementCreationFrame(own)).toMatchObject({ fn: 'createElement', line: 5 });
    const lib = `Error: x
    at createElement (http://h/node_modules/react/cjs/react.development.js:1:1)
    at Card (http://h/src/Card.tsx:3:4)`;
    expect(elementCreationFrame(lib)?.fn).toBe('Card');
    // Turbopack chunks named after node_modules paths, and Vite deps without the node_modules prefix.
    const next = `Error: x
    at jsx (http://h/_next/static/chunks/node_modules_next_dist_compiled_react_1.js:1:1)
    at Page (http://h/_next/static/chunks/app_page_tsx_1.js:3:4)`;
    expect(elementCreationFrame(next)?.fn).toBe('Page');
    const vite = `Error: x
    at Object.helper (http://h/.vite/deps/react_jsx-dev-runtime.js?v=1:1:1)
    at Card (http://h/src/Card.tsx:3:4)`;
    expect(elementCreationFrame(vite)?.fn).toBe('Card');
    // React bundled into the app's own script: both frames are candidates; the caller resolves the first.
    const bundled = `Error: x
    at exports.createElement (http://h/s/mixed.js:1:1)
    at App (http://h/s/mixed.js:2:1)`;
    expect(elementCreationFrames(bundled).map(f => f.fn)).toEqual(['exports.createElement', 'App']);
  });
});

// ---------------------------------------------------------------- fetching, caching, resolving (a fake CDP)

interface FakeResource {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
  hang?: boolean;
}

/** A PageCall stand-in: CDP answers from `resources`; the workspace is real files. */
function fakeCall(options: { resources: Record<string, FakeResource>; roots: string[]; url?: string; probe?: unknown; sendError?: (method: string) => string | undefined }) {
  const sent: Array<{ method: string; params: any }> = [];
  const streams = new Map<string, string>();
  let next = 1;
  const state: any = { loaderId: 'L1', url: options.url ?? 'http://localhost:5173/', mainFrameId: 'F1', seq: 0, navigations: { all: () => [] }, network: { entries: { after: () => [] }, annotate() {} } };
  const cdp = {
    send: async (method: string, params: any) => {
      sent.push({ method, params });
      const error = options.sendError?.(method);
      if (error) throw new Error(error);
      if (method === 'Network.loadNetworkResource') {
        const r = options.resources[params.url];
        if (r?.hang) return new Promise(() => {});
        if (!r || (r.status ?? 200) >= 400) return { resource: { success: false, httpStatusCode: r?.status ?? 404 } };
        const id = String(next++);
        streams.set(id, r.body ?? '');
        return { resource: { success: true, httpStatusCode: 200, stream: id, headers: r.headers ?? {} } };
      }
      if (method === 'IO.read') {
        const data = streams.get(params.handle) ?? '';
        streams.set(params.handle, '');
        return { data, eof: data === '' };
      }
      return {};
    },
  };
  const controller = new AbortController();
  const call: any = {
    state,
    frame: undefined,
    cdp,
    signal: controller.signal,
    tab: { id: 'tab-1' },
    env: { services: { window: { workspaceFolders: options.roots } } },
    callOn: async () => options.probe,
    evaluate: async () => ({ ok: false, why: 'fallback used' }),
  };
  return { call, sent, state, controller };
}

/** A workspace folder with files (relative path → content). */
function workspace(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'copane-source-'));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

const MAP = JSON.stringify({ version: 3, sources: ['../src/components/Card.jsx'], mappings: 'AAAA,QAMM' });
const SCRIPT = 'function Card() { return jsxDEV("b"); }\n//# sourceMappingURL=bundle.js.map\n';

describe('fetching scripts and maps', () => {
  afterEach(() => vi.useRealTimers());

  it('originalLocation resolves a console location through the source map to a workspace file', async () => {
    const root = workspace({ 'src/components/Card.jsx': 'x' });
    const { call } = fakeCall({ roots: [root], resources: { 'http://localhost:5173/assets/bundle.js': { body: SCRIPT }, 'http://localhost:5173/assets/bundle.js.map': { body: MAP } } });
    expect(await originalLocation(call, 'http://localhost:5173/assets/bundle.js:1:10')).toBe('src/components/Card.jsx:7:7');
    // Not resolvable to a workspace file: undefined (the caller keeps its own text).
    expect(await originalLocation(call, 'http://localhost:5173/assets/other.js:1:1')).toBeUndefined();
    expect(await originalLocation(call, 'not a location')).toBeUndefined();
  });

  it("caches per document, drops a frame's earlier documents, and does not cache failures", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const resources: Record<string, FakeResource> = { 'http://localhost:5173/a.js': { body: SCRIPT.replace('bundle.js.map', 'a.js.map') } };
    const { call, state, sent } = fakeCall({ roots: [], resources });
    const loads = () => sent.filter(s => s.method === 'Network.loadNetworkResource').length;
    expect(await scriptMap(call, 'http://localhost:5173/a.js')).toEqual({ error: 'source map not found: /a.js.map answered 404' });
    await scriptMap(call, 'http://localhost:5173/a.js');
    expect(loads()).toBe(2); // a failure is reused only briefly: no new load within 3 s
    resources['http://localhost:5173/a.js.map'] = { body: MAP };
    vi.setSystemTime(Date.now() + 4000);
    expect(await scriptMap(call, 'http://localhost:5173/a.js')).toHaveProperty('map');
    const loaded = loads();
    expect(loaded).toBe(4);
    await scriptMap(call, 'http://localhost:5173/a.js');
    expect(loads()).toBe(loaded); // a map is cached
    expect(cacheStats(state).bytes).toBeGreaterThan(0);
    state.loaderId = 'L2';
    await scriptMap(call, 'http://localhost:5173/a.js');
    expect(cacheStats(state).entries).toBe(1); // L1's entry is gone
  });

  it('a hanging script is a per-load note after 5 s, not a failed tool', async () => {
    vi.useFakeTimers();
    const { call } = fakeCall({ roots: [], resources: { 'http://localhost:5173/hang.js': { hang: true } } });
    const pending = scriptMap(call, 'http://localhost:5173/hang.js');
    await vi.advanceTimersByTimeAsync(5100);
    expect(await pending).toEqual({ error: 'script not readable: did not load within 5 s' });
  });

  it('only "method wasn\'t found" switches to the fallback; other errors stay per load', async () => {
    const stale = fakeCall({ roots: [], resources: {}, sendError: m => (m === 'Network.loadNetworkResource' ? 'Frame not found' : undefined) });
    expect(await scriptMap(stale.call, 'http://localhost:5173/x.js')).toEqual({ error: 'script not readable: could not be loaded (Frame not found)' });
    await scriptMap(stale.call, 'http://localhost:5173/y.js');
    expect(stale.sent.filter(s => s.method === 'Network.loadNetworkResource')).toHaveLength(2);
    const missing = fakeCall({ roots: [], resources: {}, sendError: m => (m === 'Network.loadNetworkResource' ? "'Network.loadNetworkResource' wasn't found" : undefined) });
    expect(await scriptMap(missing.call, 'http://localhost:5173/x.js')).toEqual({ error: 'script not readable: fallback used' });
    await scriptMap(missing.call, 'http://localhost:5173/y.js');
    expect(missing.sent.filter(s => s.method === 'Network.loadNetworkResource')).toHaveLength(1);
  });

  it("loads only http(s), and sends cookies only to the page's own origin", async () => {
    const { call, sent } = fakeCall({ roots: [], resources: { 'http://cdn.example/a.js': { status: 403 } } });
    expect(await scriptMap(call, 'file:///etc/passwd')).toEqual({ error: 'script not readable: was not loaded (only http and https URLs are; this is file:)' });
    expect(await scriptMap(call, 'http://cdn.example/a.js')).toEqual({ error: 'script not readable: answered 403 (loaded without cookies: another origin than the page)' });
    await scriptMap(call, 'http://localhost:5173/own.js');
    const credentials = sent.filter(s => s.method === 'Network.loadNetworkResource').map(s => [s.params.url, s.params.options.includeCredentials]);
    expect(credentials).toEqual([
      ['http://cdn.example/a.js', false],
      ['http://localhost:5173/own.js', true],
    ]);
  });
});

describe('elementSource', () => {
  const label = 'button "Add" [ref=e1]';
  const target = (call: any) => ({ kind: 'element', backendNodeId: 1, objectId: 'o', label, ref: 'e1', call }) as any;
  const stack = (url: string) => `Error: react-stack-top-frame\n    at jsxDEV (http://localhost:5173/node_modules/react/cjs/react-jsx-dev-runtime.development.js:1:1)\n    at Card (${url}:1:10)`;

  it('a malformed map becomes a note on its entries; names and other entries stay', async () => {
    const root = workspace({ 'src/List.jsx': 'x' });
    const probe = {
      tag: 'button',
      react: { dev: true, depth: 0, chain: [{ name: 'Card', stack: stack('http://localhost:5173/bad.js') }, { name: 'List', source: { fileName: '/build/src/List.jsx', lineNumber: 3, columnNumber: 5 } }] },
      grep: {},
    };
    const { call } = fakeCall({
      roots: [root],
      probe,
      resources: { 'http://localhost:5173/bad.js': { body: '//# sourceMappingURL=bad.js.map' }, 'http://localhost:5173/bad.js.map': { body: '{"version":3,"sources":["a.jsx"],"mappings":"!!!!"}' } },
    });
    const text = await elementSource(call, target(call));
    expect(text).toContain('1. Card /bad.js:1:10 (where the element is written; unusable source map: invalid character in source map mappings: "!")');
    expect(text).toContain('2. List src/List.jsx:3:5');
  });

  it('stops with a clear message when the page navigates while maps load', async () => {
    const probe = { tag: 'button', react: { dev: true, depth: 0, chain: [{ name: 'Card', stack: stack('http://localhost:5173/slow.js') }] }, grep: {} };
    const fake = fakeCall({
      roots: [],
      probe,
      resources: {},
      sendError: m => {
        if (m === 'Network.loadNetworkResource') fake.state.loaderId = 'L2';
        return undefined;
      },
    });
    await expect(elementSource(fake.call, target(fake.call))).rejects.toThrow(/navigated while its source maps were loading.*inspect again/);
  });

  it('ends at once when the page navigates while a map is still loading', async () => {
    const probe = { tag: 'button', react: { dev: true, depth: 0, chain: [{ name: 'Card', stack: stack('http://localhost:5173/hang.js') }] }, grep: {} };
    const fake = fakeCall({ roots: [], probe, resources: { 'http://localhost:5173/hang.js': { hang: true } } });
    setTimeout(() => (fake.state.loaderId = 'L2'), 300);
    const started = Date.now();
    await expect(elementSource(fake.call, target(fake.call))).rejects.toThrow(/navigated while its source maps were loading/);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('React bundled into the app: a createElement frame that maps to node_modules gives way to the next frame', async () => {
    const root = workspace({ 'src/Good.tsx': 'x' });
    const map = JSON.stringify({ version: 3, sources: ['../node_modules/react/cjs/react.development.js', '../src/Good.tsx'], mappings: 'AAAA;ACAA' });
    const mixed = 'http://localhost:5173/s/mixed.js';
    const probe = { tag: 'button', react: { dev: true, depth: 0, chain: [{ name: 'App', stack: `Error: x\n    at exports.createElement (${mixed}:1:1)\n    at App (${mixed}:2:1)` }] }, grep: {} };
    const { call } = fakeCall({ roots: [root], probe, resources: { [mixed]: { body: 'a\nb\n//# sourceMappingURL=mixed.js.map' }, [`${mixed}.map`]: { body: map } } });
    const text = await elementSource(call, target(call));
    expect(text.split('\n').slice(1)).toEqual(['1. App src/Good.tsx:1:1 (where the element is written)', 'Paths are relative to the workspace folder ' + JSON.stringify(basename(root)) + '.']);
  });

  it('lists data found nearer the element first (Svelte on the element, Vue on a shadow host)', async () => {
    const root = workspace({ 'src/Child.svelte': 'x', 'src/Host.vue': 'x' });
    const probe = {
      tag: 'button',
      vue3: { depth: 3, chain: [{ name: 'Host', file: `${root}/src/Host.vue` }] },
      svelte: { depth: 0, version: 5, loc: { file: `${root}/src/Child.svelte`, line: 7, column: 2 }, parents: [] },
      grep: {},
    };
    const { call } = fakeCall({ roots: [root], probe, resources: {} });
    const text = await elementSource(call, target(call));
    expect(text.split('\n').slice(1, 3)).toEqual(['1. Child src/Child.svelte:7:3 (where the element is written)', '2. Host src/Host.vue']);
  });

  it('Vue 2 without any __file: named components only, never "minified"; a lone root is not called a production build', async () => {
    const named = fakeCall({ roots: [], resources: {}, probe: { tag: 'span', vue2: { depth: 0, chain: [{ name: 'Panel' }, { name: 'Root', root: true }] }, grep: { text: 'Hi' } } });
    expect(await elementSource(named.call, target(named.call))).toMatch(/^Components of .*\(Vue 2 without component files \(__file\): a production build, or no vue-loader; no file locations\):\n1\. Panel\nSearch/);
    const root = fakeCall({ roots: [], resources: {}, probe: { tag: 'span', vue2: { depth: 0, chain: [{ name: 'Root', root: true }] }, grep: { text: 'Hi' } } });
    const text = await elementSource(root.call, target(root.call));
    expect(text).toMatch(/Vue 2 is present \(only its root instance, no component files\), but without file locations \(a production build, or a development build/);
    expect(text).not.toMatch(/minified/);
  });

  it('shares the workspace folder listing between calls for a few seconds', async () => {
    const root = workspace({ 'app/src/x.ts': 'x' });
    const { call } = fakeCall({ roots: [root], resources: { 'http://localhost:5173/src/x.ts': { body: 'x' } } });
    const readdir = vi.mocked(nodeFs.readdirSync);
    readdir.mockClear();
    expect(await originalLocation(call, 'http://localhost:5173/src/x.ts:1:1')).toBe('app/src/x.ts:1:1');
    const listings = readdir.mock.calls.length;
    expect(listings).toBeGreaterThan(0);
    await originalLocation(call, 'http://localhost:5173/src/x.ts:2:1');
    await originalLocation(call, 'http://localhost:5173/src/y.ts:3:1');
    expect(readdir.mock.calls.length).toBe(listings);
  });
});
