// browser_audit type "accessibility": runs axe-core in the bridge's isolated world of each document
// of the page (or of the one holding the element to check), so the page never sees it, and turns its
// results into refs. axe-core ships as dist/axe.min.js (copied there by the build, see esbuild.mjs)
// and is read only when this check first runs, so it costs nothing at activation.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ToolError } from '../../core/errors';
import type { PageCall } from './call';
import { frameLabel } from './frameTargets';
import { DialogInterrupt } from './pageState';
import { clip } from './ringBuffer';
import { contrastDetail, formatA11y, type AxeNode, type AxeReview, type AxeRule } from './a11yReport';
import type { ElementTarget } from './targets';

let axeSource: string | undefined;

function loadAxe(extensionPath: string): string {
  if (axeSource) return axeSource;
  try {
    axeSource = readFileSync(join(extensionPath, 'dist', 'axe.min.js'), 'utf8');
  } catch {
    throw new ToolError('failed', 'The accessibility checker (dist/axe.min.js) is missing from this installation of the extension; reinstall it.');
  }
  return axeSource;
}

const HAS_AXE = `function () { return typeof window.axe === 'object' && window.axe ? window.axe.version : ''; }`;

/** Elements per rule turned into refs; the rest are only counted. */
const NODES_PER_RULE = 4;
const MAX_DOCUMENTS = 10;

/**
 * Runs axe on `this` (an element, isolated world) or the document. Keeps the failing elements in a
 * global of the isolated world (read back by index for refs) and returns a compact summary.
 */
const RUN_AXE = `async function (perRule) {
  const context = this && this.nodeType === 1 ? this : document;
  const result = await axe.run(context, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
    resultTypes: ['violations', 'incomplete'],
    rules: { 'frame-tested': { enabled: false }, region: { enabled: false } },
    iframes: false,
    elementRef: true,
  });
  const elements = [];
  const violations = result.violations.map(rule => {
    const first = rule.nodes[0];
    const check = first && (first.any[0] || first.all[0] || first.none[0]);
    return {
      id: rule.id, impact: rule.impact, help: rule.help, count: rule.nodes.length, message: check ? check.message : undefined, tags: rule.tags,
      nodes: rule.nodes.slice(0, perRule).map(n => {
        const c = n.any[0] || n.all[0] || n.none[0];
        elements.push(n.element || null);
        return { index: elements.length - 1, html: n.html, data: rule.id.startsWith('color-contrast') && c ? c.data : undefined };
      }),
    };
  });
  window.__copaneAxeElements = elements;
  return { version: axe.version, violations, incomplete: result.incomplete.map(r => ({ id: r.id, count: r.nodes.length, help: r.help })) };
}`;

interface RawResult {
  version: string;
  violations: Array<{ id: string; impact: AxeRule['impact']; help: string; count: number; message?: string; tags?: string[]; nodes: Array<{ index: number; html: string; data?: unknown }> }>;
  incomplete: AxeReview[];
}

/** One document to check: the call that reaches it, its frame id (undefined = that target's main frame), and a name for messages. */
interface Doc {
  at: PageCall;
  frameId: string | undefined;
  label: string | undefined;
  /** The element to check instead of the whole document (isolated-world handle). */
  root?: string;
}

async function contextId(at: PageCall, frameId: string | undefined): Promise<number> {
  return at.frame ? at.state.frames.isolatedWorld(at.frame, frameId) : at.state.isolatedWorld(frameId);
}

