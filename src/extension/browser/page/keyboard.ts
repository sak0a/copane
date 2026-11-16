// browser_audit type "keyboard": presses Tab through the page with trusted key input and follows
// focus into shadow roots and same- and cross-origin frames. Reports the focus order, focus that does
// not show, keyboard traps, interactive-looking elements Tab never reaches, a missing or broken skip
// link and jumps against the reading order (decisions in keyboardLogic.ts, text in keyboardReport.ts).
// The page is left as it was: focus, scroll positions and the selection are saved first and put back
// at the end, also on errors and cancellation. Page-side scripts run in the bridge's isolated world,
// except the click-handler probe, which needs the page's own world.
import { ToolError } from '../../core/errors';
import { ObjectArg, exceptionText, type PageCall } from './call';
import { focusedAcrossFrames } from './frameQuery';
import { frameLabel, ownerOf } from './frameTargets';
import { pressChord } from './input';
import { keyDefinition, type Modifier } from './keys';
import { WalkTracker, focusShows, judgeSkipLink, orderJumps, type Box, type RawStyle, type StepVerdict } from './keyboardLogic';
import { formatKeyboard, type KbEnd, type KbProblem, type KbStopLine } from './keyboardReport';
import { DialogInterrupt } from './pageState';
import { clip } from './ringBuffer';
import { DEEP_ACTIVE_ELEMENT, DESCRIBE, FOCUS } from './scripts';
import { elementBox, viewport, type ElementTarget, type Viewport } from './targets';

export const MAX_STOPS = 250;
export const TIME_LIMIT_MS = 30_000;
const MAX_PIXEL_CHECKS = 40;
const MAX_CANDIDATES = 200;
const MAX_CANDIDATE_ELEMENTS = 5000;
const MAX_DOCUMENTS = 10;
/** The bridge's own page indicator is a Tab stop too; it is stepped over, at most this many times in a row. */
const MAX_BRIDGE_SKIPS = 4;
/** Longest wait after a key press for the page to react. */
const SETTLE_MS = 30;

// ---------------------------------------------------------------- page-side scripts

/** Shared snippet: the parent across shadow roots and same-origin frames. */
const UP = `const up = (n) => n.parentNode && n.parentNode.nodeType === 11 ? n.parentNode.host : n.parentNode && n.parentNode.nodeType === 9 ? (n.parentNode.defaultView && n.parentNode.defaultView.frameElement) || null : n.parentNode;`;

/**
 * Isolated world, per document. Records the scroll offsets of the window and of every scrolled element
 * (open shadow roots and same-origin frames too, bounded), the selection and a focused field's text
 * selection, and listens for scrolling so that elements scrolled by the walk can be put back.
 */
const SAVE_VIEW = `function (maxElements) {
  const view = { wins: [], els: [], sels: [], fields: [], scrolled: new Set(), targets: [] };
  view.onScroll = (e) => { if (e.target && e.target.nodeType === 1) view.scrolled.add(e.target); };
  let count = 0;
  const listen = (t) => { t.addEventListener('scroll', view.onScroll, true); view.targets.push(t); };
  const visit = (root) => {
    for (const el of root.querySelectorAll('*')) {
      if (++count > maxElements) return;
      if (el.scrollTop || el.scrollLeft) view.els.push([el, el.scrollTop, el.scrollLeft]);
      if (el.shadowRoot) { listen(el.shadowRoot); visit(el.shadowRoot); }
      if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
        let doc = null;
        try { doc = el.contentDocument; } catch {}
        if (doc && doc.documentElement) visitDocument(doc);
      }
    }
  };
  const visitDocument = (doc) => {
    const win = doc.defaultView;
    if (!win) return;
    view.wins.push([win, win.scrollX, win.scrollY]);
    const sel = doc.getSelection();
    const ranges = [];
    if (sel) for (let i = 0; i < sel.rangeCount; i++) ranges.push(sel.getRangeAt(i).cloneRange());
    view.sels.push([doc, ranges]);
    const active = doc.activeElement;
    if (active && typeof active.selectionStart === 'number') {
      try { view.fields.push([active, active.selectionStart, active.selectionEnd, active.selectionDirection]); } catch {}
    }
    listen(win);
    visit(doc);
  };
  visitDocument(document);
  window.__copaneKbView = view;
  return count;
}`;

/** Isolated world, per document. Puts back what SAVE_VIEW recorded and stops listening. */
const RESTORE_VIEW = `function () {
  const view = window.__copaneKbView;
  if (!view) return false;
  delete window.__copaneKbView;
  for (const t of view.targets) t.removeEventListener('scroll', view.onScroll, true);
  const saved = new Set(view.els.map(e => e[0]));
  for (const el of view.scrolled) if (!saved.has(el) && el.isConnected) { el.scrollTop = 0; el.scrollLeft = 0; }
  for (const [el, top, left] of view.els) if (el.isConnected) { el.scrollTop = top; el.scrollLeft = left; }
  for (const [win, x, y] of view.wins) { try { if (win.scrollX !== x || win.scrollY !== y) win.scrollTo({ left: x, top: y, behavior: 'instant' }); } catch {} }
  for (const [doc, ranges] of view.sels) {
    const sel = doc.getSelection();
    if (!sel) continue;
    const same = sel.rangeCount === ranges.length && ranges.every((r, i) => {
      const now = sel.getRangeAt(i);
      return now.startContainer === r.startContainer && now.startOffset === r.startOffset && now.endContainer === r.endContainer && now.endOffset === r.endOffset;
    });
    if (same) continue;
    sel.removeAllRanges();
    for (const r of ranges) { try { sel.addRange(r); } catch {} }
  }
  for (const [el, start, end, dir] of view.fields) { try { if (el.isConnected) el.setSelectionRange(start, end, dir || 'none'); } catch {} }
  return true;
}`;

/**
 * Isolated world, \`this\` = the region element or the window. Moves the sequential focus navigation
 * starting point to the start of the region (or of the page): focuses a temporary element there and
 * removes it, so the next Tab goes to the first stop after that point. Whether that worked.
 */
const START_AT = `function () {
  const host = this && this.nodeType === 1 ? this : (document.body || document.documentElement);
  const doc = host.ownerDocument;
  const t = doc.createElement('span');
  t.tabIndex = -1;
  t.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap';
  (host.shadowRoot || host).prepend(t);
  t.focus({ preventScroll: true });
  const ok = t.getRootNode().activeElement === t;
  t.remove();
  return ok;
}`;

