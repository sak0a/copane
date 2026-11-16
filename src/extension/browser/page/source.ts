// browser_inspect: which code renders an element. Reads the frameworks' development data in the
// page's own world (SOURCE_PROBE), resolves bundled locations through source maps (sourceFetch.ts,
// sourceMap.ts), maps paths to workspace files (workspacePaths.ts) and formats the answer
// (sourceReport.ts).
//
// Framework data are expando properties set by page JavaScript, invisible in the bridge's isolated
// world; the element handle of an ElementTarget is in the page's own world, so the probe runs there.
// It only reads. Everything it returns is page-controlled and is checked by `sanitizeProbe`.
import { readdirSync, statSync } from 'node:fs';
import { ToolError } from '../../core/errors';
import type { PageCall } from './call';
import { scriptMap, type MapResult } from './sourceFetch';
import { SourceMapError } from './sourceMap';
import { formatSource, sanitizeProbe, type SourceEntry, type SourceResult } from './sourceReport';
import { elementCreationFrames, hasCommonReactName, isLibraryUrl, parseInspectorPath, splitLocation, svelteLocation, type FileLocation } from './stackFrames';
import type { ElementTarget } from './targets';
import { displayPath, mapToWorkspace, rootName, type PathPlatform, type WorkspaceFs } from './workspacePaths';

/**
 * Element (this), page's own world. Walks from the element up (across shadow hosts) and collects
 * inspector attributes and React, Vue 3, Vue 2 and Svelte development data, each with the depth it
 * was found at. DOM properties are read through the prototypes' own accessors, because a form's
 * controls shadow them (`<input name="id">` makes `form.id` that input). Every step is guarded.
 */
