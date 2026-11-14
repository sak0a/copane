// Functions that run inside the page, passed as source to `Runtime.callFunctionOn`. They install
// nothing in the page: no globals, no attributes, no listeners. Document-level helpers run in the
// bridge's isolated world, so the page's scripts cannot see them or interfere with them; helpers bound
// to an element run with `this` = the element.

/** Shared snippet: the visible text of the whole page, including shadow roots and same-origin frames. */
const PAGE_TEXT = `
  const pageText = () => {
    const parts = [];
    const visit = (root) => {
      if (root.body) parts.push(root.body.innerText || '');
      else for (const child of root.children) if (child.innerText) parts.push(child.innerText);
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) visit(el.shadowRoot);
        if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
          let doc = null;
          try { doc = el.contentDocument; } catch {}
          if (doc) visit(doc);
        }
      }
    };
    visit(document);
    return parts.join('\\n');
  };
`;

/** Isolated world. `(maxChars)` → the start of the page's visible text, for error messages. */
export const PAGE_TEXT_EXCERPT = `function (maxChars) {
  ${PAGE_TEXT}
  const text = pageText().replace(/\\s+/g, ' ').trim();
  return text.length > maxChars ? text.slice(0, maxChars) + '…' : text;
}`;

/** Element (this). The facts needed to decide whether and how to act on it. */
export const INSPECT_ELEMENT = `function () {
  const node = this;
  const el = node.nodeType === 1 ? node : node.parentElement;
  if (!node.isConnected || !el) return { connected: false };
  const win = el.ownerDocument.defaultView;
  const style = win.getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  let visible = rect.width > 0 && rect.height > 0 && style.visibility === 'visible';
  if (visible && el.checkVisibility) visible = el.checkVisibility({ visibilityProperty: true });
  if (!visible && style.display === 'contents') visible = [...el.children].some(c => { const r = c.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
  const tag = el.tagName.toLowerCase();
  const role = el.getAttribute('role');
  const type = tag === 'input' ? (el.getAttribute('type') || 'text').toLowerCase() : undefined;
  let disabled = false;
  if (['button', 'input', 'select', 'textarea', 'option', 'optgroup'].includes(tag) && el.disabled) disabled = true;
  if (!disabled && el.closest('[aria-disabled="true"]')) disabled = true;
  const textTypes = ['text', 'search', 'email', 'url', 'tel', 'password', 'number'];
  const valueTypes = ['date', 'time', 'datetime-local', 'month', 'week', 'color', 'range'];
  let kind = 'other';
  if (tag === 'textarea' || (tag === 'input' && textTypes.includes(type))) kind = 'text';
  else if (tag === 'input' && valueTypes.includes(type)) kind = 'value';
  else if (tag === 'input' && (type === 'checkbox' || type === 'radio')) kind = type;
  else if (tag === 'input' && type === 'file') kind = 'file';
  else if (tag === 'input' && ['submit', 'button', 'reset', 'image'].includes(type)) kind = 'button';
  else if (tag === 'select') kind = 'select';
  else if (el.isContentEditable) kind = 'contenteditable';
  else if (role === 'checkbox' || role === 'switch' || role === 'menuitemcheckbox') kind = 'checkbox';
  else if (role === 'radio' || role === 'menuitemradio') kind = 'radio';
  let checked;
  if (kind === 'checkbox' || kind === 'radio') checked = 'checked' in el && (tag === 'input') ? el.checked : el.getAttribute('aria-checked') === 'true';
  const readonly = (kind === 'text' || kind === 'value') && el.readOnly;
  let fileInput = false;
  if (kind !== 'file') {
    const control = tag === 'label' ? el.control : el.querySelector && el.querySelector('input[type=file]');
    fileInput = !!(control && control.type === 'file');
  }
  return { connected: true, visible, disabled, readonly, tag, type, kind, checked, multiple: !!el.multiple, isFrame: tag === 'iframe' || tag === 'frame', hasFileInput: fileInput };
}`;

/** Element (this). `(hit)` → whether `hit` is this element or inside it (across shadow roots). */
export const CONTAINS = `function (hit) {
  for (let n = hit; n; n = n.parentNode || n.host) if (n === this) return true;
  return false;
}`;

