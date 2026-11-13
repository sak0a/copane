// The single owner of the CDP `Fetch` domain of each tab. Only one party can enable `Fetch` on a tab's
// shared CDP connection and answer what it pauses, so every feature that needs to hold or change
// requests (credential prompts, request mocking, ...) is a `FetchClient` registered here:
//
// - each client says which requests it needs paused on a tab (`patterns`) and whether it answers login
//   challenges (`handlesAuth`); the union is applied with one `Fetch.enable`, or `Fetch.disable` when
//   nobody needs anything, so tabs without a use pay nothing;
// - a paused request is offered to the clients in registration order; the first decision wins, and
//   without one the request continues unchanged;
// - every paused request is answered exactly once: on a client error, on a timeout of the client, when
//   the client aborts it (its rule went away), and before `Fetch` is disabled. When the tab or its
//   connection closes, the browser drops the interception with it, so nothing stays paused.
//
// Scope: the page target of the tab. Requests of out-of-process (cross-site) iframes and of workers are
// made by other CDP targets and are not paused here; `attach` takes any CdpPage-like target, so child
// sessions can be added the same way once the bridge attaches to them.
import { Emitter, type Disposable, type Event } from '../core/events';
import type { Logger } from '../core/log';
import type { CdpPage } from '../core/services';

/** A CDP `Fetch.RequestPattern` at the request stage. `urlPattern` is a glob: `*` any characters, `?` one. */
export interface FetchPattern {
  urlPattern: string;
  resourceType?: string;
}

export interface PausedRequest {
  tabId: string;
  /** The `Fetch` id, valid until the request is answered. */
  requestId: string;
  /** The `Network` id of the same request, as in the tab's network log. */
  networkId: string | undefined;
  url: string;
  method: string;
  headers: Record<string, string>;
  /** CDP resource type: Document, XHR, Fetch, Script, Image, ... */
  resourceType: string;
  frameId: string | undefined;
}

export type RequestDecision = (
  | { kind: 'continue'; /** Replaces the request headers. */ headers?: Record<string, string> }
  | { kind: 'fulfill'; status: number; headers: Record<string, string>; body: string }
  | { kind: 'fail'; /** CDP `Network.ErrorReason`, e.g. "Failed", "ConnectionRefused". */ reason: string }
) & {
  /** Wait this long before answering. Aborted waits answer at once with "continue". */
  delayMs?: number;
  /** When this aborts before the answer is sent (the rule behind the decision was removed), the request goes on unchanged. */
  cancel?: AbortSignal;
  /** Shown with the request in the network log, e.g. "mocked by m1". */
  note?: string;
};

export interface AuthChallenge {
  /** "Server" for a site's 401, "Proxy" for a proxy's 407. */
  source: 'Server' | 'Proxy';
  /** Origin of the site or proxy asking, e.g. "http://intranet.corp:80". */
  origin: string;
  /** Lower-case scheme: basic, digest, ntlm, negotiate. */
  scheme: string;
  realm: string;
}

export interface AuthRequest extends PausedRequest {
  challenge: AuthChallenge;
}

export type AuthDecision = { kind: 'default' } | { kind: 'cancel' } | { kind: 'provide'; username: string; password: string };

export interface FetchClient {
  /** For log lines. */
  readonly name: string;
  /** Requests this client needs paused on the tab now. Call `FetchInterception.refresh` when it changes. */
  patterns(tabId: string): FetchPattern[];
  /** Whether this client answers login challenges on the tab now (only for requests some pattern pauses). */
  handlesAuth?(tabId: string): boolean;
  /** A decision for the request, or undefined to leave it to the next client. `signal` aborts when the tab goes away. */
  onRequest?(request: PausedRequest, signal: AbortSignal): RequestDecision | undefined | Promise<RequestDecision | undefined>;
  onAuth?(request: AuthRequest, signal: AbortSignal): Promise<AuthDecision>;
  /** A connection of the tab was attached and what the clients need is in effect on it. */
  onAttached?(page: CdpPage): void;
}

/** CDP `Fetch` methods are used by this class only; the rest of the extension goes through it. */
interface Target {
  page: CdpPage;
  /** JSON of the `Fetch.enable` params in effect, or "" when disabled. */
  applied: string;
  queue: Promise<void>;
  /** Paused requests (and login challenges) not answered yet, by Fetch id; `done` settles once answered. */
  pending: Map<string, { controller: AbortController; done: Promise<void> }>;
  subscriptions: Disposable[];
}

