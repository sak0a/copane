import { describe, expect, it } from 'vitest';
import { ConsoleLog, formatConsoleArgs, formatConsoleEntry, formatRemoteObject, levelAtLeast, shortLocation } from '../../src/extension/browser/page/consoleLog';
import { filterNetwork, formatBody, formatNetworkEntry, mergeHeaders, NetworkLog, notableHeaders, pageOrigin, urlMatcher } from '../../src/extension/browser/page/networkLog';
import { PRETTY_JSON_MAX, SERIALIZE } from '../../src/extension/browser/page/scripts';
import { clip, formatBytes, formatMs, RingBuffer } from '../../src/extension/browser/page/ringBuffer';
import { fullPageHeight, MAX_EDGE, MAX_PIXELS, screenshotScale } from '../../src/extension/browser/page/screenshotMath';
import { normalizeUrl } from '../../src/extension/browser/page/navigationTools';

const seq = () => {
  let n = 0;
  return () => ++n;
};

describe('RingBuffer', () => {
  it('keeps the newest entries and counts dropped ones', () => {
    const b = new RingBuffer<{ seq: number }>(3);
    for (let i = 1; i <= 10; i++) b.push({ seq: i });
    expect(b.all().map(e => e.seq)).toEqual([8, 9, 10]);
    expect(b.dropped).toBe(7);
    expect(b.after(8).map(e => e.seq)).toEqual([9, 10]);
    expect(b.size).toBe(3);
  });

  it('formats sizes and durations', () => {
    expect(formatBytes(999)).toBe('999 B');
    expect(formatBytes(1234)).toBe('1.2 kB');
    expect(formatMs(340)).toBe('340 ms');
    expect(formatMs(2100)).toBe('2.1 s');
    expect(clip('abcdef', 4)).toBe('abc…');
  });
});

describe('console', () => {
  it('formats arguments like DevTools', () => {
    expect(formatConsoleArgs([{ type: 'string', value: 'a %s b %d%%' }, { type: 'string', value: 'X' }, { type: 'number', value: 4.7 }, { type: 'boolean', value: true }])).toBe('a X b 4% true');
    expect(formatRemoteObject({ type: 'object', subtype: 'null' })).toBe('null');
    expect(formatRemoteObject({ type: 'object', preview: { type: 'object', description: 'Object', overflow: false, properties: [{ name: 'a', type: 'number', value: '1' }, { name: 'b', type: 'string', value: 'x' }] } })).toBe('{a: 1, b: "x"}');
    expect(formatRemoteObject({ type: 'object', subtype: 'array', preview: { type: 'object', subtype: 'array', overflow: true, properties: [{ name: '0', type: 'number', value: '1' }] } })).toBe('[1, …]');
    expect(formatRemoteObject({ type: 'undefined' })).toBe('undefined');
    expect(formatRemoteObject({ type: 'number', unserializableValue: 'NaN' })).toBe('NaN');
  });

  it('records levels, collapses repeats, and formats exceptions', () => {
    const log = new ConsoleLog(10, seq());
    log.onConsoleApi({ type: 'log', args: [{ type: 'string', value: 'hi' }] });
    log.onConsoleApi({ type: 'log', args: [{ type: 'string', value: 'hi' }] });
    log.onConsoleApi({ type: 'warning', args: [{ type: 'string', value: 'careful' }], stackTrace: { callFrames: [{ functionName: '', url: 'http://a.test/app.js', lineNumber: 4, columnNumber: 2 }] } });
    log.onConsoleApi({ type: 'endGroup', args: [] });
    log.onException({ exceptionDetails: { text: 'Uncaught', exception: { type: 'object', subtype: 'error', description: 'TypeError: x is undefined\n    at f (app.js:1:1)' } } });
    log.onLogEntry({ entry: { source: 'network', level: 'error', text: 'Failed to load resource', url: 'http://a.test/x' } });
    log.onLogEntry({ entry: { source: 'other', level: 'verbose', text: 'noise' } });
    const entries = log.entries.all();
    expect(entries.map(e => [e.level, e.source, e.count])).toEqual([
      ['log', 'console', 2],
      ['warning', 'console', 1],
      ['error', 'exception', 1],
      ['error', 'browser', 1],
    ]);
    expect(entries[1]!.location).toBe('http://a.test/app.js:5:3');
    expect(formatConsoleEntry(entries[0]!)).toBe('[log] hi (×2)');
    expect(formatConsoleEntry(entries[2]!)).toMatch(/^\[exception\] Uncaught TypeError: x is undefined\n/);
    expect(levelAtLeast('warning', 'info')).toBe(true);
    expect(levelAtLeast('debug', 'info')).toBe(false);
    expect(shortLocation('http://a.test/src/app.js:5:3', 'http://a.test/')).toBe('/src/app.js:5:3');
  });
});