/** Element (this). A short description like '<div class="modal"> Please sign in'. */
export const DESCRIBE = `function () {
  const el = this.nodeType === 1 ? this : this.parentElement;
  if (!el) return String(this.nodeName);
  let s = '<' + el.tagName.toLowerCase();
  if (el.id) s += ' id="' + el.id + '"';
  const cls = typeof el.className === 'string' ? el.className.trim().split(/\\s+/).slice(0, 3).join(' ') : '';
  if (cls) s += ' class="' + cls + '"';
  s += '>';
  const text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
  return text ? s + ' ' + (text.length > 50 ? text.slice(0, 50) + '…' : text) : s;
}`;

/** Element (this). Focuses it and selects its content (clear) or puts the caret at the end. */
export const FOCUS_FOR_TYPING = `function (clear) {
  this.focus({ preventScroll: true });
  const tag = this.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') {
    if (clear) this.select();
    else { try { const n = this.value.length; this.setSelectionRange(n, n); } catch {} }
  } else if (this.isContentEditable) {
    const doc = this.ownerDocument;
    const range = doc.createRange();
    range.selectNodeContents(this);
    if (!clear) range.collapse(false);
    const sel = doc.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
  let active = this.ownerDocument.activeElement;
  while (active && active.shadowRoot && active.shadowRoot.activeElement) active = active.shadowRoot.activeElement;
  return active === this || this.contains(active);
}`;

/** Element (this). Focuses it. */
export const FOCUS = `function () { this.focus({ preventScroll: true }); }`;

/** Element (this). The text a field holds. */
export const READ_VALUE = `function () {
  if ('value' in this && typeof this.value === 'string' && this.tagName !== 'BUTTON' && this.tagName !== 'LI') return this.value;
  return (this.innerText || this.textContent || '');
}`;

/**
 * Element (this). Sets the value of an input that has no text editing (date, color, range ...) the way
 * a user's picker would: through the native setter (so frameworks notice), then input and change.
 */
export const SET_INPUT_VALUE = `function (value) {
  const proto = this.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  this.focus({ preventScroll: true });
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(this, value);
  this.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  this.dispatchEvent(new Event('change', { bubbles: true }));
  return this.value;
}`;

/** Element (this, a <select>). `(values)` → { selected } or { missing, available } or { error }. */
export const SELECT_OPTIONS = `function (values) {
  if (this.tagName !== 'SELECT') return { error: 'not-select' };
  const options = [...this.options];
  const label = (o) => (o.label || o.textContent || '').replace(/\\s+/g, ' ').trim();
  const chosen = [];
  const missing = [];
  for (const v of values) {
    let o = options.find(o => o.value === v || label(o) === v);
    if (!o) o = options.find(o => label(o).toLowerCase() === String(v).trim().toLowerCase());
    if (o) chosen.push(o); else missing.push(v);
  }
  if (missing.length) return { missing, available: options.slice(0, 40).map(o => label(o) + (o.value !== label(o) ? ' (value "' + o.value + '")' : '')), total: options.length };
  if (!this.multiple && chosen.length > 1) return { error: 'single' };
  const disabled = chosen.filter(o => o.disabled).map(label);
  if (disabled.length) return { disabledOptions: disabled };
  this.focus({ preventScroll: true });
  for (const o of options) o.selected = chosen.includes(o);
  this.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  this.dispatchEvent(new Event('change', { bubbles: true }));
  return { selected: chosen.map(label) };
}`;

/** Element (this). Scrolls it into the middle of its scroll containers. */
export const SCROLL_INTO_VIEW = `function () {
  const el = this.nodeType === 1 ? this : this.parentElement;
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
}`;

/**
 * Isolated world. `(x, y, to, dx, dy)`: the scroll position of the scroll container under the point
 * (or the page). With `to` = "top"/"bottom"/"left"/"right", or a delta, scrolls it first.
 */
