// Turns Chrome's accessibility tree (CDP `Accessibility.getFullAXTree`, one per frame) into what the
// agent reads. Pure: no CDP, no vscode, so it is unit-tested directly. One tree, three renderings:
//
// - snapshot: the YAML-like format of the Playwright MCP server. Refs (e.g. [ref=e12]) only on what an
//   agent can act on (links, buttons, fields, anything clickable) or narrow a snapshot to (landmarks,
//   headings, tables, named regions). Link targets only on request or when the link has no name.
//   Decorative separators, empty and single-child wrappers are left out; table rows of plain cells
//   are printed on one line.
// - text: the main content as light markdown, without refs, for reading.
// - find: only the elements whose text matches, each with where it is on the page.
//
// Lines carry ref placeholders until they are shown, so refs are handed out only for what the agent
// actually sees, and so two renderings of the same page can be compared (`diffLines`).
import { clip, squash } from './ringBuffer';

/** The parts of a CDP `Accessibility.AXNode` this module reads. */
export interface AXNode {
  nodeId: string;
  ignored?: boolean;
  role?: { value?: unknown };
  name?: { value?: unknown };
  value?: { value?: unknown };
  properties?: Array<{ name: string; value: { value?: unknown } }>;
  parentId?: string;
  childIds?: string[];
  backendDOMNodeId?: number;
}

export interface TreeInput {
  /** AX nodes per frame id. Frames missing here are treated as unreachable (cross-origin). */
  frames: Map<string, AXNode[]>;
  mainFrameId: string;
  /** Frame-owner element (`<iframe>`) backend node id → the frame id it hosts, when known. */
  frameOwners: Map<number, string>;
  /** Elements that look clickable (cursor: pointer, click listeners) although their role does not say so. */
  pointer: Set<number>;
  /** Elements to leave out entirely (the bridge's own UI, marked `data-copane-ui`). */
  hidden: Set<number>;
  /** Render only the subtree of this element. */
  root?: number;
  /** The page URL; links on the same origin are printed as paths. */
  pageUrl?: string;
  /** Why an iframe's content is not in `frames` (frame id from `frameOwners`, if known); printed in its place. */
  frameNote?(frameId: string | undefined): string | undefined;
}

export interface RefNode {
  backendNodeId: number;
  frameId: string;
  role: string;
  name: string;
}

export interface SnapshotInput extends TreeInput {
  /** Returns the ref for an element. Called in document order for every element that is printed with a ref. */
  refFor(node: RefNode): string;
  /** Character budget for the result. */
  maxChars: number;
  /** Print every link's target, not only those of links without a name. */
  urls?: boolean;
}

export interface SnapshotOutput {
  text: string;
  truncated: boolean;
  totalChars: number;
  /** False when `root` was given but not found in any frame. */
  rootFound: boolean;
  /** Link targets were left out (the agent can ask for them with `urls`). */
  urlsOmitted: boolean;
  /** Every line of the full rendering, refs still as placeholders: the baseline for `diffLines`. */
  lines: string[];
  /**
   * For a rendering from the top (no offset): what `text` shows, line by line with refs filled in
   * (`lines` above the cut, `footer` the cut's summary), and the lines below the cut, not shown and
   * still with placeholders. What snapshotDelta.ts compares against the next snapshot.
   */
  shown?: { lines: string[]; footer: string[]; below: string[] };
}

interface ElementView {
  kind: 'element';
  role: string;
  name: string;
  attrs: string[];
  value: string | undefined;
  url: string | undefined;
  /** `${frameId}:${backendNodeId}` when the element gets a ref. */
  key: string | undefined;
  /** Landmarks, headings, tables: listed in the summary of a cut snapshot. */
  landmark: boolean;
  pointer: boolean;
  note: string | undefined;
  level: number | undefined;
  children: View[];
}
interface TextView {
  kind: 'text';
  text: string;
}
type View = ElementView | TextView;

export interface Tree {
  views: View[];
  rootFound: boolean;
  /** What each ref placeholder key stands for. */
  nodes: Map<string, RefNode>;
}

