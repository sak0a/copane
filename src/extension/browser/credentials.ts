// Login prompts for sites and proxies that ask for credentials (HTTP 401 with WWW-Authenticate, or 407
// from a proxy: Basic, Digest, NTLM, Negotiate) in tabs an agent session is driving. VS Code's browser
// cancels every such challenge itself, so the page just fails; here the bridge answers instead: the user
// is asked in VS Code, types the login into a masked input, and the request continues.
//
// Rules: only tabs a session controls (like certificate errors), never silently for a space the user
// has not answered, asked once per site or proxy and realm, remembered for the window and optionally
// across restarts (secret storage), one re-ask after a rejected login, and the agent never sees what was
// typed: it gets a sentence saying what happened.
import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import type { Disposable } from '../core/events';
import type { BridgeServices, CdpPage } from '../core/services';
import { sessionDisplayName } from '../core/sessions';
import type { AuthDecision, AuthRequest, FetchClient, FetchInterception, FetchPattern } from './interception';
import { describeChallenge, displayHost, LoginBook, loginKey, sentInClear, type Login } from './logins';

const ASK_TIMEOUT_MS = 120_000;
const REFUSE_MS = 60_000;
const LOG_IN = 'Log In…';
const LOG_IN_REMEMBER = 'Log In and Remember…';
const CANCEL = 'Cancel';

/**
 * Every request of a driven tab is paused at the request stage: login challenges are only reported for
 * paused requests (a response-stage pattern gets none), and a challenge can come from any request (an
 * API call of the page, a proxy). Measured cost: see README / report; tabs no session drives pay nothing.
 */
const PATTERNS: FetchPattern[] = [{ urlPattern: '*' }];

interface SavedIndexEntry {
  id: string;
  source: 'Server' | 'Proxy';
  origin: string;
  scheme: string;
  realm: string;
  savedAt: number;
}

const INDEX_KEY = 'copane.browser.savedLogins';

/** Logins saved across restarts: the secret in `context.secrets`, a list without secrets in globalState. */
class SavedLogins {
  constructor(private readonly context: vscode.ExtensionContext) {}

  private id(key: string): string {
    return createHash('sha256').update(key).digest('hex').slice(0, 32);
  }

  private secretKey(id: string): string {
    return `copane.browser.login.${id}`;
  }

  list(): SavedIndexEntry[] {
    return this.context.globalState.get<SavedIndexEntry[]>(INDEX_KEY, []);
  }

  async get(key: string): Promise<Login | undefined> {
    const id = this.id(key);
    if (!this.list().some(e => e.id === id)) return undefined;
    try {
      const raw = await this.context.secrets.get(this.secretKey(id));
      const value = raw ? JSON.parse(raw) : undefined;
      return value && typeof value.username === 'string' && typeof value.password === 'string' ? { username: value.username, password: value.password } : undefined;
    } catch {
      return undefined;
    }
  }

  async save(key: string, challenge: AuthRequest['challenge'], login: Login): Promise<void> {
    const id = this.id(key);
    await this.context.secrets.store(this.secretKey(id), JSON.stringify(login));
    const entry: SavedIndexEntry = { id, source: challenge.source, origin: challenge.origin, scheme: challenge.scheme, realm: challenge.realm, savedAt: Date.now() };
    await this.context.globalState.update(INDEX_KEY, [...this.list().filter(e => e.id !== id), entry]);
  }

  async delete(key: string): Promise<void> {
    await this.deleteIds([this.id(key)]);
  }

  async deleteIds(ids: string[]): Promise<number> {
    const set = new Set(ids);
    const list = this.list();
    for (const id of set) await this.context.secrets.delete(this.secretKey(id)).then(undefined, () => {});
    await this.context.globalState.update(INDEX_KEY, list.filter(e => !set.has(e.id)));
    return list.filter(e => set.has(e.id)).length;
  }
}

