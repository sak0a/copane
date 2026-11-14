import { describe, expect, it } from 'vitest';
import { contrastDetail, formatA11y, wcagOf, type AxeRule } from '../../src/extension/browser/page/a11yReport';
import type { NetworkEntry } from '../../src/extension/browser/page/networkLog';
import { clsOf, formatPerf, summarizeNetwork, type PageTimings } from '../../src/extension/browser/page/perfReport';

describe('formatA11y', () => {
  const rule = (id: string, impact: AxeRule['impact'], count: number, nodes = count): AxeRule => ({
    id,
    impact,
    help: `${id} help`,
    count,
    nodes: Array.from({ length: Math.min(nodes, 4) }, (_, i) => ({ label: `el${i} [ref=e${i}]` })),
  });

  it('lists WCAG failures first with their criterion, then best practices, worst first, with refs and a fix', () => {
    const violations = [
      { ...rule('heading-order', 'moderate', 1), tags: ['cat.semantics', 'best-practice'] },
      { ...rule('color-contrast', 'serious', 2), tags: ['wcag2aa', 'wcag143'] },
      { ...rule('label', 'critical', 6), tags: ['wcag2a', 'wcag412', 'section508'] },
    ];
    const text = formatA11y({ tabId: 'tab-1', scope: 'whole page', version: '4.14.0', frames: 1, violations, incomplete: [], skipped: [] });
    const lines = text.split('\n');
    expect(lines[0]).toBe(
      'Accessibility of tab-1 (whole page; axe-core 4.14.0, WCAG 2.2 A/AA and best practices): 9 problems in 3 rules; 8 of them fail WCAG A/AA (2 rules); the rest are best practices. WCAG failures first, worst first.',
    );
    expect(lines[1]).toBe('- critical label ×6 [WCAG 4.1.2 A]: label help. Fix: give it a <label for>, or aria-label / aria-labelledby.');
    expect(lines[2]).toBe('  el0 [ref=e0]; el1 [ref=e1]; el2 [ref=e2]; el3 [ref=e3]; +2 more');
    expect(lines[3]).toMatch(/^- serious color-contrast ×2 \[WCAG 1\.4\.3 AA\]/);
    expect(text).toMatch(/\n- moderate heading-order ×1 \[best practice\]/);
    expect(text).toContain('https://dequeuniversity.com/rules/axe/4.14/<rule>');
    expect(text).toMatch(/not a conformance verdict/);
  });

  it('reads level and criteria from axe tags', () => {
    expect(wcagOf(['wcag2aa', 'wcag1410'])).toEqual({ level: 'AA', criteria: ['1.4.10'] });
    expect(wcagOf(['wcag21a', 'wcag135', 'wcag2a'])).toEqual({ level: 'A', criteria: ['1.3.5'] });
    expect(wcagOf(['best-practice'])).toBeUndefined();
    expect(wcagOf(undefined)).toBeUndefined();
  });

  it('caps the number of rules and summarises what needs a person', () => {
    const many = Array.from({ length: 15 }, (_, i) => rule(`rule-${i}`, 'minor', 1));
    const text = formatA11y({ tabId: 'tab-1', scope: 'whole page', version: '4.14.0', frames: 2, violations: many, incomplete: [{ id: 'color-contrast', count: 3, help: '' }], skipped: ['the frame x (timeout)'] });
    expect(text).toContain('whole page, 2 documents;');
    expect(text).toContain('- 3 more rules: rule-12 ×1, rule-13 ×1, rule-14 ×1.');
    expect(text).toContain('Needs a human look (axe could not decide, e.g. text over images): color-contrast ×3.');
    expect(text).toContain('Not checked: the frame x (timeout).');
  });

  it('says so when nothing is wrong, without claiming conformance', () => {
    const text = formatA11y({ tabId: 'tab-2', scope: 'only form [ref=e3]', version: '4.14.0', frames: 1, violations: [], incomplete: [], skipped: [] });
    expect(text.split('\n')[0]).toBe('Accessibility of tab-2 (only form [ref=e3]; axe-core 4.14.0, WCAG 2.2 A/AA and best practices): no problems found by the automated checks.');
    expect(text).toMatch(/not a conformance verdict/);
  });

  it('describes contrast failures with ratio and colours', () => {
    expect(contrastDetail({ contrastRatio: 1.912, expectedContrastRatio: '4.5:1', fgColor: '#bbbbbb', bgColor: '#ffffff', fontSize: '11.3pt (15px)', fontWeight: 'normal' })).toBe('(1.91:1, needs 4.5:1; #bbbbbb on #ffffff, 11.3pt (15px))');
    expect(contrastDetail(undefined)).toBeUndefined();
  });
});