/**
 * Isolated world, \`this\` = the region element or the window. The element Tab should reach first: the
 * lowest positive tabindex of the page, else the first focusable element in document order (open
 * shadow roots and same-origin frames in place). An approximation, used only to start the walk when
 * moving the starting point did not work or a positive tabindex goes first.
 */
const FIRST_TABBABLE = `function () {
  const scope = this && this.nodeType === 1 ? this : (document.body || document.documentElement);
  const modal = scope.ownerDocument.querySelector(':modal');
  const usable = (el) => {
    if (el.tabIndex < 0 || el.disabled) return false;
    if ((el.tagName === 'A' || el.tagName === 'AREA') && !el.hasAttribute('href') && !el.hasAttribute('tabindex')) return false;
    if (el.closest('[inert],[data-copane-ui]')) return false;
    if (modal && el.ownerDocument === modal.ownerDocument && !modal.contains(el)) return false;
    if (el.checkVisibility && !el.checkVisibility({ visibilityProperty: true })) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0;
  };
  let first = null;
  let positive = null;
  const visit = (root, top) => {
    for (const el of root.children) {
      if (usable(el)) {
        if (top && el.tabIndex > 0 && (!positive || el.tabIndex < positive.tabIndex)) positive = el;
        if (!first && el.tabIndex === 0) first = el;
      }
      if (el.shadowRoot) visit(el.shadowRoot, false);
      if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
        let doc = null;
        try { doc = el.contentDocument; } catch {}
        if (doc && doc.body && !first) visit(doc.body, false);
      }
      visit(el, top);
    }
  };
  if (usable(scope)) first = scope;
  visit(scope, !(this && this.nodeType === 1));
  return positive || first;
}`;

/**
 * Element (this), isolated world. Marks it as reached (an expando of this world with the walk's token,
 * invisible to the page) and returns what the checks need: tabindex, fixed/sticky, main and modal
 * ancestors, visibility while focused, the styles that can show focus, and same-page link facts.
 */
const FOCUS_FACTS = `function (token) {
  ${UP}
  const el = this;
  el.__copaneKb = token;
  const doc = el.ownerDocument;
  const win = doc.defaultView;
  const style = (n, pseudo) => {
    if (!n || n.nodeType !== 1) return null;
    const s = n.ownerDocument.defaultView.getComputedStyle(n, pseudo);
    if (pseudo && (s.content === 'none' || s.content === 'normal')) return null;
    return {
      outlineStyle: s.outlineStyle, outlineWidth: s.outlineWidth, outlineColor: s.outlineColor, outlineOffset: s.outlineOffset, boxShadow: s.boxShadow,
      borderWidths: [s.borderTopWidth, s.borderRightWidth, s.borderBottomWidth, s.borderLeftWidth],
      borderStyles: [s.borderTopStyle, s.borderRightStyle, s.borderBottomStyle, s.borderLeftStyle],
      borderColors: [s.borderTopColor, s.borderRightColor, s.borderBottomColor, s.borderLeftColor],
      backgroundColor: s.backgroundColor, backgroundImage: s.backgroundImage, color: s.color, textDecoration: s.textDecorationLine + ' ' + s.textDecorationColor,
      opacity: s.opacity, transform: s.transform, content: pseudo ? s.content : 'none',
    };
  };
  const parent = (n) => n && (n.parentElement || (n.getRootNode && n.getRootNode().host) || null);
  const p1 = parent(el);
  const signature = [style(el), style(el, '::before'), style(el, '::after'), style(p1), style(parent(p1))];
  let bridgeUi = false, fixed = false, inMain = false, inModal = false, transparent = false;
  for (let n = el; n; n = up(n)) {
    if (n.nodeType !== 1) continue;
    if (n.hasAttribute('data-copane-ui')) bridgeUi = true;
    const s = n.ownerDocument.defaultView.getComputedStyle(n);
    if (s.position === 'fixed' || s.position === 'sticky') fixed = true;
    if (s.opacity === '0') transparent = true;
    if (n.tagName === 'MAIN' || n.getAttribute('role') === 'main') inMain = true;
    if ((n.tagName === 'DIALOG' && n.matches(':modal')) || n.getAttribute('aria-modal') === 'true') inModal = true;
  }
  const r = el.getBoundingClientRect();
  const hidden = r.width <= 1 || r.height <= 1 || transparent || r.right <= 0 || r.bottom <= 0 || r.left >= win.innerWidth || r.top >= win.innerHeight
    || (el.checkVisibility ? !el.checkVisibility({ visibilityProperty: true }) : false);
  const tag = el.tagName;
  const ti = el.getAttribute('tabindex');
  const tabindex = ti !== null && /^\\s*\\d+\\s*$/.test(ti) ? Number(ti) : 0;
  let skip = null;
  const href = tag === 'A' ? el.getAttribute('href') : null;
  if (href !== null) {
    let samePage = href.startsWith('#');
    if (!samePage) { try { const u = new URL(el.href); samePage = !!u.hash && u.origin + u.pathname + u.search === location.origin + location.pathname + location.search; } catch {} }
    if (samePage) {
      let target = '';
      try { target = decodeURIComponent(new URL(el.href).hash.slice(1)); } catch { target = href.slice(href.indexOf('#') + 1); }
      const t = target ? (doc.getElementById(target) || doc.getElementsByName(target)[0] || null) : null;
      const rendered = !!t && t.getClientRects().length > 0 && (!t.checkVisibility || t.checkVisibility());
      const main = !!t && !!(t.matches('main,[role=main]') || t.querySelector('main,[role=main]') || t.closest('main,[role=main]'));
      skip = { target, exists: !!t, rendered, main };
    }
  }
  const editable = el.isContentEditable || tag === 'TEXTAREA' || (tag === 'INPUT' && /^(text|search|email|url|tel|password|number|)$/.test((el.getAttribute('type') || '').toLowerCase()));
  let frameUrl = null;
  try { if (win.frameElement) frameUrl = doc.URL; } catch {}
  return { bridgeUi, fixed, inMain, inModal, hidden, tabindex, skip, signature, editable, frameUrl, rtl: getComputedStyle(document.documentElement).direction === 'rtl' };
}`;

