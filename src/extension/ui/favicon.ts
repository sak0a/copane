// Site icons (favicons) for the tab rows of the Sessions view and the Agent Tabs panel. The icon is
// the one VS Code's integrated browser already shows on the editor tab (`BrowserTab.icon`, a `data:`
// URI of what the page's own network stack loaded), so nothing here fetches or evaluates anything.
// That data is page content: it is checked before a view renders it. Raster formats are recognised by
// their bytes (the declared type is ignored); SVG only when it has no script, event handlers, foreign
// content, entities or references outside itself (the views draw icons as images, where SVG cannot run
// script or load anything anyway; this is a second line). Accepted icons are re-encoded as
// `data:<sniffed type>;base64,...` and named by a short key, so view models and their diffs stay small.
// No `vscode` here (unit-tested in test/unit/ui-favicon.test.ts).
import { createHash } from 'node:crypto';

export const FAVICON_LIMITS = {
  /** Decoded size of an icon. Browsers' own favicons are mostly well below 10 KB. */
  maxBytes: 32 * 1024,
  /** Length of the `data:` URI as given, checked before decoding anything (percent-encoded SVG is up to 3x its size). */
  maxUriLength: 128 * 1024,
  /** Distinct icons remembered (accepted or rejected), least recently used dropped first. */
  cacheEntries: 32,
} as const;

export type FaviconMime = 'image/png' | 'image/x-icon' | 'image/gif' | 'image/jpeg' | 'image/webp' | 'image/svg+xml';

export type FaviconCheck =
  | { ok: true; key: string; mime: FaviconMime; uri: string; bytes: number }
  | { ok: false; reason: string };

/** Splits a `data:` URI into its declared type and decoded bytes; undefined when it is not one. */
export function parseDataUri(uri: string): { mime: string; bytes: Uint8Array } | undefined {
  const m = /^data:([^,]*),(.*)$/s.exec(uri);
  if (!m) return undefined;
  const params = m[1]!.split(';').map(p => p.trim());
  const base64 = params.slice(1).some(p => p.toLowerCase() === 'base64');
  const mime = (params[0] || 'text/plain').toLowerCase();
  const payload = m[2]!;
  try {
    if (base64) {
      const clean = decodeURIComponent(payload).replace(/\s+/g, '');
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) return undefined;
      return { mime, bytes: new Uint8Array(Buffer.from(clean, 'base64')) };
    }
    return { mime, bytes: new Uint8Array(Buffer.from(decodeURIComponent(payload), 'utf8')) };
  } catch {
    return undefined;
  }
}

