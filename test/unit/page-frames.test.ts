import { describe, expect, it } from 'vitest';
import { CdpConnection } from '../../src/extension/browser/cdp';
import { insideQuad, quadToTop, toParent, toTop, type FramePlacement } from '../../src/extension/browser/page/frameGeometry';
import { RefTable } from '../../src/extension/browser/page/refs';
import { ConsoleLog } from '../../src/extension/browser/page/consoleLog';
import { FrameRegistry } from '../../src/extension/browser/page/frames';
import { NetworkLog } from '../../src/extension/browser/page/networkLog';
import { nullLogger } from '../../src/extension/core/log';
import { ToolError } from '../../src/extension/core/errors';
import type { CdpPage } from '../../src/extension/core/services';

/** The content quad of an axis-aligned box. */
const box = (x: number, y: number, w: number, h: number) => [x, y, x + w, y, x + w, y + h, x, y + h];

describe('frame coordinates', () => {
  it('translates a point of a plain iframe by its content box', () => {
    const placement: FramePlacement = { content: box(338, 81.875, 320, 110), width: 320, height: 110 };
    expect(toParent({ x: 55.6, y: 51.75 }, placement)).toEqual({ x: 393.6, y: 133.625 });
  });

  it('handles a scaled iframe (transform: scale(0.5))', () => {
    const placement: FramePlacement = { content: box(100, 50, 200, 100), width: 400, height: 200 };
    expect(toParent({ x: 200, y: 100 }, placement)).toEqual({ x: 200, y: 100 });
    expect(toParent({ x: 0, y: 0 }, placement)).toEqual({ x: 100, y: 50 });
    expect(toParent({ x: 400, y: 200 }, placement)).toEqual({ x: 300, y: 150 });
  });

  it('handles a rotated iframe', () => {
    // 90° clockwise around the top-left corner (100, 100): x axis points down, y axis points left.
    const placement: FramePlacement = { content: [100, 100, 100, 300, 0, 300, 0, 100], width: 200, height: 100 };
    const p = toParent({ x: 50, y: 10 }, placement);
    expect(p.x).toBeCloseTo(90);
    expect(p.y).toBeCloseTo(150);
  });

  it('maps through nested frames, innermost first', () => {
    const inner: FramePlacement = { content: box(30, 40, 100, 100), width: 100, height: 100 };
    const outer: FramePlacement = { content: box(200, 300, 400, 400), width: 400, height: 400 };
    expect(toTop({ x: 5, y: 6 }, [inner, outer])).toEqual({ x: 235, y: 346 });
    expect(quadToTop(box(0, 0, 10, 10), [inner, outer])).toEqual(box(230, 340, 10, 10));
  });

  it('tells whether a point is inside a quad', () => {
    expect(insideQuad({ x: 5, y: 5 }, box(0, 0, 10, 10))).toBe(true);
    expect(insideQuad({ x: 10, y: 10 }, box(0, 0, 10, 10))).toBe(true);
    expect(insideQuad({ x: 11, y: 5 }, box(0, 0, 10, 10))).toBe(false);
    expect(insideQuad({ x: 50, y: 150 }, [100, 100, 100, 300, 0, 300, 0, 100])).toBe(true);
    expect(insideQuad({ x: 150, y: 150 }, [100, 100, 100, 300, 0, 300, 0, 100])).toBe(false);
  });
});

describe('refs in frames', () => {
  it('keeps nodes of different frame targets apart although their backend ids collide', () => {
    const t = new RefTable();
    const main = t.assign({ backendNodeId: 20, frameId: 'main', role: 'button', name: 'Top' }, 'L1');
    const inFrame = t.assign({ backendNodeId: 20, frameId: 'F1', role: 'button', name: 'Inner', frame: 'F1', frameLoaderId: 'FL1' }, 'L1');
    expect(main).not.toBe(inFrame);
    expect(t.get(inFrame)).toMatchObject({ backendNodeId: 20, frame: 'F1', frameLoaderId: 'FL1' });
    expect(t.get(main)?.frame).toBeUndefined();
    // Same node, same documents: same ref. The frame's document changed: a new ref.
    expect(t.assign({ backendNodeId: 20, frameId: 'F1', role: 'button', name: 'Inner', frame: 'F1', frameLoaderId: 'FL1' }, 'L1')).toBe(inFrame);
    expect(t.assign({ backendNodeId: 20, frameId: 'F1', role: 'button', name: 'Inner', frame: 'F1', frameLoaderId: 'FL2' }, 'L1')).not.toBe(inFrame);
  });
});

