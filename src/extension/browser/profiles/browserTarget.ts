// A CDP session on the *browser* target, reached through a tab's `startCDPSession()`: what creates
// login profiles (`Target.createBrowserContext`) and opens tabs in them (`Target.createTarget` with
// `browserContextId`). VS Code turns such a target into a real integrated-browser tab in the window.
//
// What VS Code 1.146 does (tested, see docs/browser-profiles.md): each `startCDPSession()` is its own
// "group"; a group may open tabs in a context it created itself or in the context of a tab it contains
// (the tab it was started from, and tabs it created). The group, and with it the right to use the
// contexts it created, lives until the session is closed, also after the tab it was started from is
// closed; a window reload or extension host restart ends it.
import type * as vscode from 'vscode';

const TIMEOUT_MS = 10_000;

export class BrowserTargetSession {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve(v: any): void; reject(e: Error): void; timer: NodeJS.Timeout }>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private browserSession: string | undefined;
  private isClosed = false;
  private closeListeners: Array<() => void> = [];

  private constructor(private readonly session: vscode.BrowserCDPSession) {
    this.subscriptions.push(
      session.onDidReceiveMessage(m => this.onMessage(m as any)),
      session.onDidClose(() => this.close()),
    );
  }

  /** Starts a CDP session from `tab` and attaches to the browser target. */
  static async start(tab: vscode.BrowserTab, timeoutMs = TIMEOUT_MS): Promise<BrowserTargetSession> {
    const s = new BrowserTargetSession(await tab.startCDPSession());
    try {
      const { sessionId } = await s.raw('Target.attachToBrowserTarget', {}, undefined, timeoutMs);
      s.browserSession = sessionId;
      return s;
    } catch (err) {
      s.close();
      throw err;
    }
  }

  get closed(): boolean {
    return this.isClosed;
  }

  onDidClose(listener: () => void): void {
    if (this.isClosed) listener();
    else this.closeListeners.push(listener);
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}, timeoutMs = TIMEOUT_MS): Promise<T> {
    return this.raw(method, params, this.browserSession, timeoutMs);
  }

  async createContext(): Promise<string> {
    const { browserContextId } = await this.send('Target.createBrowserContext');
    if (typeof browserContextId !== 'string') throw new Error('the browser did not return a context id');
    return browserContextId;
  }

  /** Opens a tab in `contextId`. Returns the new page's target id and VS Code view id. */
  async createTab(url: string, contextId: string): Promise<{ targetId: string; viewId: string | undefined }> {
    const { targetId } = await this.send('Target.createTarget', { url, browserContextId: contextId });
    let viewId: string | undefined;
    try {
      viewId = (await this.targets()).find(t => t.targetId === targetId)?.viewId;
    } catch {
      // Only used to recognise the tab; the caller falls back to other means.
    }
    return { targetId, viewId };
  }

  /** Page targets this session can see, with their context and VS Code view id. */
  async targets(): Promise<Array<{ targetId: string; contextId: string | undefined; viewId: string | undefined; url: string }>> {
    const { targetInfos } = await this.send('Target.getTargets');
    return (targetInfos as any[])
      .filter(t => t.type === 'page')
      .map(t => ({
        targetId: String(t.targetId),
        contextId: typeof t.browserContextId === 'string' ? t.browserContextId : undefined,
        viewId: typeof t.vscodeBrowserViewId === 'string' ? t.vscodeBrowserViewId : undefined,
        url: String(t.url ?? ''),
      }));
  }

  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    for (const s of this.subscriptions.splice(0)) s.dispose();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('the browser session closed'));
    }
    this.pending.clear();
    void Promise.resolve(this.session.close()).then(undefined, () => {});
    for (const l of this.closeListeners.splice(0)) {
      try {
        l();
      } catch {
        // ignore
      }
    }
  }

  private raw(method: string, params: Record<string, unknown>, sessionId: string | undefined, timeoutMs = TIMEOUT_MS): Promise<any> {
    if (this.isClosed) return Promise.reject(new Error('the browser session closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`the browser did not answer ${method} within ${Math.round(timeoutMs / 1000)} s`));
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

  private onMessage(message: { id?: number; result?: any; error?: { message?: string } }): void {
    if (!message || typeof message.id !== 'number') return;
    const p = this.pending.get(message.id);
    if (!p) return;
    this.pending.delete(message.id);
    clearTimeout(p.timer);
    if (message.error) p.reject(new Error(message.error.message ?? 'CDP error'));
    else p.resolve(message.result);
  }
}

/** The view id and browser context of a tab's page, through a short-lived session. */
export async function identifyTab(tab: vscode.BrowserTab, timeoutMs = 5000): Promise<{ viewId: string | undefined; contextId: string | undefined }> {
  const s = await BrowserTargetSession.start(tab, timeoutMs);
  try {
    const page = (await s.targets())[0];
    return { viewId: page?.viewId, contextId: page?.contextId };
  } finally {
    s.close();
  }
}

/** CDP errors that mean a context id is not usable from this session (any more). */
export function isUnknownContext(err: unknown): boolean {
  return /unknown browser context|no longer exists|browser session .* not found/i.test(err instanceof Error ? err.message : String(err));
}
