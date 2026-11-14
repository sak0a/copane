// Device and media emulation of a tab: presets, how a browser_emulate call changes what is emulated,
// the CDP commands that get a tab from one state to the next, and how to describe it. Pure.
//
// What VS Code does with these commands (1.146, `browserViewEmulator.ts`): it intercepts
// `Emulation.setDeviceMetricsOverride`, `clearDeviceMetricsOverride` and a bare-string
// `setUserAgentOverride` from any CDP client and folds them into its own device profile, which shows
// the browser's device toolbar (dimensions, DPR, scale) to the user, who can change or close it.
// Everything else (`setEmulatedMedia`, `setTimezoneOverride`, `setLocaleOverride`, a user agent
// override with `acceptLanguage`) passes through to Chromium as an override of our own CDP session:
// invisible in VS Code, and gone when that session closes.
// Network and CPU throttling (throttleLogic.ts) also pass through, but outlive the session.
import { cpuStep, describeCpu, describeNetwork, networkStep, parseCpu, parseNetwork, sameNetwork, shortCpu, shortNetwork, type NetworkThrottle } from './throttleLogic';

export interface DeviceSettings {
  /** Preset name, when the device is exactly a preset (possibly turned to landscape). */
  name?: string;
  /** CSS px; undefined = fit the editor. */
  width?: number;
  height?: number;
  /** undefined = the screen's own. */
  deviceScaleFactor?: number;
  /** Mobile viewport, touch input, coarse pointer. */
  mobile?: boolean;
  userAgent?: string;
}

export interface EmulationSettings {
  device?: DeviceSettings;
  colorScheme?: 'light' | 'dark';
  reducedMotion?: boolean;
  /** BCP 47, e.g. "de-DE". */
  locale?: string;
  /** IANA, e.g. "Asia/Tokyo". */
  timezone?: string;
  /** Network throttling or offline (page and frame targets). */
  network?: NetworkThrottle;
  /** CPU slowdown factor, > 1 (page and frame targets). */
  cpu?: number;
}

export interface EmulateArgs {
  preset?: PresetId;
  width?: number;
  height?: number;
  deviceScaleFactor?: number;
  mobile?: boolean;
  landscape?: boolean;
  colorScheme?: 'light' | 'dark' | 'auto';
  reducedMotion?: boolean;
  locale?: string;
  timezone?: string;
  /** A preset, "none", or "<down kbit/s>/<up kbit/s>/<latency ms>" (throttleLogic.ts). */
  network?: string;
  /** Slowdown factor; 1 ends it. */
  cpu?: number;
  reset?: boolean;
}

const IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

/** The same devices VS Code offers in "Emulate Device...", plus two desktop sizes. */
export const PRESETS = {
  'iphone-15-pro': { name: 'iPhone 15 Pro', width: 393, height: 852, deviceScaleFactor: 3, mobile: true, userAgent: IOS_UA },
  'iphone-se': { name: 'iPhone SE', width: 375, height: 667, deviceScaleFactor: 2, mobile: true, userAgent: IOS_UA },
  'pixel-8': {
    name: 'Pixel 8',
    width: 412,
    height: 915,
    deviceScaleFactor: 2.625,
    mobile: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  },
  'ipad-mini': {
    name: 'iPad Mini',
    width: 768,
    height: 1024,
    deviceScaleFactor: 2,
    mobile: true,
    userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  },
  laptop: { name: 'Laptop', width: 1366, height: 768, deviceScaleFactor: 1, mobile: false },
  desktop: { name: 'Desktop', width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false },
} as const satisfies Record<string, DeviceSettings & { name: string }>;

export type PresetId = keyof typeof PRESETS | 'none';
export const PRESET_IDS = [...Object.keys(PRESETS), 'none'] as unknown as [PresetId, ...PresetId[]];

export const MIN_SIZE = 50;
export const MAX_SIZE = 4000;

