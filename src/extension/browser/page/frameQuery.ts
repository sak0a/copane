// CSS selectors, wait conditions and focus across cross-origin frames.
//
// Selectors: a plain selector searches the page (with its open shadow roots and same-origin iframes)
// and then every cross-origin frame, preferring a visible match. `A >>> B` scopes: A selects an
// `<iframe>` (first visible match), B is searched inside that frame's document; it nests
// (`A >>> B >>> C`) and works for same-origin and cross-origin frames alike.
import { ToolError } from '../../core/errors';
import { ObjectArg, type PageCall } from './call';
import type { FrameTarget } from './frames';
import { ownerOf } from './frameTargets';
import { DialogInterrupt } from './pageState';

export const FRAME_COMBINATOR = '>>>';

/** Searches from a document (default the frame's own, or the content document of `root`, an iframe). */
const SEARCH = `
  const startOf = (root) => root ? root.contentDocument : document;
  const isVisible = (el) => {
    if (!el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = el.ownerDocument.defaultView.getComputedStyle(el);
    if (style.visibility !== 'visible') return false;
    return el.checkVisibility ? el.checkVisibility({ visibilityProperty: true }) : true;
  };
  const deepQueryAll = (selector, start) => {
    const out = [];
    const visit = (root) => {
      out.push(...root.querySelectorAll(selector));
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) visit(el.shadowRoot);
        if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
          let doc = null;
          try { doc = el.contentDocument; } catch {}
          if (doc) visit(doc);
        }
      }
    };
    if (start) visit(start);
    return out;
  };
`;

/** Isolated world. `(selector, root?)` → [firstVisibleOrFirst, count, visibleCount] or { error }. */
const QUERY_FROM = `function (selector, root) {
  ${SEARCH}
  let all;
  try { all = deepQueryAll(selector, startOf(root)); } catch (e) { return { error: String(e && e.message || e) }; }
  const visible = all.filter(isVisible);
  return [visible[0] || all[0] || null, all.length, visible.length];
}`;

/** Isolated world. `(texts)` → for each text: whether this document (with shadow roots, same-origin frames) shows it. */
const HAS_TEXT = `function (texts) {
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
  const norm = (s) => String(s).replace(/\\s+/g, ' ').trim().toLowerCase();
  const text = norm(parts.join('\\n'));
  return texts.map(t => text.includes(norm(t)));
}`;

/** Element (this). Whether it is an iframe whose document this world can read (same-origin), or false/null. */
const FRAME_ACCESS = `function () {
  if (this.tagName !== 'IFRAME' && this.tagName !== 'FRAME') return null;
  try { return !!this.contentDocument; } catch { return false; }
}`;

export function splitFrameSelector(selector: string): string[] {
  return selector.split(FRAME_COMBINATOR).map(s => s.trim());
}

interface Scope {
  at: PageCall;
  /** Object id of a same-origin iframe element whose document to search (in `at`'s isolated world). */
  root?: string;
}

interface QueryResult {
  at: PageCall;
  /** Handle (isolated world) of the first visible match, else the first match. */
  element: { objectId: string } | undefined;
  count: number;
  visible: number;
}

function rethrowHard(err: unknown): void {
  if (err instanceof DialogInterrupt || err instanceof ToolError) throw err;
}

async function queryIn(scope: Scope, selector: string): Promise<QueryResult | { error: string }> {
  const handle = await scope.at.evaluateHandle(QUERY_FROM, [selector, scope.root ? new ObjectArg(scope.root) : null], { timeoutMs: scope.at.frame ? FRAME_QUERY_TIMEOUT_MS : undefined });
  if (handle.subtype !== 'array') {
    const value = handle.objectId ? await scope.at.callOn(handle.objectId, 'function () { return this; }') : handle.value;
    return { error: value?.error ?? 'syntax error' };
  }
  const { result } = await scope.at.send('Runtime.getProperties', { objectId: handle.objectId, ownProperties: true });
  const first = result.find((p: any) => p.name === '0')?.value;
  const count = Number(result.find((p: any) => p.name === '1')?.value?.value ?? 0);
  const visible = Number(result.find((p: any) => p.name === '2')?.value?.value ?? 0);
  return { at: scope.at, element: first?.objectId ? { objectId: first.objectId } : undefined, count, visible };
}

