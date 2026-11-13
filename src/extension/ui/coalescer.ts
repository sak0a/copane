// Turns bursts of change events (a tab navigating fires several, a lease change fires through two
// services) into one update. At most one update per `delayMs`, always ending with the latest state.

export class Coalescer {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(
    private readonly flush: () => void,
    private readonly delayMs = 40,
  ) {}

  schedule(): void {
    if (this.timer !== undefined || this.disposed) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.disposed) this.flush();
    }, this.delayMs);
  }

  /** Runs a pending update now (e.g. before a command reads the model). */
  flushNow(): void {
    if (this.timer === undefined || this.disposed) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.flush();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