/** The image type of `bytes` by their signature, or "svg" for text that starts like an SVG document. */
export function sniffImage(bytes: Uint8Array): Exclude<FaviconMime, 'image/svg+xml'> | 'svg' | undefined {
  const at = (i: number, ...sig: number[]) => sig.every((b, k) => bytes[i + k] === b);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  // ICO: reserved 0, type 1 (icon), at least one image. CUR (type 2) is not a favicon.
  if (at(0, 0, 0, 1, 0) && bytes.length >= 6 && (bytes[4]! | (bytes[5]! << 8)) > 0) return 'image/x-icon';
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
  const head = Buffer.from(bytes.subarray(0, 512)).toString('utf8').replace(/^﻿/, '').trimStart();
  if (/^(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(head)) return 'svg';
  return undefined;
}

/**
 * Why an SVG must not be shown, or undefined when it is plain drawing. Strict on purpose: favicons
 * are simple shapes, and anything that can run code, load something or expand (entities) is refused.
 */
export function svgProblem(text: string): string | undefined {
  if (/<script[\s>/]/i.test(text)) return 'it contains a script';
  if (/<foreignObject[\s>/]/i.test(text)) return 'it embeds foreign (HTML) content';
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) return 'it declares a DOCTYPE or entities';
  if (/[\s/"']on[a-z]+\s*=/i.test(text)) return 'it has event handler attributes';
  // Escapes and character references can spell any of the words checked here ("\\75rl(", "&#99;").
  if (/\\/.test(text)) return 'it uses backslash escapes';
  if (/&#/.test(text)) return 'it uses character references';
  if (/javascript:/i.test(text)) return 'it has a javascript: link';
  if (/@import/i.test(text)) return 'its style imports a stylesheet';
  // Every reference must stay inside the document: href="#id" and url(#id) only.
  for (const m of text.matchAll(/(?:xlink:)?href\s*=\s*(?:(["'])(.*?)\1|([^\s>]*))/gis)) if (!(m[2] ?? m[3] ?? '').trim().startsWith('#')) return 'it references a resource outside itself';
  for (const m of text.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gis)) if (!m[2]!.trim().startsWith('#')) return 'it references a resource outside itself';
  return undefined;
}

/** Checks a `data:` URI as an icon to show; on success re-encodes it as base64 with the sniffed type. */
export function checkFavicon(uri: string, limits: { maxBytes: number; maxUriLength: number } = FAVICON_LIMITS): FaviconCheck {
  if (!uri.startsWith('data:')) return { ok: false, reason: 'not a data: URI (remote icons are never loaded by the views)' };
  if (uri.length > limits.maxUriLength) return { ok: false, reason: `larger than ${Math.round(limits.maxBytes / 1024)} KB` };
  const parsed = parseDataUri(uri);
  if (!parsed) return { ok: false, reason: 'not a valid data: URI' };
  if (parsed.bytes.length === 0) return { ok: false, reason: 'empty' };
  if (parsed.bytes.length > limits.maxBytes) return { ok: false, reason: `larger than ${Math.round(limits.maxBytes / 1024)} KB` };
  const kind = sniffImage(parsed.bytes);
  if (!kind) return { ok: false, reason: `not an image format icons are shown in (declared ${parsed.mime || 'no type'})` };
  let mime: FaviconMime;
  if (kind === 'svg') {
    const problem = svgProblem(Buffer.from(parsed.bytes).toString('utf8'));
    if (problem) return { ok: false, reason: `SVG refused: ${problem}` };
    mime = 'image/svg+xml';
  } else {
    mime = kind;
  }
  const base64 = Buffer.from(parsed.bytes).toString('base64');
  const key = `fav-${createHash('sha256').update(mime).update('\0').update(parsed.bytes).digest('hex').slice(0, 12)}`;
  return { ok: true, key, mime, uri: `data:${mime};base64,${base64}`, bytes: parsed.bytes.length };
}

/**
 * Results of `checkFavicon` by the URI as given, least recently used dropped first, so the views'
 * rebuilds (every tab change) do not decode the same icon again. Accepted icons are also found by key.
 */
export class FaviconCache {
  private readonly byUri = new Map<string, FaviconCheck>();
  private readonly byKey = new Map<string, string>();

  constructor(
    private readonly maxEntries: number = FAVICON_LIMITS.cacheEntries,
    private readonly check: (uri: string) => FaviconCheck = checkFavicon,
  ) {}

  get size(): number {
    return this.byUri.size;
  }

  get(uri: string): FaviconCheck {
    // Too long to keep as a map key: refused straight away, never stored.
    if (uri.length > FAVICON_LIMITS.maxUriLength) return this.check(uri);
    let result = this.byUri.get(uri);
    if (result) {
      this.byUri.delete(uri);
    } else {
      result = this.check(uri);
      while (this.byUri.size >= this.maxEntries) this.evict(this.byUri.keys().next().value!);
    }
    this.byUri.set(uri, result);
    if (result.ok) this.byKey.set(result.key, result.uri);
    return result;
  }

  /** The re-encoded `data:` URI of an accepted icon still in the cache. */
  uriOf(key: string): string | undefined {
    return this.byKey.get(key);
  }

  /** Keeps only the entries of these URIs (the icons of tabs still listed). */
  retain(uris: ReadonlySet<string>): void {
    for (const uri of [...this.byUri.keys()]) if (!uris.has(uri)) this.evict(uri);
  }

  private evict(uri: string): void {
    const result = this.byUri.get(uri);
    this.byUri.delete(uri);
    if (result?.ok && ![...this.byUri.values()].some(r => r.ok && r.key === result.key)) this.byKey.delete(result.key);
  }
}
