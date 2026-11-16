// The text browser_inspect returns (source.ts gathers the facts). Pure.

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
  | { kind: 'production'; label: string; evidence: string; grep: GrepHints }
  | { kind: 'names-only'; label: string; why: string; names: string[]; grep: GrepHints }
  | { kind: 'none'; label: string; grep: GrepHints }
  | { kind: 'unsupported'; label: string; framework: string; grep: GrepHints };

/** Most entries listed. */
export const MAX_ENTRIES = 12;

const quote = (s: string) => JSON.stringify(s);

/** `"Add to cart" (id "add", data-testid "add-to-cart", classes "a b")`, or undefined when there is nothing to search for. */
export function grepPhrase(g: GrepHints): string | undefined {
  const extras = [g.id && `id ${quote(g.id)}`, g.testId && `data-testid ${quote(g.testId)}`, g.classes?.length && `classes ${quote(g.classes.join(' '))}`].filter(Boolean) as string[];
  if (g.text) return extras.length ? `${quote(g.text)} (${extras.join(', ')})` : quote(g.text);
  return extras.length ? extras.join(', ') : undefined;
}

function searchInstead(g: GrepHints, lead: string): string {
  const phrase = grepPhrase(g);
  return phrase ? `${lead}: ${phrase}.` : `${lead}; it has no text, id or classes to search for, so look at its parent (browser_snapshot).`;
}

export function formatSource(result: SourceResult): string {
  switch (result.kind) {
    case 'production':
      return `No source locations for ${result.label}: ${result.evidence}, but this is a production build (no file locations; component names are minified). Open the app from its development server for locations, or ${searchInstead(result.grep, "search the workspace for the element's text")}`;
    case 'none':
      return `No framework information for ${result.label}: neither it nor its ancestors carry React, Vue or Svelte development data or inspector attributes (plain or server-rendered HTML, another framework, or a production build). ${searchInstead(result.grep, 'Search the workspace for its text instead')}`;
    case 'unsupported':
      return `No source locations for ${result.label}: ${result.framework} is not supported. ${searchInstead(result.grep, 'Search the workspace for its text instead')}`;
    case 'names-only': {
      const names = result.names.slice(0, MAX_ENTRIES).map((n, i) => `${i + 1}. ${n}`);
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
    const who = e.name ?? (e.tag ? `<${e.tag}>` : 'element');
    const where = e.location ? ` ${e.location}` : '';
    const problem = e.problem && !shared.includes(e.problem) ? e.problem : undefined;
    const notes = [e.note, problem, e.outside && 'not found in the workspace folders'].filter(Boolean).join('; ');
    lines.push(`${i + 1}. ${who}${where}${notes ? ` (${notes})` : ''}`);
  });
  for (const p of shared) lines.push(`${p[0]!.toUpperCase()}${p.slice(1)}, so those lines are in the bundled script; search the workspace for the component names.`);
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
