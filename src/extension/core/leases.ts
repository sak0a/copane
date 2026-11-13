// Control leases: at most one agent session drives a resource (a browser tab, a terminal) at a time.
// A lease is taken implicitly by the first mutating action, renewed by every further action, and ends
// when it is released, when it has been idle for `idleMs`, or when its session goes away (the
// extension entry point wires up the last two). The user is
// never blocked by a lease; leases only arbitrate between agent sessions of this window.
import { Emitter, type Event } from './events';

export interface Lease {
  resourceId: string;
  sessionId: string;
  acquiredAt: number;
  lastUsedAt: number;
}

export type LeaseChange = { resourceId: string; lease: Lease | undefined; previous: Lease | undefined };

export type AcquireResult = { ok: true; lease: Lease } | { ok: false; heldBy: Lease };

export interface LeaseManagerOptions {
  /** A lease not used for this long can be taken by another session. Default 2 minutes. */
  idleMs?: () => number;
  now?: () => number;
}

export class LeaseManager {
  private readonly leases = new Map<string, Lease>();
  private readonly changeEmitter = new Emitter<LeaseChange>();
  private readonly idleMs: () => number;
  private readonly now: () => number;

  readonly onDidChange: Event<LeaseChange> = this.changeEmitter.event;

  constructor(options: LeaseManagerOptions = {}) {
    this.idleMs = options.idleMs ?? (() => 120_000);
    this.now = options.now ?? Date.now;
  }

  /** Takes or renews the lease. Fails when another session holds a lease that is not idle. */
  acquire(resourceId: string, sessionId: string, options: { force?: boolean } = {}): AcquireResult {
    const now = this.now();
    const current = this.leases.get(resourceId);
    if (current && current.sessionId === sessionId) {
      current.lastUsedAt = now;
      return { ok: true, lease: current };
    }
    if (current && !options.force && now - current.lastUsedAt < this.idleMs()) {
      return { ok: false, heldBy: current };
    }
    const lease: Lease = { resourceId, sessionId, acquiredAt: now, lastUsedAt: now };
    this.leases.set(resourceId, lease);
    this.changeEmitter.fire({ resourceId, lease, previous: current });
    return { ok: true, lease };
  }

  /** The current holder, or undefined when free. Idle leases are still reported until taken over. */
  holder(resourceId: string): Lease | undefined {
    return this.leases.get(resourceId);
  }

  isIdle(lease: Lease): boolean {
    return this.now() - lease.lastUsedAt >= this.idleMs();
  }

  /** Releases the lease. With `sessionId`, only if that session holds it. */
  release(resourceId: string, sessionId?: string): boolean {
    const current = this.leases.get(resourceId);
    if (!current || (sessionId !== undefined && current.sessionId !== sessionId)) return false;
    this.leases.delete(resourceId);
    this.changeEmitter.fire({ resourceId, lease: undefined, previous: current });
    return true;
  }

  releaseAllOf(sessionId: string): string[] {
    const released: string[] = [];
    for (const lease of [...this.leases.values()]) {
      if (lease.sessionId === sessionId && this.release(lease.resourceId)) released.push(lease.resourceId);
    }
    return released;
  }

  /** Releases every lease that has gone idle. Call periodically so markers do not outlive real use. */
  releaseIdle(): string[] {
    const released: string[] = [];
    for (const lease of [...this.leases.values()]) {
      if (this.isIdle(lease) && this.release(lease.resourceId)) released.push(lease.resourceId);
    }
    return released;
  }

  heldBy(sessionId: string): Lease[] {
    return [...this.leases.values()].filter(l => l.sessionId === sessionId);
  }

  dispose(): void {
    this.leases.clear();
    this.changeEmitter.dispose();
  }
}
