// The texts of browser_check_change: what the baseline recorded, what changed after the update, and
// what to do when nothing arrived. Pure.
import type { SettleBlocker } from './changeLogic';
import { percent, type Region } from './imageDiff';
import { clip, formatMs } from './ringBuffer';

export interface ViewState {
  width: number;
  height: number;
  scrollX: number;
  scrollY: number;
}

export interface BaselineReport {
  tabId: string;
  url: string;
  view: ViewState;
  errors: number;
  failures: number;
  /** Elements known to change on their own (a clock, polling); 0 when none are known yet. */
  selfChanging: number;
  /** Why no screenshot is kept for comparison, if none is. */
  imageProblem?: string;
  /** A dev server's error overlay on the page. */
  overlay?: { kind: string; text: string };
}

export function formatBaseline(b: BaselineReport): string {
  const parts = [
    `Baseline of ${b.tabId} taken: ${clip(b.url, 300)}, viewport ${size(b.view)} at scroll ${Math.round(b.view.scrollX)},${Math.round(b.view.scrollY)}; ${count(b.errors, 'console error')} and ${count(b.failures, 'failed request')} on this page so far (not repeated in the check).`,
  ];
  if (b.overlay) parts.push(`The page shows an error from the dev server (${b.overlay.kind}): ${sentence(clip(b.overlay.text, 400))}`);
  if (b.selfChanging) parts.push(selfChangingNote(b.selfChanging));
  if (b.imageProblem) parts.push(`Screenshots will not be compared (${b.imageProblem}).`);
  parts.push('Edit the code, then call browser_check_change with action "check".');
  return parts.join(' ');
}

export type ScreenshotOutcome =
  /** `fractionOf`: the image's geometry is unknown, so regions are in image px of an image this size, shown as fractions. */
  | { kind: 'diff'; changed: number; total: number; regions: Region[]; more: number; fractionOf?: { width: number; height: number } }
  | { kind: 'resized'; from: ViewState; to: ViewState }
  | { kind: 'skipped'; reason: string };

export interface ChangeReport {
  tabId: string;
  /** From describeUpdate. */
  update: string;
  elapsedMs: number;
  /** Formatted error lines (at most a few) and how many more there were. */
  errors: string[];
  moreErrors: number;
  failures: string[];
  moreFailures: number;
  /** After a reload: errors and failed requests the page already had at the baseline. */
  still: { errors: number; failures: number };
  /** Reported by earlier checks against this baseline, not repeated. */
  earlier: { errors: number; failures: number };
  warnings: number;
  navigated?: { from: string; to: string };
  /** An error overlay that is new since the baseline. */
  overlay?: { kind: string; text: string };
  /** What became of the overlay shown at the baseline. */
  overlayBefore?: 'still' | 'gone';
  crashed: boolean;
  screenshot?: ScreenshotOutcome;
  scrolled?: { from: ViewState; to: ViewState };
  imageAttached: boolean;
  /** The page did not settle before the time ran out: what was still going on, and for how long. */
  unsettled?: { blocker: SettleBlocker; ms: number };
  /** The dev server's client said its connection dropped. */
  devServerLost?: string;
  /** URLs of frames that loaded a new document. */
  frames: string[];
  /** Elements known to change on their own, whose changes were ignored. */
  selfChanging: number;
  /** What the screenshot's source says about the attached image (an emulated device). */
  imageNote?: string;
  /** The page did not answer for this long during the check (busy with a long script). */
  busyMs?: number;
}