/** Frames to search for a plain selector, in document order: all but those loading a document right now. */
function searchableFrames(call: PageCall): FrameTarget[] {
  return call.state.frames.list().filter(f => !f.session.closed && (f.lifecycle.has('DOMContentLoaded') || !f.loading));
}

/** A frame that does not answer (busy, being replaced) must not hold up a search of the others. */
const FRAME_QUERY_TIMEOUT_MS = 3000;

/** Enters the iframe a scope's element is: same-origin stays in the world, cross-origin switches target. */
async function enter(scope: Scope, element: { objectId: string }, selector: string): Promise<Scope | { missing: string }> {
  const access = await scope.at.callOn<boolean | null>(element.objectId, FRAME_ACCESS);
  if (access === null) throw new ToolError('invalid_input', `"${selector}" (before ${FRAME_COMBINATOR}) must select an <iframe>, but it matches another element.`);
  if (access) return { at: scope.at, root: element.objectId };
  const frame = await frameOfOwner(scope.at, element.objectId);
  if (!frame || frame.session.closed) return { missing: `the iframe "${selector}" has no document yet` };
  return { at: scope.at.at(frame) };
}

/** The frame target an `<iframe>` element (handle in `at`) hosts, if it is cross-origin and attached. */
export async function frameOfOwner(at: PageCall, objectId: string): Promise<FrameTarget | undefined> {
  let node: { backendNodeId: number; frameId?: string };
  try {
    ({ node } = await at.send('DOM.describeNode', { objectId }));
  } catch (err) {
    rethrowHard(err);
    return undefined;
  }
  const frames = at.state.frames;
  const direct = node.frameId ? frames.get(node.frameId) : undefined;
  if (direct) return direct;
  for (const f of frames.list()) {
    if (frames.parentOf(f) !== at.frame || f.session.closed) continue;
    try {
      if ((await ownerOf(at, f)) === node.backendNodeId) return f;
    } catch (err) {
      if (err instanceof DialogInterrupt || (err instanceof ToolError && err.code === 'cancelled')) throw err;
    }
  }
  return undefined;
}

/** Resolves all but the last part of `A >>> B >>> C` to the scope C is searched in. */
async function scopeOf(call: PageCall, parts: string[]): Promise<Scope | { missing: string } | { error: string; part: string }> {
  let scope: Scope = { at: call.top };
  for (const part of parts.slice(0, -1)) {
    const r = await queryIn(scope, part);
    if ('error' in r) return { error: r.error, part };
    if (!r.element) return { missing: `no iframe matches "${part}"` };
    const next = await enter(scope, r.element, part);
    if ('missing' in next) return next;
    scope = next;
  }
  return scope;
}

/**
 * Finds the element for a selector: the page first, then cross-origin frames, preferring visible
 * matches; or inside the frame a `>>>` selector names. `element` undefined = no match (yet).
 */
export async function querySelectorAcrossFrames(call: PageCall, selector: string): Promise<QueryResult | { error: string; part: string } | { missing: string }> {
  const parts = splitFrameSelector(selector);
  if (parts.some(p => p === '')) throw new ToolError('invalid_input', `"${selector}" has an empty part around ${FRAME_COMBINATOR}. Write "iframe-selector ${FRAME_COMBINATOR} selector".`);
  const scope = await scopeOf(call, parts);
  if (!('at' in scope)) return scope;
  const last = parts[parts.length - 1]!;
  const main = await queryIn(scope, last);
  if ('error' in main) return { error: main.error, part: last };
  if (parts.length > 1 || main.visible > 0) return main;
  let best: QueryResult | undefined = main.element ? main : undefined;
  let total = main.count;
  for (const frame of searchableFrames(call)) {
    let r: QueryResult | { error: string };
    try {
      r = await queryIn({ at: call.at(frame) }, last);
    } catch (err) {
      if (err instanceof DialogInterrupt || (err instanceof ToolError && err.code === 'cancelled')) throw err;
      continue; // The frame is going away; others may still match.
    }
    if ('error' in r) continue;
    total += r.count;
    if (r.visible > 0 && !(best && best.visible > 0)) best = r;
    else if (!best && r.element) best = r;
  }
  return best ? { ...best, count: total } : { ...main, count: total };
}

