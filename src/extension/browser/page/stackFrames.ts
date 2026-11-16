// Locations as pages report them, for browser_inspect (source.ts): V8 stack strings and the frame of a
// React 19 `_debugStack` that is the user's code (where the JSX was written), inspector plugin
// attributes, and Svelte's `__svelte_meta` line bases. Pure.

export interface StackFrame {
  /** Function name as V8 prints it ("Card", "exports.jsxDEV", "new Foo"), if any. */
  fn: string | undefined;
  url: string;
  /** 1-based, as in stack strings. */
  line: number;
  /** 1-based. */
  column: number;
}

/** Splits "url:line:col" (or "url:line") from the right, so URLs with ports and Windows drives survive. */
export function splitLocation(location: string): { url: string; line: number; column: number } | undefined {
  const m = /^(.*?):(\d+)(?::(\d+))?$/.exec(location.trim());
  if (!m || !m[1]) return undefined;
  return { url: m[1], line: Number(m[2]), column: m[3] ? Number(m[3]) : 1 };
}

/** Parses V8 (`    at Name (url:1:2)`, `    at url:1:2`, `    at async Name (...)`) and Firefox/Safari (`Name@url:1:2`) lines. */
export function parseStack(stack: string): StackFrame[] {
  const frames: StackFrame[] = [];
  for (const raw of stack.split('\n')) {
    const line = raw.trim();
    let fn: string | undefined;
    let where: string;
    const v8 = /^at (?:async )?(?:(.*?) \((.*)\)|(.*))$/.exec(line);
    if (v8) {
      fn = v8[1] || undefined;
      where = (v8[2] ?? v8[3] ?? '').trim();
    } else {
      const gecko = /^(.*?)@(.+)$/.exec(line);
      if (!gecko || !/:\d+(:\d+)?$/.test(gecko[2]!)) continue;
      fn = gecko[1] || undefined;
      where = gecko[2]!;
    }
    // "eval at f (url:1:2), <anonymous>:3:4" and native frames have no usable URL.
    if (!where || where.startsWith('eval at ') || where === 'native' || where === '<anonymous>') continue;
    const loc = splitLocation(where);
    if (!loc) continue;
    frames.push({ fn: fn?.replace(/ \[as [^\]]+\]$/, ''), ...loc });
  }
  return frames;
}

/**
 * URLs of React's own code (the JSX runtime, the renderer, the scheduler): its packages in
 * node_modules, Vite's pre-bundled copies, Next's compiled copies, and the UMD/CJS file names. Only as
 * package folders or file names, so an app's own `src/scheduler/` is not taken for React.
 */
const REACT_URL = [
  /\/node_modules\/(?:react|react-dom|scheduler|react-server-dom-[\w-]+)\//,
  /\/node_modules\/\.vite\/deps\/(?:react|react-dom|react-dom_client|react-dom_server|react_jsx-dev-runtime|react_jsx-runtime|scheduler)\.js(?:[?#]|$)/,
  /\/next\/dist\/compiled\/(?:react|react-dom|scheduler)(?:-experimental)?\//,
  /(?:^|\/)(?:react|react-dom|react-dom-client|react-jsx-dev-runtime|react-jsx-runtime|scheduler)\.(?:development|production|profiling)(?:\.min)?\.js(?:[?#]|$)/,
];
const isReactUrl = (url: string) => REACT_URL.some(re => re.test(url));
/** Names only React uses: skipped wherever they are (React may be bundled into the app's own script). */
const REACT_ONLY_FN = /(^|\.)(jsxDEV|jsxDEVImpl|fakeJSXCallSite)$|^react-stack-top-frame$/;
/** Common names that are React's only when the code is React's or a library's (an app may have its own `createElement`). */
const REACT_COMMON_FN = /(^|\.)(jsxs|jsx|jsxProd|createElement|cloneElement)$/;
/** The renderer below the component that created the element (the stack's bottom). */
const RENDERER_ONLY_FN = /^(Object\.)?(react-stack-bottom-frame|renderWithHooks|renderWithHooksAgain|mountIndeterminateComponent|callComponentInDEV)$/;
const RENDERER_COMMON_FN = /^(updateFunctionComponent|beginWork|performUnitOfWork)$/;

/** True for a frame in a library (node_modules, Vite's pre-bundled dependencies). */
export function isLibraryUrl(url: string): boolean {
  return /[\\/]node_modules[\\/]|\/\.vite\/deps\//.test(url);
}

/**
 * The frame of a React 19 `_debugStack` where the element was written: the first frame after React's
 * own leading frames. The stack holds the call that created the element, so that frame is in the
 * component that wrote the JSX. A library frame there is returned too (the caller marks it as such).
 */
export function elementCreationFrame(stack: string): StackFrame | undefined {
  for (const frame of parseStack(stack)) {
    const fn = frame.fn ?? '';
    const libraryCode = isReactUrl(frame.url) || isLibraryUrl(frame.url);
    if (REACT_ONLY_FN.test(fn) || (libraryCode && REACT_COMMON_FN.test(fn))) continue;
    // Past React's leading frames into the renderer: nothing of the user's code created this element.
    if (RENDERER_ONLY_FN.test(fn) || (libraryCode && RENDERER_COMMON_FN.test(fn))) return undefined;
    if (isReactUrl(frame.url)) continue;
    return frame;
  }
  return undefined;
}

/** A location in a source file as a framework reports it: 1-based line and column when known. */
export interface FileLocation {
  file: string;
  line?: number;
  column?: number;
}

/**
 * An inspector plugin attribute: `data-insp-path` (code-inspector-plugin, `path:line:col[:tag]`) or
 * `data-v-inspector` (vite-plugin-vue-inspector, `path:line:col`). Windows paths keep their drive.
 */
export function parseInspectorPath(value: string): FileLocation | undefined {
  const m = /^(.+?):(\d+):(\d+)(?::[^:\\/]*)?$/.exec(value.trim());
  if (m) return { file: m[1]!, line: Number(m[2]), column: Number(m[3]) };
  return value.trim() ? { file: value.trim() } : undefined;
}

/**
 * Svelte's element location (`__svelte_meta.loc`) as 1-based line and column. Svelte 4 writes both
 * 0-based (and adds `char`); Svelte 5 writes a 1-based line and a 0-based column. Checked against the
 * compilers' dev output (svelte 4.2 `add_location(div, file, 4, 0, 58)` for line 5, svelte 5.57
 * `add_locations(..., [[5, 0]])` and `add_svelte_meta(..., 8, 2)` for 1-based lines 5 and 8).
 */
export function svelteLocation(loc: { file?: string; line?: number; column?: number } | undefined, version: 4 | 5): FileLocation | undefined {
  if (!loc?.file) return undefined;
  const line = typeof loc.line === 'number' ? loc.line + (version === 4 ? 1 : 0) : undefined;
  const column = typeof loc.column === 'number' ? loc.column + 1 : undefined;
  return { file: loc.file, line, column };
}
