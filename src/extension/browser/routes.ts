// Request mocking for agents (browser_route): make requests of a tab get a canned response, fail with
// a network error, be held back, or go out with changed headers, to see how a page copes.
//
// Rules belong to the session that set them and to one tab. They end when that session releases the
// tab (browser_release_tab), when another session takes control of the tab, when the session ends,
// when the tab closes, or when the user removes them (command). An idle lease alone does not end them,
// so a rule survives while the agent edits code between page loads; the UI shows that a tab has rules.
// Only the session controlling a tab can add rules to it, so at any time one session's rules apply.
import * as vscode from 'vscode';
import { z } from 'zod';
import { ToolError } from '../core/errors';
import type { Disposable } from '../core/events';
import type { BridgeServices, BrowserTabInfo } from '../core/services';
import { sessionDisplayName } from '../core/sessions';
import { defineTool, type ToolDefinition } from '../core/tools';
import type { FetchClient, FetchInterception, FetchPattern, PausedRequest, RequestDecision } from './interception';
import { tabArg } from './page/schema';
import { decisionFor, describeRule, FAIL_REASONS, fetchPatternFor, MAX_DELAY_MS, ruleMatches, validateRoute, type FailReason, type RouteRule } from './routeRules';
import type { BrowserServiceImpl } from './service';

export class RequestRoutes implements FetchClient, vscode.Disposable {
  readonly name = 'routes';
  /** Newest last; matching goes newest first. */
  private readonly rules: RouteRule[] = [];
  private nextId = 1;
  private readonly subscriptions: Disposable[] = [];

  constructor(
    private readonly services: BridgeServices,
    private readonly browser: BrowserServiceImpl,
    private readonly interception: FetchInterception,
  ) {
    this.subscriptions.push(
      interception.register(this),
      browser.addTabInfo(tabId => this.tabInfo(tabId)),
      browser.addReleaseHook((sessionId, tabIds) => {
        const removed = this.removeWhere(r => r.sessionId === sessionId && tabIds.includes(r.tabId));
        return removed.length ? `Your request rules there (${removed.map(r => r.id).join(', ')}) were removed.` : undefined;
      }),
      services.sessions.onDidChange(change => {
        if (change.type === 'removed') this.removeWhere(r => r.sessionId === change.session.id);
      }),
      services.tabLeases.onDidChange(change => {
        // Another session took control: the previous session's rules would surprise it.
        const taker = change.lease?.sessionId;
        if (!taker) return;
        const removed = this.removeWhere(r => r.tabId === change.resourceId && r.sessionId !== taker);
        if (removed.length) {
          const owner = this.services.sessions.get(removed[0]!.sessionId);
          this.interception.note(change.resourceId, `Request rules that ${owner ? sessionDisplayName(owner) : 'another session'} had set on ${change.resourceId} (${removed.map(r => r.id).join(', ')}) were removed when you took control.`, { to: taker });
          for (const [sessionId, rules] of groupBy(removed, r => r.sessionId)) {
            this.interception.note(change.resourceId, `Your request rules on ${change.resourceId} (${rules.map(r => r.id).join(', ')}) were removed: another session took control of the tab.`, { to: sessionId });
          }
        }
      }),
      browser.onDidChange(() => {
        // Tabs that closed take their rules with them.
        const gone = new Set(this.rules.filter(r => !browser.getTab(r.tabId)).map(r => r.tabId));
        if (gone.size) this.removeWhere(r => gone.has(r.tabId));
      }),
      vscode.commands.registerCommand('copane.browser.removeRequestRules', (arg?: string | { id?: string }) => this.removeForUser(arg)),
    );
  }

  patterns(tabId: string): FetchPattern[] {
    return this.rules.filter(r => r.tabId === tabId).map(r => fetchPatternFor(r.url));
  }

  onRequest(request: PausedRequest): RequestDecision | undefined {
    for (let i = this.rules.length - 1; i >= 0; i--) {
      const rule = this.rules[i]!;
      if (rule.tabId !== request.tabId || !ruleMatches(rule, request)) continue;
      rule.hits++;
      const owner = this.services.sessions.get(rule.sessionId);
      const decision = { ...decisionFor(rule, request, owner ? owner.label : ''), cancel: rule.ended?.signal };
      // A rule used up by this request still answers it (the decision does not get cancelled).
      if (rule.remaining !== undefined && --rule.remaining <= 0) this.removeWhere(r => r === rule, { keepHeld: true });
      return decision;
    }
    return undefined;
  }

  /** For BrowserTabInfo.requestRules. */
  private tabInfo(tabId: string): Partial<BrowserTabInfo> {
    const counts = new Map<string, number>();
    for (const r of this.rules) if (r.tabId === tabId) counts.set(r.sessionId, (counts.get(r.sessionId) ?? 0) + 1);
    return counts.size ? { requestRules: [...counts].map(([sessionId, rules]) => ({ sessionId, rules })) } : {};
  }

  private removeWhere(predicate: (r: RouteRule) => boolean, options: { keepHeld?: boolean } = {}): RouteRule[] {
    const removed = this.rules.filter(predicate);
    if (!removed.length) return removed;
    for (const r of removed) {
      this.rules.splice(this.rules.indexOf(r), 1);
      if (!options.keepHeld) r.ended?.abort();
    }
    for (const tabId of new Set(removed.map(r => r.tabId))) this.interception.refresh(tabId);
    this.browser.notifyChanged();
    return removed;
  }

