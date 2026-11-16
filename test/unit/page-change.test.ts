import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { ChangeBaselines, type Baseline } from '../../src/extension/browser/page/change';
import {
  cleanLocation,
  dedupeErrors,
  describeUpdate,
  DEV_SERVER_LOST,
  hmrPending,
  isHmrConsole,
  isHmrPending,
  isHmrRequest,
  repeatsFailedRequest,
  settleBlocker,
  type SettleFacts,
  type UpdateFacts,
} from '../../src/extension/browser/page/changeLogic';
import { formatBaseline, formatChange, formatTimeout, type ChangeReport, type ViewState } from '../../src/extension/browser/page/changeReport';
import { diffImages, percent, regions } from '../../src/extension/browser/page/imageDiff';
import { decodePng, downscale, MAX_PNG_PIXELS, UnsupportedPng, type RgbaImage } from '../../src/extension/browser/page/png';

// ---------------------------------------------------------------- a small PNG encoder for the tests

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  return Buffer.concat([head, Buffer.from(data), Buffer.alloc(4)]); // CRC not checked by the decoder
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Encodes RGB (3) or RGBA (4) pixels, filtering row y with filters[y % filters.length]. */
function encodePng(width: number, height: number, channels: 3 | 4, pixels: Uint8Array, filters: number[] = [0], header: { depth?: number; colour?: number; interlace?: number } = {}): Buffer {
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const f = filters[y % filters.length]!;
    raw[y * (stride + 1)] = f;
    for (let i = 0; i < stride; i++) {
      const x = pixels[y * stride + i]!;
      const a = i >= channels ? pixels[y * stride + i - channels]! : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + i]! : 0;
      const c = y > 0 && i >= channels ? pixels[(y - 1) * stride + i - channels]! : 0;
      const predicted = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, c);
      raw[y * (stride + 1) + 1 + i] = (x - predicted) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = header.depth ?? 8;
  ihdr[9] = header.colour ?? (channels === 4 ? 6 : 2);
  ihdr[12] = header.interlace ?? 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array())]);
}

function noise(n: number, seed = 7): Uint8Array {
  const out = new Uint8Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    out[i] = s >> 16;
  }
  return out;
}

function solid(width: number, height: number, rgb: [number, number, number] = [255, 255, 255]): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set([...rgb, 255], i * 4);
  return { width, height, data };
}

function paint(img: RgbaImage, x: number, y: number, w: number, h: number, rgb: [number, number, number]): RgbaImage {
  const data = new Uint8Array(img.data);
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) data.set([...rgb, 255], (yy * img.width + xx) * 4);
  return { ...img, data };
}

// ---------------------------------------------------------------- PNG