export const SOURCE_PROBE = `function () {
  const out = { tag: '', grep: {} };
  const getter = (proto, name) => { try { const d = Object.getOwnPropertyDescriptor(proto, name); return d && d.get; } catch (e) { return undefined; } };
  const call = (fn, self, ...args) => { try { return fn ? fn.apply(self, args) : undefined; } catch (e) { return undefined; } };
  const NODE_TYPE = getter(Node.prototype, 'nodeType');
  const PARENT_ELEMENT = getter(Node.prototype, 'parentElement');
  const PARENT_NODE = getter(Node.prototype, 'parentNode');
  const TAG_NAME = getter(Element.prototype, 'tagName');
  const ATTRIBUTES = getter(Element.prototype, 'attributes');
  const HOST = getter(ShadowRoot.prototype, 'host');
  const INNER_TEXT = getter(HTMLElement.prototype, 'innerText');
  const TEXT_CONTENT = getter(Node.prototype, 'textContent');
  const GET_ATTRIBUTE = Element.prototype.getAttribute;
  const attr = (el, name) => { const v = call(GET_ATTRIBUTE, el, name); return typeof v === 'string' ? v : null; };
  const tagOf = el => { const t = call(TAG_NAME, el); return typeof t === 'string' ? t.toLowerCase().slice(0, 30) : 'element'; };
  const up = el => {
    const p = call(PARENT_ELEMENT, el);
    if (p) return p;
    const n = call(PARENT_NODE, el);
    return n && call(NODE_TYPE, n) === 11 ? call(HOST, n) || null : null;
  };
  const str = (v, max) => typeof v === 'string' ? v.slice(0, max) : undefined;
  const num = v => typeof v === 'number' && isFinite(v) ? v : undefined;
  const isObj = v => v !== null && typeof v === 'object' && !(v instanceof Node);
  const own = (el, key) => { try { const v = el[key]; return isObj(v) ? v : undefined; } catch (e) { return undefined; } };
  const el0 = call(NODE_TYPE, this) === 1 ? this : call(PARENT_ELEMENT, this);
  if (!el0) return out;
  out.tag = tagOf(el0);
  const els = [];
  for (let el = el0; el && els.length < 50; el = up(el)) els.push(el);
  const base = f => typeof f === 'string' ? f.split(/[\\\\/]/).pop().replace(/\\.[^.]*$/, '') : undefined;
  try {
    for (let depth = 0; depth < els.length; depth++) {
      const el = els[depth];
      const tag = tagOf(el);
      const insp = attr(el, 'data-insp-path');
      if (insp) { out.attr = { kind: 'data-insp-path', value: insp.slice(0, 400), tag, depth }; break; }
      const vi = attr(el, 'data-v-inspector');
      if (vi) { out.attr = { kind: 'data-v-inspector', value: vi.slice(0, 400), tag, depth }; break; }
      const rp = attr(el, 'data-inspector-relative-path');
      if (rp) { out.attr = { kind: 'react-dev-inspector', value: rp.slice(0, 400), line: attr(el, 'data-inspector-line'), column: attr(el, 'data-inspector-column'), tag, depth }; break; }
    }
  } catch (e) {}
  try {
    let fiber, depth = 0;
    for (; depth < els.length; depth++) {
      let keys = [];
      try { keys = Object.keys(els[depth]); } catch (e) {}
      const key = keys.find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
      if (key) { fiber = own(els[depth], key); break; }
    }
    if (fiber) {
      const name = v => { try { return typeof v === 'string' && v ? v.slice(0, 200) : undefined; } catch (e) { return undefined; } };
      const nameOfType = t => {
        try {
          if (typeof t === 'string') return name(t);
          if (!t || (typeof t !== 'function' && typeof t !== 'object')) return undefined;
          return name(t.displayName) || name(t.name) || (t.render && (name(t.render.displayName) || name(t.render.name))) || (t.type && (name(t.type.displayName) || name(t.type.name))) || undefined;
        } catch (e) { return undefined; }
      };
      const nameOf = f => { try { return nameOfType(f.type) || name(f.name) || 'Anonymous'; } catch (e) { return 'Anonymous'; } };
      const locOf = f => {
        try {
          const s = f._debugSource;
          if (s && typeof s.fileName === 'string') return { source: { fileName: s.fileName.slice(0, 1000), lineNumber: num(s.lineNumber), columnNumber: num(s.columnNumber) } };
          const st = f._debugStack;
          const text = typeof st === 'string' ? st : st && typeof st === 'object' ? st.stack : undefined;
          if (typeof text === 'string') return { stack: text.slice(0, 4000) };
        } catch (e) {}
        return {};
      };
      let dev = false;
      try { dev = '_debugOwner' in fiber; } catch (e) {}
      const chain = [];
      // Owners: who created each element (the component whose JSX it is), which is what renders it.
      const seen = new Set();
      try {
        for (let cur = fiber; cur && chain.length < 15; ) {
          const owner = cur._debugOwner;
          if (!isObj(owner) || seen.has(owner)) break;
          seen.add(owner);
          chain.push({ name: nameOf(owner), ...locOf(cur) });
          cur = owner;
        }
      } catch (e) {}
      if (!chain.length) {
        try {
          let pending = locOf(fiber);
          const seenReturn = new Set();
          for (let f = fiber.return; isObj(f) && !seenReturn.has(f) && chain.length < 15; f = f.return) {
            seenReturn.add(f);
            if ([0, 1, 11, 14, 15].includes(f.tag)) { chain.push({ name: nameOf(f), ...pending }); pending = locOf(f); }
          }
        } catch (e) {}
      }
      out.react = { dev, depth, chain };
    }
  } catch (e) {}
  try {
    const depth = els.findIndex(e => own(e, '__vueParentComponent'));
    if (depth >= 0) {
      const chain = [];
      const seen = new Set();
      for (let c = own(els[depth], '__vueParentComponent'); isObj(c) && !seen.has(c) && chain.length < 15; c = c.parent) {
        seen.add(c);
        const t = isObj(c.type) || typeof c.type === 'function' ? c.type : {};
        const file = str(t.__file, 1000);
        chain.push({ name: str(t.name, 200) || str(t.__name, 200) || str(t.displayName, 200) || base(file) || 'Anonymous', file });
      }
      out.vue3 = { depth, chain };
    } else {
      const app = els.some(e => own(e, '__vue_app__') || attr(e, 'data-v-app') !== null);
      const scoped = els.some(e => { const a = call(ATTRIBUTES, e); for (let i = 0; a && i < a.length && i < 50; i++) if (/^data-v-[0-9a-f]{8}$/.test(a[i].name)) return true; return false; });
      if (app) out.vueProd = 'app';
      else if (scoped) out.vueProd = 'scoped';
    }
  } catch (e) {}
  try {
    const depth = els.findIndex(e => own(e, '__vue__'));
    if (depth >= 0) {
      const chain = [];
      const seen = new Set();
      for (let vm = own(els[depth], '__vue__'); isObj(vm) && !seen.has(vm) && chain.length < 15; vm = vm.$parent) {
        seen.add(vm);
        const o = isObj(vm.$options) ? vm.$options : {};
        const file = str(o.__file, 1000);
        const root = !isObj(vm.$parent);
        chain.push({ name: str(o.name, 200) || str(o._componentTag, 200) || base(file) || (root ? 'Root' : 'Anonymous'), file, root });
      }
      out.vue2 = { depth, chain };
    }
  } catch (e) {}
  try {
    const depth = els.findIndex(e => own(e, '__svelte_meta'));
    if (depth >= 0) {
      const meta = own(els[depth], '__svelte_meta');
      const loc = isObj(meta.loc) ? meta.loc : {};
      // Svelte 4 always writes char; Svelte 5 never (5.0-5.35 without parent, later with it).
      const version = 'char' in loc ? 4 : 5;
      const parents = [];
      const seen = new Set();
      for (let p = meta.parent; isObj(p) && !seen.has(p) && parents.length < 15; p = p.parent) {
        seen.add(p);
        if (p.type === 'component') parents.push({ file: str(p.file, 1000), line: num(p.line), column: num(p.column), tag: str(p.componentTag, 200) });
      }
      out.svelte = { depth, version, loc: { file: str(loc.file, 1000), line: num(loc.line), column: num(loc.column) }, parents };
    } else if (els.some(e => /(^|\\s)svelte-[a-z0-9]{6,}(\\s|$)/.test(attr(e, 'class') || ''))) out.svelteProd = true;
  } catch (e) {}
  try { out.angular = Boolean(call(Document.prototype.querySelector, document, '[ng-version]')); } catch (e) {}
  try {
    const raw = call(INNER_TEXT, el0);
    const text = (typeof raw === 'string' ? raw : String(call(TEXT_CONTENT, el0) || '')).slice(0, 2000).replace(/\\s+/g, ' ').trim();
    if (text) out.grep.text = text.slice(0, 60);
    const id = attr(el0, 'id');
    if (id) out.grep.id = id.slice(0, 100);
    const testId = attr(el0, 'data-testid');
    if (testId) out.grep.testId = testId.slice(0, 100);
    const classes = (attr(el0, 'class') || '').split(/\\s+/).filter(c => /^[a-zA-Z][a-zA-Z_-]*$/.test(c) && !/^svelte-/.test(c)).slice(0, 3);
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

/** How long one browser_inspect call waits for scripts and maps in total. */
const CALL_DEADLINE_MS = 8000;
/** How long a workspace view (file checks, folder listing) is reused. */
const WORKSPACE_TTL_MS = 5000;

/** A view of the workspace: its roots and cached file checks and folder listings, shared for a few seconds. */
class Workspace {
  readonly roots: string[];
  readonly platform: PathPlatform;
  private readonly stats = new Map<string, boolean>();
  private readonly folderCache = new Map<string, string[]>();
  readonly fs: WorkspaceFs;
  readonly created = Date.now();

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
          if (this.stats.size > 5000) this.stats.clear();
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

let sharedWorkspace: Workspace | undefined;

/** The workspace view for these roots, reused for WORKSPACE_TTL_MS (originalLocation is called for several locations in a row). */
function workspaceFor(call: PageCall): Workspace {
  const roots = [...(call.env.services.window.workspaceFolders ?? [])];
  const ws = sharedWorkspace;
  if (ws && Date.now() - ws.created < WORKSPACE_TTL_MS && ws.roots.length === roots.length && ws.roots.every((r, i) => r === roots[i])) return ws;
  return (sharedWorkspace = new Workspace(roots));
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

class CallTimeout extends Error {}

/** Resolves locations for one call: through source maps (cached per tab) and the workspace. */
class Resolver {
  readonly notes = new Set<string>();
  private readonly deadline = Date.now() + CALL_DEADLINE_MS;
  private readonly loaderId: string | undefined;

  constructor(
    private readonly call: PageCall,
    readonly ws: Workspace,
  ) {
    this.loaderId = this.currentLoader();
  }

  private currentLoader(): string | undefined {
    return this.call.frame ? this.call.frame.loaderId : this.call.state.loaderId;
  }

  private navigated(): ToolError | undefined {
    if (this.currentLoader() === this.loaderId) return undefined;
    return new ToolError('failed', `The page in ${this.call.tab.id} navigated while its source maps were loading, so the element is gone. Take a snapshot and inspect again.`);
  }

  /** Throws when the page (or the element's frame) navigated since the call started: the data are gone. */
  checkDocument(): void {
    const err = this.navigated();
    if (err) throw err;
  }

  file(loc: FileLocation | undefined): Resolved {
    if (!loc) return {};
    const m = this.ws.map(loc.file);
    return { location: withLine(m.display, loc.line, loc.column), outside: m.outside, library: m.library };
  }

  /**
   * The script's map, within the call's deadline, honouring cancellation, and ending at once when the
   * document changes (page events, and a poll for a frame's own navigation).
   */
  private mapOf(url: string): Promise<MapResult> {
    const signal = this.call.signal;
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new ToolError('cancelled', 'Cancelled.'));
      const gone = this.navigated();
      if (gone) return reject(gone);
      const onAbort = () => finish(() => reject(new ToolError('cancelled', 'Cancelled.')));
      const onChange = () => {
        const err = this.navigated();
        if (err) finish(() => reject(err));
      };
      const timer = setTimeout(() => finish(() => reject(new CallTimeout())), Math.max(0, this.deadline - Date.now()));
      const poll = setInterval(onChange, 100);
      const sub = this.call.state.onDidChange?.(onChange);
      let done = false;
      const finish = (fn: () => void) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearInterval(poll);
        sub?.dispose();
        signal.removeEventListener('abort', onAbort);
        fn();
      };
      signal.addEventListener('abort', onAbort, { once: true });
      scriptMap(this.call, url).then(r => {
        const err = this.navigated();
        finish(() => (err ? reject(err) : resolve(r)));
      });
    });
  }

  /** A generated position (1-based) in a script: through its source map when it has one. */
  async generated(url: string, line: number, column: number): Promise<Resolved> {
    if (/^webpack-internal:/i.test(url)) return this.file({ file: url, line, column });
    const pageUrl = this.call.frame?.url ?? this.call.state.url;
    const bundled = withLine(shortUrl(url, pageUrl).slice(0, 300), line, column);
    if (!/^https?:/i.test(url)) return { location: bundled, bundled: true, problem: 'not loaded: only http and https scripts are read' };
    if (isLibraryUrl(url)) return { library: true };
    let result: MapResult;
    try {
      result = await this.mapOf(url);
    } catch (err) {
      if (err instanceof CallTimeout) return { location: bundled, bundled: true, problem: `script and source map not loaded within ${CALL_DEADLINE_MS / 1000} s` };
      throw err;
    }
    if ('error' in result) {
      if (result.missing) {
        // A script served as written (no bundler): its URL path may be the file itself.
        const m = this.ws.map(url);
        if (!m.outside) return { location: withLine(m.display, line, column), library: m.library };
        return { location: bundled, bundled: true, problem: 'no source map' };
      }
      return { location: bundled, bundled: true, problem: result.error };
    }
    let pos;
    try {
      pos = result.map.lookup(line - 1, column - 1);
    } catch (err) {
      if (err instanceof SourceMapError) return { location: bundled, bundled: true, problem: `unusable source map: ${err.message}` };
      throw err;
    }
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
    const frames = elementCreationFrames(stack);
    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i]!;
      const resolved = await this.generated(frame.url, frame.line, frame.column);
      // React bundled into the app's script: its createElement/jsx resolves to library code; the
      // element was written in the next frame.
      if (resolved.library && hasCommonReactName(frame) && i + 1 < frames.length) continue;
      return resolved;
    }
    return {};
  }
}

/** The text of browser_inspect for an element. */
export async function elementSource(call: PageCall, target: ElementTarget): Promise<string> {
  const at = target.call;
  const probe = sanitizeProbe(await at.callOn<unknown>(target.objectId, SOURCE_PROBE, [], { returnByValue: true, timeoutMs: 5000 }));
  const ws = workspaceFor(call);
  const resolver = new Resolver(at, ws);
  type Entry = SourceEntry & { fromMap?: boolean };
  /** Entries per source of data, with the depth it was found at: listed innermost first. */
  const groups: Array<{ depth: number; entries: Entry[] }> = [];
  const group = (depth: number) => {
    const g = { depth, entries: [] as Entry[] };
    groups.push(g);
    return (entry: Pick<SourceEntry, 'name' | 'tag' | 'note'>, resolved: Resolved) => g.entries.push({ ...entry, ...resolved });
  };
  const frameworks: string[] = [];
  let names: string[] = [];
  let namesWhy = '';
  let uncertain: string | undefined;

  if (probe.attr) {
    const a = probe.attr;
    const loc: FileLocation | undefined = a.kind === 'react-dev-inspector' ? { file: a.value, line: a.line || undefined, column: a.column || undefined } : parseInspectorPath(a.value);
    group(a.depth)({ tag: a.tag, note: a.depth === 0 ? a.kind : `${a.kind}, on an ancestor` }, resolver.file(loc));
  }

  if (probe.react?.dev && probe.react.chain.length) {
    const react = probe.react;
    const usesStacks = react.chain.some(c => c.stack) && !react.chain.some(c => c.source);
    const resolved = await Promise.all(
      react.chain.map(c => (c.source ? Promise.resolve(resolver.file({ file: c.source.fileName, line: c.source.lineNumber, column: c.source.columnNumber })) : resolver.stack(c.stack))),
    );
    resolver.checkDocument();
    if (resolved.some(r => r.location || r.library)) {
      frameworks.push(usesStacks ? 'React 19' : 'React');
      const add = group(react.depth);
      react.chain.forEach((c, i) => add({ name: c.name, note: i === 0 && resolved[i]!.location ? (react.depth === 0 ? 'where the element is written' : 'where its ancestor is written') : undefined }, resolved[i]!));
    } else {
      names = react.chain.map(c => c.name);
      namesWhy = 'React development build without JSX source info';
    }
  }

  if (probe.vue3?.chain.length) {
    const vue = probe.vue3;
    if (vue.chain.some(c => c.file)) {
      frameworks.push('Vue 3');
      const add = group(vue.depth);
      for (const c of vue.chain) add({ name: c.name }, c.file ? resolver.file({ file: c.file }) : {});
      resolver.notes.add('Vue gives files, not lines, for components.');
    } else if (!names.length) {
      names = vue.chain.map(c => c.name);
      namesWhy = 'Vue 3 development build without component files (__file)';
    }
  }

  if (probe.vue2?.chain.length) {
    const vue = probe.vue2;
    if (vue.chain.some(c => c.file)) {
      frameworks.push('Vue 2');
      const add = group(vue.depth);
      for (const c of vue.chain) add({ name: c.name }, c.file ? resolver.file({ file: c.file }) : {});
      resolver.notes.add('Vue gives files, not lines, for components.');
    } else if (!names.length) {
      // No __file anywhere: a production build, or a development build without vue-loader. The root
      // instance (new Vue()) has no name worth listing.
      const named = vue.chain.filter(c => !c.root).map(c => c.name);
      if (named.length) {
        names = named;
        namesWhy = 'Vue 2 without component files (__file): a production build, or no vue-loader';
      } else uncertain = 'Vue 2 is present (only its root instance, no component files)';
    }
  }

  if (probe.svelte) {
    const s = probe.svelte;
    const own = svelteLocation(s.loc, s.version);
    if (own) {
      frameworks.push(`Svelte ${s.version}`);
      const add = group(s.depth);
      add({ name: baseName(own.file), note: 'where the element is written' }, resolver.file(own));
      for (const p of s.parents) {
        const loc = svelteLocation(p, s.version);
        if (loc) add({ name: baseName(loc.file), note: p.tag ? `renders <${p.tag}>` : undefined }, resolver.file(loc));
      }
    }
  }

  // Innermost first across frameworks too: data found nearer the element come first (stable for ties).
  const entries = groups.sort((a, b) => a.depth - b.depth).flatMap(g => g.entries);
  const grep = probe.grep;
  const label = target.label;
  let result: SourceResult;
  if (entries.some(e => e.location || e.library)) {
    if (!ws.roots.length) resolver.notes.add('No workspace folder is open, so paths are shown as the page reports them.');
    result = { kind: 'found', label, frameworks, attribute: probe.attr?.kind, linesFromMaps: entries.some(e => e.fromMap), entries, roots: ws.roots.map(rootName), notes: [...resolver.notes] };
  } else if (names.length) result = { kind: 'names-only', label, why: namesWhy, names, grep };
  else if (probe.angular) result = { kind: 'unsupported', label, framework: 'Angular', grep };
  else if (probe.react && !probe.react.dev) result = { kind: 'production', label, evidence: 'React is present', grep };
  else if (uncertain) result = { kind: 'production', label, evidence: uncertain, certain: false, grep };
  else if (probe.vueProd) result = { kind: 'production', label, evidence: probe.vueProd === 'app' ? 'Vue 3 is present (data-v-app)' : 'Vue is present (scoped-style data-v-… attributes)', grep };
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
 * change); uses the same per-tab source map cache and a workspace view shared for a few seconds.
 */
export async function originalLocation(call: PageCall, location: string): Promise<string | undefined> {
  const loc = splitLocation(location);
  if (!loc) return undefined;
  try {
    const resolved = await new Resolver(call, workspaceFor(call)).generated(loc.url, loc.line, loc.column);
    if (!resolved.location || resolved.outside || resolved.library || resolved.bundled) return undefined;
    return resolved.location;
  } catch {
    return undefined;
  }
}
