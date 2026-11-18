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
    tab.profile ? (tab.profile.kind === 'detached' ? 'own login store (its profile ended when VS Code restarted)' : `login profile "${tab.profile.label}"`) : undefined,
    ...(tab.requestRules ?? []).map(r => `${r.rules} request rule${r.rules === 1 ? '' : 's'} by ${label(r.sessionId) ?? 'an ended session'} (browser_route)`),
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
          return `${lines.join('\n')}\n${current ? `* = your current tab (${current}).` : 'You have no current tab: pass `tab`, or call browser_tab {"action":"select"} or browser_open.'}`;
        },
      }),
      defineTool({
        name: 'browser_open',
        title: 'Open browser tab',
        description: 'Opens a URL in a new browser tab, which becomes your current tab, and returns once the page has loaded.',
        input: {
          url: z.string().describe('"localhost:3000" works without a scheme.'),
          background: z.boolean().optional().describe('Do not bring the tab to the front.'),
          profile: z
            .string()
            .optional()
            .describe(
              'Login profile: tabs of one profile share cookies and logins, apart from all other tabs ("dev", "test"; "private" = your own; "default" = the shared store). See browser_profiles for which applies when omitted.',
            ),
        },
        annotations: { openWorldHint: true },
        handler: async (args, ctx) => {
          await requireBrowser();
          const url = normalizeUrl(args.url);
          const tab = await browser.openTab(ctx.session, url, { background: args.background, profile: args.profile });
          const store = browser.openNote?.(tab.id);
          const after = `\nIt is now your current tab.${store ? `\n${store}` : ''}`;
          // Return once the page has loaded, so the next call (usually a snapshot) reads it, not the empty tab.
          if (page) {
            try {
              return `${await page.describeOpened(ctx, tab.id, url)}${after}`;
            } catch (err) {
              if (ctx.signal.aborted) throw err;
              ctx.log.warn(`could not wait for ${tab.id} to load: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
          return `Opened ${formatTab(tab, services, ctx.session)}${after}`;
        },
      }),
      // One tool for the state-changing tab actions; listing stays its own read-only tool, so clients
      // can let it run without asking (it is frequent and harmless) while closing still asks.
      defineTool({
        name: 'browser_tab',
        title: 'Select, show, release or close a browser tab',
        description:
          'Acts on one browser tab. select: make `tab` your current tab (a tab the user opened asks them first). show: bring a tab to the front for the user to look at (focus stays). ' +
          "release: end your control of a tab, or of `all` you control, so the user and other sessions can act; you can still read it. close: close a tab (yours, an ended session's, or the user's with their permission).",
        input: {
          action: z.enum(TAB_ACTIONS),
          tab: tabArg,
          all: z.boolean().optional(),
        },
        annotations: { destructiveHint: true },
        handler: async (args, ctx) => {
          await requireBrowser();
          const problem = tabActionProblem(args);
          if (problem) throw new ToolError('invalid_input', problem);
          switch (args.action) {
            case 'select': {
              const { tab } = await browser.acquire(ctx.session, args.tab!, 'read', ctx.signal);
              const holder = tab.controlledBy && tab.controlledBy !== ctx.session.id ? services.sessions.get(tab.controlledBy) : undefined;
              const note = holder ? `\n${sessionDisplayName(holder)} controls it right now: you can read it, and act once they release it.` : '';
              return `${tab.id} is now your current tab.\n${formatTab(tab, services, ctx.session)}${note}`;
            }
            case 'show': {
              const id = browser.resolveId(ctx.session, args.tab);
              await browser.revealTab(id);
              return `${id} is in front now.`;
            }
            case 'release': {
              if (args.all) {
                const released = services.tabLeases.releaseAllOf(ctx.session.id);
                const extra = browser.runReleaseHooks(ctx.session.id, browser.listTabs().map(t => t.id));
                return [released.length ? `Released ${released.join(', ')}.` : 'You did not control any tab.', ...extra].join(' ');
              }
              const id = browser.resolveId(ctx.session, args.tab);
              const holder = services.tabLeases.holder(id);
              const extra = browser.runReleaseHooks(ctx.session.id, [id]);
              if (holder?.sessionId !== ctx.session.id) return [`You did not control ${id}; nothing to release.`, ...extra].join(' ');
              browser.releaseTab(id, ctx.session.id);
              return [`Released ${id}.`, ...extra].join(' ');
            }
            case 'close': {
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
            }
          }
        },
      }),
    ]),
  );
}

const TAB_ACTIONS = ['select', 'show', 'release', 'close'] as const;

/**
 * Why a browser_tab call cannot be done as asked, or undefined. `all` belongs to release only, so a
 * close never acts on more tabs than the one meant; select needs the tab to switch to.
 */
export function tabActionProblem(args: { action: (typeof TAB_ACTIONS)[number]; tab?: string; all?: boolean }): string | undefined {
  if (args.action === 'select' && !args.tab) return 'browser_tab {"action":"select"} needs `tab`, the id of the tab to switch to (e.g. "tab-3"; browser_list_tabs shows them). Nothing was done.';
  if (args.all !== undefined && args.action !== 'release') return `\`all\` goes only with {"action":"release"}; browser_tab {"action":"${args.action}"} acts on one tab: pass \`tab\`, or omit it for your current tab. Nothing was done.`;
  if (args.all && args.tab) return 'browser_tab {"action":"release"} takes `tab` or `all`, not both. Nothing was done.';
  return undefined;
}

/** "localhost:3000" →"http://localhost:3000"; anything with a scheme is left alone. */
export function normalizeUrl(url: string): string {
  const u = url.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(u) && !/^(localhost|[\w.-]+):\d+(\/|$)/i.test(u)) return u;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(u)) return `http://${u}`;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/|$)/i.test(u)) return `https://${u}`;
  return u;
}