/** Roles that never carry meaning of their own: their children take their place. */
const TRANSPARENT = new Set(['MenuListPopup', 'none', 'presentation', 'LabelText', 'LayoutTable', 'LayoutTableRow', 'LayoutTableCell', 'Ruby', 'RubyAnnotation', 'Abbr', 'Mark', 'Time', 'superscript', 'subscript', 'emphasis', 'strong', 'DescriptionListTerm', 'DescriptionListDetail', 'rowgroup', 'sectionheader', 'sectionfooter']);
/** Roles dropped together with their subtree. */
const DROPPED = new Set(['InlineTextBox', 'ListMarker', 'LineBreak']);
/** Roles whose AX children are internal (the editor of a text field), not page content. */
const LEAF = new Set(['Date', 'DateTime', 'InputTime', 'textbox', 'searchbox', 'spinbutton', 'slider', 'img', 'image', 'progressbar', 'meter', 'scrollbar', 'separator']);
/** Roles an agent acts on: they always get a ref. */
const INTERACTIVE = new Set([
  'link', 'button', 'checkbox', 'radio', 'switch', 'textbox', 'searchbox', 'combobox', 'listbox', 'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'tab', 'slider', 'spinbutton', 'treeitem', 'gridcell', 'iframe', 'video', 'audio', 'canvas', 'scrollbar',
]);
/** Roles an agent narrows a snapshot to: they get a ref and are listed when a snapshot is cut. */
const LANDMARKS = new Set(['main', 'navigation', 'banner', 'contentinfo', 'complementary', 'region', 'form', 'search', 'dialog', 'alertdialog', 'heading', 'article', 'table', 'grid', 'treegrid', 'tabpanel', 'iframe', 'menu', 'menubar', 'tree', 'toolbar', 'tablist']);
/** Containers whose name is usually computed from their content, so it repeats what is printed inside. */
const NAMED_BY_CONTENT = new Set(['cell', 'row', 'rowheader', 'columnheader', 'listitem', 'paragraph', 'caption', 'generic', 'group', 'term', 'definition', 'blockquote', 'note', 'tooltip', 'figure', 'list', 'article', 'code']);
/** Unnamed wrappers that are replaced by their only child. */
const COLLAPSIBLE = new Set(['listitem', 'paragraph', 'group', 'generic', 'caption', 'term', 'definition', 'figure', 'blockquote', 'code']);
const CELLS = new Set(['cell', 'gridcell', 'columnheader', 'rowheader']);
/** Containers whose parts matter more than their name: they keep their children. */
const STRUCTURE = new Set(['row', 'table', 'grid', 'treegrid', 'list', 'listbox', 'menu', 'menubar', 'tablist', 'tree', 'toolbar', 'radiogroup', 'group', 'form', 'navigation', 'region', 'main', 'banner', 'contentinfo', 'complementary', 'search', 'dialog', 'alertdialog', 'article', 'tabpanel', 'document', 'figure', 'iframe']);
/** Containers of running text: text and the links in it are printed on one line. */
const FLOW = new Set(['paragraph', 'listitem', 'cell', 'gridcell', 'columnheader', 'rowheader', 'caption', 'term', 'definition', 'blockquote', 'note', 'generic', 'status', 'alert', 'heading', 'code', 'figure']);
/** Link texts that do not say where a link goes: their target is printed. */
const VAGUE_LINK = /^(here|click here|this|link|more|read more|learn more|details|download|source|website)$/i;
/** Text that only separates items ("|", "·", ",", "(", ...). */
const SEPARATOR = /^[\s|·•,;:/()[\]–—\-.>»«<]+$/;

const ROLE_NAMES: Record<string, string> = {
  image: 'img',
  Iframe: 'iframe',
  RootWebArea: 'document',
  Canvas: 'canvas',
  Video: 'video',
  Audio: 'audio',
  MenuListOption: 'option',
  DescriptionList: 'list',
  Section: 'region',
  Pre: 'generic',
  Details: 'group',
  Summary: 'button',
  Legend: 'generic',
  Figcaption: 'caption',
  SvgRoot: 'img',
  graphics: 'img',
  'graphics-document': 'img',
  'graphics-symbol': 'img',
  DisclosureTriangle: 'button',
  Date: 'textbox',
  DateTime: 'textbox',
  InputTime: 'textbox',
};

const MAX_NAME = 150;
const MAX_TEXT = 300;
const MAX_URL = 150;
const MAX_OPTIONS = 25;
/** Estimated length of a ref ("e123") when budgeting lines that still hold placeholders. */
const REF_ESTIMATE = 4;

function str(v: unknown): string {
  return typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v);
}

function propsOf(node: AXNode): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of node.properties ?? []) out[p.name] = p.value?.value;
  return out;
}

/** The role name the snapshot prints for an AX node (Playwright / ARIA spelling). */
export function roleName(node: AXNode): string {
  const raw = str(node.role?.value) || 'generic';
  return ROLE_NAMES[raw] ?? raw;
}

/** The accessible name the snapshot prints for an AX node. */
export function accessibleName(node: AXNode): string {
  return squash(str(node.name?.value));
}

