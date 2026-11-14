// Gathers what locatorLogic.ts needs to choose a Playwright locator for an element, at the time of the
// action (the element may be gone a moment later): its role and accessible name, and how many elements
// in its document each candidate would match. Test ids, labels, placeholders, text and CSS paths are
// counted by a page-side function that follows Playwright's matching rules (substring and
// case-insensitive unless exact, open shadow roots pierced); it also tells cheaply whether a role
// locator is unique. When it cannot, roles and names are counted in Chrome's accessibility tree of the
// element's document (so frames are scoped like Playwright's frameLocator).
// For an element inside iframes it also returns a selector for each `<iframe>` on the way, same-origin
// ones from the page and cross-origin ones through their frame targets.
import { ToolError } from '../../core/errors';
import type { PageCall } from './call';
import { querySelectorAcrossFrames } from './frameQuery';
import { ownerOf } from './frameTargets';
import { AxIndex, chooseLocator, pickName, playwrightRole, roleUsable, scopedLocator, type Candidate, type LocatorChain, type LocatorFacts } from './locatorLogic';
import { DialogInterrupt } from './pageState';
import { clip } from './ringBuffer';
import type { AXNode } from './snapshot';
import type { ElementTarget } from './targets';

/** Shared by the page-side functions: Playwright's text rules, deep queries, CSS paths. */
const HELPERS = `
  const norm = (s) => String(s == null ? '' : s).replace(/\\s+/g, ' ').trim();
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'TITLE', 'META', 'LINK']);
  const deepAll = (doc, selector) => {
    const out = [];
    const visit = (root) => {
      for (const e of root.querySelectorAll('*')) {
        if (selector === '*' || e.matches(selector)) out.push(e);
        if (e.shadowRoot) visit(e.shadowRoot);
      }
    };
    visit(doc);
    return out;
  };
  const cssString = (v) => '"' + String(v).replace(/[\\\\"]/g, '\\\\$&').replace(/\\n/g, '\\\\a ') + '"';
  const stableId = (id) => /^[A-Za-z][\\w-]*$/.test(id) && !/\\d{3,}|^(ember|react|radix|mui|headlessui|chakra|rc-|r-|__)/i.test(id) && id.length <= 60;
  const uniqueIn = (doc, sel, el) => { try { const m = deepAll(doc, sel); return m.length === 1 && m[0] === el; } catch { return false; } };
`;

/** Elements that can have each role (a superset: explicit roles and the usual implicit ones), for the fast uniqueness check. */
const ROLE_SELECTORS: Record<string, string> = {
  link: 'a[href],area[href],[role~=link]',
  button: 'button,input[type=button],input[type=submit],input[type=reset],input[type=image],input[type=file],summary,[role~=button]',
  checkbox: 'input[type=checkbox],[role~=checkbox],[role~=menuitemcheckbox],[role~=switch]',
  switch: 'input[type=checkbox],[role~=switch],[role~=checkbox]',
  radio: 'input[type=radio],[role~=radio],[role~=menuitemradio]',
  textbox: 'input:not([type]),input[type=text],input[type=email],input[type=tel],input[type=url],input[type=password],input[type=search],input[type=date],input[type=time],input[type=datetime-local],input[type=month],input[type=week],textarea,[contenteditable],[role~=textbox],[role~=searchbox]',
  searchbox: 'input[type=search],input:not([type]),input[type=text],[role~=searchbox],[role~=textbox]',
  combobox: 'select,input[list],input:not([type]),input[type=text],input[type=search],[role~=combobox]',
  listbox: 'select,[role~=listbox]',
  option: 'option,[role~=option]',
  heading: 'h1,h2,h3,h4,h5,h6,[role~=heading]',
  tab: '[role~=tab]',
  menuitem: '[role~=menuitem]',
  slider: 'input[type=range],[role~=slider]',
  spinbutton: 'input[type=number],[role~=spinbutton]',
  img: 'img,svg,[role~=img],[role~=image],input[type=image]',
  treeitem: '[role~=treeitem]',
};

