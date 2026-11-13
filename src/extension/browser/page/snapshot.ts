// Turns Chrome's accessibility tree (CDP `Accessibility.getFullAXTree`, one per frame) into the text
// snapshot the agent reads: the YAML-like format of the Playwright MCP server, where every element has
// a ref the action tools accept. Pure: no CDP, no vscode, so it is unit-tested directly.
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

export interface SnapshotInput {
  /** AX nodes per frame id. Frames missing here are treated as unreachable (cross-origin). */
  frames: Map<string, AXNode[]>;
  mainFrameId: string;
  /** Frame-owner element (`<iframe>`) backend node id → the frame id it hosts, when known. */
  frameOwners: Map<number, string>;
  /** Elements that look clickable (cursor: pointer, click listeners) although their role does not say so. */
  pointer: Set<number>;
  /** Elements to leave out entirely (the bridge's own UI, marked `data-agent-bridge-ui`). */
  hidden: Set<number>;
  /** Render only the subtree of this element. */
  root?: number;
  /** Returns the ref for an element. Called in document order for every element that is printed. */
  refFor(node: { backendNodeId: number; frameId: string; role: string; name: string }): string;
  /** Character budget for the result. */
  maxChars: number;
  /** The page URL; links on the same origin are printed as paths. */
  pageUrl?: string;
}

export interface SnapshotOutput {
  text: string;
  truncated: boolean;
  totalChars: number;
  /** False when `root` was given but not found in any frame. */
  rootFound: boolean;
}

interface ElementView {
  kind: 'element';
  role: string;
  name: string;
  attrs: string[];
  value: string | undefined;
  url: string | undefined;
  backendNodeId: number | undefined;
  frameId: string;
  pointer: boolean;
  note: string | undefined;
  children: View[];
}
interface TextView {
  kind: 'text';
  text: string;
}
type View = ElementView | TextView;

/** Roles that never carry meaning of their own: their children take their place. */
const TRANSPARENT = new Set(['MenuListPopup', 'none', 'presentation', 'LabelText', 'LayoutTable', 'LayoutTableRow', 'LayoutTableCell', 'Ruby', 'RubyAnnotation', 'Abbr', 'Mark', 'Time', 'superscript', 'subscript', 'emphasis', 'strong', 'DescriptionListTerm', 'DescriptionListDetail']);
/** Roles dropped together with their subtree. */
const DROPPED = new Set(['InlineTextBox', 'ListMarker', 'LineBreak']);
/** Roles whose AX children are internal (the editor of a text field), not page content. */
const LEAF = new Set(['Date', 'DateTime', 'InputTime', 'textbox', 'searchbox', 'spinbutton', 'slider', 'img', 'image', 'progressbar', 'meter', 'scrollbar', 'separator']);
/** Roles worth listing in the "not shown" summary of a cut snapshot. */
const LANDMARKS = new Set(['main', 'navigation', 'banner', 'contentinfo', 'complementary', 'region', 'form', 'search', 'dialog', 'alertdialog', 'heading', 'article', 'table', 'grid', 'tabpanel', 'iframe']);

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

