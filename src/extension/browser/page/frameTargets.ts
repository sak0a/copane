// Acting on elements inside cross-origin frames. Input goes to the page target in top-level viewport
// coordinates (the browser routes it into the frame under the point, like a real mouse), so a point
// found in a frame's own coordinates is mapped out through each enclosing `<iframe>` (frameGeometry.ts),
// owners are scrolled into view level by level, and the hit test checks every level: the element at
// the point inside its frame, and the `<iframe>` element at the mapped point in each ancestor.
import { ToolError } from '../../core/errors';
import type { PageCall } from './call';
import { mouseMove } from './input';
import { insideQuad, toParent, type FramePlacement, type Point } from './frameGeometry';
import type { FrameTarget } from './frames';
import { DialogInterrupt } from './pageState';
import { clip } from './ringBuffer';

export interface FrameLevel {
  frame: FrameTarget;
  /** The call on the target that contains this frame's `<iframe>` element. */
  parent: PageCall;
  /** Backend node id of that `<iframe>` element in the parent's target. */
  owner: number;
  placement: FramePlacement;
  /** Border quad of the `<iframe>` element in the parent's viewport. */
  border: number[];
}

/** Size of a frame's viewport: `inner` with scrollbars (what its `<iframe>` content box shows), `client` without. */
const FRAME_SIZE = `function () {
  const vv = window.visualViewport;
  return [innerWidth, innerHeight, vv ? vv.width : document.documentElement.clientWidth, vv ? vv.height : document.documentElement.clientHeight];
}`;

/** A short name for a frame in messages: its URL without query. */
export function frameLabel(frame: FrameTarget): string {
  let url = frame.url;
  try {
    const u = new URL(frame.url);
    url = `${u.origin}${u.pathname}`;
  } catch {
    // keep as is
  }
  return `the frame ${clip(url || frame.id, 120)}`;
}

function rethrow(err: unknown): void {
  if (err instanceof DialogInterrupt || err instanceof ToolError) throw err;
}

/** The `<iframe>` element of a frame target, in its parent's target. */
export async function ownerOf(call: PageCall, frame: FrameTarget): Promise<number> {
  if (frame.ownerNode !== undefined) return frame.ownerNode;
  const parent = call.at(call.state.frames.parentOf(frame));
  try {
    const { backendNodeId } = await parent.send('DOM.getFrameOwner', { frameId: frame.id }, { timeoutMs: 5000 });
    frame.ownerNode = backendNodeId;
    return backendNodeId;
  } catch (err) {
    rethrow(err);
    throw new ToolError('not_found', `${frameLabel(frame)} is no longer on the page (its iframe was removed or the page changed). Take a new snapshot.`);
  }
}

/** Where `frame` and each enclosing frame sit, innermost first. */
export async function frameLevels(call: PageCall, frame: FrameTarget): Promise<FrameLevel[]> {
  const levels: FrameLevel[] = [];
  const frames = call.state.frames;
  for (let f: FrameTarget | undefined = frame; f; f = frames.parentOf(f)) {
    if (f.session.closed) throw new ToolError('not_found', `${frameLabel(f)} went away (it navigated or was removed). Take a new snapshot.`);
    const parent = call.at(frames.parentOf(f));
    const owner = await ownerOf(call, f);
    let model: { content: number[]; border: number[] };
    try {
      ({ model } = await parent.send('DOM.getBoxModel', { backendNodeId: owner }, { timeoutMs: 5000 }));
    } catch (err) {
      rethrow(err);
      throw new ToolError('failed', `${frameLabel(f)} is not displayed (its iframe has no box: hidden, collapsed or removed).`);
    }
    const [innerWidth, innerHeight] = await call.at(f).evaluate<number[]>(FRAME_SIZE, [], { timeoutMs: 5000 });
    levels.push({ frame: f, parent, owner, placement: { content: model.content, width: innerWidth!, height: innerHeight! }, border: model.border });
    if (levels.length > 20) break;
  }
  return levels;
}

/** The visible viewport size of a frame (without scrollbars), in its own CSS pixels. */
export async function frameViewport(call: PageCall): Promise<{ width: number; height: number }> {
  const [, , width, height] = await call.evaluate<number[]>(FRAME_SIZE, [], { timeoutMs: 5000 });
  return { width: width!, height: height! };
}

/** Maps a point in the frame's viewport to the top-level viewport. */
export function mapOut(point: Point, levels: FrameLevel[]): Point {
  return levels.reduce((p, level) => toParent(p, level.placement), point);
}