function entry(seq: number, over: Partial<NetworkEntry>): NetworkEntry {
  return {
    seq,
    id: `r${seq}`,
    requestId: `q${seq}`,
    loaderId: 'L1',
    method: 'GET',
    url: `http://localhost:3000/r${seq}`,
    type: 'Script',
    frameId: 'F',
    startedAt: 0,
    respondedAt: 0,
    start: 1,
    end: 1.1,
    status: 200,
    statusText: 'OK',
    mimeType: 'text/javascript',
    size: 1000,
    fromCache: false,
    failed: undefined,
    canceled: false,
    redirectedTo: undefined,
    requestHeaders: {},
    responseHeaders: { 'Content-Encoding': 'gzip' },
    hasPostData: false,
    postData: undefined,
    bodyUnavailable: false,
    ...over,
  };
}

describe('summarizeNetwork', () => {
  const entries = [
    entry(1, { requestId: 'old', loaderId: 'L0', url: 'http://localhost:3000/previous-page' }),
    entry(2, { requestId: 'L1', type: 'Document', url: 'http://localhost:3000/', mimeType: 'text/html', size: 3000, end: 1.05 }),
    entry(3, { url: 'http://localhost:3000/app.js', size: 400_000, end: 1.3, responseHeaders: {} }),
    entry(4, { url: 'http://localhost:3000/api/items?page=1', type: 'Fetch', mimeType: 'application/json', size: 500, start: 2, end: 3.8 }),
    entry(5, { url: 'https://cdn.example.com/font.woff2', type: 'Font', mimeType: 'font/woff2', size: 30_000, fromCache: true }),
    entry(6, { url: 'http://localhost:3000/missing.png', type: 'Image', status: 404, size: 200 }),
    entry(7, { url: 'http://localhost:3000/live', type: 'EventSource', end: undefined }),
  ];

  it('covers the current load, with totals, the slowest and largest requests, and uncompressed text', () => {
    const s = summarizeNetwork(entries, 'L1', 'http://localhost:3000/');
    expect(s.complete).toBe(true);
    expect(s.requests).toBe(6);
    expect(s.failed).toBe(1);
    expect(s.fromCache).toBe(1);
    expect(s.slowest[0]).toEqual({ id: 'r4', label: '/api/items?page=1', ms: 1800 });
    expect(s.largest[0]).toEqual({ id: 'r3', label: '/app.js', bytes: 400_000 });
    expect(s.largest[1]?.label).toBe('cdn.example.com/font.woff2');
    expect(s.uncompressed).toEqual([{ id: 'r3', label: '/app.js', bytes: 400_000 }]);
    expect(s.byType[0]).toMatchObject({ type: 'script', count: 1 });
  });

  it('knows when the log missed the start of the load', () => {
    expect(summarizeNetwork(entries.slice(2), 'L1', 'http://localhost:3000/').complete).toBe(false);
  });
});

describe('clsOf', () => {
  it('takes the largest session window and ignores shifts after input', () => {
    expect(clsOf([])).toBe(0);
    const shifts = [
      { value: 0.1, time: 100, recentInput: false },
      { value: 0.05, time: 600, recentInput: false },
      { value: 0.5, time: 900, recentInput: true },
      { value: 0.12, time: 3000, recentInput: false },
    ];
    expect(clsOf(shifts)).toBeCloseTo(0.15);
    // A window ends after 5 s even without gaps.
    const steady = Array.from({ length: 12 }, (_, i) => ({ value: 0.02, time: i * 900, recentInput: false }));
    expect(clsOf(steady)).toBeCloseTo(0.12);
  });
});