/** Element (this), isolated world. The styles that can show focus (as in FOCUS_FACTS), read now. */
const STYLE_NOW = `function () {
  const style = (n, pseudo) => {
    if (!n || n.nodeType !== 1) return null;
    const s = n.ownerDocument.defaultView.getComputedStyle(n, pseudo);
    if (pseudo && (s.content === 'none' || s.content === 'normal')) return null;
    return {
      outlineStyle: s.outlineStyle, outlineWidth: s.outlineWidth, outlineColor: s.outlineColor, outlineOffset: s.outlineOffset, boxShadow: s.boxShadow,
      borderWidths: [s.borderTopWidth, s.borderRightWidth, s.borderBottomWidth, s.borderLeftWidth],
      borderStyles: [s.borderTopStyle, s.borderRightStyle, s.borderBottomStyle, s.borderLeftStyle],
      borderColors: [s.borderTopColor, s.borderRightColor, s.borderBottomColor, s.borderLeftColor],
      backgroundColor: s.backgroundColor, backgroundImage: s.backgroundImage, color: s.color, textDecoration: s.textDecorationLine + ' ' + s.textDecorationColor,
      opacity: s.opacity, transform: s.transform, content: pseudo ? s.content : 'none',
    };
  };
  const parent = (n) => n && (n.parentElement || (n.getRootNode && n.getRootNode().host) || null);
  const p1 = parent(this);
  return [style(this), style(this, '::before'), style(this, '::after'), style(p1), style(parent(p1))];
}`;

/** Element (this), any world. `(other)` → whether other is this or inside it (shadow roots, same-origin frames). */
const CONTAINS_DEEP = `function (other) {
  ${UP}
  for (let n = other; n; n = up(n)) if (n === this) return true;
  return false;
}`;

/** Isolated world. `(...elements)` → their lowest common ancestor (across shadow roots), or null. */
const COMMON_ANCESTOR = `function (...els) {
  ${UP}
  const chain = (n) => { const out = []; for (; n; n = up(n)) out.unshift(n); return out; };
  const chains = els.map(chain);
  let common = null;
  for (let i = 0; ; i++) {
    const n = chains[0][i];
    if (!n || !chains.every(c => c[i] === n)) break;
    common = n;
  }
  if (!common || common.nodeType !== 1 || common === document.body || common === document.documentElement) return null;
  return common;
}`;

/**
 * Two animation frames (the browser has painted what the last key press changed), or \`ms\`, whichever
 * comes first. It ends by itself: a command left waiting would fail when the page navigates later,
 * and that failure ends the tab's whole CDP connection (cdp.ts).
 */
const PAINTED = `function (ms) {
  return new Promise(resolve => {
    setTimeout(() => resolve(false), ms);
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
  });
}`;

/** Isolated world, top document. Counts DOM changes (not the bridge's own UI) until read by WATCH_READ. */
const WATCH_START = `function () {
  const watch = { count: 0 };
  watch.observer = new MutationObserver(list => {
    for (const m of list) {
      const t = m.target.nodeType === 1 ? m.target : m.target.parentElement;
      if (t && t.closest && t.closest('[data-copane-ui]')) continue;
      watch.count++;
    }
  });
  watch.observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  window.__copaneKbWatch = watch;
}`;

const WATCH_READ = `function () {
  const watch = window.__copaneKbWatch;
  if (!watch) return 0;
  watch.observer.takeRecords();
  watch.observer.disconnect();
  delete window.__copaneKbWatch;
  return watch.count;
}`;

/**
 * Isolated world, \`this\` = the region element or the window. Elements that look interactive but were
 * not reached: an interactive role, an onclick attribute, or cursor: pointer (not inherited). Visible,
 * enabled, not inert, not inside or around a reached element, not part of a widget that moves focus
 * with the arrow keys (tabs, menus, radio groups) where one member was reached. Kept in a global of
 * this world (read back by index); returns the total and the first ones with why.
 */
const UNREACHED = `function (token, maxElements, maxCandidates) {
  ${UP}
  const ROLES = ['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'slider', 'combobox', 'textbox', 'searchbox', 'spinbutton', 'treeitem'];
  const COMPOSITE = '[role=tablist],[role=menu],[role=menubar],[role=listbox],[role=radiogroup],[role=tree],[role=treegrid],[role=grid],[role=toolbar]';
  const implicit = (el) => {
    const tag = el.tagName;
    if ((tag === 'A' || tag === 'AREA') && el.hasAttribute('href')) return 'link';
    if (tag === 'BUTTON' || tag === 'SUMMARY') return 'button';
    if (tag === 'SELECT') return 'combobox';
    if (tag === 'TEXTAREA') return 'textbox';
    if (tag === 'INPUT') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'hidden') return '';
      if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
      if (type === 'checkbox' || type === 'radio') return type;
      if (type === 'range') return 'slider';
      return 'textbox';
    }
    return '';
  };
  const reached = (el) => el.__copaneKb === token;
  const scope = this && this.nodeType === 1 ? this : document.documentElement;
  const all = [scope];
  const visit = (root) => {
    for (const el of root.querySelectorAll('*')) {
      if (all.length >= maxElements) return;
      all.push(el);
      if (el.shadowRoot) visit(el.shadowRoot);
      if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
        let doc = null;
        try { doc = el.contentDocument; } catch {}
        if (doc && doc.documentElement) { all.push(doc.documentElement); visit(doc.documentElement); }
      }
    }
  };
  if (scope.shadowRoot) visit(scope.shadowRoot);
  visit(scope);
  const reachedEls = all.filter(reached);
  const within = (n, ancestor) => { for (let x = n; x; x = up(x)) if (x === ancestor) return true; return false; };
  const out = [];
  const els = [];
  let total = 0;
  for (const el of all) {
    if (el.nodeType !== 1 || reached(el)) continue;
    const tag = el.tagName;
    if (['HTML', 'BODY', 'LABEL', 'OPTION', 'OPTGROUP', 'IFRAME', 'FRAME'].includes(tag)) continue;
    const explicit = (el.getAttribute('role') || '').trim().split(/\\s+/)[0];
    const role = explicit || implicit(el);
    const interactive = ROLES.includes(role);
    const onclick = el.hasAttribute('onclick');
    const win = el.ownerDocument.defaultView;
    if (!win) continue;
    let pointer = false;
    if (!interactive && !onclick) {
      if (win.getComputedStyle(el).cursor !== 'pointer') continue;
      const p = up(el);
      if (p && p.nodeType === 1 && p.ownerDocument === el.ownerDocument && win.getComputedStyle(p).cursor === 'pointer') continue;
      pointer = true;
    }
    if (el.disabled || el.closest('[inert],[aria-disabled="true"],[data-copane-ui]')) continue;
    if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const modal = el.ownerDocument.querySelector(':modal');
    if (modal && !modal.contains(el)) continue;
    let near = false;
    for (let n = up(el); n && !near; n = up(n)) if (n.nodeType === 1 && reached(n)) near = true;
    if (near || reachedEls.some(x => within(x, el))) continue;
    const group = el.closest(COMPOSITE);
    if (group && (reached(group) || reachedEls.some(x => within(x, group)))) continue;
    if (tag === 'INPUT' && el.type === 'radio' && el.name) {
      const peers = (el.form || el.ownerDocument).querySelectorAll('input[type=radio]');
      if ([...peers].some(p => p.name === el.name && reached(p))) continue;
    }
    total++;
    if (els.length >= maxCandidates) continue;
    const ti = el.getAttribute('tabindex');
    let why;
    if (interactive) why = 'role=' + role + (ti !== null && Number(ti) < 0 ? ', tabindex=' + ti : explicit ? ', no tabindex' : '');
    else if (onclick) why = 'onclick' + (ti !== null && Number(ti) < 0 ? ', tabindex=' + ti : '');
    else why = 'cursor: pointer';
    els.push(el);
    out.push({ index: els.length - 1, weak: pointer, why });
  }
  window.__copaneKbCandidates = els;
  return { total, items: out };
}`;

