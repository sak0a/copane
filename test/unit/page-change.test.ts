import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { ChangeBaselines, OVERLAY_TEXT, STOP_WATCH, WATCH, type Baseline } from '../../src/extension/browser/page/change';
import {
  cleanLocation,
  dedupeErrors,
  dedupeFailures,
  describeUpdate,
  DEV_SERVER_LOST,
  errorsWithoutFailedRequests,
  failedResourceUrl,
  hmrState,
  hookGeometry,
  isBackgroundRequest,
  isFailedResourceLine,
  isHmrConsole,
  isHmrPending,
  isHmrRequest,
  isRecurring,
  nodeVerdict,
  forgetUpdate,
  recordMutation,
  recurringErrors,
  recurringRequests,
  reloadedFrames,
  requestKey,
  settleBlocker,
  stillInFlight,
  type NodeRecord,
  type SettleFacts,
  type UpdateFacts,
} from '../../src/extension/browser/page/changeLogic';
import { formatBaseline, formatChange, formatNoUpdate, formatStuck, formatTimeout, type ChangeReport, type ViewState } from '../../src/extension/browser/page/changeReport';
import { diffImages, percent, regions } from '../../src/extension/browser/page/imageDiff';
import { crop, decodePng, downscale, MAX_PNG_PIXELS, UnsupportedPng, type RgbaImage } from '../../src/extension/browser/page/png';
import { WITHHELD_MESSAGE } from '../../src/extension/browser/page/privacy';

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