export function formatChange(r: ChangeReport): string {
  if (r.crashed) {
    const lines = [`The page in ${r.tabId} crashed after the change (renderer gone). Reload it with browser_navigate {"action":"reload"} once the cause is fixed.`];
    if (r.errors.length) lines.push(`- ${count(r.errors.length + r.moreErrors, 'new error')} before the crash:`, ...r.errors.map(e => `  ${e}`), ...more(r.moreErrors, 'browser_console_messages'));
    if (r.failures.length) lines.push(`- ${count(r.failures.length + r.moreFailures, 'new failed request')} before the crash:`, ...r.failures.map(e => `  ${e}`), ...more(r.moreFailures, 'browser_network_requests'));
    if (r.devServerLost) lines.push(lostLine(r.devServerLost));
    return lines.join('\n');
  }
  const head = `Change in ${r.tabId} after ${r.update}, ${r.unsettled ? 'compared' : 'settled'} after ${formatMs(r.elapsedMs)}`;
  const diff = r.screenshot?.kind === 'diff' ? r.screenshot : undefined;
  const nothing = !r.errors.length && !r.failures.length && !r.navigated && !r.overlay && !r.overlayBefore && !r.frames.length && diff !== undefined && diff.changed === 0 && !r.still.errors && !r.still.failures;
  const tail: string[] = [];
  if (r.warnings) tail.push(`+ ${count(r.warnings, 'new warning')} (browser_console_messages shows them).`);
  if (r.selfChanging) tail.push(`Note: ${selfChangingNote(r.selfChanging)}`);
  if (r.unsettled) tail.push(unsettledNote(r.unsettled));
  if (r.busyMs) tail.push(`Note: the page was busy (not answering) for ${formatMs(r.busyMs)} after the update: a long-running script, which users feel as a frozen page.`);
  if (r.imageNote && r.imageAttached) tail.push(`About the after-screenshot: ${r.imageNote}`);
  if (nothing) {
    const lines = [`${head}: no new errors or failed requests, and the screenshot is unchanged. The edit does not show in this view (other route or state?), or it did not apply.`];
    if (r.earlier.errors || r.earlier.failures) lines.push(earlierLine(r.earlier));
    if (r.scrolled) lines.push(scrollLine(r.scrolled));
    if (r.devServerLost) lines.push(lostLine(r.devServerLost));
    return [...lines, ...tail].join('\n');
  }
  const lines = [`${head}:`];
  if (r.errors.length) lines.push(`- ${count(r.errors.length + r.moreErrors, 'new error')}:`, ...r.errors.map(e => `  ${e}`), ...more(r.moreErrors, 'browser_console_messages'));
  if (r.failures.length === 1 && !r.moreFailures) lines.push(`- 1 new failed request: ${r.failures[0]}`);
  else if (r.failures.length) lines.push(`- ${count(r.failures.length + r.moreFailures, 'new failed request')}:`, ...r.failures.map(e => `  ${e}`), ...more(r.moreFailures, 'browser_network_requests'));
  if (!r.errors.length && !r.failures.length) lines.push('- No new errors or failed requests.');
  if (r.navigated) lines.push(`- Navigated: ${clip(r.navigated.from, 300)} → ${clip(r.navigated.to, 300)}`);
  for (const url of r.frames.slice(0, 3)) lines.push(`- The frame ${clip(url, 200)} loaded a new document.`);
  if (r.overlay) lines.push(`- Error shown in the page by the dev server (${r.overlay.kind}): ${sentence(clip(r.overlay.text, 400))} Fix the cause; the overlay goes away with the next update that works.`);
  if (r.overlayBefore === 'still') lines.push('- The error overlay shown at the baseline is still shown.');
  if (r.overlayBefore === 'gone') lines.push('- The error overlay shown at the baseline is gone.');
  if (r.still.errors || r.still.failures) {
    const what = [r.still.errors ? `${count(r.still.errors, 'error')} (same text)` : '', r.still.failures ? count(r.still.failures, 'failed request') : ''].filter(Boolean).join(' and ');
    lines.push(`- Still there from before the change: ${what}.`);
  }
  if (r.earlier.errors || r.earlier.failures) lines.push(earlierLine(r.earlier));
  if (r.devServerLost) lines.push(lostLine(r.devServerLost));
  if (r.screenshot) lines.push(screenshotLine(r.screenshot, r.imageAttached));
  if (r.scrolled) lines.push(scrollLine(r.scrolled));
  return [...lines, ...tail].join('\n');
}

export interface TimeoutReport {
  tabId: string;
  timeoutMs: number;
  /** Time since the baseline, or since the last check when there was one. */
  sinceMs: number;
  since: 'baseline' | 'last check';
  /** Elements known to change on their own. */
  selfChanging: number;
  /** Changed elements not counted yet: they might still turn out to change on their own. */
  pendingDom: number;
  /** The page has frames (changes inside them count only when the frame reloads). */
  hasFrames: boolean;
  devServerLost?: string;
}

export function formatTimeout(t: TimeoutReport): string {
  const lines = [
    `No update reached ${t.tabId} within ${formatMs(t.timeoutMs)} (no hot update, reload, DOM change or error since the ${t.since} ${formatMs(t.sinceMs)} ago). If the edit should show here: is the dev server running and watching that file (check its terminal)? A page without hot reload needs check with reload: true.`,
  ];
  if (t.pendingDom) lines.push(`${count(t.pendingDom, 'element')} changed but ${t.pendingDom === 1 ? 'is' : 'are'} not counted yet: a change counts once it has not repeated for 5 s (to tell it from a clock or polling). Check again in a few seconds.`);
  if (t.selfChanging) lines.push(selfChangingNote(t.selfChanging));
  if (t.hasFrames) lines.push('Changes inside frames are only seen when the frame reloads.');
  if (t.devServerLost) lines.push(lostLine(t.devServerLost));
  return lines.join('\n');
}

