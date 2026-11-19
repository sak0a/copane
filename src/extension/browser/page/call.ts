// One tool invocation against one tab: acquires the tab, waits until its page can be used, and wraps
// every CDP command so that it ends when the agent cancels, when the tab closes, or when a JavaScript
// dialog opens (which would otherwise block the command until someone answers the dialog).
import { ToolError } from '../../core/errors';
import { deniedMessage } from '../access';
import type { BridgeServices, BrowserTabInfo, CdpPage, TabAccess } from '../../core/services';
import type { ToolContext } from '../../core/tools';
import type { ToolContent } from '../../../shared/protocol';
import type { FrameTarget } from './frames';
import { DialogInterrupt, type DialogInfo, type PageState, type PageStates } from './pageState';
import { clip } from './ringBuffer';
import type { RefStore, RefTable } from './refs';
import type { ScreenshotDetail } from './screenshotMath';
import type { SessionNotices } from './sessionNotices';
import { accessibleName, roleName, type AXNode } from './snapshot';
import type { ElementTarget } from './targets';

export interface PageEnv {
  services: BridgeServices;
  states: PageStates;
  refs: RefStore;
  /** Read cursors for console and network, per `${sessionId}\0${tabId}`. */
  cursors: Map<string, { console: number; network: number }>;
  /** The page as this session last saw it, per `${sessionId}\0${tabId}`: what action results compare against. */
  baselines: Map<string, { loaderId: string | undefined; lines: string[] }>;
  /** Guidance already given in full to a session (sessionNotices.ts). */
  notices: SessionNotices;
  /** Features that hook into page tool calls (downloads, emulation). */
  hooks?: PageHook[];
}

/** A feature's hooks into page tool calls. Every member is optional. */
export interface PageHook {
  /** Runs before a call that controls the tab; the function it returns runs when the call ends. */
  aroundControl?(call: PageCall): Promise<(() => void) | undefined>;
  /** Lines for an action's result about what it caused since `sinceSeq` (e.g. downloads). */
  effectLines?(call: PageCall, sinceSeq: number): Promise<string[]>;
  /** Takes a screenshot itself when the usual way would disturb the tab; undefined to let the tool do it. */
  screenshot?(call: PageCall, request: ScreenshotRequest): Promise<ToolContent[] | undefined>;
  /** The page takes touch input instead of mouse presses (mobile emulation). */
  usesTouch?(call: PageCall): Promise<boolean>;
  /** Sees every call (read or control) once its tab is acquired, before the tool runs (the test recorder). */
  observeCall?(call: PageCall): void;
  /** An element the call resolved from the agent's ref or selector, before the tool acts on it (see `targetResolved`). */
  targetResolved?(call: PageCall, target: ElementTarget): Promise<void>;
  /** A line for a performance measurement of a page load that started at `loadedAt` (e.g. it was throttled). */
  measurementNote?(call: PageCall, loadedAt: number | undefined): string | undefined;
}

/** Tells the hooks which element a call is about to act on (called by resolveTarget in targets.ts). */
export async function targetResolved(call: PageCall, target: ElementTarget): Promise<void> {
  for (const hook of call.env.hooks ?? []) await hook.targetResolved?.(call, target);
}

export interface ScreenshotRequest {
  /** Element to capture (already scrolled into view). */
  target: { backendNodeId: number; label: string } | undefined;
  fullPage: boolean;
  format: 'jpeg' | 'png';
  /** Image size budget (screenshotMath.ts); default "normal". */
  detail?: ScreenshotDetail;
}

/** True when a hook says the page wants taps instead of mouse presses. */
export async function pageUsesTouch(call: PageCall): Promise<boolean> {
  for (const hook of call.env.hooks ?? []) if (await hook.usesTouch?.(call)) return true;
  return false;
}

/** An object handle argument for `callOn`. */
export class ObjectArg {
  constructor(readonly objectId: string) {}
}

let groupCounter = 0;

/** How long a dialog must stay open before it counts as blocking the page. */
export const DIALOG_GRACE_MS = 50;

const CONTEXT_GONE = /Cannot find context|context was destroyed|Execution context was destroyed|Inspected target navigated|No frame with given id|Frame with the given id was not found/i;

export class PageCall {
  readonly group: string;
  private readonly scoped = new Map<string, PageCall>();

  constructor(
    readonly env: PageEnv,
    readonly ctx: ToolContext,
    readonly tab: BrowserTabInfo,
    readonly page: CdpPage,
    readonly state: PageState,
    /** Set for a call scoped to a cross-origin frame (see `at`): commands go to that frame's target. */
    readonly frame?: FrameTarget,
    private readonly parent?: PageCall,
  ) {
    this.group = parent?.group ?? `copane-${++groupCounter}`;
  }

