import { describe, expect, it } from 'vitest';
import type { BrowserTabInfo } from '../../src/extension/core/services';
import { SESSION_COLORS, type AgentSession } from '../../src/extension/core/sessions';
import { checkFavicon, FAVICON_LIMITS, FaviconCache, parseDataUri, sniffImage, svgProblem } from '../../src/extension/ui/favicon';
import { buildViewModel, diffModels, treeAsText } from '../../src/extension/ui/model';
import { buildPanelModel, panelTabNodeId } from '../../src/extension/ui/panelModel';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAHElEQVR4nGP4z8BAEmIY1TCqYVTDqIZRDcNXAwBrnz/x2fH3DwAAAABJRU5ErkJggg==';
const pngUri = `data:image/png;base64,${PNG}`;
const svg = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">${body}</svg>`;
const b64 = (text: string | Buffer) => Buffer.from(text).toString('base64');

describe('parseDataUri', () => {
  it('decodes base64 and percent-encoded payloads', () => {
    expect(parseDataUri(pngUri)?.mime).toBe('image/png');
    expect(parseDataUri(pngUri)?.bytes.length).toBe(85);
    expect(Buffer.from(parseDataUri('data:image/svg+xml,%3Csvg%3E%3C/svg%3E')!.bytes).toString()).toBe('<svg></svg>');
  });

  it('refuses what is not a data: URI or not base64', () => {
    expect(parseDataUri('https://example.com/favicon.ico')).toBeUndefined();
    expect(parseDataUri('data:image/png;base64,***')).toBeUndefined();
  });
});

describe('sniffImage', () => {
  it('recognises formats by their bytes, not the declared type', () => {
    expect(sniffImage(Buffer.from(PNG, 'base64'))).toBe('image/png');
    expect(sniffImage(Buffer.from([0, 0, 1, 0, 1, 0, 16, 16]))).toBe('image/x-icon');
    expect(sniffImage(Buffer.from('GIF89a....'))).toBe('image/gif');
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(sniffImage(Buffer.from(`<?xml version="1.0"?>\n<!-- x -->\n${svg('')}`))).toBe('svg');
    expect(sniffImage(Buffer.from('<!doctype html><title>x</title>'))).toBeUndefined();
    expect(sniffImage(Buffer.from([0, 0, 2, 0, 1, 0]))).toBeUndefined(); // a cursor, not an icon
  });
});

describe('svgProblem', () => {
  it('accepts plain drawing with internal references', () => {
    expect(svgProblem(svg('<defs><linearGradient id="g"/></defs><circle fill="url(#g)" r="7"/><use href="#g"/>'))).toBeUndefined();
  });

  it.each([
    ['<script>alert(1)</script>', /script/],
    ['<foreignObject><div/></foreignObject>', /foreign/],
    ['<rect onload="x()"/>', /event handler/],
    ['<a href="javascript:alert(1)"><rect/></a>', /javascript|outside/],
    ['<image href="https://tracker.example/p.png"/>', /outside/],
    ['<image xlink:href="data:image/png;base64,AAAA"/>', /outside/],
    ['<rect style="fill: url(https://x.example/a.svg#p)"/>', /outside/],
    ['<style>@import "https://x.example/a.css";</style>', /imports/],
  ])('refuses %s', (body, reason) => {
    expect(svgProblem(svg(body))).toMatch(reason);
  });

  it('refuses entity declarations', () => {
    expect(svgProblem(`<!DOCTYPE svg [<!ENTITY a "aaaa">]>${svg('&a;')}`)).toMatch(/DOCTYPE/);
  });
});

describe('checkFavicon', () => {
  it('accepts a PNG and re-encodes it with the sniffed type and a stable key', () => {
    const r = checkFavicon(`data:application/octet-stream;base64,${PNG}`);
    expect(r).toMatchObject({ ok: true, mime: 'image/png', uri: pngUri, bytes: 85 });
    const again = checkFavicon(pngUri);
    expect(again.ok && r.ok && again.key === r.key).toBe(true);
    expect(r.ok && r.key).toMatch(/^fav-[0-9a-f]{12}$/);
  });

  it('accepts a clean SVG and refuses one with a script', () => {
    expect(checkFavicon(`data:image/svg+xml;base64,${b64(svg('<circle r="7"/>'))}`)).toMatchObject({ ok: true, mime: 'image/svg+xml' });
    expect(checkFavicon(`data:image/svg+xml;base64,${b64(svg('<script>alert(1)</script>'))}`)).toMatchObject({ ok: false, reason: expect.stringMatching(/SVG refused: it contains a script/) });
  });

  it('refuses icons over the size limit, before and after decoding', () => {
    const big = Buffer.concat([Buffer.from(PNG, 'base64'), Buffer.alloc(FAVICON_LIMITS.maxBytes)]);
    expect(checkFavicon(`data:image/png;base64,${big.toString('base64')}`)).toMatchObject({ ok: false, reason: 'larger than 32 KB' });
    expect(checkFavicon(`data:image/png;base64,${'A'.repeat(FAVICON_LIMITS.maxUriLength)}`)).toMatchObject({ ok: false, reason: 'larger than 32 KB' });
  });

  it('refuses remote URIs, empty data and non-images', () => {
    expect(checkFavicon('https://example.com/favicon.ico').ok).toBe(false);
    expect(checkFavicon('data:image/png;base64,').ok).toBe(false);
    expect(checkFavicon(`data:image/png;base64,${b64('<!doctype html><p>not found</p>')}`)).toMatchObject({ ok: false, reason: expect.stringMatching(/not an image/) });
  });
});

