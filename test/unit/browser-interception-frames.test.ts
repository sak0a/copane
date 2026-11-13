// Request interception in cross-origin frames: every frame target of a tab gets what the clients need,
// is answered on its own session, and is let go cleanly when the frame goes away. Also the frame
// registry's side: a new frame is held until interception is in place, and always released.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FetchInterception, MAX_FRAME_TARGETS, type FetchClient, type RequestDecision } from '../../src/extension/browser/interception';
import { ConsoleLog } from '../../src/extension/browser/page/consoleLog';
import { FRAME_HOLD_MS, FrameRegistry } from '../../src/extension/browser/page/frames';
import { NetworkLog } from '../../src/extension/browser/page/networkLog';
import { Emitter } from '../../src/extension/core/events';
import { nullLogger } from '../../src/extension/core/log';
import type { CdpPage } from '../../src/extension/core/services';

class FakeSession implements CdpPage {
  readonly sent: Array<{ method: string; params: any }> = [];
  closed = false;
  /** Commands that never get an answer (the frame is stuck). */
  hang: RegExp | undefined;
  private readonly listeners = new Map<string, Set<(p: any) => void>>();
  private readonly closeEmitter = new Emitter<void>();
  readonly onDidClose = this.closeEmitter.event;
  constructor(
    readonly tabId = 'tab-1',
    private readonly children = new Map<string, FakeSession>(),
  ) {}
  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    this.sent.push({ method, params });
    if (this.closed) return Promise.reject(new Error('session closed'));
    if (this.hang?.test(method)) return new Promise(() => {});
    if (method === 'Page.getFrameTree') return Promise.resolve({ frameTree: { frame: { id: 'X', loaderId: 'L', url: 'about:blank' } } });
    if (method === 'Runtime.evaluate') return Promise.resolve({ result: { value: 'complete' } });
    return Promise.resolve({});
  }
  on(event: string, listener: (p: any) => void) {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(listener);
    return { dispose: () => void set!.delete(listener) };
  }
  childSession(sessionId: string): CdpPage {
    let child = this.children.get(sessionId);
    if (!child) this.children.set(sessionId, (child = new FakeSession(this.tabId, this.children)));
    return child;
  }
  emit(event: string, params: any) {
    for (const l of [...(this.listeners.get(event) ?? [])]) l(params);
  }
  close() {
    this.closed = true;
    this.closeEmitter.fire();
  }
  methods(prefix = 'Fetch.') {
    return this.sent.filter(s => s.method.startsWith(prefix)).map(s => s.method);
  }
}

const flush = async (n = 3) => {
  for (let i = 0; i < n; i++) await new Promise(resolve => setTimeout(resolve, 0));
};
const paused = (requestId: string, url = 'http://b/api/cart') => ({ requestId, networkId: `n-${requestId}`, request: { url, method: 'GET', headers: {} }, resourceType: 'Fetch', frameId: 'F1' });

function client(over: Partial<FetchClient> & { want?: { patterns: string[]; auth?: boolean } } = {}): FetchClient {
  const want = over.want ?? { patterns: [] };
  return { name: 'test', patterns: () => want.patterns.map(urlPattern => ({ urlPattern })), handlesAuth: () => !!want.auth, ...over };
}

