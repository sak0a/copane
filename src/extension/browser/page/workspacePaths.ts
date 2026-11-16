// Mapping a path or URL that a page reports for its code (a source map source, a component's __file,
// an inspector attribute, a dev server URL) to a file in the window's workspace folders. Pure: the
// file system is reached through the `WorkspaceFs` callbacks (source.ts gives them `node:fs`).
//
// Roots are the workspace folders as the extension host sees them, which in a remote window is the
// remote side, next to the files. A path from elsewhere (a container's /app, a Windows dev server, a
// build machine) is matched by its trailing segments, longest first.

export type PathPlatform = 'win32' | 'darwin' | 'linux';

export interface WorkspaceFs {
  /** True when the path is an existing file. */
  exists(path: string): boolean;
  /** Folders under a root, root-relative with "/", up to a few levels deep (not node_modules or dot folders). */
  folders?(root: string): string[];
}

export type Mapped =
  | {
      root: string;
      /** Relative to `root`, with "/". */
      rel: string;
      library: boolean;
      /** More than one workspace folder held a file with this path; `rel` is the first. */
      alsoIn?: number;
    }
  | { unmapped: string; library: boolean };

/** Most file checks for one path. */
export const MAX_STATS_PER_PATH = 60;
/** Most trailing segments tried. */
const MAX_SUFFIX_SEGMENTS = 12;

/**
 * Normalizes what pages report: strips query and hash, bundler prefixes (`webpack://app/`,
 * `webpack-internal:///`, `(app-pages-browser)/`, `file://`, `/@fs/`, `vite:`), keeps only the path of
 * an http(s) URL, turns `\` into `/` and `/C:/` into `C:/`, and drops a leading `./`.
 */