/** Page's own world, element (this): a click handler set by React (props) or Vue 3 (invokers). */
const CLICK_PROPS = `function () {
  try {
    for (const k of Object.keys(this)) {
      if (k.startsWith('__reactProps$') && this[k] && (this[k].onClick || this[k].onMouseDown || this[k].onPointerDown)) return true;
    }
    if (this._vei && (this._vei.onClick || this._vei.onMousedown || this._vei.onPointerdown)) return true;
  } catch {}
  return false;
}`;

// ---------------------------------------------------------------- the walk

interface Facts {
  bridgeUi: boolean;
  fixed: boolean;
  inMain: boolean;
  inModal: boolean;
  hidden: boolean;
  tabindex: number;
  skip: { target: string; exists: boolean; rendered: boolean; main: boolean } | null;
  signature: Array<RawStyle | null>;
  editable: boolean;
  frameUrl: string | null;
  rtl: boolean;
}

interface Stop {
  key: string;
  at: PageCall;
  /** Handle in the bridge's isolated world of the element's target. */
  objectId: string;
  backendNodeId: number;
  label: string;
  name: string;
  box?: Box;
  frame?: string;
  doc: string;
  facts: Facts;
  scripted?: boolean;
  /** The element focused, captured while focused (top target only), for the pixel check. */
  shot?: { data: string; clip: Record<string, number>; pageX: number; pageY: number };
}

/** A document whose view was saved: restored with its own world even after cancellation. */
interface SavedDoc {
  at: PageCall;
  contextId: number;
}

const isHard = (err: unknown) => err instanceof DialogInterrupt || (err instanceof ToolError && (err.code === 'cancelled' || err.code === 'not_found'));

function rethrowHard(err: unknown): void {
  if (isHard(err)) throw err;
}

function message(err: unknown): string {
  return err instanceof Error ? clip(err.message, 200) : String(err);
}

/** Sends a command on a call's session without the call's cancellation and dialog checks (for restoring). */
async function raw(at: PageCall, method: string, params: Record<string, unknown>): Promise<any> {
  const r = await at.cdp.send(method, params, { timeoutMs: 5000 });
  if (r?.exceptionDetails) throw new Error(exceptionText(r.exceptionDetails));
  return r;
}

function frameName(url: string): string {
  try {
    const u = new URL(url);
    return `the frame ${clip(`${u.origin}${u.pathname}`, 120)}`;
  } catch {
    return `the frame ${clip(url, 120)}`;
  }
}

