// browser_inspect's facts and text (source.ts gathers them): what the page probe may return, checked
// and bounded here because the page controls every value of it, and the text for the agent. Pure.

/** Longest component name, tag, path and search text kept. */
export const MAX_NAME = 60;
export const MAX_TAG = 30;
export const MAX_PATH = 300;
export const MAX_TEXT = 60;
/** Longest result. */
export const MAX_RESULT = 4000;

/**
 * A page string made safe to print: only strings, whitespace and control characters (newlines,
 * bidi and zero-width marks) collapsed to single spaces, clipped. Undefined for anything else or "".
 */
export function clean(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const s = value.replace(/[\s\p{Cc}\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]+/gu, ' ').trim();
  if (!s) return undefined;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** A non-negative integer from the page (a line, a column), else undefined. */
export function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < 1e9 ? value : undefined;
}

/** What SOURCE_PROBE (source.ts) returns, after `sanitizeProbe`. `depth`: how many ancestors up the data was found. */
export interface Probe {
  tag: string;
  attr?: { kind: 'data-insp-path' | 'data-v-inspector' | 'react-dev-inspector'; value: string; line?: number; column?: number; tag: string; depth: number };
  react?: { dev: boolean; depth: number; chain: Array<{ name: string; source?: { fileName: string; lineNumber?: number; columnNumber?: number }; stack?: string }> };
  vue3?: { depth: number; chain: Array<{ name: string; file?: string }> };
  vue2?: { depth: number; chain: Array<{ name: string; file?: string; root: boolean }> };
  svelte?: { depth: number; version: 4 | 5; loc?: { file: string; line?: number; column?: number }; parents: Array<{ file: string; line?: number; column?: number; tag?: string }> };
  svelteProd?: boolean;
  vueProd?: 'app' | 'scoped';
  angular?: boolean;
  grep: GrepHints;
}

const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const list = (v: unknown, max: number): unknown[] => (Array.isArray(v) ? v.slice(0, max) : []);
const depthOf = (v: unknown) => count(v) ?? 0;

/** Checks and bounds every field of the probe's result; drops what does not have the expected shape. */
export function sanitizeProbe(raw: unknown): Probe {
  const r = obj(raw) ?? {};
  const out: Probe = { tag: clean(r.tag, MAX_TAG) ?? 'element', grep: {} };
  const a = obj(r.attr);
  const kind = a?.kind;
  if (a && (kind === 'data-insp-path' || kind === 'data-v-inspector' || kind === 'react-dev-inspector')) {
    const value = clean(a.value, MAX_PATH + 40);
    if (value) out.attr = { kind, value, line: count(Number(a.line)), column: count(Number(a.column)), tag: clean(a.tag, MAX_TAG) ?? 'element', depth: depthOf(a.depth) };
  }
  const re = obj(r.react);
  if (re) {
    const chain = list(re.chain, 15).flatMap(c => {
      const o = obj(c);
      if (!o) return [];
      const s = obj(o.source);
      const fileName = clean(s?.fileName, MAX_PATH);
      const stack = typeof o.stack === 'string' ? o.stack.slice(0, 4000) : undefined;
      return [{ name: clean(o.name, MAX_NAME) ?? 'Anonymous', ...(fileName ? { source: { fileName, lineNumber: count(s!.lineNumber), columnNumber: count(s!.columnNumber) } } : {}), ...(stack ? { stack } : {}) }];
    });
    out.react = { dev: re.dev === true, depth: depthOf(re.depth), chain };
  }
  for (const key of ['vue3', 'vue2'] as const) {
    const v = obj(r[key]);
    if (!v) continue;
    const chain = list(v.chain, 15).flatMap(c => {
      const o = obj(c);
      return o ? [{ name: clean(o.name, MAX_NAME) ?? 'Anonymous', file: clean(o.file, MAX_PATH), root: o.root === true }] : [];
    });
    if (key === 'vue3') out.vue3 = { depth: depthOf(v.depth), chain: chain.map(({ name, file }) => ({ name, file })) };
    else out.vue2 = { depth: depthOf(v.depth), chain };
  }
  const sv = obj(r.svelte);
  if (sv) {
    const loc = obj(sv.loc);
    const file = clean(loc?.file, MAX_PATH);
    const parents = list(sv.parents, 15).flatMap(p => {
      const o = obj(p);
      const f = clean(o?.file, MAX_PATH);
      return o && f ? [{ file: f, line: count(o.line), column: count(o.column), tag: clean(o.tag, MAX_NAME) }] : [];
    });
    out.svelte = { depth: depthOf(sv.depth), version: sv.version === 4 ? 4 : 5, ...(file ? { loc: { file, line: count(loc!.line), column: count(loc!.column) } } : {}), parents };
  }
  if (r.svelteProd === true) out.svelteProd = true;
  if (r.vueProd === 'app' || r.vueProd === 'scoped') out.vueProd = r.vueProd;
  if (r.angular === true) out.angular = true;
  const g = obj(r.grep) ?? {};
  const classes = list(g.classes, 3).map(c => clean(c, 40)).filter((c): c is string => !!c);
  out.grep = { text: clean(g.text, MAX_TEXT), id: clean(g.id, MAX_TEXT), testId: clean(g.testId, MAX_TEXT), ...(classes.length ? { classes } : {}) };
  for (const k of ['text', 'id', 'testId'] as const) if (out.grep[k] === undefined) delete out.grep[k];
  return out;
}