export const SCROLL_STATE = `function (x, y, to, dx, dy) {
  const scrollable = (el) => {
    if (!el || el.nodeType !== 1) return false;
    const s = getComputedStyle(el);
    const oy = /(auto|scroll|overlay)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 1;
    const ox = /(auto|scroll|overlay)/.test(s.overflowX) && el.scrollWidth > el.clientWidth + 1;
    return oy || ox;
  };
  let el = x === null ? null : document.elementFromPoint(x, y);
  while (el && el.shadowRoot && el.shadowRoot.elementFromPoint) {
    const inner = el.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === el) break;
    el = inner;
  }
  let container = null;
  for (let n = el; n; n = n.parentElement || (n.getRootNode && n.getRootNode().host) || null) {
    if (n === document.documentElement || n === document.body) break;
    if (scrollable(n)) { container = n; break; }
  }
  const target = container || document.scrollingElement || document.documentElement;
  if (to === 'top') target.scrollTo({ top: 0, behavior: 'instant' });
  if (to === 'bottom') target.scrollTo({ top: target.scrollHeight, behavior: 'instant' });
  if (to === 'left') target.scrollTo({ left: 0, behavior: 'instant' });
  if (to === 'right') target.scrollTo({ left: target.scrollWidth, behavior: 'instant' });
  if (dx || dy) target.scrollBy({ left: dx || 0, top: dy || 0, behavior: 'instant' });
  let label = 'page';
  if (container) {
    label = '<' + container.tagName.toLowerCase() + (container.id ? ' id="' + container.id + '"' : '') + (typeof container.className === 'string' && container.className.trim() ? ' class="' + container.className.trim().split(/\\s+/).slice(0, 2).join(' ') + '"' : '') + '>';
  }
  return { label, top: Math.round(target.scrollTop), left: Math.round(target.scrollLeft), height: target.scrollHeight, width: target.scrollWidth, clientHeight: target.clientHeight, clientWidth: target.clientWidth };
}`;

/**
 * Isolated world. Keeps the browser's own context menu from opening for the agent's next right-click
 * (VS Code would show it on the user's screen). Listens last, in the bubble phase, so the page's own
 * contextmenu handlers run first and see an untouched event. Removes itself after one event or 2 s.
 */
export const SUPPRESS_NATIVE_CONTEXT_MENU = `function () {
  const stop = (e) => { e.preventDefault(); window.removeEventListener('contextmenu', stop); };
  window.addEventListener('contextmenu', stop);
  setTimeout(() => window.removeEventListener('contextmenu', stop), 2000);
}`;

/** Isolated world. Hides (true) or restores (false) the bridge's own UI elements for a screenshot. */
export const TOGGLE_BRIDGE_UI = `function (hide) {
  let n = 0;
  for (const el of document.querySelectorAll('[data-copane-ui]')) {
    if (hide) {
      if (el.__copaneHidden) continue;
      el.__copaneHidden = [el.style.getPropertyValue('visibility'), el.style.getPropertyPriority('visibility')];
      el.style.setProperty('visibility', 'hidden', 'important');
    } else if (el.__copaneHidden) {
      const [value, priority] = el.__copaneHidden;
      if (value) el.style.setProperty('visibility', value, priority); else el.style.removeProperty('visibility');
      delete el.__copaneHidden;
    }
    n++;
  }
  return n;
}`;

/** Isolated world. The focused element, looking into shadow roots and same-origin frames. */
export const DEEP_ACTIVE_ELEMENT = `function () {
  let el = document.activeElement;
  for (;;) {
    if (el && el.shadowRoot && el.shadowRoot.activeElement) { el = el.shadowRoot.activeElement; continue; }
    if (el && (el.tagName === 'IFRAME' || el.tagName === 'FRAME')) {
      let doc = null;
      try { doc = el.contentDocument; } catch {}
      if (doc && doc.activeElement && doc.activeElement !== doc.body) { el = doc.activeElement; continue; }
    }
    break;
  }
  return el && el !== document.body && el !== document.documentElement ? el : null;
}`;