class Walk {
  private readonly token = `kb${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  private readonly started = Date.now();
  private readonly loaderId: string | undefined;
  private readonly stops = new Map<string, Stop>();
  private readonly notVisible = new Map<string, string>();
  private readonly visibilityChecked = new Set<string>();
  private pixelChecks = 0;
  /** The region as a handle in the isolated world of its target. */
  private region: { at: PageCall; objectId: string } | undefined;
  private saved: SavedDoc[] = [];
  private focusedBefore: { at: PageCall; objectId: string } | undefined;
  private frameEmulation: PageCall[] = [];
  private watching = false;
  private last: Stop | undefined;
  readonly notes: string[] = [];

  constructor(
    private readonly call: PageCall,
    private readonly root: ElementTarget | undefined,
  ) {
    this.loaderId = call.state.loaderId;
  }

  get elapsed(): number {
    return Date.now() - this.started;
  }

  // ---------------------------------------------------------------- save and restore

  async save(): Promise<void> {
    const { call } = this;
    this.focusedBefore = await focusedAcrossFrames(call, DEEP_ACTIVE_ELEMENT);
    const ats = [call, ...call.state.frames.list().filter(f => !f.session.closed).map(f => call.at(f))].slice(0, MAX_DOCUMENTS);
    for (const at of ats) {
      try {
        const contextId = at.frame ? await call.state.frames.isolatedWorld(at.frame) : await call.state.isolatedWorld();
        await at.evaluate(SAVE_VIEW, [20_000], { timeoutMs: at.frame ? 3000 : 10_000 });
        this.saved.push({ at, contextId });
      } catch (err) {
        rethrowHard(err);
        if (at === call) throw err;
      }
      if (at.frame) {
        // Frames run in their own processes, which the page target's focus emulation does not reach.
        try {
          await at.send('Emulation.setFocusEmulationEnabled', { enabled: true }, { timeoutMs: 3000 });
          this.frameEmulation.push(at);
        } catch (err) {
          rethrowHard(err);
        }
      }
    }
  }

  /** Puts focus, scroll and selection back. Returns why that failed, or undefined. */
  async restore(): Promise<string | undefined> {
    const { call } = this;
    let failure: string | undefined;
    const navigated = call.state.loaderId !== this.loaderId;
    if (navigated) failure = 'the page navigated';
    else if (call.state.dialog) failure = 'a dialog is open in the page';
    else if (call.page.closed) failure = 'the tab was closed';
    if (!failure) {
      try {
        if (this.focusedBefore) {
          await raw(this.focusedBefore.at, 'Runtime.callFunctionOn', { functionDeclaration: FOCUS, objectId: this.focusedBefore.objectId, returnByValue: true });
        } else {
          // Nothing was focused: leave nothing focused, with Tab starting from the top again.
          const top = this.saved[0];
          if (top) await raw(top.at, 'Runtime.callFunctionOn', { functionDeclaration: START_AT, executionContextId: top.contextId, returnByValue: true });
        }
      } catch (err) {
        failure = `focus: ${message(err)}`;
      }
      for (const doc of this.saved) {
        try {
          await raw(doc.at, 'Runtime.callFunctionOn', { functionDeclaration: RESTORE_VIEW, executionContextId: doc.contextId, returnByValue: true });
        } catch (err) {
          if (doc.at === call) failure ??= `scroll: ${message(err)}`;
        }
      }
    }
    for (const at of this.frameEmulation) {
      if (at.cdp.closed) continue;
      await at.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false }, { timeoutMs: 3000 }).catch(() => undefined);
    }
    return failure;
  }

  async startWatch(): Promise<void> {
    try {
      await this.call.evaluate(WATCH_START);
      this.watching = true;
    } catch (err) {
      rethrowHard(err);
    }
  }

  async readWatch(): Promise<number> {
    if (!this.watching || this.call.state.loaderId !== this.loaderId || this.call.state.dialog) return 0;
    const top = this.saved[0];
    if (!top) return 0;
    try {
      return Number((await raw(top.at, 'Runtime.callFunctionOn', { functionDeclaration: WATCH_READ, executionContextId: top.contextId, returnByValue: true })).result?.value ?? 0);
    } catch {
      return 0;
    }
  }

  // ---------------------------------------------------------------- region

  /** The region as a handle in the isolated world of its target (its frame's world, for a same-origin frame). */
  async resolveRegion(): Promise<void> {
    const root = this.root;
    if (!root) return;
    const at = root.call;
    const entry = root.ref ? this.call.refs.get(root.ref) : undefined;
    const frameIds: Array<string | undefined> = [undefined];
    if (entry?.frameId && !at.frame && entry.frameId !== this.call.state.mainFrameId) frameIds.push(entry.frameId);
    if (at.frame) frameIds.push(...[...at.frame.localFrames].filter(id => id !== at.frame!.id));
    else frameIds.push(...(await this.sameOriginFrameIds()));
    for (const frameId of frameIds) {
      try {
        const contextId = at.frame ? await this.call.state.frames.isolatedWorld(at.frame, frameId) : await this.call.state.isolatedWorld(frameId);
        const { object } = await at.send('DOM.resolveNode', { backendNodeId: root.backendNodeId, executionContextId: contextId, objectGroup: this.call.group });
        if (object?.objectId) {
          this.region = { at, objectId: object.objectId };
          return;
        }
      } catch (err) {
        rethrowHard(err);
      }
    }
    throw new ToolError('failed', `Could not walk ${root.label}: its document could not be reached. Take a snapshot and pass the ref of a container instead.`);
  }

  private async sameOriginFrameIds(): Promise<string[]> {
    try {
      const { frameTree } = await this.call.send('Page.getFrameTree');
      const out: string[] = [];
      const walk = (node: any) => {
        for (const child of node.childFrames ?? []) {
          if (!this.call.state.frames.targetOf(child.frame.id)) out.push(child.frame.id);
          walk(child);
        }
      };
      walk(frameTree);
      return out.slice(0, 20);
    } catch (err) {
      rethrowHard(err);
      return [];
    }
  }

  /** Whether a stop is inside the region (always true without one). */
  private async inRegion(stop: { at: PageCall; objectId: string }): Promise<boolean> {
    const region = this.region;
    if (!region) return true;
    try {
      if (stop.at === region.at) return await region.at.callOn<boolean>(region.objectId, CONTAINS_DEEP, [new ObjectArg(stop.objectId)]);
      // A stop in a cross-origin frame: inside when the frame's <iframe> (at the region's level) is.
      const frames = this.call.state.frames;
      if (!stop.at.frame) return false;
      const level = frames.chain(stop.at.frame).find(f => frames.parentOf(f) === region.at.frame);
      if (!level) return false;
      const owner = await ownerOf(this.call, level);
      const contextId = region.at.frame ? await frames.isolatedWorld(region.at.frame) : await this.call.state.isolatedWorld();
      const { object } = await region.at.send('DOM.resolveNode', { backendNodeId: owner, executionContextId: contextId, objectGroup: this.call.group });
      return Boolean(object?.objectId) && (await region.at.callOn<boolean>(region.objectId, CONTAINS_DEEP, [new ObjectArg(object.objectId)]));
    } catch (err) {
      rethrowHard(err);
      return false;
    }
  }

  // ---------------------------------------------------------------- one step

  private async press(modifiers: Modifier[] = []): Promise<void> {
    const { call } = this;
    await pressChord(call, { modifiers, key: keyDefinition('Tab')! });
    await this.settle();
    this.checkNavigation();
  }

  /**
   * Gives the page's focus handlers time to run (a script moving focus on in a timeout or a frame).
   * Two animation frames when the tab paints at full rate; VS Code paints a tab in the background only
   * about twice a second, so the wait is capped. Reading focus and styles needs no paint, and a
   * screenshot paints by itself.
   */
  private async settle(): Promise<void> {
    try {
      await this.call.evaluate(PAINTED, [SETTLE_MS], { timeoutMs: 5000 });
    } catch (err) {
      rethrowHard(err);
    }
  }

  private checkNavigation(): void {
    const { call } = this;
    if (call.state.loaderId === this.loaderId && !call.state.crashed) return;
    const where = this.last ? ` (focus reached ${this.last.label}, whose focus handler may load another page)` : '';
    const what = call.state.crashed ? 'crashed' : 'navigated';
    throw new ToolError('failed', `The page in ${call.tab.id} ${what} while Tab was pressed${where}. The walk stopped at stop ${this.stops.size}; focus and scroll could not be restored. Take a snapshot.`);
  }

  /** The focused element's key, handle and target, or undefined when nothing in the page has focus. */
  private async focused(): Promise<{ key: string; at: PageCall; objectId: string; backendNodeId: number } | undefined> {
    const found = await focusedAcrossFrames(this.call, DEEP_ACTIVE_ELEMENT);
    if (!found) return undefined;
    const { node } = await found.at.send('DOM.describeNode', { objectId: found.objectId });
    return { key: `${found.at.frame?.id ?? 'top'}#${node.backendNodeId}`, at: found.at, objectId: found.objectId, backendNodeId: node.backendNodeId };
  }

  /** Describes the focused element (role, name, ref, position) and reads its facts. */
  private async describe(found: { key: string; at: PageCall; objectId: string; backendNodeId: number }, vp: Viewport): Promise<Stop> {
    const known = this.stops.get(found.key);
    const facts = await found.at.callOn<Facts>(found.objectId, FOCUS_FACTS, [this.token]);
    if (known) return { ...known, objectId: found.objectId, facts };
    const { label, name } = await this.labelOf(found.at, found.backendNodeId, found.objectId, facts.frameUrl);
    const view = await elementBox(found.at, found.backendNodeId);
    const box = view && { x: view.x + vp.pageX, y: view.y + vp.pageY, width: view.width, height: view.height };
    const frame = facts.frameUrl ? frameName(facts.frameUrl) : found.at.frame ? frameLabel(found.at.frame) : undefined;
    const doc = `${found.at.frame?.id ?? 'top'}|${facts.frameUrl ?? ''}`;
    return { key: found.key, at: found.at, objectId: found.objectId, backendNodeId: found.backendNodeId, label, name, box, frame, doc, facts };
  }

  /** 'button "Search" [ref=e40]', or the element's HTML with a ref when it has no role. Assigns refs as browser_snapshot does. */
  async labelOf(at: PageCall, backendNodeId: number, objectId: string, frameUrl: string | null): Promise<{ label: string; name: string }> {
    const { call } = this;
    const ax = await at.describeAx(backendNodeId);
    const role = ax && !ax.ignored ? ax.role : 'generic';
    const name = ax && !ax.ignored ? ax.name : '';
    let frameId = at.frame?.id ?? call.state.mainFrameId ?? '';
    if (frameUrl) frameId = (await this.frameIdOf(at, objectId)) ?? frameId;
    const ref = call.refs.assign({ backendNodeId, frameId, role, name, ...(at.frame ? { frame: at.frame.id, frameLoaderId: at.frame.loaderId } : {}) }, call.state.loaderId);
    let what = role !== 'generic' && role !== 'none' ? `${role}${name ? ` "${clip(name, 50)}"` : ''}` : '';
    if (!what) {
      try {
        what = clip(await at.callOn<string>(objectId, DESCRIBE), 70);
      } catch (err) {
        rethrowHard(err);
        what = role;
      }
    }
    return { label: `${what} [ref=${ref}]`, name };
  }

  /** The frame id of a same-origin frame holding an element (through its <iframe>). */
  private async frameIdOf(at: PageCall, objectId: string): Promise<string | undefined> {
    try {
      const owner = await at.callOn(objectId, 'function () { return this.ownerDocument.defaultView.frameElement; }', [], { returnByValue: false });
      if (!owner?.objectId) return undefined;
      const { node } = await at.send('DOM.describeNode', { objectId: owner.objectId });
      return node.frameId;
    } catch (err) {
      rethrowHard(err);
      return undefined;
    }
  }

  /** A PNG of the element's area while focused (top target), unless it shows an outline anyway. */
  private async shoot(stop: Stop, vp: Viewport): Promise<Stop['shot']> {
    if (stop.at.frame || stop.facts.hidden || stop.facts.editable || this.pixelChecks >= MAX_PIXEL_CHECKS) return undefined;
    const self = stop.facts.signature[0];
    if (self && self.outlineStyle !== 'none' && Number.parseFloat(self.outlineWidth) > 0) return undefined;
    const view = await elementBox(stop.at, stop.backendNodeId);
    if (!view) return undefined;
    const m = 8;
    const x = Math.max(0, view.x - m);
    const y = Math.max(0, view.y - m);
    const width = Math.min(600, Math.min(vp.width, view.x + view.width + m) - x);
    const height = Math.min(300, Math.min(vp.height, view.y + view.height + m) - y);
    if (width < 2 || height < 2) return undefined;
    this.pixelChecks++;
    const area = { x: x + vp.pageX, y: y + vp.pageY, width, height, scale: 1 };
    try {
      const { data } = await this.call.send('Page.captureScreenshot', { format: 'png', clip: area, fromSurface: true }, { timeoutMs: 5000 });
      return { data, clip: area, pageX: vp.pageX, pageY: vp.pageY };
    } catch (err) {
      rethrowHard(err);
      return undefined;
    }
  }

  /** Focus visibility of a stop that has just lost focus (WCAG 2.4.7). */
  private async checkVisibility(stop: Stop, vp: Viewport): Promise<void> {
    if (this.visibilityChecked.has(stop.key)) return;
    this.visibilityChecked.add(stop.key);
    if (stop.facts.hidden) {
      this.notVisible.set(stop.key, `${stop.label} (hidden or off-screen when focused)`);
      return;
    }
    let now: Array<RawStyle | null>;
    try {
      now = await stop.at.callOn<Array<RawStyle | null>>(stop.objectId, STYLE_NOW);
    } catch (err) {
      rethrowHard(err);
      return; // Gone from the page.
    }
    if (focusShows(stop.facts.signature, now)) return;
    // A text field shows the caret.
    if (stop.facts.editable) return;
    if (stop.shot && stop.shot.pageX === vp.pageX && stop.shot.pageY === vp.pageY) {
      try {
        const { data } = await this.call.send('Page.captureScreenshot', { format: 'png', clip: stop.shot.clip, fromSurface: true }, { timeoutMs: 5000 });
        if (data !== stop.shot.data) return;
        this.notVisible.set(stop.key, stop.label);
        return;
      } catch (err) {
        rethrowHard(err);
      }
    }
    this.notVisible.set(stop.key, `${stop.label} (${stop.frame ? `in ${stop.frame}; ` : ''}style check only)`);
  }

  /**
   * Presses Tab and records the stop focus lands on (stepping over the bridge's own indicator).
   * Undefined when nothing in the page has focus.
   */
  private async step(modifiers: Modifier[] = []): Promise<{ stop: Stop | undefined; vp: Viewport }> {
    for (let skips = 0; ; skips++) {
      await this.press(modifiers);
      const vp = await viewport(this.call);
      const found = await this.focused();
      if (!found) return { stop: undefined, vp };
      const stop = await this.describe(found, vp);
      if (stop.facts.bridgeUi && skips < MAX_BRIDGE_SKIPS) continue;
      return { stop, vp };
    }
  }

  /** Records a stop as the current one, and checks the previous one's focus visibility. */
  private async arrive(stop: Stop | undefined, vp: Viewport): Promise<void> {
    if (this.last && this.last.key !== stop?.key) await this.checkVisibility(this.last, vp);
    if (stop && !this.stops.has(stop.key)) {
      stop.shot = await this.shoot(stop, vp);
      this.stops.set(stop.key, stop);
    }
    if (stop) this.last = this.stops.get(stop.key);
  }

  // ---------------------------------------------------------------- run

  async run(): Promise<string> {
    let end: KbEnd;
    let order: Stop[] = [];
    let trapProblem: KbProblem | undefined;
    let notRestored: string | undefined;
    let pageChanges = 0;
    const tracker = new WalkTracker();
    try {
      await this.resolveRegion();
      await this.save();
      const first = await this.start();
      await this.startWatch();
      let verdict: StepVerdict | { kind: 'outside'; label?: string } = { kind: 'continue' };
      let current = first;
      for (;;) {
        if (current.stop && !(await this.inRegion(current.stop))) {
          verdict = { kind: 'outside', label: current.stop.label };
          break;
        }
        verdict = tracker.push(current.stop?.key);
        if (verdict.kind !== 'continue') break;
        if (tracker.stops.length >= MAX_STOPS || this.elapsed >= TIME_LIMIT_MS) break;
        current = await this.step();
        await this.arrive(current.stop, current.vp);
      }
      order = tracker.stops.map(k => this.stops.get(k)!);
      const inModal = order.length > 0 && order.every(s => s.facts.inModal);
      if (verdict.kind === 'outside') end = order.length ? { kind: 'left-region' } : { kind: 'empty', next: verdict.label };
      else if (verdict.kind === 'continue') end = tracker.stops.length >= MAX_STOPS ? { kind: 'limit' } : { kind: 'time' };
      else if (verdict.kind === 'stuck') {
        end = { kind: 'trap', stop: verdict.index + 1 };
        const stop = order[verdict.index]!;
        trapProblem = { id: 'keyboard-trap', count: 1, what: 'Tab is captured: focus does not move on; WCAG allows it only if the page says how to leave', items: [stop.label] };
      } else if (verdict.kind === 'wrap' || verdict.kind === 'left' || verdict.kind === 'cycle') {
        const cycle = verdict.kind === 'cycle' ? order.slice(verdict.start, verdict.start + verdict.length) : order;
        const contained = verdict.kind === 'cycle' ? cycle.some(s => s.facts.inModal) : inModal;
        if (contained) end = { kind: 'modal' };
        else if (verdict.kind === 'wrap' && this.root && (await this.regionHoldsPageStart())) end = { kind: 'complete' };
        else if (verdict.kind === 'cycle' || (this.root && verdict.kind === 'wrap')) {
          // Focus goes round inside part of the page (or the region never lets it out).
          const start = verdict.kind === 'cycle' ? verdict.start : 0;
          end = { kind: 'trap', stop: start + 1 };
          trapProblem = await this.trap(cycle);
        } else end = this.root ? { kind: 'left-region' } : { kind: 'complete' };
      } else end = { kind: 'complete' };
    } finally {
      pageChanges = await this.readWatch();
      notRestored = await this.restore();
    }
    return this.report(order, end, trapProblem, notRestored, pageChanges);
  }

  /** Moves the Tab starting point to the region's (or page's) start and takes the first step. */
  private async start(): Promise<{ stop: Stop | undefined; vp: Viewport }> {
    const { call } = this;
    const scope = this.region ?? { at: call, objectId: undefined };
    let first: { objectId: string; positive: boolean } | undefined;
    try {
      const handle = scope.objectId
        ? await scope.at.callOn(scope.objectId, FIRST_TABBABLE, [], { returnByValue: false })
        : await scope.at.evaluateHandle(FIRST_TABBABLE);
      if (handle?.objectId && handle.subtype !== 'null') first = { objectId: handle.objectId, positive: (await scope.at.callOn<number>(handle.objectId, 'function () { return this.tabIndex; }')) > 0 };
    } catch (err) {
      rethrowHard(err);
    }
    if (!(first?.positive && !this.root)) {
      let moved = false;
      try {
        moved = scope.objectId ? await scope.at.callOn<boolean>(scope.objectId, START_AT) : await scope.at.evaluate<boolean>(START_AT);
      } catch (err) {
        rethrowHard(err);
      }
      const taken = await this.step();
      if (moved || !first) {
        await this.arrive(taken.stop, taken.vp);
        return taken;
      }
      const { node } = await scope.at.send('DOM.describeNode', { objectId: first.objectId });
      if (taken.stop && taken.stop.key === `${scope.at.frame?.id ?? 'top'}#${node.backendNodeId}`) {
        await this.arrive(taken.stop, taken.vp);
        return taken;
      }
    }
    // Tab cannot be made to start there (or a positive tabindex goes first): focus the first stop by script.
    await scope.at.callOn(first!.objectId, 'function () { this.focus(); }');
    await this.settle();
    const vp = await viewport(call);
    const found = await this.focused();
    const stop = found && (await this.describe(found, vp));
    if (stop) stop.scripted = true;
    this.notes.push(
      first!.positive
        ? 'Stop 1 was focused by script: a positive tabindex puts it first; Tab continued from there.'
        : 'Stop 1 was focused by script (Tab could not be made to start at the beginning); Tab continued from there.',
    );
    await this.arrive(stop, vp);
    return { stop, vp };
  }

  /**
   * Whether the region holds the page's first stop: then Tab going round inside it is the page's own
   * wrap from its end to its start (a region around everything), not a trap.
   */
  private async regionHoldsPageStart(): Promise<boolean> {
    try {
      const handle = await this.call.evaluateHandle(FIRST_TABBABLE);
      if (!handle?.objectId || handle.subtype === 'null') return false;
      return await this.inRegion({ at: this.call, objectId: handle.objectId });
    } catch (err) {
      rethrowHard(err);
      return false;
    }
  }

  /** Shift+Tab from inside a cycle: does it get out? Returns the trap problem. */
  private async trap(cycle: Stop[]): Promise<KbProblem> {
    const keys = new Set(cycle.map(s => s.key));
    let leaves = false;
    for (let i = 0; i <= cycle.length && !leaves; i++) {
      await this.press(['Shift']);
      const found = await this.focused();
      if (!found || !keys.has(found.key)) leaves = true;
    }
    const region = await this.trapRegion(cycle);
    const back = leaves ? 'Shift+Tab leaves it' : 'Shift+Tab cannot leave it either';
    return { id: 'keyboard-trap', count: 1, what: `Tab cycles inside ${region} through ${cycle.length} stops; ${back}`, items: [cycle.map(s => s.label).join('; ')] };
  }

  /** The smallest element around all stops of a cycle (when they share a target), else their frame. */
  private async trapRegion(cycle: Stop[]): Promise<string> {
    const at = cycle[0]!.at;
    if (cycle.every(s => s.at === at)) {
      try {
        const handle = await at.callOn(cycle[0]!.objectId, COMMON_ANCESTOR, cycle.map(s => new ObjectArg(s.objectId)), { returnByValue: false });
        if (handle?.objectId && handle.subtype !== 'null') {
          const { node } = await at.send('DOM.describeNode', { objectId: handle.objectId });
          return (await this.labelOf(at, node.backendNodeId, handle.objectId, null)).label;
        }
      } catch (err) {
        rethrowHard(err);
      }
      return at.frame ? frameLabel(at.frame) : 'the page';
    }
    const outer = cycle.map(s => s.at.frame).find(f => f && !this.call.state.frames.parentOf(f));
    return outer ? frameLabel(outer) : 'several frames';
  }

  // ---------------------------------------------------------------- checks after the walk

  /** Interactive-looking elements Tab never reached (WCAG 2.1.1), over the region or every document. */
  private async unreachable(): Promise<KbProblem | undefined> {
    const { call } = this;
    const scopes: Array<{ at: PageCall; objectId?: string }> = this.region
      ? [this.region]
      : [{ at: call }, ...call.state.frames.list().filter(f => !f.session.closed).map(f => ({ at: call.at(f) }))].slice(0, MAX_DOCUMENTS);
    // Candidates by strength: 0 an interactive role or onclick, 1 cursor: pointer with a click handler, 2 without one.
    const found: Array<{ at: PageCall; objectId: string; backendNodeId: number; why: string; rank: number }> = [];
    let total = 0;
    for (const scope of scopes) {
      let r: { total: number; items: Array<{ index: number; weak: boolean; why: string }> };
      try {
        r = scope.objectId
          ? await scope.at.callOn(scope.objectId, UNREACHED, [this.token, MAX_CANDIDATE_ELEMENTS, MAX_CANDIDATES], { timeoutMs: 20_000 })
          : await scope.at.evaluate(UNREACHED, [this.token, MAX_CANDIDATE_ELEMENTS, MAX_CANDIDATES], { timeoutMs: 20_000 });
      } catch (err) {
        rethrowHard(err);
        continue;
      }
      total += r.total;
      for (const item of r.items) {
        if (found.length >= MAX_CANDIDATES) break;
        try {
          const handle = await scope.at.evaluateHandle('function (i) { return (window.__copaneKbCandidates || [])[i] || null; }', [item.index]);
          if (!handle?.objectId) continue;
          const { node } = await scope.at.send('DOM.describeNode', { objectId: handle.objectId });
          let why = item.why;
          let rank = 0;
          if (item.weak) {
            const evidence = await this.clickHandler(scope.at, node.backendNodeId);
            why = evidence ? 'click handler, cursor: pointer' : 'cursor: pointer, no handler found: maybe decorative';
            rank = evidence ? 1 : 2;
          }
          found.push({ at: scope.at, objectId: handle.objectId, backendNodeId: node.backendNodeId, why, rank });
        } catch (err) {
          rethrowHard(err);
        }
      }
    }
    if (!total) return undefined;
    // Only what is shown needs a label (and a ref); the rest is counted.
    const items: string[] = [];
    for (const c of found.sort((a, b) => a.rank - b.rank).slice(0, 8)) {
      try {
        items.push(`${(await this.labelOf(c.at, c.backendNodeId, c.objectId, null)).label} (${c.why})`);
      } catch (err) {
        rethrowHard(err);
      }
    }
    return { id: 'not-focusable', count: total, items };
  }

  /** Whether the page's own world shows a click (or press) handler on the element. */
  private async clickHandler(at: PageCall, backendNodeId: number): Promise<boolean> {
    try {
      const objectId = await at.resolve(backendNodeId);
      const { listeners } = await at.send('DOMDebugger.getEventListeners', { objectId, depth: 0 }, { timeoutMs: 5000 });
      if ((listeners ?? []).some((l: { type: string }) => /^(click|mousedown|mouseup|pointerdown|pointerup|keydown|touchstart)$/.test(l.type))) return true;
      return await at.callOn<boolean>(objectId, CLICK_PROPS);
    } catch (err) {
      rethrowHard(err);
      return false;
    }
  }

  // ---------------------------------------------------------------- report

  private async report(order: Stop[], end: KbEnd, trapProblem: KbProblem | undefined, notRestored: string | undefined, pageChanges: number): Promise<string> {
    const problems: KbProblem[] = [];
    if (trapProblem) problems.push(trapProblem);
    const complete = end.kind === 'complete' || end.kind === 'left-region' || end.kind === 'modal' || end.kind === 'empty';
    const notVisible = order.filter(s => this.notVisible.has(s.key)).map(s => this.notVisible.get(s.key)!);
    if (notVisible.length) problems.push({ id: 'focus-not-visible', count: notVisible.length, items: notVisible });
    if (complete && !notRestored?.startsWith('the page navigated')) {
      const unreachable = await this.unreachable();
      if (unreachable) problems.push(unreachable);
    }
    if (complete && !this.root && end.kind === 'complete') {
      const skip = judgeSkipLink(order.map(s => ({ label: s.label, name: s.name, skip: s.facts.skip ?? undefined, inMain: s.facts.inMain })));
      if (skip.kind === 'missing') problems.push({ id: 'skip-link-missing', count: 1, what: `${skip.before} stops before the main content (first in <main>: ${skip.firstMain})`, items: [] });
      if (skip.kind === 'broken') problems.push({ id: 'skip-link-broken', count: 1, what: `the skip link goes nowhere: ${skip.why}`, items: [skip.label] });
    }
    const ltr = !(order[0]?.facts.rtl ?? false);
    const jumps = orderJumps(order.map(s => ({ label: s.label, box: s.box, tabindex: s.facts.tabindex || undefined, fixed: s.facts.fixed, doc: s.doc })), ltr);
    if (jumps.count) problems.push({ id: 'focus-order', count: jumps.count, items: jumps.shown.map(j => j.text) });
    const stops: KbStopLine[] = order.map(s => ({ label: s.label, box: s.box, tabindex: s.facts.tabindex > 0 ? s.facts.tabindex : undefined, frame: s.frame, scripted: s.scripted }));
    return formatKeyboard({
      tabId: this.call.tab.id,
      scope: this.root ? `only ${this.root.label}` : 'whole page',
      documents: new Set(order.map(s => s.doc)).size,
      stops,
      end,
      ms: this.elapsed,
      problems,
      notRestored,
      notes: this.notes,
      pageChanges,
    });
  }
}

/** browser_audit type "keyboard" on the whole page or, with `root`, on one region of it. */
export async function keyboardAudit(call: PageCall, root: ElementTarget | undefined): Promise<string> {
  return new Walk(call, root).run();
}