describe('network', () => {
  const request = (id: string, url: string, extra: Record<string, unknown> = {}) => ({ requestId: id, request: { url, method: 'GET', headers: { a: '1' } }, timestamp: 1, wallTime: 1000, type: 'Fetch', ...extra });

  it('records responses, failures and redirects', () => {
    const log = new NetworkLog(100, seq());
    log.onRequest(request('1', 'http://a.test/api'));
    log.onResponse({ requestId: '1', response: { status: 200, mimeType: 'application/json', headers: { 'content-type': 'application/json' } } });
    log.onFinished({ requestId: '1', timestamp: 1.25, encodedDataLength: 1200 });
    log.onRequest(request('2', 'http://a.test/down'));
    log.onFailed({ requestId: '2', timestamp: 1.1, errorText: 'net::ERR_CONNECTION_REFUSED' });
    log.onRequest(request('3', 'http://a.test/old', { type: 'Document', loaderId: '3' }));
    log.onRequest(request('3', 'http://a.test/new', { type: 'Document', loaderId: '3', redirectResponse: { status: 302 } }));
    log.onRequest(request('4', 'data:image/png;base64,xx'));
    const [ok, failed, redirect, final] = log.entries.all();
    expect(log.entries.size).toBe(4);
    expect(formatNetworkEntry(ok!, 0)).toBe('r1  GET 200 fetch  http://a.test/api  (250 ms, 1.2 kB)');
    expect(formatNetworkEntry(failed!, 0)).toMatch(/r2 {2}GET FAILED \(net::ERR_CONNECTION_REFUSED\) fetch/);
    expect(redirect!.redirectedTo).toBe('http://a.test/new');
    expect(formatNetworkEntry(redirect!, 0)).toMatch(/302 →/);
    expect(log.byRequestId('3')).toBe(final);
    expect(log.byId('r2')).toBe(failed);
  });

  it('filters by url, method, status and type, hiding static resources', () => {
    const log = new NetworkLog(100, seq());
    log.onRequest(request('1', 'http://a.test/api/items'));
    log.onResponse({ requestId: '1', response: { status: 200 } });
    log.onRequest({ ...request('2', 'http://a.test/logo.png'), type: 'Image' });
    log.onResponse({ requestId: '2', response: { status: 200 } });
    log.onRequest({ ...request('3', 'http://a.test/missing.css'), type: 'Stylesheet' });
    log.onResponse({ requestId: '3', response: { status: 404 } });
    log.onRequest({ ...request('4', 'http://a.test/api/save'), request: { url: 'http://a.test/api/save', method: 'POST' } });
    log.onResponse({ requestId: '4', response: { status: 500 } });
    const all = log.entries.all();
    const ids = (f: Parameters<typeof filterNetwork>[1]) => filterNetwork(all, f).matched.map(e => e.id);
    expect(ids({})).toEqual(['r1', 'r3', 'r4']);
    expect(filterNetwork(all, {}).hiddenStatic).toBe(1);
    expect(ids({ includeStatic: true })).toEqual(['r1', 'r2', 'r3', 'r4']);
    expect(ids({ status: 'failed' })).toEqual(['r3', 'r4']);
    expect(ids({ status: '5xx' })).toEqual(['r4']);
    expect(ids({ method: 'post' })).toEqual(['r4']);
    expect(ids({ url: '/api/' })).toEqual(['r1', 'r4']);
    expect(ids({ url: '*/api/*' })).toEqual(['r1', 'r4']);
    expect(ids({ url: '/items$/' })).toEqual(['r1']);
    expect(ids({ types: ['image'] })).toEqual(['r2']);
    expect(() => urlMatcher('/[/')).toThrow(/Invalid regular expression/);
  });

  it('prints URLs on the page origin as paths, keeping other origins and matching filters on the full URL', () => {
    const log = new NetworkLog(100, seq());
    log.onRequest(request('1', 'http://a.test/api/items?q=1'));
    log.onResponse({ requestId: '1', response: { status: 200 } });
    log.onFinished({ requestId: '1', timestamp: 1.25 });
    log.onRequest(request('2', 'https://cdn.other.test/lib.js'));
    log.onResponse({ requestId: '2', response: { status: 200 } });
    log.onFinished({ requestId: '2', timestamp: 1.25 });
    const [own, other] = log.entries.all();
    const origin = pageOrigin('http://a.test/app/page.html#x');
    expect(origin).toBe('http://a.test');
    expect(pageOrigin('about:blank')).toBeUndefined();
    expect(pageOrigin(undefined)).toBeUndefined();
    expect(formatNetworkEntry(own!, 0, origin)).toBe('r1  GET 200 fetch  /api/items?q=1  (250 ms)');
    expect(formatNetworkEntry(other!, 0, origin)).toBe('r2  GET 200 fetch  https://cdn.other.test/lib.js  (250 ms)');
    expect(formatNetworkEntry(own!, 0)).toBe('r1  GET 200 fetch  http://a.test/api/items?q=1  (250 ms)');
    expect(filterNetwork(log.entries.all(), { url: 'http://a.test/api' }).matched.map(e => e.id)).toEqual(['r1']);
  });

  it('merges the headers actually sent case-insensitively, without listing any twice', () => {
    const log = new NetworkLog(100, seq());
    log.onRequest({ ...request('1', 'http://a.test/api'), request: { url: 'http://a.test/api', method: 'GET', headers: { Accept: '*/*', 'User-Agent': 'UA', 'X-Mine': '1' } } });
    log.onRequestExtra({ requestId: '1', headers: { accept: '*/*', 'user-agent': 'UA', cookie: 'a=b', ':method': 'GET' } });
    expect(log.entries.all()[0]!.requestHeaders).toEqual({ 'X-Mine': '1', accept: '*/*', 'user-agent': 'UA', cookie: 'a=b', ':method': 'GET' });
    expect(mergeHeaders({ A: '1', '…': 'more headers were cut' }, { a: '2' })).toEqual({ a: '2' });
  });

  it('leaves routine headers out of the details', () => {
    const { shown, routine } = notableHeaders({ ':authority': 'a.test', ':path': '/', accept: '*/*', 'accept-encoding': 'gzip', 'sec-ch-ua': 'x', 'Sec-Fetch-Mode': 'cors', priority: 'u=1', cookie: 'a=b' });
    expect(shown).toEqual([['accept', '*/*'], ['cookie', 'a=b']]);
    expect(routine).toBe(6);
    expect(notableHeaders(undefined)).toEqual({ shown: [], routine: 0 });
  });

  it('formats bodies: short JSON indented, long JSON compact before the cut', () => {
    expect(formatBody('{"hello":"world"}', 4000)).toBe('  {\n    "hello": "world"\n  }');
    expect(formatBody('not json {', 4000)).toBe('  not json {');
    const long = JSON.stringify({ items: Array.from({ length: 200 }, (_, i) => ({ id: i, name: `item ${i}` })) }, null, 2);
    const compact = JSON.stringify(JSON.parse(long));
    expect(formatBody(long, 20_000)).toBe(`  ${compact}`);
    expect(formatBody(long, 1000)).toBe(`  ${compact.slice(0, 1000)}\n  … (${compact.length - 1000} more characters; raise maxBodyChars to see more)`);
    // Short JSON goes compact too when its indented form would not fit maxBodyChars.
    const small = JSON.stringify({ list: Array.from({ length: 12 }, (_, i) => i) });
    expect(formatBody(small, 100)).toBe(`  ${small}`);
  });

  it('reports in-flight requests for network idle, ignoring long-lived ones', () => {
    const log = new NetworkLog(100, seq());
    log.onRequest({ ...request('1', 'http://a.test/sse'), type: 'EventSource', wallTime: Date.now() / 1000 });
    log.onRequest({ ...request('2', 'http://a.test/x'), wallTime: Date.now() / 1000 });
    expect(log.inflight(Date.now(), 10_000).map(e => e.id)).toEqual(['r2']);
  });
});

