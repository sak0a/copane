// Resolving what the agent points at (a snapshot ref, a CSS selector, or viewport coordinates) to a
// live element, and waiting until that element can take real input: attached, visible, enabled,
// scrolled into view, not moving, and not covered by something else.
import { ToolError } from '../../core/errors';
import { ObjectArg, type PageCall } from './call';
import { insideQuad, quadToTop } from './frameGeometry';
import { querySelectorAcrossFrames } from './frameQuery';
import { frameLabel, frameLevels, framesReachable, frameViewport, hitInFrame, mapOut, scrollFramesTo } from './frameTargets';
import { DialogInterrupt } from './pageState';
import { clip } from './ringBuffer';
import { normalizeRef } from './refs';
import { CONTAINS, DESCRIBE, INSPECT_ELEMENT, SCROLL_INTO_VIEW } from './scripts';

export interface TargetArgs {
  ref?: string;
  selector?: string;
  x?: number;
  y?: number;
}

export interface ElementTarget {
  kind: 'element';
  backendNodeId: number;
  /** Handle in the page's own world of the element's frame. */
  objectId: string;
  /** e.g. 'button "Save" [ref=e5]' */
  label: string;
  ref: string | undefined;
  /**
   * The call to use for anything addressing this element (its objectId, backendNodeId): the tool's
   * call, or that call scoped to the cross-origin frame the element lives in (`call.frame`).
   */
  call: PageCall;
}
export interface PointTarget {
  kind: 'point';
  x: number;
  y: number;
  label: string;
}
export type Target = ElementTarget | PointTarget;

export interface ElementInfo {
  connected: boolean;
  visible: boolean;
  disabled: boolean;
  readonly: boolean;
  tag: string;
  type: string | undefined;
  kind: 'text' | 'value' | 'checkbox' | 'radio' | 'file' | 'button' | 'select' | 'contenteditable' | 'other';
  checked: boolean | undefined;
  multiple: boolean;
  isFrame: boolean;
  hasFileInput: boolean;
}

export const DEFAULT_ACTION_TIMEOUT_MS = 5000;

function describeEntry(role: string, name: string): string {
  return name ? `${role} "${clip(name, 80)}"` : role;
}

/**
 * Resolves the target arguments. Returns undefined when none were given. `allowPoint` permits x/y.
 * Selectors are retried until `waitMs` so an element that is about to appear is found.
 */
export async function resolveTarget(call: PageCall, args: TargetArgs, options: { allowPoint?: boolean; waitMs?: number; prefix?: string } = {}): Promise<Target | undefined> {
  const p = options.prefix ?? '';
  const given = [args.ref !== undefined, args.selector !== undefined, args.x !== undefined || args.y !== undefined].filter(Boolean).length;
  if (given === 0) return undefined;
  if (given > 1) throw new ToolError('invalid_input', `Pass only one of ${p}ref, ${p}selector${options.allowPoint ? ` or ${p}x/${p}y` : ''}.`);

  if (args.x !== undefined || args.y !== undefined) {
    if (!options.allowPoint) throw new ToolError('invalid_input', 'This tool needs an element (ref or selector), not coordinates.');
    if (args.x === undefined || args.y === undefined) throw new ToolError('invalid_input', `Pass both ${p}x and ${p}y.`);
    return { kind: 'point', x: args.x, y: args.y, label: `the point (${Math.round(args.x)}, ${Math.round(args.y)})` };
  }

  if (args.ref !== undefined) return resolveRef(call, args.ref);
  return resolveSelector(call, args.selector!, options.waitMs ?? DEFAULT_ACTION_TIMEOUT_MS);
}

