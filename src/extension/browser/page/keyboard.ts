// browser_audit type "keyboard": presses Tab through the page with trusted key input and follows
// focus into shadow roots (closed ones too, through CDP) and same- and cross-origin frames. Reports the
// focus order, focus that does not show, keyboard traps, interactive-looking elements Tab never
// reaches, a missing or broken skip link and jumps against the reading order (decisions in
// keyboardLogic.ts, text in keyboardReport.ts).
//
// Every document (the page, each frame target, each frame in the same process) is handled in the
// bridge's isolated world of that document: the Tab starting point is reset in each, its view saved
// and restored, Tab keydowns observed (to tell a captured Tab), and unreached controls looked for.
// The page is left as it was: focus, scroll positions and selections are put back at the end, also
// on errors and cancellation, and the walk's own marks are removed. Nothing is left waiting in the
// page between steps: a command still pending when a focus handler navigates would end the tab's
// CDP connection (cdp.ts), so every wait happens here, not in the page.
import { ToolError } from '../../core/errors';
import { ObjectArg, dialogMessage, exceptionText, pageUsesTouch, type PageCall } from './call';
import { frameLabel, ownerOf } from './frameTargets';
import { pressChord } from './input';
import { keyDefinition, type Modifier } from './keys';
import { MIN_CHANGED_PIXELS, OPAQUE_LIMIT, WalkTracker, changedPixels, decideEnd, endNeeds, focusShows, judgeSkipLink, orderJumps, splitInside, type Box, type Outcome, type RawStyle, type StepVerdict } from './keyboardLogic';
import { formatKeyboard, type KbEnd, type KbInput, type KbProblem, type KbStopLine } from './keyboardReport';
import { DialogInterrupt } from './pageState';
import { decodePng } from './png';
import { clip } from './ringBuffer';
import { DESCRIBE, TOGGLE_BRIDGE_UI } from './scripts';
import { elementBox, viewport, type ElementTarget, type Viewport } from './targets';

export const MAX_STOPS = 250;
export const TIME_LIMIT_MS = 30_000;
const MAX_PIXEL_CHECKS = 40;
/** Longest time spent on pixel checks after the walk. */
const PIXEL_BUDGET_MS = 12_000;
const MAX_CANDIDATES = 200;
const MAX_CANDIDATE_ELEMENTS = 5000;
const MAX_DOCUMENTS = 20;
/** The bridge's own page indicator is a Tab stop too; it is stepped over, at most this many times in a row. */
const MAX_BRIDGE_SKIPS = 6;
/** Wait after a key press or focus change for the page's handlers (a script moving focus on in a timeout). */
const SETTLE_MS = 15;

// ---------------------------------------------------------------- page-side scripts

/** Shared snippet: the parent across shadow roots and same-origin frames. */
const UP = `const up = (n) => n.parentNode && n.parentNode.nodeType === 11 ? n.parentNode.host : n.parentNode && n.parentNode.nodeType === 9 ? (n.parentNode.defaultView && n.parentNode.defaultView.frameElement) || null : n.parentNode;`;

/** Shared snippet: the styles that can show focus, of an element or pseudo-element (null when not rendered). */
const STYLE = `const style = (n, pseudo) => {
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
  // The element, its ::before and ::after, and its ancestors up to the body (at most 12, across shadow
  // hosts): a ring drawn by any of them through :focus-within shows focus too.
  const own = (el) => {
    const out = [style(el), style(el, '::before'), style(el, '::after')];
    for (let n = parent(el), i = 0; n && i < 12 && n !== n.ownerDocument.body && n !== n.ownerDocument.documentElement; n = parent(n), i++) out.push(style(n), style(n, '::before'), style(n, '::after'));
    return out;
  };
  const related = (el) => {
    const out = [];
    if (el.labels) out.push(...el.labels);
    if (el.previousElementSibling) out.push(el.previousElementSibling);
    let s = el.nextElementSibling;
    for (let i = 0; s && i < 2; i++, s = s.nextElementSibling) out.push(s);
    if (el.parentElement) out.push(el.parentElement);
    return [...new Set(out)].slice(0, 6);
  };
  const relatedStyles = (el) => related(el).flatMap(r => [style(r), style(r, '::before'), style(r, '::after')]);`;

/**
 * Isolated world of one document (no frames: each has its own). Records the scroll offsets of the
 * window and of every scrolled element (open shadow roots too, bounded), the selection, and the text
 * selection of every text field; listens for scrolling (to put back what the walk scrolled) and for
 * Tab keydowns (to tell when the page takes the key).
 */
const SAVE_VIEW = `function (maxElements) {
  const view = { win: [scrollX, scrollY], els: [], ranges: [], fields: [], scrolled: new Set(), targets: [], lastKey: null };
  view.onScroll = (e) => { if (e.target && e.target.nodeType === 1) view.scrolled.add(e.target); };
  view.onKey = (e) => { if (e.key === 'Tab') view.lastKey = e; };
  window.addEventListener('keydown', view.onKey, true);
  const listen = (t) => { t.addEventListener('scroll', view.onScroll, true); view.targets.push(t); };
  listen(window);
  let count = 0;
  const visit = (root) => {
    for (const el of root.querySelectorAll('*')) {
      if (++count > maxElements) return;
      if (el.scrollTop || el.scrollLeft) view.els.push([el, el.scrollTop, el.scrollLeft]);
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        try { if (typeof el.selectionStart === 'number') view.fields.push([el, el.selectionStart, el.selectionEnd, el.selectionDirection]); } catch {}
      }
      if (el.shadowRoot) { listen(el.shadowRoot); visit(el.shadowRoot); }
    }
  };
  visit(document);
  const sel = document.getSelection();
  if (sel) for (let i = 0; i < sel.rangeCount; i++) view.ranges.push(sel.getRangeAt(i).cloneRange());
  window.__copaneKbView = view;
  window.__copaneKbMarked = [];
  return count;
}`;

/**
 * Isolated world of one document. Puts back what SAVE_VIEW recorded, stops listening, and removes
 * everything the walk left in this world (reached marks, candidate lists).
 */
const RESTORE_VIEW = `function () {
  for (const el of window.__copaneKbMarked || []) { try { delete el.__copaneKb; } catch {} }
  delete window.__copaneKbMarked;
  delete window.__copaneKbCandidates;
  delete window.__copaneKbMissed;
  const view = window.__copaneKbView;
  if (!view) return false;
  delete window.__copaneKbView;
  window.removeEventListener('keydown', view.onKey, true);
  for (const t of view.targets) t.removeEventListener('scroll', view.onScroll, true);
  const saved = new Set(view.els.map(e => e[0]));
  for (const el of view.scrolled) if (!saved.has(el) && el.isConnected) { el.scrollTop = 0; el.scrollLeft = 0; }
  for (const [el, top, left] of view.els) if (el.isConnected) { el.scrollTop = top; el.scrollLeft = left; }
  if (scrollX !== view.win[0] || scrollY !== view.win[1]) scrollTo({ left: view.win[0], top: view.win[1], behavior: 'instant' });
  for (const [el, start, end, dir] of view.fields) {
    try { if (el.isConnected && (el.selectionStart !== start || el.selectionEnd !== end)) el.setSelectionRange(start, end, dir || 'none'); } catch {}
  }
  const sel = document.getSelection();
  if (sel) {
    const ranges = view.ranges;
    const same = sel.rangeCount === ranges.length && ranges.every((r, i) => {
      const now = sel.getRangeAt(i);
      return now.startContainer === r.startContainer && now.startOffset === r.startOffset && now.endContainer === r.endContainer && now.endOffset === r.endOffset;
    });
    if (!same) {
      sel.removeAllRanges();
      for (const r of ranges) { try { sel.addRange(r); } catch {} }
    }
  }
  return true;
}`;