  /** The call on the page target (this one, unless it is scoped to a frame). */
  get top(): PageCall {
    return this.parent ?? this;
  }

  /** The CDP session this call talks to: the frame target's for a frame-scoped call, else the page's. */
  get cdp(): CdpPage {
    return this.frame?.session ?? this.page;
  }

  /**
   * The same call, talking to a cross-origin frame's target (undefined = the page target). Shares
   * cancellation, dialog handling and the object group; input events still go through the page.
   */
  at(frame: FrameTarget | undefined): PageCall {
    const top = this.top;
    if (!frame) return top;
    let call = top.scoped.get(frame.id);
    if (!call || call.frame !== frame) top.scoped.set(frame.id, (call = new PageCall(this.env, this.ctx, this.tab, this.page, this.state, frame, top)));
    return call;
  }

  get signal(): AbortSignal {
    return this.ctx.signal;
  }

  /** Key of per-session, per-tab state (cursors, baselines). */
  get sessionTabKey(): string {
    return `${this.ctx.session.id}\u0000${this.tab.id}`;
  }

  /** This session's refs for this tab. */
  get refs(): RefTable {
    return this.env.refs.table(this.ctx.session.id, this.tab.id);
  }

  /**
   * Sends a CDP command. Rejects with DialogInterrupt when a dialog is open or opens meanwhile (unless
   * `allowDialog`), with ToolError "cancelled" when the agent cancels.
   */
  send<T = any>(method: string, params: Record<string, unknown> = {}, options: { timeoutMs?: number; allowDialog?: boolean } = {}): Promise<T> {
    if (this.signal.aborted) return Promise.reject(new ToolError('cancelled', 'Cancelled.'));
    if (!options.allowDialog && this.state.dialog) return Promise.reject(new DialogInterrupt(this.state.dialog));
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        sub?.dispose();
        if (pendingCheck) clearTimeout(pendingCheck);
        this.signal.removeEventListener('abort', onAbort);
        fn();
      };
      const onAbort = () => done(() => reject(new ToolError('cancelled', 'Cancelled.')));
      // Some dialogs are answered by the browser itself at once (VS Code confirms "leave this page?"),
      // so a dialog only interrupts the command if it is still open a moment later.
      let pendingCheck: NodeJS.Timeout | undefined;
      const sub = options.allowDialog
        ? undefined
        : this.state.onDidChange(() => {
            const dialog = this.state.dialog;
            if (!dialog || pendingCheck) return;
            pendingCheck = setTimeout(() => {
              pendingCheck = undefined;
              if (this.state.dialog === dialog) done(() => reject(new DialogInterrupt(dialog)));
            }, DIALOG_GRACE_MS);
          });
      this.signal.addEventListener('abort', onAbort);
      this.cdp.send<T>(method, params, { timeoutMs: options.timeoutMs ?? 30_000 }).then(
        value => done(() => resolve(value)),
        err => done(() => reject(err instanceof ToolError || !(err instanceof Error) ? err : Object.assign(new Error(`${method}: ${err.message}`), { cdpMessage: err.message }))),
      );
    });
  }

  /** Runs a page-side function in the bridge's isolated world of a frame (default: main frame). */
  async evaluate<T = any>(fn: string, args: unknown[] = [], options: { frameId?: string; timeoutMs?: number } = {}): Promise<T> {
    const result = await this.evaluateRaw(fn, args, { ...options, returnByValue: true });
    return result.value as T;
  }

  /** Like `evaluate`, but returns the CDP RemoteObject (for results that are DOM nodes). */
  async evaluateHandle(fn: string, args: unknown[] = [], options: { frameId?: string; timeoutMs?: number } = {}): Promise<any> {
    return this.evaluateRaw(fn, args, { ...options, returnByValue: false });
  }

  private async evaluateRaw(fn: string, args: unknown[], options: { frameId?: string; timeoutMs?: number; returnByValue: boolean }): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      const contextId = this.frame ? await this.state.frames.isolatedWorld(this.frame, options.frameId) : await this.state.isolatedWorld(options.frameId);
      try {
        const r = await this.send(
          'Runtime.callFunctionOn',
          { functionDeclaration: fn, executionContextId: contextId, arguments: args.map(toCallArgument), returnByValue: options.returnByValue, awaitPromise: true, objectGroup: this.group },
          { timeoutMs: options.timeoutMs },
        );
        if (r.exceptionDetails) throw new Error(exceptionText(r.exceptionDetails));
        return r.result;
      } catch (err) {
        if (attempt === 0 && err instanceof Error && CONTEXT_GONE.test(err.message)) {
          if (this.frame) this.state.frames.forgetWorld(this.frame, contextId);
          else this.state.forgetWorld(contextId);
          await this.sleep(100);
          continue;
        }
        throw err;
      }
    }
  }

  /** Calls a page-side function with `this` = the object. Returns the value (or the RemoteObject). */
  async callOn<T = any>(objectId: string, fn: string, args: unknown[] = [], options: { returnByValue?: boolean; timeoutMs?: number } = {}): Promise<T> {
    const r = await this.send(
      'Runtime.callFunctionOn',
      { functionDeclaration: fn, objectId, arguments: args.map(toCallArgument), returnByValue: options.returnByValue ?? true, awaitPromise: true, objectGroup: this.group },
      { timeoutMs: options.timeoutMs },
    );
    if (r.exceptionDetails) throw new Error(exceptionText(r.exceptionDetails));
    return (options.returnByValue ?? true) ? r.result.value : r.result;
  }

  /** A handle to a DOM node in the page's own world of its frame. Throws when the node is gone. */
  async resolve(backendNodeId: number): Promise<string> {
    const { object } = await this.send('DOM.resolveNode', { backendNodeId, objectGroup: this.group });
    if (!object?.objectId) throw new Error('node not found');
    return object.objectId;
  }

  /** Role and name of a node as the snapshot would print them. */
  async describeAx(backendNodeId: number): Promise<{ role: string; name: string; ignored: boolean } | undefined> {
    try {
      const { nodes } = await this.send<{ nodes: AXNode[] }>('Accessibility.getPartialAXTree', { backendNodeId, fetchRelatives: false });
      const node = nodes.find(n => n.backendDOMNodeId === backendNodeId) ?? nodes[0];
      if (!node) return undefined;
      return { role: roleName(node), name: accessibleName(node), ignored: Boolean(node.ignored) };
    } catch (err) {
      if (err instanceof DialogInterrupt || err instanceof ToolError) throw err;
      return undefined;
    }
  }

  /** Waits, honouring cancellation. */
  sleep(ms: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.signal.aborted) return reject(new ToolError('cancelled', 'Cancelled.'));
      const onAbort = () => {
        clearTimeout(timer);
        reject(new ToolError('cancelled', 'Cancelled.'));
      };
      const timer = setTimeout(() => {
        this.signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      this.signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  dispose(): void {
    for (const call of this.scoped.values()) call.dispose();
    this.scoped.clear();
    if (this.cdp.closed) return;
    if (this.state.dialog) return;
    this.cdp.send('Runtime.releaseObjectGroup', { objectGroup: this.group }, { timeoutMs: 5000 }).then(undefined, () => {});
  }
}

function toCallArgument(arg: unknown): Record<string, unknown> {
  if (arg instanceof ObjectArg) return { objectId: arg.objectId };
  if (arg === undefined) return {};
  return { value: arg };
}

export function exceptionText(details: { text?: string; exception?: { description?: string; value?: unknown } }): string {
  const description = details.exception?.description ?? (details.exception?.value !== undefined ? String(details.exception.value) : undefined);
  return description ? description.split('\n').slice(0, 6).join('\n') : (details.text ?? 'exception');
}

export function dialogMessage(tabId: string, dialog: DialogInfo): string {
  const kind = dialog.type === 'beforeunload' ? 'a "leave this page?" (beforeunload)' : `${dialog.type === 'alert' ? 'an' : 'a'} ${dialog.type}`;
  const message = dialog.message ? `: "${clip(dialog.message, 300)}"` : '';
  const how = dialog.type === 'alert' ? 'browser_handle_dialog (accept: true)' : dialog.type === 'prompt' ? 'browser_handle_dialog (accept, and promptText for the answer)' : 'browser_handle_dialog with accept true or false';
  return `${tab(tabId)} shows ${kind} dialog${message}. The page is blocked until it is answered, and the user cannot see it in VS Code. Answer it with ${how}.`;
}

function tab(id: string): string {
  return `Tab ${id}`;
}

export interface WithPageOptions {
  access: TabAccess;
  /** Run even while a dialog is open (tools that do not touch the page, and browser_handle_dialog). */
  allowDialog?: boolean;
  /** Do not wait for the document to be usable first. */
  skipReady?: boolean;
}

/**
 * Refuses to go on once the user has taken the tab over (paused it, or an agent handed it to them).
 * `withPage` checks this when a call starts; a call that waits and then reads the page checks again
 * with this before each read, so nothing the user does meanwhile is returned.
 */
export function assertNotPaused(call: PageCall): void {
  if (call.env.services.browser.getTab(call.tab.id)?.paused) throw new ToolError('access_denied', deniedMessage({ kind: 'paused' }, call.tab.id));
}

/** Acquires the tab and runs `fn` with a PageCall. All page tools go through here. */
export async function withPage<T>(env: PageEnv, ctx: ToolContext, tabId: string | undefined, options: WithPageOptions, fn: (call: PageCall) => Promise<T>): Promise<T> {
  const { tab, page } = await env.services.browser.acquire(ctx.session, tabId, options.access, ctx.signal);
  const state = env.states.forPage(page);
  await Promise.race([state.ready, new Promise(resolve => setTimeout(resolve, 15_000))]);
  const call = new PageCall(env, ctx, tab, page, state);
  for (const hook of env.hooks ?? []) hook.observeCall?.(call);
  const after: Array<() => void> = [];
  try {
    if (options.access === 'control') {
      for (const hook of env.hooks ?? []) {
        const done = await hook.aroundControl?.(call);
        if (done) after.push(done);
      }
    }
    if (state.dialog && !options.allowDialog) throw new DialogInterrupt(state.dialog);
    // The session driving the tab gets a page that behaves as if it were in front, even when the tab is
    // in the background: timers not throttled, animation frames running, input accepted.
    if (!state.dialog && (options.access === 'control' || tab.controlledBy === ctx.session.id)) await keepPageActive(call);
    if (!options.skipReady) await ensureReady(call);
    return await fn(call);
  } catch (err) {
    if (err instanceof DialogInterrupt) throw new ToolError('failed', dialogMessage(tab.id, err.dialog));
    if (page.closed && !(err instanceof ToolError && err.code === 'cancelled')) throw new ToolError('not_found', `Tab ${tab.id} was closed while the tool was running.`);
    throw err;
  } finally {
    for (const done of after) done();
    call.dispose();
  }
}

/**
 * A tab that is not on screen drops mouse presses and key events sent through CDP (mouse moves still
 * arrive), throttles timers and runs no animation frames, so pages behave differently from what the
 * user would see. Focus emulation makes the page behave as if it were in front. It stays on while an
 * agent holds the tab's control lease, so menus and typeaheads that close on blur stay open between
 * the agent's calls, and is turned off when the lease ends (index.ts). It does not move the user's focus.
 */
export async function keepPageActive(call: PageCall): Promise<void> {
  if (call.state.focusEmulation) return;
  call.state.focusEmulation = true;
  try {
    await call.send('Emulation.setFocusEmulationEnabled', { enabled: true }, { timeoutMs: 5000 });
  } catch (err) {
    call.state.focusEmulation = false;
    if (err instanceof DialogInterrupt || (err instanceof ToolError && err.code === 'cancelled')) throw err;
  }
}

/**
 * Waits until the main document is usable (DOMContentLoaded of the current document, and a page that
 * was just opened has committed its first navigation), and checks that the page answers at all.
 */
export async function ensureReady(call: PageCall, timeoutMs = 10_000): Promise<void> {
  const { state } = call;
  if (state.crashed) throw new ToolError('failed', `The page in ${call.tab.id} crashed. Reload it with browser_navigate {"action":"reload"}.`);
  // A tab that was just opened starts on an empty document ("" or about:blank) until its first
  // navigation commits; reading it before then would show an empty page.
  const expectsNavigation = () => (state.url === '' || state.url === 'about:blank') && call.tab.url !== '' && !call.tab.url.startsWith('about:');
  await state.waitFor(() => state.lifecycleOf().has('DOMContentLoaded') && !expectsNavigation(), { timeoutMs, signal: call.signal });
  try {
    await call.evaluate('function () { return 1; }', [], { timeoutMs: 3000 });
  } catch (err) {
    if (err instanceof DialogInterrupt || (err instanceof ToolError && err.code === 'cancelled')) throw err;
    if (err instanceof ToolError && err.code === 'timeout') {
      throw new ToolError(
        'timeout',
        `${call.tab.id} is not responding to scripts. It may be showing a dialog that opened before the bridge was watching it (call browser_handle_dialog to dismiss it), or be stuck in a long-running script (try again shortly, or reload it with browser_navigate {"action":"reload"}).`,
      );
    }
    throw err;
  }
}