/** Applies a browser_emulate call to the current settings. Throws an Error with a message for the agent on bad input. */
export function mergeEmulation(current: EmulationSettings, args: EmulateArgs): EmulationSettings {
  const next: EmulationSettings = args.reset ? {} : { ...current, device: current.device && { ...current.device } };
  if (args.preset === 'none') next.device = undefined;
  else if (args.preset) next.device = { ...PRESETS[args.preset] };

  const custom = args.width !== undefined || args.height !== undefined || args.deviceScaleFactor !== undefined || args.mobile !== undefined;
  if (custom) {
    const device: DeviceSettings = { ...(next.device ?? {}) };
    if (args.width !== undefined) device.width = checkSize('width', args.width);
    if (args.height !== undefined) device.height = checkSize('height', args.height);
    if (args.deviceScaleFactor !== undefined) {
      if (!(args.deviceScaleFactor > 0 && args.deviceScaleFactor <= 8)) throw new Error('deviceScaleFactor must be between 0 and 8.');
      device.deviceScaleFactor = args.deviceScaleFactor;
    }
    if (args.mobile !== undefined) device.mobile = args.mobile;
    if (device.name && !matchesPreset(device)) device.name = undefined;
    next.device = device;
  }
  if (args.landscape !== undefined) {
    const d = next.device;
    if (!d || d.width === undefined || d.height === undefined) throw new Error('landscape needs a device size: pass a preset or width and height.');
    if (args.landscape !== d.width > d.height) next.device = { ...d, width: d.height, height: d.width };
  }

  if (args.colorScheme !== undefined) next.colorScheme = args.colorScheme === 'auto' ? undefined : args.colorScheme;
  if (args.reducedMotion !== undefined) next.reducedMotion = args.reducedMotion || undefined;
  if (args.locale !== undefined) next.locale = args.locale.trim() ? checkLocale(args.locale.trim()) : undefined;
  if (args.timezone !== undefined) next.timezone = args.timezone.trim() ? checkTimezone(args.timezone.trim()) : undefined;
  if (args.network !== undefined) next.network = parseNetwork(args.network);
  if (args.cpu !== undefined) next.cpu = parseCpu(args.cpu);
  return next;
}

function checkSize(what: string, value: number): number {
  if (!Number.isFinite(value) || value < MIN_SIZE || value > MAX_SIZE) throw new Error(`${what} must be between ${MIN_SIZE} and ${MAX_SIZE} CSS px.`);
  return Math.round(value);
}

function matchesPreset(device: DeviceSettings): boolean {
  const preset = Object.values(PRESETS).find(p => p.name === device.name) as DeviceSettings | undefined;
  if (!preset) return false;
  const portrait = (w?: number, h?: number) => (w !== undefined && h !== undefined && w > h ? [h, w] : [w, h]);
  const [pw, ph] = portrait(preset.width, preset.height);
  const [dw, dh] = portrait(device.width, device.height);
  return pw === dw && ph === dh && preset.deviceScaleFactor === device.deviceScaleFactor && !!preset.mobile === !!device.mobile;
}

export function checkLocale(locale: string): string {
  try {
    const [canonical] = Intl.getCanonicalLocales(locale);
    if (canonical) return canonical;
  } catch {
    // fall through
  }
  throw new Error(`"${locale}" is not a valid locale; use a BCP 47 tag such as "en-US" or "de-DE".`);
}

export function checkTimezone(timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: timezone }).resolvedOptions().timeZone;
  } catch {
    throw new Error(`"${timezone}" is not a known time zone; use an IANA name such as "America/New_York" or "Asia/Tokyo".`);
  }
}

export function isEmulating(s: EmulationSettings | undefined): boolean {
  return !!s && (!!s.device || !!s.colorScheme || !!s.reducedMotion || !!s.locale || !!s.timezone || !!s.network || !!s.cpu);
}

export function isThrottling(s: EmulationSettings | undefined): boolean {
  return !!s && (!!s.network || !!s.cpu);
}

export interface CdpStep {
  method: string;
  params: Record<string, unknown>;
  /** Wait this long after the command, for VS Code to lay out the editor again. */
  waitMs?: number;
}

/** `Accept-Language` for a locale: "de-DE" → "de-DE,de". */
export function acceptLanguage(locale: string): string {
  const base = locale.split('-')[0]!;
  return base && base !== locale ? `${locale},${base}` : locale;
}

/**
 * The CDP commands that change a tab's emulation from `prev` to `next`. With `sessionOnly`, only the
 * overrides that live in our CDP session (after re-attaching, when VS Code still has the device).
 * `baseUserAgent` is the tab's user agent without our overrides, needed to send Accept-Language.
 */
