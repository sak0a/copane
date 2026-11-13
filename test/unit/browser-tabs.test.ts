import { describe, expect, it } from 'vitest';
import { BINDING, markerSource, MARKER_ATTRIBUTE, PageMarker, WORLD, type MarkerPage } from '../../src/extension/browser/marker';
import { candidatesFor, compareTabIds, parseState } from '../../src/extension/browser/tabState';
import { normalizeUrl } from '../../src/extension/browser/tabTools';

describe('tab state', () => {
  it('accepts a stored state and never reuses a remembered id', () => {
    const state = parseState({
      version: 1,
      nextNumber: 2,
      tabs: [
        { id: 'tab-7', viewId: 'v7', origin: 'agent', openedBy: 's1', url: 'http://a.test/' },
        { id: 'bogus', viewId: 'v', origin: 'agent', url: '' },
        { id: 'tab-3', viewId: 'v3', origin: 'martian', url: '' },
      ],
      currentTab: { s1: 'tab-7', s2: 5 },
    });
    expect(state.tabs.map(t => t.id)).toEqual(['tab-7']);
    expect(state.nextNumber).toBe(8);
    expect(state.currentTab).toEqual({ s1: 'tab-7' });
  });

  it('starts empty from nothing or from another version', () => {
    for (const raw of [undefined, null, 'x', { version: 2, tabs: [] }]) expect(parseState(raw)).toEqual({ version: 1, nextNumber: 1, tabs: [], currentTab: {} });
  });

  it('only identifies restored tabs whose URL could match a remembered one', () => {
    const state = parseState({ version: 1, nextNumber: 1, tabs: [{ id: 'tab-1', viewId: 'v1', origin: 'user', url: 'http://a.test/' }], currentTab: {} });
    expect(candidatesFor(state, 'http://a.test/', new Set())).toHaveLength(1);
    expect(candidatesFor(state, 'about:blank', new Set())).toHaveLength(1);
    expect(candidatesFor(state, 'http://b.test/', new Set())).toHaveLength(0);
    expect(candidatesFor(state, 'http://a.test/', new Set(['v1']))).toHaveLength(0);
  });

  it('sorts tab ids by number', () => {
    expect(['tab-10', 'tab-9', 'tab-1'].sort(compareTabIds)).toEqual(['tab-1', 'tab-9', 'tab-10']);
  });
});

describe('normalizeUrl', () => {
  it('adds a scheme to bare hosts and leaves URLs alone', () => {
    expect(normalizeUrl('localhost:3000')).toBe('http://localhost:3000');
    expect(normalizeUrl('localhost:3000/path')).toBe('http://localhost:3000/path');
    expect(normalizeUrl('127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
    expect(normalizeUrl('example.com/a')).toBe('https://example.com/a');
    expect(normalizeUrl(' https://example.com ')).toBe('https://example.com');
    expect(normalizeUrl('about:blank')).toBe('about:blank');
    expect(normalizeUrl('file:///tmp/x.html')).toBe('file:///tmp/x.html');
  });
});

/** A CDP page that records commands and lets the test fire events. */
function fakePage(options: { failEvaluate?: boolean } = {}) {
  const sent: Array<{ method: string; params: any }> = [];
  const listeners = new Map<string, Set<(p: any) => void>>();
  const page: MarkerPage = {
    async send(method: string, params: any = {}) {
      sent.push({ method, params });
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } } as any;
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 11 } as any;
      if (method === 'Runtime.evaluate' && options.failEvaluate) throw new Error('Cannot find context with specified id');
      return {} as any;
    },
    on(event: string, listener: (p: any) => void) {
      let set = listeners.get(event);
      if (!set) listeners.set(event, (set = new Set()));
      set.add(listener);
      return { dispose: () => void set!.delete(listener) };
    },
  };
  const fire = (event: string, params: any) => listeners.get(event)?.forEach(l => l(params));
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  return { page, sent, fire, tick };
}

describe('PageMarker', () => {
  const state = { label: 'Claude 2 · tests', color: '#3794ff', paused: false };

  it('installs into an isolated world for new documents and the current one, then pushes the state', async () => {
    const { page, sent, tick } = fakePage();
    const marker = new PageMarker(page, () => {});
    marker.set(state);
    await marker.install();
    await tick();
    const methods = sent.map(s => s.method);
    expect(methods).toContain('Runtime.addBinding');
    expect(sent.find(s => s.method === 'Runtime.addBinding')!.params).toEqual({ name: BINDING, executionContextName: WORLD });
    expect(sent.find(s => s.method === 'Page.addScriptToEvaluateOnNewDocument')!.params.worldName).toBe(WORLD);
    const evaluations = sent.filter(s => s.method === 'Runtime.evaluate');
    expect(evaluations.every(e => e.params.contextId === 11)).toBe(true);
    expect(evaluations.at(-1)!.params.expression).toContain('"label":"Claude 2 · tests"');
  });

  it('does not touch the page until there is something to show', async () => {
    const { page, sent, tick } = fakePage();
    const marker = new PageMarker(page, () => {});
    marker.set(null);
    await tick();
    expect(sent).toEqual([]);
  });

  it('pushes the state to each new document that says hello, and reports clicks', async () => {
    const { page, sent, fire, tick } = fakePage();
    const actions: string[] = [];
    const marker = new PageMarker(page, a => actions.push(a));
    marker.set(state);
    await marker.install();
    sent.length = 0;
    fire('Runtime.bindingCalled', { name: BINDING, payload: JSON.stringify({ type: 'hello' }), executionContextId: 42 });
    await tick();
    expect(sent.map(s => [s.method, s.params.contextId])).toEqual([['Runtime.evaluate', 42]]);
    fire('Runtime.bindingCalled', { name: BINDING, payload: JSON.stringify({ type: 'pause' }), executionContextId: 42 });
    fire('Runtime.bindingCalled', { name: 'someoneElse', payload: JSON.stringify({ type: 'resume' }), executionContextId: 42 });
    fire('Runtime.bindingCalled', { name: BINDING, payload: 'not json', executionContextId: 42 });
    expect(actions).toEqual(['pause']);
  });

  it('makes the indicator click-through before agent input, at most once per window', async () => {
    let now = 0;
    const { page, sent } = fakePage();
    const marker = new PageMarker(page, () => {}, undefined, () => now);
    marker.set(state);
    await marker.install();
    sent.length = 0;
    await marker.beforeInput();
    await marker.beforeInput();
    expect(sent.filter(s => s.params.expression?.includes('passive'))).toHaveLength(1);
    now += 1200;
    await marker.beforeInput();
    expect(sent.filter(s => s.params.expression?.includes('passive'))).toHaveLength(2);
    marker.set({ ...state, paused: true });
    now += 5000;
    sent.length = 0;
    await marker.beforeInput();
    expect(sent.filter(s => s.params.expression?.includes('passive'))).toHaveLength(0);
  });

  it('survives a document that went away', async () => {
    const { page } = fakePage({ failEvaluate: true });
    const marker = new PageMarker(page, () => {});
    marker.set(state);
    await expect(marker.install()).resolves.toBeUndefined();
    await expect(marker.beforeInput()).resolves.toBeUndefined();
  });

  it('ships a self-contained page script that marks its root and keeps out of page globals', () => {
    const source = markerSource();
    expect(source).toContain(MARKER_ATTRIBUTE);
    expect(source).toMatch(/mode: ["']closed["']/);
    expect(source).toContain('isTrusted');
    // It must parse as a standalone script (no imports, no TypeScript left over).
    expect(() => new Function(source)).not.toThrow();
  });
});
