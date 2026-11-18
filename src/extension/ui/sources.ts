// Where the UI reads its data from, called defensively: the browser and terminal services are built
// by other modules and may be missing or throw (e.g. the browser API not enabled). In a dev host,
// fixture terminals (set by the `debug_ui_fixtures` tool) are merged in so every terminal state can be
// seen and tested before the real terminal service exists.
import { Emitter, type Disposable, type Event } from '../core/events';
import type { BridgeServices, BrowserTabInfo, TerminalInfo } from '../core/services';
import type { Logger } from '../core/log';

export class FixtureTerminals {
  private items: TerminalInfo[] = [];
  private readonly emitter = new Emitter<void>();
  readonly onDidChange: Event<void> = this.emitter.event;

  list(): TerminalInfo[] {
    return this.items;
  }

  has(id: string): boolean {
    return this.items.some(t => t.id === id);
  }

  set(items: TerminalInfo[]): void {
    this.items = items;
    this.emitter.fire();
  }

  /** Behaves like Ctrl+C on a running command. */
  interrupt(id: string): void {
    this.update(id, t => (t.state === 'running' || t.state === 'waiting-for-user' ? { ...t, state: 'idle', currentCommand: undefined, userInputRequest: undefined, lastExitCode: 130 } : t));
  }

  close(id: string): void {
    this.items = this.items.filter(t => t.id !== id);
    this.emitter.fire();
  }

  dispose(): void {
    this.emitter.dispose();
  }

  private update(id: string, fn: (t: TerminalInfo) => TerminalInfo): void {
    this.items = this.items.map(t => (t.id === id ? fn(t) : t));
    this.emitter.fire();
  }
}

/** Read and act on tabs and terminals without letting a failing service break the UI. */
export class UiSources {
  constructor(
    private readonly services: BridgeServices,
    private readonly log: Logger,
    readonly fixtures: FixtureTerminals | undefined,
  ) {}

  get browserAvailable(): boolean {
    try {
      return this.services.browser?.available === true;
    } catch {
      return false;
    }
  }

  tabs(): BrowserTabInfo[] {
    if (!this.browserAvailable) return [];
    return this.safe('list browser tabs', () => this.services.browser.listTabs(), []);
  }

  /** The login profile of each session's new tabs, where it is not the default store. */
  sessionProfiles(sessionIds: readonly string[]): Map<string, { label: string; setBy: 'user' | 'agent' | 'setting' }> {
    const out = new Map<string, { label: string; setBy: 'user' | 'agent' | 'setting' }>();
    if (!this.browserAvailable || !this.services.browser.sessionProfile) return out;
    for (const id of sessionIds) {
      const p = this.safe('read a session profile', () => this.services.browser.sessionProfile?.(id), undefined);
      if (p) out.set(id, { label: p.name === 'default' ? 'default store' : p.label, setBy: p.setBy });
    }
    return out;
  }

  /** The site icon VS Code shows for a tab (unchecked `data:` URI), if any. */
  tabIcon(tabId: string): string | undefined {
    if (!this.browserAvailable || !this.services.browser.tabIcon) return undefined;
    return this.safe('read a tab icon', () => this.services.browser.tabIcon?.(tabId), undefined);
  }

  terminals(): TerminalInfo[] {
    const real = this.safe('list terminals', () => this.services.terminals?.list() ?? [], []);
    return this.fixtures ? [...real, ...this.fixtures.list()] : real;
  }

  /** Subscribes to every source of change. */
  subscribe(listener: () => void): Disposable[] {
    const { services } = this;
    const subs: Disposable[] = [services.sessions.onDidChange(listener), services.tabLeases.onDidChange(listener)];
    const add = (what: string, event: Event<any> | undefined) => {
      if (!event) return;
      try {
        subs.push(event(listener));
      } catch (err) {
        this.log.warn(`UI: cannot watch ${what}: ${String(err)}`);
      }
    };
    add('browser tabs', services.browser?.onDidChange);
    add('terminals', services.terminals?.onDidChange);
    add('fixture terminals', this.fixtures?.onDidChange);
    return subs;
  }

  revealTerminal(id: string, preserveFocus: boolean): void {
    if (this.fixtures?.has(id)) return;
    this.services.terminals.reveal(id, { preserveFocus });
  }

  interruptTerminal(id: string): void {
    if (this.fixtures?.has(id)) return this.fixtures.interrupt(id);
    this.services.terminals.interrupt(id);
  }

  closeTerminal(id: string): void {
    if (this.fixtures?.has(id)) return this.fixtures.close(id);
    this.services.terminals.close(id);
  }

  private safe<T>(what: string, fn: () => T, fallback: T): T {
    try {
      return fn();
    } catch (err) {
      this.log.warn(`UI: could not ${what}: ${err instanceof Error ? err.message : String(err)}`);
      return fallback;
    }
  }
}
