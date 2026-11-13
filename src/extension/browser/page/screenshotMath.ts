// Sizing screenshots for a model: big enough to read, small enough not to waste tokens. Pure.

/** Longest edge and total pixels that vision models handle without being downscaled again. */
export const MAX_EDGE = 1568;
export const MAX_PIXELS = 1_150_000;
/** Below this scale text becomes hard to read, so tall full-page shots are cut instead of shrunk further. */
export const MIN_READABLE_SCALE = 0.5;

/** Output pixels per CSS pixel for a region of `width` × `height` CSS pixels. Never upscales. */
export function screenshotScale(width: number, height: number): number {
  if (width <= 0 || height <= 0) return 1;
  return Math.min(1, MAX_EDGE / Math.max(width, height), Math.sqrt(MAX_PIXELS / (width * height)));
}

/**
 * For a full-page shot: the height (CSS px) to capture so the image stays readable. Pages taller than
 * that are cut at the bottom.
 */
export function fullPageHeight(width: number, height: number): number {
  const maxByEdge = MAX_EDGE / MIN_READABLE_SCALE;
  const maxByPixels = MAX_PIXELS / (MIN_READABLE_SCALE * MIN_READABLE_SCALE) / Math.max(1, width);
  return Math.max(1, Math.min(height, Math.floor(Math.min(maxByEdge, maxByPixels))));
}
