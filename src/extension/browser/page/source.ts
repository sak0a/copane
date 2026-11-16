// browser_inspect: which code renders an element. Reads the frameworks' development data in the
// page's own world (SOURCE_PROBE), resolves bundled locations through source maps (sourceFetch.ts,
// sourceMap.ts), maps paths to workspace files (workspacePaths.ts) and formats the answer
// (sourceReport.ts).
//
// Framework data are expando properties set by page JavaScript, invisible in the bridge's isolated
// world; the element handle of an ElementTarget is in the page's own world, so the probe runs there.
// It only reads.
import { readdirSync, statSync } from 'node:fs';
import type { PageCall } from './call';
import { isLibraryUrl, elementCreationFrame, parseInspectorPath, splitLocation, svelteLocation, type FileLocation } from './stackFrames';
import { scriptMap } from './sourceFetch';
import { formatSource, type GrepHints, type SourceEntry, type SourceResult } from './sourceReport';
import type { ElementTarget } from './targets';
import { displayPath, mapToWorkspace, rootName, type PathPlatform, type WorkspaceFs } from './workspacePaths';

/** What SOURCE_PROBE returns. */
interface Probe {
  tag: string;
  attr?: { kind: string; value: string; line?: string; column?: string; tag: string; self: boolean };
  react?: { dev: boolean; self: boolean; chain: Array<{ name: string; source?: { fileName?: string; lineNumber?: number; columnNumber?: number }; stack?: string }> };
  vue3?: { dev: boolean; chain: Array<{ name: string; file?: string }> };
  vue2?: { dev: boolean; chain: Array<{ name: string; file?: string }> };
  svelte?: { version: 4 | 5; loc?: { file?: string; line?: number; column?: number }; parents: Array<{ file?: string; line?: number; column?: number; tag?: string }> };
  svelteProd?: boolean;
  vueProd?: string;
  angular?: boolean;
  grep: GrepHints;
}

/**
 * Element (this), page's own world. Walks from the element up (across shadow hosts) and collects
 * inspector attributes and React, Vue 3, Vue 2 and Svelte development data. Every step is guarded.
 */
