// One Copane session per chat conversation of a client that runs one MCP server process for many
// conversations. VS Code's own MCP client (chat and agent mode) starts one process per window and uses
// it for every chat there; it names the chat in each `tools/call` as `_meta["vscode.conversationId"]`
// (src/vs/workbench/contrib/mcp/common/mcpServer.ts in microsoft/vscode). The bridge protocol has one
// session per connection (`hello` is accepted once), so each conversation gets its own BridgeClient,
// with its own connection, session key, window choice and reconnect logic. Calls without the key keep
// using the process's default BridgeClient, so clients that never send it see no difference.
//
// Conversations end without notice, so at most `max` are kept and one unused for `idleMs` is closed.
// Closing is what an agent process exiting does: the window keeps the session for its grace period,
// then ends it (its terminals stay, owned by its key). A conversation that comes back reconnects with
// the same key and resumes the session, or gets its identity back if it already ended.
import { createHash } from 'node:crypto';
import type { BridgeClient } from './bridgeClient';

/** The `_meta` key in which VS Code names the chat conversation of a tool call. */
export const CONVERSATION_META_KEY = 'vscode.conversationId';

/** The conversation id of a `tools/call`, when the client sent a usable one. */
export function conversationIdOf(meta: unknown): string | undefined {
  if (!meta || typeof meta !== 'object') return undefined;
  const id = (meta as Record<string, unknown>)[CONVERSATION_META_KEY];
  return typeof id === 'string' && id.trim() && id.length <= 4096 ? id : undefined;
}

/**
 * Session key of a conversation: stable across MCP server restarts (a window reload restarts the
 * process, the chat keeps its id), namespaced so it cannot be another agent's key, and hashed so the
 * id is not stored in the window's session memory. Under an explicit `COPANE_SESSION` it is namespaced
 * below that key.
 */
export function conversationSessionKey(conversationId: string, explicitKey?: string): string {
  const hash = createHash('sha256').update(conversationId).digest('hex').slice(0, 32);
  return `${explicitKey ? `${explicitKey}/` : ''}vscode-chat:${hash}`;
}

export interface ConversationBridgesOptions {
  /** Makes the client of one conversation; `window` is the window last chosen with window_select. */
  create(sessionKey: string, window: string | undefined): BridgeClient;
  /** `COPANE_SESSION`, when set. */
  explicitKey?: string;
  /** Most conversations connected at once; the least recently used one is closed beyond it. */
  max?: number;
  /** A conversation without a call for this long is closed. */
  idleMs?: number;
  /** How often idle conversations are looked for (also on every call). */
  sweepMs?: number;
  now?: () => number;
}

interface Entry {
  bridge: BridgeClient;
  lastUsed: number;
  /** Calls under way; a conversation is never closed in the middle of one. */
  busy: number;
}

export const DEFAULT_MAX_CONVERSATIONS = 16;
export const DEFAULT_CONVERSATION_IDLE_MS = 30 * 60_000;

export class ConversationBridges {
  private readonly entries = new Map<string, Entry>();
  private readonly max: number;
  private readonly idleMs: number;
  private readonly sweepMs: number;
  private readonly now: () => number;
  private sweeper: NodeJS.Timeout | undefined;
  private disposed = false;
  /**
   * The window last chosen with window_select in this process. A conversation starts there; the
   * conversations already connected stay where they are, so one chat never moves another.
   */
  preferredWindow: string | undefined;

  constructor(private readonly options: ConversationBridgesOptions) {
    this.max = Math.max(1, options.max ?? DEFAULT_MAX_CONVERSATIONS);
    this.idleMs = options.idleMs ?? DEFAULT_CONVERSATION_IDLE_MS;
    this.sweepMs = options.sweepMs ?? Math.min(this.idleMs, 60_000);
    this.now = options.now ?? Date.now;
  }

  /** Number of conversations with a client. */
  get size(): number {
    return this.entries.size;
  }

  /** The client of a conversation, if it has one now (does not create or touch it). */
  peek(conversationId: string): BridgeClient | undefined {
    return this.entries.get(this.key(conversationId))?.bridge;
  }

  /** Runs `fn` with the conversation's client, creating it when needed. */
  async use<T>(conversationId: string, fn: (bridge: BridgeClient) => Promise<T>): Promise<T> {
    if (this.disposed) throw new Error('closed');
    const key = this.key(conversationId);
    let entry = this.entries.get(key);
    if (entry) {
      // Most recently used last, so the first entry is the least recently used one.
      this.entries.delete(key);
    } else {
      entry = { bridge: this.options.create(key, this.preferredWindow), lastUsed: 0, busy: 0 };
    }
    this.entries.set(key, entry);
    entry.lastUsed = this.now();
    entry.busy++;
    this.sweep();
    this.schedule();
    try {
      return await fn(entry.bridge);
    } finally {
      entry.busy--;
      entry.lastUsed = this.now();
    }
  }

  /** Closes idle conversations, then the least recently used ones beyond the limit. */
  sweep(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.busy === 0 && now - entry.lastUsed >= this.idleMs) this.close(key, entry);
    }
    let over = this.entries.size - this.max;
    for (const [key, entry] of this.entries) {
      if (over <= 0) break;
      if (entry.busy > 0) continue;
      this.close(key, entry);
      over--;
    }
    if (this.entries.size === 0) this.unschedule();
  }

  dispose(): void {
    this.disposed = true;
    this.unschedule();
    for (const [key, entry] of this.entries) this.close(key, entry);
  }

  private key(conversationId: string): string {
    return conversationSessionKey(conversationId, this.options.explicitKey);
  }

  private close(key: string, entry: Entry): void {
    this.entries.delete(key);
    entry.bridge.dispose();
  }

  /** Never keeps the process alive. */
  private schedule(): void {
    if (this.sweeper || this.disposed) return;
    this.sweeper = setInterval(() => this.sweep(), this.sweepMs);
    this.sweeper.unref?.();
  }

  private unschedule(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = undefined;
  }
}