export function normalizeSourcePath(raw: string): string {
  let p = raw.trim();
  if (/^https?:\/\//i.test(p)) {
    try {
      p = decodeURIComponent(new URL(p).pathname);
    } catch {
      p = p.replace(/^https?:\/\/[^/]*/i, '');
    }
  } else {
    p = p.replace(/[?#].*$/s, '');
    if (/^file:\/\//i.test(p)) {
      try {
        p = decodeURIComponent(p.replace(/^file:\/\/(localhost)?/i, ''));
      } catch {
        p = p.replace(/^file:\/\/(localhost)?/i, '');
      }
    }
    p = p.replace(/^webpack-internal:\/\/\//i, '').replace(/^webpack:\/\/[^/]*\//i, '').replace(/^vite:/i, '');
  }
  p = p.replace(/^\([^)]*\)\//, '');
  p = p.replace(/\\/g, '/');
  if (p.startsWith('/@fs/')) p = p.slice(4);
  if (/^\/[a-zA-Z]:\//.test(p)) p = p.slice(1);
  while (p.startsWith('./')) p = p.slice(2);
  return resolveDots(p);
}

/** Resolves "." and ".." segments; ".." never climbs above an absolute path's root (a relative path keeps its leading ones). */
function resolveDots(p: string): string {
  if (!/(^|\/)\.\.?(\/|$)/.test(p)) return p;
  const m = /^([a-zA-Z]:\/|\/\/[^/]+\/[^/]+\/|\/)?(.*)$/s.exec(p)!;
  const prefix = m[1] ?? '';
  const out: string[] = [];
  for (const s of m[2]!.split('/')) {
    if (s === '.' || s === '') continue;
    if (s === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else if (!prefix) out.push('..');
      continue;
    }
    out.push(s);
  }
  return prefix + out.join('/');
}

/** True for library code: a path through node_modules (or Vite's pre-bundled dependencies). */
export function isLibraryPath(path: string): boolean {
  return /(^|\/)node_modules\//.test(path) || /(^|\/)\.vite\/deps\//.test(path);
}

function rootKey(root: string): string {
  return root.replace(/\\/g, '/').replace(/\/+$/, '');
}

function joinPath(root: string, rel: string, platform: PathPlatform): string {
  const sep = platform === 'win32' ? '\\' : '/';
  return root.replace(/[\\/]+$/, '') + sep + rel.split('/').join(sep);
}

/**
 * Maps `raw` to a workspace file. Absolute paths inside a root map directly; anything else is matched
 * by its trailing segments (at least 2, or 1 when the path has only one) against each root and the
 * root's folders, longest first, checking at most MAX_STATS_PER_PATH files.
 */
export function mapToWorkspace(raw: string, roots: readonly string[], fs: WorkspaceFs, platform: PathPlatform, options: { ignored?: boolean } = {}): Mapped {
  const path = normalizeSourcePath(raw);
  const library = Boolean(options.ignored) || isLibraryPath(path);
  if (library || !path) return { unmapped: path || raw, library };
  const fold = platform === 'linux' ? (s: string) => s : (s: string) => s.toLowerCase();

  let stats = 0;
  const exists = (p: string) => {
    stats++;
    return fs.exists(p);
  };

  // Absolute and inside a root: that file, if it exists; nothing else is claimed for it.
  for (const root of roots) {
    const key = rootKey(root);
    if (!key) continue;
    if (!fold(path).startsWith(fold(key) + '/')) continue;
    const rel = path.slice(key.length + 1);
    if (rel.split('/').some(s => s === '..' || s === '.' || s === '')) continue;
    if (exists(joinPath(root, rel, platform))) return { root, rel, library };
    return { unmapped: path, library };
  }

  const segments = path.split('/').filter(s => s && s !== '.' && s !== '..');
  const n = segments.length;
  if (n === 0) return { unmapped: path, library };
  const minimum = n === 1 ? 1 : 2;
  // Folders per root, looked up once, and only when the root itself has no match for a suffix.
  const folderSets = new Map<string, Set<string>>();
  const foldersOf = (root: string): Set<string> => {
    let set = folderSets.get(root);
    if (!set) folderSets.set(root, (set = new Set((fs.folders?.(root) ?? []).map(f => fold(f)))));
    return set;
  };
  const folderList = new Map<string, string[]>();

  for (let k = Math.max(0, n - MAX_SUFFIX_SEGMENTS); n - k >= minimum; k++) {
    const suffix = segments.slice(k);
    const rel = suffix.join('/');
    for (const root of roots) {
      if (stats >= MAX_STATS_PER_PATH) return { unmapped: path, library };
      if (exists(joinPath(root, rel, platform))) return { root, rel, library };
    }
    // The same suffix under a folder of a root (a monorepo's apps/web, an app in a subfolder): only
    // folders that contain the suffix's first segment, so few files are checked.
    if (suffix.length < 2 || !fs.folders) continue;
    const found: Array<{ root: string; rel: string }> = [];
    for (const root of roots) {
      const set = foldersOf(root);
      if (set.size === 0) continue;
      let list = folderList.get(root);
      if (!list) folderList.set(root, (list = fs.folders(root)));
      for (const folder of list) {
        if (!set.has(fold(`${folder}/${suffix[0]}`))) continue;
        if (stats >= MAX_STATS_PER_PATH) break;
        const candidate = `${folder}/${rel}`;
        if (exists(joinPath(root, candidate, platform))) found.push({ root, rel: candidate });
        if (found.length >= 3) break;
      }
    }
    if (found.length) return { ...found[0]!, library, ...(found.length > 1 ? { alsoIn: found.length - 1 } : {}) };
  }
  return { unmapped: path, library };
}

/** The basename of a root, for paths shown with more than one workspace folder. */
export function rootName(root: string): string {
  return rootKey(root).split('/').pop() || root;
}

/** How a mapped path is shown: root-relative, prefixed by the root's name when there are several roots. */
export function displayPath(mapped: Mapped, roots: readonly string[]): string {
  if ('unmapped' in mapped) return mapped.unmapped;
  return roots.length > 1 ? `${rootName(mapped.root)}/${mapped.rel}` : mapped.rel;
}