export const SOURCE_PROBE = `function () {
  const out = { tag: '', grep: {} };
  const el0 = this.nodeType === 1 ? this : this.parentElement;
  if (!el0) return out;
  out.tag = el0.tagName.toLowerCase();
  const up = el => el.parentElement || (el.parentNode && el.parentNode.host) || null;
  const chainOf = () => { const list = []; for (let el = el0, i = 0; el && i < 50; el = up(el), i++) list.push(el); return list; };
  const els = chainOf();
  const base = f => typeof f === 'string' ? f.split(/[\\\\/]/).pop().replace(/\\.[^.]*$/, '') : undefined;
  try {
    for (const el of els) {
      const self = el === el0;
      const tag = el.tagName.toLowerCase();
      const insp = el.getAttribute('data-insp-path');
      if (insp) { out.attr = { kind: 'data-insp-path', value: insp, tag, self }; break; }
      const vi = el.getAttribute('data-v-inspector');
      if (vi) { out.attr = { kind: 'data-v-inspector', value: vi, tag, self }; break; }
      const rp = el.getAttribute('data-inspector-relative-path');
      if (rp) { out.attr = { kind: 'react-dev-inspector', value: rp, line: el.getAttribute('data-inspector-line') || undefined, column: el.getAttribute('data-inspector-column') || undefined, tag, self }; break; }
    }
  } catch (e) {}
  try {
    let host, key;
    for (const el of els) {
      key = Object.keys(el).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
      if (key) { host = el; break; }
    }
    if (host) {
      const fiber = host[key];
      const nameOfType = t => {
        if (!t) return undefined;
        if (typeof t === 'string') return t;
        return t.displayName || t.name || (t.render && (t.render.displayName || t.render.name)) || (t.type && (t.type.displayName || t.type.name)) || undefined;
      };
      const nameOf = f => nameOfType(f && f.type) || (f && typeof f.name === 'string' ? f.name : undefined) || 'Anonymous';
      const locOf = f => {
        try {
          const s = f && f._debugSource;
          if (s && s.fileName) return { source: { fileName: String(s.fileName), lineNumber: s.lineNumber, columnNumber: s.columnNumber } };
          const st = f && f._debugStack;
          const text = st && (typeof st === 'string' ? st : st.stack);
          if (text) return { stack: String(text).slice(0, 4000) };
        } catch (e) {}
        return {};
      };
      const dev = '_debugOwner' in fiber;
      const chain = [];
      // Owners: who created each element (the component whose JSX it is), which is what renders it.
      const seen = new Set();
      for (let cur = fiber; cur && chain.length < 15; ) {
        const owner = cur._debugOwner;
        if (!owner || seen.has(owner)) break;
        seen.add(owner);
        chain.push({ name: nameOf(owner), ...locOf(cur) });
        cur = owner;
      }
      if (!chain.length) {
        let pending = locOf(fiber);
        for (let f = fiber.return; f && chain.length < 15; f = f.return) {
          if ([0, 1, 11, 14, 15].includes(f.tag)) { chain.push({ name: nameOf(f), ...pending }); pending = locOf(f); }
        }
      }
      out.react = { dev, self: host === el0, chain };
    }
  } catch (e) {}
  try {
    const el = els.find(e => e.__vueParentComponent);
    if (el) {
      const chain = [];
      for (let c = el.__vueParentComponent; c && chain.length < 15; c = c.parent) {
        const t = c.type || {};
        chain.push({ name: t.name || t.__name || t.displayName || base(t.__file) || 'Anonymous', file: typeof t.__file === 'string' ? t.__file : undefined });
      }
      out.vue3 = { dev: true, chain };
    } else {
      const app = els.find(e => e.__vue_app__ || e.hasAttribute('data-v-app'));
      const scoped = els.some(e => Array.from(e.attributes).some(a => /^data-v-[0-9a-f]{8}$/.test(a.name)));
      if (app) out.vueProd = 'Vue 3 is present (data-v-app)';
      else if (scoped) out.vueProd = 'Vue is present (scoped-style data-v-… attributes)';
    }
  } catch (e) {}
  try {
    const el = els.find(e => e.__vue__);
    if (el) {
      const chain = [];
      let anyFile = false;
      for (let vm = el.__vue__; vm && chain.length < 15; vm = vm.$parent) {
        const o = vm.$options || {};
        const file = typeof o.__file === 'string' ? o.__file : undefined;
        if (file) anyFile = true;
        chain.push({ name: o.name || o._componentTag || base(file) || (vm.$parent ? 'Anonymous' : 'Root'), file });
      }
      let devtools = false;
      try { devtools = Boolean(el.__vue__.$options._base.config.devtools); } catch (e) {}
      out.vue2 = { dev: anyFile || devtools, chain };
    }
  } catch (e) {}
  try {
    const el = els.find(e => e.__svelte_meta);
    if (el) {
      const meta = el.__svelte_meta;
      const loc = meta.loc || {};
      const version = 'char' in loc || !('parent' in meta) ? 4 : 5;
      const parents = [];
      for (let p = meta.parent; p && parents.length < 15; p = p.parent) {
        if (p.type === 'component') parents.push({ file: p.file, line: p.line, column: p.column, tag: p.componentTag });
      }
      out.svelte = { version, loc: { file: loc.file, line: loc.line, column: loc.column }, parents };
    } else if (els.some(e => typeof e.className === 'string' && /(^|\\s)svelte-[a-z0-9]{6,}(\\s|$)/.test(e.className))) out.svelteProd = true;
  } catch (e) {}
  try { out.angular = Boolean(document.querySelector('[ng-version]')); } catch (e) {}
  try {
    const text = (el0.innerText || el0.textContent || '').replace(/\\s+/g, ' ').trim();
    if (text) out.grep.text = text.length > 60 ? text.slice(0, 60) : text;
    if (el0.id) out.grep.id = el0.id;
    const testId = el0.getAttribute('data-testid');
    if (testId) out.grep.testId = testId;
    const classes = typeof el0.className === 'string' ? el0.className.split(/\\s+/).filter(c => /^[a-zA-Z][a-zA-Z_-]*$/.test(c) && !/^svelte-/.test(c)).slice(0, 3) : [];
    if (classes.length) out.grep.classes = classes;
  } catch (e) {}
  return out;
}`;

/** A resolved location for one entry. */
interface Resolved {
  location?: string;
  outside?: boolean;
  library?: boolean;
  /** Why the location is not a source file. */
  problem?: string;
  /** A position in the bundled script (its map was not usable). */
  bundled?: boolean;
  /** The line came from a source map. */
  fromMap?: boolean;
}

/** Per-call view of the workspace: its roots and cached file checks. */
class Workspace {
  readonly roots: string[];
  readonly platform: PathPlatform;
  private readonly stats = new Map<string, boolean>();
  private readonly folderCache = new Map<string, string[]>();
  readonly fs: WorkspaceFs;

  constructor(roots: readonly string[]) {
    this.roots = [...roots];
    this.platform = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';
    this.fs = {
      exists: p => {
        let known = this.stats.get(p);
        if (known === undefined) {
          try {
            known = statSync(p).isFile();
          } catch {
            known = false;
          }
          this.stats.set(p, known);
        }
        return known;
      },
      folders: root => {
        let list = this.folderCache.get(root);
        if (!list) this.folderCache.set(root, (list = listFolders(root)));
        return list;
      },
    };
  }

