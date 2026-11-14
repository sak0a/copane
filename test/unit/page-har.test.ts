import { describe, expect, it } from 'vitest';
import { buildHar, harTimings, isSecretName, MaskReport, maskBody, maskCookieHeader, maskHeader, maskSetCookie, maskUrl } from '../../src/extension/browser/page/harLogic';
import { NetworkLog } from '../../src/extension/browser/page/networkLog';
import { withholdEntry } from '../../src/extension/browser/page/privacy';

const T0 = 1_700_000_000; // wall clock, s

function recorded() {
  let n = 0;
  const log = new NetworkLog(100, () => ++n);
  // Page load: document with a session cookie, an API call with a token in the query and headers.
  log.onRequest({ requestId: 'D1', loaderId: 'D1', frameId: 'MAIN', type: 'Document', timestamp: 100, wallTime: T0, request: { url: 'http://site.test/', method: 'GET', headers: { Accept: 'text/html' } } });
  log.onRequestExtra({ requestId: 'D1', headers: { Cookie: 'sid=SECRET-SID; theme=dark' } });
  log.onResponse({
    requestId: 'D1',
    type: 'Document',
    response: {
      status: 200,
      statusText: 'OK',
      mimeType: 'text/html',
      protocol: 'http/1.1',
      remoteIPAddress: '127.0.0.1',
      headers: { 'Content-Type': 'text/html', 'Set-Cookie': 'sid=SECRET-SID; Path=/; HttpOnly\nlang=en; Expires=Wed, 21 Oct 2037 07:28:00 GMT' },
      timing: { requestTime: 100.01, dnsStart: 1, dnsEnd: 3, connectStart: 3, connectEnd: 8, sslStart: -1, sslEnd: -1, sendStart: 9, sendEnd: 10, receiveHeadersEnd: 40 },
    },
  });
  log.onFinished({ requestId: 'D1', timestamp: 100.1, encodedDataLength: 1234 });
  log.onRequest({
    requestId: 'A1',
    loaderId: 'D1',
    frameId: 'MAIN',
    type: 'Fetch',
    timestamp: 100.2,
    wallTime: T0 + 0.2,
    request: { url: 'http://site.test/api?q=shoes&access_token=SECRET-QUERY&code=SECRET-CODE', method: 'POST', headers: { Authorization: 'Bearer SECRET-BEARER', 'X-Api-Key': 'SECRET-KEY', 'Content-Type': 'application/json' }, postData: '{"user":"ann","password":"SECRET-PW","nested":{"refresh_token":"SECRET-RT"}}', hasPostData: true },
  });
  log.onResponse({ requestId: 'A1', type: 'Fetch', response: { status: 200, mimeType: 'application/json', headers: { 'content-type': 'application/json' } } });
  log.onFinished({ requestId: 'A1', timestamp: 100.25, encodedDataLength: 50 });
  // A cross-origin frame's request, a failure, a form post, one still pending.
  log.onRequest({ requestId: 'F1', loaderId: 'FL', frameId: 'FRAME', type: 'XHR', timestamp: 100.3, wallTime: T0 + 0.3, request: { url: 'http://other.test/frame-api', method: 'GET' } });
  log.onFailed({ requestId: 'F1', timestamp: 100.31, errorText: 'net::ERR_INTERNET_DISCONNECTED' });
  log.onRequest({ requestId: 'P1', loaderId: 'D1', frameId: 'MAIN', type: 'Document', timestamp: 100.4, wallTime: T0 + 0.4, request: { url: 'http://site.test/login', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, postData: 'user=ann&pass=SECRET-FORM&remember=1', hasPostData: true } });
  log.onRequest({ requestId: 'S1', loaderId: 'D1', frameId: 'MAIN', type: 'Fetch', timestamp: 100.5, wallTime: T0 + 0.5, request: { url: 'http://site.test/slow', method: 'GET' } });
  return log;
}

const ALL_SECRETS = ['SECRET-SID', 'SECRET-QUERY', 'SECRET-CODE', 'SECRET-KEY', 'SECRET-PW', 'SECRET-RT', 'SECRET-FORM', 'SECRET-BODY'];

function har(log: NetworkLog, extra: Partial<Parameters<typeof buildHar>[0]> = {}) {
  return buildHar({ entries: log.entries.all(), mainFrameId: 'MAIN', secrets: false, creator: { name: 'Copane', version: '1.0.0' }, current: { loaderId: 'D1', title: 'Site', onContentLoad: 50, onLoad: 80 }, ...extra });
}