/**
 * Scrolls each enclosing `<iframe>` so that `rect` (in the frame's viewport) is visible in the parent,
 * level by level outwards. Best effort: the browser often does this itself already.
 */
export async function scrollFramesTo(call: PageCall, frame: FrameTarget, rect: { x: number; y: number; width: number; height: number }): Promise<void> {
  let levels: FrameLevel[];
  try {
    levels = await frameLevels(call, frame);
  } catch (err) {
    if (err instanceof DialogInterrupt || (err instanceof ToolError && err.code === 'cancelled')) throw err;
    return;
  }
  let r = rect;
  for (const level of levels) {
    const { placement, border } = level;
    // The rect relative to the iframe's border box, in the iframe element's own (untransformed) pixels.
    const scale = Math.hypot(placement.content[2]! - placement.content[0]!, placement.content[3]! - placement.content[1]!) / (placement.width || 1) || 1;
    const offsetX = Math.hypot(placement.content[0]! - border[0]!, 0) / scale;
    const offsetY = Math.hypot(0, placement.content[1]! - border[1]!) / scale;
    const local = { x: Math.max(0, r.x) + offsetX, y: Math.max(0, r.y) + offsetY, width: Math.max(1, Math.min(r.width, placement.width)), height: Math.max(1, Math.min(r.height, placement.height)) };
    try {
      await level.parent.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: level.owner, rect: local }, { timeoutMs: 5000 });
    } catch (err) {
      rethrow(err);
    }
    // Where the rect is in the parent now (re-measured: the scroll moved the iframe).
    try {
      const { model } = await level.parent.send('DOM.getBoxModel', { backendNodeId: level.owner }, { timeoutMs: 5000 });
      const moved = { ...placement, content: model.content };
      const a = toParent({ x: r.x, y: r.y }, moved);
      const b = toParent({ x: r.x + r.width, y: r.y + r.height }, moved);
      r = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
    } catch (err) {
      rethrow(err);
      return;
    }
  }
}

/**
 * Checks that a top-level click at `top` reaches into `frame`: in every ancestor the point lands on the
 * `<iframe>` element (inside its content box), not on something covering it. Returns true, or what covers it.
 */
export async function framesReachable(call: PageCall, levels: FrameLevel[], local: Point): Promise<true | string> {
  let point = local;
  for (const level of levels) {
    point = toParent(point, level.placement);
    if (!insideQuad(point, level.placement.content)) return `the edge of ${frameLabel(level.frame)} (the point is outside the visible part of the frame)`;
    let hit: { backendNodeId: number };
    try {
      hit = await level.parent.send('DOM.getNodeForLocation', { x: Math.round(point.x), y: Math.round(point.y), includeUserAgentShadowDOM: false, ignorePointerEventsNone: false });
    } catch (err) {
      rethrow(err);
      continue; // Cannot tell at this level.
    }
    if (hit.backendNodeId === level.owner) continue;
    try {
      const objectId = await level.parent.resolve(hit.backendNodeId);
      return await level.parent.callOn<string>(objectId, DESCRIBE_SHORT);
    } catch (err) {
      rethrow(err);
      return 'another element';
    }
  }
  return true;
}

const DESCRIBE_SHORT = `function () {
  const el = this.nodeType === 1 ? this : this.parentElement;
  if (!el) return String(this.nodeName);
  let s = '<' + el.tagName.toLowerCase();
  if (el.id) s += ' id="' + el.id + '"';
  s += '>';
  const text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
  return text ? s + ' ' + (text.length > 50 ? text.slice(0, 50) + '…' : text) : s;
}`;

/**
 * Isolated world of the frame target's root frame: remembers where the frame last saw the mouse, in
 * the root's viewport coordinates, also when it moved over a same-origin child document (capture
 * listeners on every reachable window, removed after 3 s or when read).
 */
const WATCH_MOUSE = `function () {
  const g = globalThis;
  if (g.__copaneMouseOff) g.__copaneMouseOff();
  g.__copaneMouse = null;
  const offs = [];
  const toRoot = (e) => {
    let x = e.clientX, y = e.clientY;
    for (let w = e.view; w && w !== window; w = w.parent) {
      const fe = w.frameElement;
      if (!fe) break;
      const r = fe.getBoundingClientRect();
      const s = fe.ownerDocument.defaultView.getComputedStyle(fe);
      x += r.left + parseFloat(s.borderLeftWidth) + parseFloat(s.paddingLeft);
      y += r.top + parseFloat(s.borderTopWidth) + parseFloat(s.paddingTop);
    }
    return [x, y];
  };
  const on = (e) => { g.__copaneMouse = toRoot(e); };
  const watch = (w, depth) => {
    try {
      w.addEventListener('mousemove', on, true);
      offs.push(() => w.removeEventListener('mousemove', on, true));
      if (depth < 5) for (const f of w.document.querySelectorAll('iframe, frame')) { try { if (f.contentDocument) watch(f.contentWindow, depth + 1); } catch {} }
    } catch {}
  };
  watch(window, 0);
  const timer = setTimeout(() => g.__copaneMouseOff && g.__copaneMouseOff(), 3000);
  g.__copaneMouseOff = () => { for (const off of offs) off(); clearTimeout(timer); g.__copaneMouseOff = null; };
}`;
const MOUSE_SEEN = `function () { const m = globalThis.__copaneMouse; if (globalThis.__copaneMouseOff) globalThis.__copaneMouseOff(); return m; }`;