  /** A path as reported by the page, mapped to the workspace. */
  map(raw: string, options: { ignored?: boolean } = {}): { display: string; outside: boolean; library: boolean } {
    const mapped = mapToWorkspace(raw, this.roots, this.fs, this.platform, options);
    const display = displayPath(mapped, this.roots);
    const outside = 'unmapped' in mapped;
    const also = !outside && mapped.alsoIn ? ` (also in ${mapped.alsoIn} other folder${mapped.alsoIn === 1 ? '' : 's'})` : '';
    return { display: display + also, outside, library: mapped.library };
  }
}

/** Folders under a root, up to 3 levels, root-relative; not node_modules or dot folders. At most 400. */
function listFolders(root: string): string[] {
  const out: string[] = [];
  const queue: Array<{ rel: string; depth: number }> = [{ rel: '', depth: 0 }];
  while (queue.length && out.length < 400) {
    const { rel, depth } = queue.shift()!;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(rel ? `${root}/${rel}` : root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
      const child = rel ? `${rel}/${e.name}` : e.name;
      out.push(child);
      if (depth + 1 < 3) queue.push({ rel: child, depth: depth + 1 });
      if (out.length >= 400) break;
    }
  }
  return out;
}

function withLine(display: string, line?: number, column?: number): string {
  if (!line) return display;
  return column ? `${display}:${line}:${column}` : `${display}:${line}`;
}

/** A script URL as shown when it could not be mapped: its path on the page's own origin, else the URL. */
function shortUrl(url: string, pageUrl: string): string {
  try {
    const u = new URL(url);
    return u.origin === new URL(pageUrl).origin ? u.pathname : url;
  } catch {
    return url;
  }
}

/** Resolves locations for one call: through source maps (cached per tab) and the workspace. */
class Resolver {
  readonly notes = new Set<string>();

  constructor(
    private readonly call: PageCall,
    readonly ws: Workspace,
  ) {}

  file(loc: FileLocation | undefined): Resolved {
    if (!loc) return {};
    const m = this.ws.map(loc.file);
    return { location: withLine(m.display, loc.line, loc.column), outside: m.outside, library: m.library };
  }

  /** A generated position (1-based) in a script: through its source map when it has one. */
  async generated(url: string, line: number, column: number): Promise<Resolved> {
    if (/^webpack-internal:/i.test(url)) return this.file({ file: url, line, column });
    if (!/^(https?|file):/i.test(url)) return { location: withLine(url, line, column), outside: true };
    if (isLibraryUrl(url)) return { library: true };
    const pageUrl = this.call.frame?.url ?? this.call.state.url;
    const bundled = withLine(shortUrl(url, pageUrl), line, column);
    const result = await scriptMap(this.call, url);
    if ('error' in result) {
      if (result.missing) {
        // A script served as written (no bundler): its URL path may be the file itself.
        const m = this.ws.map(url);
        if (!m.outside) return { location: withLine(m.display, line, column), library: m.library };
        return { location: bundled, bundled: true, problem: 'no source map' };
      }
      return { location: bundled, bundled: true, problem: result.error };
    }
    const pos = result.map.lookup(line - 1, column - 1);
    if (!pos) return { location: bundled, bundled: true, problem: 'position not in its source map' };
    const m = this.ws.map(pos.source, { ignored: pos.ignored });
    if (result.scriptModified && !this.call.frame) {
      const loadedAt = this.call.state.navigations.all().find(n => n.loaderId === this.call.state.loaderId && !n.sameDocument)?.time;
      if (loadedAt && result.scriptModified > loadedAt + 1000) this.notes.add(`Lines may be off: ${shortUrl(url, pageUrl)} was rebuilt after the page loaded; reload the page and inspect again.`);
    }
    return { location: withLine(m.display, pos.line, pos.column), outside: m.outside, library: m.library, fromMap: true };
  }

  async stack(stack: string | undefined): Promise<Resolved> {
    if (!stack) return {};
    const frame = elementCreationFrame(stack);
    if (!frame) return {};
    return this.generated(frame.url, frame.line, frame.column);
  }
}

function roots(call: PageCall): string[] {
  return [...(call.env.services.window.workspaceFolders ?? [])];
}