/** The dev server rebuilt without a change, and nothing else happened. */
export function formatNoUpdate(r: { tabId: string; how: 'nothing' | 'silent'; line: string; elapsedMs: number }): string {
  const what =
    r.how === 'nothing'
      ? `the dev server rebuilt, but nothing changed ("${clip(r.line, 120)}")`
      : `the dev server started a rebuild ("${clip(r.line, 120)}") and reported no update for 5 s, which is what webpack-dev-server 6 does when nothing changed`;
  return `No update in ${r.tabId} after ${formatMs(r.elapsedMs)}: ${what}. The edit did not change the bundle: was the file saved with a change, and does this page import it?`;
}

/** The tab stopped answering during the check. */
export function formatStuck(r: { tabId: string; step: string; waitedMs: number; update?: string; errors: string[]; failures: string[] }): string {
  const lines = [
    `${r.tabId} did not respond while ${r.step} (waited ${formatMs(r.waitedMs)}): it may be stuck in a long-running script, or VS Code is not drawing it right now. Try again; bring it to the front with browser_tab {"action":"show"}, or reload it with browser_navigate {"action":"reload"} if it stays stuck.`,
  ];
  if (r.update) lines.push(`- Seen before that: ${r.update}.`);
  if (r.errors.length) lines.push(`- Seen before that: ${count(r.errors.length, 'new error')}:`, ...r.errors.map(e => `  ${e}`));
  if (r.failures.length) lines.push(`- Seen before that: ${count(r.failures.length, 'new failed request')}:`, ...r.failures.map(e => `  ${e}`));
  return lines.join('\n');
}

function selfChangingNote(n: number): string {
  return `The page changes on its own (${count(n, 'element')} keep${n === 1 ? 's' : ''} changing: a clock, an animation or polling); those changes do not count as an update (the screenshot regions may still include them), and other DOM changes count once they have not repeated for 5 s.`;
}

function screenshotLine(s: ScreenshotOutcome, attached: boolean): string {
  const image = attached ? ' After-screenshot attached.' : '';
  if (s.kind === 'resized') return `- Viewport changed size (${size(s.from)} → ${size(s.to)}), so the screenshots are not compared.${image}`;
  if (s.kind === 'skipped') return `- Screenshots not compared (${s.reason}).${image}`;
  if (s.changed === 0) return `- Screenshot unchanged.${image}`;
  const n = s.regions.length + s.more;
  const f = s.fractionOf;
  const at = (v: number, of: number) => `${Math.round((v / of) * 100)}%`;
  const boxes = s.regions
    .map(r => (f ? `x ${at(r.x, f.width)}–${at(r.x + r.width, f.width)} y ${at(r.y, f.height)}–${at(r.y + r.height, f.height)}` : `x ${r.x}–${r.x + r.width} y ${r.y}–${r.y + r.height}`) + (n > 1 ? ` (${percent(r.changed, s.total)})` : ''))
    .join('; ');
  const smaller = s.more ? `; and ${s.more} smaller` : '';
  const units = f ? "fractions of the image's width and height; how it maps to the viewport is not known" : 'viewport CSS px';
  return `- Screenshot: ${percent(s.changed, s.total)} changed in ${count(n, 'region')} (${units}): ${boxes}${smaller}.${image}`;
}

function scrollLine(s: { from: ViewState; to: ViewState }): string {
  return `- Scrolled from ${Math.round(s.from.scrollX)},${Math.round(s.from.scrollY)} to ${Math.round(s.to.scrollX)},${Math.round(s.to.scrollY)} since the baseline; the regions include that shift.`;
}

function earlierLine(e: { errors: number; failures: number }): string {
  const what = [e.errors ? count(e.errors, 'error') : '', e.failures ? count(e.failures, 'failed request') : ''].filter(Boolean).join(' and ');
  return `- Reported by an earlier check of this baseline, not repeated: ${what}.`;
}

function lostLine(line: string): string {
  return `- The dev server connection was lost (${clip(line, 120)}): is it still running?`;
}

function unsettledNote(u: { blocker: SettleBlocker; ms: number }): string {
  const t = formatMs(u.ms);
  switch (u.blocker) {
    case 'dom':
      return `Note: the page kept changing for ${t} after the update (animation, polling or a live feed); the comparison includes those changes.`;
    case 'network':
      return `Note: requests were still running ${t} after the update; what they bring is not in this comparison.`;
    case 'loading':
      return `Note: the page was still loading ${t} after the update; check again for the final state.`;
    case 'hmr':
      return `Note: the hot update had not completed ${t} after it started; check again for the final state.`;
  }
}

function more(n: number, tool: string): string[] {
  return n > 0 ? [`  +${n} more (${tool} shows them)`] : [];
}

/** Ends the text with a full stop unless it ends with punctuation already. */
function sentence(t: string): string {
  return /[.!?…]$/.test(t) ? t : `${t}.`;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

function size(v: { width: number; height: number }): string {
  return `${Math.round(v.width)}×${Math.round(v.height)}`;
}