async function resolveRef(call: PageCall, rawRef: string): Promise<ElementTarget> {
  const ref = normalizeRef(rawRef);
  const entry = call.refs.get(ref);
  if (!entry) {
    throw new ToolError('invalid_input', `There is no ref "${rawRef}" for ${call.tab.id}. Refs come from your own browser_snapshot of this tab; take a snapshot first.`);
  }
  const was = describeEntry(entry.role, entry.name);
  if (entry.loaderId !== call.state.loaderId) {
    throw new ToolError('not_found', `Ref ${ref} (${was}) belongs to a page that is gone: ${call.tab.id} has navigated since your snapshot (now ${clip(call.state.url, 200)}). Take a new snapshot.`);
  }
  let at = call;
  if (entry.frame) {
    // A node in a cross-origin frame: that frame target must still show the same document.
    const frame = call.state.frames.get(entry.frame);
    if (!frame || frame.session.closed) {
      throw new ToolError('not_found', `Ref ${ref} (${was}) was inside a frame that is gone (it was removed, reloaded or navigated to this page's own site). Take a new snapshot.`);
    }
    if (frame.loaderId !== entry.frameLoaderId) {
      throw new ToolError('not_found', `Ref ${ref} (${was}) belongs to a document that is gone: ${frameLabel(frame)} has navigated since your snapshot. Take a new snapshot.`);
    }
    at = call.at(frame);
  }
  let objectId: string;
  try {
    objectId = await at.resolve(entry.backendNodeId);
  } catch (err) {
    if (err instanceof DialogInterrupt || err instanceof ToolError) throw err;
    throw new ToolError('not_found', `Ref ${ref} (${was}) no longer exists: the page changed since your snapshot. Take a new snapshot.`);
  }
  const connected = await at.callOn<boolean>(objectId, 'function () { return this.isConnected; }');
  if (!connected) {
    throw new ToolError('not_found', `Ref ${ref} (${was}) was removed from the page: it re-rendered since your snapshot. Take a new snapshot to get current refs.`);
  }
  const now = await at.describeAx(entry.backendNodeId);
  if (now && !now.ignored && (now.role !== entry.role || now.name !== entry.name)) {
    throw new ToolError(
      'not_found',
      `Ref ${ref} has changed: it was ${was} in your snapshot and is now ${describeEntry(now.role, now.name)}. The page changed underneath (re-render, list update); take a new snapshot instead of acting on it.`,
    );
  }
  return { kind: 'element', backendNodeId: entry.backendNodeId, objectId, label: `${was} [ref=${ref}]`, ref, call: at };
}

async function resolveSelector(call: PageCall, selector: string, waitMs: number): Promise<ElementTarget> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const found = await querySelectorAcrossFrames(call, selector);
    if ('error' in found) {
      const part = found.part !== selector ? ` (in "${found.part}")` : '';
      throw new ToolError('invalid_input', `"${selector}" is not a valid CSS selector${part}: ${found.error}.`);
    }
    if ('element' in found && found.element) {
      const at = found.at;
      const { node } = await at.send('DOM.describeNode', { objectId: found.element.objectId });
      const backendNodeId: number = node.backendNodeId;
      const objectId = await at.resolve(backendNodeId);
      const ax = await at.describeAx(backendNodeId);
      const what = ax && !ax.ignored && ax.role !== 'generic' ? describeEntry(ax.role, ax.name) : await at.callOn<string>(objectId, DESCRIBE);
      const extra = found.count > 1 ? `, first visible of ${found.count} matches` : '';
      const where = at.frame ? ` in ${frameLabel(at.frame)}` : '';
      return { kind: 'element', backendNodeId, objectId, label: `${what} (selector ${JSON.stringify(selector)}${extra}${where})`, ref: undefined, call: at };
    }
    if (Date.now() >= deadline) {
      const why = 'missing' in found ? ` (${found.missing})` : '';
      throw new ToolError('not_found', `No element matches the selector ${JSON.stringify(selector)} in ${call.tab.id}${why} (waited ${Math.round(waitMs / 1000)} s). Check the page with browser_snapshot, or wait for it with browser_wait_for.`);
    }
    await call.sleep(150);
  }
}

export async function inspect(_call: PageCall, target: ElementTarget): Promise<ElementInfo> {
  const info = await target.call.callOn<ElementInfo>(target.objectId, INSPECT_ELEMENT);
  if (!info.connected) throw new ToolError('not_found', `${target.label} was removed from the page. Take a new snapshot.`);
  return info;
}

export async function scrollIntoView(_call: PageCall, target: ElementTarget): Promise<void> {
  const at = target.call;
  try {
    await at.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: target.backendNodeId });
  } catch (err) {
    if (err instanceof DialogInterrupt || err instanceof ToolError) throw err;
    await at.callOn(target.objectId, SCROLL_INTO_VIEW);
  }
  // In a cross-origin frame: bring the element's part of each enclosing iframe into view too.
  if (at.frame) {
    const box = await elementBox(at, target.backendNodeId, { local: true });
    if (box) await scrollFramesTo(at, at.frame, box);
  }
}