describe('decodePng on hostile input', () => {
  it('refuses a short header, and turns any malformed input into UnsupportedPng', () => {
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(() => decodePng(Buffer.concat([sig, chunk('IHDR', new Uint8Array(4)), chunk('IEND', new Uint8Array())]))).toThrow(UnsupportedPng);
    const good = encodePng(4, 4, 4, noise(64));
    for (let cut = 9; cut < good.length; cut += 7) {
      try {
        decodePng(good.subarray(0, cut));
      } catch (err) {
        expect(err).toBeInstanceOf(UnsupportedPng);
      }
    }
  });

  it('does not inflate more than the header promises (a decompression bomb)', () => {
    // A 1×1 image whose data inflates to 50 MB.
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(1, 0);
    ihdr.writeUInt32BE(1, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    const bomb = deflateSync(Buffer.alloc(50_000_000));
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', bomb), chunk('IEND', new Uint8Array())]);
    const started = Date.now();
    expect(() => decodePng(png)).toThrow(UnsupportedPng);
    expect(Date.now() - started).toBeLessThan(1000);
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

  it('caps the pixels of tall images too', () => {
    const tall = downscale(solid(800, 1437), 800, 400_000);
    expect(tall.width * tall.height).toBeLessThanOrEqual(400_000);
    expect([tall.width, tall.height]).toEqual([400, 719]);
    expect(downscale(solid(780, 500), 800, 400_000).width).toBe(780);
  });

  it('crops to the top-left part', () => {
    const img = paint(solid(10, 6), 0, 0, 4, 3, [0, 0, 0]);
    const part = crop(img, 4, 3);
    expect([part.width, part.height]).toEqual([4, 3]);
    expect([...part.data.subarray(0, 4)]).toEqual([0, 0, 0, 255]);
    expect(crop(img, 50, 50)).toBe(img);
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
  it('recognises update lines of Vite, webpack 5 (dev server 5 and 6) and Next.js', () => {
    for (const line of [
      '[vite] hot updated: /src/App.vue',
      '[vite] css hot updated: /src/style.css',
      '[vite] page reload src/main.ts',
      '[vite] invalidate /src/store.ts: Could not Fast Refresh.',
      '[vite] (client) hot updated: /src/App.tsx',
      '[vite] hot updated: /src/panel.js via /src/main.js', // Vite 8, real
      // webpack 5.112 + webpack-dev-server 5.2.7, real
      '[webpack-dev-server] App updated. Recompiling...',
      '[webpack-dev-server] App hot update...',
      '[webpack-dev-server] Nothing changed.',
      '[webpack-dev-server] Errors while compiling. Reload prevented.',
      '[webpack-dev-server] Warnings while compiling.',
      '[HMR] Checking for updates on the server...',
      '[HMR] Updated modules:',
      '[HMR]  - ./src/panel.js',
      '[HMR] App is up to date.',
      '[HMR] Nothing hot updated.',
      '[HMR] Cannot apply update. Need to do a full reload!',
      '[HMR] Cannot find update. Need to do a full reload!',
      // webpack-dev-server 6.1 (webpack-dev-middleware 8.6 client), real
      '[webpack-dev-server] bundle rebuilding (/private/tmp/app/src/panel.js changed)',
      '[webpack-dev-server] bundle rebuilt in 29ms',
      '[webpack-dev-server] Checking for updates on the server...',
      '[webpack-dev-server] Hot updated 1 modules.',
      '[webpack-dev-server] App is up to date.',
      '[webpack-dev-server] bundle has 1 errors',
      '[webpack-dev-server] Reloading page',
      '[Fast Refresh] rebuilding',
      '[Fast Refresh] done in 412ms',
      '[hmr] Failed to reload /src/App.vue. This could be due to syntax errors or importing non-existent modules. (see errors above)',
    ])
      expect(isHmrConsole(line), line).toBe(true);
    for (const line of [
      '[vite] connecting...',
      '[vite] connected.',
      '[webpack-dev-server] Server started: Hot Module Replacement enabled, Live Reloading enabled, Progress disabled, Overlay enabled.',
      '[webpack-dev-server] connected',
      '[webpack-dev-server] Trying to reconnect...',
      'Download the React DevTools',
      'hot updated',
    ])
      expect(isHmrConsole(line), line).toBe(false);
  });

  it('knows which lines start an update that is not done yet', () => {
    expect(isHmrPending('[HMR] Checking for updates on the server...')).toBe(true);
    expect(isHmrPending('[Fast Refresh] rebuilding')).toBe(true);
    expect(isHmrPending('[webpack-dev-server] App updated. Recompiling...')).toBe(true);
    expect(isHmrPending('[webpack-dev-server] bundle rebuilding (/a/src/x.js changed)')).toBe(true);
    expect(isHmrPending('[HMR] App is up to date.')).toBe(false);
  });

  it('follows an update cycle to its end, including "nothing changed"', () => {
    const at = (texts: string[], t0 = 0) => texts.map((text, i) => ({ text, time: t0 + i * 10 }));
    const state = (texts: string[], now = 1000) => hmrState(at(texts), now);
    expect(state([])).toBe('none');
    expect(state(['[vite] connected.'])).toBe('none');
    expect(state(['[webpack-dev-server] App updated. Recompiling...', '[webpack-dev-server] App hot update...', '[HMR] Checking for updates on the server...'])).toBe('pending');
    // webpack-dev-server 5, a real hot update
    expect(state(['[webpack-dev-server] App updated. Recompiling...', '[webpack-dev-server] App hot update...', '[HMR] Checking for updates on the server...', '[HMR] Updated modules:', '[HMR]  - ./src/panel.js', '[HMR] App is up to date.'])).toBe('done');
    // webpack-dev-server 5, an identical rebuild (the file was touched)
    expect(state(['[webpack-dev-server] App updated. Recompiling...', '[webpack-dev-server] Nothing changed.'])).toBe('nothing');
    // webpack-dev-server 6, a real update, and an identical rebuild: "bundle rebuilding" and then nothing
    expect(state(['[webpack-dev-server] bundle rebuilding (/a/src/panel.js changed)', '[webpack-dev-server] bundle rebuilt in 27ms', '[webpack-dev-server] Checking for updates on the server...', '[webpack-dev-server] Hot updated 1 modules.', '[webpack-dev-server] App is up to date.'])).toBe('done');
    expect(state(['[webpack-dev-server] bundle rebuilding (/a/src/title.js changed)'], 2000)).toBe('pending');
    expect(state(['[webpack-dev-server] bundle rebuilding (/a/src/title.js changed)'], 5000)).toBe('silent');
    // A real update, then an identical rebuild: the update counts.
    expect(state(['[vite] hot updated: /src/a.js', '[webpack-dev-server] App updated. Recompiling...', '[webpack-dev-server] Nothing changed.'])).toBe('done');
    expect(state(['[Fast Refresh] rebuilding', '[Fast Refresh] done in 88ms'])).toBe('done');
    expect(state(['[Fast Refresh] rebuilding'])).toBe('pending');
  });

  it('recognises update requests only as same-origin modules and stylesheets, or webpack hot-update files', () => {
    const page = 'http://localhost:5173/cart';
    const req = (url: string, type: string) => isHmrRequest({ url, type }, page);
    expect(req('http://localhost:5173/main.3f2a1b.hot-update.json', 'Fetch')).toBe(true);
    expect(req('http://localhost:5173/main.3f2a1b.hot-update.js', 'Script')).toBe(true);
    expect(req('http://localhost:5173/src/App.vue?t=1712345678901', 'Script')).toBe(true);
    expect(req('http://localhost:5173/src/style.css?import&t=1712345678901', 'Script')).toBe(true);
    expect(req('http://localhost:5173/src/style.css?t=1712345678901', 'Stylesheet')).toBe(true);
    expect(req('http://localhost:5173/src/App.vue?vue&type=style&index=0&lang.css&t=1712345678901', 'Script')).toBe(true);
    // A page that polls with a timestamp, an image with one, another origin: not updates.
    expect(req('http://localhost:5173/api/status?t=1731750000000', 'Fetch')).toBe(false);
    expect(req('http://localhost:5173/api/status?t=1731750000000', 'XHR')).toBe(false);
    expect(req('http://localhost:5173/avatar.png?t=1731750000000', 'Image')).toBe(false);
    expect(req('http://localhost:5173/beacon?t=1731750000000', 'Ping')).toBe(false);
    expect(req('http://cdn.example.com/lib.js?t=1731750000000', 'Script')).toBe(false);
    expect(req('http://localhost:5173/main.3f2a1b.hot-update.json', 'Image')).toBe(false);
    expect(req('http://localhost:5173/__webpack_hmr', 'EventSource')).toBe(false);
    expect(req('http://localhost:5173/src/main.ts', 'Script')).toBe(false);
  });

  it('tells the page\'s own requests (polling, streams) from the update\'s', () => {
    const before = [
      { url: 'http://x/api/status?t=1', type: 'Fetch' },
      { url: 'http://x/api/status?t=2', type: 'Fetch' },
      { url: 'http://x/api/user', type: 'Fetch' },
      { url: 'http://x/src/app.js?t=1712345678901', type: 'Script' },
      { url: 'http://x/src/app.js?t=1712345678902', type: 'Script' },
    ];
    const recurring = recurringRequests(before);
    expect([...recurring]).toEqual(['http://x/api/status']);
    expect(isBackgroundRequest({ url: 'http://x/api/status?t=3', type: 'Fetch' }, recurring)).toBe(true);
    expect(isBackgroundRequest({ url: 'http://x/api/user', type: 'Fetch' }, recurring)).toBe(false);
    expect(isBackgroundRequest({ url: 'http://x/src/app.js?t=1712345678903', type: 'Script' }, recurring)).toBe(false);
    expect(isBackgroundRequest({ url: 'http://x/events', type: 'EventSource' }, recurring)).toBe(true);
    expect(isBackgroundRequest({ url: 'ws://x/ws', type: 'WebSocket' }, recurring)).toBe(true);
    expect(requestKey('http://x/a?b=1#c')).toBe('http://x/a');
  });

  it('notices the dev server going away', () => {
    expect(DEV_SERVER_LOST.test('[vite] server connection lost. Polling for restart...')).toBe(true);
    expect(DEV_SERVER_LOST.test('[webpack-dev-server] Disconnected!')).toBe(true);
    expect(DEV_SERVER_LOST.test('[vite] connected.')).toBe(false);
  });
});

describe('DOM changes the page makes on its own', () => {
  /** Feeds changes at these page times into one element's record. */
  const feed = (times: number[]) => times.reduce<NodeRecord | undefined>((r, t) => recordMutation(r, t), undefined)!;

  it('a clock ticking every 2 s or every 5 s changes on its own from its third tick; every second, from its second', () => {
    expect(isRecurring(feed([1000, 3000]))).toBe(false);
    expect(isRecurring(feed([1000, 3000, 5000]))).toBe(true);
    expect(isRecurring(feed([1000, 2000]))).toBe(true);
    expect(isRecurring(feed([1000, 6000, 11_000]))).toBe(true);
    expect(nodeVerdict(feed([1000, 2000, 3000]), 3500, 0)).toBe('recurring');
    // Until then its changes are not counted yet (they do not stay still for 5.5 s).
    expect(nodeVerdict(feed([1000]), 1900, 0)).toBe('pending');
    expect(nodeVerdict(feed([1000, 6000]), 10_000, 0)).toBe('pending');
  });

  it('two changes within 1.5 s, or a second of continuous change, is an animation', () => {
    expect(isRecurring(feed([1000, 2200]))).toBe(true);
    expect(isRecurring(feed(Array.from({ length: 70 }, (_, i) => i * 16)))).toBe(true);
    expect(isRecurring(feed(Array.from({ length: 20 }, (_, i) => i * 16)))).toBe(false);
  });

  it('an element edited twice, 3 s apart, is an edit both times (not a clock)', () => {
    // Watch started at 0; edits at 6 s and 9 s.
    expect(nodeVerdict(feed([6000]), 6100, 0)).toBe('changed');
    const twice = feed([6000, 9000]);
    expect(isRecurring(twice)).toBe(false);
    expect(nodeVerdict(twice, 10_000, 0)).toBe('pending');
    expect(nodeVerdict(twice, 14_600, 0)).toBe('changed');
  });

  it('the mark expires when the element has been still for twice its interval (at least 4 s)', () => {
    const clock = feed([1000, 2000, 3000]);
    expect(nodeVerdict(clock, 6900, 0)).toBe('recurring');
    expect(nodeVerdict(clock, 7100, 0)).toBe('idle');
    // Its next change starts a new record: an ordinary element again.
    const later = recordMutation(clock, 20_000);
    expect(later).toMatchObject({ first: 20_000, bursts: 1, establishedAt: 0 });
    const slow = feed([0, 10_000, 20_000]);
    expect(nodeVerdict(slow, 39_000, 0)).toBe('recurring');
    expect(nodeVerdict(slow, 41_000, 0)).toBe('idle');
  });

  it('a first change soon after the watch began waits to be told from a slow clock; later it counts at once', () => {
    expect(nodeVerdict(feed([800]), 2000, 0)).toBe('pending');
    expect(nodeVerdict(feed([800]), 6400, 0)).toBe('changed');
    expect(nodeVerdict(feed([9000]), 9100, 0)).toBe('changed');
  });

  it('remembers when an element was first seen changing on its own, and forgets what a recognised update changed', () => {
    const clock = feed([1000, 3000, 5000, 7000]);
    expect(clock.establishedAt).toBe(5000);
    expect(feed([1000, 2000]).establishedAt).toBe(2000);
    expect(forgetUpdate(clock, 6500)).toBe(false); // known before the update: stays known
    expect(forgetUpdate(feed([5000, 5600]), 4000)).toBe(true); // changed (twice) during the update: forgotten
    expect(forgetUpdate(feed([2000]), 4000)).toBe(false); // not changed since: kept
  });

  it('a record of changes in one burst stays one burst', () => {
    expect(feed([1000, 1100, 1200])).toEqual({ first: 1000, last: 1200, bursts: 1, minGap: Infinity, establishedAt: 0 });
    expect(feed([1000, 1300])).toMatchObject({ bursts: 2, minGap: 300 });
  });

  it('the page script embeds these functions as they are', () => {
    // WATCH inlines their source; they must be self-contained apart from each other.
    const scope = new Function(`const ${isRecurring.name} = ${isRecurring.toString()}; const ${recordMutation.name} = ${recordMutation.toString()}; const ${nodeVerdict.name} = ${nodeVerdict.toString()}; const ${forgetUpdate.name} = ${forgetUpdate.toString()}; return [${recordMutation.name}, ${nodeVerdict.name}, ${forgetUpdate.name}];`)();
    const [rec, verdict] = scope as [typeof recordMutation, typeof nodeVerdict];
    const r = [1000, 2000, 3000].reduce<NodeRecord | undefined>((x, t) => rec(x, t), undefined)!;
    expect(verdict(r, 3500, 0)).toBe('recurring');
  });
});

describe('requests in flight', () => {
  const req = (e: Partial<Parameters<typeof stillInFlight>[0]>) => ({ end: undefined, failed: undefined, status: undefined, type: 'Script', startedAt: 0, loaderId: 'L2', seq: 50, ...e });
  const doc = { loaderId: 'L2', startSeq: 40 };

  it('only requests of the current document keep the page busy', () => {
    expect(stillInFlight(req({}), 1000, doc)).toBe(true);
    // A hot-update script the previous document started, never finished: gone with that document.
    expect(stillInFlight(req({ loaderId: 'L1', seq: 30 }), 1000, doc)).toBe(false);
    expect(stillInFlight(req({ loaderId: undefined, seq: 30 }), 1000, doc)).toBe(false);
    // The new document's own request is sent before its navigation is recorded.
    expect(stillInFlight(req({ type: 'Document', seq: 38 }), 1000, doc)).toBe(true);
  });

  it('finished, failed, answered, streams and very old requests do not', () => {
    for (const e of [{ end: 5 }, { failed: 'net::ERR_ABORTED' }, { status: 200 }, { type: 'EventSource' }, { type: 'WebSocket' }]) expect(stillInFlight(req(e), 1000, doc), JSON.stringify(e)).toBe(false);
    expect(stillInFlight(req({}), 61_000, doc)).toBe(false);
  });
});

describe('frames', () => {
  it('reports frames whose document was replaced, not frames that came or went', () => {
    const before = { a: { loaderId: 'L1', url: 'http://x/a' }, b: { loaderId: 'L2', url: 'http://y/b' } };
    expect(reloadedFrames(before, { a: { loaderId: 'L1', url: 'http://x/a' }, b: { loaderId: 'L3', url: 'http://y/b' } })).toEqual(['http://y/b']);
    expect(reloadedFrames(before, { a: { loaderId: 'L1', url: 'http://x/a' }, c: { loaderId: 'L9', url: 'http://z/' } })).toEqual([]);
  });
});

describe('describeUpdate', () => {
  const facts = (f: Partial<UpdateFacts>): UpdateFacts => ({ documentChanged: false, urlChanged: false, consoleTexts: [], requestUrls: [], overlay: false, newErrors: 0, domChanged: false, frames: [], ...f });

  it('names the update by what the dev server said', () => {
    expect(describeUpdate(facts({ consoleTexts: ['[vite] hot updated: /src/components/Cart.vue'] }))).toBe('a hot update (Vite: /src/components/Cart.vue)');
    expect(describeUpdate(facts({ consoleTexts: ['[vite] hot updated: /src/panel.js via /src/main.js'] }))).toBe('a hot update (Vite: /src/panel.js)');
    expect(describeUpdate(facts({ consoleTexts: ['[vite] hot updated: /src/a.vue', '[vite] css hot updated: /src/a.css', '[vite] hot updated: /src/a.vue'] }))).toBe('a hot update (Vite: /src/a.vue, /src/a.css)');
    expect(describeUpdate(facts({ consoleTexts: ['[HMR] Checking for updates on the server...', '[HMR] Updated modules:', '[HMR]  - ./src/App.js', '[HMR] App is up to date.'] }))).toBe('a hot update (webpack: ./src/App.js)');
    expect(describeUpdate(facts({ consoleTexts: ['[webpack-dev-server] bundle rebuilding (/private/tmp/change-check-webpack/app/src/panel.js changed)', '[webpack-dev-server] Hot updated 1 modules.'] }))).toBe('a hot update (webpack: …/app/src/panel.js)');
    expect(describeUpdate(facts({ consoleTexts: ['[Fast Refresh] rebuilding', '[Fast Refresh] done in 120ms'] }))).toBe('a hot update (Next.js Fast Refresh)');
    expect(describeUpdate(facts({ consoleTexts: ['[webpack-dev-server] App hot update...'] }))).toBe('a hot update (webpack)');
  });

  it('prefers what happened to the document', () => {
    expect(describeUpdate(facts({ documentChanged: true, consoleTexts: ['[vite] page reload src/main.ts'] }))).toBe('a full reload (new document)');
    expect(describeUpdate(facts({ documentChanged: true, urlChanged: true }))).toBe('a navigation (new document)');
  });

  it('falls back to requests, frames, overlays, errors and DOM changes', () => {
    expect(describeUpdate(facts({ requestUrls: ['http://localhost:5173/src/x.ts?t=1712345678901'] }))).toBe('a hot update (/src/x.ts reloaded)');
    expect(describeUpdate(facts({ frames: ['http://127.0.0.2:4000/story.html'] }))).toBe('a reload of the frame http://127.0.0.2:4000/story.html');
    expect(describeUpdate(facts({ overlay: true }))).toBe('an error shown by the dev server');
    expect(describeUpdate(facts({ newErrors: 1 }))).toBe('a new error (no hot-update message seen)');
    expect(describeUpdate(facts({ newFailures: 1 }))).toBe('a failed request (no hot-update message seen)');
    expect(describeUpdate(facts({ domChanged: true }))).toBe('DOM changes only, no dev-server message (if this page changes on its own, this may not be your edit: check again, or use reload: true)');
  });
});

describe('settleBlocker', () => {
  const quiet: SettleFacts = { loading: false, documentChanged: false, loaded: true, networkIdleMs: 2000, domQuietMs: 800, hmrPending: false };

  it('walks a hot update to settled', () => {
    const steps: Array<Partial<SettleFacts>> = [
      { hmrPending: true, networkIdleMs: 0, domQuietMs: 0 },
      { networkIdleMs: 100, domQuietMs: 50 },
      { networkIdleMs: 600, domQuietMs: 200 },
      { networkIdleMs: 900, domQuietMs: 520 },
    ];
    expect(steps.map(s => settleBlocker({ ...quiet, ...s }))).toEqual(['hmr', 'network', 'dom', undefined]);
  });

  it('waits for the load event of a new document', () => {
    expect(settleBlocker({ ...quiet, loading: true })).toBe('loading');
    expect(settleBlocker({ ...quiet, documentChanged: true, loaded: false })).toBe('loading');
    expect(settleBlocker({ ...quiet, documentChanged: true, loaded: true })).toBeUndefined();
  });
});

describe('errors and failed requests', () => {
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

  it('counts a failed request the page had before a reload as still there, by URL', () => {
    // The baseline knew /missing.png only from the browser's console line (it failed before recording began).
    const failures = [{ url: 'http://x/missing.png' }, { url: 'http://x/api/new' }];
    const { fresh, still } = dedupeFailures(failures, ['http://x/missing.png'], true);
    expect(still.map(f => f.url)).toEqual(['http://x/missing.png']);
    expect(fresh.map(f => f.url)).toEqual(['http://x/api/new']);
    expect(dedupeFailures(failures, ['http://x/missing.png'], false).fresh).toHaveLength(2);
  });

  it('reads the URL of the browser\'s "Failed to load resource" line', () => {
    const line = { source: 'browser', level: 'error', text: 'Failed to load resource: the server responded with a status of 404 (Not Found)', location: 'http://x/missing.png' };
    expect(isFailedResourceLine(line)).toBe(true);
    expect(failedResourceUrl({ ...line, location: 'http://x/missing.png:1' })).toBe('http://x/missing.png');
    expect(isFailedResourceLine({ ...line, source: 'console' })).toBe(false);
  });

  it('drops the browser\'s "Failed to load resource" line for a request listed as failed, also when withheld', () => {
    const e = (text: string, location?: string, source = 'browser') => ({ source, level: 'error', text, location });
    const entries = [
      e('Failed to load resource: the server responded with a status of 404 (Not Found)', 'http://127.0.0.1:5173/api/missing'),
      e('Failed to load resource: net::ERR_CONNECTION_REFUSED', 'http://127.0.0.1:5173/api/other'),
      e('Uncaught TypeError: boom', 'http://127.0.0.1:5173/src/a.js:1:1', 'exception'),
      // Logged while the user had the tab: no text, no location.
      e(WITHHELD_MESSAGE),
      e(WITHHELD_MESSAGE),
    ];
    const kept = errorsWithoutFailedRequests(entries, [{ url: 'http://127.0.0.1:5173/api/missing' }, { url: 'https://idp.example/token?…', withheld: true }]);
    expect(kept.map(k => k.text)).toEqual(['Failed to load resource: net::ERR_CONNECTION_REFUSED', 'Uncaught TypeError: boom', WITHHELD_MESSAGE]);
  });

  it('knows errors the page logs again and again', () => {
    expect([...recurringErrors([{ text: 'GET /api/status failed', count: 3 }, { text: 'once', count: 1 }])]).toEqual(['GET /api/status failed']);
    expect([...recurringErrors([{ text: 'x?t=1', count: 1 }, { text: 'x?t=2', count: 1 }])]).toEqual(['x']);
  });

  it('removes cache-busting queries from locations', () => {
    expect(cleanLocation('/src/broken.js?t=1712345678901:4:28')).toBe('/src/broken.js:4:28');
    expect(cleanLocation('localhost:5173/src/a.css?import&t=1712345678901:1:1')).toBe('localhost:5173/src/a.css:1:1');
    expect(cleanLocation('/node_modules/.vite/deps/vue.js?v=3f2a1b9c:120:5')).toBe('/node_modules/.vite/deps/vue.js:120:5');
    expect(cleanLocation('/src/x.ts:3:1')).toBe('/src/x.ts:3:1');
  });
});

describe('hookGeometry', () => {
  // The sentences emulation.ts writes next to a device screenshot.
  it('reads the scale, and the part of a background tab\'s image that is the device', () => {
    expect(hookGeometry('Screenshot of the viewport in tab-3 (390×844 px; viewport 390×844 CSS px), emulating iPhone 14. Image pixels are viewport CSS pixels, so a point in it can be passed as x/y to browser_click.')).toEqual({ scale: 1, viewport: undefined });
    expect(hookGeometry('Screenshot … To click a point in it, divide its image coordinates by 0.750 and pass them as x/y to browser_click.')).toEqual({ scale: 0.75, viewport: undefined });
    expect(
      hookGeometry(
        'Screenshot of the viewport in tab-3 (1024×768 px; viewport 400×4000 CSS px), emulating 400×4000. Image pixels are viewport CSS pixels, so a point in it can be passed as x/y to browser_click. tab-3 is in the background, where VS Code draws it in a 1024×768 px area without fitting the device: the emulated viewport is the top-left 400×768 px of the image, and the rest of it is cut off. Bring the tab to the front with browser_tab {"action":"show"} for a complete picture.',
      ),
    ).toEqual({ scale: 1, viewport: { width: 400, height: 768 } });
    expect(hookGeometry('Screenshot of something else.')).toBeUndefined();
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
    frames: [],
    selfChanging: 0,
    ...r,
  };
}

describe('formatBaseline', () => {
  it('says what was recorded and what to do next', () => {
    expect(formatBaseline({ tabId: 'tab-2', url: 'http://localhost:5173/cart', view, errors: 1, failures: 0, selfChanging: 0 })).toBe(
      'Baseline of tab-2 taken: http://localhost:5173/cart, viewport 1280×720 at scroll 0,0; 1 console error and 0 failed requests on this page so far (not repeated in the check). Edit the code, then call browser_check_change with action "check".',
    );
  });

  it('warns about a page that changes on its own, and an image that cannot be compared', () => {
    const text = formatBaseline({ tabId: 'tab-2', url: 'http://x/', view, errors: 0, failures: 2, selfChanging: 3, imageProblem: 'unsupported image' });
    expect(text).toContain('2 failed requests');
    expect(text).toContain('The page changes on its own (3 elements keep changing: a clock, an animation or polling); those changes do not count as an update');
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
        'The page in tab-2 crashed after the change (renderer gone). Reload it with browser_navigate {"action":"reload"} once the cause is fixed.',
        '- 1 new error before the crash:',
        '  [exception] Uncaught RangeError: Maximum call stack size exceeded  (/src/loop.ts:3:9)',
      ].join('\n'),
    );
  });

  it('a build error overlay', () => {
    const text = formatChange(report({ update: 'an error shown by the dev server', overlay: { kind: 'Vite error overlay', text: '[plugin:vite:vue] src/components/Cart.vue: Unexpected token (31:18)' }, screenshot: { kind: 'diff', changed: 0, total: 1, regions: [], more: 0 } }));
    expect(text).toContain('- Error shown in the page by the dev server (Vite error overlay): [plugin:vite:vue] src/components/Cart.vue: Unexpected token (31:18). Fix the cause; the overlay goes away with the next update that works.');
    expect(text).toContain('- Screenshot unchanged.');
  });

  it('an overlay that was there at the baseline: still shown, or gone', () => {
    const unchanged = { kind: 'diff' as const, changed: 0, total: 1, regions: [], more: 0 };
    expect(formatChange(report({ overlayBefore: 'still', screenshot: unchanged }))).toContain('- The error overlay shown at the baseline is still shown.');
    const gone = formatChange(report({ overlayBefore: 'gone', screenshot: unchanged }));
    expect(gone).toContain('- The error overlay shown at the baseline is gone.');
    expect(gone).not.toContain('the screenshot is unchanged. The edit does not show');
    expect(formatBaseline({ tabId: 'tab-2', url: 'http://x/', view, errors: 0, failures: 0, selfChanging: 0, overlay: { kind: 'Vite error overlay', text: '[plugin:vite:vue] Unexpected token (31:18)' } })).toContain(
      'The page shows an error from the dev server (Vite error overlay): [plugin:vite:vue] Unexpected token (31:18). Edit the code',
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

describe('more report texts', () => {
  it('regions as fractions of the image when its geometry is unknown', () => {
    const text = formatChange(report({ screenshot: { kind: 'diff', changed: 100, total: 10_000, regions: [{ x: 10, y: 20, width: 30, height: 10, changed: 100 }], more: 0, fractionOf: { width: 100, height: 100 } } }));
    expect(text).toContain("- Screenshot: 1.0% changed in 1 region (fractions of the image's width and height; how it maps to the viewport is not known): x 10%–40% y 20%–30%.");
  });

  it('a frame that reloaded, the note about the device screenshot, the page changing on its own', () => {
    const text = formatChange(report({ update: 'a reload of the frame http://y/story.html', frames: ['http://y/story.html'], imageAttached: true, imageNote: 'Screenshot of the viewport in tab-2, emulating iPhone 14.', selfChanging: 2, screenshot: { kind: 'diff', changed: 0, total: 1, regions: [], more: 0 } }));
    expect(text).toContain('- The frame http://y/story.html loaded a new document.');
    expect(text).toContain('About the after-screenshot: Screenshot of the viewport in tab-2, emulating iPhone 14.');
    expect(text).toContain('Note: The page changes on its own (2 elements keep changing');
  });

  it('a page that was busy for a while after the update', () => {
    expect(formatChange(report({ busyMs: 4200 }))).toContain('Note: the page was busy (not answering) for 4.2 s after the update: a long-running script, which users feel as a frozen page.');
    expect(formatChange(report({}))).not.toContain('busy');
  });

  it('a rebuild that changed nothing', () => {
    expect(formatNoUpdate({ tabId: 'tab-2', how: 'nothing', line: '[webpack-dev-server] Nothing changed.', elapsedMs: 300 })).toBe(
      'No update in tab-2 after 300 ms: the dev server rebuilt, but nothing changed ("[webpack-dev-server] Nothing changed."). The edit did not change the bundle: was the file saved with a change, and does this page import it?',
    );
    expect(formatNoUpdate({ tabId: 'tab-2', how: 'silent', line: '[webpack-dev-server] bundle rebuilding (/a/src/x.js changed)', elapsedMs: 5300 })).toContain('reported no update for 5 s, which is what webpack-dev-server 6 does when nothing changed');
  });

  it('a tab that stopped answering, with what was seen before', () => {
    const text = formatStuck({ tabId: 'tab-2', step: 'taking the screenshot', waitedMs: 17_000, update: 'a hot update (Vite: /src/app.js)', errors: ['Uncaught TypeError: boom'], failures: [] });
    expect(text).toBe(
      [
        'tab-2 did not respond while taking the screenshot (waited 17 s): it may be stuck in a long-running script, or VS Code is not drawing it right now. Try again; bring it to the front with browser_tab {"action":"show"}, or reload it with browser_navigate {"action":"reload"} if it stays stuck.',
        '- Seen before that: a hot update (Vite: /src/app.js).',
        '- Seen before that: 1 new error:',
        '  Uncaught TypeError: boom',
      ].join('\n'),
    );
  });
});

describe('formatTimeout', () => {
  it('says nothing arrived and what to check', () => {
    expect(formatTimeout({ tabId: 'tab-2', timeoutMs: 15_000, sinceMs: 48_000, since: 'baseline', selfChanging: 0, pendingDom: 0, hasFrames: false })).toBe(
      'No update reached tab-2 within 15 s (no hot update, reload, DOM change or error since the baseline 48 s ago). If the edit should show here: is the dev server running and watching that file (check its terminal)? A page without hot reload needs check with reload: true.',
    );
  });

  it('on a page that changes on its own, and after a lost connection', () => {
    const text = formatTimeout({ tabId: 'tab-2', timeoutMs: 2000, sinceMs: 5000, since: 'last check', selfChanging: 2, pendingDom: 1, hasFrames: true, devServerLost: '[webpack-dev-server] Disconnected!' });
    expect(text).toContain('since the last check 5.0 s ago');
    expect(text).toContain('1 element changed but is not counted yet: a change counts once it has not repeated for 5 s');
    expect(text).toContain('The page changes on its own (2 elements keep changing');
    expect(text).toContain('Changes inside frames are only seen when the frame reloads.');
    expect(text).toContain('- The dev server connection was lost ([webpack-dev-server] Disconnected!): is it still running?');
  });
});

// ---------------------------------------------------------------- baselines

describe('ChangeBaselines', () => {
  const baseline = (tabId: string): Baseline => ({ tabId, seq: 0, loaderId: 'l', url: 'u', takenAt: 0, docErrors: [], docFailureUrls: [], view, lastOverlay: '', watchMark: 0, watchDoc: 'l', lastDoc: 'l', failedBefore: [], frames: {}, pending: [], reported: { errors: 0, failures: 0 } });

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

  it('remembers which baselines were dropped to make room', () => {
    const store = new ChangeBaselines(() => true);
    for (let i = 0; i < 11; i++) store.set('s1\u0000tab-' + i, baseline('tab-' + i));
    expect(store.wasEvicted('s1\u0000tab-0')).toBe(true);
    expect(store.wasEvicted('s1\u0000tab-5')).toBe(false);
    store.set('s1\u0000tab-0', baseline('tab-0'));
    expect(store.wasEvicted('s1\u0000tab-0')).toBe(false);
  });

  it('says when a tab lost its last baseline, so its DOM watch can stop', () => {
    const dropped: string[] = [];
    const store = new ChangeBaselines(() => true, 2, tabId => dropped.push(tabId));
    store.set('s1\u0000tab-1', baseline('tab-1'));
    store.set('s2\u0000tab-1', baseline('tab-1'));
    store.set('s1\u0000tab-2', baseline('tab-2')); // evicts s1/tab-1; s2 still has tab-1
    expect(dropped).toEqual([]);
    store.dropSession('s2');
    expect(dropped).toEqual(['tab-1']);
    store.dropSession('s1');
    expect(dropped).toEqual(['tab-1', 'tab-2']);
  });

  it('the page scripts are valid JavaScript', () => {
    expect(() => new Function('return (' + WATCH + ');')).not.toThrow();
    expect(() => new Function('return (' + OVERLAY_TEXT + ');')).not.toThrow();
    expect(() => new Function('return (' + STOP_WATCH + ');')).not.toThrow();
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
