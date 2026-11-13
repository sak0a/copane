// Cross-origin frames in browser_snapshot. Each frame target has its own accessibility tree and its
// own backend node ids, which collide with the page's, so its nodes join the snapshot input with ids
// moved into a separate range per target (`k * 2^32 + id`); refs are handed out for the real id and
// target. Frames show up nested under their `<iframe>` element, like same-origin frames.
//
// Cost is bounded: a snapshot reads at most MAX_CROSS_ORIGIN_FRAMES frames (the largest first, visible
// ones before others of the same size), skips hidden and tiny ones, and gives up on frames that do not answer within the time
// budget. An iframe whose content was left out says why in its place, and a snapshot rooted at that
// iframe's ref (or anything inside it) reads it regardless of the limit.
import { ToolError } from '../../core/errors';
import type { PageCall } from './call';
import type { FrameTarget } from './frames';
import { ownerOf } from './frameTargets';
import { DialogInterrupt } from './pageState';
import type { RefNode } from './refs';
import type { AXNode } from './snapshot';
import type { DomFacts } from './snapshotTools';
import type { ElementTarget } from './targets';

export const MAX_CROSS_ORIGIN_FRAMES = 10;
const ID_RANGE = 2 ** 32;
const TIME_BUDGET_MS = 4000;
const TINY_PX = 4;

export interface CrossOriginFrames {
  /** How many cross-origin frames are in the snapshot, and how many were left out. */
  included: number;
  skipped: number;
  /** The ref-table node for a node of the snapshot (real backend id, frame target, its document). */
  refNode(node: { backendNodeId: number; frameId: string; role: string; name: string }): RefNode;
  /** The id `renderSnapshot` knows an element under, wherever it lives. */
  idOf(target: ElementTarget): number;
  /** Why an iframe's content is missing, for `renderSnapshot`'s `frameNote`. */
  note(frameId: string | undefined): string | undefined;
}

type Collect = (call: PageCall) => Promise<DomFacts | undefined>;

interface Candidate {
  frame: FrameTarget;
  ownerId: number;
  forced: boolean;
  visibleArea: number;
  area: number;
  /** The smaller side of the iframe, in CSS pixels (0 when unknown). */
  minSide: number;
  size: string;
}

/**
 * Adds the cross-origin frames below the frames already in `frames` (the page target's) to the
 * snapshot input, level by level. `collectFacts` is the snapshot's DOM-facts reader, run per target.
 */