export interface FrameConditions {
  text?: string;
  textGone?: string;
  selector?: string;
  state?: 'visible' | 'hidden' | 'attached' | 'detached';
}

export interface FrameChecks {
  text?: boolean;
  textGone?: boolean;
  selector?: boolean;
  selectorCount?: number;
  selectorVisible?: number;
  error?: string;
}

/**
 * Evaluates wait conditions over the page and its cross-origin frames: text counts when any document
 * shows it, is gone when none does; selector matches are counted over all documents (or inside the
 * frame a `>>>` selector names).
 */
export async function checkAcrossFrames(call: PageCall, c: FrameConditions): Promise<FrameChecks> {
  const out: FrameChecks = {};
  const targets: PageCall[] = [call.top, ...searchableFrames(call).map(f => call.at(f))];
  const texts = [c.text, c.textGone].filter((t): t is string => t !== undefined);
  if (texts.length) {
    const seen = texts.map(() => false);
    await Promise.all(
      targets.map(async at => {
        try {
          const r = await at.evaluate<boolean[]>(HAS_TEXT, [texts], { timeoutMs: at.frame ? FRAME_QUERY_TIMEOUT_MS : 5000 });
          r.forEach((v, i) => (seen[i] ||= v));
        } catch (err) {
          if (at === call.top || err instanceof DialogInterrupt || (err instanceof ToolError && err.code === 'cancelled')) throw err;
        }
      }),
    );
    let i = 0;
    if (c.text !== undefined) out.text = seen[i++];
    if (c.textGone !== undefined) out.textGone = !seen[i++];
  }
  if (c.selector !== undefined) {
    const parts = splitFrameSelector(c.selector);
    let count = 0;
    let visible = 0;
    const last = parts[parts.length - 1]!;
    if (parts.some(p => p === '')) return { error: `empty part around ${FRAME_COMBINATOR}` };
    const scopes: Scope[] = [];
    if (parts.length > 1) {
      const scope = await scopeOf(call, parts);
      if ('error' in scope) return { error: scope.error };
      if ('at' in scope) scopes.push(scope);
    } else {
      scopes.push(...targets.map(at => ({ at })));
    }
    for (const scope of scopes) {
      try {
        const r = await queryIn(scope, last);
        if ('error' in r) return { error: r.error };
        count += r.count;
        visible += r.visible;
      } catch (err) {
        if (scope.at === call.top || err instanceof DialogInterrupt || (err instanceof ToolError && err.code === 'cancelled')) throw err;
      }
    }
    const state = c.state ?? 'visible';
    out.selector = state === 'visible' ? visible > 0 : state === 'hidden' ? visible === 0 : state === 'attached' ? count > 0 : count === 0;
    out.selectorCount = count;
    out.selectorVisible = visible;
  }
  return out;
}

/**
 * The focused element, followed into cross-origin frames: `DEEP_ACTIVE_ELEMENT` stops at an
 * `<iframe>` it cannot look into; when that iframe hosts a frame target, look there.
 */
export async function focusedAcrossFrames(call: PageCall, deepActiveElement: string): Promise<{ at: PageCall; objectId: string } | undefined> {
  let at = call.top;
  for (let depth = 0; depth < 10; depth++) {
    const handle = await at.evaluateHandle(deepActiveElement);
    if (!handle.objectId || handle.subtype === 'null') return undefined;
    const access = await at.callOn<boolean | null>(handle.objectId, FRAME_ACCESS);
    if (access !== false) return { at, objectId: handle.objectId };
    const frame = await frameOfOwner(at, handle.objectId);
    if (!frame) return { at, objectId: handle.objectId };
    at = call.at(frame);
  }
  return undefined;
}