// ---------------------------------------------------------------- frame registry


/** A CDP page (or child session) that records commands and lets the test fire events. */
class FakeSession implements CdpPage {
  readonly tabId = 'tab-1';
  closed = false;
  readonly sent: Array<{ method: string; params: Record<string, unknown> }> = [];
  private readonly listeners = new Map<string, Set<(p: any) => void>>();
  private readonly closeListeners = new Set<() => void>();
  constructor(
    private readonly children: Map<string, FakeSession>,
    private readonly answers: (method: string) => unknown = () => ({}),
  ) {}
  send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.sent.push({ method, params });
    return Promise.resolve(this.answers(method) as T);
  }
  on(event: string, listener: (p: any) => void) {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(listener);
    return { dispose: () => void set.delete(listener) };
  }
  readonly onDidClose = (listener: () => void) => {
    this.closeListeners.add(listener);
    return { dispose: () => void this.closeListeners.delete(listener) };
  };
  childSession(sessionId: string): CdpPage {
    let child = this.children.get(sessionId);
    if (!child) this.children.set(sessionId, (child = new FakeSession(this.children, this.answers)));
    return child;
  }
  emit(event: string, params: unknown): void {
    for (const l of [...(this.listeners.get(event) ?? [])]) l(params);
  }
  close(): void {
    this.closed = true;
    for (const l of [...this.closeListeners]) l();
  }
}

function registry() {
  const children = new Map<string, FakeSession>();
  const page = new FakeSession(children, method => (method === 'Page.getFrameTree' ? { frameTree: { frame: { id: 'X', loaderId: 'L0', url: 'about:blank' } } } : method === 'Runtime.evaluate' ? { result: { value: 'complete' } } : {}));
  let seq = 0;
  const frames = new FrameRegistry(page, { log: nullLogger, console: new ConsoleLog(10, () => ++seq), network: new NetworkLog(10, () => ++seq), nextSeq: () => ++seq, activity() {}, changed() {} });
  const attach = (via: FakeSession, sessionId: string, targetId: string, parentFrameId: string, type = 'iframe') =>
    via.emit('Target.attachedToTarget', { sessionId, targetInfo: { targetId, type, url: '', parentFrameId } });
  return { page, children, frames, attach, seq: () => seq };
}

describe('frame registry', () => {
  it('auto-attaches to iframe targets only, and to nested ones through each frame', async () => {
    const { page, children, frames, attach } = registry();
    expect(page.sent[0]).toMatchObject({ method: 'Target.setAutoAttach', params: { autoAttach: true, flatten: true, filter: [{ type: 'iframe', exclude: false }] } });
    attach(page, 's1', 'F1', 'MAIN');
    attach(page, 'w1', 'W1', 'MAIN', 'worker');
    expect(frames.list().map(f => f.id)).toEqual(['F1']);
    await frames.whenReady(100);
    const child = children.get('s1')!;
    expect(child.sent.map(c => c.method)).toEqual(expect.arrayContaining(['Page.enable', 'Runtime.enable', 'Network.enable', 'Log.enable', 'DOM.enable', 'Target.setAutoAttach']));
    attach(child, 's2', 'F2', 'F1');
    const nested = frames.get('F2')!;
    expect(frames.parentOf(nested)?.id).toBe('F1');
    expect(frames.chain(nested).map(f => f.id)).toEqual(['F1', 'F2']);
    expect(frames.parentOf(frames.get('F1')!)).toBeUndefined();
  });

  it('knows which target renders a frame, and records navigations and departures', async () => {
    const { page, children, frames, attach, seq } = registry();
    attach(page, 's1', 'F1', 'MAIN');
    await frames.whenReady(100);
    const child = children.get('s1')!;
    child.emit('Page.frameAttached', { frameId: 'SUB', parentFrameId: 'F1' });
    expect(frames.targetOf('SUB')?.id).toBe('F1');
    expect(frames.targetOf('MAIN')).toBeUndefined();
    const mark = seq();
    child.emit('Page.frameStartedLoading', { frameId: 'F1' });
    expect(frames.loadingSince(mark).map(f => f.id)).toEqual(['F1']);
    child.emit('Page.frameNavigated', { frame: { id: 'F1', loaderId: 'L2', url: 'https://b.example/next' } });
    child.emit('Page.frameStoppedLoading', { frameId: 'F1' });
    expect(frames.loadingSince(mark)).toEqual([]);
    expect(frames.get('F1')).toMatchObject({ loaderId: 'L2', url: 'https://b.example/next' });
    expect(frames.get('F1')!.lifecycle.has('DOMContentLoaded')).toBe(true);
    child.close();
    expect(frames.get('F1')).toBeUndefined();
    expect(frames.describeSince(mark)).toEqual(["A cross-origin frame (https://b.example/next) went away: removed, reloaded or navigated to this page's own site."]);
  });

  it('records console messages and requests of frames into the tab logs', async () => {
    const children = new Map<string, FakeSession>();
    const page = new FakeSession(children);
    let seq = 0;
    const consoleLog = new ConsoleLog(10, () => ++seq);
    const network = new NetworkLog(10, () => ++seq);
    const frames = new FrameRegistry(page, { log: nullLogger, console: consoleLog, network, nextSeq: () => ++seq, activity() {}, changed() {} });
    page.emit('Target.attachedToTarget', { sessionId: 's1', targetInfo: { targetId: 'F1', type: 'iframe', parentFrameId: 'MAIN' } });
    const child = children.get('s1')!;
    child.emit('Runtime.consoleAPICalled', { type: 'error', args: [{ type: 'string', value: 'from the frame' }] });
    child.emit('Network.requestWillBeSent', { requestId: 'R1', frameId: 'F1', request: { url: 'https://b.example/api', method: 'GET', headers: {} }, timestamp: 1, wallTime: 1, type: 'Fetch' });
    expect(consoleLog.entries.all().map(e => e.text)).toEqual(['from the frame']);
    expect(network.entries.all().map(e => e.url)).toEqual(['https://b.example/api']);
    expect(frames.size).toBe(1);
  });
});