  /** Command for the user: removes every rule on a tab (argument: tab id or a tab item), or on all tabs. */
  private removeForUser(arg?: string | { id?: string }): number {
    const tabId = typeof arg === 'string' ? arg : arg?.id;
    const removed = this.removeWhere(r => tabId === undefined || r.tabId === tabId);
    for (const r of removed) {
      this.interception.note(r.tabId, `The user removed your request rules on ${r.tabId} (${removed.filter(o => o.tabId === r.tabId && o.sessionId === r.sessionId).map(o => o.id).join(', ')}); its requests go to the network normally again.`, { to: r.sessionId, topic: `rules-removed\u0000${r.tabId}` });
    }
    void vscode.window.showInformationMessage(removed.length ? `Removed ${removed.length} request rule${removed.length === 1 ? '' : 's'}${tabId ? ` from ${tabId}` : ''}.` : 'No request rules were active.');
    return removed.length;
  }

  tools(): ToolDefinition<any>[] {
    const failNames = Object.keys(FAIL_REASONS) as [FailReason, ...FailReason[]];
    return [
      defineTool({
        name: 'browser_route',
        title: 'Mock network requests',
        description:
          'Mocks requests of a tab to test how the page handles errors, canned data or slow responses. "add": requests matching url (and method) get a response (status/headers/body), fail with a network error (fail), or are sent on after delay and/or with setHeaders; the newest matching rule wins. "list" shows the tab\'s rules, "remove" deletes one (id) or all of yours. Rules last until you release the tab or your session ends; mocked requests are marked in browser_network_requests.',
        input: {
          action: z.enum(['add', 'list', 'remove']),
          url: z.string().optional().describe('Glob over the whole URL (* = anything, e.g. "*/api/cart*"), /regex/, or substring.'),
          method: z.string().optional(),
          status: z.number().int().min(100).max(599).optional().describe('Default 200.'),
          headers: z.record(z.string(), z.string()).optional().describe('Response headers. Content-Type defaults to JSON or text from the body.'),
          body: z.string().optional(),
          fail: z.enum(failNames).optional(),
          delay: z.number().int().min(0).max(MAX_DELAY_MS).optional().describe('Milliseconds to hold each request first.'),
          setHeaders: z.record(z.string(), z.string().nullable()).optional().describe('Request headers to set (null removes).'),
          times: z.number().int().min(1).optional().describe('Remove the rule after this many requests.'),
          id: z.string().optional().describe('For remove.'),
          tab: tabArg,
        },
        handler: async (args, ctx) => {
          if (args.action === 'add') {
            const validation = validateRoute(args);
            if (!validation.ok) throw new ToolError('invalid_input', validation.error);
            const { tab } = await this.services.browser.acquire(ctx.session, args.tab, 'control', ctx.signal);
            const rule: RouteRule = { ...validation.rule, id: `m${this.nextId++}`, sessionId: ctx.session.id, tabId: tab.id, ended: new AbortController() };
            this.rules.push(rule);
            this.interception.refresh(tab.id);
            this.browser.notifyChanged();
            return `Added ${describeRule(rule)} on ${tab.id}. It applies to requests from now on (not to responses the page already has); reload or repeat the action that loads the data. Remove it with action "remove" when done.`;
          }
          const { tab } = await this.services.browser.acquire(ctx.session, args.tab, 'read', ctx.signal);
          if (args.action === 'remove') {
            const id = args.id?.trim().replace(/^#/, '');
            if (id && !this.rules.some(r => r.id === id && r.tabId === tab.id && r.sessionId === ctx.session.id)) {
              const other = this.rules.find(r => r.id === id);
              throw new ToolError('not_found', other ? `${id} is ${other.sessionId === ctx.session.id ? `on ${other.tabId}; pass tab: "${other.tabId}"` : 'not one of your rules'}.` : `There is no rule ${id}. List them with action "list".`);
            }
            const removed = this.removeWhere(r => r.tabId === tab.id && r.sessionId === ctx.session.id && (!id || r.id === id));
            return removed.length ? `Removed ${removed.map(r => r.id).join(', ')} from ${tab.id}.` : `You have no request rules on ${tab.id}.`;
          }
          const mine = this.rules.filter(r => r.tabId === tab.id && r.sessionId === ctx.session.id).reverse();
          const others = this.rules.filter(r => r.tabId === tab.id && r.sessionId !== ctx.session.id);
          const lines = mine.length ? [`Your request rules on ${tab.id}, newest (winning) first:`, ...mine.map(describeRule)] : [`You have no request rules on ${tab.id}.`];
          for (const [sessionId, rules] of groupBy(others, r => r.sessionId)) {
            const s = this.services.sessions.get(sessionId);
            lines.push(`${s ? sessionDisplayName(s) : 'Another session'} has ${rules.length} rule${rules.length === 1 ? '' : 's'} here: ${rules.map(describeRule).join('; ')}`);
          }
          return lines.join('\n');
        },
      }),
    ];
  }

  dispose(): void {
    this.rules.length = 0;
    for (const s of this.subscriptions.splice(0)) s.dispose();
  }
}

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = map.get(k);
    if (list) list.push(item);
    else map.set(k, [item]);
  }
  return map;
}