export interface Viewport {
  width: number;
  height: number;
  pageX: number;
  pageY: number;
  dpr: number;
  contentWidth: number;
  contentHeight: number;
}

export async function viewport(call: PageCall): Promise<Viewport> {
  const m = await call.send('Page.getLayoutMetrics');
  const css = m.cssVisualViewport ?? m.cssLayoutViewport;
  const dev = m.visualViewport ?? m.layoutViewport;
  return {
    width: css.clientWidth,
    height: css.clientHeight,
    pageX: css.pageX ?? 0,
    pageY: css.pageY ?? 0,
    dpr: dev && css.clientWidth ? dev.clientWidth / css.clientWidth : 1,
    contentWidth: (m.cssContentSize ?? m.contentSize).width,
    contentHeight: (m.cssContentSize ?? m.contentSize).height,
  };
}

/**
 * Bounding box of the element's visible boxes, in top-level viewport CSS pixels (mapped out of the
 * frame when `call` is scoped to a cross-origin frame; `local` keeps the frame's own coordinates).
 */
export async function elementBox(call: PageCall, backendNodeId: number, options: { local?: boolean } = {}): Promise<{ x: number; y: number; width: number; height: number } | undefined> {
  let quads: number[][];
  try {
    ({ quads } = await call.send('DOM.getContentQuads', { backendNodeId }));
  } catch (err) {
    if (err instanceof DialogInterrupt || err instanceof ToolError) throw err;
    return undefined;
  }
  if (call.frame && !options.local) {
    const placements = (await frameLevels(call, call.frame)).map(l => l.placement);
    quads = quads.map(q => quadToTop(q, placements));
  }
  const xs = quads.flatMap(q => [q[0]!, q[2]!, q[4]!, q[6]!]);
  const ys = quads.flatMap(q => [q[1]!, q[3]!, q[5]!, q[7]!]);
  if (xs.length === 0) return undefined;
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** The point to click: the centre of the element's largest box, clipped to the viewport. */
export function clickablePoint(quads: number[][], vw: number, vh: number): { x: number; y: number } | undefined {
  let best: { x: number; y: number; area: number } | undefined;
  for (const q of quads) {
    const xs = [q[0]!, q[2]!, q[4]!, q[6]!];
    const ys = [q[1]!, q[3]!, q[5]!, q[7]!];
    const left = Math.max(0, Math.min(...xs));
    const right = Math.min(vw, Math.max(...xs));
    const top = Math.max(0, Math.min(...ys));
    const bottom = Math.min(vh, Math.max(...ys));
    const area = (right - left) * (bottom - top);
    if (right - left < 1 || bottom - top < 1) continue;
    if (!best || area > best.area) best = { x: (left + right) / 2, y: (top + bottom) / 2, area };
  }
  return best && { x: best.x, y: best.y };
}

/**
 * Waits until the target can take a real mouse event and returns the viewport point to use.
 * Throws a ToolError naming the reason (hidden, disabled, covered by ...) after `timeoutMs`.
 */
export async function actionPoint(
  call: PageCall,
  target: Target,
  options: { verb: string; enabled?: boolean; editable?: boolean; timeoutMs?: number },
): Promise<{ x: number; y: number; info: ElementInfo | undefined; local?: { x: number; y: number }; approach?: { x: number; y: number } }> {
  if (target.kind === 'point') return { x: target.x, y: target.y, info: undefined };
  const timeoutMs = options.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let last: { x: number; y: number } | undefined;
  let reason = 'is not ready';
  for (;;) {
    const info = await inspect(call, target);
    if (!info.visible) reason = 'is not visible';
    else if (options.enabled && info.disabled) reason = 'is disabled';
    else if (options.editable && info.readonly) reason = 'is read-only';
    else {
      await scrollIntoView(call, target);
      const at = target.call;
      // Inside a cross-origin frame: find the point in the frame's own viewport, then map it out.
      const vp = at.frame ? await frameViewport(at) : await viewport(call);
      let quads: number[][] = [];
      try {
        ({ quads } = await at.send('DOM.getContentQuads', { backendNodeId: target.backendNodeId }));
      } catch (err) {
        if (err instanceof DialogInterrupt || err instanceof ToolError) throw err;
      }
      const local = clickablePoint(quads, vp.width, vp.height);
      const levels = at.frame && local ? await frameLevels(call, at.frame) : [];
      const point = local && (levels.length ? mapOut(local, levels) : local);
      if (!point) reason = 'has no visible area inside the viewport';
      else if (!last || Math.abs(last.x - point.x) > 1 || Math.abs(last.y - point.y) > 1) {
        // Not stable yet (or first look): look again shortly.
        last = point;
        reason = 'keeps moving (animation)';
        await call.sleep(50);
        if (Date.now() < deadline) continue;
      } else {
        // In a cross-origin frame, DOM.getNodeForLocation can miss same-origin child frames whose rendering
        // is throttled (off-screen, background tab); the frame's own elementFromPoint does not.
        let hit = at.frame ? await hitInFrame(at, target.objectId, local!) : await hitTest(at, target, local!, info);
        if (hit === true && levels.length) hit = await framesReachable(call, levels, local!);
        if (hit === true) {
          const top = await viewport(call);
          if (point.x >= 0 && point.y >= 0 && point.x <= top.width && point.y <= top.height) {
            if (!at.frame) return { ...point, info };
            return { ...point, info, local: local!, approach: approachPoint(quads, vp, levels) };
          }
          hit = `the edge of the window (the frame's part with it is outside the viewport)`;
        }
        reason = `is covered by ${hit}`;
      }
    }
    if (reason === 'is read-only' || Date.now() >= deadline) {
      const hint =
        reason.startsWith('is covered') ? ' Close or dismiss what covers it first (a dialog, banner or overlay), or wait for it to go away.'
        : reason === 'is disabled' ? ' Something on the page has to enable it first (e.g. filling required fields).'
        : reason === 'is not visible' ? ' It may be in a collapsed menu, another tab panel or off-screen behind a toggle; open that first.'
        : '';
      const waited = reason === 'is read-only' ? '' : ` (waited ${Math.round(timeoutMs / 1000)} s)`;
      throw new ToolError(reason === 'is read-only' ? 'failed' : 'timeout', `Could not ${options.verb} ${target.label}: it ${reason}${waited}.${hint}`);
    }
    await call.sleep(100);
  }
}

/**
 * A point inside the element's frame but off the element. A cross-origin frame is not told when the
 * mouse leaves it for the parent page, so it would not fire mouseenter/mouseover again on an element
 * it still thinks is hovered; moving through this point first makes the frame see the pointer arrive.
 */
function approachPoint(quads: number[][], vp: { width: number; height: number }, levels: Parameters<typeof mapOut>[1]): { x: number; y: number } | undefined {
  const corners = [{ x: 1, y: 1 }, { x: vp.width - 2, y: vp.height - 2 }, { x: vp.width - 2, y: 1 }, { x: 1, y: vp.height - 2 }];
  const inside = (p: { x: number; y: number }) => quads.some(q => insideQuad(p, q));
  const corner = corners.find(c => c.x > 0 && c.y > 0 && !inside(c));
  return corner && mapOut(corner, levels);
}

/** True when a click at the point reaches the target; otherwise a description of what is on top. */
async function hitTest(call: PageCall, target: ElementTarget, point: { x: number; y: number }, info: ElementInfo): Promise<true | string> {
  let hit: { backendNodeId: number; frameId?: string };
  try {
    hit = await call.send('DOM.getNodeForLocation', { x: Math.round(point.x), y: Math.round(point.y), includeUserAgentShadowDOM: false, ignorePointerEventsNone: false });
  } catch (err) {
    if (err instanceof DialogInterrupt || err instanceof ToolError) throw err;
    return true; // Cannot tell; let the click go ahead.
  }
  if (hit.backendNodeId === target.backendNodeId) return true;
  let hitObject: string;
  try {
    hitObject = await call.resolve(hit.backendNodeId);
  } catch (err) {
    if (err instanceof DialogInterrupt || err instanceof ToolError) throw err;
    return true;
  }
  try {
    if (await call.callOn<boolean>(target.objectId, CONTAINS, [new ObjectArg(hitObject)])) return true;
  } catch (err) {
    if (err instanceof DialogInterrupt || err instanceof ToolError) throw err;
    // Different frames: the target is a frame and the point lands inside it, or a frame covers it.
    if (info.isFrame) return true;
  }
  try {
    return await call.callOn<string>(hitObject, DESCRIBE);
  } catch (err) {
    if (err instanceof DialogInterrupt || err instanceof ToolError) throw err;
    return 'another element';
  }
}
