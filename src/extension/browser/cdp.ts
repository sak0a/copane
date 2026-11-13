// One CDP connection to the page target of an integrated-browser tab.
//
// `BrowserTab.startCDPSession()` hands out a session rooted at a browser target that only sees this
// tab. We attach to the browser target, find the page target and attach to it with a flattened
// session; all commands and events of `CdpPage` are scoped to that page session.
//
// Closing a tab does not close its CDP session (the session's own onDidClose does not fire), so the
// service closes the connection from the tab-close event, and a send that the browser answers with
// "session/target not found" closes it too: every later send then fails at once with a message for
// the agent, and the next `acquire` attaches a fresh connection if the tab still exists.
//
// Child sessions: the page session can auto-attach to its out-of-process iframes (`Target.setAutoAttach`
// with flatten); VS Code's proxy forwards that to Chromium and announces each child with
// `Target.attachedToTarget` on the session that asked. `childSession(id)` gives a CdpPage scoped to
// such a session: commands carry its session id, its events go only to its own listeners, and its
// failures never close the page connection.
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

/** CDP error texts that mean the page session is gone for good. */
const GONE = /session (with given id )?not found|no target with given id|target closed|not attached to an active page|inspected target navigated or closed/i;

export type CloseReason = 'closed' | 'tab-closed' | 'lost';

export class CdpConnection implements CdpPage {
  private nextId = 1;
  private pageSessionId: string | undefined;
  private isClosed = false;
  private readonly pending = new Map<number, PendingCommand>();
  private readonly listeners = new Map<string, Set<(params: any) => void>>();
  private readonly closeEmitter = new Emitter<void>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly children = new Map<string, ChildSession>();
  private closeReason: CloseReason = 'closed';

  readonly onDidClose: Event<void> = this.closeEmitter.event;
  /** Awaited before every `Input.*` command, e.g. to make the page indicator click-through. */
  beforeInput: (() => Promise<void>) | undefined;
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

  /**
   * VS Code's browser view id of a tab, without attaching to its page: used to recognise tabs restored
   * after a window reload. Undefined when VS Code does not expose it.
   */
  static async identify(tab: vscode.BrowserTab): Promise<string | undefined> {
    const connection = new CdpConnection('(identify)', await tab.startCDPSession());
    try {
      const { sessionId } = await connection.raw('Target.attachToBrowserTarget', {}, undefined, 5000);
      const { targetInfos } = await connection.raw('Target.getTargets', {}, sessionId, 5000);
      const page = (targetInfos as any[]).find(t => t.type === 'page');
      return typeof page?.vscodeBrowserViewId === 'string' ? page.vscodeBrowserViewId : undefined;
    } finally {
      connection.close();
    }
  }

  get closed(): boolean {
    return this.isClosed;
  }

  async send<T = any>(method: string, params: Record<string, unknown> = {}, options: { timeoutMs?: number } = {}): Promise<T> {
    if (this.beforeInput && method.startsWith('Input.') && !this.isClosed) {
      try {
        await this.beforeInput();
      } catch {
        // Never let the indicator get in the way of the agent's input.
      }
    }
    try {
      return await this.raw(method, params, this.pageSessionId, options.timeoutMs);
    } catch (err) {
      if (!(err instanceof ToolError) && err instanceof Error && GONE.test(err.message)) {
        this.close('lost');
        throw this.goneError();
      }
      throw err;
    }
  }

  on(event: string, listener: (params: any) => void): vscode.Disposable {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(listener);
    return { dispose: () => void set.delete(listener) };
  }

  /** See `CdpPage.childSession`. */
  childSession(sessionId: string): CdpPage {
    let child = this.children.get(sessionId);
    if (!child) {
      child = new ChildSession(
        this.tabId,
        sessionId,
        (method, params, timeoutMs) => this.raw(method, params, sessionId, timeoutMs),
        id => this.childSession(id),
        () => this.children.delete(sessionId),
      );
      this.children.set(sessionId, child);
      if (this.isClosed) child.close();
    }
    return child;
  }