export interface SourceEntry {
  /** Component name; undefined for the element itself (shown as its tag). */
  name?: string;
  /** Tag of the element an inspector attribute or element location belongs to, e.g. "button". */
  tag?: string;
  /** Workspace path (or the path/URL as given), with ":line:col" when known. */
  location?: string;
  /** The location was not found in the workspace folders. */
  outside?: boolean;
  /** Said in parentheses after the location ("data-v-inspector", "source map not found: ..."). */
  note?: string;
  /** Library code (node_modules, ignore-listed): counted, not listed. */
  library?: boolean;
  /** The location is in the bundled script, not a source file. */
  bundled?: boolean;
  /** Why the location is not a source file ("source map not found: ... answered 404"). Said once when shared. */
  problem?: string;
}

/** What the agent can search the workspace for instead. */
export interface GrepHints {
  text?: string;
  id?: string;
  testId?: string;
  classes?: string[];
}

export type SourceResult =
  | {
      kind: 'found';
      label: string;
      /** e.g. ["Vue 3"], ["React 19"], [] when only an inspector attribute was found. */
      frameworks: string[];
      /** e.g. "data-v-inspector" when only an attribute was found. */
      attribute?: string;
      linesFromMaps: boolean;
      entries: SourceEntry[];
      /** Workspace folder names (one: paths are relative to it). */
      roots: string[];
      notes: string[];
    }
  /** `certain`: the framework's production markers; otherwise only the file data are missing (it may be a dev build without them). */
  | { kind: 'production'; label: string; evidence: string; certain?: boolean; grep: GrepHints }
  | { kind: 'names-only'; label: string; why: string; names: string[]; grep: GrepHints }
  | { kind: 'none'; label: string; grep: GrepHints }
  | { kind: 'unsupported'; label: string; framework: string; grep: GrepHints };

/** Most entries listed. */
export const MAX_ENTRIES = 12;

const quote = (s: string) => JSON.stringify(s);

/** `"Add to cart" (id "add", data-testid "add-to-cart", classes "a b")`, or undefined when there is nothing to search for. */
export function grepPhrase(g: GrepHints): string | undefined {
  const text = clean(g.text, MAX_TEXT);
  const id = clean(g.id, MAX_TEXT);
  const testId = clean(g.testId, MAX_TEXT);
  const classes = (g.classes ?? []).map(c => clean(c, 40)).filter(Boolean);
  const extras = [id && `id ${quote(id)}`, testId && `data-testid ${quote(testId)}`, classes.length && `classes ${quote(classes.join(' '))}`].filter(Boolean) as string[];
  if (text) return extras.length ? `${quote(text)} (${extras.join(', ')})` : quote(text);
  return extras.length ? extras.join(', ') : undefined;
}

function searchInstead(g: GrepHints, lead: string): string {
  const phrase = grepPhrase(g);
  return phrase ? `${lead}: ${phrase}.` : `${lead}; it has no text, id or classes to search for, so look at its parent (browser_snapshot).`;
}