const ANSWER_TIMEOUT_MS = 10_000;
/** A client that takes longer than this to decide about a plain request is skipped. Login prompts have their own timeouts. */
const DECIDE_TIMEOUT_MS = 15_000;

export class FetchInterception implements Disposable {
  private readonly clients: FetchClient[] = [];
  private readonly targets = new Map<string, Target>();
  private readonly interceptEmitter = new Emitter<{ tabId: string; networkId: string; note: string }>();
  private readonly noteEmitter = new Emitter<{ tabId: string; text: string; topic?: string; to?: string }>();
  private disposed = false;

  /** A request was answered by a client with a note for the network log. */
  readonly onDidIntercept: Event<{ tabId: string; networkId: string; note: string }> = this.interceptEmitter.event;
  /** Something the agent driving the tab should learn with its next action result. */
  readonly onDidNote: Event<{ tabId: string; text: string; topic?: string; to?: string }> = this.noteEmitter.event;

  constructor(private readonly log: Logger) {}

  register(client: FetchClient): Disposable {
    this.clients.push(client);
    this.refreshAll();
    return {
      dispose: () => {
        const i = this.clients.indexOf(client);
        if (i >= 0) this.clients.splice(i, 1);
        this.refreshAll();
      },
    };
  }

  /** Starts serving a tab's CDP connection (again after a re-attach). */
  attach(page: CdpPage): void {
    const previous = this.targets.get(page.tabId);
    if (previous?.page === page) return;
    if (previous) this.drop(previous);
    const target: Target = { page, applied: '', queue: Promise.resolve(), pending: new Map(), subscriptions: [] };
    target.subscriptions.push(
      page.on('Fetch.requestPaused', params => void this.onPaused(target, params)),
      page.on('Fetch.authRequired', params => void this.onAuthRequired(target, params)),
      page.onDidClose(() => this.drop(target)),
    );
    this.targets.set(page.tabId, target);
    this.refresh(page.tabId);
    target.queue = target.queue.then(() => {
      if (page.closed || this.targets.get(page.tabId) !== target) return;
      for (const client of this.clients) this.guard(client, 'onAttached', () => client.onAttached?.(page), undefined);
    });
  }

  /** Re-applies what the clients need on a tab (all tabs without an id). Cheap when nothing changed. */
  refresh(tabId?: string): void {
    if (tabId === undefined) return this.refreshAll();
    const target = this.targets.get(tabId);
    if (!target || target.page.closed || this.disposed) return;
    target.queue = target.queue.then(() => this.apply(target)).then(undefined, () => {});
  }

  /** Whether `Fetch` is enabled on the tab now (for tests and diagnostics). */
  isActive(tabId: string): boolean {
    return !!this.targets.get(tabId)?.applied;
  }

  /**
   * Tells agents something in their action results on the tab: without `to`, whoever's action is
   * running there now; with `to`, that session's next action, whenever it comes. A later note with the
   * same `topic` replaces an earlier one.
   */
  note(tabId: string, text: string, options: { topic?: string; to?: string } = {}): void {
    this.noteEmitter.fire({ tabId, text, ...options });
  }

  private refreshAll(): void {
    for (const id of this.targets.keys()) this.refresh(id);
  }

