// Source map v3 decoding for browser_inspect (source.ts): base64 VLQ, plain and index maps, lookup of
// a generated position, and resolving source URLs. Pure: no vscode, no network.
//
// Maps come from pages, so decoding is bounded: the size, line and segment counts are checked before
// anything is allocated, decoding goes only as far as the line looked up (continuing from there on the
// next lookup), and the decoded segments live in one typed array. A map that turns out to be malformed
// throws SourceMapError from `lookup`, and keeps throwing it.

/** A map that cannot be used; the message is shown to the agent as is (e.g. "source map too large"). */
export class SourceMapError extends Error {}

/** Largest `mappings` string decoded (characters). */
export const MAX_MAPPINGS_CHARS = 10_000_000;
/** Most generated lines in one map. */
export const MAX_LINES = 500_000;
/** Most segments in one map. */
export const MAX_SEGMENTS = 2_000_000;
/** Most sections of an index map, and how deep index maps may nest. */
const MAX_SECTIONS = 1000;
const MAX_NESTING = 3;
/** Said when a map is over a limit. */
export const TOO_LARGE = `source map too large (limits: ${MAX_MAPPINGS_CHARS / 1_000_000}M characters of mappings, ${MAX_LINES / 1000}k lines, ${MAX_SEGMENTS / 1_000_000}M segments)`;

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
  /** Bytes this map holds once decoded (for the cache's budget). */
  readonly size: number;
  readonly file: string | undefined;
  /** The original position of a generated position (0-based line and column), if mapped. Throws SourceMapError for a malformed map. */
  lookup(line: number, column: number): OriginalPosition | undefined;
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_VALUE = new Int8Array(128).fill(-1);
for (let i = 0; i < BASE64.length; i++) BASE64_VALUE[BASE64.charCodeAt(i)] = i;

/** Decodes the base64 VLQ numbers of one segment (e.g. "gBAAgB" → [16, 0, 0, 16]). */
export function decodeVlq(segment: string): number[] {
  const out: number[] = [];
  const reader = { pos: 0 };
  while (reader.pos < segment.length) out.push(readVlq(segment, reader, segment.length));
  return out;
}

/** Reads one VLQ number at `r.pos` (before `end`), advancing it. */
function readVlq(text: string, r: { pos: number }, end: number): number {
  let value = 0;
  let shift = 0;
  for (;;) {
    if (r.pos >= end) throw new SourceMapError('truncated number in source map mappings');
    const code = text.charCodeAt(r.pos++);
    const digit = code < 128 ? BASE64_VALUE[code]! : -1;
    if (digit < 0) throw new SourceMapError(`invalid character in source map mappings: ${JSON.stringify(text[r.pos - 1])}`);
    if (shift > 30) throw new SourceMapError('number too large in source map mappings');
    value += (digit & 31) * 2 ** shift;
    if (!(digit & 32)) break;
    shift += 5;
  }
  // The sign is in the lowest bit.
  const magnitude = Math.floor(value / 2);
  if (magnitude > 0x7fffffff) throw new SourceMapError('number too large in source map mappings');
  return value % 2 === 1 ? -magnitude : magnitude;
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
    if (/^(x-)?sourcemap$/i.test(name) && typeof value === 'string' && value.trim()) return resolveUrl(value.trim(), scriptUrl);
  }
  const re = /(?:\/\/|\/\*)[#@][ \t]*sourceMappingURL=([^\s'"*]+)/g;
  // The last comment counts: a bundle may quote the string earlier (e.g. inside a library).
  let last: string | undefined;
  for (let m = re.exec(text); m; m = re.exec(text)) last = m[1];
  return last ? resolveUrl(last, scriptUrl) : undefined;
}

/**
 * Parses a source map. `mapUrl` resolves relative sources; for an inline (`data:`) map pass the
 * script's URL. Throws SourceMapError for anything unusable. Only what lookups need is kept.
 */
