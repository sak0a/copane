import { z } from 'zod';
import { ToolError } from '../core/errors';
import type { BridgeServices, BrowserTabInfo } from '../core/services';
import { sessionDisplayName, type AgentSession } from '../core/sessions';
import { defineTool } from '../core/tools';
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

const tabArg = z.string().optional().describe('Tab id, e.g. "tab-3" (see browser_list_tabs). Defaults to your current tab.');

/** Tools that manage tabs (as opposed to acting on a page). */
export function registerTabTools(services: BridgeServices, browser: BrowserServiceImpl): void {
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
        description:
          "Lists the integrated-browser tabs of this VS Code window: yours, the user's and other agent sessions', with who opened each, who controls it, and which one is your current tab. Tabs the user opened need their permission before you use them (asked on first use); tabs another session controls you can only read.",
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
        description:
          "Opens a URL in a new tab of VS Code's integrated browser, next to the user's editors, without taking keyboard focus. The tab is yours (no permission needed), becomes your current tab, and shows the user that you control it.",
        input: {
          url: z.string().describe('URL to open, e.g. "http://localhost:3000". A bare host like "localhost:3000" gets http://.'),
          background: z.boolean().optional().describe('Open without bringing the tab to the front. Default false.'),
        },
        annotations: { openWorldHint: true },
        handler: async (args, ctx) => {
          await requireBrowser();
          const tab = await browser.openTab(ctx.session, normalizeUrl(args.url), { background: args.background });
          return `Opened ${formatTab(tab, services, ctx.session)}\nIt is now your current tab.`;
        },
      }),
      defineTool({
        name: 'browser_select_tab',
        title: 'Switch to a browser tab',
        description:
          "Makes a tab your current one, so later browser tools act on it without `tab`. For a tab the user opened, this is where VS Code asks the user for permission; if they decline, do not ask again. Does not bring the tab to the front (see browser_show_tab) and does not take control from another session.",
        input: { tab: z.string().describe('Tab id, e.g. "tab-3" (see browser_list_tabs).') },
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
        description:
          'Brings a browser tab to the front in the editor area so the user can see it (keyboard focus stays where it is). Use it when you want the user to look at something; do not call it before every action, since it changes what the user sees.',
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
        description:
          'Ends your control of a tab when you are done acting in it: the indicator disappears for the user, and other sessions may act in it. You can still read it, and acting in it again takes control again. Release tabs you no longer drive, especially ones the user opened.',
        input: {
          tab: tabArg,
          all: z.boolean().optional().describe('Release every tab you control.'),
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
        description:
          "Closes a browser tab. You may close your own tabs and tabs of sessions that have ended. A tab the user opened needs their permission and must not be controlled by another session; another live session's tab cannot be closed.",
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
