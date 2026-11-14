// Choosing a Playwright locator for an element the agent acted on, and printing it as code. Pure: the
// facts (roles, names, how many elements each candidate would match) are gathered from the page at the
// time of the action (locators.ts); this module only decides and renders, so it is unit-tested directly.
//
// Order of preference follows Playwright's own locator generator: a test id, then role and accessible
// name, then label, placeholder, alt text, visible text, title; then a stable CSS id, a role or text
// locator scoped to a unique container, an index into several role matches, and a CSS path last. A
// candidate is used only when it matches exactly one element (Playwright's strict mode).
import { squash } from './ringBuffer';
import type { AXNode } from './snapshot';

/** Matching rules of Playwright's getBy* text options: whitespace collapsed; substring and case-insensitive unless exact. */
export function normalizeText(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

export function textMatches(candidate: string, value: string, exact: boolean): boolean {
  const c = normalizeText(candidate);
  const v = normalizeText(value);
  return exact ? c === v : c.toLowerCase().includes(v.toLowerCase());
}

export type Locator =
  | { kind: 'role'; role: string; name?: string; exact?: boolean }
  | { kind: 'testid'; value: string }
  | { kind: 'label' | 'placeholder' | 'alt' | 'title' | 'text'; value: string; exact?: boolean }
  | { kind: 'css'; selector: string };

export type LocatorPart = Locator & { nth?: number };

/** A complete locator: the frames to enter (CSS selectors of their `<iframe>` elements, outermost first), then the parts. */
export interface LocatorChain {
  frames: string[];
  parts: LocatorPart[];
}

/**
 * ARIA roles Chrome and Playwright compute the same way for the common elements, so a getByRole
 * locator derived from Chrome's accessibility tree finds the same element in Playwright.
 */
const ROLES = new Set([
  'alert', 'alertdialog', 'article', 'banner', 'button', 'cell', 'checkbox', 'columnheader', 'combobox', 'complementary', 'contentinfo', 'dialog',
  'form', 'grid', 'gridcell', 'group', 'heading', 'img', 'link', 'list', 'listbox', 'listitem', 'main', 'menu', 'menubar', 'menuitem',
  'menuitemcheckbox', 'menuitemradio', 'navigation', 'option', 'progressbar', 'radio', 'radiogroup', 'region', 'row', 'rowheader', 'search',
  'searchbox', 'separator', 'slider', 'spinbutton', 'status', 'switch', 'tab', 'table', 'tablist', 'tabpanel', 'textbox', 'toolbar', 'tooltip',
  'tree', 'treegrid', 'treeitem', 'meter', 'dialog', 'figure', 'note', 'log', 'marquee', 'timer', 'definition', 'term', 'paragraph', 'code',
]);

/** Roles that are useless without a name (too many on any page). */
const NEEDS_NAME = new Set(['img', 'list', 'listitem', 'row', 'cell', 'gridcell', 'group', 'paragraph', 'generic', 'region', 'figure', 'code', 'term', 'definition', 'note', 'columnheader', 'rowheader']);

/** Containers that make a good scope for an element whose own locator is not unique (a row, a card, a dialog). */
export const CONTAINER_ROLES = new Set(['row', 'listitem', 'article', 'region', 'dialog', 'alertdialog', 'form', 'group', 'navigation', 'main', 'complementary', 'banner', 'contentinfo', 'search', 'tabpanel', 'table', 'list', 'menu', 'toolbar', 'grid', 'treeitem', 'figure']);

/** The getByRole role for a role as the snapshot prints it, or undefined when getByRole should not be used for it. */
export function playwrightRole(role: string): string | undefined {
  return ROLES.has(role) ? role : undefined;
}

export function roleUsable(role: string | undefined, name: string): boolean {
  return !!role && (name !== '' || !NEEDS_NAME.has(role));
}

/** Names longer than this are shortened to a prefix that still identifies the element. */
const MAX_NAME = 80;

/**
 * The name option for a role locator, given the names of every element with that role in the document
 * (document order) and the position of ours. Tries the name as a substring (Playwright's default), then
 * exact, then shorter prefixes for long names. Returns the nth index when nothing is unique.
 */
export function pickName(names: string[], self: number, options: { shortest?: boolean } = {}): { name: string; exact?: boolean; unique: boolean; nth: number; count: number } {
  const own = normalizeText(names[self] ?? '');
  const variants: Array<{ name: string; exact: boolean }> = [];
  // A container (a table row's name is all its cells) reads best by its first words: "Widget 37".
  if (options.shortest) {
    const words = own.split(' ');
    for (let n = 1; n < Math.min(words.length, 6); n++) variants.push({ name: words.slice(0, n).join(' '), exact: false });
  }
  const prefixes = (s: string) => {
    const out: string[] = [];
    for (const len of [30, 50, MAX_NAME]) {
      if (s.length <= len) break;
      const cut = s.slice(0, len);
      const space = cut.lastIndexOf(' ');
      out.push((space > len / 2 ? cut.slice(0, space) : cut).trim());
    }
    return out;
  };
  if (own.length <= MAX_NAME) variants.push({ name: own, exact: false }, { name: own, exact: true });
  for (const p of prefixes(own)) variants.push({ name: p, exact: false });
  for (const v of variants) {
    let count = 0;
    let nth = -1;
    names.forEach((n, i) => {
      if (!textMatches(n, v.name, v.exact)) return;
      if (i === self) nth = count;
      count++;
    });
    if (count === 1 && nth === 0) return { name: v.name, ...(v.exact ? { exact: true } : {}), unique: true, nth: 0, count };
  }
  // Not unique: the shortest variant with the index of our element among its matches.
  const v = variants.find(x => !x.exact) ?? { name: own, exact: false };
  let count = 0;
  let nth = 0;
  names.forEach((n, i) => {
    if (!textMatches(n, v.name, false)) return;
    if (i === self) nth = count;
    count++;
  });
  return { name: v.name, unique: false, nth, count };
}

/** One text-like candidate measured in the page: how many elements it matches, substring and exact. */
export interface Candidate {
  value: string;
  count: number;
  exactCount: number;
}

/** What locators.ts learned about an element at the time of the action. */
export interface LocatorFacts {
  /** Role locator: role, chosen name, and whether it is unique (from pickName). */
  role?: { role: string; name: string; exact?: boolean; unique: boolean; nth: number; count: number; ordered: boolean };
  testId?: { value: string; count: number };
  label?: Candidate;
  placeholder?: Candidate;
  alt?: Candidate;
  title?: Candidate;
  text?: Candidate & { nth: number };
  /** A stable `#id` or attribute selector that matched only this element. */
  cssId?: string;
  /** A unique container and a role locator unique inside it. */
  scoped?: { container: Locator; inner: LocatorPart };
  /** CSS path to the element; count = how many elements it matches, nth = ours among them. */
  css?: { selector: string; count: number; nth: number };
}

/** The locator parts for the facts, best first; never empty (falls back to the CSS path). */
export function chooseLocator(f: LocatorFacts): { parts: LocatorPart[]; robust: boolean } {
  const unique = (c: Candidate | undefined) => (c && c.value ? (c.count === 1 ? { exact: false } : c.exactCount === 1 ? { exact: true } : undefined) : undefined);
  const withExact = <T extends object>(base: T, exact: boolean): T => (exact ? { ...base, exact: true } : base);
  if (f.testId && f.testId.count === 1) return { parts: [{ kind: 'testid', value: f.testId.value }], robust: true };
  if (f.role?.unique) return { parts: [roleLocator(f.role)], robust: true };
  for (const kind of ['label', 'placeholder', 'alt'] as const) {
    const u = unique(f[kind]);
    if (u) return { parts: [withExact({ kind, value: f[kind]!.value }, u.exact)], robust: true };
  }
  const t = unique(f.text);
  if (t) return { parts: [withExact({ kind: 'text', value: f.text!.value }, t.exact)], robust: true };
  const title = unique(f.title);
  if (title) return { parts: [withExact({ kind: 'title', value: f.title!.value }, title.exact)], robust: true };
  if (f.cssId) return { parts: [{ kind: 'css', selector: f.cssId }], robust: true };
  if (f.scoped) return { parts: [f.scoped.container, f.scoped.inner], robust: true };
  if (f.role && f.role.ordered && f.role.count > 1) return { parts: [{ ...roleLocator(f.role), nth: f.role.nth }], robust: false };
  if (f.text && f.text.value && f.text.count > 1) return { parts: [{ kind: 'text', value: f.text.value, nth: f.text.nth }], robust: false };
  if (f.css) return { parts: [{ kind: 'css', selector: f.css.selector, ...(f.css.count > 1 ? { nth: f.css.nth } : {}) }], robust: f.css.count === 1 };
  return { parts: [{ kind: 'css', selector: '*' }], robust: false };
}

function roleLocator(r: NonNullable<LocatorFacts['role']>): Locator {
  return { kind: 'role', role: r.role, ...(r.name ? { name: r.name } : {}), ...(r.exact ? { exact: true } : {}) };
}

/** A JavaScript string literal in single quotes, as Playwright's code generator writes them. */
export function quote(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')}'`;
}

function renderPart(p: LocatorPart): string {
  const exact = 'exact' in p && p.exact ? ', { exact: true }' : '';
  let s: string;
  switch (p.kind) {
    case 'role': {
      const opts = [p.name !== undefined ? `name: ${quote(p.name)}` : '', p.exact ? 'exact: true' : ''].filter(Boolean);
      s = `getByRole(${quote(p.role)}${opts.length ? `, { ${opts.join(', ')} }` : ''})`;
      break;
    }
    case 'testid':
      s = `getByTestId(${quote(p.value)})`;
      break;
    case 'label':
      s = `getByLabel(${quote(p.value)}${exact})`;
      break;
    case 'placeholder':
      s = `getByPlaceholder(${quote(p.value)}${exact})`;
      break;
    case 'alt':
      s = `getByAltText(${quote(p.value)}${exact})`;
      break;
    case 'title':
      s = `getByTitle(${quote(p.value)}${exact})`;
      break;
    case 'text':
      s = `getByText(${quote(p.value)}${exact})`;
      break;
    case 'css':
      s = `locator(${quote(p.selector)})`;
      break;
  }
  const nth = p.nth === undefined ? '' : p.nth === 0 ? '.first()' : `.nth(${p.nth})`;
  return `.${s}${nth}`;
}

/** `page.frameLocator(...).getByRole(...)`. */
export function renderLocator(chain: LocatorChain, root = 'page'): string {
  return root + chain.frames.map(f => `.frameLocator(${quote(f)})`).join('') + chain.parts.map(renderPart).join('');
}

/** A CSS selector the agent used, as a locator: `a >>> b` (copane's frame combinator) becomes frameLocator('a').locator('b'). */
export function selectorChain(selector: string): LocatorChain {
  const parts = selector.split('>>>').map(s => s.trim());
  const last = parts.pop()!;
  return { frames: parts, parts: [{ kind: 'css', selector: last }] };
}

/** Chrome's computed role names behind each role the snapshot prints (snapshot.ts ROLE_NAMES, reversed). */
const RAW_ROLES: Record<string, string[]> = {
  img: ['image', 'img'],
  textbox: ['textbox', 'Date', 'DateTime', 'InputTime'],
  button: ['button', 'DisclosureTriangle', 'Summary'],
  option: ['option', 'MenuListOption'],
  region: ['region', 'Section'],
  group: ['group', 'Details'],
  list: ['list', 'DescriptionList'],
};

/** The getByRole role of a raw Chrome role, if any. */
function roleOfRaw(raw: string): string | undefined {
  return playwrightRole(Object.entries(RAW_ROLES).find(([, list]) => list.includes(raw))?.[0] ?? raw);
}

/** Roles Playwright names from their content even when Chrome reports no name. */
const NAME_FROM_CONTENT = new Set(['row', 'cell', 'gridcell', 'columnheader', 'rowheader']);

/** One document's accessibility tree (`Accessibility.getFullAXTree`), in tree order, for counting roles and names. */
export class AxIndex {
  private readonly byId = new Map<string, AXNode>();
  private readonly order: AXNode[] = [];
  private readonly position = new Map<AXNode, number>();
  private readonly end = new Map<AXNode, number>();

  constructor(nodes: AXNode[]) {
    for (const n of nodes) this.byId.set(n.nodeId, n);
    const roots = nodes.filter(n => !n.parentId || !this.byId.has(n.parentId));
    const visit = (n: AXNode, depth: number) => {
      if (this.position.has(n) || depth > 2000) return;
      this.position.set(n, this.order.length);
      this.order.push(n);
      for (const id of n.childIds ?? []) {
        const child = this.byId.get(id);
        if (child) visit(child, depth + 1);
      }
      this.end.set(n, this.order.length);
    };
    for (const r of roots) visit(r, 0);
  }

  /**
   * The name Playwright computes for a node. Chrome leaves some roles nameless that Playwright names
   * from their content (a table row is named by its cells), so those get the text inside them.
   */
  nameOf = (n: AXNode): string => {
    const own = squash(String(n.name?.value ?? ''));
    if (own || !NAME_FROM_CONTENT.has(AxIndex.rawRole(n))) return own;
    const start = this.position.get(n);
    if (start === undefined) return '';
    const text = this.order.slice(start + 1, this.end.get(n)).filter(d => AxIndex.rawRole(d) === 'StaticText').map(d => String(d.name?.value ?? ''));
    return squash(text.join(' '));
  };

  byBackendId(id: number): AXNode | undefined {
    return this.order.find(n => n.backendDOMNodeId === id && !n.ignored);
  }

  /** Nodes Playwright's getByRole(role) can match (not ignored), in document order, optionally under `within`. */
  withRole(role: string, within?: AXNode): AXNode[] {
    const raw = RAW_ROLES[role] ?? [role];
    const from = within ? this.position.get(within)! + 1 : 0;
    const to = within ? this.end.get(within)! : this.order.length;
    return this.order.slice(from, to).filter(n => !n.ignored && raw.includes(String(n.role?.value ?? '')));
  }

  ancestors(n: AXNode): AXNode[] {
    const out: AXNode[] = [];
    for (let p = n.parentId ? this.byId.get(n.parentId) : undefined; p && out.length < 50; p = p.parentId ? this.byId.get(p.parentId) : undefined) out.push(p);
    return out;
  }

  static rawRole(n: AXNode): string {
    return String(n.role?.value ?? '');
  }
}

/**
 * A unique container (row, list item, dialog, named region...) around the element in which its role
 * and name are unique: for lists of identical buttons ("Order" in every row).
 */
export function scopedLocator(tree: AxIndex, self: AXNode, role: string): LocatorFacts['scoped'] {
  let tried = 0;
  for (const node of tree.ancestors(self)) {
    if (node.ignored) continue;
    const containerRole = roleOfRaw(AxIndex.rawRole(node));
    const name = tree.nameOf(node);
    if (!containerRole || !CONTAINER_ROLES.has(containerRole) || !name) continue;
    if (++tried > 4) break;
    const outer = tree.withRole(containerRole);
    const container = pickName(outer.map(tree.nameOf), outer.indexOf(node), { shortest: true });
    if (!container.unique) continue;
    const inner = tree.withRole(role, node);
    const own = pickName(inner.map(tree.nameOf), inner.indexOf(self));
    if (!own.unique) continue;
    return {
      container: { kind: 'role', role: containerRole, name: container.name, ...(container.exact ? { exact: true } : {}) },
      inner: { kind: 'role', role, ...(own.name ? { name: own.name } : {}), ...(own.exact ? { exact: true } : {}) },
    };
  }
  return undefined;
}