// ---------------------------------------------------------------- child sessions of a CDP connection

describe('CdpConnection child sessions', () => {
  async function connect() {
    const sent: any[] = [];
    let receive: (m: unknown) => void = () => {};
    const session = {
      sendMessage(message: any) {
        sent.push(message);
        const answers: Record<string, unknown> = {
          'Target.attachToBrowserTarget': { sessionId: 'B' },
          'Target.getTargets': { targetInfos: [{ type: 'page', targetId: 'P' }] },
          'Target.attachToTarget': { sessionId: 'S' },
        };
        if (message.method in answers) queueMicrotask(() => receive({ id: message.id, result: answers[message.method] }));
        return Promise.resolve();
      },
      onDidReceiveMessage(listener: (m: unknown) => void) {
        receive = listener;
        return { dispose() {} };
      },
      onDidClose: () => ({ dispose() {} }),
      close() {},
    };
    const tab = { startCDPSession: async () => session } as any;
    const connection = await CdpConnection.attach('tab-1', tab);
    return { connection, sent, receive: (m: unknown) => receive(m) };
  }

  it('routes commands and events by session, and a child failure leaves the page connected', async () => {
    const { connection, sent, receive } = await connect();
    const child = connection.childSession('C1');
    const pageEvents: unknown[] = [];
    const childEvents: unknown[] = [];
    connection.on('Runtime.consoleAPICalled', p => pageEvents.push(p));
    child.on('Runtime.consoleAPICalled', p => childEvents.push(p));
    receive({ method: 'Runtime.consoleAPICalled', sessionId: 'C1', params: { n: 1 } });
    receive({ method: 'Runtime.consoleAPICalled', sessionId: 'S', params: { n: 2 } });
    expect(childEvents).toEqual([{ n: 1 }]);
    expect(pageEvents).toEqual([{ n: 2 }]);

    const pending = child.send('Runtime.evaluate', { expression: '1' });
    const message = sent.at(-1);
    expect(message).toMatchObject({ method: 'Runtime.evaluate', sessionId: 'C1' });
    receive({ id: message.id, error: { message: 'Session with given id not found' } });
    await expect(pending).rejects.toThrow(/A frame in tab-1 went away/);
    expect(child.closed).toBe(true);
    expect(connection.closed).toBe(false);
  });

  it('ends commands of a child that detaches instead of letting them hang', async () => {
    const { connection, receive } = await connect();
    const child = connection.childSession('C2');
    const pending = child.send('Runtime.evaluate', { expression: 'new Promise(() => {})' });
    receive({ method: 'Target.detachedFromTarget', sessionId: 'S', params: { sessionId: 'C2', targetId: 'F2' } });
    await expect(pending).rejects.toBeInstanceOf(ToolError);
    expect(child.closed).toBe(true);
    expect(connection.closed).toBe(false);
    // Closing the page connection closes its children.
    const other = connection.childSession('C3');
    connection.close();
    expect(other.closed).toBe(true);
  });
});