  /** Closes the connection. The tab itself stays open. `tab-closed` and `lost` only change the error later sends get. */
  close(reason: CloseReason = 'closed'): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.closeReason = reason;
    for (const s of this.subscriptions.splice(0)) s.dispose();
    for (const command of this.pending.values()) {
      clearTimeout(command.timer);
      command.reject(this.goneError());
    }
    this.pending.clear();
    this.listeners.clear();
    for (const child of [...this.children.values()]) child.close();
    this.children.clear();
    void Promise.resolve(this.session.close()).then(undefined, () => {});
    this.closeEmitter.fire();
    this.closeEmitter.dispose();
  }

  private goneError(): ToolError {
    if (this.closeReason === 'lost') {
      return new ToolError('failed', `Lost the connection to the page in ${this.tabId} (it crashed, was replaced or VS Code dropped the debugging session). Call the tool again: the bridge reconnects on the next call.`);
    }
    return new ToolError('not_found', `${this.tabId} was closed. Call browser_list_tabs to see the open tabs, or open a new one with browser_open.`);
  }

  private raw(method: string, params: Record<string, unknown>, sessionId?: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<any> {
    if (this.isClosed) return Promise.reject(this.goneError());
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
    if (typeof message.method !== 'string') return;
    if (this.pageSessionId && this.isPageGone(message)) {
      this.close('lost');
      return;
    }
    if (message.method === 'Target.detachedFromTarget' && typeof message.params?.sessionId === 'string') {
      this.children.get(message.params.sessionId)?.close();
    }
    if (message.sessionId !== this.pageSessionId) {
      if (message.sessionId) this.children.get(message.sessionId)?.dispatch(message.method, message.params);
      return;
    }
    for (const listener of [...(this.listeners.get(message.method) ?? [])]) {
      try {
        listener(message.params);
      } catch {
        // A failing listener must not break event delivery to the others.
      }
    }
  }

  /** Events of the browser session that say our page session ended. */
  private isPageGone(message: { method?: string; sessionId?: string; params?: any }): boolean {
    switch (message.method) {
      case 'Target.detachedFromTarget':
        return message.params?.sessionId === this.pageSessionId || (this.targetId !== undefined && message.params?.targetId === this.targetId);
      case 'Target.targetDestroyed':
      case 'Target.targetCrashed':
        return this.targetId !== undefined && message.params?.targetId === this.targetId && message.sessionId !== this.pageSessionId;
      case 'Inspector.detached':
        return message.sessionId === this.pageSessionId;
      default:
        return false;
    }
  }
}

/** A child target session (out-of-process iframe) of a CdpConnection; see `CdpPage.childSession`. */
class ChildSession implements CdpPage {
  private isClosed = false;
  private readonly listeners = new Map<string, Set<(params: any) => void>>();
  private readonly closeEmitter = new Emitter<void>();
  readonly onDidClose: Event<void> = this.closeEmitter.event;

  constructor(
    readonly tabId: string,
    readonly sessionId: string,
    private readonly rawSend: (method: string, params: Record<string, unknown>, timeoutMs: number | undefined) => Promise<any>,
    private readonly sibling: (sessionId: string) => CdpPage,
    private readonly onClosed: () => void,
  ) {}

  get closed(): boolean {
    return this.isClosed;
  }

  async send<T = any>(method: string, params: Record<string, unknown> = {}, options: { timeoutMs?: number } = {}): Promise<T> {
    if (this.isClosed) throw this.goneError();
    let sub: { dispose(): void } | undefined;
    try {
      // A command to a frame that detaches meanwhile is never answered: end it with the detach.
      const gone = new Promise<never>((_, reject) => (sub = this.onDidClose(() => reject(this.goneError()))));
      gone.catch(() => {});
      return await Promise.race([this.rawSend(method, params, options.timeoutMs), gone]);
    } catch (err) {
      if (!(err instanceof ToolError) && err instanceof Error && GONE.test(err.message)) {
        this.close();
        throw this.goneError();
      }
      throw err;
    } finally {
      sub?.dispose();
    }
  }

  on(event: string, listener: (params: any) => void): vscode.Disposable {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(listener);
    return { dispose: () => void set.delete(listener) };
  }

  /** Nested frames: all sessions are flat, so this is the page connection's child too. */
  childSession(sessionId: string): CdpPage {
    return this.sibling(sessionId);
  }

  dispatch(method: string, params: unknown): void {
    if (this.isClosed) return;
    for (const listener of [...(this.listeners.get(method) ?? [])]) {
      try {
        listener(params);
      } catch {
        // A failing listener must not break event delivery to the others.
      }
    }
  }

  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.listeners.clear();
    this.onClosed();
    this.closeEmitter.fire();
    this.closeEmitter.dispose();
  }

  private goneError(): ToolError {
    return new ToolError('not_found', `A frame in ${this.tabId} went away while the tool was using it (it navigated, reloaded or was removed). Take a new snapshot.`);
  }
}