/** Element (this), page world of its frame. Facts for locatorLogic plus what the recorder needs to know about the element. */
const LOCATOR_FACTS = `function (roleCheck, wantText) {
  ${HELPERS}
  const el = this;
  const doc = el.ownerDocument;
  const tag = el.localName;
  const ROLE_SELECTORS = ${JSON.stringify(ROLE_SELECTORS)};
  const textCache = new Map();
  const textOf = (e) => {
    if (textCache.has(e)) return textCache.get(e);
    let t;
    if (e.nodeName === 'INPUT' && (e.type === 'submit' || e.type === 'button' || e.type === 'reset')) t = e.value;
    else {
      const parts = [];
      const kids = e.shadowRoot ? e.shadowRoot.childNodes : e.childNodes;
      for (const c of kids) {
        if (c.nodeType === 3) parts.push(c.nodeValue);
        else if (c.nodeType === 1 && !SKIP.has(c.nodeName)) parts.push(c.nodeName === 'SLOT' ? c.assignedNodes({ flatten: true }).map(n => n.nodeType === 3 ? n.nodeValue : textOf(n)).join('') : textOf(c));
      }
      t = parts.join('');
    }
    t = norm(t);
    textCache.set(e, t);
    return t;
  };
  // Text of an element without the form controls inside it (a label's own words).
  const ownWords = (e) => {
    const parts = [];
    const walk = (n) => { for (const c of n.childNodes) { if (c.nodeType === 3) parts.push(c.nodeValue); else if (c.nodeType === 1 && !SKIP.has(c.nodeName) && !['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(c.nodeName)) walk(c); } };
    walk(e);
    return norm(parts.join(' '));
  };
  const labelsOf = (e) => {
    const ids = e.getAttribute('aria-labelledby');
    if (ids) {
      const root = e.getRootNode();
      const els = ids.split(/\\s+/).map(id => (root.getElementById ? root.getElementById(id) : null) || doc.getElementById(id)).filter(Boolean);
      if (els.length) return els.map(textOf);
    }
    const al = e.getAttribute('aria-label');
    if (al && al.trim()) return [norm(al)];
    if (['BUTTON', 'METER', 'OUTPUT', 'PROGRESS', 'SELECT', 'TEXTAREA'].includes(e.nodeName) || (e.nodeName === 'INPUT' && e.type !== 'hidden')) return [...(e.labels || [])].map(textOf);
    return [];
  };
  const count = (items, value, get) => {
    const v = norm(value), lower = v.toLowerCase();
    let n = 0, exact = 0;
    for (const item of items) {
      const got = get(item);
      const list = Array.isArray(got) ? got : [got];
      if (list.some(g => g != null && norm(g).toLowerCase().includes(lower))) n++;
      if (list.some(g => g != null && norm(g) === v)) exact++;
    }
    return { value: v, count: n, exactCount: exact };
  };
  const out = { tag, type: el.type || undefined, isInput: ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.nodeName) };
  const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
  out.secret = el.type === 'password' || /(current|new)-password|one-time-code|cc-number|cc-csc/.test(ac);
  out.fileInput = (el.nodeName === 'INPUT' && el.type === 'file') || (el.nodeName === 'LABEL' && !!el.control && el.control.type === 'file');
  const all = deepAll(doc, '*');
  // Fast check of a role locator: among the elements that could have the role (a superset), how many
  // could have a name containing it, from any source an accessible name is computed from. One (this
  // element) means getByRole(role, { name }) is unique without reading the accessibility tree.
  if (roleCheck && ROLE_SELECTORS[roleCheck.role]) {
    const want = norm(roleCheck.name).toLowerCase();
    const deepText = (e) => {
      let t = e.textContent || '';
      for (const d of [e, ...e.querySelectorAll('*')]) if (d.shadowRoot) t += ' ' + deepText(d.shadowRoot);
      return t;
    };
    const nameish = (e) => {
      const parts = [e.getAttribute('aria-label'), e.getAttribute('title'), e.getAttribute('alt'), e.getAttribute('placeholder'), e.nodeName === 'INPUT' ? e.value : '', deepText(e)];
      const ids = e.getAttribute('aria-labelledby');
      const root = e.getRootNode();
      if (ids) for (const id of ids.split(/\\s+/)) { const r = (root.getElementById ? root.getElementById(id) : null) || doc.getElementById(id); if (r) parts.push(deepText(r)); }
      for (const l of e.labels || []) parts.push(deepText(l));
      for (const img of e.querySelectorAll ? e.querySelectorAll('img[alt],[aria-label],[title]') : []) parts.push(img.getAttribute('alt'), img.getAttribute('aria-label'), img.getAttribute('title'));
      return norm(parts.filter(Boolean).join(' ')).toLowerCase();
    };
    if (want && nameish(el).includes(want)) {
      const candidates = all.filter(e => e.matches(ROLE_SELECTORS[roleCheck.role]));
      // Elements without a box (display: none, in a closed <details>) are not in the accessibility tree either.
      const rendered = (e) => e === el || (e.checkVisibility ? e.checkVisibility() : true) || getComputedStyle(e).display === 'contents';
      out.roleCandidates = candidates.filter(e => nameish(e).includes(want) && rendered(e)).length;
    }
  }
  if (wantText === undefined) wantText = out.roleCandidates !== 1;
  const testId = el.getAttribute('data-testid');
  if (testId) out.testId = { value: testId, count: all.filter(e => e.getAttribute('data-testid') === testId).length };
  const labelable = all.filter(e => e.hasAttribute('aria-label') || e.hasAttribute('aria-labelledby') || ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON', 'METER', 'OUTPUT', 'PROGRESS'].includes(e.nodeName));
  const myLabels = labelsOf(el);
  if (myLabels.length) {
    const own = el.labels && el.labels.length && !el.hasAttribute('aria-label') && !el.hasAttribute('aria-labelledby') ? ownWords(el.labels[0]) : myLabels[0];
    if (own && own.length <= 80) out.label = count(labelable, own, labelsOf);
  }
  for (const [key, attr] of [['placeholder', 'placeholder'], ['alt', 'alt'], ['title', 'title']]) {
    const v = norm(el.getAttribute(attr));
    if (!v || v.length > 80 || (attr === 'alt' && !['IMG', 'AREA', 'INPUT'].includes(el.nodeName))) continue;
    out[key] = count(all.filter(e => e.hasAttribute(attr)), v, e => e.getAttribute(attr));
  }
  if (wantText) {
    const own = textOf(el);
    if (own && own.length <= 80 && !out.isInput) {
      // getByText matches the smallest elements whose text contains the value: no child element matches too.
      const match = (e, v, exact) => { const t = textOf(e); return exact ? t === v : t.toLowerCase().includes(v.toLowerCase()); };
      const matching = (exact) => {
        let n = 0, nth = -1;
        for (const e of all) {
          if (SKIP.has(e.nodeName) || !match(e, own, exact)) continue;
          const kids = e.shadowRoot ? [...e.shadowRoot.children] : [...e.children];
          if (kids.some(k => !SKIP.has(k.nodeName) && match(k, own, exact))) continue;
          if (e === el) nth = n;
          n++;
        }
        return { n, nth };
      };
      const lax = matching(false), strict = matching(true);
      if (lax.nth >= 0 || strict.nth >= 0) out.text = { value: own, count: lax.nth >= 0 ? lax.n : 0, exactCount: strict.nth >= 0 ? strict.n : 0, nth: Math.max(lax.nth, 0) };
    }
  }
  // CSS: a stable id or a distinctive attribute, else a path from the nearest ancestor with one.
  const candidates = [];
  if (el.id && stableId(el.id)) candidates.push('#' + CSS.escape(el.id));
  for (const attr of ['data-test', 'data-test-id', 'data-cy', 'data-qa', 'name']) {
    const v = el.getAttribute(attr);
    if (v && v.length <= 80) candidates.push(tag + '[' + attr + '=' + cssString(v) + ']');
  }
  out.cssId = candidates.find(c => uniqueIn(doc, c, el));
  const segment = (e) => {
    if (e !== el && e.id && stableId(e.id) && uniqueIn(doc, '#' + CSS.escape(e.id), e)) return { sel: '#' + CSS.escape(e.id), anchored: true };
    const parent = e.parentElement;
    const name = e.localName;
    if (!parent) return { sel: name, anchored: true };
    const same = [...parent.children].filter(c => c.localName === name);
    return { sel: same.length > 1 ? name + ':nth-of-type(' + (same.indexOf(e) + 1) + ')' : name, anchored: false };
  };
  const path = [];
  for (let e = el; e && path.length < 12; e = e.parentElement) {
    const s = segment(e);
    path.unshift(s.sel);
    if (s.anchored || e.localName === 'body') break;
  }
  const selector = path.join(' > ');
  try {
    const matches = deepAll(doc, selector);
    out.css = { selector, count: matches.length, nth: Math.max(0, matches.indexOf(el)) };
  } catch {}
  return out;
}`;