/** The text of browser_inspect for an element. */
export async function elementSource(call: PageCall, target: ElementTarget): Promise<string> {
  const at = target.call;
  const probe = await at.callOn<Probe>(target.objectId, SOURCE_PROBE, [], { returnByValue: true, timeoutMs: 5000 });
  const ws = new Workspace(roots(call));
  const resolver = new Resolver(at, ws);
  const entries: Array<SourceEntry & { fromMap?: boolean }> = [];
  const frameworks: string[] = [];
  const add = (entry: Pick<SourceEntry, 'name' | 'tag' | 'note'>, resolved: Resolved) => entries.push({ ...entry, ...resolved });
  let names: string[] = [];
  let namesWhy = '';

  if (probe.attr) {
    const a = probe.attr;
    const loc: FileLocation | undefined =
      a.kind === 'react-dev-inspector' ? { file: a.value, line: Number(a.line) || undefined, column: Number(a.column) || undefined } : parseInspectorPath(a.value);
    add({ tag: a.tag, note: a.self ? a.kind : `${a.kind}, on an ancestor` }, resolver.file(loc));
  }

  if (probe.react?.dev && probe.react.chain.length) {
    const chain = probe.react.chain;
    const usesStacks = chain.some(c => c.stack) && !chain.some(c => c.source);
    const resolved = await Promise.all(
      chain.map(c =>
        c.source?.fileName ? Promise.resolve(resolver.file({ file: c.source.fileName, line: c.source.lineNumber, column: c.source.columnNumber })) : resolver.stack(c.stack),
      ),
    );
    if (resolved.some(r => r.location || r.library)) {
      frameworks.push(usesStacks ? 'React 19' : 'React');
      chain.forEach((c, i) => add({ name: c.name, note: i === 0 && resolved[i]!.location ? (probe.react!.self ? 'where the element is written' : 'where its ancestor is written') : undefined }, resolved[i]!));
    } else {
      names = chain.map(c => c.name);
      namesWhy = 'React development build without JSX source info';
    }
  }

  for (const [key, label] of [['vue3', 'Vue 3'], ['vue2', 'Vue 2']] as const) {
    const vue = probe[key];
    if (!vue?.dev || !vue.chain.length) continue;
    if (vue.chain.some(c => c.file)) {
      frameworks.push(label);
      for (const c of vue.chain) add({ name: c.name }, c.file ? resolver.file({ file: c.file }) : {});
      resolver.notes.add('Vue gives files, not lines, for components.');
    } else if (!names.length) {
      names = vue.chain.map(c => c.name);
      namesWhy = `${label} development build without component files (__file)`;
    }
  }

  if (probe.svelte) {
    const s = probe.svelte;
    const own = svelteLocation(s.loc, s.version);
    if (own) {
      frameworks.push(`Svelte ${s.version}`);
      add({ name: baseName(own.file), note: 'where the element is written' }, resolver.file(own));
      for (const p of s.parents) {
        const loc = svelteLocation(p, s.version);
        if (loc) add({ name: baseName(loc.file), note: p.tag ? `renders <${p.tag}>` : undefined }, resolver.file(loc));
      }
    }
  }

  const grep = probe.grep ?? {};
  const label = target.label;
  let result: SourceResult;
  if (entries.some(e => e.location || e.library)) {
    if (!ws.roots.length) resolver.notes.add('No workspace folder is open, so paths are shown as the page reports them.');
    result = {
      kind: 'found',
      label,
      frameworks,
      attribute: probe.attr?.kind,
      linesFromMaps: entries.some(e => e.fromMap),
      entries,
      roots: ws.roots.map(rootName),
      notes: [...resolver.notes],
    };
  } else if (names.length) result = { kind: 'names-only', label, why: namesWhy, names, grep };
  else if (probe.angular) result = { kind: 'unsupported', label, framework: 'Angular', grep };
  else if (probe.react && !probe.react.dev) result = { kind: 'production', label, evidence: 'React is present', grep };
  else if (probe.vue2 && !probe.vue2.dev) result = { kind: 'production', label, evidence: 'Vue 2 is present (__vue__ without __file)', grep };
  else if (probe.vueProd) result = { kind: 'production', label, evidence: probe.vueProd, grep };
  else if (probe.svelteProd) result = { kind: 'production', label, evidence: 'Svelte is present (svelte-xxxx classes, no __svelte_meta)', grep };
  else result = { kind: 'none', label, grep };
  return formatSource(result);
}

function baseName(file: string): string {
  return file.split(/[\\/]/).pop()!.replace(/\.[^.]*$/, '') || file;
}

/**
 * The workspace location of a script position "url:line:col" (1-based, as consoleLog.ts writes it):
 * "file:line:col" relative to the workspace (prefixed by the folder name with several folders), or
 * undefined when it cannot be resolved to a workspace file. For other tools' locations (check after a
 * change); uses the same per-tab source map cache.
 */
export async function originalLocation(call: PageCall, location: string): Promise<string | undefined> {
  const loc = splitLocation(location);
  if (!loc) return undefined;
  try {
    const resolved = await new Resolver(call, new Workspace(roots(call))).generated(loc.url, loc.line, loc.column);
    if (!resolved.location || resolved.outside || resolved.library || resolved.bundled) return undefined;
    return resolved.location;
  } catch {
    return undefined;
  }
}