  private async apply(target: Target): Promise<void> {
    const { page } = target;
    if (page.closed) return;
    const tabId = page.tabId;
    const seen = new Set<string>();
    const patterns: FetchPattern[] = [];
    let auth = false;
    for (const client of this.clients) {
      for (const p of this.guard(client, 'patterns', () => client.patterns(tabId), [])) {
        const key = `${p.urlPattern}\u0000${p.resourceType ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        patterns.push(p);
      }
      auth ||= this.guard(client, 'handlesAuth', () => client.handlesAuth?.(tabId) ?? false, false);
    }
    // Login challenges are only reported for paused requests, so without patterns there is nothing to do.
    const want = patterns.length ? JSON.stringify({ patterns: patterns.map(p => ({ ...p, requestStage: 'Request' })), handleAuthRequests: auth }) : '';
    if (want === target.applied) return;
    try {
      if (want) {
        await page.send('Fetch.enable', JSON.parse(want), { timeoutMs: ANSWER_TIMEOUT_MS });
      } else {
        // Answer whatever is still paused before letting go of the domain (the browser would resume
        // them on disable too, but a held request should go out as itself, now).
        await this.answerAll(target);
        await page.send('Fetch.disable', {}, { timeoutMs: ANSWER_TIMEOUT_MS });
      }
      target.applied = want;
      this.log.debug(`${tabId}: ${want ? `intercepting ${patterns.map(p => p.urlPattern + (p.resourceType ? ` (${p.resourceType})` : '')).join(', ')}${auth ? ' + logins' : ''}` : 'interception off'}`);
    } catch (err) {
      if (!page.closed) this.log.warn(`${tabId}: could not ${want ? 'enable' : 'disable'} request interception: ${errorText(err)}`);
    }
  }

  /** Aborts everything still being decided, and waits (bounded) until those requests are answered. */
  private async answerAll(target: Target): Promise<void> {
    const entries = [...target.pending.values()];
    for (const e of entries) e.controller.abort();
    await Promise.race([Promise.all(entries.map(e => e.done)), new Promise(resolve => setTimeout(resolve, ANSWER_TIMEOUT_MS))]);
  }

  private track(target: Target, key: string, run: (signal: AbortSignal) => Promise<void>): Promise<void> {
    const controller = new AbortController();
    let finish: () => void = () => {};
    const entry = { controller, done: new Promise<void>(resolve => (finish = resolve)) };
    target.pending.set(key, entry);
    return run(controller.signal).finally(() => {
      if (target.pending.get(key) === entry) target.pending.delete(key);
      finish();
    });
  }

  private onPaused(target: Target, params: any): Promise<void> {
    const request = toPaused(target.page.tabId, params);
    return this.track(target, request.requestId, signal => this.handlePaused(target, request, params, signal));
  }

  private async handlePaused(target: Target, request: PausedRequest, params: any, signal: AbortSignal): Promise<void> {
    let decision: RequestDecision | undefined;
    try {
      // Only the request stage is ever asked for; a response-stage pause would come from someone else.
      if (params.responseStatusCode === undefined && params.responseErrorReason === undefined) {
        for (const client of this.clients) {
          if (!client.onRequest || signal.aborted) continue;
          decision = await withTimeout(Promise.resolve(client.onRequest(request, signal)), DECIDE_TIMEOUT_MS);
          if (decision) break;
        }
        if (decision?.delayMs && decision.delayMs > 0) await sleep(decision.delayMs, decision.cancel ? AbortSignal.any([signal, decision.cancel]) : signal);
        if (decision?.cancel?.aborted) decision = undefined;
      }
    } catch (err) {
      if (!signal.aborted && !decision?.cancel?.aborted) this.log.warn(`${request.tabId}: deciding about ${request.method} ${request.url.slice(0, 200)} failed, letting it through: ${errorText(err)}`);
      decision = undefined;
    }
    if (signal.aborted) decision = undefined;
    await this.answer(target, request, decision);
  }

  private async answer(target: Target, request: PausedRequest, decision: RequestDecision | undefined): Promise<void> {
    const { page } = target;
    if (page.closed) return;
    const requestId = request.requestId;
    const send = (method: string, params: Record<string, unknown>) => page.send(method, { requestId, ...params }, { timeoutMs: ANSWER_TIMEOUT_MS });
    try {
      if (!decision || decision.kind === 'continue') {
        await send('Fetch.continueRequest', decision?.headers ? { headers: toEntries(decision.headers) } : {});
      } else if (decision.kind === 'fulfill') {
        await send('Fetch.fulfillRequest', { responseCode: decision.status, responseHeaders: toEntries(decision.headers), body: Buffer.from(decision.body, 'utf8').toString('base64') });
      } else {
        await send('Fetch.failRequest', { errorReason: decision.reason });
      }
      if (decision?.note && request.networkId) this.interceptEmitter.fire({ tabId: request.tabId, networkId: request.networkId, note: decision.note });
    } catch (err) {
      if (page.closed || /invalid (interception|request) ?id/i.test(errorText(err))) return;
      this.log.warn(`${request.tabId}: answering ${request.url.slice(0, 200)} failed (${errorText(err)}); letting it through unchanged`);
      if (decision && (decision.kind !== 'continue' || decision.headers)) await send('Fetch.continueRequest', {}).then(undefined, () => {});
    }
  }

  private onAuthRequired(target: Target, params: any): Promise<void> {
    const request: AuthRequest = { ...toPaused(target.page.tabId, params), challenge: toChallenge(params.authChallenge) };
    return this.track(target, `auth\u0000${request.requestId}`, signal => this.handleAuth(target, request, signal));
  }

  private async handleAuth(target: Target, request: AuthRequest, signal: AbortSignal): Promise<void> {
    let decision: AuthDecision = { kind: 'default' };
    try {
      const client = this.clients.find(c => c.onAuth && this.guard(c, 'handlesAuth', () => c.handlesAuth?.(request.tabId) ?? false, false));
      if (client?.onAuth) decision = await client.onAuth(request, signal);
    } catch (err) {
      this.log.warn(`${request.tabId}: login handling failed, cancelling the login: ${errorText(err)}`);
      decision = { kind: 'cancel' };
    }
    if (signal.aborted && decision.kind !== 'provide') decision = { kind: 'cancel' };
    if (target.page.closed) return;
    const response =
      decision.kind === 'provide' ? { response: 'ProvideCredentials', username: decision.username, password: decision.password }
      : decision.kind === 'cancel' ? { response: 'CancelAuth' }
      : { response: 'Default' };
    // Never log the params of this call: they hold the credentials.
    await target.page.send('Fetch.continueWithAuth', { requestId: request.requestId, authChallengeResponse: response }, { timeoutMs: ANSWER_TIMEOUT_MS }).then(undefined, err => {
      if (!target.page.closed) this.log.warn(`${request.tabId}: answering a login challenge failed: ${errorText(err).replace(/"(username|password)"\s*:\s*"[^"]*"/g, '"$1":"…"')}`);
    });
  }

  private guard<T>(client: FetchClient, what: string, fn: () => T, fallback: T): T {
    try {
      return fn();
    } catch (err) {
      this.log.warn(`${client.name}.${what} failed: ${errorText(err)}`);
      return fallback;
    }
  }

  private drop(target: Target): void {
    for (const { controller } of target.pending.values()) controller.abort();
    for (const s of target.subscriptions.splice(0)) s.dispose();
    if (this.targets.get(target.page.tabId) === target) this.targets.delete(target.page.tabId);
  }

  dispose(): void {
    this.disposed = true;
    for (const target of [...this.targets.values()]) {
      const wasActive = !!target.applied;
      const answered = this.answerAll(target);
      this.drop(target);
      // Answer what is paused, then hand the domain back.
      if (wasActive && !target.page.closed) void answered.then(() => target.page.send('Fetch.disable', {}, { timeoutMs: ANSWER_TIMEOUT_MS })).then(undefined, () => {});
    }
    this.clients.length = 0;
    this.interceptEmitter.dispose();
    this.noteEmitter.dispose();
  }
}

function toPaused(tabId: string, p: any): PausedRequest {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(p?.request?.headers ?? {})) headers[k] = String(v);
  return {
    tabId,
    requestId: String(p?.requestId),
    networkId: typeof p?.networkId === 'string' ? p.networkId : undefined,
    url: String(p?.request?.url ?? '') + (p?.request?.urlFragment ?? ''),
    method: String(p?.request?.method ?? 'GET'),
    headers,
    resourceType: String(p?.resourceType ?? 'Other'),
    frameId: typeof p?.frameId === 'string' ? p.frameId : undefined,
  };
}

function toChallenge(c: any): AuthChallenge {
  return {
    source: c?.source === 'Proxy' ? 'Proxy' : 'Server',
    origin: String(c?.origin ?? ''),
    scheme: String(c?.scheme ?? '').toLowerCase(),
    realm: String(c?.realm ?? ''),
  };
}

function toEntries(headers: Record<string, string>): Array<{ name: string; value: string }> {
  return Object.entries(headers).map(([name, value]) => ({ name, value: String(value) }));
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('aborted'));
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([promise, new Promise<T>((_, reject) => (timer = setTimeout(() => reject(new Error(`no decision within ${ms / 1000} s`)), ms)))]).finally(() => clearTimeout(timer));
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