/** Selector of an `<iframe>` element (this) in its document. */
const IFRAME_SELECTOR = `function () {
  ${HELPERS}
  const el = this, doc = el.ownerDocument, tag = el.localName;
  const options = [];
  if (el.id && stableId(el.id)) options.push('#' + CSS.escape(el.id));
  for (const attr of ['name', 'title', 'data-testid', 'src']) {
    const v = el.getAttribute(attr);
    if (v && v.length <= 150) options.push(tag + '[' + attr + '=' + cssString(v) + ']');
  }
  const found = options.find(s => uniqueIn(doc, s, el));
  if (found) return found;
  const frames = deepAll(doc, tag);
  return frames.length === 1 ? tag : tag + ' >> nth=' + frames.indexOf(el);
}`;

/** Element (this). Selectors of the same-origin `<iframe>` elements around its document, outermost first. */
const FRAME_PATH = `function () {
  const path = [];
  let win = this.ownerDocument.defaultView;
  for (let i = 0; win && i < 10; i++) {
    let fe = null;
    try { fe = win.frameElement; } catch {}
    if (!fe) break;
    path.unshift((${IFRAME_SELECTOR}).call(fe));
    win = fe.ownerDocument.defaultView;
  }
  return path;
}`;

/** What the recorder keeps about an element an action used. */
export interface LocatedElement {
  chain: LocatorChain;
  robust: boolean;
  label: string;
  tag: string;
  type?: string;
  /** A password, one-time code or card field: what is typed into it is not recorded. */
  secret: boolean;
  fileInput: boolean;
  /** Text the element is labelled with (for naming a secret's environment variable). */
  labelText: string;
}