describe('HAR 1.2 structure', () => {
  it('has the required fields, ISO times, pages with load timings, and entries mapped to their page', () => {
    const { har: h, stats } = har(recorded());
    const log = h.log as any;
    expect(Object.keys(log).slice(0, 2)).toEqual(['version', 'creator']);
    expect(log.version).toBe('1.2');
    expect(log.pages).toEqual([{ startedDateTime: new Date(T0 * 1000).toISOString(), id: 'page_1', title: 'Site', pageTimings: { onContentLoad: 50, onLoad: 80 } }]);
    expect(log.entries).toHaveLength(5);
    for (const e of log.entries) {
      expect(e.startedDateTime).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
      expect(e.pageref).toBe('page_1');
      for (const k of ['method', 'url', 'httpVersion', 'cookies', 'headers', 'queryString', 'headersSize', 'bodySize']) expect(e.request).toHaveProperty(k);
      for (const k of ['status', 'statusText', 'httpVersion', 'cookies', 'headers', 'content', 'redirectURL', 'headersSize', 'bodySize']) expect(e.response).toHaveProperty(k);
      expect(e.response.content).toHaveProperty('mimeType');
      expect(e.response.content).toHaveProperty('size');
      for (const k of ['send', 'wait', 'receive']) expect(e.timings[k]).toBeGreaterThanOrEqual(0);
      expect(e.cache).toEqual({});
    }
    const [doc, api, frame, , pending] = log.entries;
    expect(doc.timings).toEqual({ blocked: 11, dns: 2, connect: 5, ssl: -1, send: 1, wait: 30, receive: 50 });
    expect(doc.time).toBe(99);
    expect(doc.serverIPAddress).toBe('127.0.0.1');
    expect(doc.response.cookies).toEqual([
      { name: 'sid', value: '(masked)', path: '/', httpOnly: true },
      { name: 'lang', value: '(masked)', expires: '2037-10-21T07:28:00.000Z' },
    ]);
    expect(api.request.postData.mimeType).toBe('application/json');
    expect(api.comment).toMatch(/approximate timings/);
    expect(frame._frameId).toBe('FRAME');
    expect(frame.response).toMatchObject({ status: 0, _error: 'net::ERR_INTERNET_DISCONNECTED' });
    expect(pending.comment).toMatch(/not finished/);
    expect(stats).toMatchObject({ entries: 5, pages: 1, frameEntries: 1, pending: 2 });
  });

  it('unknown load timings are -1', () => {
    const log = har(recorded(), { current: undefined }).har.log as any;
    expect(log.pages[0].pageTimings).toEqual({ onContentLoad: -1, onLoad: -1 });
    expect(log.pages[0].title).toBe('http://site.test/');
  });

  it('the current document is a page even when its request was made before recording started', () => {
    const log = recorded();
    const entries = log.entries.all().filter(e => e.requestId !== 'D1');
    const h = buildHar({ entries, mainFrameId: 'MAIN', secrets: false, creator: { name: 'Copane', version: '1' }, current: { loaderId: 'D1', startedAt: T0 * 1000 - 50, url: 'http://site.test/', title: 'Site', onLoad: 80 } }).har.log as any;
    expect(h.pages).toEqual([{ startedDateTime: new Date(T0 * 1000 - 50).toISOString(), id: 'page_1', title: 'Site', pageTimings: { onContentLoad: -1, onLoad: 80 } }]);
    expect(h.entries.every((e: any) => e.pageref === 'page_1')).toBe(true);
    // Requests from before a page started belong to no page.
    const late = buildHar({ entries, mainFrameId: 'MAIN', secrets: false, creator: { name: 'Copane', version: '1' }, current: { loaderId: 'D1', startedAt: T0 * 1000 + 350 } }).har.log as any;
    expect(late.entries.map((e: any) => e.pageref)).toEqual([undefined, undefined, 'page_1', 'page_1']);
  });

  it('timings without resource timing come from the events and add up', () => {
    const log = recorded();
    const api = log.entries.all()[1]!;
    const t = harTimings(api);
    expect(t.approximate).toBe(true);
    expect(t.timings.blocked).toBe(-1);
    expect(t.timings.wait! + t.timings.receive!).toBeCloseTo(t.time, 3);
  });
});