export function emulationSteps(prev: EmulationSettings, next: EmulationSettings, options: { baseUserAgent?: string; sessionOnly?: boolean } = {}): CdpStep[] {
  const steps: CdpStep[] = [];
  const pd = prev.device;
  const nd = next.device;
  if (!options.sessionOnly && !sameDevice(pd, nd)) {
    if (nd) {
      steps.push({
        method: 'Emulation.setDeviceMetricsOverride',
        params: { width: nd.width ?? 0, height: nd.height ?? 0, deviceScaleFactor: nd.deviceScaleFactor ?? 0, mobile: !!nd.mobile },
      });
      if (nd.userAgent !== pd?.userAgent) steps.push({ method: 'Emulation.setUserAgentOverride', params: { userAgent: nd.userAgent ?? '' } });
    } else {
      if (pd?.userAgent) steps.push({ method: 'Emulation.setUserAgentOverride', params: { userAgent: '' } });
      // VS Code keeps scaling input coordinates by the last fit-to-editor scale after emulation ends,
      // so clicks by coordinates would land in the wrong place. A device without a size fits the editor
      // at scale 1; once that layout has reached VS Code, clearing leaves the scale at 1.
      steps.push({ method: 'Emulation.setDeviceMetricsOverride', params: { width: 0, height: 0, deviceScaleFactor: 0, mobile: false }, waitMs: 400 });
      steps.push({ method: 'Emulation.clearDeviceMetricsOverride', params: {} });
    }
  }
  if (prev.colorScheme !== next.colorScheme || !!prev.reducedMotion !== !!next.reducedMotion || (options.sessionOnly && (next.colorScheme || next.reducedMotion))) {
    const features: Array<{ name: string; value: string }> = [];
    if (next.colorScheme) features.push({ name: 'prefers-color-scheme', value: next.colorScheme });
    if (next.reducedMotion) features.push({ name: 'prefers-reduced-motion', value: 'reduce' });
    steps.push({ method: 'Emulation.setEmulatedMedia', params: { features } });
  }
  if (prev.timezone !== next.timezone || (options.sessionOnly && next.timezone)) {
    steps.push({ method: 'Emulation.setTimezoneOverride', params: { timezoneId: next.timezone ?? '' } });
  }
  const userAgentChanged = pd?.userAgent !== nd?.userAgent;
  if (prev.locale !== next.locale || (next.locale && userAgentChanged) || (options.sessionOnly && next.locale)) {
    steps.push({ method: 'Emulation.setLocaleOverride', params: next.locale ? { locale: next.locale } : {} });
    // navigator.language and the Accept-Language header. Passing acceptLanguage keeps VS Code from
    // folding this into its device profile; an empty user agent and language remove the override.
    const userAgent = nd?.userAgent ?? options.baseUserAgent ?? '';
    steps.push({
      method: 'Emulation.setUserAgentOverride',
      params: next.locale && userAgent ? { userAgent, acceptLanguage: acceptLanguage(next.locale) } : { userAgent: '', acceptLanguage: '' },
    });
  }
  // Throttling of the page target; frame targets get the same commands (throttle.ts).
  if (!sameNetwork(prev.network, next.network) || (options.sessionOnly && next.network)) steps.push(networkStep(next.network));
  if (prev.cpu !== next.cpu || (options.sessionOnly && next.cpu)) steps.push(cpuStep(next.cpu));
  return steps;
}

function sameDevice(a: DeviceSettings | undefined, b: DeviceSettings | undefined): boolean {
  if (!a || !b) return a === b;
  return a.width === b.width && a.height === b.height && a.deviceScaleFactor === b.deviceScaleFactor && !!a.mobile === !!b.mobile && a.userAgent === b.userAgent;
}

/** "iPhone 15 Pro (393×852 CSS px at 3×, mobile with touch), dark colour scheme, time zone Asia/Tokyo". */
export function describeEmulation(s: EmulationSettings): string {
  const parts: string[] = [];
  const d = s.device;
  if (d) {
    const size = d.width && d.height ? `${d.width}×${d.height} CSS px` : d.width ? `${d.width} CSS px wide` : d.height ? `${d.height} CSS px tall` : 'editor-sized viewport';
    const details = [size + (d.deviceScaleFactor ? ` at ${d.deviceScaleFactor}×` : ''), d.mobile ? 'mobile with touch' : '', d.userAgent && !d.name ? 'custom user agent' : ''].filter(Boolean).join(', ');
    const landscape = d.name && d.width !== undefined && d.height !== undefined && d.width > d.height && d.mobile ? ' landscape' : '';
    parts.push(d.name ? `${d.name}${landscape} (${details})` : details);
  }
  if (s.colorScheme) parts.push(`${s.colorScheme} colour scheme`);
  if (s.reducedMotion) parts.push('reduced motion');
  if (s.locale) parts.push(`locale ${s.locale}`);
  if (s.timezone) parts.push(`time zone ${s.timezone}`);
  if (s.network) parts.push(describeNetwork(s.network));
  if (s.cpu) parts.push(describeCpu(s.cpu));
  return parts.join(', ') || 'nothing';
}

/** A short label for views and tooltips: "iPhone 15 Pro · dark", "800×600 · de-DE". */
export function shortEmulationLabel(s: EmulationSettings): string {
  const d = s.device;
  const parts = [
    d ? (d.name ?? (d.width && d.height ? `${d.width}×${d.height}` : 'device')) : '',
    s.colorScheme ?? '',
    s.reducedMotion ? 'reduced motion' : '',
    s.locale ?? '',
    s.timezone ?? '',
    s.network ? shortNetwork(s.network) : '',
    s.cpu ? shortCpu(s.cpu) : '',
  ];
  return parts.filter(Boolean).join(' · ');
}