describe('evaluate results (SERIALIZE)', () => {
  const serialize = (value: unknown, maxChars = 20_000): string => (new Function(`return (${SERIALIZE});`)() as (this: unknown, max: number) => string).call(value, maxChars);

  it('indents small values and makes large ones compact', () => {
    expect(serialize({ a: 1, list: [1, 2] })).toBe('{\n  "a": 1,\n  "list": [\n    1,\n    2\n  ]\n}');
    const big = { rows: Array.from({ length: 100 }, (_, i) => ({ id: i, label: `row ${i}` })) };
    expect(JSON.stringify(big, null, 2).length).toBeGreaterThan(PRETTY_JSON_MAX);
    expect(serialize(big)).toBe(JSON.stringify(big));
  });

  it('cuts at maxChars and marks cycles', () => {
    const o: Record<string, unknown> = { name: 'loop' };
    o.self = o;
    expect(serialize(o)).toContain('"self": "(circular)"');
    const cut = serialize({ s: 'x'.repeat(5000) }, 100);
    expect(cut).toBe(`{"s":"${'x'.repeat(94)}\n… (cut: 5008 characters in total)`);
  });
});

describe('screenshot sizing', () => {
  it('never upscales and stays within the edge and pixel limits', () => {
    expect(screenshotScale(800, 600)).toBe(1);
    const s = screenshotScale(1920, 1080);
    expect(1920 * s).toBeLessThanOrEqual(MAX_EDGE + 0.5);
    expect(1920 * s * 1080 * s).toBeLessThanOrEqual(MAX_PIXELS + 1);
  });

  it('cuts very tall full-page shots so they stay readable', () => {
    expect(fullPageHeight(780, 2000)).toBe(2000);
    expect(fullPageHeight(780, 30000)).toBe(3136);
    expect(fullPageHeight(1600, 30000)).toBeLessThan(3136);
  });
});

describe('normalizeUrl', () => {
  it('adds a scheme where needed', () => {
    expect(normalizeUrl('localhost:3000')).toBe('http://localhost:3000');
    expect(normalizeUrl('127.0.0.1:8080/x')).toBe('http://127.0.0.1:8080/x');
    expect(normalizeUrl('example.com')).toBe('https://example.com');
    expect(normalizeUrl('http://a.test')).toBe('http://a.test');
    expect(normalizeUrl('about:blank')).toBe('about:blank');
    expect(normalizeUrl('file:///tmp/x.html')).toBe('file:///tmp/x.html');
  });
});
