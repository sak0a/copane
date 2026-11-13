// Handing a browser tab to the user (browser_request_user_input), the browser's counterpart of
// terminal_request_user_input: the agent says what it needs ("Sign in to Jira"), the tab comes to the
// front and shows the request with Done / Won't do in its page indicator, the user does it in that same
// tab, and the agent continues there. For what an agent must not or cannot do itself: single sign-on
// with MFA, a captcha, a consent screen, a choice only the user can make, a look at the page.
//
// While the user has the tab it is paused (the existing user-takeover state), so no agent can read or
// act in it. The hand-off ends when the agent's `done_when` condition holds (the smooth way for logins:
// the user never clicks anything afterwards), the user clicks Done or Won't do (in the page, in the
// editor title, in the views or in a notification), the timeout passes, the agent cancels, its session
// ends, or the tab closes. Before the pause ends, what the page sent and logged meanwhile is withheld
// and password fields still on the page are emptied (page/privacy.ts).
//
// Getting the user's attention: the tab is brought to the front (unless they are typing in an editor
// right now), the views and status bar count it like a terminal waiting for them, and a notification
// appears only while the tab is out of sight: VS Code pauses a browser view that a notification
// covers, so one over the tab the user should use would be in the way.
import * as vscode from 'vscode';
import { z } from 'zod';
import { ToolError } from '../core/errors';
import { scopedLogger, type Logger } from '../core/log';
import type { BridgeServices, CdpPage } from '../core/services';
import { sessionDisplayName, type AgentSession } from '../core/sessions';
import { defineTool } from '../core/tools';
import { viewIdOf } from './decorations';
import {
  conditionHolds,
  describeOutcome,
  describePage,
  describePrivacy,
  parseProbe,
  probeExpression,
  validateDoneWhen,
  type DoneWhen,
  type HandoffOutcome,
  type PageProbe,
} from './handoffLogic';
import type { PageHooks } from './page';
import type { BrowserServiceImpl } from './service';

const POLL_MS = 500;
/** How long the tab must be out of sight before a notification asks for the user's attention. */
const HIDDEN_NOTIFY_MS = 2000;
/** A matched condition counts once the page has loaded, or after this long if it never finishes loading. */
const SETTLE_MS = 4000;
/** The user counts as typing in an editor if they changed a document this recently: the tab is not brought to the front then. */
const TYPING_MS = 3000;
const DEFAULT_TIMEOUT_S = 600;

const SHOW = 'Show Tab';
const DONE = 'Done';
const DECLINE = "Won't Do";

interface Handoff {
  tabId: string;
  sessionId: string;
  sessionName: string;
  color: string;
  message: string;
  since: number;
  /** Set once it is ending: the tab is still paused while privacy is applied. */
  ending: boolean;
  finish(outcome: HandoffOutcome): void;
}

export class BrowserHandoffs implements vscode.Disposable {
  private readonly active = new Map<string, Handoff>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly log: Logger;
  private lastEditAt = 0;
  private disposed = false;