interface PendingAsk {
  promise: Promise<{ login: Login; remember: boolean } | undefined>;
  controller: AbortController;
  waiters: number;
}

export class CredentialPrompts implements FetchClient, vscode.Disposable {
  readonly name = 'credentials';
  private readonly book = new LoginBook(REFUSE_MS);
  private readonly saved: SavedLogins;
  private readonly asking = new Map<string, PendingAsk>();
  /** Login challenges being decided per tab: interception stays on for them even if the tab's lease ends. */
  private readonly busy = new Map<string, number>();
  private readonly subscriptions: Disposable[] = [];

  constructor(
    private readonly services: BridgeServices,
    private readonly interception: FetchInterception,
  ) {
    this.saved = new SavedLogins(services.context);
    this.subscriptions.push(
      interception.register(this),
      services.tabLeases.onDidChange(change => interception.refresh(change.resourceId)),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('copane.browser.loginPrompts')) interception.refresh();
      }),
      vscode.commands.registerCommand('copane.browser.forgetLogins', () => this.forgetAll()),
    );
  }

  private get enabled(): boolean {
    return vscode.workspace.getConfiguration('copane.browser').get<boolean>('loginPrompts', true);
  }

  /** A session drives the tab (holds its lease), so a login challenge there is the agent's to resolve. */
  private inScope(tabId: string): boolean {
    const holder = this.services.tabLeases.holder(tabId);
    return this.enabled && !!holder && !!this.services.sessions.get(holder.sessionId);
  }

  patterns(tabId: string): FetchPattern[] {
    return this.handlesAuth(tabId) ? PATTERNS : [];
  }

  handlesAuth(tabId: string): boolean {
    return this.inScope(tabId) || (this.busy.get(tabId) ?? 0) > 0;
  }

  /**
   * A tab opened with a URL starts loading before the bridge attaches to it, so a site that answers
   * fast has already sent its 401 (cancelled by VS Code) when interception starts. If the page an
   * agent opened is such an answer, load it again once: this time the challenge comes here.
   */
  onAttached(page: CdpPage): void {
    // Only tabs an agent opened (browser_open, or a popup of its page): those were loaded with a GET.
    // A user's tab may show the answer to a form it posted, which must not be sent again.
    if (!this.inScope(page.tabId) || this.services.browser.getTab(page.tabId)?.origin !== 'agent') return;
    void this.recoverFirstChallenge(page).catch(err => this.services.log.debug(`${page.tabId}: could not check the first response: ${err instanceof Error ? err.message : String(err)}`));
  }

  private async recoverFirstChallenge(page: CdpPage): Promise<void> {
    const expression = `new Promise(resolve => {
      const done = () => { const n = performance.getEntriesByType('navigation')[0]; resolve(JSON.stringify({ status: n ? n.responseStatus || 0 : 0, url: location.href })); };
      if (document.readyState === 'complete') done(); else { addEventListener('load', done, { once: true }); setTimeout(done, 5000); }
    })`;
    for (let attempt = 0; attempt < 10 && !page.closed; attempt++) {
      const { result } = await page.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, { timeoutMs: 8000 });
      const { status, url } = JSON.parse(String(result?.value ?? '{}')) as { status: number; url: string };
      const expected = this.services.browser.getTab(page.tabId)?.url ?? '';
      // Still the blank document a new tab starts with: the real page has not committed yet.
      if (url === 'about:blank' && expected && !expected.startsWith('about:')) {
        await new Promise(resolve => setTimeout(resolve, 300));
        continue;
      }
      if ((status === 401 || status === 407) && /^https?:/.test(url) && this.inScope(page.tabId)) {
        this.services.log.info(`${page.tabId}: the page answered ${status} before the bridge attached; reloading it once so the login can be asked`);
        await page.send('Page.reload', {}, { timeoutMs: 5000 }).then(undefined, () => {});
      }
      return;
    }
  }

  async onAuth(request: AuthRequest, signal: AbortSignal): Promise<AuthDecision> {
    const { tabId } = request;
    this.busy.set(tabId, (this.busy.get(tabId) ?? 0) + 1);
    try {
      return await this.decide(request, signal);
    } finally {
      const left = (this.busy.get(tabId) ?? 1) - 1;
      if (left > 0) this.busy.set(tabId, left);
      else this.busy.delete(tabId);
      if (left <= 0) this.interception.refresh(tabId);
    }
  }

  private async decide(request: AuthRequest, signal: AbortSignal): Promise<AuthDecision> {
    const { tabId, challenge } = request;
    const key = loginKey(challenge);
    const who = describeChallenge(challenge);
    // A later note about the same login replaces an earlier one in the agent's next result.
    const topic = `login\u0000${key}`;
    const saved = await this.saved.get(key);
    const verdict = this.book.onChallenge(key, request.requestId, saved);
    if (verdict.action === 'provide') {
      this.book.provided(key, request.requestId, verdict.login, verdict.origin);
      this.services.log.info(`${tabId}: answered a login challenge from ${who} with the login ${verdict.origin === 'saved' ? 'saved' : 'entered earlier in this window'}`);
      return { kind: 'provide', ...verdict.login };
    }
    if (verdict.action === 'refuse') {
      this.interception.note(
        tabId,
        verdict.reason === 'rejected-twice'
          ? `${capitalize(who)} rejected the login the user entered again, so the bridge stopped asking${challenge.source === 'Proxy' ? ' (the tab shows an error)' : ' and the page shows the error the site sent'}. Do not retry: tell the user, who may need to check their account.`
          : `${capitalize(who)} asked for a login again; the user declined a moment ago, so it was cancelled without asking. Do not retry in a loop: ask the user in chat whether to try again (they are asked again after a minute).`,
        { topic },
      );
      return { kind: 'cancel' };
    }
    if (verdict.rejected?.origin === 'saved') await this.saved.delete(key).then(undefined, () => {});

    let pending = this.asking.get(key);
    // Requests that challenge for the same space while the user is being asked share the prompt; only
    // the first one tells the agent, so it reads each outcome once.
    const first = !pending;
    if (!pending) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ASK_TIMEOUT_MS);
      this.interception.note(
        tabId,
        `${capitalize(who)} asks for a login${verdict.rejected ? ' again: the login it was given was rejected' : ''}. The user is being asked for it in VS Code (up to ${ASK_TIMEOUT_MS / 60_000} minutes), and the page waits until they answer. Do not navigate again meanwhile; check the page later with browser_snapshot or browser_wait_for.`,
        { topic },
      );
      const promise = this.askUser(request, verdict.rejected?.username, controller.signal).finally(() => {
        clearTimeout(timer);
        if (this.asking.get(key) === pending) this.asking.delete(key);
      });
      pending = { promise, controller, waiters: 0 };
      this.asking.set(key, pending);
    }
    const ask = pending;
    ask.waiters++;
    // The prompt goes away when every request waiting on it is gone (tab closed, session ended).
    const onAbort = () => {
      if (--ask.waiters <= 0) ask.controller.abort();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    let answer: Awaited<PendingAsk['promise']>;
    try {
      answer = await ask.promise;
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
    if (signal.aborted) return { kind: 'cancel' };
    if (!answer) {
      this.book.refuse(key);
      if (first) this.interception.note(
        tabId,
        `${capitalize(who)} asked for a login and the user declined or did not answer${challenge.source === 'Proxy' ? ', so nothing could be loaded through it (the tab shows an error)' : '; the page shows the error the site sent (HTTP 401)'}. Do not retry in a loop: ask the user in chat whether you should try again.`,
        { topic },
      );
      if (first) this.services.log.info(`${tabId}: login for ${who} not provided`);
      return { kind: 'cancel' };
    }
    this.book.provided(key, request.requestId, answer.login, 'typed');
    if (first) this.interception.note(tabId, `${capitalize(who)} asked for a login; the user entered one${answer.remember ? ' (saved for later)' : ''} and the page continues loading.`, { topic });
    if (first) this.services.log.info(`${tabId}: login for ${who} provided by the user${answer.remember ? ' and saved' : ''}`);
    return { kind: 'provide', ...answer.login };
  }

  /** The notification, then the user name and password inputs. Undefined when declined, dismissed or timed out. */
  private async askUser(request: AuthRequest, rejectedUser: string | undefined, signal: AbortSignal): Promise<{ login: Login; remember: boolean } | undefined> {
    const { challenge, tabId } = request;
    const key = loginKey(challenge);
    const holder = this.services.tabLeases.holder(tabId);
    const session = holder && this.services.sessions.get(holder.sessionId);
    const agent = session ? sessionDisplayName(session) : 'An agent session';
    const pageHost = displayHost(request.url);
    const subject =
      challenge.source === 'Proxy'
        ? `The proxy ${displayHost(challenge.origin)} asks for a login${challenge.realm ? ` (realm "${challenge.realm}")` : ''} while ${agent} loads ${pageHost}.`
        : `${displayHost(challenge.origin)} asks for a login${challenge.realm ? ` (realm "${challenge.realm}")` : ''} in the tab ${agent} is using.`;
    const rejected = rejectedUser !== undefined ? `The login${rejectedUser ? ` for "${rejectedUser}"` : ''} was not accepted. ` : '';
    const clear = sentInClear(challenge) ? ' It is sent unencrypted (plain HTTP).' : '';
    const choice = await this.services.prompts.ask({
      message: `${rejected}${subject} The agent will not see what you type.${clear}`,
      choices: [LOG_IN, LOG_IN_REMEMBER, CANCEL],
      signal,
      autoClose: true,
    });
    if (choice !== LOG_IN && choice !== LOG_IN_REMEMBER) return undefined;
    const input = this.services.prompts.input;
    if (!input) return undefined;
    const title = `Login for ${challenge.source === 'Proxy' ? 'the proxy ' : ''}${displayHost(challenge.origin)}${challenge.realm ? ` (${challenge.realm})` : ''}`;
    const username = await input.call(this.services.prompts, {
      title,
      prompt: challenge.scheme === 'ntlm' || challenge.scheme === 'negotiate' ? 'User name (DOMAIN\\user or user@domain)' : 'User name',
      value: rejectedUser || this.book.usernameFor(key),
      signal,
    });
    if (username === undefined || signal.aborted) return undefined;
    const password = await input.call(this.services.prompts, { title, prompt: `Password for ${username}`, password: true, signal });
    if (password === undefined || signal.aborted) return undefined;
    const login = { username, password };
    const remember = choice === LOG_IN_REMEMBER;
    if (remember) {
      await this.saved.save(key, challenge, login).then(undefined, err => {
        this.services.log.warn(`could not save the login for ${describeChallenge(challenge)}: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
    return { login, remember };
  }

  /** Command: forgets the logins saved across restarts and those entered in this window. Returns how many were saved. */
  async forgetAll(): Promise<number> {
    const saved = this.saved.list();
    const count = await this.saved.deleteIds(saved.map(e => e.id));
    this.book.forget();
    void vscode.window.showInformationMessage(
      count ? `Forgot ${count} saved browser login${count === 1 ? '' : 's'} (${saved.map(e => displayHost(e.origin)).join(', ')}) and the logins entered in this window. Pages may still be logged in until VS Code restarts.` : 'No browser logins were saved. Logins entered in this window are forgotten too; pages may still be logged in until VS Code restarts.',
    );
    return count;
  }

  dispose(): void {
    for (const ask of this.asking.values()) ask.controller.abort();
    for (const s of this.subscriptions.splice(0)) s.dispose();
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