export function parseSourceMap(text: string, mapUrl: string): ParsedMap {
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^\)\]\}'[^\n]*\n/, ''));
  } catch (err) {
    // JSON.parse itself recurses: a map of thousands of nested sections overflows the stack there.
    throw new SourceMapError(err instanceof RangeError ? 'index source map nested too deeply' : 'the source map is not valid JSON');
  }
  return fromRaw(raw, mapUrl, 0);
}

function fromRaw(raw: any, mapUrl: string, depth: number): ParsedMap {
  if (!raw || typeof raw !== 'object') throw new SourceMapError('not a source map');
  if (raw.version !== 3) throw new SourceMapError(`unsupported source map version ${String(raw.version).slice(0, 20)}`);
  if (Array.isArray(raw.sections)) return indexMap(raw, mapUrl, depth);
  if (typeof raw.mappings !== 'string' || !Array.isArray(raw.sources)) throw new SourceMapError('not a source map (no mappings or sources)');
  return new PlainMap(raw, mapUrl);
}

class PlainMap implements ParsedMap {
  readonly size: number;
  readonly file: string | undefined;
  private readonly sources: string[];
  private readonly ignored: Set<number>;
  private mappings: string;
  /** Quads: generated column, source index (-1: unmapped), original line, original column. */
  private segments: Int32Array;
  /** Index of each line's first segment; lineStart[n] for lines decoded so far. */
  private lineStart: Int32Array;
  /** Lines whose segments are not in column order (searched linearly). */
  private readonly unsorted = new Set<number>();
  private readonly lineCount: number;
  // Decoder state, kept between lookups.
  private decodedLines = 0;
  private count = 0;
  private pos = 0;
  private source = 0;
  private origLine = 0;
  private origColumn = 0;
  private broken: SourceMapError | undefined;

  constructor(raw: any, mapUrl: string) {
    const mappings: string = raw.mappings;
    if (mappings.length > MAX_MAPPINGS_CHARS) throw new SourceMapError(TOO_LARGE);
    // Count lines and segments before allocating (one pass, no allocation).
    let lines = 1;
    let separators = 0;
    for (let i = mappings.indexOf(';'); i >= 0; i = mappings.indexOf(';', i + 1)) lines++;
    if (lines > MAX_LINES) throw new SourceMapError(TOO_LARGE);
    for (let i = mappings.indexOf(','); i >= 0; i = mappings.indexOf(',', i + 1)) separators++;
    // Every segment is followed by "," or ";" or the end: an upper bound.
    const segments = separators + lines;
    if (segments > MAX_SEGMENTS) throw new SourceMapError(TOO_LARGE);
    this.lineCount = lines;
    this.mappings = mappings;
    this.segments = new Int32Array(segments * 4);
    this.lineStart = new Int32Array(lines + 1);
    this.file = typeof raw.file === 'string' ? raw.file : undefined;
    const root = typeof raw.sourceRoot === 'string' && raw.sourceRoot ? raw.sourceRoot.replace(/\/?$/, '/') : '';
    this.sources = (raw.sources as unknown[]).map(s => {
      const source = typeof s === 'string' ? s : '';
      const joined = root && !/^([a-zA-Z][a-zA-Z0-9+.-]*:|\/|\\\\)/.test(source) ? root + source : source;
      return resolveUrl(joined, mapUrl);
    });
    const list = (v: unknown) => (Array.isArray(v) ? v.filter((n): n is number => Number.isInteger(n)) : []);
    this.ignored = new Set([...list(raw.ignoreList), ...list(raw.x_google_ignoreList)]);
    this.size = mappings.length * 2 + this.segments.byteLength + this.lineStart.byteLength + this.sources.reduce((n, s) => n + s.length * 2, 0);
  }