  constructor(
    private readonly services: BridgeServices,
    private readonly browser: BrowserServiceImpl,
    private readonly page: PageHooks,
  ) {
    this.log = scopedLogger(services.log, 'handoff');
    browser.resolveUserRequest = (tabId, outcome) => this.resolve(tabId, outcome, 'command');
    this.subscriptions.push(
      browser.addTabInfoProvider(tabId => {
        const h = this.active.get(tabId);
        return h && { request: { sessionId: h.sessionId, message: h.message, since: h.since } };
      }),
      browser.addMarkerExtension({
        state: (tabId, current) => {
          const h = this.active.get(tabId);
          // Shown even with copane.browser.pageIndicator off: it is where the user answers.
          return h ? { label: h.sessionName, color: h.color, paused: true, request: h.message } : current;
        },
        onAction: (tabId, action) => {
          const h = this.active.get(tabId);
          if (!h) return false;
          if (action === 'done' || action === 'resume') this.resolve(tabId, 'done', 'page');
          else if (action === 'decline') this.resolve(tabId, 'declined', 'page');
          return true;
        },
      }),
      // Resuming the tab any other way (a command, "Resume Agent on All Its Tabs") ends the hand-off
      // as done, which resumes the tab itself once what the user did is kept private.
      browser.addResumeGuard(tabId => {
        const h = this.active.get(tabId);
        if (!h) return false;
        if (!h.ending) h.finish({ kind: 'done', via: 'resume' });
        return true;
      }),
      browser.addPausedExplainer((tabId, sessionId) => {
        const h = this.active.get(tabId);
        if (!h) return undefined;
        if (h.sessionId === sessionId) {
          return `${tabId} is with the user for your request ("${clip(h.message, 80)}"); browser_request_user_input returns when they are done. Do not use this tab meanwhile; other tabs work.`;
        }
        return `${tabId} is with the user for a request of ${h.sessionName}, so no agent can read or use it until they are done. Use another tab (browser_open) or try later.`;
      }),
      // The tab closed, or the user resumed it some other way (Sessions view, editor title).
      browser.onDidChange(() => {
        for (const h of this.active.values()) {
          if (h.ending) continue;
          const tab = browser.getTab(h.tabId);
          if (!tab) h.finish({ kind: 'closed' });
          else if (!tab.paused) h.finish({ kind: 'done', via: 'resume' });
        }
        this.updateContext();
      }),
      services.sessions.onDidChange(change => {
        if (change.type !== 'removed') return;
        for (const h of this.active.values()) if (h.sessionId === change.session.id) h.finish({ kind: 'session-ended' });
      }),
      vscode.workspace.onDidChangeTextDocument(e => {
        if (e.contentChanges.length && vscode.window.state.focused && (e.document.uri.scheme === 'file' || e.document.uri.scheme === 'untitled')) this.lastEditAt = Date.now();
      }),
      vscode.commands.registerCommand('copane.browser.finishRequest', async (arg?: unknown) => {
        const id = await this.pick(arg);
        if (id) this.resolve(id, 'done', 'command');
      }),
      vscode.commands.registerCommand('copane.browser.declineRequest', async (arg?: unknown) => {
        const id = await this.pick(arg);
        if (id) this.resolve(id, 'declined', 'command');
      }),
    );
    if (browser.available) this.updateContext();
  }

  tools() {
    return [
      defineTool({
        name: 'browser_request_user_input',
        title: 'Hand the browser tab to the user',
        description:
          'Hands a tab to the user for what you must not or cannot do: sign-in (SSO, MFA, passwords), captcha, consent, a choice or check only they can make. ' +
          "Never ask for the user's credentials in chat or sign in as them. You cannot read or use the tab meanwhile. " +
          "Returns when done_when holds, the user clicks Done or Won't do, it times out or the tab closes, with where the page is now.",
        input: {
          message: z.string().min(1).max(300).describe('One or two sentences, e.g. "Sign in to Jira with your company account."'),
          done_when: z
            .object({
              url: z.string().optional().describe('Substring or glob (*) of the URL without query, or /regex/'),
              text: z.string().optional().describe('appears on the page'),
              gone: z.string().optional().describe('text disappears'),
              selector: z.string().optional().describe('element exists'),
            })
            .optional()
            .describe('Ends it by itself once all hold, e.g. {url: "/dashboard"} after sign-in; if it already holds, nothing is handed over.'),
          tab: z.string().optional(),
          timeout_seconds: z.number().min(10).max(3600).optional().describe('Default 600.'),
        },
        handler: (args, ctx) => this.request(ctx.session, args, ctx.signal),
      }),
    ];
  }

