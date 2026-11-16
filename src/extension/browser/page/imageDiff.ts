// Comparing two screenshots of the same viewport for the change check: which pixels changed, grouped
// into regions with boxes in viewport CSS px, and how much of the view changed. Pure.
import type { RgbaImage } from './png';

/** A channel must differ by more than this (of 255) for the pixel to count as changed. */
export const PIXEL_THRESHOLD = 32;
/** Pixels are grouped in cells of this size; a cell counts when it holds at least MIN_CELL_PIXELS changed pixels. */
export const CELL = 8;
export const MIN_CELL_PIXELS = 2;
/** Regions shown; the rest are summed up as "and N smaller". */
export const MAX_REGIONS = 6;

export interface ImageDiff {
  width: number;
  height: number;
  /** One byte per pixel: 1 where it changed. */
  mask: Uint8Array;
}

export interface Region {
  /** Box in viewport CSS px. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Changed image pixels in the region. */
  changed: number;
}

export interface DiffSummary {
  /** Changed image pixels in the regions that count. */
  changed: number;
  /** Image pixels in total. */
  total: number;
  /** Largest first, at most MAX_REGIONS. */
  regions: Region[];
  /** Regions not listed. */
  more: number;
}

/** Marks the pixels that changed. The images must have the same size. */
export function diffImages(a: RgbaImage, b: RgbaImage): ImageDiff {
  if (a.width !== b.width || a.height !== b.height) throw new Error('images differ in size');
  const n = a.width * a.height;
  const mask = new Uint8Array(n);
  const da = a.data;
  const db = b.data;
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const d = Math.max(Math.abs(da[i]! - db[i]!), Math.abs(da[i + 1]! - db[i + 1]!), Math.abs(da[i + 2]! - db[i + 2]!));
    if (d > PIXEL_THRESHOLD) mask[p] = 1;
  }
  return { width: a.width, height: a.height, mask };
}

/**
 * Groups changed pixels into regions: cells with enough changed pixels, joined with their neighbours
 * (one cell of slack, 8-connected). Each region's box is the tight box of its changed pixels, divided
 * by `scale` (image px per CSS px). Regions narrower than 2 CSS px or smaller than 12 CSS px² (a
 * blinking caret) are dropped, and their pixels do not count.
 */
export function regions(diff: ImageDiff, scale: number): DiffSummary {
  const { width, height, mask } = diff;
  const cw = Math.ceil(width / CELL);
  const ch = Math.ceil(height / CELL);
  const counts = new Uint16Array(cw * ch);
  for (let y = 0; y < height; y++) {
    const row = (y / CELL) | 0;
    for (let x = 0; x < width; x++) if (mask[y * width + x]) counts[row * cw + ((x / CELL) | 0)]!++;
  }
  const on = new Uint8Array(cw * ch);
  for (let i = 0; i < on.length; i++) if (counts[i]! >= MIN_CELL_PIXELS) on[i] = 1;
  // One cell of slack, so nearby changes (letters of one word) form one region.
  const grown = new Uint8Array(cw * ch);
  for (let cy = 0; cy < ch; cy++)
    for (let cx = 0; cx < cw; cx++) {
      if (!on[cy * cw + cx]) continue;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx >= 0 && ny >= 0 && nx < cw && ny < ch) grown[ny * cw + nx] = 1;
        }
    }
  // 8-connected components of the grown cells.
  const label = new Int32Array(cw * ch).fill(-1);
  const boxes: Array<{ minX: number; minY: number; maxX: number; maxY: number; changed: number }> = [];
  const stack: number[] = [];
  for (let start = 0; start < grown.length; start++) {
    if (!grown[start] || label[start] !== -1) continue;
    const id = boxes.length;
    boxes.push({ minX: Infinity, minY: Infinity, maxX: -1, maxY: -1, changed: 0 });
    label[start] = id;
    stack.push(start);
    while (stack.length) {
      const c = stack.pop()!;
      const cx = c % cw;
      const cy = (c / cw) | 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= cw || ny >= ch) continue;
          const k = ny * cw + nx;
          if (grown[k] && label[k] === -1) {
            label[k] = id;
            stack.push(k);
          }
        }
    }
  }
  // Only changed pixels in cells that counted on their own (lone noisy pixels elsewhere do not).
  for (let y = 0; y < height; y++) {
    const row = ((y / CELL) | 0) * cw;
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      const cell = row + ((x / CELL) | 0);
      if (!on[cell]) continue;
      const box = boxes[label[cell]!]!;
      box.changed++;
      if (x < box.minX) box.minX = x;
      if (y < box.minY) box.minY = y;
      if (x > box.maxX) box.maxX = x;
      if (y > box.maxY) box.maxY = y;
    }
  }
  const s = scale > 0 ? scale : 1;
  const kept: Region[] = [];
  for (const b of boxes) {
    if (b.changed === 0) continue;
    const w = (b.maxX + 1 - b.minX) / s;
    const h = (b.maxY + 1 - b.minY) / s;
    if (w < 2 || w * h < 12) continue;
    const x = Math.floor(b.minX / s);
    const y = Math.floor(b.minY / s);
    kept.push({ x, y, width: Math.ceil((b.maxX + 1) / s) - x, height: Math.ceil((b.maxY + 1) / s) - y, changed: b.changed });
  }
  kept.sort((a, b) => b.changed - a.changed);
  return {
    changed: kept.reduce((n, r) => n + r.changed, 0),
    total: width * height,
    regions: kept.slice(0, MAX_REGIONS),
    more: Math.max(0, kept.length - MAX_REGIONS),
  };
}

/** "6.2%", "<0.1%", "0%". */
export function percent(changed: number, total: number): string {
  if (changed <= 0 || total <= 0) return '0%';
  const p = (changed / total) * 100;
  if (p < 0.1) return '<0.1%';
  return `${p.toFixed(1)}%`;
}