describe('masking', () => {
  it('leaves no cookie value or secret-looking value in the file by default, and says what it masked', () => {
    const { har: h, stats } = har(recorded(), { bodies: new Map([['r2', { text: '{"access_token":"SECRET-BODY","ok":true}', base64: false, size: 40 }]]) });
    const text = JSON.stringify(h);
    for (const s of ALL_SECRETS) expect(text, s).not.toContain(s);
    expect(text).not.toContain('SECRET-BEARER'); // never recorded at all
    expect(text).toContain('Bearer (credentials hidden)');
    expect(text).toContain('q=shoes');
    expect(text).toContain('theme=(masked)');
    expect(text).toContain('remember=1');
    const summary = stats.masked.summary();
    expect(summary).toMatch(/cookies \(sid, theme\)/);
    expect(summary).toMatch(/Set-Cookie \(sid, lang\)/);
    expect(summary).toMatch(/query parameters \(access_token, code\)/);
    expect(summary).toMatch(/headers \(X-Api-Key\)/);
    expect(summary).toMatch(/form and JSON fields \(password, refresh_token, access_token, pass\)/);
  });

  it('keeps everything recorded when secrets are asked for (Authorization is still not recorded)', () => {
    const { har: h, stats } = har(recorded(), { secrets: true, bodies: new Map([['r2', { text: '{"access_token":"SECRET-BODY"}', base64: false, size: 30 }]]) });
    const text = JSON.stringify(h);
    for (const s of ALL_SECRETS) expect(text, s).toContain(s);
    expect(text).not.toContain('SECRET-BEARER');
    expect(stats.masked.empty).toBe(true);
  });

  it('a request sent while the user had the tab stays withheld', () => {
    const log = recorded();
    withholdEntry(log.entries.all()[1]!);
    const { har: h, stats } = har(log, { secrets: true, postData: new Map([['r2', 'SECRET-PW-AGAIN']]), bodies: new Map() });
    const api = (h.log as any).entries[1];
    expect(api.request.url).toBe('http://site.test/api?…');
    expect(api.request.headers).toEqual([]);
    expect(api.request.queryString).toEqual([]);
    expect(api.request.postData).toBeUndefined();
    expect(api.response.headers).toEqual([]);
    expect(api.comment).toMatch(/withheld/);
    expect(JSON.stringify(h)).not.toContain('SECRET-PW');
    expect(stats.withheld).toBe(1);
  });

  it('masks by name in URLs, cookies, headers and bodies', () => {
    const r = new MaskReport();
    expect(maskUrl('https://a.test/cb?code=abc&state=xyz#frag', r)).toBe('https://a.test/cb?code=(masked)&state=xyz#frag');
    expect(maskUrl('https://s3.test/f?X-Amz-Signature=deadbeef&X-Amz-Date=1', r)).toBe('https://s3.test/f?X-Amz-Signature=(masked)&X-Amz-Date=1');
    expect(maskCookieHeader('a=1; b=2', r)).toBe('a=(masked); b=(masked)');
    expect(maskSetCookie('id=1; Secure', r)).toBe('id=(masked); Secure');
    expect(maskHeader('Referer', 'https://a.test/?token=t', r)).toBe('https://a.test/?token=(masked)');
    expect(maskHeader('x-csrf-token', 'v', r)).toBe('(masked)');
    expect(maskHeader('Accept', 'text/html', r)).toBe('text/html');
    expect(maskBody('{"a":[{"apiKey":"k"}],"name":"x"}', 'application/json', r)).toBe('{"a":[{"apiKey":"(masked)"}],"name":"x"}');
    const multipart = '--b\r\nContent-Disposition: form-data; name="password"\r\n\r\nhunter2\r\n--b\r\nContent-Disposition: form-data; name="user"\r\n\r\nann\r\n--b--';
    expect(maskBody(multipart, 'multipart/form-data; boundary=b', r)).toBe(multipart.replace('hunter2', '(masked)'));
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc_def';
    expect(maskBody(`token is ${jwt} ok`, 'text/plain', r)).toBe('token is (masked) ok');
    expect(maskUrl(`https://a.test/?q=${jwt}`, r)).toBe('https://a.test/?q=(masked)');
    for (const name of ['access_token', 'accessToken', 'client_secret', 'X-Api-Key', 'sessionid', 'otp', 'csrf_token']) expect(isSecretName(name), name).toBe(true);
    for (const name of ['q', 'page', 'monkey', 'state', 'content-type', 'theme', 'keyboard']) expect(isSecretName(name), name).toBe(false);
  });
});
