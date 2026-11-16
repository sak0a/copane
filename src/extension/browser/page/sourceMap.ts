// Source map v3 decoding for browser_inspect (source.ts): base64 VLQ, plain and index maps, lookup of
// a generated position, and resolving source URLs. Pure: no vscode, no network.

/** A map that cannot be used; the message is shown to the agent as is (e.g. "source map too large"). */
export class SourceMapError extends Error {}

/** Largest `mappings` string decoded (characters). */
export const MAX_MAPPINGS_CHARS = 20_000_000;

export interface OriginalPosition {
  /** The source as resolved against the map's URL (an http URL, webpack://..., a file path). */
  source: string;
  /** 1-based. */
  line: number;
  /** 1-based. */
  column: number;
  /** The source is on the map's ignore list (library code). */
  ignored: boolean;
}

export interface ParsedMap {
  /** Characters of `mappings` text, for the cache's size limit. */
  readonly size: number;
  readonly file: string | undefined;
  /** The original position of a generated position (0-based line and column), if mapped. */
  lookup(line: number, column: number): OriginalPosition | undefined;
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_VALUE = new Int8Array(128).fill(-1);
for (let i = 0; i < BASE64.length; i++) BASE64_VALUE[BASE64.charCodeAt(i)] = i;

/** Decodes the base64 VLQ numbers of one segment (e.g. "gBAAgB" → [16, 0, 0, 16]). */
export function decodeVlq(segment: string): number[] {
  const out: number[] = [];
  let value = 0;
  let shift = 0;
  for (let i = 0; i < segment.length; i++) {
    const digit = BASE64_VALUE[segment.charCodeAt(i)] ?? -1;
    if (digit < 0) throw new SourceMapError(`invalid character in source map mappings: "${segment[i]}"`);
    value += (digit & 31) * 2 ** shift;
    if (digit & 32) {
      shift += 5;
      continue;
    }
    // The sign is in the lowest bit.
    const magnitude = Math.floor(value / 2);
    out.push(value % 2 === 1 ? -magnitude : magnitude);
    value = 0;
    shift = 0;
  }
  if (shift !== 0) throw new SourceMapError('truncated number in source map mappings');
  return out;
}

/**
 * Resolves a reference (a source, a sourceMappingURL) against a base URL. Absolute URLs and file paths
 * (POSIX or Windows) are kept; relative ones are resolved only against a hierarchical URL base.
 */
export function resolveUrl(reference: string, base: string | undefined): string {
  if (/^[a-zA-Z]:[\\/]/.test(reference) || reference.startsWith('\\\\')) return reference;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(reference)) return reference;
  if (!base || !/^(https?|file):/i.test(base)) return reference;
  try {
    return new URL(reference, base).href;
  } catch {
    return reference;
  }
}

/** The text of a `data:` URL (base64 or URI-encoded), or undefined when it is not one. */
export function decodeDataUrl(url: string): string | undefined {
  const m = /^data:([^,]*?),(.*)$/s.exec(url);
  if (!m) return undefined;
  const meta = m[1]!;
  const data = m[2]!;
  if (/;base64$/i.test(meta)) return Buffer.from(data, 'base64').toString('utf8');
  try {
    return decodeURIComponent(data);
  } catch {
    return data;
  }
}

/**
 * The source map reference of a script: the `SourceMap` / `X-SourceMap` header, else the last
 * `//# sourceMappingURL=` (or the old `//@`) comment. Resolved against the script URL.
 */
export function findSourceMapUrl(scriptUrl: string, text: string, headers: Record<string, string> = {}): string | undefined {
  for (const [name, value] of Object.entries(headers)) {
    if (/^(x-)?sourcemap$/i.test(name) && value.trim()) return resolveUrl(value.trim(), scriptUrl);
  }
  const re = /(?:\/\/|\/\*)[#@][ \t]*sourceMappingURL=([^\s'"*]+)/g;
  // The last comment counts: a bundle may quote the string earlier (e.g. inside a library).
  let last: string | undefined;
  for (let m = re.exec(text); m; m = re.exec(text)) last = m[1];
  return last ? resolveUrl(last, scriptUrl) : undefined;
}

interface RawMap {
  version?: number;
  file?: string;
  sourceRoot?: string;
  sources?: Array<string | null>;
  mappings?: string;
  sections?: Array<{ offset: { line: number; column: number }; map?: RawMap; url?: string }>;
  ignoreList?: number[];
  x_google_ignoreList?: number[];
}

/**
 * Parses a source map. `mapUrl` resolves relative sources; for an inline (`data:`) map pass the
 * script's URL. Throws SourceMapError for anything unusable.
 */
export function parseSourceMap(text: string, mapUrl: string): ParsedMap {
  let raw: RawMap;
  try {
    raw = JSON.parse(text.replace(/^\)\]\}'[^\n]*\n/, ''));
  } catch {
    throw new SourceMapError('the source map is not valid JSON');
  }
  if (!raw || typeof raw !== 'object') throw new SourceMapError('not a source map');
  return fromRaw(raw, mapUrl);
}