describe('FetchInterception in frames', () => {
  it('enables what the clients need in a frame before attachFrame resolves, and follows changes', async () => {
    const page = new FakeSession();
    const frame = page.childSession('s1') as FakeSession;
    const fetch = new FetchInterception(nullLogger);
    fetch.attach(page);
    const want = { patterns: ['*api*'] as string[], auth: true };
    const registration = fetch.register(client({ want }));
    await fetch.attachFrame(frame);
    // Already in effect when the frame may run.
    expect(frame.sent).toEqual([{ method: 'Fetch.enable', params: { patterns: [{ urlPattern: '*api*', requestStage: 'Request' }], handleAuthRequests: true } }]);
    expect(fetch.frameStats('tab-1')).toEqual({ frames: 1, active: 1, pending: 0 });
    // Attaching twice changes nothing.
    await fetch.attachFrame(frame);
    expect(frame.methods()).toEqual(['Fetch.enable']);
    registration.dispose();
    await flush();
    expect(page.methods()).toEqual(['Fetch.enable', 'Fetch.disable']);
    expect(frame.methods()).toEqual(['Fetch.enable', 'Fetch.disable']);
    expect(fetch.frameStats('tab-1')).toEqual({ frames: 1, active: 0, pending: 0 });
  });

  it('costs nothing in a frame while no client needs anything', async () => {
    const page = new FakeSession();
    const fetch = new FetchInterception(nullLogger);
    fetch.attach(page);
    fetch.register(client());
    const frames = Array.from({ length: 30 }, (_, i) => page.childSession(`s${i}`) as FakeSession);
    await Promise.all(frames.map(f => fetch.attachFrame(f)));
    expect(frames.flatMap(f => f.sent)).toEqual([]);
    expect(fetch.frameStats('tab-1')).toEqual({ frames: 30, active: 0, pending: 0 });
  });

  it('offers a frame request to the clients with the tab id and answers it on the frame session', async () => {
    const page = new FakeSession();
    const frame = page.childSession('s1') as FakeSession;
    const fetch = new FetchInterception(nullLogger);
    const seen: string[] = [];
    fetch.register(
      client({
        want: { patterns: ['*'] },
        onRequest: r => {
          seen.push(`${r.tabId} ${r.frameId} ${r.url}`);
          return { kind: 'fulfill', status: 500, headers: { 'content-type': 'application/json' }, body: '{}', note: 'mocked by m1' };
        },
      }),
    );
    const notes: string[] = [];
    fetch.onDidIntercept(e => notes.push(`${e.tabId} ${e.networkId} ${e.note}`));
    fetch.attach(page);
    await fetch.attachFrame(frame);
    frame.emit('Fetch.requestPaused', paused('job-7'));
    await flush();
    expect(seen).toEqual(['tab-1 F1 http://b/api/cart']);
    expect(frame.sent.at(-1)).toMatchObject({ method: 'Fetch.fulfillRequest', params: { requestId: 'job-7', responseCode: 500 } });
    expect(page.methods()).toEqual(['Fetch.enable']); // nothing answered on the page session
    expect(notes).toEqual(['tab-1 n-job-7 mocked by m1']);
  });

  it('answers login challenges in a frame through the client that handles logins', async () => {
    const page = new FakeSession();
    const frame = page.childSession('s1') as FakeSession;
    const fetch = new FetchInterception(nullLogger);
    fetch.register(client({ want: { patterns: ['*'], auth: true }, onAuth: async () => ({ kind: 'provide', username: 'u', password: 'p' }) }));
    fetch.attach(page);
    await fetch.attachFrame(frame);
    frame.emit('Fetch.authRequired', { ...paused('job-1'), authChallenge: { source: 'Server', origin: 'http://b', scheme: 'Basic', realm: 'R' } });
    await flush();
    expect(frame.sent.at(-1)).toEqual({ method: 'Fetch.continueWithAuth', params: { requestId: 'job-1', authChallengeResponse: { response: 'ProvideCredentials', username: 'u', password: 'p' } } });
  });

  it('stops deciding about a frame that goes away, and never answers on its dead session', async () => {
    const page = new FakeSession();
    const frame = page.childSession('s1') as FakeSession;
    const fetch = new FetchInterception(nullLogger);
    let aborted = false;
    fetch.register(
      client({
        want: { patterns: ['*'] },
        onRequest: (_r, signal): RequestDecision => {
          signal.addEventListener('abort', () => (aborted = true));
          return { kind: 'fail', reason: 'Failed', delayMs: 60_000 };
        },
      }),
    );
    fetch.attach(page);
    await fetch.attachFrame(frame);
    frame.emit('Fetch.requestPaused', paused('job-1'));
    await flush();
    expect(fetch.frameStats('tab-1').pending).toBe(1);
    const before = frame.sent.length;
    frame.close();
    await flush();
    expect(aborted).toBe(true);
    expect(frame.sent.length).toBe(before);
    expect(fetch.frameStats('tab-1')).toEqual({ frames: 0, active: 0, pending: 0 });
    // A later frame of the same tab is served normally.
    const next = page.childSession('s2') as FakeSession;
    await fetch.attachFrame(next);
    expect(next.methods()).toEqual(['Fetch.enable']);
  });

  it('serves at most MAX_FRAME_TARGETS frames per tab and tells the agent once', async () => {
    const page = new FakeSession();
    const fetch = new FetchInterception(nullLogger);
    const notes: string[] = [];
    fetch.onDidNote(n => notes.push(n.text));
    fetch.register(client({ want: { patterns: ['*api*'] } }));
    fetch.attach(page);
    const frames = Array.from({ length: MAX_FRAME_TARGETS + 2 }, (_, i) => page.childSession(`s${i}`) as FakeSession);
    await Promise.all(frames.map(f => fetch.attachFrame(f)));
    expect(fetch.frameStats('tab-1')).toEqual({ frames: MAX_FRAME_TARGETS, active: MAX_FRAME_TARGETS, pending: 0 });
    expect(frames.at(-1)!.sent).toEqual([]);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/more than 100 cross-origin frames/);
  });

  it('hands the domain back in frames on dispose', async () => {
    const page = new FakeSession();
    const frame = page.childSession('s1') as FakeSession;
    const fetch = new FetchInterception(nullLogger);
    fetch.register(client({ want: { patterns: ['*'] } }));
    fetch.attach(page);
    await fetch.attachFrame(frame);
    fetch.dispose();
    await flush();
    expect(frame.methods()).toEqual(['Fetch.enable', 'Fetch.disable']);
  });
});

