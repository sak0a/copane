// Sizing screenshots for a model: big enough to read, small enough not to waste tokens. Pure.

export type ScreenshotDetail = 'normal' | 'high';

export interface ScreenshotBudget {
  /** Longest edge of the image, px. */
  maxEdge: number;
  /** Total pixels of the image. */
  maxPixels: number;
}

/**
 * Image size budgets. A vision model costs about width × height / 750 tokens per image. "high" is the
 * most vision models take without downscaling again (1568 px edge, 1.15 MP: ~1,530 tokens); "normal",
 * the default, is ~30% fewer tokens (~1,070) and keeps 12-13 px text readable on common window sizes.
 */
export const SCREENSHOT_BUDGETS: Record<ScreenshotDetail, ScreenshotBudget> = {
  normal: { maxEdge: 1280, maxPixels: 800_000 },
  high: { maxEdge: 1568, maxPixels: 1_150_000 },
};

/** Below this scale text becomes hard to read, so tall full-page shots are cut instead of shrunk further. */
export const MIN_READABLE_SCALE = 0.5;

/** Output pixels per CSS pixel for a region of `width` × `height` CSS pixels. Never upscales. */
export function screenshotScale(width: number, height: number, detail: ScreenshotDetail = 'normal'): number {
  if (width <= 0 || height <= 0) return 1;
  const b = SCREENSHOT_BUDGETS[detail];
  return Math.min(1, b.maxEdge / Math.max(width, height), Math.sqrt(b.maxPixels / (width * height)));
}

/**
 * For a full-page shot: the height (CSS px) to capture so the image stays readable. Pages taller than
 * that are cut at the bottom.
 */
export function fullPageHeight(width: number, height: number, detail: ScreenshotDetail = 'normal'): number {
  const b = SCREENSHOT_BUDGETS[detail];
  const maxByEdge = b.maxEdge / MIN_READABLE_SCALE;
  const maxByPixels = b.maxPixels / (MIN_READABLE_SCALE * MIN_READABLE_SCALE) / Math.max(1, width);
  return Math.max(1, Math.min(height, Math.floor(Math.min(maxByEdge, maxByPixels))));
}

/** True when the "high" budget would give a noticeably sharper image of the same region. */
export function sharperAvailable(width: number, height: number, detail: ScreenshotDetail): boolean {
  return detail === 'normal' && screenshotScale(width, height, 'high') > screenshotScale(width, height, 'normal') * 1.02;
}

/** What the result says when a sharper image is available. */
export const SHARPER_NOTE = 'Downscaled; detail: "high" gives a sharper image (~1.4× the tokens).';

/** "120 + imageX / 0.786", "imageY - 1200", "imageX". */
function term(axis: 'X' | 'Y', scale: number, offset: number): string {
  const image = Math.abs(scale - 1) < 0.005 ? `image${axis}` : `image${axis} / ${scale.toFixed(3)}`;
  const o = Math.round(offset);
  return o > 0 ? `${o} + ${image}` : o < 0 ? `${image} - ${-o}` : image;
}

/**
 * How image pixels map to browser_click's x/y (viewport CSS px), for a screenshot taken at `scale`:
 * - viewport: the image is the viewport.
 * - element: the image's top-left is at `origin` (viewport CSS px) at capture time.
 * - page: the image is the page from its top-left; `scroll` is the page's scroll position now.
 */
export function coordinateNote(
  shot: { kind: 'viewport'; scale: number } | { kind: 'element'; scale: number; origin: { x: number; y: number } } | { kind: 'page'; scale: number; scroll: { x: number; y: number } },
): string {
  const one = Math.abs(shot.scale - 1) < 0.005;
  if (shot.kind === 'viewport') return one ? 'Its pixels are CSS px: usable as x/y for browser_click.' : `For browser_click x/y, divide its coordinates by ${shot.scale.toFixed(3)}.`;
  const [dx, dy] = shot.kind === 'element' ? [shot.origin.x, shot.origin.y] : [-shot.scroll.x, -shot.scroll.y];
  const scrolled = shot.kind === 'page' && (Math.round(shot.scroll.x) || Math.round(shot.scroll.y)) ? ` (the page is scrolled to ${Math.round(shot.scroll.x)}, ${Math.round(shot.scroll.y)})` : '';
  return `For browser_click x/y${scrolled}: x = ${term('X', shot.scale, dx)}, y = ${term('Y', shot.scale, dy)}.`;
}