  /** Ends a pending hand-off for the user. False when the tab has none. */
  resolve(tabId: string, outcome: 'done' | 'declined', via: 'page' | 'command' | 'notification'): boolean {
    const h = this.active.get(tabId);
    if (!h || h.ending) return false;
    h.finish(outcome === 'done' ? { kind: 'done', via } : { kind: 'declined', via });
    return true;
  }

  dispose(): void {
    // On shutdown or reload the tabs stay paused (that state is saved), so nothing typed becomes readable.
    this.disposed = true;
    for (const h of this.active.values()) h.finish({ kind: 'cancelled' });
    for (const s of this.subscriptions.splice(0)) s.dispose();
    void vscode.commands.executeCommand('setContext', 'copane.browser.waitingForUser', false);
  }

  // ------------------------------------------------------------------ the hand-off

  private async request(
    session: AgentSession,
    args: { message: string; done_when?: DoneWhen; tab?: string; timeout_seconds?: number },
    signal: AbortSignal,
  ): Promise<string> {
    const condition = args.done_when;
    const problem = validateDoneWhen(condition);
    if (problem) throw new ToolError('invalid_input', problem);
    const { tab, page } = await this.browser.acquire(session, args.tab, 'control', signal);
    const tabId = tab.id;

    // Let the page finish loading, then see whether there is anything to do at all.
    const first = await this.waitLoaded(page, condition, false, 3000, signal);
    if (signal.aborted) throw new ToolError('cancelled', 'Cancelled.');
    if (first?.selector === 'invalid') throw new ToolError('invalid_input', `done_when.selector "${condition?.selector}" is not a valid CSS selector.`);
    if (condition && first && conditionHolds(condition, first)) {
      return `done_when already holds in ${tabId}, so nothing was handed to the user. ${describePage(first, tab.url, { kind: 'condition' })}`;
    }

    const mark = this.page.privacy.mark(tabId);
    const startedAt = Date.now();
    let finish!: (outcome: HandoffOutcome) => void;
    const outcomePromise = new Promise<HandoffOutcome>(resolve => {
      let settled = false;
      finish = value => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
    });
    const h: Handoff = {
      tabId,
      sessionId: session.id,
      sessionName: sessionDisplayName(session),
      color: session.color.hex,
      message: args.message,
      since: startedAt,
      ending: false,
      finish: outcome => finish(outcome),
    };
    this.active.set(tabId, h);
    this.log.info(`${session.label} hands ${tabId} to the user: ${args.message}`);
    const timeoutMs = (args.timeout_seconds ?? DEFAULT_TIMEOUT_S) * 1000;
    const timer = setTimeout(() => finish({ kind: 'timeout' }), timeoutMs);
    const onAbort = () => finish({ kind: 'cancelled' });
    signal.addEventListener('abort', onAbort, { once: true });
    const stopWatching = new AbortController();
    let outcome: HandoffOutcome;
    let setupError: unknown;
    try {
      this.browser.setPaused(tabId, true);
      this.cosmetic(() => {
        this.browser.refreshMarker(tabId);
        this.browser.tabInfoChanged();
        this.updateContext();
      });
      // Bring it to the front, unless the user is typing in an editor this moment: then the
      // notification (the tab is out of sight) asks instead of taking their keystrokes.
      if (Date.now() - this.lastEditAt > TYPING_MS) await this.browser.revealTab(tabId).catch(err => this.log.info(`could not bring ${tabId} to the front: ${errorText(err)}`));
      void this.watch(h, page, condition, stopWatching.signal);
      outcome = await outcomePromise;
    } catch (err) {
      setupError = err;
      outcome = { kind: 'cancelled' };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      stopWatching.abort();
    }

    // Before the tab is anyone's again: empty password fields, withhold what was sent meanwhile. Only
    // then does the pause end; if that fails, the tab stays paused (the user can resume it).
    h.ending = true;
    let withheld = { requests: 0, messages: 0 };
    let scrubbed = 0;
    let privacyApplied = false;
    const exists = !this.disposed && !!this.browser.getTab(tabId);
    try {
      if (exists) {
        scrubbed = await this.page.privacy.scrub(tabId).catch(() => 0);
        withheld = this.page.privacy.withhold(tabId, mark);
      }
      privacyApplied = true;
    } catch (err) {
      this.log.warn(`could not withhold what ${tabId} recorded while the user had it, so it stays paused: ${errorText(err)}`);
    } finally {
      // Gone from `active` first, so the resume guard lets the hand-off's own resume through.
      this.active.delete(tabId);
    }
    // On shutdown or reload the tab stays paused (that state is saved), so nothing typed becomes readable.
    if (this.disposed) throw new ToolError('cancelled', 'Cancelled: VS Code is shutting down or reloading.');
    let stillPaused = false;
    if (exists && privacyApplied) {
      try {
        this.browser.setPaused(tabId, false);
      } catch (err) {
        this.log.warn(`could not resume ${tabId} after the hand-off: ${errorText(err)}`);
      }
      // The agent continues where the user left off: it controls the tab again.
      this.cosmetic(() => {
        if (outcome.kind !== 'session-ended' && this.services.sessions.get(session.id)) this.services.tabLeases.acquire(tabId, session.id);
      });
    }
    stillPaused = exists && !!this.browser.getTab(tabId)?.paused;
    this.cosmetic(() => {
      if (exists) this.browser.refreshMarker(tabId);
      this.browser.tabInfoChanged();
      this.updateContext();
    });
    if (setupError) throw setupError;
    let after: PageProbe | undefined;
    const waited = Date.now() - startedAt;
    this.log.info(`hand-off of ${tabId} ended: ${outcome.kind} after ${Math.round(waited / 1000)} s${withheld.requests ? `, ${withheld.requests} requests withheld` : ''}${scrubbed ? `, ${scrubbed} fields emptied` : ''}`);
    if (outcome.kind === 'cancelled' || outcome.kind === 'session-ended') throw new ToolError('cancelled', describeOutcome(outcome, tabId, waited));
    if (outcome.kind !== 'closed' && !page.closed && !stillPaused) {
      after = await this.waitLoaded(page, undefined, true, outcome.kind === 'condition' || outcome.kind === 'done' ? 3000 : 0, signal);
    }
    return [
      describeOutcome(outcome, tabId, waited),
      outcome.kind === 'closed' ? '' : describePage(after, this.browser.getTab(tabId)?.url ?? tab.url, outcome),
      describePrivacy(withheld, scrubbed),
      stillPaused ? `${tabId} stays paused because what the page sent meanwhile could not be withheld; ask the user to resume it when they are ready.` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  /** Checks the condition and whether the tab is in sight until `stop` aborts. */
  private async watch(h: Handoff, page: CdpPage, condition: DoneWhen | undefined, stop: AbortSignal): Promise<void> {
    let metSince: number | undefined;
    let hiddenSince: number | undefined;
    let prompt: AbortController | undefined;
    let dismissed = false;
    const ask = () => {
      const controller = new AbortController();
      prompt = controller;
      const tab = this.browser.getTab(h.tabId);
      const name = tab?.title || hostOf(tab?.url ?? '') || h.tabId;
      void this.services.prompts
        .ask({ message: `${h.sessionName} needs you in the browser tab "${clip(name, 60)}": ${h.message}`, choices: [SHOW, DONE, DECLINE], signal: controller.signal, autoClose: true })
        .then(answer => {
          if (controller.signal.aborted || stop.aborted) return;
          prompt = undefined;
          hiddenSince = undefined;
          if (answer === SHOW) void this.browser.revealTab(h.tabId).catch(err => this.log.info(`could not show ${h.tabId}: ${errorText(err)}`));
          else if (answer === DONE) this.resolve(h.tabId, 'done', 'notification');
          else if (answer === DECLINE) this.resolve(h.tabId, 'declined', 'notification');
          else dismissed = true;
        });
    };
    stop.addEventListener('abort', () => prompt?.abort(), { once: true });
    while (!stop.aborted) {
      const probe = page.closed ? undefined : await this.probe(page, condition, false);
      if (stop.aborted) break;
      const now = Date.now();
      const href = probe?.href ?? this.browser.getTab(h.tabId)?.url ?? '';
      // Without the page (it is between documents), only a URL condition can be checked.
      const holds = condition && (probe ? conditionHolds(condition, probe) : !condition.text && !condition.gone && !condition.selector && conditionHolds(condition, { href }));
      if (holds) {
        metSince ??= now;
        if (probe?.ready === 'complete' || now - metSince >= SETTLE_MS) {
          h.finish({ kind: 'condition' });
          break;
        }
      } else {
        metSince = undefined;
      }
      if (probe && !probe.visible) {
        hiddenSince ??= now;
        if (!prompt && !dismissed && now - hiddenSince >= HIDDEN_NOTIFY_MS) ask();
      } else if (probe?.visible) {
        hiddenSince = undefined;
        if (prompt) {
          prompt.abort(); // The user is looking at the tab: the notification would only cover it.
          prompt = undefined;
        }
      }
      await sleep(POLL_MS, stop);
    }
  }

  /** Probes until the page has loaded (or `waitMs` passes). Undefined when the page cannot be reached. */
  private async waitLoaded(page: CdpPage, condition: DoneWhen | undefined, describe: boolean, waitMs: number, signal: AbortSignal): Promise<PageProbe | undefined> {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const probe = await this.probe(page, condition, describe);
      if ((probe && probe.ready === 'complete') || Date.now() >= deadline || signal.aborted || page.closed) return probe;
      await sleep(200, signal);
    }
  }

  private async probe(page: CdpPage, condition: DoneWhen | undefined, describe: boolean): Promise<PageProbe | undefined> {
    try {
      const r = await page.send<{ result?: { value?: unknown } }>('Runtime.evaluate', { expression: probeExpression(condition, describe), returnByValue: true }, { timeoutMs: 2000 });
      return parseProbe(r.result?.value);
    } catch {
      return undefined; // Between documents, or a dialog blocks the page.
    }
  }

  /** UI refreshes that must never keep a hand-off from ending. */
  private cosmetic(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.log.warn(`hand-off UI update failed: ${errorText(err)}`);
    }
  }

