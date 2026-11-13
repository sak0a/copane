import { describe, expect, it } from 'vitest';
import { acceptLanguage, describeEmulation, emulationSteps, isEmulating, mergeEmulation, PRESETS, shortEmulationLabel } from '../../src/extension/browser/page/emulationLogic';
import { imageSize } from '../../src/extension/browser/page/imageSize';

describe('mergeEmulation', () => {
  it('applies a preset with its size, scale, mobile flag and user agent', () => {
    const s = mergeEmulation({}, { preset: 'iphone-15-pro' });
    expect(s.device).toMatchObject({ name: 'iPhone 15 Pro', width: 393, height: 852, deviceScaleFactor: 3, mobile: true });
    expect(s.device?.userAgent).toMatch(/iPhone/);
  });

  it('changes only what a call passes', () => {
    const a = mergeEmulation({}, { preset: 'pixel-8', colorScheme: 'dark' });
    const b = mergeEmulation(a, { timezone: 'Asia/Tokyo' });
    expect(b).toMatchObject({ colorScheme: 'dark', timezone: 'Asia/Tokyo' });
    expect(b.device?.name).toBe('Pixel 8');
    expect(mergeEmulation(b, { colorScheme: 'auto' }).colorScheme).toBeUndefined();
    expect(mergeEmulation(b, { timezone: '' }).timezone).toBeUndefined();
  });

  it('drops the preset name once its size is changed, and keeps it for landscape', () => {
    const custom = mergeEmulation({}, { preset: 'iphone-se', width: 400 });
    expect(custom.device).toMatchObject({ width: 400, height: 667, mobile: true });
    expect(custom.device?.name).toBeUndefined();
    const landscape = mergeEmulation({}, { preset: 'iphone-se', landscape: true });
    expect(landscape.device).toMatchObject({ name: 'iPhone SE', width: 667, height: 375 });
    expect(describeEmulation(landscape)).toMatch(/^iPhone SE landscape \(667×375/);
    expect(mergeEmulation(landscape, { landscape: false }).device).toMatchObject({ width: 375, height: 667 });
  });

  it('"none" ends the device but keeps media settings; reset ends everything', () => {
    const s = mergeEmulation({}, { preset: 'ipad-mini', reducedMotion: true });
    expect(mergeEmulation(s, { preset: 'none' })).toEqual({ reducedMotion: true, device: undefined });
    expect(isEmulating(mergeEmulation(s, { reset: true }))).toBe(false);
    expect(mergeEmulation(s, { reset: true, colorScheme: 'light' })).toEqual({ colorScheme: 'light' });
  });

  it('rejects bad sizes, locales and time zones with a message for the agent', () => {
    expect(() => mergeEmulation({}, { width: 10 })).toThrow(/between 50 and 4000/);
    expect(() => mergeEmulation({}, { locale: 'not a locale!' })).toThrow(/BCP 47/);
    expect(() => mergeEmulation({}, { timezone: 'Mars/Olympus' })).toThrow(/IANA/);
    expect(() => mergeEmulation({}, { landscape: true })).toThrow(/needs a device size/);
    expect(mergeEmulation({}, { locale: 'de-de' }).locale).toBe('de-DE');
  });
});

describe('emulationSteps', () => {
  const methods = (steps: Array<{ method: string }>) => steps.map(s => s.method);

  it('sets the device through VS Code (metrics and a bare user agent) and media through the session', () => {
    const next = mergeEmulation({}, { preset: 'iphone-15-pro', colorScheme: 'dark', reducedMotion: true });
    const steps = emulationSteps({}, next);
    expect(steps[0]).toEqual({ method: 'Emulation.setDeviceMetricsOverride', params: { width: 393, height: 852, deviceScaleFactor: 3, mobile: true } });
    expect(steps[1]).toEqual({ method: 'Emulation.setUserAgentOverride', params: { userAgent: PRESETS['iphone-15-pro'].userAgent } });
    expect(steps[2]).toEqual({
      method: 'Emulation.setEmulatedMedia',
      params: { features: [{ name: 'prefers-color-scheme', value: 'dark' }, { name: 'prefers-reduced-motion', value: 'reduce' }] },
    });
  });

  it('ends a device by first fitting the editor at scale 1, then clearing', () => {
    const prev = mergeEmulation({}, { preset: 'pixel-8' });
    const steps = emulationSteps(prev, {});
    expect(methods(steps)).toEqual(['Emulation.setUserAgentOverride', 'Emulation.setDeviceMetricsOverride', 'Emulation.clearDeviceMetricsOverride']);
    expect(steps[0]!.params).toEqual({ userAgent: '' });
    expect(steps[1]!.params).toEqual({ width: 0, height: 0, deviceScaleFactor: 0, mobile: false });
    expect(steps[1]!.waitMs).toBeGreaterThan(0);
  });

  it('sends locale with Accept-Language on the device or base user agent, and clears both', () => {
    const steps = emulationSteps({}, { locale: 'de-DE' }, { baseUserAgent: 'UA/1' });
    expect(steps).toEqual([
      { method: 'Emulation.setLocaleOverride', params: { locale: 'de-DE' } },
      { method: 'Emulation.setUserAgentOverride', params: { userAgent: 'UA/1', acceptLanguage: 'de-DE,de' } },
    ]);
    const withDevice = mergeEmulation({ locale: 'de-DE' }, { preset: 'iphone-se' });
    expect(emulationSteps({ locale: 'de-DE' }, withDevice, { baseUserAgent: 'UA/1' }).at(-1)!.params).toEqual({ userAgent: PRESETS['iphone-se'].userAgent, acceptLanguage: 'de-DE,de' });
    expect(emulationSteps({ locale: 'de-DE' }, {}, { baseUserAgent: 'UA/1' }).at(-1)!.params).toEqual({ userAgent: '', acceptLanguage: '' });
  });

  it('re-applies only session overrides after re-attaching', () => {
    const s = mergeEmulation({}, { preset: 'iphone-se', colorScheme: 'light', timezone: 'Europe/Paris' });
    expect(methods(emulationSteps({}, s, { sessionOnly: true }))).toEqual(['Emulation.setEmulatedMedia', 'Emulation.setTimezoneOverride']);
  });

  it('sends nothing when nothing changes', () => {
    const s = mergeEmulation({}, { preset: 'laptop', colorScheme: 'dark' });
    expect(emulationSteps(s, mergeEmulation(s, {}))).toEqual([]);
  });
});

describe('describing emulation', () => {
  it('reads naturally', () => {
    const s = mergeEmulation({}, { preset: 'iphone-15-pro', colorScheme: 'dark', locale: 'ja-JP', timezone: 'Asia/Tokyo' });
    expect(describeEmulation(s)).toBe('iPhone 15 Pro (393×852 CSS px at 3×, mobile with touch), dark colour scheme, locale ja-JP, time zone Asia/Tokyo');
    expect(shortEmulationLabel(s)).toBe('iPhone 15 Pro · dark · ja-JP · Asia/Tokyo');
    expect(describeEmulation(mergeEmulation({}, { width: 800, height: 600 }))).toBe('800×600 CSS px');
    expect(acceptLanguage('en')).toBe('en');
  });
});

describe('imageSize', () => {
  it('reads PNG and JPEG headers', () => {
    const png = Buffer.alloc(33);
    png.writeUInt32BE(0x89504e47, 0);
    png.write('IHDR', 12, 'ascii');
    png.writeUInt32BE(393, 16);
    png.writeUInt32BE(852, 20);
    expect(imageSize(png)).toEqual({ width: 393, height: 852 });
    // SOI, an APP0 segment of length 4, then SOF0 with height 600 and width 800.
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20, 0x03, 0, 0, 0, 0, 0, 0]);
    expect(imageSize(jpeg)).toEqual({ width: 800, height: 600 });
    expect(imageSize(Buffer.from('not an image'))).toBeUndefined();
  });
});