function fromRaw(raw: RawMap, mapUrl: string): ParsedMap {
  if (raw.version !== 3) throw new SourceMapError(`unsupported source map version ${String(raw.version)}`);
  if (Array.isArray(raw.sections)) return indexMap(raw, mapUrl);
  if (typeof raw.mappings !== 'string' || !Array.isArray(raw.sources)) throw new SourceMapError('not a source map (no mappings or sources)');
  if (raw.mappings.length > MAX_MAPPINGS_CHARS) throw new SourceMapError('source map too large');
  return new PlainMap(raw, mapUrl);
}

/** One decoded line: quads of generated column, source index (-1: unmapped), original line, original column. */
type Line = Int32Array;

class PlainMap implements ParsedMap {
  readonly size: number;
  readonly file: string | undefined;
  private readonly sources: string[];
  private readonly ignored: Set<number>;
  private lines: Line[] | undefined;

  constructor(
    private readonly raw: RawMap,
    mapUrl: string,
  ) {
    this.size = raw.mappings!.length;
    this.file = raw.file;
    const root = raw.sourceRoot ? raw.sourceRoot.replace(/\/?$/, '/') : '';
    this.sources = raw.sources!.map(s => {
      const source = s ?? '';
      const joined = root && !/^([a-zA-Z][a-zA-Z0-9+.-]*:|\/|\\\\)/.test(source) ? root + source : source;
      return resolveUrl(joined, mapUrl);
    });
    this.ignored = new Set([...(raw.ignoreList ?? []), ...(raw.x_google_ignoreList ?? [])]);
  }

  lookup(line: number, column: number): OriginalPosition | undefined {
    this.lines ??= decodeMappings(this.raw.mappings!);
    const segments = this.lines[line];
    if (!segments || segments.length === 0) return undefined;
    // The segment with the largest generated column <= column, on this line only.
    let lo = 0;
    let hi = segments.length / 4 - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (segments[mid * 4]! <= column) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (found < 0) return undefined;
    const src = segments[found * 4 + 1]!;
    if (src < 0 || src >= this.sources.length) return undefined;
    return { source: this.sources[src]!, line: segments[found * 4 + 2]! + 1, column: segments[found * 4 + 3]! + 1, ignored: this.ignored.has(src) };
  }
}

/** Decodes all of `mappings` into one quad array per generated line, sorted by generated column. */
export function decodeMappings(mappings: string): Line[] {
  const lines: Line[] = [];
  let source = 0;
  let origLine = 0;
  let origColumn = 0;
  for (const lineText of mappings.split(';')) {
    let column = 0;
    const quads: number[] = [];
    let sorted = true;
    if (lineText) {
      for (const segment of lineText.split(',')) {
        if (!segment) continue;
        const v = decodeVlq(segment);
        column += v[0]!;
        if (quads.length && column < quads[quads.length - 4]!) sorted = false;
        if (v.length >= 4) {
          source += v[1]!;
          origLine += v[2]!;
          origColumn += v[3]!;
          quads.push(column, source, origLine, origColumn);
        } else quads.push(column, -1, 0, 0);
      }
    }
    if (!sorted) {
      const order = Array.from({ length: quads.length / 4 }, (_, i) => i).sort((a, b) => quads[a * 4]! - quads[b * 4]!);
      lines.push(Int32Array.from(order.flatMap(i => quads.slice(i * 4, i * 4 + 4))));
    } else lines.push(Int32Array.from(quads));
  }
  return lines;
}

function indexMap(raw: RawMap, mapUrl: string): ParsedMap {
  // Sections that point at another URL are not followed.
  const sections = (raw.sections ?? [])
    .filter(s => s.map && s.offset)
    .map(s => ({ line: s.offset.line, column: s.offset.column, map: fromRaw(s.map!, mapUrl) }))
    .sort((a, b) => a.line - b.line || a.column - b.column);
  const size = sections.reduce((n, s) => n + s.map.size, 0);
  if (size > MAX_MAPPINGS_CHARS) throw new SourceMapError('source map too large');
  return {
    size,
    file: raw.file,
    lookup(line, column) {
      let section: (typeof sections)[number] | undefined;
      for (const s of sections) {
        if (s.line < line || (s.line === line && s.column <= column)) section = s;
        else break;
      }
      if (!section) return undefined;
      return section.map.lookup(line - section.line, line === section.line ? column - section.column : column);
    },
  };
}
