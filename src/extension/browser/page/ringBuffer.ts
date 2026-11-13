// A bounded, append-only log. Entries carry a monotonically increasing `seq`, so readers can ask for
// "everything after the last entry I saw" even after old entries were dropped.

export interface Sequenced {
  seq: number;
}

export class RingBuffer<T extends Sequenced> {
  private items: T[] = [];
  /** How many entries were dropped because the buffer was full. */
  dropped = 0;

  constructor(readonly capacity: number) {}

  push(item: T): void {
    this.items.push(item);
    // Trim in batches so pushing stays cheap.
    if (this.items.length > this.capacity + Math.max(1, Math.floor(this.capacity / 4))) this.trim();
  }

  /** Entries in order, oldest first, at most `capacity` of them. */
  all(): T[] {
    this.trim();
    return [...this.items];
  }

  /** Entries with `seq` greater than `seq`. */
  after(seq: number): T[] {
    return this.all().filter(i => i.seq > seq);
  }

  last(): T | undefined {
    return this.items[this.items.length - 1];
  }

  get size(): number {
    return Math.min(this.items.length, this.capacity);
  }

  clear(): void {
    this.items = [];
  }

  private trim(): void {
    const excess = this.items.length - this.capacity;
    if (excess > 0) {
      this.items.splice(0, excess);
      this.dropped += excess;
    }
  }
}

/** Cuts `value` to `max` characters, marking the cut. */
export function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

/** Collapses runs of whitespace to one space and trims. */
export function squash(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** "1.2 kB", "340 B", "3.4 MB". */
export function formatBytes(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return '?';
  if (n < 1000) return `${Math.round(n)} B`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)} kB`;
  return `${(n / 1_000_000).toFixed(1)} MB`;
}

/** "340 ms", "2.1 s". */
export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}
