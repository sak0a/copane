import { describe, expect, it } from 'vitest';
import { Emitter } from '../../src/extension/core/events';
import { nullLogger } from '../../src/extension/core/log';
import type { CdpPage } from '../../src/extension/core/services';
import { FetchInterception, type FetchClient, type RequestDecision } from '../../src/extension/browser/interception';
import { redactHeader, NetworkLog } from '../../src/extension/browser/page/networkLog';

class FakePage implements CdpPage {
  readonly sent: Array<{ method: string; params: any }> = [];
  closed = false;
  fail: RegExp | undefined;
  private readonly listeners = new Map<string, Set<(p: any) => void>>();
  private readonly closeEmitter = new Emitter<void>();
  readonly onDidClose = this.closeEmitter.event;
  constructor(readonly tabId = 'tab-1') {}
  async send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    this.sent.push({ method, params });
    if (this.fail?.test(method)) throw new Error(`${method} failed`);
    return {};
  }
  on(event: string, listener: (p: any) => void) {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(listener);
    return { dispose: () => void set!.delete(listener) };
  }
  emit(event: string, params: any) {
    for (const l of this.listeners.get(event) ?? []) l(params);
  }
  close() {
    this.closed = true;
    this.closeEmitter.fire();
  }
  methods(prefix = 'Fetch.') {
    return this.sent.filter(s => s.method.startsWith(prefix)).map(s => s.method);
  }
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const paused = (requestId: string, url = 'http://a/api/cart', extra: any = {}) => ({ requestId, networkId: `n-${requestId}`, request: { url, method: 'GET', headers: { Accept: '*/*' } }, resourceType: 'Fetch', frameId: 'f', ...extra });

function client(over: Partial<FetchClient> & { want?: { patterns: string[]; auth?: boolean } }): FetchClient {
  const want = over.want ?? { patterns: [] };
  return { name: 'test', patterns: () => want.patterns.map(urlPattern => ({ urlPattern })), handlesAuth: () => !!want.auth, ...over };
}