/** Any world, `this` = a value. JSON for the agent: DOM nodes described, cycles cut, size bounded. */
export const SERIALIZE = `function (maxChars) {
  const seen = new WeakSet();
  const describe = (n) => {
    if (n.nodeType === 1) {
      let s = '<' + n.tagName.toLowerCase();
      if (n.id) s += ' id="' + n.id + '"';
      const cls = typeof n.className === 'string' ? n.className.trim().split(/\\s+/).slice(0, 3).join(' ') : '';
      if (cls) s += ' class="' + cls + '"';
      s += '>';
      const t = (n.textContent || '').replace(/\\s+/g, ' ').trim();
      return t ? s + ' ' + (t.length > 80 ? t.slice(0, 80) + '…' : t) : s;
    }
    if (n.nodeType === 3) return '#text ' + JSON.stringify((n.textContent || '').slice(0, 80));
    if (n.nodeType === 9) return '#document ' + n.URL;
    return n.nodeName;
  };
  const walk = (v, depth) => {
    if (v === null) return null;
    const t = typeof v;
    if (t === 'string' || t === 'boolean') return v;
    if (t === 'number') return Number.isFinite(v) ? v : String(v);
    if (t === 'undefined') return '(undefined)';
    if (t === 'bigint') return v.toString() + 'n';
    if (t === 'symbol') return v.toString();
    if (t === 'function') return '(function ' + (v.name || 'anonymous') + ')';
    if (typeof Node === 'function' && v instanceof Node) return describe(v);
    if (typeof Window === 'function' && v instanceof Window) return '(window ' + v.location.href + ')';
    if (seen.has(v)) return '(circular)';
    if (depth > 6) return Array.isArray(v) ? '(array of ' + v.length + ')' : '(object)';
    seen.add(v);
    if (v instanceof Error) return { name: v.name, message: v.message, stack: String(v.stack || '').split('\\n').slice(0, 6).join('\\n') };
    if (v instanceof Date) return isNaN(v) ? 'Invalid Date' : v.toISOString();
    if (v instanceof RegExp) return String(v);
    if (v instanceof Promise) return '(promise)';
    if (v instanceof Map) return { '(Map)': [...v.entries()].slice(0, 100).map(([k, x]) => [walk(k, depth + 1), walk(x, depth + 1)]) };
    if (v instanceof Set) return { '(Set)': [...v].slice(0, 100).map(x => walk(x, depth + 1)) };
    const listLike = Array.isArray(v) || ArrayBuffer.isView(v) || (typeof NodeList === 'function' && v instanceof NodeList) || (typeof HTMLCollection === 'function' && v instanceof HTMLCollection);
    if (listLike) {
      const arr = Array.from(v);
      const out = arr.slice(0, 200).map(x => walk(x, depth + 1));
      if (arr.length > 200) out.push('… ' + (arr.length - 200) + ' more items');
      return out;
    }
    if (typeof v.toJSON === 'function') { try { return walk(v.toJSON(), depth + 1); } catch {} }
    const out = {};
    let n = 0;
    for (const k in v) {
      if (n++ >= 200) { out['…'] = 'more keys'; break; }
      let x;
      try { x = v[k]; } catch (e) { x = '(threw)'; }
      out[k] = walk(x, depth + 1);
    }
    return out;
  };
  let json;
  try { json = JSON.stringify(walk(this, 0), null, 2); } catch (e) { json = String(e); }
  if (json === undefined) json = 'undefined';
  return json.length > maxChars ? json.slice(0, maxChars) + '\\n… (cut: ' + json.length + ' characters in total)' : json;
}`;

/** Any world. Runs `fn` (the agent's function source) with an optional element argument. */
export function wrapUserFunction(source: string): string {
  return `async function (element) {
  const __f = (${source}\n);
  return typeof __f === 'function' ? await __f(element) : await __f;
}`;
}

/**
 * With `this` = an element of the main frame: whether the page's own hit test at viewport (x, y)
 * lands on it or inside it (through open shadow roots). False for elements in frames.
 */
export const PAGE_HIT_TEST = `function (x, y) {
  const view = this.ownerDocument.defaultView;
  if (!view || view !== view.top) return false;
  let el = this.ownerDocument.elementFromPoint(x, y);
  while (el && el.shadowRoot) {
    const inner = el.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === el) break;
    el = inner;
  }
  for (let n = el; n; n = n.parentNode || n.host) if (n === this) return true;
  return false;
}`;

/**
 * Element (this). The field's label when it is a secret field (password, one-time code, card number or
 * code), else ''. Cheap, and run before anything slow, so a secret is recognised even when choosing a
 * locator fails.
 */
export const SECRET_FIELD = `function () {
  const el = this;
  if (!el || el.nodeType !== 1) return '';
  const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
  if (!(el.type === 'password' || /(current|new)-password|one-time-code|cc-number|cc-csc/.test(ac))) return '';
  const label = el.labels && el.labels[0] ? el.labels[0].textContent : el.getAttribute('aria-label') || el.name || el.id || 'password';
  return String(label).replace(/\\s+/g, ' ').trim() || 'password';
}`;
