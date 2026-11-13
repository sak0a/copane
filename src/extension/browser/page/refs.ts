// Element refs ("e12") handed out by snapshots. One table per (agent session, tab), so two sessions
// sharing a tab never resolve each other's refs. A ref stays bound to one DOM node and remembers what
// that node was (role and name) and which document it lived in, so a ref used after the page changed
// fails instead of acting on whatever is there now. Ref numbers are never reused within a table.

export interface RefEntry {
  ref: string;
  backendNodeId: number;
  frameId: string;
  /** Main-frame loader id at the time: a different one means the page navigated since. */
  loaderId: string | undefined;
  role: string;
  name: string;
  /** Set for a node in a cross-origin frame: the frame target (frames.ts) whose session owns `backendNodeId`. */
  frame?: string;
  /** That frame's loader id at the time: a different one means the frame navigated since. */
  frameLoaderId?: string;
}

/** What a snapshot knows about a node it hands out a ref for. */
export type RefNode = { backendNodeId: number; frameId: string; role: string; name: string; frame?: string; frameLoaderId?: string };

/** Backend node ids are per target: a node is identified by its frame target and its id. */
const nodeKey = (node: { backendNodeId: number; frame?: string }) => (node.frame ? `${node.frame}#${node.backendNodeId}` : node.backendNodeId);

export class RefTable {
  private readonly byRef = new Map<string, RefEntry>();
  private readonly byNode = new Map<number | string, RefEntry>();
  private counter = 0;

  /** The ref for a node, reusing the existing one while the node stays in the same document. */
  assign(node: RefNode, loaderId: string | undefined): string {
    const existing = this.byNode.get(nodeKey(node));
    if (existing && existing.loaderId === loaderId && existing.frameLoaderId === node.frameLoaderId) {
      existing.role = node.role;
      existing.name = node.name;
      existing.frameId = node.frameId;
      return existing.ref;
    }
    const entry: RefEntry = { ref: `e${++this.counter}`, backendNodeId: node.backendNodeId, frameId: node.frameId, loaderId, role: node.role, name: node.name };
    if (node.frame) Object.assign(entry, { frame: node.frame, frameLoaderId: node.frameLoaderId });
    this.byRef.set(entry.ref, entry);
    this.byNode.set(nodeKey(node), entry);
    this.trim();
    return entry.ref;
  }

  get(ref: string): RefEntry | undefined {
    return this.byRef.get(normalizeRef(ref));
  }

  /** Records what a node is now, after an action of this session changed it (e.g. a counter button). */
  update(ref: string, role: string, name: string): void {
    const entry = this.byRef.get(ref);
    if (entry) {
      entry.role = role;
      entry.name = name;
    }
  }

  get size(): number {
    return this.byRef.size;
  }

  /** Keeps memory bounded on long sessions: drops the oldest refs beyond 20000. */
  private trim(): void {
    if (this.byRef.size <= 20_000) return;
    for (const [ref, entry] of this.byRef) {
      this.byRef.delete(ref);
      if (this.byNode.get(nodeKey(entry)) === entry) this.byNode.delete(nodeKey(entry));
      if (this.byRef.size <= 15_000) break;
    }
  }
}

/** Accepts "e12", "[ref=e12]", "ref=e12". */
export function normalizeRef(ref: string): string {
  const m = /e\d+/.exec(ref.trim());
  return m ? m[0] : ref.trim();
}

export class RefStore {
  private readonly tables = new Map<string, RefTable>();

  table(sessionId: string, tabId: string): RefTable {
    const key = `${sessionId}\u0000${tabId}`;
    let t = this.tables.get(key);
    if (!t) this.tables.set(key, (t = new RefTable()));
    return t;
  }

  dropSession(sessionId: string): void {
    for (const key of [...this.tables.keys()]) if (key.startsWith(`${sessionId}\u0000`)) this.tables.delete(key);
  }

  dropTab(tabId: string): void {
    for (const key of [...this.tables.keys()]) if (key.endsWith(`\u0000${tabId}`)) this.tables.delete(key);
  }
}