  lookup(line: number, column: number): OriginalPosition | undefined {
    if (this.broken) throw this.broken;
    if (!Number.isInteger(line) || line < 0 || line >= this.lineCount) return undefined;
    try {
      this.decodeThrough(line);
    } catch (err) {
      this.broken = err instanceof SourceMapError ? err : new SourceMapError(`unusable source map: ${String(err)}`);
      // Nothing more will be read from it.
      this.mappings = '';
      this.segments = new Int32Array(0);
      this.lineStart = new Int32Array(0);
      throw this.broken;
    }
    const from = this.lineStart[line]!;
    const to = this.lineStart[line + 1]!;
    const s = this.segments;
    let found = -1;
    if (this.unsorted.has(line)) {
      for (let i = from; i < to; i++) if (s[i * 4]! <= column && (found < 0 || s[i * 4]! >= s[found * 4]!)) found = i;
    } else {
      // The segment with the largest generated column <= column, on this line only.
      let lo = from;
      let hi = to - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (s[mid * 4]! <= column) {
          found = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
    }
    if (found < 0) return undefined;
    const src = s[found * 4 + 1]!;
    if (src < 0 || src >= this.sources.length || s[found * 4 + 2]! < 0 || s[found * 4 + 3]! < 0) return undefined;
    return { source: this.sources[src]!, line: s[found * 4 + 2]! + 1, column: s[found * 4 + 3]! + 1, ignored: this.ignored.has(src) };
  }

  /** Decodes lines up to and including `target`, continuing where the last lookup stopped. */
  private decodeThrough(target: number): void {
    const text = this.mappings;
    const s = this.segments;
    while (this.decodedLines <= target) {
      const lineNo = this.decodedLines;
      this.lineStart[lineNo] = this.count;
      let end = text.indexOf(';', this.pos);
      if (end < 0) end = text.length;
      let column = 0;
      let previous = -1;
      const r = { pos: this.pos };
      while (r.pos < end) {
        if (text.charCodeAt(r.pos) === 44 /* , */) {
          r.pos++;
          continue;
        }
        column += readVlq(text, r, end);
        let fields = 1;
        let src = -1;
        let line = 0;
        let col = 0;
        while (r.pos < end && text.charCodeAt(r.pos) !== 44) {
          const v = readVlq(text, r, end);
          fields++;
          if (fields === 2) this.source += v;
          else if (fields === 3) this.origLine += v;
          else if (fields === 4) this.origColumn += v;
          else if (fields > 5) throw new SourceMapError('a segment with more than 5 fields in source map mappings');
        }
        if (fields === 2 || fields === 3) throw new SourceMapError('a segment with 2 or 3 fields in source map mappings');
        if (fields >= 4) {
          src = this.source;
          line = this.origLine;
          col = this.origColumn;
        }
        if (column < previous) this.unsorted.add(lineNo);
        previous = column;
        const k = this.count++ * 4;
        s[k] = column;
        s[k + 1] = src;
        s[k + 2] = line;
        s[k + 3] = col;
      }
      this.pos = end + 1;
      this.decodedLines++;
      this.lineStart[lineNo + 1] = this.count;
    }
  }
}

function indexMap(raw: any, mapUrl: string, depth: number): ParsedMap {
  if (depth >= MAX_NESTING) throw new SourceMapError('index source map nested too deeply');
  if (raw.sections.length > MAX_SECTIONS) throw new SourceMapError(`index source map with more than ${MAX_SECTIONS} sections`);
  // Sections that point at another URL are not followed.
  const sections: Array<{ line: number; column: number; map: ParsedMap }> = [];
  let size = 0;
  for (const s of raw.sections as any[]) {
    if (!s || typeof s !== 'object' || !s.map) continue;
    const line = s.offset?.line;
    const column = s.offset?.column;
    if (!Number.isInteger(line) || !Number.isInteger(column) || line < 0 || column < 0) throw new SourceMapError('index source map section without a valid offset');
    const map = fromRaw(s.map, mapUrl, depth + 1);
    size += map.size;
    if (size > MAX_MAPPINGS_CHARS * 4) throw new SourceMapError(TOO_LARGE);
    sections.push({ line, column, map });
  }
  sections.sort((a, b) => a.line - b.line || a.column - b.column);
  return {
    size,
    file: typeof raw.file === 'string' ? raw.file : undefined,
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