describe('FetchInterception', () => {
  it('enables the union of what clients need, and disables when nobody needs anything', async () => {
    const page = new FakePage();
    const fetch = new FetchInterception(nullLogger);
    fetch.attach(page);
    await flush();
    expect(page.methods()).toEqual([]);
    const a = { patterns: ['*api*'] as string[], auth: false };
    const b = { patterns: ['*'] as string[], auth: true };
    const ra = fetch.register(client({ want: a }));
    const rb = fetch.register(client({ want: b }));
    await flush();
    expect(page.sent.at(-1)).toEqual({ method: 'Fetch.enable', params: { patterns: [{ urlPattern: '*api*', requestStage: 'Request' }, { urlPattern: '*', requestStage: 'Request' }], handleAuthRequests: true } });
    expect(page.methods()).toEqual(['Fetch.enable']); // both registrations applied at once
    fetch.refresh('tab-1');
    await flush();
    expect(page.methods()).toEqual(['Fetch.enable']); // nothing changed, nothing sent
    rb.dispose();
    await flush();
    expect(page.sent.at(-1)?.params).toEqual({ patterns: [{ urlPattern: '*api*', requestStage: 'Request' }], handleAuthRequests: false });
    ra.dispose();
    await flush();
    expect(page.sent.at(-1)?.method).toBe('Fetch.disable');
    expect(fetch.isActive('tab-1')).toBe(false);
  });

  it('continues requests nobody decides about, and answers decisions', async () => {
    const page = new FakePage();
    const fetch = new FetchInterception(nullLogger);
    const notes: string[] = [];
    fetch.onDidIntercept(e => notes.push(`${e.networkId}: ${e.note}`));
    fetch.register(
      client({
        want: { patterns: ['*'] },
        onRequest: (r): RequestDecision | undefined =>
          r.url.endsWith('/fulfil') ? { kind: 'fulfill', status: 500, headers: { 'content-type': 'text/plain' }, body: 'boom', note: 'mocked by m1' }
          : r.url.endsWith('/fail') ? { kind: 'fail', reason: 'ConnectionRefused' }
          : r.url.endsWith('/headers') ? { kind: 'continue', headers: { 'x-a': '1' } }
          : undefined,
      }),
    );
    fetch.attach(page);
    await flush();
    page.emit('Fetch.requestPaused', paused('1', 'http://a/plain'));
    page.emit('Fetch.requestPaused', paused('2', 'http://a/fulfil'));
    page.emit('Fetch.requestPaused', paused('3', 'http://a/fail'));
    page.emit('Fetch.requestPaused', paused('4', 'http://a/headers'));
    await flush();
    await flush();
    const answers = page.sent.filter(s => s.method !== 'Fetch.enable');
    expect(answers).toEqual([
      { method: 'Fetch.continueRequest', params: { requestId: '1' } },
      { method: 'Fetch.fulfillRequest', params: { requestId: '2', responseCode: 500, responseHeaders: [{ name: 'content-type', value: 'text/plain' }], body: Buffer.from('boom').toString('base64') } },
      { method: 'Fetch.failRequest', params: { requestId: '3', errorReason: 'ConnectionRefused' } },
      { method: 'Fetch.continueRequest', params: { requestId: '4', headers: [{ name: 'x-a', value: '1' }] } },
    ]);
    expect(notes).toEqual(['n-2: mocked by m1']);
  });

  it('lets a request through when a client throws, and when answering fails', async () => {
    const page = new FakePage();
    const fetch = new FetchInterception(nullLogger);
    fetch.register(client({ want: { patterns: ['*'] }, onRequest: () => { throw new Error('bug'); } }));
    fetch.attach(page);
    await flush();
    page.emit('Fetch.requestPaused', paused('1'));
    await flush();
    expect(page.sent.at(-1)).toEqual({ method: 'Fetch.continueRequest', params: { requestId: '1' } });

    const page2 = new FakePage('tab-2');
    const fetch2 = new FetchInterception(nullLogger);
    fetch2.register(client({ want: { patterns: ['*'] }, onRequest: () => ({ kind: 'fulfill', status: 200, headers: {}, body: '' }) }));
    fetch2.attach(page2);
    await flush();
    page2.fail = /fulfillRequest/;
    page2.emit('Fetch.requestPaused', paused('9'));
    await flush();
    await flush();
    expect(page2.methods().slice(-2)).toEqual(['Fetch.fulfillRequest', 'Fetch.continueRequest']);
  });

  it('answers delayed requests at once when interception is turned off', async () => {
    const page = new FakePage();
    const fetch = new FetchInterception(nullLogger);
    const reg = fetch.register(client({ want: { patterns: ['*'] }, onRequest: () => ({ kind: 'fulfill', status: 200, headers: {}, body: 'late', delayMs: 60_000 }) }));
    fetch.attach(page);
    await flush();
    page.emit('Fetch.requestPaused', paused('1'));
    await flush();
    expect(page.methods()).toEqual(['Fetch.enable']);
    reg.dispose();
    await flush();
    await flush();
    // The held request is let through unchanged before the domain is disabled.
    expect(page.methods()).toEqual(['Fetch.enable', 'Fetch.continueRequest', 'Fetch.disable']);
  });

  it('sends a held request on unchanged when the rule behind it goes away', async () => {
    const page = new FakePage();
    const fetch = new FetchInterception(nullLogger);
    const ended = new AbortController();
    fetch.register(client({ want: { patterns: ['*'] }, onRequest: () => ({ kind: 'fulfill', status: 500, headers: {}, body: '', delayMs: 60_000, cancel: ended.signal }) }));
    fetch.attach(page);
    await flush();
    page.emit('Fetch.requestPaused', paused('1'));
    await flush();
    ended.abort();
    await flush();
    await flush();
    expect(page.sent.at(-1)).toEqual({ method: 'Fetch.continueRequest', params: { requestId: '1' } });
  });

  it('cancels a pending login when the tab closes, and maps login decisions', async () => {
    const page = new FakePage();
    const fetch = new FetchInterception(nullLogger);
    let release: (v: any) => void = () => {};
    fetch.register(
      client({
        want: { patterns: ['*'], auth: true },
        onAuth: r => (r.challenge.realm === 'wait' ? new Promise(resolve => (release = resolve)) : Promise.resolve({ kind: 'provide', username: 'u', password: 'p' })),
      }),
    );
    fetch.attach(page);
    await flush();
    page.emit('Fetch.authRequired', { ...paused('1'), authChallenge: { source: 'Proxy', origin: 'http://p:8080', scheme: 'Basic', realm: 'R' } });
    await flush();
    expect(page.sent.at(-1)).toEqual({ method: 'Fetch.continueWithAuth', params: { requestId: '1', authChallengeResponse: { response: 'ProvideCredentials', username: 'u', password: 'p' } } });
    page.emit('Fetch.authRequired', { ...paused('2'), authChallenge: { origin: 'http://a', scheme: 'basic', realm: 'wait' } });
    await flush();
    page.close();
    release({ kind: 'provide', username: 'u', password: 'p' });
    await flush();
    // The tab is gone: nothing more is sent to it.
    expect(page.sent.filter(s => s.params.requestId === '2')).toEqual([]);
  });

  it('answers login challenges with "Default" when no client handles them', async () => {
    const page = new FakePage();
    const fetch = new FetchInterception(nullLogger);
    fetch.register(client({ want: { patterns: ['*api*'] } }));
    fetch.attach(page);
    await flush();
    page.emit('Fetch.authRequired', { ...paused('1'), authChallenge: { origin: 'http://a', scheme: 'basic', realm: 'R' } });
    await flush();
    expect(page.sent.at(-1)).toEqual({ method: 'Fetch.continueWithAuth', params: { requestId: '1', authChallengeResponse: { response: 'Default' } } });
  });

  it('hands the domain back on dispose', async () => {
    const page = new FakePage();
    const fetch = new FetchInterception(nullLogger);
    fetch.register(client({ want: { patterns: ['*'] }, onRequest: () => ({ kind: 'continue', delayMs: 60_000 }) }));
    fetch.attach(page);
    await flush();
    page.emit('Fetch.requestPaused', paused('1'));
    await flush();
    fetch.dispose();
    await flush();
    await flush();
    expect(page.methods()).toEqual(['Fetch.enable', 'Fetch.continueRequest', 'Fetch.disable']);
  });
});