describe('decodePng', () => {
  it.each([0, 1, 2, 3, 4])('decodes RGBA with filter %i', filter => {
    const pixels = noise(13 * 7 * 4, filter + 1);
    const img = decodePng(encodePng(13, 7, 4, pixels, [filter]));
    expect(img.width).toBe(13);
    expect(img.height).toBe(7);
    expect(Buffer.from(img.data).equals(Buffer.from(pixels))).toBe(true);
  });

  it.each([0, 1, 2, 3, 4])('decodes RGB with filter %i, alpha 255', filter => {
    const pixels = noise(9 * 5 * 3, filter + 11);
    const img = decodePng(encodePng(9, 5, 3, pixels, [filter]));
    for (let p = 0; p < 9 * 5; p++) {
      expect([...img.data.subarray(p * 4, p * 4 + 4)]).toEqual([pixels[p * 3], pixels[p * 3 + 1], pixels[p * 3 + 2], 255]);
    }
  });

  it('decodes rows with mixed filters and split IDAT chunks', () => {
    const pixels = noise(20 * 10 * 4, 99);
    const png = encodePng(20, 10, 4, pixels, [0, 1, 2, 3, 4]);
    // Split the IDAT into two chunks.
    const idatAt = png.indexOf('IDAT') - 4;
    const len = png.readUInt32BE(idatAt);
    const data = png.subarray(idatAt + 8, idatAt + 8 + len);
    const split = Buffer.concat([png.subarray(0, idatAt), chunk('IDAT', data.subarray(0, 10)), chunk('IDAT', data.subarray(10)), png.subarray(idatAt + 12 + len)]);
    expect(Buffer.from(decodePng(split).data).equals(Buffer.from(pixels))).toBe(true);
  });

  it('refuses what it does not read', () => {
    const px = noise(4 * 4 * 4);
    expect(() => decodePng(encodePng(4, 4, 4, px, [0], { depth: 16 }))).toThrow(UnsupportedPng);
    expect(() => decodePng(encodePng(4, 4, 4, px, [0], { colour: 3 }))).toThrow(/colour type 3/);
    expect(() => decodePng(encodePng(4, 4, 4, px, [0], { interlace: 1 }))).toThrow(/interlaced/);
    expect(() => decodePng(Buffer.from('GIF89a not a png'))).toThrow(UnsupportedPng);
    const bad = encodePng(4, 4, 4, px, [0]);
    const at = bad.indexOf('IDAT') + 6;
    bad[at] = bad[at]! ^ 0xff; // damage the deflate stream
    expect(() => decodePng(bad)).toThrow(UnsupportedPng);
  });

  it('refuses images over the pixel cap before inflating them', () => {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(2001, 0);
    ihdr.writeUInt32BE(2000, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    expect(2001 * 2000).toBeGreaterThan(MAX_PNG_PIXELS);
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IEND', new Uint8Array())]);
    expect(() => decodePng(png)).toThrow(/too large/);
  });
});

describe('downscale', () => {
  it('averages whole boxes and keeps narrow images as they are', () => {
    const img: RgbaImage = { width: 4, height: 2, data: new Uint8Array([0, 0, 0, 255, 100, 100, 100, 255, 10, 20, 30, 255, 30, 40, 50, 255, 200, 200, 200, 255, 100, 100, 100, 255, 10, 20, 30, 255, 30, 40, 50, 255]) };
    const small = downscale(img, 2);
    expect(small.width).toBe(2);
    expect(small.height).toBe(1);
    expect([...small.data]).toEqual([100, 100, 100, 255, 20, 30, 40, 255]);
    expect(downscale(img, 4)).toBe(img);
  });

  it('averages the partial boxes at the edges over the pixels they have', () => {
    const img = solid(5, 3, [90, 90, 90]);
    const small = downscale(img, 2); // factor 3: 2×1
    expect([small.width, small.height]).toEqual([2, 1]);
    expect([...small.data]).toEqual([90, 90, 90, 255, 90, 90, 90, 255]);
  });

  it('brings a 1600 px screenshot to 800 px', () => {
    expect(downscale(solid(1600, 10), 800).width).toBe(800);
    expect(downscale(solid(1601, 10), 800).width).toBe(534);
  });
});

// ---------------------------------------------------------------- image diff

describe('diffImages and regions', () => {
  const base = solid(400, 200);

  it('finds nothing in identical images', () => {
    const s = regions(diffImages(base, solid(400, 200)), 1);
    expect(s).toEqual({ changed: 0, total: 80_000, regions: [], more: 0 });
    expect(percent(s.changed, s.total)).toBe('0%');
  });

  it('finds one 50×20 block with its CSS box and share', () => {
    const s = regions(diffImages(base, paint(base, 100, 40, 50, 20, [0, 0, 0])), 1);
    expect(s.regions).toEqual([{ x: 100, y: 40, width: 50, height: 20, changed: 1000 }]);
    expect(percent(s.changed, s.total)).toBe('1.3%');
  });

  it('keeps two separate blocks apart, largest first', () => {
    const after = paint(paint(base, 10, 10, 20, 20, [255, 0, 0]), 300, 100, 60, 40, [0, 0, 255]);
    const s = regions(diffImages(base, after), 1);
    expect(s.regions.map(r => [r.x, r.y, r.width, r.height])).toEqual([
      [300, 100, 60, 40],
      [10, 10, 20, 20],
    ]);
  });

  it('joins changes a cell apart (letters of one word) into one region', () => {
    const after = paint(paint(base, 100, 100, 6, 10, [0, 0, 0]), 112, 100, 6, 10, [0, 0, 0]);
    expect(regions(diffImages(base, after), 1).regions).toHaveLength(1);
  });

  it('drops a caret-sized change and ignores differences below the threshold', () => {
    expect(regions(diffImages(base, paint(base, 200, 50, 1, 18, [0, 0, 0])), 1).regions).toEqual([]);
    expect(regions(diffImages(base, paint(base, 0, 0, 400, 200, [230, 230, 230])), 1).changed).toBe(0); // Δ 25 ≤ 32
    expect(regions(diffImages(base, paint(base, 0, 0, 400, 200, [220, 220, 220])), 1).changed).toBe(80_000); // Δ 35
  });

  it('ignores lone changed pixels (anti-aliasing) scattered over the image', () => {
    let after = base;
    for (let i = 0; i < 20; i++) after = paint(after, 5 + i * 19, 3 + i * 9, 1, 1, [0, 0, 0]);
    expect(diffImages(base, after).mask.reduce((n, v) => n + v, 0)).toBe(20);
    expect(regions(diffImages(base, after), 1).changed).toBe(0);
  });

  it('converts image px to CSS px with the scale', () => {
    // An image at 0.5 image px per CSS px: a 50×20 block is 100×40 CSS px.
    const s = regions(diffImages(base, paint(base, 100, 40, 50, 20, [0, 0, 0])), 0.5);
    expect(s.regions[0]).toMatchObject({ x: 200, y: 80, width: 100, height: 40 });
    // A 1-image-px line at that scale is 2 CSS px wide: kept; at 0.625 it is 1.6 CSS px: a caret, dropped.
    expect(regions(diffImages(base, paint(base, 100, 40, 1, 20, [0, 0, 0])), 0.625).regions).toEqual([]);
  });

  it('lists at most 6 regions and counts the rest', () => {
    let after = base;
    for (let i = 0; i < 8; i++) after = paint(after, 10 + i * 48, 10, 20, 20 + i, [0, 0, 0]);
    const s = regions(diffImages(base, after), 1);
    expect(s.regions).toHaveLength(6);
    expect(s.more).toBe(2);
    expect(s.changed).toBe(Array.from({ length: 8 }, (_, i) => 20 * (20 + i)).reduce((a, b) => a + b));
  });

  it('formats shares', () => {
    expect(percent(62, 1000)).toBe('6.2%');
    expect(percent(1, 10_000)).toBe('<0.1%');
    expect(percent(1000, 1000)).toBe('100.0%');
  });
});

// ---------------------------------------------------------------- signals

describe('HMR patterns', () => {
  it('recognises update lines of Vite, webpack 5 and Next.js', () => {
    for (const line of [
      '[vite] hot updated: /src/App.vue',
      '[vite] css hot updated: /src/style.css',
      '[vite] page reload src/main.ts',
      '[vite] invalidate /src/store.ts: Could not Fast Refresh.',
      '[vite] (client) hot updated: /src/App.tsx',
      '[vite] hot updated: /src/panel.js via /src/main.js', // Vite 8
      '[HMR] Updated modules:',
      '[HMR] Nothing hot updated.',
      '[HMR] Cannot apply update. Need to do a full reload!',
      '[HMR] App is up to date.',
      '[webpack-dev-server] App updated. Recompiling...',
      '[webpack-dev-server] App hot update...',
      '[webpack-dev-server] Errors while compiling. Reload prevented.',
      '[webpack-dev-server] Warnings while compiling.',
      '[Fast Refresh] rebuilding',
      '[Fast Refresh] done in 412ms',
      '[hmr] Failed to reload /src/App.vue. This could be due to syntax errors or importing non-existent modules. (see errors above)',
    ])
      expect(isHmrConsole(line), line).toBe(true);
    for (const line of ['[vite] connecting...', '[vite] connected.', '[webpack-dev-server] Server started: Hot Module Replacement enabled, Live Reloading enabled, Progress disabled, Overlay enabled.', 'Download the React DevTools', 'hot updated'])
      expect(isHmrConsole(line), line).toBe(false);
  });

  it('knows which lines start an update that is not done yet', () => {
    expect(isHmrPending('[HMR] Checking for updates on the server...')).toBe(true);
    expect(isHmrPending('[Fast Refresh] rebuilding')).toBe(true);
    expect(isHmrPending('[webpack-dev-server] App updated. Recompiling...')).toBe(true);
    expect(isHmrPending('[HMR] App is up to date.')).toBe(false);
    expect(hmrPending(['[webpack-dev-server] App updated. Recompiling...', '[HMR] Checking for updates on the server...'])).toBe(true);
    expect(hmrPending(['[HMR] Checking for updates on the server...', '[HMR] Updated modules:', '[HMR]  - ./src/index.js', '[HMR] App is up to date.'])).toBe(false);
    expect(hmrPending(['[Fast Refresh] rebuilding', '[Fast Refresh] done in 88ms'])).toBe(false);
    expect(hmrPending(['[Fast Refresh] rebuilding'])).toBe(true);
    expect(hmrPending([])).toBe(false);
  });

  it('recognises update requests, not the long-lived event stream', () => {
    expect(isHmrRequest('http://localhost:3000/main.3f2a1b.hot-update.json')).toBe(true);
    expect(isHmrRequest('http://localhost:3000/main.3f2a1b.hot-update.js')).toBe(true);
    expect(isHmrRequest('http://localhost:5173/src/App.vue?t=1712345678901')).toBe(true);
    expect(isHmrRequest('http://localhost:5173/src/style.css?import&t=1712345678901')).toBe(true);
    expect(isHmrRequest('http://localhost:5173/src/App.vue?vue&type=style&index=0&lang.css&t=1712345678901')).toBe(true);
    expect(isHmrRequest('http://localhost:3000/__webpack_hmr')).toBe(false);
    expect(isHmrRequest('http://localhost:5173/src/main.ts')).toBe(false);
    expect(isHmrRequest('http://localhost:5173/api/items?t=12')).toBe(false);
  });

  it('notices the dev server going away', () => {
    expect(DEV_SERVER_LOST.test('[vite] server connection lost. Polling for restart...')).toBe(true);
    expect(DEV_SERVER_LOST.test('[webpack-dev-server] Disconnected!')).toBe(true);
    expect(DEV_SERVER_LOST.test('[vite] connected.')).toBe(false);
  });
});

describe('describeUpdate', () => {
  const facts = (f: Partial<UpdateFacts>): UpdateFacts => ({ documentChanged: false, urlChanged: false, consoleTexts: [], requestUrls: [], overlay: false, newErrors: 0, domChanged: false, ...f });

  it('names the update by what the dev server said', () => {
    expect(describeUpdate(facts({ consoleTexts: ['[vite] hot updated: /src/components/Cart.vue'] }))).toBe('a hot update (Vite: /src/components/Cart.vue)');
    expect(describeUpdate(facts({ consoleTexts: ['[vite] hot updated: /src/panel.js via /src/main.js'] }))).toBe('a hot update (Vite: /src/panel.js)');
    expect(describeUpdate(facts({ consoleTexts: ['[vite] hot updated: /src/a.vue', '[vite] css hot updated: /src/a.css', '[vite] hot updated: /src/a.vue'] }))).toBe('a hot update (Vite: /src/a.vue, /src/a.css)');
    expect(describeUpdate(facts({ consoleTexts: ['[HMR] Checking for updates on the server...', '[HMR] Updated modules:', '[HMR]  - ./src/App.js', '[HMR] App is up to date.'] }))).toBe('a hot update (webpack: ./src/App.js)');
    expect(describeUpdate(facts({ consoleTexts: ['[Fast Refresh] rebuilding', '[Fast Refresh] done in 120ms'] }))).toBe('a hot update (Next.js Fast Refresh)');
    expect(describeUpdate(facts({ consoleTexts: ['[webpack-dev-server] App hot update...'] }))).toBe('a hot update (webpack)');
  });

  it('prefers what happened to the document', () => {
    expect(describeUpdate(facts({ documentChanged: true, consoleTexts: ['[vite] page reload src/main.ts'] }))).toBe('a full reload (new document)');
    expect(describeUpdate(facts({ documentChanged: true, urlChanged: true }))).toBe('a navigation (new document)');
  });

  it('falls back to requests, overlays, errors and DOM changes', () => {
    expect(describeUpdate(facts({ requestUrls: ['http://localhost:5173/src/x.ts?t=1712345678901'] }))).toBe('a hot update (/src/x.ts reloaded)');
    expect(describeUpdate(facts({ overlay: true }))).toBe('a build error shown by the dev server');
    expect(describeUpdate(facts({ newErrors: 1 }))).toBe('a new error (no hot-update message seen)');
    expect(describeUpdate(facts({ domChanged: true }))).toBe('DOM changes (no hot-update message seen)');
  });
});

describe('settleBlocker', () => {
  const quiet: SettleFacts = { loading: false, documentChanged: false, loaded: true, networkIdleMs: 2000, domQuietMs: 800, churn: false, sinceSignalMs: 800, hmrPending: false };

  it('walks a hot update to settled', () => {
    const steps: Array<Partial<SettleFacts>> = [
      { hmrPending: true, networkIdleMs: 0, domQuietMs: 0, sinceSignalMs: 0 },
      { networkIdleMs: 100, domQuietMs: 50, sinceSignalMs: 200 },
      { networkIdleMs: 600, domQuietMs: 200, sinceSignalMs: 400 },
      { networkIdleMs: 900, domQuietMs: 520, sinceSignalMs: 700 },
    ];
    expect(steps.map(s => settleBlocker({ ...quiet, ...s }))).toEqual(['hmr', 'network', 'dom', undefined]);
  });

  it('waits for the load event of a new document', () => {
    expect(settleBlocker({ ...quiet, loading: true })).toBe('loading');
    expect(settleBlocker({ ...quiet, documentChanged: true, loaded: false })).toBe('loading');
    expect(settleBlocker({ ...quiet, documentChanged: true, loaded: true })).toBeUndefined();
  });

  it('on a page that changes on its own, waits a second instead of DOM quiet', () => {
    expect(settleBlocker({ ...quiet, churn: true, domQuietMs: 0, sinceSignalMs: 600 })).toBe('dom');
    expect(settleBlocker({ ...quiet, churn: true, domQuietMs: 0, sinceSignalMs: 1000 })).toBeUndefined();
  });
});

describe('errors', () => {
  it('counts errors the page already had before a reload as still there', () => {
    const errors = [{ text: 'Uncaught TypeError: x is undefined' }, { text: 'Uncaught TypeError: x is undefined' }, { text: 'Uncaught ReferenceError: y is not defined' }];
    const { fresh, still } = dedupeErrors(errors, ['Uncaught TypeError: x is undefined'], true);
    expect(still).toHaveLength(1);
    expect(fresh.map(e => e.text)).toEqual(['Uncaught TypeError: x is undefined', 'Uncaught ReferenceError: y is not defined']);
  });

  it('matches across cache-busting queries and stack lines, and not without a new document', () => {
    const errors = [{ text: 'Uncaught Error: boom at http://x/src/a.js?t=1712345678902\n    at f (http://x/src/a.js?t=1712345678902:3:9)' }];
    expect(dedupeErrors(errors, ['Uncaught Error: boom at http://x/src/a.js?t=1712345678901\n    at g'], true).still).toHaveLength(1);
    expect(dedupeErrors(errors, [errors[0]!.text], false).fresh).toHaveLength(1);
  });

  it('drops the browser\'s "Failed to load resource" line for a request listed as failed', () => {
    const urls = new Set(['http://127.0.0.1:5173/api/missing']);
    expect(repeatsFailedRequest({ source: 'browser', text: 'Failed to load resource: the server responded with a status of 404 (Not Found)', location: 'http://127.0.0.1:5173/api/missing' }, urls)).toBe(true);
    expect(repeatsFailedRequest({ source: 'browser', text: 'Failed to load resource: net::ERR_CONNECTION_REFUSED', location: 'http://127.0.0.1:5173/api/other' }, urls)).toBe(false);
    expect(repeatsFailedRequest({ source: 'exception', text: 'Failed to load resource', location: 'http://127.0.0.1:5173/api/missing' }, urls)).toBe(false);
  });

  it('removes cache-busting queries from locations', () => {
    expect(cleanLocation('/src/broken.js?t=1712345678901:4:28')).toBe('/src/broken.js:4:28');
    expect(cleanLocation('localhost:5173/src/a.css?import&t=1712345678901:1:1')).toBe('localhost:5173/src/a.css:1:1');
    expect(cleanLocation('/node_modules/.vite/deps/vue.js?v=3f2a1b9c:120:5')).toBe('/node_modules/.vite/deps/vue.js:120:5');
    expect(cleanLocation('/src/x.ts:3:1')).toBe('/src/x.ts:3:1');
  });
});

// ---------------------------------------------------------------- reports

const view: ViewState = { width: 1280, height: 720, scrollX: 0, scrollY: 0 };

function report(r: Partial<ChangeReport>): ChangeReport {
  return {
    tabId: 'tab-2',
    update: 'a hot update (Vite: /src/components/Cart.vue)',
    elapsedMs: 1300,
    errors: [],
    moreErrors: 0,
    failures: [],
    moreFailures: 0,
    still: { errors: 0, failures: 0 },
    earlier: { errors: 0, failures: 0 },
    warnings: 0,
    crashed: false,
    imageAttached: false,
    ...r,
  };
}

describe('formatBaseline', () => {
  it('says what was recorded and what to do next', () => {
    expect(formatBaseline({ tabId: 'tab-2', url: 'http://localhost:5173/cart', view, errors: 1, failures: 0, churn: false })).toBe(
      'Baseline of tab-2 taken: http://localhost:5173/cart, viewport 1280×720 at scroll 0,0; 1 console error and 0 failed requests on this page so far (not repeated in the check). Edit the code, then call browser_check_change with action "check".',
    );
  });

  it('warns about a page that changes on its own, and an image that cannot be compared', () => {
    const text = formatBaseline({ tabId: 'tab-2', url: 'http://x/', view, errors: 0, failures: 2, churn: true, imageProblem: 'unsupported image' });
    expect(text).toContain('2 failed requests');
    expect(text).toContain('DOM changes alone will not count as the update');
    expect(text).toContain('Screenshots will not be compared (unsupported image).');
  });
});

describe('formatChange', () => {
  it('a hot update with an error, a failed request and changed regions', () => {
    const text = formatChange(
      report({
        errors: ["[exception] Uncaught TypeError: Cannot read properties of undefined (reading 'price')  (src/components/Cart.vue:31:18)"],
        failures: ['r57  GET 404 fetch  http://localhost:5173/api/cart/totals'],
        warnings: 2,
        imageAttached: true,
        screenshot: {
          kind: 'diff',
          changed: 57_139,
          total: 921_600,
          regions: [
            { x: 340, y: 210, width: 600, height: 270, changed: 53_453 },
            { x: 1100, y: 20, width: 160, height: 32, changed: 3686 },
          ],
          more: 0,
        },
      }),
    );
    expect(text).toBe(
      [
        'Change in tab-2 after a hot update (Vite: /src/components/Cart.vue), settled after 1.3 s:',
        '- 1 new error:',
        "  [exception] Uncaught TypeError: Cannot read properties of undefined (reading 'price')  (src/components/Cart.vue:31:18)",
        '- 1 new failed request: r57  GET 404 fetch  http://localhost:5173/api/cart/totals',
        '- Screenshot: 6.2% changed in 2 regions (viewport CSS px): x 340–940 y 210–480 (5.8%); x 1100–1260 y 20–52 (0.4%). After-screenshot attached.',
        '+ 2 new warnings (browser_console_messages shows them).',
      ].join('\n'),
    );
  });

  it('nothing changed', () => {
    expect(formatChange(report({ update: 'a hot update (Vite: /src/utils/format.ts)', elapsedMs: 600, screenshot: { kind: 'diff', changed: 0, total: 100, regions: [], more: 0 } }))).toBe(
      'Change in tab-2 after a hot update (Vite: /src/utils/format.ts), settled after 600 ms: no new errors or failed requests, and the screenshot is unchanged. The edit does not show in this view (other route or state?), or it did not apply.',
    );
  });

  it('a reload that navigated, with an error still there', () => {
    const text = formatChange(
      report({
        update: 'a navigation (new document)',
        elapsedMs: 2100,
        navigated: { from: 'http://localhost:5173/cart', to: 'http://localhost:5173/login' },
        still: { errors: 1, failures: 0 },
        imageAttached: true,
        screenshot: { kind: 'diff', changed: 658_000, total: 921_600, regions: [{ x: 0, y: 0, width: 1280, height: 720, changed: 658_000 }], more: 0 },
      }),
    );
    expect(text).toContain('- Navigated: http://localhost:5173/cart → http://localhost:5173/login');
    expect(text).toContain('- Still there from before the change: 1 error (same text).');
    expect(text).toContain('- Screenshot: 71.4% changed in 1 region (viewport CSS px): x 0–1280 y 0–720. After-screenshot attached.');
    expect(text).not.toContain('(71.4%)');
  });

  it('a crash', () => {
    const text = formatChange(report({ crashed: true, errors: ['[exception] Uncaught RangeError: Maximum call stack size exceeded  (/src/loop.ts:3:9)'] }));
    expect(text).toBe(
      [
        'The page in tab-2 crashed after the change (renderer gone). Reload it with browser_history (action "reload") once the cause is fixed.',
        '- 1 new error before the crash:',
        '  [exception] Uncaught RangeError: Maximum call stack size exceeded  (/src/loop.ts:3:9)',
      ].join('\n'),
    );
  });

  it('a build error overlay', () => {
    const text = formatChange(report({ update: 'a build error shown by the dev server', overlay: { kind: 'Vite error overlay', text: '[plugin:vite:vue] src/components/Cart.vue: Unexpected token (31:18)' }, screenshot: { kind: 'diff', changed: 0, total: 1, regions: [], more: 0 } }));
    expect(text).toContain('- Build error shown in the page (Vite error overlay): [plugin:vite:vue] src/components/Cart.vue: Unexpected token (31:18). Fix the file; the page updates by itself once it compiles.');
    expect(text).toContain('- Screenshot unchanged.');
  });

  it('an overlay that was there at the baseline: still shown, or gone', () => {
    const unchanged = { kind: 'diff' as const, changed: 0, total: 1, regions: [], more: 0 };
    expect(formatChange(report({ overlayBefore: 'still', screenshot: unchanged }))).toContain('- The build error shown at the baseline is still shown.');
    const gone = formatChange(report({ overlayBefore: 'gone', screenshot: unchanged }));
    expect(gone).toContain('- The build error shown at the baseline is gone.');
    expect(gone).not.toContain('the screenshot is unchanged. The edit does not show');
    expect(formatBaseline({ tabId: 'tab-2', url: 'http://x/', view, errors: 0, failures: 0, churn: false, overlay: { kind: 'Vite error overlay', text: '[plugin:vite:vue] Unexpected token (31:18)' } })).toContain(
      'The page shows a build error (Vite error overlay): [plugin:vite:vue] Unexpected token (31:18). Edit the code',
    );
  });

  it('a page that did not settle', () => {
    const text = formatChange(report({ unsettled: { blocker: 'dom', ms: 10_000 }, screenshot: { kind: 'diff', changed: 0, total: 1, regions: [], more: 0 } }));
    expect(text).toMatch(/^Change in tab-2 after a hot update \(Vite: \/src\/components\/Cart\.vue\), compared after 1\.3 s: no new errors/);
    expect(text).toContain('Note: the page kept changing for 10 s after the update (animation, polling or a live feed); the comparison includes those changes.');
    expect(formatChange(report({ unsettled: { blocker: 'network', ms: 3000 } }))).toContain('Note: requests were still running 3.0 s after the update');
    expect(formatChange(report({ unsettled: { blocker: 'hmr', ms: 3000 } }))).toContain('Note: the hot update had not completed');
    expect(formatChange(report({ unsettled: { blocker: 'loading', ms: 3000 } }))).toContain('Note: the page was still loading');
  });

  it('a viewport that changed size, a scroll, earlier reports and a lost dev server', () => {
    const text = formatChange(
      report({
        screenshot: { kind: 'resized', from: view, to: { width: 390, height: 844, scrollX: 0, scrollY: 0 } },
        imageAttached: true,
        scrolled: { from: view, to: { ...view, scrollY: 640 } },
        earlier: { errors: 1, failures: 2 },
        devServerLost: '[vite] server connection lost. Polling for restart...',
      }),
    );
    expect(text).toContain('- Viewport changed size (1280×720 → 390×844), so the screenshots are not compared. After-screenshot attached.');
    expect(text).toContain('- Scrolled from 0,0 to 0,640 since the baseline; the regions include that shift.');
    expect(text).toContain('- Reported by an earlier check of this baseline, not repeated: 1 error and 2 failed requests.');
    expect(text).toContain('- The dev server connection was lost ([vite] server connection lost. Polling for restart...): is it still running?');
  });

  it('lists many errors and failed requests with a count of the rest', () => {
    const text = formatChange(report({ errors: ['[error] a', '[error] b'], moreErrors: 3, failures: ['r1 …', 'r2 …'], moreFailures: 1, screenshot: { kind: 'skipped', reason: 'unsupported image' } }));
    expect(text).toContain('- 5 new errors:\n  [error] a\n  [error] b\n  +3 more (browser_console_messages shows them)');
    expect(text).toContain('- 3 new failed requests:\n  r1 …\n  r2 …\n  +1 more (browser_network_requests shows them)');
    expect(text).toContain('- Screenshots not compared (unsupported image).');
  });
});

describe('formatTimeout', () => {
  it('says nothing arrived and what to check', () => {
    expect(formatTimeout({ tabId: 'tab-2', timeoutMs: 15_000, sinceMs: 48_000, since: 'baseline', churn: false })).toBe(
      'No update reached tab-2 within 15 s (no hot update, reload, DOM change or error since the baseline 48 s ago). If the edit should show here: is the dev server running and watching that file (check its terminal)? A page without hot reload needs check with reload: true.',
    );
  });

  it('on a page that changes on its own, and after a lost connection', () => {
    const text = formatTimeout({ tabId: 'tab-2', timeoutMs: 2000, sinceMs: 5000, since: 'last check', churn: true, devServerLost: '[webpack-dev-server] Disconnected!' });
    expect(text).toContain('DOM changes do not count on this page, which changes on its own since the last check 5.0 s ago');
    expect(text).toContain('- The dev server connection was lost ([webpack-dev-server] Disconnected!): is it still running?');
  });
});

// ---------------------------------------------------------------- baselines

describe('ChangeBaselines', () => {
  const baseline = (tabId: string): Baseline => ({ tabId, seq: 0, loaderId: 'l', url: 'u', takenAt: 0, docErrors: [], docFailures: [], view, churn: false, lastOverlay: '', watch: { loaderId: 'l', count: 0 } });

  it('keeps the 10 most recently used, per session and tab', () => {
    const store = new ChangeBaselines(() => true);
    for (let i = 0; i < 11; i++) store.set(`s1\u0000tab-${i}`, baseline(`tab-${i}`));
    expect(store.size).toBe(10);
    expect(store.get('s1\u0000tab-0')).toBeUndefined();
    expect(store.get('s1\u0000tab-1')).toBeDefined();
    store.set('s1\u0000tab-11', baseline('tab-11'));
    expect(store.get('s1\u0000tab-1')).toBeDefined(); // used recently: kept
    expect(store.get('s1\u0000tab-2')).toBeUndefined();
  });

  it('drops a session\'s baselines and those of closed tabs', () => {
    const open = new Set(['tab-1', 'tab-2']);
    const store = new ChangeBaselines(id => open.has(id));
    store.set('s1\u0000tab-1', baseline('tab-1'));
    store.set('s2\u0000tab-1', baseline('tab-1'));
    store.set('s1\u0000tab-2', baseline('tab-2'));
    store.dropSession('s1');
    expect(store.get('s1\u0000tab-1')).toBeUndefined();
    expect(store.get('s2\u0000tab-1')).toBeDefined();
    open.delete('tab-1');
    expect(store.get('s2\u0000tab-1')).toBeUndefined();
    expect(store.size).toBe(0);
  });
});
