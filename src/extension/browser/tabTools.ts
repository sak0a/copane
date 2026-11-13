import { z } from 'zod';
import { ToolError } from '../core/errors';
import type { BridgeServices, BrowserTabInfo } from '../core/services';
import { sessionDisplayName, type AgentSession } from '../core/sessions';
import { defineTool } from '../core/tools';
import type { PageHooks } from './page';
import type { BrowserServiceImpl } from './service';

/** One line per tab, written for the agent. */
export function formatTab(tab: BrowserTabInfo, services: BridgeServices, viewer: AgentSession): string {
  const label = (id: string | undefined) => (id === viewer.id ? 'you' : id ? (services.sessions.get(id) ? sessionDisplayName(services.sessions.get(id)!) : 'an ended session') : undefined);
  const notes = [
    tab.origin === 'user' ? 'opened by the user' : `opened by ${label(tab.openedBy) ?? 'an ended session'}${tab.openerTab ? ` from ${tab.openerTab}` : ''}`,
    tab.origin === 'user' && tab.allowedSessions.includes(viewer.id) ? 'shared with you' : undefined,
    tab.controlledBy ? `controlled by ${label(tab.controlledBy)}` : undefined,
    tab.active ? 'in front' : undefined,
    tab.paused ? 'PAUSED by the user' : undefined,
  ].filter(Boolean);
  return `${tab.id}  ${tab.url}  "${tab.title}"  (${notes.join(', ')})`;
}

const tabArg = z.string().optional();

/** Tools that manage tabs (as opposed to acting on a page). */
export function registerTabTools(services: BridgeServices, browser: BrowserServiceImpl, page?: PageHooks): void {
  const { context } = services;
  const requireBrowser = async () => {
    browser.assertAvailable();
    await browser.ready;
  };
  const describe = (tabId: string) => {
    const tab = browser.getTab(tabId);
    if (!tab) throw new ToolError('not_found', `${tabId} was closed. Call browser_list_tabs for the open tabs.`);
    return tab;
  };

  context.subscriptions.push(
    services.tools.register([
      defineTool({
        name: 'browser_list_tabs',
        title: 'List browser tabs',
        description: "Lists this window's browser tabs with who opened and who controls each.",
        input: {},
        annotations: { readOnlyHint: true },
        handler: async (_args, ctx) => {
          await requireBrowser();
          const tabs = browser.listTabs();
          if (tabs.length === 0) return 'No browser tabs are open. Open one with browser_open.';
          const current = browser.currentTabOf(ctx.session.id);
          const lines = tabs.map(t => `${t.id === current ? '* ' : '  '}${formatTab(t, services, ctx.session)}`);
          return `${lines.join('\n')}\n${current ? `* = your current tab (${current}).` : 'You have no current tab: pass `tab`, or call browser_select_tab or browser_open.'}`;
        },
      }),
      defineTool({
        name: 'browser_open',
        title: 'Open browser tab',
        description: 'Opens a URL in a new browser tab, which becomes your current tab, and returns once the page has loaded.',
        input: {
          url: z.string().describe('"localhost:3000" works without a scheme.'),
          background: z.boolean().optional().describe('Do not bring the tab to the front.'),
        },
        annotations: { openWorldHint: true },
        handler: async (args, ctx) => {
          await requireBrowser();
          const url = normalizeUrl(args.url);
          const tab = await browser.openTab(ctx.session, url, { background: args.background });
          // Return once the page has loaded, so the next call (usually a snapshot) reads it, not the empty tab.
          if (page) {
            try {
              return `${await page.describeOpened(ctx, tab.id, url)}\nIt is now your current tab.`;
            } catch (err) {
              if (ctx.signal.aborted) throw err;
              ctx.log.warn(`could not wait for ${tab.id} to load: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
          return `Opened ${formatTab(tab, services, ctx.session)}\nIt is now your current tab.`;
        },
      }),
      defineTool({
        name: 'browser_select_tab',
        title: 'Switch to a browser tab',
        description: 'Makes a tab your current one (for a tab the user opened, asks them first). Does not bring it to the front.',
        input: { tab: z.string().describe('e.g. "tab-3".') },
        annotations: { idempotentHint: true },
        handler: async (args, ctx) => {
          await requireBrowser();
          const { tab } = await browser.acquire(ctx.session, args.tab, 'read', ctx.signal);
          const holder = tab.controlledBy && tab.controlledBy !== ctx.session.id ? services.sessions.get(tab.controlledBy) : undefined;
          const note = holder ? `\n${sessionDisplayName(holder)} controls it right now: you can read it, and act once they release it.` : '';
          return `${tab.id} is now your current tab.\n${formatTab(tab, services, ctx.session)}${note}`;
        },
      }),
      defineTool({
        name: 'browser_show_tab',
        title: 'Show browser tab to the user',
        description: 'Brings a browser tab to the front so the user sees it (focus stays). Only when you want the user to look at it.',
        input: { tab: tabArg },
        handler: async (args, ctx) => {
          await requireBrowser();
          const id = browser.resolveId(ctx.session, args.tab);
          await browser.revealTab(id);
          return `${id} is in front now.`;
        },
      }),
      defineTool({
        name: 'browser_release_tab',
        title: 'Release browser tab',
        description: 'Ends your control of a tab you are done driving, so the user and other sessions can act in it. You can still read it.',
        input: {
          tab: tabArg,
          all: z.boolean().optional().describe('Every tab you control.'),
        },
        annotations: { idempotentHint: true },
        handler: async (args, ctx) => {
          await requireBrowser();
          if (args.all) {
            const released = services.tabLeases.releaseAllOf(ctx.session.id);
            return released.length ? `Released ${released.join(', ')}.` : 'You did not control any tab.';
          }
          const id = browser.resolveId(ctx.session, args.tab);
          const holder = services.tabLeases.holder(id);
          if (holder?.sessionId !== ctx.session.id) return `You did not control ${id}; nothing to release.`;
          browser.releaseTab(id, ctx.session.id);
          return `Released ${id}.`;
        },
      }),
      defineTool({
        name: 'browser_close_tab',
        title: 'Close browser tab',
        description: "Closes a browser tab: yours, an ended session's, or (with their permission) the user's.",
        input: { tab: tabArg },
        annotations: { destructiveHint: true },
        handler: async (args, ctx) => {
          await requireBrowser();
          const id = browser.resolveId(ctx.session, args.tab);
          const rel = browser.relationOf(ctx.session, id);
          if (rel === 'other-session') {
            const owner = services.sessions.get(describe(id).openedBy ?? '');
            throw new ToolError('access_denied', `${id} belongs to ${owner ? sessionDisplayName(owner) : 'another agent session'}; only it (or the user) can close it.`);
          }
          // Same checks as acting in the tab: consent for user tabs, pause, and the lease.
          await browser.acquire(ctx.session, id, 'control', ctx.signal);
          const { title } = describe(id);
          await browser.closeTab(id);
          const current = browser.currentTabOf(ctx.session.id);
          return `Closed ${id} ("${title}").${current ? '' : ' You have no current tab now.'}`;
        },
      }),
    ]),
  );
}

/** "localhost:3000" → "http://localhost:3000"; anything with a scheme is left alone. */
export function normalizeUrl(url: string): string {
  const u = url.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(u) && !/^(localhost|[\w.-]+):\d+(\/|$)/i.test(u)) return u;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(u)) return `http://${u}`;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/|$)/i.test(u)) return `https://${u}`;
  return u;
}
