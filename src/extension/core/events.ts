// A tiny event emitter with the same listener shape as `vscode.Event`, but without a dependency on
// the `vscode` module, so core logic can be unit-tested in plain Node.
export interface Disposable {
  dispose(): void;
}

export type Event<T> = (listener: (e: T) => void) => Disposable;

export class Emitter<T> {
  private readonly listeners = new Set<(e: T) => void>();

  readonly event: Event<T> = listener => {
    this.listeners.add(listener);
    return { dispose: () => void this.listeners.delete(listener) };
  };

  fire(e: T): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(e);
      } catch {
        // One failing listener must not prevent the others from running.
      }
    }
  }

  dispose(): void {
    this.listeners.clear();
  }
}