/** Element (this), isolated world of its document: whether the last Tab keydown there was taken by the page. Forgets it. */
const READ_KEY = `function () {
  const view = window.__copaneKbView;
  const e = view && view.lastKey;
  if (view) view.lastKey = null;
  return !!(e && e.defaultPrevented);
}`;

/**
 * Isolated world, \`this\` = the region element or the window. Moves the sequential focus navigation
 * starting point to the start of the region (or of the document): focuses a temporary element there
 * and removes it, so the next Tab goes to the first stop after that point. Whether that worked.
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

/** Element (this). Like START_AT, but right before this element: the next Tab should land on it. */
const START_BEFORE = `function () {
  const t = this.ownerDocument.createElement('span');
  t.tabIndex = -1;
  t.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap';
  this.parentNode.insertBefore(t, this);
  t.focus({ preventScroll: true });
  const ok = t.getRootNode().activeElement === t;
  t.remove();
  return ok;
}`;

/**
 * Isolated world of a document (\`this\` = the window), or \`this\` = a shadow root: the focused element,
 * through open shadow roots. Stops at frames (each document is asked itself) and at closed shadow roots
 * (CDP reads those). Null when nothing (or only the document) has focus.
 */
const DEEP_LOCAL = `function () {
  const root = this && this.nodeType === 11 ? this : null;
  let el = root ? root.activeElement : document.activeElement;
  while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
  if (!el || (!root && (el === document.body || el === document.documentElement))) return null;
  return el;
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
    if (el.tabIndex < 0 || el.matches(':disabled')) return false;
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
 * Element (this), isolated world of its document. Marks it as reached (an expando of this world with
 * the walk's token, invisible to the page, removed by RESTORE_VIEW) and returns what the checks need:
 * tabindex, fixed/sticky, main and modal ancestors, visibility while focused, the styles that can show
 * focus (for a visually hidden form control also those of its labels, siblings and parent), and
 * same-page link facts.
 */
const FOCUS_FACTS = `function (token) {
  ${UP}
  ${STYLE}
  const el = this;
  if (el.__copaneKb !== token) { el.__copaneKb = token; (window.__copaneKbMarked || (window.__copaneKbMarked = [])).push(el); }
  const doc = el.ownerDocument;
  const win = doc.defaultView;
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
  // What is left of its box once every ancestor that clips (overflow other than visible, clip-path,
  // clip) has cut it, and the viewport. Ancestors an absolutely positioned box escapes (not positioned)
  // do not clip it; nothing above a fixed box does.
  const r = el.getBoundingClientRect();
  let left = Math.max(r.left, 0), top = Math.max(r.top, 0), right = Math.min(r.right, win.innerWidth), bottom = Math.min(r.bottom, win.innerHeight);
  let escaping = getComputedStyle(el).position === 'absolute';
  for (let n = el.parentElement || (el.getRootNode && el.getRootNode().host) || null; n && n.nodeType === 1; n = n.parentElement || (n.getRootNode && n.getRootNode().host) || null) {
    const s = getComputedStyle(n);
    const positioned = s.position !== 'static' || s.transform !== 'none';
    const clips = s.overflowX !== 'visible' || s.overflowY !== 'visible' || s.clipPath !== 'none' || (s.clip && s.clip !== 'auto' && s.position === 'absolute');
    if (clips && (!escaping || positioned)) {
      // Overflow clips at the padding box (inside the borders); clip-path and clip at the border box.
      const c = n.getBoundingClientRect();
      const overflow = s.overflowX !== 'visible' || s.overflowY !== 'visible';
      const cl = overflow ? c.left + n.clientLeft : c.left;
      const ct = overflow ? c.top + n.clientTop : c.top;
      const cr = overflow ? cl + n.clientWidth : c.right;
      const cb = overflow ? ct + n.clientHeight : c.bottom;
      left = Math.max(left, cl); top = Math.max(top, ct); right = Math.min(right, cr); bottom = Math.min(bottom, cb);
    }
    if (positioned) escaping = s.position === 'absolute';
    if (s.position === 'fixed') break;
  }
  // At most about a pixel left showing counts as hidden.
  const clipped = right - left < 2 || bottom - top < 2;
  const hidden = r.width <= 1 || r.height <= 1 || transparent || clipped
    || (el.checkVisibility ? !el.checkVisibility({ visibilityProperty: true }) : false);
  const tag = el.tagName;
  const formControl = ['INPUT', 'SELECT', 'TEXTAREA'].includes(tag) || ['checkbox', 'radio', 'switch'].includes(el.getAttribute('role') || '');
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
  return {
    bridgeUi, fixed, inMain, inModal, hidden, formControl, tabindex, skip, editable,
    signature: own(el), related: hidden && formControl ? relatedStyles(el) : null,
    docUrl: doc.URL, rtl: getComputedStyle(document.documentElement).direction === 'rtl',
  };
}`;

/** Element (this). The styles that can show focus, read now (as FOCUS_FACTS read them). */
const STYLE_NOW = `function (withRelated) {
  ${STYLE}
  return { own: own(this), related: withRelated ? relatedStyles(this) : null };
}`;

/** Element (this, a visually hidden form control). What would show its focus: its first rendered label, else its parent. */
const INDICATOR = `function () {
  const shown = (n) => n && n.getClientRects().length > 0 && n.getBoundingClientRect().width > 1;
  for (const l of this.labels || []) if (shown(l)) return l;
  return this.parentElement;
}`;

/** Element (this). `(level)` → its ancestor that many levels up (across shadow hosts), or null at the body. */
const ANCESTOR = `function (level) {
  let n = this;
  for (let i = 0; i < level && n; i++) n = n.parentElement || (n.getRootNode && n.getRootNode().host) || null;
  return n && n !== n.ownerDocument.body && n !== n.ownerDocument.documentElement ? n : null;
}`;

/** Element (this), any world. `(other)` → whether other is this or inside it (shadow roots, same-origin frames). */
const CONTAINS_DEEP = `function (other) {
  ${UP}
  for (let n = other; n; n = up(n)) if (n === this) return true;
  return false;
}`;

/** Any world. `(...elements)` → their lowest common ancestor (across shadow roots), or null. */
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
  if (!common || common.nodeType !== 1 || common === common.ownerDocument.body || common === common.ownerDocument.documentElement) return null;
  return common;
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

/** Shared snippet: elements hidden from everyone (inert, aria-hidden, in the bridge's UI), across shadow roots and same-origin frames. */
const SHUT = `const shut = (el) => {
    for (let n = el; n; n = up(n)) {
      if (n.nodeType !== 1) continue;
      if (n.inert || n.hasAttribute('inert') || n.getAttribute('aria-hidden') === 'true' || n.hasAttribute('data-copane-ui')) return true;
    }
    return false;
  };`;

/**
 * Isolated world of one document, \`this\` = the region element or the window. Elements that look
 * interactive but were not reached: an interactive role, an onclick attribute, or cursor: pointer (not
 * inherited). Visible, enabled, not inert or aria-hidden, not inside or around a reached element, not
 * part of a widget that moves focus with the arrow keys (tabs, menus, radio groups) where one member
 * was reached; with \`modalOnly\`, only inside an open modal dialog. Kept in a global of this world
 * (read back by index); returns the total and the first ones with why.
 */
const UNREACHED = `function (token, maxElements, maxCandidates, modalOnly) {
  ${UP}
  ${SHUT}
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
  const inModal = (el) => {
    for (let n = el; n; n = up(n)) {
      if (n.nodeType !== 1) continue;
      if ((n.tagName === 'DIALOG' && n.matches(':modal')) || (n.getAttribute('aria-modal') === 'true' && (!n.checkVisibility || n.checkVisibility()))) return true;
    }
    return false;
  };
  const scope = this && this.nodeType === 1 ? this : document.documentElement;
  const all = [scope];
  const visit = (root) => {
    for (const el of root.querySelectorAll('*')) {
      if (all.length >= maxElements) return;
      all.push(el);
      if (el.shadowRoot) visit(el.shadowRoot);
    }
  };
  if (scope.shadowRoot) visit(scope.shadowRoot);
  visit(scope);
  const reachedEls = all.filter(reached);
  const within = (n, ancestor) => { for (let x = n; x; x = up(x)) if (x === ancestor) return true; return false; };
  const modal = document.querySelector(':modal');
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
    let pointer = false;
    if (!interactive && !onclick) {
      if (getComputedStyle(el).cursor !== 'pointer') continue;
      const p = up(el);
      if (p && p.nodeType === 1 && p.ownerDocument === document && getComputedStyle(p).cursor === 'pointer') continue;
      pointer = true;
    }
    if (el.matches(':disabled') || el.closest('[aria-disabled="true"]') || shut(el)) continue;
    if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    if (modal && !modal.contains(el)) continue;
    if (modalOnly && !inModal(el)) continue;
    let near = false;
    for (let n = up(el); n && !near; n = up(n)) if (n.nodeType === 1 && reached(n)) near = true;
    if (near || reachedEls.some(x => within(x, el))) continue;
    const group = el.closest(COMPOSITE);
    if (group && (reached(group) || reachedEls.some(x => within(x, group)))) continue;
    if (tag === 'INPUT' && el.type === 'radio' && el.name) {
      const peers = (el.form || document).querySelectorAll('input[type=radio]');
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

/**
 * Isolated world of one document: up to \`max\` focusable elements (tabindex >= 0, visible, enabled)
 * the walk did not reach, kept in a global (read back by index). Used to tell a real wrap from a trap
 * that holds stop 1.
 */
const UNREACHED_TABBABLE = `function (token, max) {
  ${UP}
  ${SHUT}
  const out = [];
  const visit = (root) => {
    for (const el of root.querySelectorAll('*')) {
      if (out.length >= max) return;
      if (el.shadowRoot) visit(el.shadowRoot);
      if (el.__copaneKb === token || el.tabIndex < 0 || el.matches(':disabled') || el.tagName === 'IFRAME' || el.tagName === 'FRAME') continue;
      if ((el.tagName === 'A' || el.tagName === 'AREA') && !el.hasAttribute('href') && !el.hasAttribute('tabindex')) continue;
      if (shut(el) || (el.checkVisibility && !el.checkVisibility({ visibilityProperty: true }))) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      out.push(el);
    }
  };
  visit(document);
  window.__copaneKbMissed = out;
  return out.length;
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
  formControl: boolean;
  tabindex: number;
  skip: { target: string; exists: boolean; rendered: boolean; main: boolean } | null;
  signature: Array<RawStyle | null>;
  related: Array<RawStyle | null> | null;
  editable: boolean;
  docUrl: string;
  rtl: boolean;
}

/** One document of the page: a target (the page or a frame target) and a frame in it (undefined = its main frame). */
interface Doc {
  at: PageCall;
  frameId: string | undefined;
  /** Its isolated world, kept for restoring after cancellation. */
  contextId: number;
}

/** The focused element as found by `deepFocus`. */
interface Found {
  key: string;
  at: PageCall;
  /** Frame in `at`'s target holding it (undefined = the target's main frame). */
  frameId: string | undefined;
  /** Handle in the bridge's isolated world of its document. */
  objectId: string;
  backendNodeId: number;
  /** What the walk cannot see into when focus is somewhere inside this element. */
  opaque?: string;
}

interface Stop extends Found {
  label: string;
  name: string;
  box?: Box;
  frame?: string;
  doc: string;
  facts: Facts;
  scripted?: boolean;
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

/**
 * Whether two screenshots (base64 PNG) show the same thing: fewer than MIN_CHANGED_PIXELS pixels
 * changed noticeably (text anti-aliasing varies by a few levels between paints).
 */
function samePicture(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    const changed = changedPixels(decodePng(Buffer.from(a, 'base64')), decodePng(Buffer.from(b, 'base64')));
    if (changed !== undefined) return changed < MIN_CHANGED_PIXELS;
  } catch {
    // Not a PNG this can read: compare the bytes.
  }
  return false;
}

const keyOf = (at: PageCall, backendNodeId: number) => `${at.frame?.id ?? 'top'}#${backendNodeId}`;

class Walk {
  private readonly token = `kb${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  private readonly started = Date.now();
  private readonly loaderId: string | undefined;
  private readonly tracker = new WalkTracker();
  private readonly stops = new Map<string, Stop>();
  private readonly notVisible = new Map<string, string>();
  private readonly visibilityChecked = new Set<string>();
  /** Stops whose focus showed no style change: checked by pixels after the walk. */
  private readonly pixelQueue: Array<{ stop: Stop; related: boolean }> = [];
  private region: { at: PageCall; frameId: string | undefined; objectId: string; mainObjectId: string } | undefined;
  private docs: Doc[] = [];
  private focusedBefore: { at: PageCall; objectId: string } | undefined;
  private watching = false;
  /** The element focused now (bridge UI included): its document saw the next Tab keydown. */
  private current: Found | undefined;
  private last: Stop | undefined;
  private slowPaint = false;
  private pageChanges: number | undefined;
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

  private get count(): number {
    return this.tracker.stops.length;
  }

  // ---------------------------------------------------------------- documents, save and restore

  private async contextOf(at: PageCall, frameId: string | undefined): Promise<number> {
    return at.frame ? this.call.state.frames.isolatedWorld(at.frame, frameId) : this.call.state.isolatedWorld(frameId);
  }

  /** Frames of a target that live in its process (same-origin or same-site), not counting its main frame. */
  private async localFrames(at: PageCall): Promise<string[]> {
    if (at.frame) return [...at.frame.localFrames].filter(id => id !== at.frame!.id);
    try {
      const { frameTree } = await at.send('Page.getFrameTree');
      const out: string[] = [];
      const walk = (node: any) => {
        for (const child of node.childFrames ?? []) {
          if (!this.call.state.frames.targetOf(child.frame.id)) out.push(child.frame.id);
          walk(child);
        }
      };
      walk(frameTree);
      return out;
    } catch (err) {
      rethrowHard(err);
      return [];
    }
  }

  /** Every document of the page (the page, its frames in the same process, frame targets and theirs), bounded. */
  private async documents(): Promise<Array<{ at: PageCall; frameId: string | undefined }>> {
    const { call } = this;
    const out: Array<{ at: PageCall; frameId: string | undefined }> = [];
    for (const at of [call, ...call.state.frames.list().filter(f => !f.session.closed).map(f => call.at(f))]) {
      out.push({ at, frameId: undefined });
      for (const frameId of await this.localFrames(at)) out.push({ at, frameId });
      if (out.length >= MAX_DOCUMENTS) break;
    }
    return out.slice(0, MAX_DOCUMENTS);
  }

  async save(): Promise<void> {
    this.focusedBefore = await this.deepFocus();
    for (const { at, frameId } of await this.documents()) {
      let contextId: number;
      try {
        contextId = await this.contextOf(at, frameId);
      } catch (err) {
        rethrowHard(err);
        if (at === this.call && !frameId) throw err;
        continue;
      }
      // Registered before saving, so that a cancellation during the save still removes the listeners.
      const doc = { at, frameId, contextId };
      this.docs.push(doc);
      try {
        await at.evaluate(SAVE_VIEW, [20_000], { frameId, timeoutMs: at === this.call && !frameId ? 10_000 : 3000 });
      } catch (err) {
        rethrowHard(err);
        if (at === this.call && !frameId) throw err;
      }
    }
  }

  /**
   * Moves the Tab starting point to the start of every document: frames first (a frame keeps its own
   * point, e.g. where it was last clicked, and Tab entering it would continue from there), then the page.
   */
  private async resetStarts(raws: boolean): Promise<void> {
    for (const doc of [...this.docs.slice(1), ...this.docs.slice(0, 1)]) {
      try {
        if (raws) await raw(doc.at, 'Runtime.callFunctionOn', { functionDeclaration: START_AT, executionContextId: doc.contextId, returnByValue: true });
        else await doc.at.evaluate(START_AT, [], { frameId: doc.frameId, timeoutMs: 3000 });
      } catch (err) {
        if (!raws) rethrowHard(err);
      }
    }
  }

  /** Puts focus, scroll and selections back and removes the walk's marks. Returns why that failed, or undefined. */
  async restore(): Promise<string | undefined> {
    const { call } = this;
    if (call.state.loaderId !== this.loaderId) return 'the page navigated';
    if (call.state.dialog) return 'a dialog is open in the page';
    if (call.page.closed) return 'the tab was closed';
    let failure: string | undefined;
    try {
      if (this.focusedBefore) {
        await raw(this.focusedBefore.at, 'Runtime.callFunctionOn', { functionDeclaration: 'function () { this.focus({ preventScroll: true }); }', objectId: this.focusedBefore.objectId, returnByValue: true });
      } else {
        // Nothing was focused: leave nothing focused, with Tab starting from the top again.
        await this.resetStarts(true);
      }
    } catch (err) {
      failure = `focus: ${message(err)}`;
    }
    for (const doc of this.docs) {
      try {
        await raw(doc.at, 'Runtime.callFunctionOn', { functionDeclaration: RESTORE_VIEW, executionContextId: doc.contextId, returnByValue: true });
      } catch (err) {
        if (doc === this.docs[0]) failure ??= `scroll: ${message(err)}`;
      }
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
    const top = this.docs[0];
    if (!this.watching || !top || this.call.state.loaderId !== this.loaderId || this.call.state.dialog) return 0;
    try {
      return Number((await raw(top.at, 'Runtime.callFunctionOn', { functionDeclaration: WATCH_READ, executionContextId: top.contextId, returnByValue: true })).result?.value ?? 0);
    } catch {
      return 0;
    }
  }

  // ---------------------------------------------------------------- region

  /** The region as a handle in the isolated world of its document, and in the page's own world. */
  async resolveRegion(): Promise<void> {
    const root = this.root;
    if (!root) return;
    const at = root.call;
    const entry = root.ref ? this.call.refs.get(root.ref) : undefined;
    const frameIds: Array<string | undefined> = [undefined];
    if (entry?.frameId && entry.frameId !== (at.frame?.id ?? this.call.state.mainFrameId)) frameIds.push(entry.frameId);
    frameIds.push(...(await this.localFrames(at)));
    for (const frameId of frameIds) {
      try {
        const contextId = await this.contextOf(at, frameId);
        const { object } = await at.send('DOM.resolveNode', { backendNodeId: root.backendNodeId, executionContextId: contextId, objectGroup: this.call.group });
        if (object?.objectId) {
          this.region = { at, frameId, objectId: object.objectId, mainObjectId: root.objectId };
          return;
        }
      } catch (err) {
        rethrowHard(err);
      }
    }
    throw new ToolError('failed', `Could not walk ${root.label}: its document could not be reached. Take a snapshot and pass the ref of a container instead.`);
  }

  /**
   * Whether an element (by target and backend node id) is inside the region (always true without one).
   * Decided in the page's own world, where every frame of a target can be compared.
   */
  private async inRegion(at: PageCall, backendNodeId: number): Promise<boolean> {
    const region = this.region;
    if (!region) return true;
    try {
      let node = backendNodeId;
      if (at !== region.at) {
        // In a cross-origin frame: inside when that frame's <iframe> (at the region's level) is.
        const frames = this.call.state.frames;
        if (!at.frame) return false;
        const level = frames.chain(at.frame).find(f => frames.parentOf(f) === region.at.frame);
        if (!level) return false;
        node = await ownerOf(this.call, level);
      }
      const objectId = await region.at.resolve(node);
      return await region.at.callOn<boolean>(region.mainObjectId, CONTAINS_DEEP, [new ObjectArg(objectId)]);
    } catch (err) {
      rethrowHard(err);
      return false;
    }
  }

  // ---------------------------------------------------------------- one step

  private async press(modifiers: Modifier[] = []): Promise<void> {
    await pressChord(this.call, { modifiers, key: keyDefinition('Tab')! });
    // Waited here, not in the page: see the head comment.
    await this.call.sleep(SETTLE_MS);
    this.checkNavigation();
  }

  private navigationError(): ToolError {
    const { call } = this;
    const what = call.state.crashed ? 'crashed' : 'navigated';
    const after = this.last ? ` after stop ${this.count} (${this.last.label}): the element Tab reached next probably loads another page when it gets focus` : '';
    return new ToolError('failed', `The page in ${call.tab.id} ${what} while Tab was pressed${after}. The walk stopped there; focus and scroll could not be restored. Take a snapshot.`);
  }

  private checkNavigation(): void {
    if (this.call.state.loaderId !== this.loaderId || this.call.state.crashed) throw this.navigationError();
  }

  /**
   * The focused element, followed through open and closed shadow roots and into frames (frame targets
   * and frames in the same process alike). Undefined when nothing in the page has focus.
   */
  private async deepFocus(): Promise<Found | undefined> {
    let at = this.call;
    let frameId: string | undefined;
    let handle = await at.evaluateHandle(DEEP_LOCAL, [], { frameId });
    let owner: Found | undefined;
    for (let depth = 0; depth < 12; depth++) {
      if (!handle?.objectId || handle.subtype === 'null') return owner;
      const { node } = await at.send('DOM.describeNode', { objectId: handle.objectId, depth: 1, pierce: true });
      const here: Found = { key: keyOf(at, node.backendNodeId), at, frameId, objectId: handle.objectId, backendNodeId: node.backendNodeId };
      if (node.nodeName === 'IFRAME' || node.nodeName === 'FRAME') {
        // Focus is in the frame's document: ask that document (its target, or its world in this target).
        const child: string | undefined = node.frameId;
        const target = child ? this.call.state.frames.get(child) : undefined;
        try {
          if (target && !target.session.closed) {
            at = this.call.at(target);
            frameId = undefined;
          } else if (child && !target) frameId = child;
          else return { ...here, opaque: 'a frame the walk cannot enter' };
          handle = await at.evaluateHandle(DEEP_LOCAL, [], { frameId, timeoutMs: 3000 });
        } catch (err) {
          rethrowHard(err);
          return { ...here, opaque: 'a frame the walk cannot enter' };
        }
        owner = here; // The frame itself, if nothing inside it has focus.
        continue;
      }
      const closed = (node.shadowRoots ?? []).find((r: { shadowRootType?: string }) => r.shadowRootType === 'closed');
      if (closed) {
        // Page scripts cannot look into a closed shadow root, but the bridge can through CDP.
        try {
          const { object } = await at.send('DOM.resolveNode', { backendNodeId: closed.backendNodeId, executionContextId: await this.contextOf(at, frameId), objectGroup: this.call.group });
          const inner = object?.objectId ? await at.callOn(object.objectId, DEEP_LOCAL, [], { returnByValue: false }) : undefined;
          if (!inner?.objectId || inner.subtype === 'null') return here;
          handle = inner;
          owner = here;
          continue;
        } catch (err) {
          rethrowHard(err);
          return { ...here, opaque: 'a closed shadow root' };
        }
      }
      return here;
    }
    return owner;
  }

  /** Whether the page took the last Tab keydown in the document of `found` (preventDefault). */
  private async captured(found: Found | undefined): Promise<boolean> {
    if (!found) return false;
    try {
      return await found.at.callOn<boolean>(found.objectId, READ_KEY);
    } catch (err) {
      rethrowHard(err);
      return false;
    }
  }

  /** Describes a focused element (role, name, ref, position) and reads its facts. */
  private async describe(found: Found, vp: Viewport): Promise<Stop> {
    const known = this.stops.get(found.key);
    const facts = await found.at.callOn<Facts>(found.objectId, FOCUS_FACTS, [this.token]);
    if (known) return { ...known, objectId: found.objectId, facts };
    if (facts.bridgeUi) return { ...found, label: 'the bridge indicator', name: '', doc: '', facts };
    const { label, name } = await this.labelOf(found.at, found.frameId, found.backendNodeId, found.objectId);
    const view = await elementBox(found.at, found.backendNodeId);
    const box = view && { x: view.x + vp.pageX, y: view.y + vp.pageY, width: view.width, height: view.height };
    const frame = found.frameId ? frameName(facts.docUrl) : found.at.frame ? frameLabel(found.at.frame) : undefined;
    const doc = `${found.at.frame?.id ?? 'top'}|${found.frameId ?? ''}`;
    return { ...found, label, name, box, frame, doc, facts };
  }

  /** 'button "Search" [ref=e40]', or the element's HTML with a ref when it has no role. Assigns refs as browser_snapshot does. */
  async labelOf(at: PageCall, frameId: string | undefined, backendNodeId: number, objectId: string): Promise<{ label: string; name: string }> {
    const { call } = this;
    const ax = await at.describeAx(backendNodeId);
    const role = ax && !ax.ignored ? ax.role : 'generic';
    const name = ax && !ax.ignored ? ax.name : '';
    const ref = call.refs.assign(
      { backendNodeId, frameId: frameId ?? at.frame?.id ?? call.state.mainFrameId ?? '', role, name, ...(at.frame ? { frame: at.frame.id, frameLoaderId: at.frame.loaderId } : {}) },
      call.state.loaderId,
    );
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

  /** Focus visibility of a stop that has just lost focus (WCAG 2.4.7): by style now, by pixels after the walk. */
  private async checkVisibility(stop: Stop): Promise<void> {
    if (this.visibilityChecked.has(stop.key)) return;
    this.visibilityChecked.add(stop.key);
    const related = stop.facts.hidden && stop.facts.formControl;
    if (stop.facts.hidden && !related) {
      this.notVisible.set(stop.key, `${stop.label} (hidden or off-screen when focused)`);
      return;
    }
    let now: { own: Array<RawStyle | null>; related: Array<RawStyle | null> | null };
    try {
      now = await stop.at.callOn(stop.objectId, STYLE_NOW, [related]);
    } catch (err) {
      rethrowHard(err);
      return; // Gone from the page.
    }
    if (related) {
      // A visually hidden input (a custom checkbox or switch): its label or a sibling shows focus, if anything does.
      if (!focusShows(stop.facts.related ?? [], now.related ?? [])) this.pixelQueue.push({ stop, related: true });
      return;
    }
    if (focusShows(stop.facts.signature, now.own) || stop.facts.editable) return; // A text field shows the caret.
    this.pixelQueue.push({ stop, related: false });
  }

  /**
   * Presses Tab (or Shift+Tab) and finds the element focus lands on, stepping over the bridge's own
   * indicator. `stop` is undefined when nothing in the page has focus (or only the indicator does).
   */
  private async step(modifiers: Modifier[] = []): Promise<{ stop: Stop | undefined; captured: boolean }> {
    for (let skips = 0; ; skips++) {
      const before = this.current;
      await this.press(modifiers);
      const vp = await viewport(this.call);
      const found = await this.deepFocus();
      const captured = found && before && found.key === before.key ? await this.captured(before) : false;
      this.current = found;
      if (!found) return { stop: undefined, captured: false };
      const stop = await this.describe(found, vp);
      if (!stop.facts.bridgeUi) return { stop, captured };
      if (skips >= MAX_BRIDGE_SKIPS) return { stop: undefined, captured: false };
    }
  }

  /** Records a stop as the current one, and checks the previous one's focus visibility. */
  private async arrive(stop: Stop | undefined): Promise<void> {
    if (this.last && this.last.key !== stop?.key) await this.checkVisibility(this.last);
    if (stop && !this.stops.has(stop.key)) this.stops.set(stop.key, stop);
    if (stop) this.last = this.stops.get(stop.key);
  }

  // ---------------------------------------------------------------- run

  async run(): Promise<string> {
    let result: Omit<KbInput, 'notRestored' | 'pageChanges'> | undefined;
    let failure: unknown;
    try {
      result = await this.walk();
    } catch (err) {
      failure = err;
    }
    // A dialog opened by a focus handler: some are answered at once (by the browser or the user); then the page can still be put back.
    if (this.call.state.dialog && !this.call.page.closed) {
      await this.call.state.waitFor(() => !this.call.state.dialog, { timeoutMs: 1000, ignoreDialogs: true }).catch(() => undefined);
    }
    const pageChanges = this.pageChanges ?? (await this.readWatch());
    const notRestored = await this.restore();
    if (failure !== undefined) throw this.explain(failure, notRestored);
    // A navigation can commit after the step that caused it was judged (seen on a slow machine): what the
    // walk read after that belongs to another page, so it is not a result.
    this.checkNavigation();
    return formatKeyboard({ ...result!, notRestored, pageChanges });
  }

  /** The error to report for a failed walk: what stopped it, at which stop, and whether the page was put back. */
  private explain(err: unknown, notRestored: string | undefined): unknown {
    const { call } = this;
    if (call.state.loaderId !== this.loaderId || call.state.crashed) return this.navigationError();
    const dialog = err instanceof DialogInterrupt ? err.dialog : call.state.dialog;
    if (dialog && !(err instanceof ToolError && err.code === 'cancelled')) {
      const after = this.last ? ` after stop ${this.count} (${this.last.label})` : '';
      const restored = notRestored ? 'focus and scroll were not restored' : 'focus and scroll were put back';
      return new ToolError('failed', `${dialogMessage(call.tab.id, dialog)} The keyboard walk stopped${after}: a focus or blur handler opened the dialog; ${restored}.`);
    }
    return err;
  }

  private async walk(): Promise<Omit<KbInput, 'notRestored' | 'pageChanges'>> {
    await this.resolveRegion();
    await this.save();
    await this.start();
    await this.startWatch();
    let verdict: StepVerdict | { kind: 'outside'; label?: string } = { kind: 'continue' };
    let observed: { stop: Stop | undefined; captured: boolean } = { stop: this.last, captured: false };
    for (;;) {
      const { stop } = observed;
      if (stop && !(await this.inRegion(stop.at, stop.backendNodeId))) {
        verdict = { kind: 'outside', label: stop.label };
        break;
      }
      verdict = this.tracker.push({ key: stop?.key, captured: observed.captured, opaque: Boolean(stop?.opaque) });
      if (verdict.kind !== 'continue') break;
      if (this.count >= MAX_STOPS || this.elapsed >= TIME_LIMIT_MS) break;
      observed = await this.step();
      await this.arrive(observed.stop);
    }
    // Read now: what follows (probes, pixel checks) changes the page itself.
    this.pageChanges = await this.readWatch();
    const keys = this.tracker.stops;
    const base = (key: string) => this.stops.get(splitInside(key).key)!;
    const inModal = keys.map(k => base(k).facts.inModal);
    const needs = endNeeds(verdict, inModal, Boolean(this.root));
    const outcome = decideEnd({
      verdict,
      inModal,
      region: Boolean(this.root),
      limitReached: this.count >= MAX_STOPS,
      regionHoldsPageStart: needs === 'region-start' ? await this.regionHoldsPageStart() : undefined,
      missedTabStop: needs === 'missed-stop' ? await this.missedTabStop() : undefined,
    });
    const { end, problem } = await this.ending(outcome, keys, verdict.kind === 'outside' ? verdict.label : undefined);
    await this.pixelChecks();
    return this.report(keys, end, problem);
  }

  /** Moves the Tab starting point to the start (of every document, then the region's) and takes the first step. */
  private async start(): Promise<void> {
    const { call } = this;
    const scope = this.region ?? { at: call, frameId: undefined, objectId: undefined };
    let first: { objectId: string; positive: boolean } | undefined;
    try {
      const handle = scope.objectId ? await scope.at.callOn(scope.objectId, FIRST_TABBABLE, [], { returnByValue: false }) : await scope.at.evaluateHandle(FIRST_TABBABLE);
      if (handle?.objectId && handle.subtype !== 'null') first = { objectId: handle.objectId, positive: (await scope.at.callOn<number>(handle.objectId, 'function () { return this.tabIndex; }')) > 0 };
    } catch (err) {
      rethrowHard(err);
    }
    await this.resetStarts(false);
    this.current = undefined;
    if (!(first?.positive && !this.root)) {
      let moved = !scope.objectId; // resetStarts already moved the page's starting point.
      if (scope.objectId) {
        try {
          moved = await scope.at.callOn<boolean>(scope.objectId, START_AT);
        } catch (err) {
          rethrowHard(err);
        }
      }
      const taken = await this.step();
      let ok = moved || !first;
      if (!ok) {
        const { node } = await scope.at.send('DOM.describeNode', { objectId: first!.objectId });
        ok = taken.stop?.key === keyOf(scope.at, node.backendNodeId);
      }
      if (ok) {
        await this.arrive(taken.stop);
        return;
      }
    }
    // Tab cannot be made to start there (or a positive tabindex goes first): focus the first stop by script.
    await scope.at.callOn(first!.objectId, 'function () { this.focus(); }');
    await call.sleep(SETTLE_MS);
    const vp = await viewport(call);
    const found = await this.deepFocus();
    this.current = found;
    const stop = found && (await this.describe(found, vp));
    if (stop) stop.scripted = true;
    this.notes.push(
      first!.positive
        ? 'Stop 1 was focused by script: a positive tabindex puts it first; Tab continued from there.'
        : 'Stop 1 was focused by script (Tab could not be made to start at the beginning); Tab continued from there.',
    );
    await this.arrive(stop?.facts.bridgeUi ? undefined : stop);
  }

  /**
   * Whether the region holds the page's first stop: then Tab going round inside it is the page's own
   * wrap from its end to its start (a region around everything), not a trap.
   */
  private async regionHoldsPageStart(): Promise<boolean> {
    try {
      const handle = await this.call.evaluateHandle(FIRST_TABBABLE);
      if (!handle?.objectId || handle.subtype === 'null') return false;
      const { node } = await this.call.send('DOM.describeNode', { objectId: handle.objectId });
      return await this.inRegion(this.call, node.backendNodeId);
    } catch (err) {
      rethrowHard(err);
      return false;
    }
  }

  /**
   * After Tab came back to stop 1 on the whole page: is there a Tab stop the walk never reached? An
   * element that looks focusable but was not reached is tried directly: Tab from right before it must
   * land on it. Then focus going round was a cycle (a trap holding stop 1), not the page's own wrap.
   */
  private async missedTabStop(): Promise<boolean> {
    let tries = 0;
    for (const doc of this.docs) {
      let count = 0;
      try {
        count = await doc.at.evaluate<number>(UNREACHED_TABBABLE, [this.token, 3], { frameId: doc.frameId, timeoutMs: 10_000 });
      } catch (err) {
        rethrowHard(err);
        continue;
      }
      for (let i = 0; i < count && tries < 3; i++, tries++) {
        try {
          const handle = await doc.at.evaluateHandle('function (i) { return (window.__copaneKbMissed || [])[i] || null; }', [i], { frameId: doc.frameId });
          if (!handle?.objectId || handle.subtype === 'null') continue;
          const { node } = await doc.at.send('DOM.describeNode', { objectId: handle.objectId });
          if (!(await doc.at.callOn<boolean>(handle.objectId, START_BEFORE))) continue;
          await this.press();
          const found = await this.deepFocus();
          this.current = found;
          if (found?.key === keyOf(doc.at, node.backendNodeId)) return true;
        } catch (err) {
          rethrowHard(err);
        }
      }
      if (tries >= 3) break;
    }
    return false;
  }

  /** Turns the outcome into the report's end and the trap problem, probing with Shift+Tab where needed. */
  private async ending(outcome: Outcome, keys: string[], outsideLabel: string | undefined): Promise<{ end: KbEnd; problem?: KbProblem }> {
    const base = (key: string) => this.stops.get(splitInside(key).key)!;
    switch (outcome.kind) {
      case 'empty':
        return { end: { kind: 'empty', next: outsideLabel } };
      case 'complete':
      case 'left-region':
      case 'modal':
      case 'limit':
      case 'none':
        return { end: { kind: outcome.kind } };
      case 'time':
        return { end: { kind: 'time' } };
      case 'stuck': {
        const stop = base(keys[outcome.index]!);
        return {
          end: { kind: 'trap', stop: outcome.index + 1 },
          problem: { id: 'keyboard-trap', count: 1, what: 'Tab is captured here (the page takes the key and focus does not move); WCAG allows it only if the page says how to leave', items: [stop.label] },
        };
      }
      case 'opaque': {
        const stop = base(keys[outcome.index]!);
        const leaves = await this.shiftTabLeaves(new Set([stop.key]), OPAQUE_LIMIT, stop);
        if (leaves) return { end: { kind: 'opaque', label: stop.label, presses: OPAQUE_LIMIT, inside: stop.opaque } };
        const what = stop.opaque
          ? `Tab and Shift+Tab stay inside ${stop.label} (${stop.opaque}: not inspected) for ${OPAQUE_LIMIT} presses each`
          : `Tab does not move focus from ${stop.label} (${OPAQUE_LIMIT} presses) and Shift+Tab cannot leave it either`;
        return { end: { kind: 'trap', stop: outcome.index + 1 }, problem: { id: 'keyboard-trap', count: 1, what, items: [stop.label] } };
      }
      case 'cycle': {
        const cycle = keys.slice(outcome.start, outcome.start + outcome.length).map(base);
        const unique = [...new Map(cycle.map(s => [s.key, s])).values()];
        const leaves = await this.shiftTabLeaves(new Set(unique.map(s => s.key)), Math.min(unique.length + 1, 60), unique[0]!);
        const region = await this.trapRegion(unique);
        const back = leaves ? 'Shift+Tab leaves it' : 'Shift+Tab cannot leave it either';
        return {
          end: { kind: 'trap', stop: outcome.start + 1 },
          problem: { id: 'keyboard-trap', count: 1, what: `Tab cycles inside ${region} through ${outcome.length} stops; ${back}`, items: unique.map(s => s.label), itemTotal: unique.length },
        };
      }
    }
  }

  /** From `from` (focused by script), whether Shift+Tab gets focus out of `keys` within `presses` presses. */
  private async shiftTabLeaves(keys: Set<string>, presses: number, from: Stop): Promise<boolean> {
    try {
      await from.at.callOn(from.objectId, 'function () { this.focus({ preventScroll: true }); }');
    } catch (err) {
      rethrowHard(err);
    }
    for (let i = 0; i < presses; i++) {
      await this.press(['Shift']);
      const found = await this.deepFocus();
      this.current = found;
      if (!found || !keys.has(found.key)) return true;
    }
    return false;
  }

  /** The smallest element around all stops of a cycle (when they share a target), else their frame. */
  private async trapRegion(cycle: Stop[]): Promise<string> {
    const at = cycle[0]!.at;
    if (cycle.every(s => s.at === at)) {
      try {
        const handles = [];
        for (const s of cycle.slice(0, 200)) handles.push(new ObjectArg(await at.resolve(s.backendNodeId)));
        const common = await at.callOn(handles[0]!.objectId, COMMON_ANCESTOR, handles, { returnByValue: false });
        if (common?.objectId && common.subtype !== 'null') {
          const { node } = await at.send('DOM.describeNode', { objectId: common.objectId });
          const { object } = await at.send('DOM.resolveNode', { backendNodeId: node.backendNodeId, executionContextId: await this.contextOf(at, cycle[0]!.frameId), objectGroup: this.call.group });
          return (await this.labelOf(at, cycle[0]!.frameId, node.backendNodeId, object?.objectId ?? common.objectId)).label;
        }
      } catch (err) {
        rethrowHard(err);
      }
      return at.frame ? frameLabel(at.frame) : 'the page';
    }
    const outer = cycle.map(s => s.at.frame).find(f => f && !this.call.state.frames.parentOf(f));
    return outer ? frameLabel(outer) : 'several frames';
  }

  // ---------------------------------------------------------------- pixel checks (after the walk)

  /** A PNG of the area. The browser draws a fresh frame for it, which in a tab in the background takes a while. */
  private async capture(area: Record<string, number>): Promise<string> {
    const started = Date.now();
    const { data } = await this.call.send('Page.captureScreenshot', { format: 'png', clip: area, fromSurface: true }, { timeoutMs: 5000 });
    if (Date.now() - started > 300) this.slowPaint = true;
    return data;
  }

  /**
   * The stops whose focus changed no style: the element (or, for a visually hidden input, its label or
   * parent) is captured focused and then with nothing focused in its document, so
   * no neighbour's focus is in either picture. Identical pictures: focus does not show.
   */
  private async pixelChecks(): Promise<void> {
    if (!this.pixelQueue.length) return;
    // A clipped capture drops VS Code's device emulation (emulation.ts), so none is taken while a device is emulated.
    const without: string | undefined = (await pageUsesTouch(this.call)) ? 'device emulation' : undefined;
    const started = Date.now();
    // The bridge's own indicator changes on its own; it must not be in either picture.
    const top = this.docs[0];
    if (!without && top) await this.call.evaluate(TOGGLE_BRIDGE_UI, [true]).catch(err => rethrowHard(err));
    try {
      await this.comparePixels(started, without);
    } finally {
      if (top && !this.call.state.dialog && !this.call.page.closed) await raw(top.at, 'Runtime.callFunctionOn', { functionDeclaration: TOGGLE_BRIDGE_UI, arguments: [{ value: false }], executionContextId: top.contextId, returnByValue: true }).catch(() => undefined);
    }
  }

  private async comparePixels(started: number, without: string | undefined): Promise<void> {
    let done = 0;
    for (const { stop, related } of this.pixelQueue) {
      const hiddenInput = related ? 'the input itself is visually hidden; nothing near it shows focus' : '';
      if (!without && (done >= MAX_PIXEL_CHECKS || Date.now() - started > PIXEL_BUDGET_MS)) without = 'time limit';
      let same: boolean | undefined;
      if (!without && this.call.state.loaderId === this.loaderId) {
        done++;
        try {
          same = await this.pixelSame(stop, related);
        } catch (err) {
          rethrowHard(err);
          if (err instanceof ToolError && err.code === 'timeout') without = 'a screenshot timed out';
        }
      }
      if (same === false) continue;
      const parts = [stop.frame && same === undefined ? `in ${stop.frame}` : '', hiddenInput, same === undefined ? `style check only${without ? `: ${without}` : ''}` : ''].filter(Boolean);
      this.notVisible.set(stop.key, `${stop.label}${parts.length ? ` (${parts.join('; ')})` : ''}`);
    }
  }

  /** True when the pictures with and without focus are identical; undefined when they could not be compared. */
  private async pixelSame(stop: Stop, related: boolean): Promise<boolean | undefined> {
    const { at } = stop;
    let target = stop.backendNodeId;
    let targetObject = stop.objectId;
    if (related) {
      const handle = await at.callOn(stop.objectId, INDICATOR, [], { returnByValue: false });
      if (!handle?.objectId || handle.subtype === 'null') return undefined;
      target = (await at.send('DOM.describeNode', { objectId: handle.objectId })).node.backendNodeId;
      targetObject = handle.objectId;
    }
    await at.callOn(stop.objectId, 'function () { this.focus(); }');
    await this.call.sleep(SETTLE_MS);
    const vp = await viewport(this.call);
    let view = await elementBox(at, target);
    if (!view) return undefined;
    // A ring may be drawn by an ancestor further out (padding between): take in the nearest ancestors' boxes, while small.
    for (let level = 1; level <= 3; level++) {
      const handle = await at.callOn(targetObject, ANCESTOR, [level], { returnByValue: false });
      if (!handle?.objectId || handle.subtype === 'null') break;
      const outer = await elementBox(at, (await at.send('DOM.describeNode', { objectId: handle.objectId })).node.backendNodeId);
      if (!outer || outer.width > 600 || outer.height > 300) break;
      const x0 = Math.min(view.x, outer.x);
      const y0 = Math.min(view.y, outer.y);
      view = { x: x0, y: y0, width: Math.max(view.x + view.width, outer.x + outer.width) - x0, height: Math.max(view.y + view.height, outer.y + outer.height) - y0 };
    }
    const m = 8;
    const x = Math.max(0, view.x - m);
    const y = Math.max(0, view.y - m);
    const width = Math.min(600, Math.min(vp.width, view.x + view.width + m) - x);
    const height = Math.min(300, Math.min(vp.height, view.y + view.height + m) - y);
    if (width < 2 || height < 2) return undefined;
    const area = { x: x + vp.pageX, y: y + vp.pageY, width, height, scale: 1 };
    const focused = await this.capture(area);
    await at.callOn(stop.objectId, 'function () { this.blur(); }');
    await this.call.sleep(SETTLE_MS);
    const after = await viewport(this.call);
    if (after.pageX !== vp.pageX || after.pageY !== vp.pageY) return undefined;
    return samePicture(focused, await this.capture(area));
  }

  // ---------------------------------------------------------------- checks after the walk

  /** Interactive-looking elements Tab never reached (WCAG 2.1.1), over the region or every document. */
  private async unreachable(modalOnly: boolean): Promise<KbProblem | undefined> {
    const scopes: Array<{ at: PageCall; frameId: string | undefined; objectId?: string }> = this.region ? [this.region] : this.docs;
    // Candidates by strength: 0 an interactive role or onclick, 1 cursor: pointer with a click handler, 2 without one.
    const found: Array<{ at: PageCall; frameId: string | undefined; objectId: string; backendNodeId: number; why: string; rank: number }> = [];
    let total = 0;
    for (const scope of scopes) {
      let r: { total: number; items: Array<{ index: number; weak: boolean; why: string }> };
      const args = [this.token, MAX_CANDIDATE_ELEMENTS, MAX_CANDIDATES, modalOnly];
      try {
        r = scope.objectId ? await scope.at.callOn(scope.objectId, UNREACHED, args, { timeoutMs: 20_000 }) : await scope.at.evaluate(UNREACHED, args, { frameId: scope.frameId, timeoutMs: 20_000 });
      } catch (err) {
        rethrowHard(err);
        continue;
      }
      total += r.total;
      for (const item of r.items) {
        if (found.length >= MAX_CANDIDATES) break;
        try {
          const handle = await scope.at.evaluateHandle('function (i) { return (window.__copaneKbCandidates || [])[i] || null; }', [item.index], { frameId: scope.frameId });
          if (!handle?.objectId || handle.subtype === 'null') continue;
          const { node } = await scope.at.send('DOM.describeNode', { objectId: handle.objectId });
          let why = item.why;
          let rank = 0;
          if (item.weak) {
            const evidence = await this.clickHandler(scope.at, node.backendNodeId);
            why = evidence ? 'click handler, cursor: pointer' : 'cursor: pointer, no handler found: maybe decorative';
            rank = evidence ? 1 : 2;
          }
          found.push({ at: scope.at, frameId: scope.frameId, objectId: handle.objectId, backendNodeId: node.backendNodeId, why, rank });
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
        items.push(`${(await this.labelOf(c.at, c.frameId, c.backendNodeId, c.objectId)).label} (${c.why})`);
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

  private async report(keys: string[], end: KbEnd, trapProblem: KbProblem | undefined): Promise<Omit<KbInput, 'notRestored' | 'pageChanges'>> {
    // The stops in order, those inside an opaque container folded into it.
    const lines: Array<{ stop: Stop; inside: number }> = [];
    for (const key of keys) {
      const { key: k, inside } = splitInside(key);
      const stop = this.stops.get(k)!;
      const prev = lines.at(-1);
      if (inside && prev && prev.stop === stop) prev.inside++;
      else lines.push({ stop, inside: 0 });
    }
    const order = lines.map(l => l.stop);
    const problems: KbProblem[] = [];
    if (trapProblem) problems.push(trapProblem);
    const complete = end.kind === 'complete' || end.kind === 'left-region' || end.kind === 'modal' || end.kind === 'empty' || end.kind === 'none';
    const notVisible = [...new Set(order)].filter(s => this.notVisible.has(s.key)).map(s => this.notVisible.get(s.key)!);
    if (notVisible.length) problems.push({ id: 'focus-not-visible', count: notVisible.length, items: notVisible });
    if (complete) {
      const unreachable = await this.unreachable(end.kind === 'modal');
      if (unreachable) problems.push(unreachable);
    }
    if (!this.root && end.kind === 'complete') {
      const skip = judgeSkipLink(order.map(s => ({ label: s.label, name: s.name, skip: s.facts.skip ?? undefined, inMain: s.facts.inMain })));
      if (skip.kind === 'missing') problems.push({ id: 'skip-link-missing', count: 1, what: `${skip.before} stops before the main content (first in <main>: ${skip.firstMain})`, items: [] });
      if (skip.kind === 'broken') problems.push({ id: 'skip-link-broken', count: 1, what: `the skip link goes nowhere: ${skip.why}`, items: [skip.label] });
    }
    const ltr = !(order[0]?.facts.rtl ?? false);
    const jumps = orderJumps(order.map(s => ({ label: s.label, box: s.box, tabindex: s.facts.tabindex || undefined, fixed: s.facts.fixed, doc: s.doc })), ltr);
    if (jumps.count) problems.push({ id: 'focus-order', count: jumps.count, items: jumps.shown.map(j => j.text) });
    if (this.slowPaint && !this.call.tab.active) this.notes.push('The tab is in the background, where VS Code paints it rarely, which slowed the pixel checks; walks are faster when it is the visible tab.');
    const stops: KbStopLine[] = lines.map(({ stop: s, inside }) => ({
      label: s.label,
      box: s.box,
      tabindex: s.facts.tabindex > 0 ? s.facts.tabindex : undefined,
      frame: s.frame,
      scripted: s.scripted,
      inside: inside ? { count: inside, what: s.opaque ?? 'its inside' } : undefined,
    }));
    return {
      tabId: this.call.tab.id,
      scope: this.root ? `only ${this.root.label}` : 'whole page',
      documents: new Set(order.map(s => s.doc)).size,
      stops,
      end,
      ms: this.elapsed,
      problems,
      notes: this.notes,
      background: !this.call.tab.active,
    };
  }
}

/** browser_audit type "keyboard" on the whole page or, with `root`, on one region of it. */
export async function keyboardAudit(call: PageCall, root: ElementTarget | undefined): Promise<string> {
  return new Walk(call, root).run();
}