describe('network log', () => {
  it('hides credentials in Authorization headers but keeps the scheme', () => {
    expect(redactHeader('Authorization', 'Basic YWxpY2U6cHc=')).toBe('Basic (credentials hidden)');
    expect(redactHeader('proxy-authorization', 'NTLM TlRMTVNTUAAD')).toBe('NTLM (credentials hidden)');
    expect(redactHeader('authorization', 'opaque')).toBe('(credentials hidden)');
    expect(redactHeader('Accept', 'text/html')).toBe('text/html');
    let seq = 0;
    const log = new NetworkLog(10, () => ++seq);
    log.onRequest({ requestId: 'n1', request: { url: 'http://a/', method: 'GET', headers: { Authorization: 'Bearer secret-token' } }, timestamp: 1 });
    log.onRequestExtra({ requestId: 'n1', headers: { 'Proxy-Authorization': 'Basic cHJveHk6cHc=' } });
    expect(JSON.stringify(log.byRequestId('n1')!.requestHeaders)).not.toMatch(/secret-token|cHJveHk6cHc/);
  });

  it('marks requests the bridge answered, also when the note comes first', () => {
    let seq = 0;
    const log = new NetworkLog(10, () => ++seq);
    log.annotate('n2', 'mocked by m1');
    log.onRequest({ requestId: 'n2', request: { url: 'http://a/api', method: 'GET' }, timestamp: 1 });
    expect(log.byRequestId('n2')!.intercepted).toBe('mocked by m1');
    log.onRequest({ requestId: 'n3', request: { url: 'http://a/b', method: 'GET' }, timestamp: 1 });
    log.annotate('n3', 'delayed by m2');
    expect(log.byRequestId('n3')!.intercepted).toBe('delayed by m2');
  });
});
