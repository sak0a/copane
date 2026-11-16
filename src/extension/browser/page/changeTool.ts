// browser_check_change: a baseline of a tab before the agent edits code, then a check of what the
// update did (change.ts).
import { z } from 'zod';
import { ToolError } from '../../core/errors';
import { defineTool, type ToolDefinition } from '../../core/tools';
import { withPage, type PageCall, type PageEnv } from './call';
import { ChangeBaselines, checkChange, takeBaseline } from './change';
import { tabArg } from './schema';

export function changeTools(env: PageEnv, options: { locate?: (call: PageCall, location: string) => Promise<string | undefined> } = {}): ToolDefinition<any>[] {
  const baselines = new ChangeBaselines(tabId => Boolean(env.services.browser.getTab(tabId)));
  env.services.context.subscriptions.push(
    env.services.sessions.onDidChange(change => {
      if (change.type === 'removed') baselines.dropSession(change.session.id);
    }),
  );
  return [
    defineTool({
      name: 'browser_check_change',
      title: 'Check page after a code change',
      description:
        'Before you edit code, action "baseline" records the tab (screenshot, errors, failed requests, URL). After the edit, "check" waits for the hot update or reload to settle and reports only what changed: new errors with source locations, failed requests, navigation or crash, changed screenshot regions.',
      input: {
        action: z.enum(['baseline', 'check']),
        reload: z.boolean().optional().describe('check: reload first, for pages without hot reload.'),
        timeout: z.number().min(1).max(60).optional().describe('check: seconds to wait for the update, default 15.'),
        tab: tabArg,
      },
      handler: (args, ctx) => {
        if (args.action === 'baseline' && (args.reload !== undefined || args.timeout !== undefined)) throw new ToolError('invalid_input', 'reload and timeout apply to "check" only.');
        const check = args.action === 'check';
        // A check must also report a page that crashed, which ensureReady would refuse.
        return withPage(env, ctx, args.tab, { access: check && args.reload ? 'control' : 'read', skipReady: check }, async call => {
          if (!check) return takeBaseline(call, baselines);
          const base = baselines.get(call.sessionTabKey);
          if (!base) throw new ToolError('invalid_input', `No baseline for ${call.tab.id} in this session. Call browser_check_change with action "baseline" before editing, then "check" after.`);
          return checkChange(call, base, { reload: Boolean(args.reload), timeoutMs: (args.timeout ?? 15) * 1000, locate: options.locate });
        });
      },
    }),
  ];
}
