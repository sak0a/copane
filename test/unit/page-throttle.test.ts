import { describe, expect, it } from 'vitest';
import { describeEmulation, emulationSteps, isEmulating, mergeEmulation, shortEmulationLabel } from '../../src/extension/browser/page/emulationLogic';
import { formatPerf } from '../../src/extension/browser/page/perfReport';
import { CLEAR_THROTTLING, NETWORK_PRESETS, describeNetwork, parseCpu, parseNetwork, throttlingNote } from '../../src/extension/browser/page/throttleLogic';

describe('network presets', () => {
  it('are the numbers Chrome DevTools uses, by its current and older names', () => {
    expect(parseNetwork('3g')).toMatchObject({ name: '3G', latency: 2000, download: 50_000, upload: 50_000, offline: false });
    expect(parseNetwork('Slow 3G')).toEqual(parseNetwork('3g'));
    expect(parseNetwork('slow-4g')).toMatchObject({ name: 'Slow 4G', latency: 562.5, download: 180_000, upload: 84_375 });
    expect(parseNetwork('fast-3g')).toEqual(parseNetwork('Slow 4G'));
    expect(parseNetwork('Fast 4G')).toMatchObject({ name: 'Fast 4G', latency: 165, download: 1_012_500, upload: 168_750 });
    expect(parseNetwork('offline')).toMatchObject({ offline: true });
    expect(Object.keys(NETWORK_PRESETS)).toEqual(['offline', '3g', 'slow-4g', 'fast-4g']);
  });

  it('takes explicit kbit/s and latency, and none ends it', () => {
    expect(parseNetwork('1600/750/150')).toEqual({ offline: false, latency: 150, download: 200_000, upload: 93_750 });
    expect(parseNetwork('none')).toBeUndefined();
    expect(parseNetwork('')).toBeUndefined();
    expect(() => parseNetwork('2g')).toThrow(/offline, 3g, slow-4g, fast-4g/);
    expect(() => parseNetwork('0/10/10')).toThrow(/above 0/);
    expect(describeNetwork(parseNetwork('slow-4g')!)).toBe('Slow 4G network (1.4 Mbit/s down, 675 kbit/s up, 563 ms latency)');
    expect(describeNetwork(parseNetwork('100/50/20')!)).toBe('throttled network (100 kbit/s down, 50 kbit/s up, 20 ms latency)');
  });

  it('validates the CPU factor; 1 ends it', () => {
    expect(parseCpu(4)).toBe(4);
    expect(parseCpu(1)).toBeUndefined();
    expect(() => parseCpu(0.5)).toThrow(/between 1/);
    expect(() => parseCpu(50)).toThrow(/between 1/);
  });
});

describe('throttling in browser_emulate', () => {
  const methods = (steps: Array<{ method: string }>) => steps.map(s => s.method);

  it('combines with device emulation, and each ends on its own', () => {
    const s = mergeEmulation({}, { preset: 'pixel-8', network: 'slow-4g', cpu: 4 });
    expect(describeEmulation(s)).toMatch(/^Pixel 8 .*, Slow 4G network \(.*\), CPU 4× slower$/);
    expect(shortEmulationLabel(s)).toBe('Pixel 8 · Slow 4G · CPU 4×');
    const noNet = mergeEmulation(s, { network: 'none' });
    expect(noNet.network).toBeUndefined();
    expect(noNet.cpu).toBe(4);
    expect(noNet.device?.name).toBe('Pixel 8');
    const noDevice = mergeEmulation(s, { preset: 'none' });
    expect(noDevice).toMatchObject({ cpu: 4, network: { name: 'Slow 4G' } });
    expect(isEmulating(mergeEmulation(s, { reset: true }))).toBe(false);
    expect(isEmulating(mergeEmulation({ cpu: 4 }, { cpu: 1 }))).toBe(false);
    expect(shortEmulationLabel(mergeEmulation({}, { network: 'offline' }))).toBe('offline');
  });

  it('sends network and CPU commands only when they change, and undoes them', () => {
    const on = mergeEmulation({}, { network: 'offline', cpu: 6 });
    expect(emulationSteps({}, on)).toEqual([
      { method: 'Network.emulateNetworkConditions', params: { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 } },
      { method: 'Emulation.setCPUThrottlingRate', params: { rate: 6 } },
    ]);
    expect(emulationSteps(on, mergeEmulation(on, { colorScheme: 'dark' })).map(s => s.method)).toEqual(['Emulation.setEmulatedMedia']);
    expect(emulationSteps(on, {})).toEqual(CLEAR_THROTTLING);
    // A device change alone does not touch throttling.
    expect(methods(emulationSteps(on, mergeEmulation(on, { preset: 'iphone-se' })))).not.toContain('Emulation.setCPUThrottlingRate');
    // After a new CDP connection, the session's overrides are sent again.
    expect(methods(emulationSteps({}, on, { sessionOnly: true }))).toEqual(['Network.emulateNetworkConditions', 'Emulation.setCPUThrottlingRate']);
  });

  it('a performance result says whether the numbers were throttled', () => {
    const t = { network: parseNetwork('slow-4g'), cpu: 4, since: 1000 };
    expect(throttlingNote(t, 2000)).toMatch(/^Throttled \(browser_emulate\): Slow 4G network .* and CPU 4× slower\. These numbers were measured under it/);
    expect(throttlingNote(t, 500)).toMatch(/the page loaded before that, so the load numbers are not throttled \(reload: true/);
    const base = {
      tabId: 'tab-1',
      url: 'http://x/',
      browser: 'Chromium',
      reloaded: true,
      background: false,
      timings: { interactions: { slow: 0 }, scripts: [], renderBlocking: [], resources: { count: 0, transferred: 0 } },
      network: { complete: true, requests: 0, transferred: 0, failed: 0, pending: 0, fromCache: 0, byType: [], slowest: [], largest: [], uncompressed: [] },
    };
    expect(formatPerf(base)).toMatch(/without CPU or network throttling/);
    const throttled = formatPerf({ ...base, conditions: [throttlingNote(t, 2000)] });
    expect(throttled).toMatch(/Throttled \(browser_emulate\)/);
    expect(throttled).toMatch(/with the throttling above/);
    expect(throttled).not.toMatch(/without CPU or network throttling/);
  });
});