describe('formatPerf', () => {
  const timings: PageTimings = {
    nav: { ttfb: 120, domContentLoaded: 900, load: 1500, type: 'navigate', protocol: 'h2', redirects: 0, transferSize: 3000, serverTiming: ['db 80 ms'] },
    fcp: 800,
    lcp: { time: 1400, element: '<img.hero>', url: 'http://localhost:3000/hero.jpg', ref: 'e4' },
    cls: { value: 0.12, shifts: 2, largest: { value: 0.1, time: 1200, source: '<div#banner>' } },
    interactions: { slowest: { event: 'click', target: '<button> "Save"', duration: 320, inputDelay: 10, processing: 290, presentation: 20, time: 5000 }, slow: 2 },
    longTasks: { count: 3, total: 640, longest: 320, longestAt: 900, blocking: 490 },
    scripts: [{ source: 'http://localhost:3000/app.js', invoker: 'BUTTON#save.onclick', duration: 290 }],
    renderBlocking: [{ url: 'http://localhost:3000/styles.css', duration: 120 }],
    resources: { count: 5, transferred: 434_000 },
  };
  const network = summarizeNetwork(
    [entry(2, { requestId: 'L1', type: 'Document', url: 'http://localhost:3000/', size: 3000 }), entry(3, { url: 'http://localhost:3000/app.js', size: 400_000, end: 1.3 })],
    'L1',
    'http://localhost:3000/',
  );

  it('puts the numbers in a few lines, and says what they are good for', () => {
    const text = formatPerf({ tabId: 'tab-1', url: 'http://localhost:3000/', browser: 'Chromium 150', loadedAgo: 4000, reloaded: false, background: false, timings, network });
    expect(text).toContain('Performance of tab-1: http://localhost:3000/ (loaded 4.0 s ago, h2).');
    expect(text).toContain('Load: TTFB 120 ms, FCP 800 ms, DOMContentLoaded 900 ms, load 1.5 s, LCP 1.4 s (<img.hero> [ref=e4] http://localhost:3000/hero.jpg).');
    expect(text).toContain('Server timing: db 80 ms.');
    expect(text).toContain('Layout shift (CLS): 0.120 from 2 shifts; largest shift 0.100 at 1.2 s moving <div#banner>.');
    expect(text).toContain('Interactions: slowest click on <button> "Save" took 320 ms (input delay 10 ms, handlers 290 ms, until painted 20 ms)');
    expect(text).toContain('Main thread: 3 long tasks (over 50 ms), 640 ms in total, longest 320 ms at 900 ms; blocking time 490 ms.');
    expect(text).toContain('Slow scripts (in long frames): http://localhost:3000/app.js (BUTTON#save.onclick) 290 ms.');
    expect(text).toContain('Network: 2 requests, 403.0 kB transferred;');
    expect(text).toContain('Largest: r3 /app.js 400.0 kB');
    expect(text).toContain('Render-blocking: /styles.css 120 ms.');
    expect(text).toMatch(/not comparable with Lighthouse scores or field Core Web Vitals/);
    expect(text.length).toBeLessThan(2000);
  });

  it('does not report paint-bound interaction times of a background tab as INP', () => {
    const text = formatPerf({ tabId: 'tab-1', url: 'http://localhost:3000/', browser: 'Chromium 150', reloaded: false, background: true, timings, network });
    expect(text).toContain('INP cannot be read here');
    expect(text).not.toContain('INP is at least');
  });

  it('says when a background tab has not reported its interactions yet', () => {
    const text = formatPerf({ tabId: 'tab-1', url: 'http://localhost:3000/', browser: 'Chromium 150', reloaded: false, background: true, timings: { ...timings, interactions: { slow: 0, hadInput: true } }, network });
    expect(text).toContain('Interactions: not reported yet.');
    expect(text).toContain('browser_show_tab');
  });

  it('falls back to resource timing when the network log started late', () => {
    const late = summarizeNetwork([entry(3, { url: 'http://localhost:3000/app.js' })], 'L1', 'http://localhost:3000/');
    const text = formatPerf({ tabId: 'tab-1', url: 'http://localhost:3000/', browser: 'Chromium 150', reloaded: false, background: false, timings, network: late });
    expect(text).toContain('Network: 6 requests, 437.0 kB transferred (from resource timing');
  });
});