/**
 * Moves the mouse onto a point inside a cross-origin frame and makes sure the frame got it. The browser
 * routes input into such frames by its own hit-test data, which lags a moment behind a scroll; an
 * event sent too early lands in whatever was at that point before. Moving through `approach` (off the
 * element, inside the frame) also makes the frame see the pointer arrive (see approachPoint).
 */
export async function pointerIntoFrame(call: PageCall, at: PageCall, point: { x: number; y: number; local?: { x: number; y: number }; approach?: { x: number; y: number } }, buttons = 0): Promise<void> {
  if (!at.frame || !point.local) return;
  const deadline = Date.now() + 2000;
  for (;;) {
    await at.evaluate(WATCH_MOUSE, [], { timeoutMs: 3000 });
    if (point.approach) await mouseMove(call, point.approach.x, point.approach.y, [], buttons);
    await mouseMove(call, point.x, point.y, [], buttons);
    const seen = await at.evaluate<[number, number] | null>(MOUSE_SEEN, [], { timeoutMs: 3000 });
    if (seen && Math.abs(seen[0] - point.local.x) <= 2 && Math.abs(seen[1] - point.local.y) <= 2) return;
    if (Date.now() >= deadline) {
      throw new ToolError('failed', `The mouse did not reach ${frameLabel(at.frame)}: the browser kept sending it elsewhere (the frame may be moving, or covered). Try again, or take a screenshot to see the page.`);
    }
    await call.sleep(100);
  }
}

/**
 * Element (this, inside a frame target). `(x, y)` in the frame target's viewport → true when a click
 * there reaches this element, else a short description of what is there. Starts at the frame target's
 * root document (the highest one this document can reach) and descends through same-origin iframes
 * and open shadow roots with elementFromPoint, which brings layout up to date first.
 */
const HIT_IN_FRAME = `function (x, y) {
  let doc = this.ownerDocument;
  try { while (doc.defaultView.frameElement) doc = doc.defaultView.frameElement.ownerDocument; } catch {}
  let px = x, py = y, hit = null;
  for (let depth = 0; depth < 10; depth++) {
    hit = doc.elementFromPoint(px, py);
    while (hit && hit.shadowRoot && hit.shadowRoot.elementFromPoint) {
      const inner = hit.shadowRoot.elementFromPoint(px, py);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    if (!hit || (hit.tagName !== 'IFRAME' && hit.tagName !== 'FRAME') || hit === this) break;
    let inner = null;
    try { inner = hit.contentDocument; } catch {}
    if (!inner) break;
    const r = hit.getBoundingClientRect();
    const s = hit.ownerDocument.defaultView.getComputedStyle(hit);
    px -= r.left + parseFloat(s.borderLeftWidth) + parseFloat(s.paddingLeft);
    py -= r.top + parseFloat(s.borderTopWidth) + parseFloat(s.paddingTop);
    doc = inner;
  }
  if (!hit) return 'nothing (the point is outside the frame\\'s document)';
  for (let n = hit; n; n = n.parentNode || n.host) if (n === this) return true;
  let s = '<' + hit.tagName.toLowerCase() + (hit.id ? ' id="' + hit.id + '"' : '') + '>';
  const text = (hit.innerText || hit.textContent || '').replace(/\\s+/g, ' ').trim();
  return text ? s + ' ' + (text.length > 50 ? text.slice(0, 50) + '…' : text) : s;
}`;

/** Hit test for an element inside a frame target, at a point in that target's viewport (see HIT_IN_FRAME). */
export async function hitInFrame(at: PageCall, objectId: string, local: Point): Promise<true | string> {
  try {
    return await at.callOn<true | string>(objectId, HIT_IN_FRAME, [local.x, local.y]);
  } catch (err) {
    rethrow(err);
    return true; // Cannot tell; let the click go ahead.
  }
}