  // ------------------------------------------------------------------ user commands and context

  /** The tab a Done / Won't Do command means: its argument, the active tab, the only one waiting, or the user's pick. */
  private async pick(arg: unknown): Promise<string | undefined> {
    let id: string | undefined;
    if (typeof arg === 'string') id = arg;
    else if (arg instanceof vscode.Uri) id = viewIdOf(arg) ? this.browser.tabIdForViewId(viewIdOf(arg)!) : undefined;
    else if (arg && typeof arg === 'object' && typeof (arg as { id?: unknown }).id === 'string') id = (arg as { id: string }).id;
    if (id && this.active.has(id)) return id;
    const active = this.browser.activeTabId();
    if (active && this.active.has(active)) return active;
    const waiting = [...this.active.values()].filter(h => !h.ending);
    if (waiting.length <= 1) return waiting[0]?.tabId;
    const label = (h: Handoff) => `${h.tabId}: ${clip(h.message, 70)}`;
    const answer = await this.services.prompts.ask({ message: 'Which browser tab request is this about?', choices: waiting.map(label) });
    return waiting.find(h => label(h) === answer)?.tabId;
  }

  private updateContext(): void {
    if (this.disposed) return;
    const active = this.browser.activeTabId();
    void vscode.commands.executeCommand('setContext', 'copane.browser.waitingForUser', this.active.size > 0);
    void vscode.commands.executeCommand('setContext', 'copane.browser.activeTabWaiting', !!active && this.active.has(active));
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
