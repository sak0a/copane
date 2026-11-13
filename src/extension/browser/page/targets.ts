// Resolving what the agent points at (a snapshot ref, a CSS selector, or viewport coordinates) to a
// live element, and waiting until that element can take real input: attached, visible, enabled,
// scrolled into view, not moving, and not covered by something else.
import { ToolError } from '../../core/errors';
import { ObjectArg, type PageCall } from './call';
import { DialogInterrupt } from './pageState';
import { clip } from './ringBuffer';
import { normalizeRef } from './refs';
import { CONTAINS, DESCRIBE, INSPECT_ELEMENT, QUERY_SELECTOR, SCROLL_INTO_VIEW } from './scripts';

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
  let objectId: string;
  try {
    objectId = await call.resolve(entry.backendNodeId);
  } catch (err) {
    if (err instanceof DialogInterrupt || err instanceof ToolError) throw err;
    throw new ToolError('not_found', `Ref ${ref} (${was}) no longer exists: the page changed since your snapshot. Take a new snapshot.`);
  }
  const connected = await call.callOn<boolean>(objectId, 'function () { return this.isConnected; }');
  if (!connected) {
    throw new ToolError('not_found', `Ref ${ref} (${was}) was removed from the page: it re-rendered since your snapshot. Take a new snapshot to get current refs.`);
  }
  const now = await call.describeAx(entry.backendNodeId);
  if (now && !now.ignored && (now.role !== entry.role || now.name !== entry.name)) {
    throw new ToolError(
      'not_found',
      `Ref ${ref} has changed: it was ${was} in your snapshot and is now ${describeEntry(now.role, now.name)}. The page changed underneath (re-render, list update); take a new snapshot instead of acting on it.`,
    );
  }
  return { kind: 'element', backendNodeId: entry.backendNodeId, objectId, label: `${was} [ref=${ref}]`, ref };
}

async function resolveSelector(call: PageCall, selector: string, waitMs: number): Promise<ElementTarget> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const handle = await call.evaluateHandle(QUERY_SELECTOR, [selector]);
    if (handle.subtype !== 'array') {
      const value = handle.value ?? (handle.objectId ? (await call.callOn(handle.objectId, 'function () { return this; }')) : undefined);
      throw new ToolError('invalid_input', `"${selector}" is not a valid CSS selector: ${value?.error ?? 'syntax error'}.`);
    }
    const { result } = await call.send('Runtime.getProperties', { objectId: handle.objectId, ownProperties: true });
    const first = result.find((p: any) => p.name === '0')?.value;
    const count = Number(result.find((p: any) => p.name === '1')?.value?.value ?? 0);
    if (first?.objectId) {
      const { node } = await call.send('DOM.describeNode', { objectId: first.objectId });
      const backendNodeId: number = node.backendNodeId;
      const objectId = await call.resolve(backendNodeId);
      const ax = await call.describeAx(backendNodeId);
      const what = ax && !ax.ignored && ax.role !== 'generic' ? describeEntry(ax.role, ax.name) : await call.callOn<string>(objectId, DESCRIBE);
      const extra = count > 1 ? `, first visible of ${count} matches` : '';
      return { kind: 'element', backendNodeId, objectId, label: `${what} (selector ${JSON.stringify(selector)}${extra})`, ref: undefined };
    }
    if (Date.now() >= deadline) {
      throw new ToolError('not_found', `No element matches the selector ${JSON.stringify(selector)} in ${call.tab.id} (waited ${Math.round(waitMs / 1000)} s). Check the page with browser_snapshot, or wait for it with browser_wait_for.`);
    }
    await call.sleep(150);
  }
}

export async function inspect(call: PageCall, target: ElementTarget): Promise<ElementInfo> {
  const info = await call.callOn<ElementInfo>(target.objectId, INSPECT_ELEMENT);
  if (!info.connected) throw new ToolError('not_found', `${target.label} was removed from the page. Take a new snapshot.`);
  return info;
}

export async function scrollIntoView(call: PageCall, target: ElementTarget): Promise<void> {
  try {
    await call.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: target.backendNodeId });
  } catch (err) {
    if (err instanceof DialogInterrupt || err instanceof ToolError) throw err;
    await call.callOn(target.objectId, SCROLL_INTO_VIEW);
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

/** Bounding box of the element's visible boxes, in viewport CSS pixels. */
export async function elementBox(call: PageCall, backendNodeId: number): Promise<{ x: number; y: number; width: number; height: number } | undefined> {
  let quads: number[][];
  try {
    ({ quads } = await call.send('DOM.getContentQuads', { backendNodeId }));
  } catch (err) {
    if (err instanceof DialogInterrupt || err instanceof ToolError) throw err;
    return undefined;
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
): Promise<{ x: number; y: number; info: ElementInfo | undefined }> {
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
      const vp = await viewport(call);
      let quads: number[][] = [];
      try {
        ({ quads } = await call.send('DOM.getContentQuads', { backendNodeId: target.backendNodeId }));
      } catch (err) {
        if (err instanceof DialogInterrupt || err instanceof ToolError) throw err;
      }
      const point = clickablePoint(quads, vp.width, vp.height);
      if (!point) reason = 'has no visible area inside the viewport';
      else if (!last || Math.abs(last.x - point.x) > 1 || Math.abs(last.y - point.y) > 1) {
        // Not stable yet (or first look): look again shortly.
        last = point;
        reason = 'keeps moving (animation)';
        await call.sleep(50);
        if (Date.now() < deadline) continue;
      } else {
        const hit = await hitTest(call, target, point, info);
        if (hit === true) return { ...point, info };
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
