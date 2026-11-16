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
  /** The DOM changed while the baseline watched it for a moment. */
  churn: boolean;
  /** Why no screenshot is kept for comparison, if none is. */
  imageProblem?: string;
  /** A dev server's error overlay on the page. */
  overlay?: { kind: string; text: string };
}

export function formatBaseline(b: BaselineReport): string {
  const parts = [
    `Baseline of ${b.tabId} taken: ${clip(b.url, 300)}, viewport ${size(b.view)} at scroll ${Math.round(b.view.scrollX)},${Math.round(b.view.scrollY)}; ${count(b.errors, 'console error')} and ${count(b.failures, 'failed request')} on this page so far (not repeated in the check).`,
  ];
  if (b.overlay) parts.push(`The page shows a build error (${b.overlay.kind}): ${sentence(clip(b.overlay.text, 400))}`);
  if (b.churn) parts.push('The page changes on its own (animation or polling), so DOM changes alone will not count as the update.');
  if (b.imageProblem) parts.push(`Screenshots will not be compared (${b.imageProblem}).`);
  parts.push('Edit the code, then call browser_check_change with action "check".');
  return parts.join(' ');
}

export type ScreenshotOutcome =
  | { kind: 'diff'; changed: number; total: number; regions: Region[]; more: number }
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
}

export function formatChange(r: ChangeReport): string {
  if (r.crashed) {
    const lines = [`The page in ${r.tabId} crashed after the change (renderer gone). Reload it with browser_history (action "reload") once the cause is fixed.`];
    if (r.errors.length) lines.push(`- ${count(r.errors.length + r.moreErrors, 'new error')} before the crash:`, ...r.errors.map(e => `  ${e}`), ...more(r.moreErrors, 'browser_console_messages'));
    if (r.failures.length) lines.push(`- ${count(r.failures.length + r.moreFailures, 'new failed request')} before the crash:`, ...r.failures.map(e => `  ${e}`), ...more(r.moreFailures, 'browser_network_requests'));
    if (r.devServerLost) lines.push(lostLine(r.devServerLost));
    return lines.join('\n');
  }
  const head = `Change in ${r.tabId} after ${r.update}, ${r.unsettled ? 'compared' : 'settled'} after ${formatMs(r.elapsedMs)}`;
  const diff = r.screenshot?.kind === 'diff' ? r.screenshot : undefined;
  const nothing = !r.errors.length && !r.failures.length && !r.navigated && !r.overlay && !r.overlayBefore && diff !== undefined && diff.changed === 0 && !r.still.errors && !r.still.failures;
  const tail: string[] = [];
  if (r.warnings) tail.push(`+ ${count(r.warnings, 'new warning')} (browser_console_messages shows them).`);
  if (r.unsettled) tail.push(unsettledNote(r.unsettled));
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
  if (r.overlay) lines.push(`- Build error shown in the page (${r.overlay.kind}): ${sentence(clip(r.overlay.text, 400))} Fix the file; the page updates by itself once it compiles.`);
  if (r.overlayBefore === 'still') lines.push('- The build error shown at the baseline is still shown.');
  if (r.overlayBefore === 'gone') lines.push('- The build error shown at the baseline is gone.');
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
  churn: boolean;
  devServerLost?: string;
}

export function formatTimeout(t: TimeoutReport): string {
  const watched = t.churn ? 'no hot update, reload or error; DOM changes do not count on this page, which changes on its own' : 'no hot update, reload, DOM change or error';
  const lines = [
    `No update reached ${t.tabId} within ${formatMs(t.timeoutMs)} (${watched} since the ${t.since} ${formatMs(t.sinceMs)} ago). If the edit should show here: is the dev server running and watching that file (check its terminal)? A page without hot reload needs check with reload: true.`,
  ];
  if (t.devServerLost) lines.push(lostLine(t.devServerLost));
  return lines.join('\n');
}

function screenshotLine(s: ScreenshotOutcome, attached: boolean): string {
  const image = attached ? ' After-screenshot attached.' : '';
  if (s.kind === 'resized') return `- Viewport changed size (${size(s.from)} → ${size(s.to)}), so the screenshots are not compared.${image}`;
  if (s.kind === 'skipped') return `- Screenshots not compared (${s.reason}).${image}`;
  if (s.changed === 0) return `- Screenshot unchanged.${image}`;
  const n = s.regions.length + s.more;
  const boxes = s.regions.map(r => `x ${r.x}–${r.x + r.width} y ${r.y}–${r.y + r.height}${n > 1 ? ` (${percent(r.changed, s.total)})` : ''}`).join('; ');
  const smaller = s.more ? `; and ${s.more} smaller` : '';
  return `- Screenshot: ${percent(s.changed, s.total)} changed in ${count(n, 'region')} (viewport CSS px): ${boxes}${smaller}.${image}`;
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