interface PageFacts {
  /** How many elements could match getByRole(role, { name }) (the fast check); absent when it cannot tell. */
  roleCandidates?: number;
  tag: string;
  type?: string;
  isInput: boolean;
  secret: boolean;
  fileInput: boolean;
  testId?: { value: string; count: number };
  label?: Candidate;
  placeholder?: Candidate;
  alt?: Candidate;
  title?: Candidate;
  text?: Candidate & { nth: number };
  cssId?: string;
  css?: { selector: string; count: number; nth: number };
}

function rethrowHard(err: unknown): void {
  if (err instanceof ToolError && err.code === 'cancelled') throw err;
}

/** The role and name the element has in the snapshot (from the agent's ref when it used one). */
async function axOf(call: PageCall, target: ElementTarget): Promise<{ role: string; name: string } | undefined> {
  const entry = target.ref ? call.refs.get(target.ref) : undefined;
  if (entry) return { role: entry.role, name: entry.name };
  const ax = await target.call.describeAx(target.backendNodeId);
  return ax && !ax.ignored ? { role: ax.role, name: ax.name } : undefined;
}

/** Element (this), page world. Its document's `<iframe>` element when that is a same-origin child frame, else null. */
const OWNER_IFRAME = `function () { try { return this.ownerDocument.defaultView.frameElement; } catch { return null; } }`;

/**
 * The accessibility tree of the element's document. `Accessibility.getFullAXTree` rather than
 * `queryAXTree`: the latter waits for the next rendering frame when the tree is dirty, which in a
 * background tab (painted about once a second) adds up to a second to every action.
 */
async function documentTree(at: PageCall, target: ElementTarget): Promise<AXNode[]> {
  let frameId: string | undefined;
  const owner = await at.callOn<{ objectId?: string }>(target.objectId, OWNER_IFRAME, [], { returnByValue: false });
  if (owner?.objectId) frameId = (await at.send('DOM.describeNode', { objectId: owner.objectId })).node.frameId;
  else if (!at.frame) frameId = at.state.mainFrameId;
  const { nodes } = await at.send<{ nodes: AXNode[] }>('Accessibility.getFullAXTree', frameId ? { frameId } : {}, { timeoutMs: 10_000 });
  return nodes;
}

/** Selectors of the `<iframe>` elements an element (handle in `at`) is inside, outermost first, across cross-origin frame targets too. */
async function frameChain(call: PageCall, at: PageCall, objectId: string): Promise<string[]> {
  const chain: string[] = [];
  chain.unshift(...(await at.callOn<string[]>(objectId, FRAME_PATH)));
  const frames = call.state.frames;
  for (let f = at.frame; f; f = frames.parentOf(f)) {
    const parent = call.at(frames.parentOf(f));
    const owner = await parent.resolve(await ownerOf(call, f));
    chain.unshift(await parent.callOn<string>(owner, IFRAME_SELECTOR));
    chain.unshift(...(await parent.callOn<string[]>(owner, FRAME_PATH)));
    if (chain.length > 20) break;
  }
  return chain;
}