async function ensureAxe(doc: Doc, source: () => string): Promise<void> {
  const version = await doc.at.evaluate<string>(HAS_AXE, [], { frameId: doc.frameId, timeoutMs: 5000 });
  if (version) return;
  const id = await contextId(doc.at, doc.frameId);
  const r = await doc.at.send('Runtime.evaluate', { expression: source(), contextId: id, returnByValue: true }, { timeoutMs: 20_000 });
  if (r.exceptionDetails) throw new Error(`axe-core did not load: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
}

/** Documents of the whole page: the main document, same-process frames, and cross-origin frame targets with theirs. */
async function documentsOf(call: PageCall): Promise<Doc[]> {
  const docs: Doc[] = [{ at: call, frameId: undefined, label: undefined }];
  try {
    const { frameTree } = await call.send('Page.getFrameTree');
    const walk = (node: any) => {
      for (const child of node.childFrames ?? []) {
        const id: string = child.frame.id;
        if (!call.state.frames.targetOf(id)) docs.push({ at: call, frameId: id, label: `the frame ${clip(child.frame.url, 100)}` });
        walk(child);
      }
    };
    walk(frameTree);
  } catch (err) {
    if (err instanceof DialogInterrupt || err instanceof ToolError) throw err;
  }
  for (const frame of call.state.frames.list()) {
    if (frame.session.closed) continue;
    docs.push({ at: call.at(frame), frameId: undefined, label: frameLabel(frame) });
  }
  return docs;
}

/** The document holding the element, and the element as a handle in the bridge's isolated world there. */
async function documentOf(call: PageCall, target: ElementTarget): Promise<Doc> {
  const at = target.call;
  const entry = target.ref ? call.refs.get(target.ref) : undefined;
  const candidates = [entry?.frameId && !at.frame && entry.frameId !== call.state.mainFrameId ? entry.frameId : undefined, ...(at.frame ? [...at.frame.localFrames].filter(id => id !== at.frame!.id) : [])];
  for (const frameId of [undefined, ...candidates.filter(Boolean)] as Array<string | undefined>) {
    try {
      const { object } = await at.send('DOM.resolveNode', { backendNodeId: target.backendNodeId, executionContextId: await contextId(at, frameId) });
      if (object?.objectId) return { at, frameId, label: at.frame ? frameLabel(at.frame) : frameId ? 'a frame' : undefined, root: object.objectId };
    } catch (err) {
      if (err instanceof DialogInterrupt || (err instanceof ToolError && err.code === 'cancelled')) throw err;
    }
  }
  throw new ToolError('failed', `Could not check ${target.label}: its document could not be reached. Take a snapshot and pass the ref of a container instead.`);
}

/** Describes a failing element: its role and name with a ref, or its HTML when it is not in the accessibility tree. */
async function describeNode(call: PageCall, doc: Doc, index: number, html: string): Promise<string> {
  const fallback = clip(html.replace(/\s+/g, ' '), 90);
  try {
    const handle = await doc.at.evaluateHandle('function (i) { return (window.__copaneAxeElements || [])[i] || null; }', [index], { frameId: doc.frameId });
    if (!handle?.objectId) return fallback;
    const { node } = await doc.at.send('DOM.describeNode', { objectId: handle.objectId });
    const ax = await doc.at.describeAx(node.backendNodeId);
    const role = ax && !ax.ignored ? ax.role : 'generic';
    const name = ax && !ax.ignored ? ax.name : '';
    const frameId = doc.frameId ?? doc.at.frame?.id ?? call.state.mainFrameId ?? '';
    const ref = call.refs.assign(
      { backendNodeId: node.backendNodeId, frameId, role, name, ...(doc.at.frame ? { frame: doc.at.frame.id, frameLoaderId: doc.at.frame.loaderId } : {}) },
      call.state.loaderId,
    );
    const what = role !== 'generic' && role !== 'none' ? `${role}${name ? ` "${clip(name, 50)}"` : ''}` : fallback;
    return `${what} [ref=${ref}]`;
  } catch (err) {
    if (err instanceof DialogInterrupt || (err instanceof ToolError && err.code === 'cancelled')) throw err;
    return fallback;
  }
}

export async function accessibilityAudit(call: PageCall, root: ElementTarget | undefined, extensionPath: string): Promise<string> {
  const source = () => loadAxe(extensionPath);
  const all = root ? [await documentOf(call, root)] : await documentsOf(call);
  const docs = all.slice(0, MAX_DOCUMENTS);
  const violations: AxeRule[] = [];
  const incomplete = new Map<string, AxeReview>();
  const skipped: string[] = [];
  let version = '';
  let checked = 0;
  for (const doc of docs) {
    let raw: RawResult;
    try {
      await ensureAxe(doc, source);
      raw = doc.root
        ? await doc.at.callOn<RawResult>(doc.root, RUN_AXE, [NODES_PER_RULE], { timeoutMs: 60_000 })
        : await doc.at.evaluate<RawResult>(RUN_AXE, [NODES_PER_RULE], { frameId: doc.frameId, timeoutMs: 60_000 });
    } catch (err) {
      if (err instanceof DialogInterrupt || (err instanceof ToolError && (err.code === 'cancelled' || err.code === 'failed'))) throw err;
      if (doc === docs[0]) throw new ToolError('failed', `The accessibility check failed in ${call.tab.id}: ${err instanceof Error ? clip(err.message, 300) : String(err)}`);
      skipped.push(`${doc.label ?? 'a frame'} (${err instanceof Error ? clip(err.message, 120) : String(err)})`);
      continue;
    }
    checked++;
    version = raw.version;
    for (const v of raw.violations) {
      const nodes: AxeNode[] = [];
      for (const n of v.nodes) nodes.push({ label: await describeNode(call, doc, n.index, n.html), detail: contrastDetail(n.data) });
      violations.push({ id: v.id, impact: v.impact, help: v.help, count: v.count, nodes, message: v.message, frame: doc.label, tags: v.tags });
    }
    for (const i of raw.incomplete) {
      const known = incomplete.get(i.id);
      if (known) known.count += i.count;
      else incomplete.set(i.id, { ...i });
    }
  }
  if (all.length > docs.length) skipped.push(`${all.length - docs.length} more frames (only the first ${MAX_DOCUMENTS} documents are checked)`);
  return formatA11y({
    tabId: call.tab.id,
    scope: root ? `only ${root.label}` : 'whole page',
    version,
    frames: checked,
    violations,
    incomplete: [...incomplete.values()],
    skipped,
    brief: !call.env.notices.first(call.ctx.session.id, 'a11y-caveat'),
  });
}
