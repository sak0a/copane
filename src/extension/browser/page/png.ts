// Decoding the PNG screenshots the browser returns into RGBA pixels, and shrinking them, for the
// change check (imageDiff.ts). Pure, `node:zlib` only. Supports what Chromium writes: 8-bit RGB or
// RGBA, not interlaced; anything else is refused with UnsupportedPng.
import { inflateSync } from 'node:zlib';

export interface RgbaImage {
  width: number;
  height: number;
  /** width × height × 4 bytes, row by row. */
  data: Uint8Array;
}

/** The image is not a PNG this decoder reads (palette, 16-bit, grey, interlaced, too large, damaged). */
export class UnsupportedPng extends Error {}

/** More pixels than this are refused (a 2000×2000 image). */
export const MAX_PNG_PIXELS = 4_000_000;

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function decodePng(bytes: Uint8Array): RgbaImage {
  if (bytes.length < 8 || SIGNATURE.some((b, i) => bytes[i] !== b)) throw new UnsupportedPng('not a PNG');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Uint8Array[] = [];
  let pos = 8;
  let sawHeader = false;
  while (pos + 8 <= bytes.length) {
    const length = view.getUint32(pos);
    const type = String.fromCharCode(bytes[pos + 4]!, bytes[pos + 5]!, bytes[pos + 6]!, bytes[pos + 7]!);
    const start = pos + 8;
    if (start + length > bytes.length) throw new UnsupportedPng('truncated chunk');
    if (type === 'IHDR') {
      width = view.getUint32(start);
      height = view.getUint32(start + 4);
      const depth = bytes[start + 8];
      const colour = bytes[start + 9];
      const interlace = bytes[start + 12];
      if (depth !== 8) throw new UnsupportedPng(`bit depth ${depth}`);
      if (colour === 2) channels = 3;
      else if (colour === 6) channels = 4;
      else throw new UnsupportedPng(`colour type ${colour}`);
      if (interlace !== 0) throw new UnsupportedPng('interlaced');
      if (width === 0 || height === 0) throw new UnsupportedPng('empty image');
      if (width * height > MAX_PNG_PIXELS) throw new UnsupportedPng(`${width}×${height} is too large`);
      sawHeader = true;
    } else if (type === 'IDAT') {
      idat.push(bytes.subarray(start, start + length));
    } else if (type === 'IEND') {
      break;
    }
    pos = start + length + 4; // skip the CRC
  }
  if (!sawHeader) throw new UnsupportedPng('no header');
  if (idat.length === 0) throw new UnsupportedPng('no image data');
  let raw: Uint8Array;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch {
    throw new UnsupportedPng('damaged image data');
  }
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) throw new UnsupportedPng('image data too short');

  const out = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride);
  let cur = new Uint8Array(stride);
  const bpp = channels;
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    const filter = raw[rowStart];
    const src = raw.subarray(rowStart + 1, rowStart + 1 + stride);
    switch (filter) {
      case 0:
        cur.set(src);
        break;
      case 1: // Sub
        for (let i = 0; i < stride; i++) cur[i] = (src[i]! + (i >= bpp ? cur[i - bpp]! : 0)) & 0xff;
        break;
      case 2: // Up
        for (let i = 0; i < stride; i++) cur[i] = (src[i]! + prev[i]!) & 0xff;
        break;
      case 3: // Average
        for (let i = 0; i < stride; i++) cur[i] = (src[i]! + (((i >= bpp ? cur[i - bpp]! : 0) + prev[i]!) >> 1)) & 0xff;
        break;
      case 4: // Paeth
        for (let i = 0; i < stride; i++) {
          const a = i >= bpp ? cur[i - bpp]! : 0;
          const b = prev[i]!;
          const c = i >= bpp ? prev[i - bpp]! : 0;
          cur[i] = (src[i]! + paeth(a, b, c)) & 0xff;
        }
        break;
      default:
        throw new UnsupportedPng(`row filter ${filter}`);
    }
    const o = y * width * 4;
    if (channels === 4) out.set(cur, o);
    else for (let x = 0; x < width; x++) {
      out[o + x * 4] = cur[x * 3]!;
      out[o + x * 4 + 1] = cur[x * 3 + 1]!;
      out[o + x * 4 + 2] = cur[x * 3 + 2]!;
      out[o + x * 4 + 3] = 255;
    }
    [prev, cur] = [cur, prev];
  }
  return { width, height, data: out };
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * Shrinks the image by a whole factor so it is at most `maxWidth` wide, averaging each factor × factor
 * box (boxes at the right and bottom edge average the pixels they have). Returns the image itself when
 * it is narrow enough.
 */
export function downscale(img: RgbaImage, maxWidth: number): RgbaImage {
  if (img.width <= maxWidth) return img;
  const f = Math.ceil(img.width / maxWidth);
  const w = Math.ceil(img.width / f);
  const h = Math.ceil(img.height / f);
  const out = new Uint8Array(w * h * 4);
  for (let by = 0; by < h; by++) {
    const y0 = by * f;
    const y1 = Math.min(img.height, y0 + f);
    for (let bx = 0; bx < w; bx++) {
      const x0 = bx * f;
      const x1 = Math.min(img.width, x0 + f);
      let r = 0, g = 0, b = 0, a = 0;
      for (let y = y0; y < y1; y++) {
        let i = (y * img.width + x0) * 4;
        for (let x = x0; x < x1; x++, i += 4) {
          r += img.data[i]!;
          g += img.data[i + 1]!;
          b += img.data[i + 2]!;
          a += img.data[i + 3]!;
        }
      }
      const n = (y1 - y0) * (x1 - x0);
      const o = (by * w + bx) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round(a / n);
    }
  }
  return { width: w, height: h, data: out };
}