describe('FaviconCache', () => {
  it('checks each distinct icon once and finds accepted ones by key', () => {
    let calls = 0;
    const cache = new FaviconCache(4, uri => (calls++, checkFavicon(uri)));
    const first = cache.get(pngUri);
    cache.get(pngUri);
    expect(calls).toBe(1);
    expect(first.ok && cache.uriOf(first.key)).toBe(pngUri);
  });

  it('drops the least recently used entry when full, and what is no longer in use on retain', () => {
    let calls = 0;
    const cache = new FaviconCache(2, uri => (calls++, checkFavicon(uri)));
    const svgUri = (n: number) => `data:image/svg+xml;base64,${b64(svg(`<circle r="${n}"/>`))}`;
    cache.get(svgUri(1));
    cache.get(svgUri(2));
    cache.get(svgUri(1)); // 1 is now the most recent
    const third = cache.get(svgUri(3)); // evicts 2
    expect(cache.size).toBe(2);
    cache.get(svgUri(1));
    expect(calls).toBe(3);
    cache.retain(new Set([svgUri(1)]));
    expect(cache.size).toBe(1);
    expect(third.ok && cache.uriOf(third.key)).toBeUndefined();
  });

  it('never keeps an oversized URI', () => {
    const cache = new FaviconCache();
    expect(cache.get(`data:image/png;base64,${'A'.repeat(FAVICON_LIMITS.maxUriLength)}`).ok).toBe(false);
    expect(cache.size).toBe(0);
  });
});

// ---------------------------------------------------------------- in the view models

function session(n: number): AgentSession {
  return {
    id: `s${n}`,
    client: { name: 'claude-code', version: '2.1.0', kind: 'claude-code' },
    number: n,
    label: `Claude ${n}`,
    badge: `C${n}`,
    color: SESSION_COLORS[(n - 1) % SESSION_COLORS.length]!,
    title: undefined,
    pid: 1000 + n,
    cwd: '/work/app',
    createdAt: n,
    lastActivityAt: n,
    connected: true,
  };
}

function tab(id: string, extra: Partial<BrowserTabInfo> = {}): BrowserTabInfo {
  return { id, url: 'http://localhost:3000/', title: 'App', active: false, origin: 'agent', openedBy: 's1', controlledBy: undefined, allowedSessions: [], paused: false, ...extra };
}

describe('tab rows with a site icon', () => {
  const s1 = session(1);
  const tabs = [tab('tab-1', { controlledBy: 's1' }), tab('tab-2'), tab('tab-3', { paused: true }), tab('tab-4', { request: { sessionId: 's1', message: 'Sign in', since: 1 } }), tab('tab-5')];
  const tabIcons = new Map(['tab-1', 'tab-2', 'tab-3', 'tab-4'].map(id => [id, 'fav-0123456789ab']));
  const base = { sessions: [s1], tabs, terminals: [], browserAvailable: true, graceSeconds: 20 };

  it('shows the icon in the Sessions tree instead of the globe, keeping warning icons and the globe as fallback', () => {
    const model = buildViewModel({ ...base, tabIcons });
    const icon = (id: string) => model.nodes.get(`session:s1/tab:${id}`)!.icon;
    expect(icon('tab-1')).toEqual({ id: 'globe', color: s1.color.themeColor, image: 'fav-0123456789ab' });
    expect(icon('tab-2')).toEqual({ id: 'globe', image: 'fav-0123456789ab' });
    expect(icon('tab-3').image).toBeUndefined();
    expect(icon('tab-4').image).toBeUndefined();
    expect(icon('tab-5')).toEqual({ id: 'globe' });
    expect(treeAsText(model)).toContain('[globe:terminal');
    expect(treeAsText(model)).toContain('fav-0123456789ab]');
  });

  it('shows the icon in the panel while the agent has or controls the tab', () => {
    const model = buildPanelModel({ sessions: [s1], tabs, tabIcons });
    const icon = (id: string) => model.nodes.get(panelTabNodeId(id))!.icon;
    expect(icon('tab-1')).toMatchObject({ id: 'circle-large-filled', image: 'fav-0123456789ab' });
    expect(icon('tab-2')).toMatchObject({ id: 'circle-large-outline', image: 'fav-0123456789ab' });
    expect(icon('tab-3')).toEqual({ id: 'debug-pause', color: s1.color.themeColor });
    expect(icon('tab-4').image).toBeUndefined();
  });

  it('an icon arriving changes only that row', () => {
    const before = buildViewModel(base);
    const after = buildViewModel({ ...base, tabIcons: new Map([['tab-2', 'fav-0123456789ab']]) });
    expect(diffModels(before, after)).toEqual({ full: false, changed: ['session:s1/tab:tab-2'] });
    expect(diffModels(after, buildViewModel({ ...base, tabIcons: new Map([['tab-2', 'fav-0123456789ab']]) }))).toEqual({ full: false, changed: [] });
  });

  it('refuses SVG that hides a reference or handler behind unusual syntax', async () => {
    const { svgProblem } = await import('../../src/extension/ui/favicon');
    const svg = (inner: string) => `<svg xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;
    expect(svgProblem(svg('<use href=http://evil/x.svg#a/>'))).toBeDefined();
    expect(svgProblem(svg('<rect/onload="x"/>'))).toBeDefined();
    expect(svgProblem('<svg/onload=alert(1)>')).toBeDefined();
    expect(svgProblem(svg('<style>a{fill:\\75rl(http://e/x)}</style>'))).toBeDefined();
    expect(svgProblem(svg('<style>@\\69mport "http://e/a.css"</style>'))).toBeDefined();
    expect(svgProblem(svg('<s&#99;ript>1</s&#99;ript>'))).toBeDefined();
    expect(svgProblem(svg('<use href="#a"/><rect fill="url(#g)"/>'))).toBeUndefined();
  });
});
