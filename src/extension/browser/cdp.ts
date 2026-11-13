// One CDP connection to the page target of an integrated-browser tab.
//
// `BrowserTab.startCDPSession()` hands out a session rooted at a browser target that only sees this
// tab. We attach to the browser target, find the page target and attach to it with a flattened
// session; all commands and events of `CdpPage` are scoped to that page session.
import type * as vscode from 'vscode';
import { ToolError } from '../core/errors';
import { Emitter, type Event } from '../core/events';
import type { CdpPage } from '../core/services';

interface PendingCommand {
  resolve(value: any): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class CdpConnection implements CdpPage {
  private nextId = 1;
  private pageSessionId: string | undefined;
  private isClosed = false;
  private readonly pending = new Map<number, PendingCommand>();
  private readonly listeners = new Map<string, Set<(params: any) => void>>();
  private readonly closeEmitter = new Emitter<void>();
  private readonly subscriptions: vscode.Disposable[] = [];

  readonly onDidClose: Event<void> = this.closeEmitter.event;
  /** VS Code's own id of the browser view (`vscodeBrowserViewId` on the CDP target), if exposed. */
  viewId: string | undefined;
  targetId: string | undefined;

  private constructor(
    readonly tabId: string,
    private readonly session: vscode.BrowserCDPSession,
  ) {
    this.subscriptions.push(
      session.onDidReceiveMessage(message => this.onMessage(message as any)),
      session.onDidClose(() => this.close()),
    );
  }

  static async attach(tabId: string, tab: vscode.BrowserTab): Promise<CdpConnection> {
    const connection = new CdpConnection(tabId, await tab.startCDPSession());
    try {
      const { sessionId: browserSession } = await connection.raw('Target.attachToBrowserTarget', {});
      const { targetInfos } = await connection.raw('Target.getTargets', {}, browserSession);
      const page = (targetInfos as any[]).find(t => t.type === 'page');
      if (!page) throw new Error('the tab has no page target');
      const { sessionId } = await connection.raw('Target.attachToTarget', { targetId: page.targetId, flatten: true }, browserSession);
      connection.pageSessionId = sessionId;
      connection.targetId = page.targetId;
      connection.viewId = typeof page.vscodeBrowserViewId === 'string' ? page.vscodeBrowserViewId : undefined;
      return connection;
    } catch (err) {
      connection.close();
      throw err;
    }
  }

  get closed(): boolean {
    return this.isClosed;
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}, options: { timeoutMs?: number } = {}): Promise<T> {
    return this.raw(method, params, this.pageSessionId, options.timeoutMs);
  }

  on(event: string, listener: (params: any) => void): vscode.Disposable {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(listener);
    return { dispose: () => void set.delete(listener) };
  }

  /** Closes the connection. The tab itself stays open. */
  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    for (const s of this.subscriptions.splice(0)) s.dispose();
    for (const command of this.pending.values()) {
      clearTimeout(command.timer);
      command.reject(new ToolError('not_found', `Tab ${this.tabId} was closed.`));
    }
    this.pending.clear();
    this.listeners.clear();
    void Promise.resolve(this.session.close()).then(undefined, () => {});
    this.closeEmitter.fire();
    this.closeEmitter.dispose();
  }

  private raw(method: string, params: Record<string, unknown>, sessionId?: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<any> {
    if (this.isClosed) return Promise.reject(new ToolError('not_found', `Tab ${this.tabId} was closed.`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ToolError('timeout', `The browser did not answer ${method} within ${Math.round(timeoutMs / 1000)} s.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const message: Record<string, unknown> = { id, method, params };
      if (sessionId) message.sessionId = sessionId;
      Promise.resolve(this.session.sendMessage(message)).then(undefined, err => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  private onMessage(message: { id?: number; method?: string; sessionId?: string; params?: any; result?: any; error?: { message?: string } }): void {
    if (!message || typeof message !== 'object') return;
    if (typeof message.id === 'number') {
      const command = this.pending.get(message.id);
      if (!command) return;
      this.pending.delete(message.id);
      clearTimeout(command.timer);
      if (message.error) command.reject(new Error(message.error.message ?? 'CDP error'));
      else command.resolve(message.result);
      return;
    }
    if (typeof message.method !== 'string' || message.sessionId !== this.pageSessionId) return;
    for (const listener of [...(this.listeners.get(message.method) ?? [])]) {
      try {
        listener(message.params);
      } catch {
        // A failing listener must not break event delivery to the others.
      }
    }
  }
}