describe('frame registry holds new frames until interception is in place', () => {
  afterEach(() => vi.useRealTimers());

  function setup(attachFrame: (session: CdpPage) => Promise<void> | void) {
    const page = new FakeSession();
    let seq = 0;
    const frames = new FrameRegistry(page, { log: nullLogger, console: new ConsoleLog(10, () => ++seq), network: new NetworkLog(10, () => ++seq), nextSeq: () => ++seq, activity() {}, changed() {}, attachFrame });
    const attach = (via: FakeSession, sessionId: string, waitingForDebugger: boolean, type = 'iframe') => {
      via.emit('Target.attachedToTarget', { sessionId, targetInfo: { targetId: `T-${sessionId}`, type, url: '', parentFrameId: 'MAIN' }, waitingForDebugger });
      return page.childSession(sessionId) as FakeSession;
    };
    return { page, frames, attach };
  }

  it('asks to hold new frames, and releases one only after interception and recording are set up', async () => {
    let release!: () => void;
    const order: string[] = [];
    const { page, frames, attach } = setup(session => {
      order.push((session as FakeSession).tabId);
      return new Promise<void>(resolve => (release = resolve));
    });
    expect(page.sent[0]).toMatchObject({ method: 'Target.setAutoAttach', params: { waitForDebuggerOnStart: true } });
    const frame = attach(page, 's1', true);
    await flush();
    expect(frame.methods('Runtime.run')).toEqual([]);
    expect(frame.methods('')).toEqual(expect.arrayContaining(['Network.enable', 'Runtime.enable', 'Target.setAutoAttach']));
    release();
    await frames.whenReady(1000);
    const methods = frame.methods('');
    expect(methods.indexOf('Runtime.runIfWaitingForDebugger')).toBeGreaterThan(methods.indexOf('Network.enable'));
    expect(methods.filter(m => m === 'Runtime.runIfWaitingForDebugger')).toHaveLength(1);
    // Nested frames are held the same way.
    expect(frame.sent.find(s => s.method === 'Target.setAutoAttach')?.params).toMatchObject({ waitForDebuggerOnStart: true });
    expect(order).toHaveLength(1);
  });

  it('releases a held frame after FRAME_HOLD_MS even when something never answers', async () => {
    vi.useFakeTimers();
    const { page, attach } = setup(() => new Promise<void>(() => {}));
    const frame = attach(page, 's1', true);
    frame.hang = /^Network\.enable$/;
    await vi.advanceTimersByTimeAsync(FRAME_HOLD_MS - 100);
    expect(frame.methods('Runtime.run')).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    expect(frame.methods('Runtime.run')).toEqual(['Runtime.runIfWaitingForDebugger']);
  });

  it('does not run frames that were already running, and lets other waiting targets go at once', async () => {
    const { page, frames, attach } = setup(() => undefined);
    const running = attach(page, 's1', false);
    const worker = attach(page, 'w1', true, 'worker');
    await frames.whenReady(1000);
    expect(running.methods('Runtime.run')).toEqual([]);
    expect(worker.methods('')).toEqual(['Runtime.runIfWaitingForDebugger']);
    expect(frames.list().map(f => f.id)).toEqual(['T-s1']);
  });
});