export function renderSnapshot(input: SnapshotInput): SnapshotOutput {
  const byFrame = new Map<string, Map<string, AXNode>>();
  for (const [frameId, nodes] of input.frames) byFrame.set(frameId, new Map(nodes.map(n => [n.nodeId, n])));

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
    const name = accessibleName(node);
    const pointer = backend !== undefined && input.pointer.has(backend);
    const focusable = props.focusable === true && role === 'generic' && props.editable === undefined;

    let children: View[] = [];
    let note: string | undefined;
    if (role === 'iframe') {
      const childFrame = backend !== undefined ? input.frameOwners.get(backend) : undefined;
      if (childFrame && byFrame.has(childFrame)) children = convertFrame(childFrame);
      else note = 'cross-origin frame: its content cannot be read; use browser_screenshot and click by x/y';
    } else if (!LEAF.has(role) && !(role === 'combobox' && props.editable !== undefined)) {
      children = mergeText(childViews());
    }

    if (role === 'generic' && !name && !pointer && !focusable) return children;
    if ((role === 'group' || role === 'region' || role === 'paragraph' || role === 'listitem' || role === 'list' || role === 'caption') && !name && children.length === 0) return [];

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
    if (typeof props.level === 'number' && (role === 'heading' || role === 'treeitem')) attrs.push(`level=${props.level}`);
    if (props.selected === true) attrs.push('selected');
    if (props.focused === true) attrs.push('active');
    if (props.required === true) attrs.push('required');
    if (props.readonly === true && role !== 'generic') attrs.push('readonly');
    if (props.invalid !== undefined && props.invalid !== 'false' && props.invalid !== false) attrs.push('invalid');
    if (props.modal === true) attrs.push('modal');

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

    // A name that just repeats the text inside is printed once.
    if (name && children.length > 0 && children.every(c => c.kind === 'text')) {
      const text = squash(children.map(c => (c as TextView).text).join(' '));
      const bare = (v: string) => v.replace(/\s+/g, '');
      if (text === name || name.includes(text) || bare(name).includes(bare(text))) children = [];
    }
    if (role === 'option' && children.every(c => c.kind === 'text')) children = [];
    if (value !== undefined && value === name) value = undefined;

    const url = role === 'link' && typeof props.url === 'string' ? props.url : undefined;
    return [{ kind: 'element', role, name, attrs, value, url, backendNodeId: backend, frameId, pointer: pointer && role !== 'link' && role !== 'button', note, children }];
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
      // Frames inside the subtree are still rendered; mark the others as visited only lazily.
      views = convert(node, frameId, index);
      if (node.ignored && views.length === 0) views = [];
      break;
    }
  } else {
    views = convertFrame(input.mainFrameId);
  }

  // Render to lines, assigning refs in document order.
  interface Line {
    text: string;
    landmark: boolean;
    depth?: number;
  }
  const lines: Line[] = [];
  const render = (view: View, depth: number) => {
    const indent = '  '.repeat(depth);
    if (view.kind === 'text') {
      lines.push({ text: `${indent}- text: ${quoteText(clip(view.text, MAX_TEXT))}`, landmark: false });
      return;
    }
    let head = `${indent}- ${view.role}`;
    if (view.name) head += ` ${JSON.stringify(clip(view.name, MAX_NAME))}`;
    for (const a of view.attrs) head += ` [${a}]`;
    if (view.backendNodeId !== undefined) {
      head += ` [ref=${input.refFor({ backendNodeId: view.backendNodeId, frameId: view.frameId, role: view.role, name: view.name })}]`;
    }
    if (view.pointer) head += ' [cursor=pointer]';

    let children = view.children;
    let omittedOptions = 0;
    if (view.role === 'combobox' || view.role === 'listbox') {
      const options = children.filter(c => c.kind === 'element' && c.role === 'option');
      if (options.length > MAX_OPTIONS) {
        omittedOptions = options.length - MAX_OPTIONS;
        const keep = new Set(options.slice(0, MAX_OPTIONS));
        children = children.filter(c => !(c.kind === 'element' && c.role === 'option') || keep.has(c) || (c as ElementView).attrs.includes('selected'));
      }
    }
    const single = children.length === 1 && children[0]!.kind === 'text' && !view.url && view.value === undefined ? (children[0] as TextView).text : undefined;
    const landmark = LANDMARKS.has(view.role);
    if (view.note) {
      lines.push({ text: `${head}: [${view.note}]`, landmark, depth });
      return;
    }
    if (single !== undefined) {
      lines.push({ text: `${head}: ${quoteText(clip(single, MAX_TEXT))}`, landmark, depth });
      return;
    }
    const valueSuffix = view.value !== undefined ? `: ${quoteText(clip(view.value, MAX_TEXT))}` : '';
    if (children.length === 0 && !view.url) {
      lines.push({ text: head + valueSuffix, landmark, depth });
      return;
    }
    lines.push({ text: `${head}${valueSuffix || ':'}`, landmark, depth });
    if (view.url) lines.push({ text: `${indent}  - /url: ${clip(shortUrl(view.url, input.pageUrl), MAX_URL)}`, landmark: false });
    for (const child of children) render(child, depth + 1);
    if (omittedOptions) lines.push({ text: `${indent}  - text: … ${omittedOptions} more options`, landmark: false });
  };
  for (const v of views) render(v, 0);

  const totalChars = lines.reduce((n, l) => n + l.text.length + 1, 0);
  if (totalChars <= input.maxChars) return { text: lines.map(l => l.text).join('\n'), truncated: false, totalChars, rootFound };

  // Over budget: keep whole lines up to the budget (minus room for the summary), then list the
  // landmarks and headings that were cut, so the agent can narrow the next snapshot to one of them.
  const summaryBudget = Math.min(3000, Math.floor(input.maxChars * 0.2));
  const kept: string[] = [];
  let used = 0;
  let i = 0;
  for (; i < lines.length; i++) {
    const len = lines[i]!.text.length + 1;
    if (used + len > input.maxChars - summaryBudget) break;
    kept.push(lines[i]!.text);
    used += len;
  }
  // The shallowest parts first (the page's top-level structure), then deeper ones while room remains;
  // listed in page order.
  const rest = lines
    .slice(i)
    .map((l, index) => ({ ...l, index }))
    .filter(l => l.landmark && /\[ref=/.test(l.text));
  const byDepth = [...rest].sort((a, b) => (a.depth ?? 0) - (b.depth ?? 0) || a.index - b.index);
  const chosen = new Set<number>();
  let summaryUsed = 0;
  for (const l of byDepth) {
    const len = l.text.trim().length + 4;
    if (summaryUsed + len > summaryBudget - 400) break;
    chosen.add(l.index);
    summaryUsed += len;
  }
  const summary = rest.filter(l => chosen.has(l.index)).map(l => `  ${l.text.trim().replace(/:$/, '')}`);
  const shownPct = Math.max(1, Math.round((used / totalChars) * 100));
  const footer = [
    `[Snapshot cut: showing the first ${used} of ${totalChars} characters (${shownPct}%).`,
    ...(summary.length ? [`Parts below the cut include:`, ...summary, ...(rest.length > summary.length ? [`  … and ${rest.length - summary.length} more`] : [])] : []),
    `To read one part, call browser_snapshot with ref set to one of these refs; or raise maxChars.]`,
  ];
  return { text: [...kept, ...footer].join('\n'), truncated: true, totalChars, rootFound };
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