export async function addCrossOriginFrames(call: PageCall, input: { frames: Map<string, AXNode[]>; facts: DomFacts; root?: ElementTarget; collectFacts: Collect; viewport: { width: number; height: number } }): Promise<CrossOriginFrames> {
  const registry = call.state.frames;
  const index = new Map<FrameTarget, number>();
  const byIndex: FrameTarget[] = [];
  const notes = new Map<string, string>();
  const keyOf = (frame: FrameTarget | undefined): number => {
    if (!frame) return 0;
    let k = index.get(frame);
    if (k === undefined) {
      byIndex.push(frame);
      index.set(frame, (k = byIndex.length));
    }
    return k;
  };
  const encode = (frame: FrameTarget | undefined, id: number) => (frame ? keyOf(frame) * ID_RANGE + id : id);
  let included = 0;
  let skipped = 0;

  const result: CrossOriginFrames = {
    get included() {
      return included;
    },
    get skipped() {
      return skipped;
    },
    refNode(node) {
      const k = Math.floor(node.backendNodeId / ID_RANGE);
      const frame = k > 0 ? byIndex[k - 1] : undefined;
      if (!frame) return node;
      return { ...node, backendNodeId: node.backendNodeId - k * ID_RANGE, frame: frame.id, frameLoaderId: frame.loaderId };
    },
    idOf(target) {
      return encode(target.call.frame, target.backendNodeId);
    },
    note(frameId) {
      if (frameId && notes.has(frameId)) return notes.get(frameId);
      if (!registry.supported) return undefined;
      return 'frame content not available (still loading, or it could not be read); take a new snapshot in a moment, or use browser_screenshot';
    },
  };
  if (!registry.supported || registry.size === 0) return result;
  await registry.whenReady(2000);

  // With a root, only frames on the way to it and frames inside it are read, whatever the limit:
  // `chain` = the root's frame and its ancestors, `inside` = frames whose iframe is within the root.
  const rootFrame = input.root?.call.frame;
  const chain = new Set<FrameTarget>(rootFrame ? registry.chain(rootFrame) : []);
  const inside = new Set<FrameTarget>();
  const deadline = Date.now() + TIME_BUDGET_MS;
  const processed = new Set<FrameTarget>();
  let budget = MAX_CROSS_ORIGIN_FRAMES;

  for (let depth = 0; depth < 10; depth++) {
    const level = registry.list().filter(f => !processed.has(f) && !f.session.closed && f.parentFrameId !== undefined && input.frames.has(f.parentFrameId));
    if (level.length === 0) break;
    for (const f of level) processed.add(f);

    // Where each frame's iframe is and whether it shows anything.
    const candidates = (
      await Promise.all(
        level.map(async (frame): Promise<Candidate | undefined> => {
          const parent = registry.parentOf(frame);
          let owner: number;
          try {
            owner = await ownerOf(call, frame);
          } catch (err) {
            rethrowHard(err);
            return undefined;
          }
          const ownerId = encode(parent, owner);
          input.facts.frameOwners.set(ownerId, frame.id);
          const parentNodes = input.frames.get(frame.parentFrameId!) ?? [];
          const ax = parentNodes.find(n => n.backendDOMNodeId === ownerId);
          if (!ax || ax.ignored) return undefined; // Not rendered in the snapshot (hidden).
          let isForced = false;
          if (input.root) {
            if ((parent && inside.has(parent)) || underRoot(parentNodes, ax, result.idOf(input.root))) inside.add(frame);
            isForced = chain.has(frame) || inside.has(frame);
            if (!isForced) return undefined; // Outside the part of the page asked for.
          }
          let width = 0;
          let height = 0;
          let visibleArea = 0;
          try {
            const { model } = await call.at(parent).send('DOM.getBoxModel', { backendNodeId: owner }, { timeoutMs: 3000 });
            width = model.width;
            height = model.height;
            if (!parent) {
              const q: number[] = model.border;
              const xs = [q[0]!, q[2]!, q[4]!, q[6]!];
              const ys = [q[1]!, q[3]!, q[5]!, q[7]!];
              const w = Math.min(input.viewport.width, Math.max(...xs)) - Math.max(0, Math.min(...xs));
              const h = Math.min(input.viewport.height, Math.max(...ys)) - Math.max(0, Math.min(...ys));
              visibleArea = w > 0 && h > 0 ? w * h : 0;
            }
          } catch (err) {
            rethrowHard(err);
          }
          return { frame, ownerId, forced: isForced, visibleArea, area: width * height, minSide: Math.min(width, height), size: `${Math.round(width)}×${Math.round(height)} px` };
        }),
      )
    ).filter((c): c is Candidate => c !== undefined);

    const chosen: Candidate[] = [];
    // Large frames carry the content (forms, dashboards); ads and widgets are small. Visible ones break ties.
    const ranked = [...candidates].sort((a, b) => Number(b.forced) - Number(a.forced) || b.area - a.area || b.visibleArea - a.visibleArea);
    for (const c of ranked) {
      const tiny = !c.forced && c.area > 0 && c.minSide < TINY_PX;
      if (tiny) {
        notes.set(c.frame.id, `frame not read: ${c.size}`);
        skipped++;
      } else if (c.forced || budget > 0) {
        chosen.push(c);
        if (!c.forced) budget--;
      } else {
        notes.set(c.frame.id, `frame not read (limit ${MAX_CROSS_ORIGIN_FRAMES} cross-origin frames); snapshot this ref to read it`);
        skipped++;
      }
    }

    await Promise.all(
      chosen.map(async c => {
        const remaining = deadline - Date.now();
        if (remaining <= 0 && !c.forced) {
          notes.set(c.frame.id, 'frame not read (time limit); snapshot this ref to read it');
          skipped++;
          return;
        }
        try {
          await readFrame(call, c.frame, input, encode, Math.max(remaining, 3000));
          included++;
        } catch (err) {
          if (err instanceof DialogInterrupt || (err instanceof ToolError && err.code === 'cancelled')) throw err;
          notes.set(c.frame.id, `frame could not be read (${err instanceof ToolError ? 'it went away or did not answer' : 'error'}); take a new snapshot, or use browser_screenshot`);
          skipped++;
        }
      }),
    );
  }
  return result;
}

/** Reads one frame target: its DOM facts and the accessibility trees of its frames, ids encoded. */
async function readFrame(
  call: PageCall,
  frame: FrameTarget,
  input: { frames: Map<string, AXNode[]>; facts: DomFacts; collectFacts: Collect },
  encode: (frame: FrameTarget | undefined, id: number) => number,
  timeoutMs: number,
): Promise<void> {
  const at = call.at(frame);
  const facts = await withTimeout(input.collectFacts(at), timeoutMs);
  const frameIds = [frame.id, ...[...new Set(facts?.frameOwners.values() ?? [])].filter(id => id !== frame.id)];
  const trees = await Promise.all(
    frameIds.map(async frameId => {
      try {
        const { nodes } = await at.send<{ nodes: AXNode[] }>('Accessibility.getFullAXTree', { frameId }, { timeoutMs });
        return [frameId, nodes] as const;
      } catch (err) {
        if (frameId === frame.id || err instanceof DialogInterrupt || (err instanceof ToolError && err.code === 'cancelled')) throw err;
        return undefined;
      }
    }),
  );
  for (const tree of trees) {
    if (!tree) continue;
    input.frames.set(
      tree[0],
      tree[1].map(n => (n.backendDOMNodeId === undefined ? n : { ...n, backendDOMNodeId: encode(frame, n.backendDOMNodeId) })),
    );
  }
  if (facts) {
    for (const id of facts.pointer) input.facts.pointer.add(encode(frame, id));
    for (const id of facts.hidden) input.facts.hidden.add(encode(frame, id));
    for (const [owner, frameId] of facts.frameOwners) input.facts.frameOwners.set(encode(frame, owner), frameId);
  }
}

/** Whether `node` (an AX node of one frame's tree) is the root element or inside it. */
function underRoot(nodes: AXNode[], node: AXNode, rootId: number): boolean {
  const byId = new Map(nodes.map(n => [n.nodeId, n]));
  for (let n: AXNode | undefined = node; n; n = n.parentId ? byId.get(n.parentId) : undefined) {
    if (n.backendDOMNodeId === rootId) return true;
  }
  return false;
}

function rethrowHard(err: unknown): void {
  if (err instanceof DialogInterrupt || (err instanceof ToolError && err.code === 'cancelled')) throw err;
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<undefined>(r => (timer = setTimeout(() => r(undefined), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}