/** Chooses a locator for an element at the time an action uses it. */
export async function locateElement(call: PageCall, target: ElementTarget): Promise<LocatedElement> {
  const at = target.call;
  const ax = await axOf(call, target);
  const role = ax ? playwrightRole(ax.role) : undefined;
  const facts: LocatorFacts = {};
  const usable = role && ax && roleUsable(role, ax.name) ? role : undefined;
  const fast = usable && ax!.name && ax!.name.length <= 80 ? { role: usable, name: ax!.name } : null;
  // Text candidates are counted (the costly part) only when the fast check did not settle the role locator.
  const page = await at.callOn<PageFacts>(target.objectId, LOCATOR_FACTS, [fast, undefined]);
  let tree: AxIndex | undefined;
  let self: AXNode | undefined;
  if (usable && page.roleCandidates === 1) {
    facts.role = { role: usable, name: ax!.name, unique: true, nth: 0, count: 1, ordered: true };
  } else if (usable) {
    // Exact count from the accessibility tree.
    tree = new AxIndex(await documentTree(at, target));
    self = tree.byBackendId(target.backendNodeId);
    const matches = self ? tree.withRole(usable) : [];
    const index = self ? matches.indexOf(self) : -1;
    if (index >= 0) facts.role = { role: usable, ...pickName(matches.map(tree.nameOf), index), ordered: true };
  }
  Object.assign(facts, { testId: page.testId, label: page.label, placeholder: page.placeholder, alt: page.alt, title: page.title, text: page.text, cssId: page.cssId, css: page.css });
  let choice = chooseLocator(facts);
  if (!choice.robust && usable) {
    tree ??= new AxIndex(await documentTree(at, target));
    self ??= tree.byBackendId(target.backendNodeId);
    if (self) facts.scoped = scopedLocator(tree, self, usable);
    if (facts.scoped) choice = chooseLocator(facts);
  }
  const frames = await frameChain(call, at, target.objectId);
  const label = ax ? `${ax.role}${ax.name ? ` "${clip(ax.name, 60)}"` : ''}` : `<${page.tag}>`;
  return {
    chain: { frames, parts: choice.parts },
    robust: choice.robust,
    label,
    tag: page.tag,
    type: page.type,
    secret: page.secret,
    fileInput: page.fileInput,
    labelText: page.label?.value ?? ax?.name ?? page.tag,
  };
}

/** Isolated world. The smallest visible element whose text contains `text` (case-insensitive), through open shadow roots and same-origin frames. */
const FIND_TEXT = `function (text) {
  const norm = (s) => String(s || '').replace(/\\s+/g, ' ').trim().toLowerCase();
  const want = norm(text);
  const has = (el) => norm(el.innerText).includes(want);
  const deepest = (el) => { for (;;) { const next = [...el.children].find(has); if (!next) return el; el = next; } };
  const inRoot = (root) => {
    const body = root.body || root;
    if (root.body && has(root.body)) return deepest(root.body);
    for (const el of body.querySelectorAll('*')) {
      if (el.shadowRoot) {
        const hit = [...el.shadowRoot.children].find(has);
        if (hit) return deepest(hit);
        const inner = inRoot(el.shadowRoot);
        if (inner) return inner;
      }
      if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
        let doc = null;
        try { doc = el.contentDocument; } catch {}
        const inner = doc && doc.body ? inRoot(doc) : null;
        if (inner) return inner;
      }
    }
    return null;
  };
  return inRoot(document);
}`;

/**
 * Where text the agent waited for is shown: undefined when it is in the top document (or nowhere), else
 * the frames to enter (Playwright's getByText does not look into iframes; browser_wait_for does).
 */
export async function locateText(call: PageCall, text: string): Promise<string[] | undefined> {
  const scopes: PageCall[] = [call, ...call.state.frames.list().filter(f => !f.session.closed).map(f => call.at(f))];
  for (const at of scopes) {
    let handle: { objectId?: string } | undefined;
    try {
      handle = await at.evaluateHandle(FIND_TEXT, [text], { timeoutMs: 3000 });
    } catch (err) {
      if (err instanceof DialogInterrupt) throw err;
      rethrowHard(err);
      continue;
    }
    if (!handle?.objectId) continue;
    const chain = await frameChain(call, at, handle.objectId);
    return chain.length ? chain : undefined;
  }
  return undefined;
}

/** Like locateText, for a CSS selector the agent waited for (frames are entered only when the match is inside one). */
export async function locateSelector(call: PageCall, selector: string): Promise<string[] | undefined> {
  const found = await querySelectorAcrossFrames(call, selector);
  if (!('element' in found) || !found.element) return undefined;
  const chain = await frameChain(call, found.at, found.element.objectId);
  return chain.length ? chain : undefined;
}
