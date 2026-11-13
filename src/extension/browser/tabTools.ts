import { z } from 'zod';
import type { BridgeServices, BrowserTabInfo } from '../core/services';
import type { AgentSession } from '../core/sessions';
import { defineTool } from '../core/tools';

/** One line per tab, written for the agent. */
export function formatTab(tab: BrowserTabInfo, services: BridgeServices, viewer: AgentSession): string {
  const label = (id: string | undefined) => (id === viewer.id ? 'you' : id ? (services.sessions.get(id)?.label ?? 'an ended session') : undefined);
  const notes = [
    tab.origin === 'user' ? 'opened by the user' : `opened by ${label(tab.openedBy) ?? 'an ended session'}`,
    tab.controlledBy ? `controlled by ${label(tab.controlledBy)}` : undefined,
    tab.active ? 'visible' : undefined,
    tab.paused ? 'paused by the user' : undefined,
  ].filter(Boolean);
  return `${tab.id}  ${tab.url}  "${tab.title}"  (${notes.join(', ')})`;
}

/** Tools that manage tabs (as opposed to acting on a page). */
export function registerTabTools(services: BridgeServices): void {
  const { browser, context } = services;
  context.subscriptions.push(
    services.tools.register([
      defineTool({
        name: 'browser_list_tabs',
        title: 'List browser tabs',
        description: "Lists the integrated-browser tabs of this VS Code window: yours, the user's and other agent sessions', with who opened and who controls each.",
        input: {},
        annotations: { readOnlyHint: true },
        handler: (_args, ctx) => {
          const tabs = browser.listTabs();
          if (tabs.length === 0) return 'No browser tabs are open. Open one with browser_open.';
          return tabs.map(t => formatTab(t, services, ctx.session)).join('\n');
        },
      }),
      defineTool({
        name: 'browser_open',
        title: 'Open browser tab',
        description: "Opens a URL in a new tab of VS Code's integrated browser, next to the user's editors. The new tab becomes your current tab.",
        input: {
          url: z.string().describe('URL to open, e.g. "http://localhost:3000".'),
          background: z.boolean().optional().describe('Open without bringing the tab to the front. Default false.'),
        },
        annotations: { openWorldHint: true },
        handler: async (args, ctx) => {
          const tab = await browser.openTab(ctx.session, args.url, { background: args.background });
          return `Opened ${formatTab(tab, services, ctx.session)}`;
        },
      }),
    ]),
  );
}