export function formatSource(result: SourceResult): string {
  const text = formatAny(result);
  return text.length > MAX_RESULT ? `${text.slice(0, MAX_RESULT - 1)}…` : text;
}

function formatAny(result: SourceResult): string {
  switch (result.kind) {
    case 'production':
      return result.certain === false
        ? `No source locations for ${result.label}: ${result.evidence}, but without file locations (a production build, or a development build without the framework's file info). Open the app from its development server for locations, or ${searchInstead(result.grep, "search the workspace for the element's text")}`
        : `No source locations for ${result.label}: ${result.evidence}, but this is a production build (no file locations; component names are minified). Open the app from its development server for locations, or ${searchInstead(result.grep, "search the workspace for the element's text")}`;
    case 'none':
      return `No framework information for ${result.label}: neither it nor its ancestors carry React, Vue or Svelte development data or inspector attributes (plain or server-rendered HTML, another framework, or a production build). ${searchInstead(result.grep, 'Search the workspace for its text instead')}`;
    case 'unsupported':
      return `No source locations for ${result.label}: ${result.framework} is not supported. ${searchInstead(result.grep, 'Search the workspace for its text instead')}`;
    case 'names-only': {
      const names = result.names.slice(0, MAX_ENTRIES).map((n, i) => `${i + 1}. ${clean(n, MAX_NAME) ?? 'Anonymous'}`);
      if (result.names.length > MAX_ENTRIES) names.push(`+${result.names.length - MAX_ENTRIES} more`);
      return [`Components of ${result.label} (${result.why}; no file locations):`, ...names, `Search the workspace for these component names, or ${searchInstead(result.grep, "for the element's text")}`].join('\n');
    }
    case 'found':
      return formatFound(result);
  }
}

function formatFound(r: Extract<SourceResult, { kind: 'found' }>): string {
  const what = r.frameworks.length ? `${r.frameworks.join(' + ')}, development build` : `inspector attribute ${r.attribute ?? ''}`.trim();
  const lines = [`Source of ${r.label} (${what}${r.linesFromMaps ? '; lines from source maps' : ''}):`];
  const shown = r.entries.filter(e => !e.library);
  const libraries = r.entries.length - shown.length;
  // A problem several entries share (one bundle without its map) is said once, after the list.
  const problems = new Map<string, number>();
  for (const e of shown.slice(0, MAX_ENTRIES)) if (e.problem) problems.set(e.problem, (problems.get(e.problem) ?? 0) + 1);
  const shared = [...problems].filter(([, n]) => n > 1).map(([p]) => p);
  shown.slice(0, MAX_ENTRIES).forEach((e, i) => {
    const tag = clean(e.tag, MAX_TAG);
    const who = clean(e.name, MAX_NAME) ?? (tag ? `<${tag}>` : 'element');
    const location = clean(e.location, MAX_PATH);
    const where = location ? ` ${location}` : '';
    const problem = e.problem && !shared.includes(e.problem) ? e.problem : undefined;
    const notes = [clean(e.note, 100), clean(problem, MAX_PATH), e.outside && 'not found in the workspace folders'].filter(Boolean).join('; ');
    lines.push(`${i + 1}. ${who}${where}${notes ? ` (${notes})` : ''}`);
  });
  for (const p of shared) {
    const c = clean(p, MAX_PATH)!;
    lines.push(`${c[0]!.toUpperCase()}${c.slice(1)}, so those lines are in the bundled script; search the workspace for the component names.`);
  }
  if (shown.length > MAX_ENTRIES) lines.push(`+${shown.length - MAX_ENTRIES} outer components not listed.`);
  if (libraries) lines.push(`${libraries} library component${libraries === 1 ? '' : 's'} left out (node_modules).`);
  const tail: string[] = [];
  const anyMapped = shown.some(e => e.location && !e.outside && !e.bundled);
  if (anyMapped && r.roots.length === 1) tail.push(`Paths are relative to the workspace folder ${quote(r.roots[0]!)}.`);
  else if (anyMapped && r.roots.length > 1) tail.push('Paths start with the workspace folder name.');
  tail.push(...r.notes);
  if (tail.length) lines.push(tail.join(' '));
  return lines.join('\n');
}
