// Network and CPU throttling of a tab (part of browser_emulate): presets, parsing the agent's
// arguments, the CDP commands, and how to describe it. Pure.
//
// What was established against VS Code 1.146 (Chromium 150) through its CDP proxy:
// - `Network.emulateNetworkConditions` and `Emulation.setCPUThrottlingRate` work on an integrated
//   browser tab's page target; offline also turns `navigator.onLine` false and fires `offline`.
// - A cross-origin iframe is a separate target (and renderer process): the page target's settings do
//   not reach its requests or its scripts, so they are sent to every frame target too.
// - Neither ends with the CDP session that set it: CPU throttling stays on the renderer process (a
//   same-site frame in another tab that shares the process sees it too), and an offline tab stays
//   offline after the extension host restarts. So they are always undone explicitly (throttle.ts).

/** Network conditions as CDP takes them: latency in ms, throughput in bytes per second (-1 = unlimited). */
export interface NetworkThrottle {
  /** DevTools' name of the preset, when it is one. */
  name?: string;
  offline: boolean;
  latency: number;
  download: number;
  upload: number;
}

/** Chrome DevTools' presets (front_end/core/sdk/NetworkManager.ts), by the names it shows today. */
export const NETWORK_PRESETS = {
  offline: { name: 'Offline', offline: true, latency: 0, download: -1, upload: -1 },
  '3g': { name: '3G', offline: false, latency: 2000, download: (500 * 1000) / 8 * 0.8, upload: (500 * 1000) / 8 * 0.8 },
  'slow-4g': { name: 'Slow 4G', offline: false, latency: 562.5, download: (1.6 * 1000 * 1000) / 8 * 0.9, upload: (750 * 1000) / 8 * 0.9 },
  'fast-4g': { name: 'Fast 4G', offline: false, latency: 165, download: (9 * 1000 * 1000) / 8 * 0.9, upload: (1.5 * 1000 * 1000) / 8 * 0.9 },
} as const satisfies Record<string, NetworkThrottle>;

/** Older DevTools names for the same presets. */
const ALIASES: Record<string, keyof typeof NETWORK_PRESETS> = { 'slow-3g': '3g', 'fast-3g': 'slow-4g' };

export const MAX_CPU_RATE = 20;

/**
 * Parses browser_emulate's `network`: a preset ("offline", "3g", "slow-4g", "fast-4g", also "slow-3g",
 * "fast-3g", spaces or case as DevTools writes them), "none"/"" (no throttling), or explicit numbers
 * "<download kbit/s>/<upload kbit/s>/<latency ms>". Returns undefined for no throttling; throws an
 * Error with a message for the agent.
 */
export function parseNetwork(value: string): NetworkThrottle | undefined {
  const v = value.trim().toLowerCase().replace(/\s+/g, '-');
  if (v === '' || v === 'none' || v === 'online' || v === 'no-throttling') return undefined;
  const preset = NETWORK_PRESETS[(ALIASES[v] ?? v) as keyof typeof NETWORK_PRESETS];
  if (preset) return { ...preset };
  const m = /^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/.exec(v);
  if (!m) throw new Error(`network "${value}" is not known: use offline, 3g, slow-4g, fast-4g, none, or "<download kbit/s>/<upload kbit/s>/<latency ms>" such as "1600/750/150".`);
  const [down, up, latency] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (down <= 0 || up <= 0) throw new Error('network download and upload must be above 0 kbit/s (use "offline" for no connection).');
  if (latency > 60_000) throw new Error('network latency must be at most 60000 ms.');
  return { offline: false, latency, download: (down * 1000) / 8, upload: (up * 1000) / 8 };
}

/** Validates browser_emulate's `cpu`: 1 ends it (undefined), up to MAX_CPU_RATE. */
export function parseCpu(rate: number): number | undefined {
  if (!Number.isFinite(rate) || rate < 1 || rate > MAX_CPU_RATE) throw new Error(`cpu must be a slowdown factor between 1 (none) and ${MAX_CPU_RATE}, e.g. 4 or 6.`);
  return rate === 1 ? undefined : Math.round(rate * 10) / 10;
}

const kbit = (bytesPerSecond: number) => {
  const k = (bytesPerSecond * 8) / 1000;
  return k >= 1000 ? `${Math.round(k / 100) / 10} Mbit/s` : `${Math.round(k)} kbit/s`;
};

/** "Slow 4G network (1.4 Mbit/s down, 675 kbit/s up, 563 ms latency)", "offline". */
export function describeNetwork(n: NetworkThrottle): string {
  if (n.offline) return 'offline';
  return `${n.name ? `${n.name} network` : 'throttled network'} (${kbit(n.download)} down, ${kbit(n.upload)} up, ${Math.round(n.latency)} ms latency)`;
}

/** For labels: "offline", "Slow 4G", "1.6 Mbit/s". */
export function shortNetwork(n: NetworkThrottle): string {
  return n.offline ? 'offline' : (n.name ?? kbit(n.download));
}

export const describeCpu = (rate: number) => `CPU ${rate}× slower`;
export const shortCpu = (rate: number) => `CPU ${rate}×`;

export interface CdpStep {
  method: string;
  params: Record<string, unknown>;
  waitMs?: number;
}

const NO_THROTTLING = { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 };

export function networkStep(n: NetworkThrottle | undefined): CdpStep {
  return { method: 'Network.emulateNetworkConditions', params: n ? { offline: n.offline, latency: n.latency, downloadThroughput: n.download, uploadThroughput: n.upload } : NO_THROTTLING };
}

export function cpuStep(rate: number | undefined): CdpStep {
  return { method: 'Emulation.setCPUThrottlingRate', params: { rate: rate ?? 1 } };
}

/** The commands that undo any throttling of one target (also when the bridge does not know it set any). */
export const CLEAR_THROTTLING: CdpStep[] = [networkStep(undefined), cpuStep(undefined)];

export function sameNetwork(a: NetworkThrottle | undefined, b: NetworkThrottle | undefined): boolean {
  if (!a || !b) return a === b;
  return a.offline === b.offline && a.latency === b.latency && a.download === b.download && a.upload === b.upload;
}

/**
 * What a throttled measurement means, for browser_audit's performance check. `since`: when the
 * throttling started; `loadedAt`: when the measured page load started (both ms since epoch).
 */
export function throttlingNote(t: { network?: NetworkThrottle; cpu?: number; since: number }, loadedAt: number | undefined): string {
  const what = [t.network ? describeNetwork(t.network) : '', t.cpu ? describeCpu(t.cpu) : ''].filter(Boolean).join(' and ');
  const covered = loadedAt !== undefined && loadedAt >= t.since;
  return covered
    ? `Throttled (browser_emulate): ${what}. These numbers were measured under it, so expect them to be much slower than the unthrottled page.`
    : `Throttled (browser_emulate) now: ${what}, but the page loaded before that, so the load numbers are not throttled (reload: true measures a throttled load).`;
}