/** Text compared without spacing and punctuation, so "C++, Go" and "C++ Go" count as the same. */
function bare(s: string): string {
  return s.replace(/[\s|·•,;:/()[\]–—\-.>»«<"'!?]+/g, '').toLowerCase();
}

/** Everything an element says: its name and the text inside it. */
function shownText(v: View): string {
  if (v.kind === 'text') return v.text;
  return [v.name, ...v.children.map(shownText)].join(' ');
}

/** True for text, and for elements printed on one line (no children, no value). */
function isInline(v: View): boolean {
  return v.kind === 'text' || (v.children.length === 0 && v.value === undefined && !v.note) || (!v.key && v.attrs.length === 0 && v.children.every(c => c.kind === 'text'));
}

function hasRef(v: View): boolean {
  return v.kind === 'element' && (v.key !== undefined || v.children.some(hasRef));
}

// ---------------------------------------------------------------- tree

export function buildTree(input: TreeInput): Tree {
  const byFrame = new Map<string, Map<string, AXNode>>();
  for (const [frameId, nodes] of input.frames) byFrame.set(frameId, new Map(nodes.map(n => [n.nodeId, n])));
  const nodes = new Map<string, RefNode>();
  const visitedFrames = new Set<string>();

  const convertFrame = (frameId: string): View[] => {
    const index = byFrame.get(frameId);
    if (!index || visitedFrames.has(frameId)) return [];
    visitedFrames.add(frameId);
    const top = [...index.values()].find(n => !n.parentId || !index.has(n.parentId));
    return top ? convert(top, frameId, index) : [];
  };

  const convert = (node: AXNode, frameId: string, index: Map<string, AXNode>): View[] => {
    const backend = node.backendDOMNodeId;
    if (backend !== undefined && input.hidden.has(backend)) return [];
    const rawRole = str(node.role?.value);
    if (DROPPED.has(rawRole)) return [];
    if (rawRole === 'StaticText') {
      const text = squash(str(node.name?.value));
      return text ? [{ kind: 'text', text }] : [];
    }
    const childViews = (): View[] => (node.childIds ?? []).flatMap(id => {
      const child = index.get(id);
      return child ? convert(child, frameId, index) : [];
    });
    if (node.ignored || rawRole === 'RootWebArea' || TRANSPARENT.has(rawRole)) return mergeText(childViews());

    const role = roleName(node);
    const props = propsOf(node);
    let name = accessibleName(node);
    const pointer = backend !== undefined && input.pointer.has(backend);
    const editable = props.editable !== undefined && props.editable !== 'false' && props.editable !== false;
    const focusable = props.focusable === true;

    let children: View[] = [];
    let note: string | undefined;
    if (role === 'iframe') {
      const childFrame = backend !== undefined ? input.frameOwners.get(backend) : undefined;
      if (childFrame && byFrame.has(childFrame)) children = convertFrame(childFrame);
      else note = input.frameNote?.(childFrame) ?? 'cross-origin frame: its content cannot be read; use browser_screenshot and click by x/y';
    } else if (!LEAF.has(role) && !(role === 'combobox' && props.editable !== undefined)) {
      children = mergeText(childViews());
    }

    const attrs: string[] = [];
    const checked = props.checked;
    if (checked === 'true' || checked === true) attrs.push('checked');
    else if (checked === 'mixed') attrs.push('checked=mixed');
    const pressed = props.pressed;
    if (pressed === 'true' || pressed === true) attrs.push('pressed');
    else if (pressed === 'mixed') attrs.push('pressed=mixed');
    if (props.disabled === true) attrs.push('disabled');
    if (props.expanded === true) attrs.push('expanded');
    else if (props.expanded === false) attrs.push('expanded=false');
    const level = typeof props.level === 'number' ? props.level : undefined;
    if (level !== undefined && (role === 'heading' || role === 'treeitem')) attrs.push(`level=${level}`);
    if (props.selected === true) attrs.push('selected');
    if (props.focused === true) attrs.push('active');
    if (props.required === true) attrs.push('required');
    if (props.readonly === true && role !== 'generic') attrs.push('readonly');
    if (props.invalid !== undefined && props.invalid !== 'false' && props.invalid !== false) attrs.push('invalid');
    if (props.modal === true) attrs.push('modal');

    const interactive = INTERACTIVE.has(role) || pointer || focusable || editable || attrs.some(a => /^(checked|pressed|expanded|selected)/.test(a));
    const landmark = LANDMARKS.has(role) || ((role === 'group' || role === 'region') && name !== '');
    if (role === 'generic' && !name && !interactive) return children;
    if (role === 'separator' && !interactive) return [];
    if (role === 'img' && !name && !interactive) return [];

    let value: string | undefined;
    const rawValue = node.value?.value;
    if (rawValue !== undefined && rawValue !== null && rawValue !== '') {
      value = squash(str(rawValue));
      if (props.valuetext !== undefined && str(props.valuetext)) value = squash(str(props.valuetext));
    }
    if (role === 'combobox' && value === undefined) {
      const selected = findSelectedOption(children);
      if (selected) value = selected;
    }

    // A name that only repeats what is inside is printed once: on the element when nothing inside
    // can be acted on, otherwise on the content.
    if (name && children.length > 0) {
      // A legend or caption that repeats the name of its group or table.
      const first = children[0]!;
      if (bare(shownText(first)) === bare(name) && (first.kind === 'text' || (!hasRef(first) && (first.role === 'caption' || first.role === 'generic')))) children = children.slice(1);
      const inside = bare(children.map(shownText).join(' '));
      if (!children.some(hasRef) && !STRUCTURE.has(role) && bare(name).includes(inside)) children = [];
      else if (!interactive && !landmark && NAMED_BY_CONTENT.has(role) && inside.includes(bare(name))) name = '';
    }
    if (role === 'generic' && !name && !interactive) return children;
    if (role === 'option' && children.every(c => c.kind === 'text')) children = [];
    if (value !== undefined && value === name) value = undefined;

    const key = backend !== undefined && (interactive || landmark) ? `${frameId}:${backend}` : undefined;
    if (key) nodes.set(key, { backendNodeId: backend!, frameId, role, name });

    const plain = !key && attrs.length === 0 && !name && value === undefined && !note;
    if (plain && !CELLS.has(role)) {
      if (children.length === 0) return [];
      const meaningful = withoutSeparators(children);
      if (COLLAPSIBLE.has(role) && meaningful.length === 1 && meaningful[0]!.kind === 'element') return meaningful;
    }
    if (!key && !name && children.length === 0 && value === undefined && !note && !CELLS.has(role) && role !== 'img') return [];

    const url = role === 'link' && typeof props.url === 'string' ? props.url : undefined;
    return [{ kind: 'element', role, name, attrs, value, url, key, landmark, pointer: pointer && role !== 'link' && role !== 'button', note, level, children }];
  };

  // Locate the root: the main frame's tree, or the element asked for, in whichever frame it lives.
  let views: View[];
  let rootFound = true;
  if (input.root !== undefined) {
    views = [];
    rootFound = false;
    for (const [frameId, index] of byFrame) {
      const node = [...index.values()].find(n => n.backendDOMNodeId === input.root);
      if (!node) continue;
      rootFound = true;
      views = convert(node, frameId, index);
      break;
    }
  } else {
    views = convertFrame(input.mainFrameId);
  }
  return { views, rootFound, nodes };
}

function mergeText(views: View[]): View[] {
  const out: View[] = [];
  for (const v of views) {
    const prev = out[out.length - 1];
    if (v.kind === 'text' && prev?.kind === 'text') prev.text = `${prev.text} ${v.text}`;
    else out.push(v.kind === 'text' ? { ...v } : v);
  }
  // A label's text right before its field repeats the field's name: keep it once, on the field.
  return out.filter((v, i) => {
    const next = out[i + 1];
    return !(v.kind === 'text' && next?.kind === 'element' && next.name && next.name === v.text);
  });
}

/** Separators between items ("|", "·", ",") say nothing in a snapshot, where each item is shown on its own. */
function withoutSeparators(views: View[]): View[] {
  return views.length > 1 ? views.filter(v => !(v.kind === 'text' && SEPARATOR.test(v.text))) : views;
}

function findSelectedOption(views: View[]): string | undefined {
  for (const v of views) {
    if (v.kind !== 'element') continue;
    if (v.role === 'option' && v.attrs.includes('selected')) return v.name;
    const inner = findSelectedOption(v.children);
    if (inner) return inner;
  }
  return undefined;
}

/** Text is printed bare unless YAML would misread it. */
function quoteText(text: string): string {
  if (text === '' || /^[\s\-?:,[\]{}#&*!|>'"%@`]|: | #|\s$/.test(text)) return JSON.stringify(text);
  return text;
}

/** "http://host/a/b#c" → "/a/b#c" when it is on the page's origin. */
export function shortUrl(url: string, pageUrl: string | undefined): string {
  if (!pageUrl) return url;
  try {
    const u = new URL(url);
    const p = new URL(pageUrl);
    if (u.origin !== p.origin || u.origin === 'null') return url;
    return `${u.pathname}${u.search}${u.hash}`;
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------- snapshot lines

const PLACEHOLDER = /\u0001([^\u0001]+)\u0001/g;

interface Line {
  text: string;
  depth: number;
  landmark: boolean;
}

interface LineOptions {
  urls: boolean;
  pageUrl: string | undefined;
}

/** One element's head: `role "name" [attrs] [ref=…] [cursor=pointer] [url=…]`. */
function head(view: ElementView, options: LineOptions, state: { urlsOmitted: boolean }): string {
  let out = view.role;
  if (view.name) out += ` ${JSON.stringify(clip(view.name, MAX_NAME))}`;
  for (const a of view.attrs) out += ` [${a}]`;
  if (view.key) out += ` [ref=\u0001${view.key}\u0001]`;
  if (view.pointer) out += ' [cursor=pointer]';
  if (view.url) {
    if (options.urls || !view.name || VAGUE_LINK.test(view.name)) out += ` [url=${clip(shortUrl(view.url, options.pageUrl), MAX_URL)}]`;
    else state.urlsOmitted = true;
  }
  return out;
}

/** A table row of plain cells as one line ("a | b | link "c" [ref=e4]"), or undefined if a cell holds more. */
function inlineRow(row: ElementView, options: LineOptions, state: { urlsOmitted: boolean }): string | undefined {
  if (row.children.length === 0 || !row.children.every(c => c.kind === 'element' && CELLS.has(c.role))) return undefined;
  const cells: string[] = [];
  for (const cell of row.children as ElementView[]) {
    const own = cell.key || cell.attrs.length > 0;
    if (cell.children.length === 0) {
      cells.push(own ? head(cell, options, state) : cell.name);
      continue;
    }
    if (own) return undefined;
    const parts = withoutSeparators(cell.children);
    if (!parts.every(isInline)) return undefined;
    cells.push(parts.map(c => inlineItem(c, options, state)).join(' '));
  }
  return cells.every(c => c === '') ? '' : cells.join(' | ');
}

/** A text or an element inside a line of running text. */
function inlineItem(v: View, options: LineOptions, state: { urlsOmitted: boolean }): string {
  if (v.kind === 'text') return clip(v.text, MAX_TEXT);
  if (v.children.length === 0) return head(v, options, state);
  return clip(v.children.map(c => (c as TextView).text).join(' '), MAX_TEXT);
}

function toLines(views: View[], options: LineOptions, state: { urlsOmitted: boolean }): Line[] {
  const lines: Line[] = [];
  const render = (view: View, depth: number) => {
    const indent = '  '.repeat(depth);
    if (view.kind === 'text') {
      lines.push({ text: `${indent}- text: ${quoteText(clip(view.text, MAX_TEXT))}`, depth, landmark: false });
      return;
    }
    const h = `${indent}- ${head(view, options, state)}`;
    const landmark = view.landmark;
    if (view.note) {
      lines.push({ text: `${h}: [${view.note}]`, landmark, depth });
      return;
    }
    if (view.role === 'row') {
      const row = inlineRow(view, options, state);
      if (row === '') return;
      if (row !== undefined) {
        lines.push({ text: `${h}: ${row}`, landmark, depth });
        return;
      }
    }
    let children = withoutSeparators(view.children);
    let omittedOptions = 0;
    if (view.role === 'combobox' || view.role === 'listbox') {
      const options = children.filter(c => c.kind === 'element' && c.role === 'option');
      if (options.length > MAX_OPTIONS) {
        omittedOptions = options.length - MAX_OPTIONS;
        const keep = new Set(options.slice(0, MAX_OPTIONS));
        children = children.filter(c => !(c.kind === 'element' && c.role === 'option') || keep.has(c) || (c as ElementView).attrs.includes('selected'));
      }
    }
    if (FLOW.has(view.role) && view.value === undefined && children.length > 1 && children.some(c => c.kind === 'text') && children.every(isInline)) {
      const flow = children.map(c => inlineItem(c, options, state)).join(' ');
      lines.push({ text: `${h}: ${flow}`, landmark, depth });
      return;
    }
    const single = children.length === 1 && children[0]!.kind === 'text' && view.value === undefined ? (children[0] as TextView).text : undefined;
    if (single !== undefined) {
      lines.push({ text: `${h}: ${quoteText(clip(single, MAX_TEXT))}`, landmark, depth });
      return;
    }
    const valueSuffix = view.value !== undefined ? `: ${quoteText(clip(view.value, MAX_TEXT))}` : '';
    if (children.length === 0) {
      lines.push({ text: h + valueSuffix, landmark, depth });
      return;
    }
    lines.push({ text: `${h}${valueSuffix || ':'}`, landmark, depth });
    for (const child of children) render(child, depth + 1);
    if (omittedOptions) lines.push({ text: `${indent}  - text: … ${omittedOptions} more options`, landmark: false, depth: depth + 1 });
  };
  for (const v of withoutSeparators(views)) render(v, 0);
  return lines;
}

/** Length of a line once its placeholders are replaced by refs (estimated). */
function shownLength(line: string): number {
  let n = line.length;
  for (const m of line.matchAll(PLACEHOLDER)) n += REF_ESTIMATE - m[0].length;
  return n;
}

/** Replaces ref placeholders with refs, handing them out in order. */
export function fillRefs(text: string, nodes: Map<string, RefNode>, refFor: (node: RefNode) => string): string {
  return text.replace(PLACEHOLDER, (_, key: string) => {
    const node = nodes.get(key);
    return node ? refFor(node) : '?';
  });
}

export function renderSnapshot(input: SnapshotInput & { offset?: number }): SnapshotOutput {
  const tree = buildTree(input);
  return renderTree(tree, input);
}

export interface RenderOptions {
  refFor(node: RefNode): string;
  maxChars: number;
  urls?: boolean;
  pageUrl?: string;
  /** Start at this character of the full rendering (continuing a cut one). */
  offset?: number;
}

/** The lines of a full snapshot with default options, refs as placeholders: what `diffLines` compares. */
export function snapshotLines(tree: Tree, pageUrl: string | undefined): string[] {
  return toLines(tree.views, { urls: false, pageUrl }, { urlsOmitted: false }).map(l => l.text);
}

export function renderTree(tree: Tree, input: RenderOptions): SnapshotOutput {
  const state = { urlsOmitted: false };
  const lines = toLines(tree.views, { urls: Boolean(input.urls), pageUrl: input.pageUrl }, state);
  const all = lines.map(l => l.text);
  const fill = (s: string) => fillRefs(s, tree.nodes, input.refFor);
  const totalChars = lines.reduce((n, l) => n + shownLength(l.text) + 1, 0);
  const base = { rootFound: tree.rootFound, urlsOmitted: state.urlsOmitted, lines: input.urls ? snapshotLines(tree, input.pageUrl) : all };
  const offset = Math.max(0, input.offset ?? 0);
  if (offset === 0 && totalChars <= input.maxChars) {
    const filled = all.map(fill);
    return { ...base, text: filled.join('\n'), truncated: false, totalChars, shown: { lines: filled, footer: [], below: [] } };
  }

  // Over budget: keep whole lines up to the budget (minus room for the summary), then list the
  // landmarks and headings that were cut, so the agent can narrow the next snapshot to one of them.
  const summaryBudget = Math.min(3000, Math.floor(input.maxChars * 0.2));
  const kept: string[] = [];
  let skipped = 0;
  let i = 0;
  for (; i < lines.length && skipped < offset; i++) skipped += shownLength(lines[i]!.text) + 1;
  // A continuation starts with the line it is inside of, so the agent sees where it is.
  if (skipped > 0 && i < lines.length && lines[i]!.depth > 0) {
    for (let p = i - 1; p >= 0; p--) {
      if (lines[p]!.depth < lines[i]!.depth) {
        kept.push(`${lines[p]!.text.replace(/:$/, '')}: # continued`);
        break;
      }
    }
  }
  let used = 0;
  for (; i < lines.length; i++) {
    const len = shownLength(lines[i]!.text) + 1;
    // Always at least one line, so reading on from an offset makes progress.
    if (used + len > input.maxChars - summaryBudget && kept.length > (skipped > 0 && kept[0]?.endsWith('# continued') ? 1 : 0)) break;
    kept.push(lines[i]!.text);
    used += len;
  }
  if (i >= lines.length) {
    const tail = skipped > 0 ? [`[Snapshot continued from character ${skipped}: this is the end of the page.]`] : [];
    const filled = kept.map(fill);
    const shown = skipped > 0 ? undefined : { lines: filled, footer: [], below: [] };
    return { ...base, text: [...filled, ...tail.map(fill)].join('\n'), truncated: skipped > 0, totalChars, shown };
  }
  // The shallowest parts first (the page's top-level structure), then deeper ones while room remains;
  // listed in page order.
  const rest = lines
    .slice(i)
    .map((l, index) => ({ ...l, index }))
    .filter(l => l.landmark && l.text.includes('\u0001'))
    // A heading named like the landmark listed just before it (region "Section 2", heading "Section 2") adds nothing.
    .filter((l, k, all) => k === 0 || !sameNamedHeading(all[k - 1]!.text, l.text));
  const byDepth = [...rest].sort((a, b) => a.depth - b.depth || a.index - b.index);
  const chosen = new Set<number>();
  let summaryUsed = 0;
  for (const l of byDepth) {
    const len = shownLength(l.text.trim()) + 4;
    if (summaryUsed + len > summaryBudget - 400) break;
    chosen.add(l.index);
    summaryUsed += len;
  }
  const summary = rest.filter(l => chosen.has(l.index)).map(l => `  ${l.text.trim().replace(/:$/, '').replace(/: .*$/, '')}`);
  const end = skipped + used;
  const shownPct = Math.max(1, Math.round((used / totalChars) * 100));
  const footer = [
    `[Snapshot cut: showing characters ${skipped}-${end} of ${totalChars} (${shownPct}%).`,
    ...(summary.length ? [`Parts below the cut include:`, ...summary, ...(rest.length > summary.length ? [`  … and ${rest.length - summary.length} more`] : [])] : []),
    `To read one part, call browser_snapshot with its ref; to read on, with offset ${end}; to look for something, with find.]`,
  ];
  const filledKept = kept.map(fill);
  const filledFooter = footer.map(fill);
  const shown = skipped > 0 ? undefined : { lines: filledKept, footer: filledFooter, below: lines.slice(i).map(l => l.text) };
  return { ...base, text: [...filledKept, ...filledFooter].join('\n'), truncated: true, totalChars, shown };
}

/** True when `line` is a heading with the same name as the landmark (not a heading) on `prev`. */
function sameNamedHeading(prev: string, line: string): boolean {
  const named = (l: string) => /^\s*- (\w+) ("(?:[^"\\]|\\.)*")/.exec(l);
  const a = named(prev);
  const b = named(line);
  return Boolean(a && b && b[1] === 'heading' && a[1] !== 'heading' && a[2] === b[2]);
}

/** Cuts plain text at a line boundary within `maxChars`, starting at `offset`. */
export function textWindow(text: string, offset: number, maxChars: number): { text: string; end: number; total: number } {
  const total = text.length;
  let start = Math.min(Math.max(0, offset), total);
  if (start > 0) {
    const nl = text.lastIndexOf('\n', start);
    start = nl >= 0 && start - nl < 300 ? nl + 1 : start;
  }
  let end = Math.min(total, start + maxChars);
  if (end < total) {
    const nl = text.lastIndexOf('\n', end);
    if (nl > start + maxChars / 2) end = nl;
  }
  return { text: text.slice(start, end), end, total };
}

// ---------------------------------------------------------------- text

/** Roles left out of the text rendering: page chrome and controls. */
const TEXT_SKIP = new Set(['navigation', 'banner', 'contentinfo', 'complementary', 'search', 'button', 'combobox', 'textbox', 'searchbox', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton', 'listbox', 'menu', 'menubar', 'toolbar', 'tablist', 'img', 'scrollbar', 'progressbar', 'meter', 'tooltip']);
/** Elements that flow inside a line of text. */
const INLINE = new Set(['link', 'generic', 'code', 'term', 'definition', 'mark', 'time']);
/** Citation and edit markers ("[12]", "[edit]") that only interrupt the text. */
const CITATION = /^\[(\d+|[a-z]|edit|citation needed|note \d+)\]$/i;

export interface TextOutput {
  text: string;
  /** What the text is: "the main content" or "the whole page". */
  scope: string;
}

/** The page as light markdown: headings, paragraphs, lists, table rows. No refs, no controls. */
export function renderText(tree: Tree): TextOutput {
  let views = tree.views;
  let scope = 'the whole page';
  const main = findView(views, v => v.role === 'main') ?? findView(views, v => v.role === 'article');
  if (main) {
    views = main.children;
    scope = `the ${main.role === 'main' ? 'main content' : 'article'}`;
  }
  const out: string[] = [];
  let inline: string[] = [];
  let prefix = '';
  const flush = () => {
    const s = squash(inline.join(' ')).replace(/ ([,.;:!?)])/g, '$1').replace(/\( /g, '(');
    if (s) out.push(prefix + s);
    inline = [];
    prefix = '';
  };
  const inlineText = (v: View): string => {
    if (v.kind === 'text') return v.text;
    if (TEXT_SKIP.has(v.role) || (v.role === 'link' && CITATION.test(v.name))) return '';
    if (v.children.length === 0) return v.name || v.value || '';
    return v.children.map(inlineText).filter(Boolean).join(' ');
  };
  const walk = (vs: View[], indent: string) => {
    for (const v of vs) {
      if (v.kind === 'text') {
        inline.push(v.text);
        continue;
      }
      if (TEXT_SKIP.has(v.role) && v.role !== 'textbox') continue;
      if (v.role === 'textbox' && !v.value) continue;
      if (v.role === 'link' && CITATION.test(v.name)) continue;
      if (INLINE.has(v.role) || (v.children.length === 0 && v.role !== 'heading' && v.role !== 'separator')) {
        inline.push(inlineText(v) || (v.role === 'textbox' ? v.value! : ''));
        continue;
      }
      flush();
      if (v.role === 'heading') {
        out.push('', `${'#'.repeat(Math.min(6, v.level ?? 2))} ${squash(v.name || inlineText(v))}`);
      } else if (v.role === 'list') {
        for (const item of v.children) {
          if (item.kind === 'element' && item.role === 'listitem') {
            prefix = `${indent}- `;
            walk(item.children.length ? item.children : [{ kind: 'text', text: item.name }], `${indent}  `);
            flush();
          } else walk([item], indent);
        }
      } else if (v.role === 'row') {
        // Empty cells at the edges are layout (spacers, indentation, action columns): leave them out.
        const cells = v.children.map(c => squash(inlineText(c)));
        while (cells.length && !cells[0]) cells.shift();
        while (cells.length && !cells[cells.length - 1]) cells.pop();
        if (cells.length) out.push(`${indent}${cells.length > 1 ? `| ${cells.join(' | ')} |` : cells[0]}`);
      } else if (v.role === 'listitem') {
        prefix = `${indent}- `;
        walk(v.children.length ? v.children : [{ kind: 'text', text: v.name }], `${indent}  `);
      } else {
        walk(v.children.length ? v.children : v.name ? [{ kind: 'text', text: v.name }] : [], indent);
      }
      flush();
    }
  };
  walk(views, '');
  flush();
  return { text: out.join('\n').replace(/^\n+/, '').replace(/\n{3,}/g, '\n\n'), scope };
}

function findView(views: View[], test: (v: ElementView) => boolean): ElementView | undefined {
  for (const v of views) {
    if (v.kind !== 'element') continue;
    if (test(v)) return v;
    const inner = findView(v.children, test);
    if (inner) return inner;
  }
  return undefined;
}

// ---------------------------------------------------------------- find

export interface FindOutput {
  /** Matching lines (ref placeholders filled), each with where it is. */
  text: string;
  matches: number;
  shown: number;
}

/**
 * The elements whose name, value or text contains `query` (case-insensitive), one line each, with
 * the part of the page and the heading they are under. Rows of a table match as a whole line.
 */
export function findInTree(tree: Tree, query: string, input: RenderOptions): FindOutput {
  const q = query.toLowerCase();
  const options = { urls: Boolean(input.urls), pageUrl: input.pageUrl };
  const state = { urlsOmitted: false };
  const found: string[] = [];
  let matches = 0;
  let heading: string | undefined;
  const contains = (s: string | undefined) => Boolean(s && s.toLowerCase().includes(q));
  const where = (path: ElementView[]) => {
    const scopes = path.filter(p => p.landmark && p.role !== 'heading' && p.role !== 'table').slice(-2);
    const parts = [...scopes.map(p => `${p.role}${p.name ? ` ${JSON.stringify(clip(p.name, 60))}` : ''}`)];
    if (heading && !scopes.some(p => p.name === heading)) parts.push(`under heading ${JSON.stringify(clip(heading, 80))}`);
    return parts.length ? `# in ${parts.join(', ')}:` : '# at the top level of the page:';
  };
  let lastWhere: string | undefined;
  const add = (line: string, path: ElementView[]) => {
    matches++;
    // Matches in the same part of the page share one line saying where they are.
    const w = where(path);
    if (w !== lastWhere) found.push(w);
    lastWhere = w;
    found.push(line);
  };
  const visit = (v: View, path: ElementView[]) => {
    if (v.kind === 'text') {
      if (contains(v.text)) {
        const at = v.text.toLowerCase().indexOf(q);
        const start = Math.max(0, at - 80);
        const snippet = `${start > 0 ? '…' : ''}${v.text.slice(start, at + q.length + 80)}${at + q.length + 80 < v.text.length ? '…' : ''}`;
        add(`- text: ${quoteText(snippet)}`, path);
      }
      return;
    }
    if (v.role === 'heading') heading = v.name || shownText(v);
    if (v.role === 'row') {
      const row = inlineRow(v, options, state);
      if (row !== undefined) {
        if (contains(row.replace(PLACEHOLDER, ''))) add(`- ${head(v, options, state)}: ${row}`, path);
        return;
      }
    }
    const h = head(v, options, state);
    if (contains(v.name) || contains(v.value) || (options.urls && contains(v.url))) {
      add(`- ${h}${v.value !== undefined ? `: ${quoteText(clip(v.value, MAX_TEXT))}` : ''}`, path);
      if (!v.children.some(hasRef)) return;
    }
    for (const c of v.children) visit(c, [...path, v]);
  };
  for (const v of tree.views) visit(v, []);
  // Keep whole lines within the budget.
  const kept: string[] = [];
  let used = 0;
  for (const line of found) {
    const len = shownLength(line) + 1;
    if (used + len > input.maxChars) break;
    kept.push(line);
    used += len;
  }
  if (kept.length && kept[kept.length - 1]!.startsWith('# ')) kept.pop();
  return { text: fillRefs(kept.join('\n'), tree.nodes, input.refFor), matches, shown: kept.filter(l => !l.startsWith('# ')).length };
}

// ---------------------------------------------------------------- diff

export interface LineDiff {
  /** Lines of `after` that are new or changed, with the line they sit under when that one did not change. */
  added: string[];
  /** Short descriptions (role and name) of elements that are gone. */
  removed: string[];
  /** How many lines of `after` are new or changed. */
  addedCount: number;
}

/** States that change on every click without meaning anything to the agent. */
const NOISE = / \[active\]/g;

/**
 * Compares two renderings of the same document (ref placeholders intact). `ignoreKeys` are elements
 * whose own change is already reported (the field the agent typed into).
 */
export function diffLines(before: string[], after: string[], ignoreKeys: Set<string> = new Set()): LineDiff {
  const norm = (l: string) => l.replace(NOISE, '');
  const a = before.map(norm);
  const b = after.map(norm);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  // Inside the changed window, a line counts as unchanged if the same line is still there.
  const remaining = new Map<string, number>();
  for (let i = start; i < endA; i++) remaining.set(a[i]!, (remaining.get(a[i]!) ?? 0) + 1);
  const addedIdx: number[] = [];
  for (let j = start; j < endB; j++) {
    const n = remaining.get(b[j]!) ?? 0;
    if (n > 0) remaining.set(b[j]!, n - 1);
    else addedIdx.push(j);
  }
  const keyOf = (l: string) => /\u0001([^\u0001]+)\u0001/.exec(l)?.[1];
  const indentOf = (l: string) => l.length - l.trimStart().length;
  const describe = (l: string) => /^\s*- (\w+)( "[^"]*")?/.exec(l);
  // Lines of an ignored element and everything inside it.
  const ignoredLines = (lines: string[]): Set<number> => {
    const out = new Set<number>();
    let under: number | undefined;
    lines.forEach((l, i) => {
      const ind = indentOf(l);
      if (under !== undefined && ind <= under) under = undefined;
      const k = keyOf(l);
      if (under === undefined && k && ignoreKeys.has(k)) under = ind;
      if (under !== undefined) out.add(i);
    });
    return out;
  };
  const ignoredAfter = ignoredLines(b);
  const ignoredBefore = new Set([...ignoredLines(a)].map(i => a[i]!));
  const addedKeys = new Set(addedIdx.map(j => keyOf(b[j]!)).filter((k): k is string => k !== undefined));
  const visibleAdded = addedIdx.filter(j => !ignoredAfter.has(j));
  const addedNames = new Set(visibleAdded.map(j => describe(b[j]!)?.slice(1).join('')));
  // Context: the nearest line above that is less indented and did not change itself.
  const addedSet = new Set(visibleAdded);
  const out: string[] = [];
  const shownContext = new Set<number>();
  for (const j of visibleAdded) {
    const ind = indentOf(b[j]!);
    if (ind > 0 && !addedSet.has(j - 1)) {
      for (let p = j - 1; p >= 0; p--) {
        if (indentOf(b[p]!) < ind) {
          if (!addedSet.has(p) && !shownContext.has(p)) {
            shownContext.add(p);
            out.push(after[p]!.replace(NOISE, ''));
          }
          break;
        }
      }
    }
    out.push(after[j]!.replace(NOISE, ''));
  }
  const removed: string[] = [];
  for (const [line, n] of remaining) {
    if (n <= 0 || ignoredBefore.has(line)) continue;
    const k = keyOf(line);
    if (k && addedKeys.has(k)) continue;
    const m = describe(line);
    // An element without a ref whose line changed (a status message) is not gone.
    if (m && m[1] !== 'text' && !addedNames.has(m.slice(1).join(''))) removed.push(`${m[1]}${m[2] ?? ''}`);
  }
  // Dedent to the least indented line shown.
  const min = Math.min(...out.map(indentOf));
  return { added: out.map(l => l.slice(Number.isFinite(min) ? min : 0)), removed, addedCount: visibleAdded.length };
}
