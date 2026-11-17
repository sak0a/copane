// browser_audit: an accessibility check (a11y.ts, axe-core), a keyboard walk (keyboard.ts) or a
// performance check (perf.ts) of the page, in one tool so they cost one definition.
import { z } from 'zod';
import { ToolError } from '../../core/errors';
import { defineTool, type ToolDefinition } from '../../core/tools';
import { accessibilityAudit } from './a11y';
import { keyboardAudit } from './keyboard';
import { withPage, type PageEnv } from './call';
import { performanceAudit } from './perf';
import { tabArg } from './schema';
import { resolveTarget, type ElementTarget } from './targets';

export function auditTools(env: PageEnv): ToolDefinition<any>[] {
  return [
    defineTool({
      name: 'browser_audit',
      title: 'Audit page',
      description:
        'accessibility: axe-core violations by rule, with refs and fixes (ref/selector: only that part). performance: load timing, Web Vitals, slowest and largest requests, long tasks, render-blocking resources. keyboard: presses Tab through the page (ref/selector: that region) and reports focus order, invisible focus, traps, unreachable controls and the skip link; focus and scroll are restored.',
      input: {
        type: z.enum(['accessibility', 'performance', 'keyboard']),
        // ref and selector are explained on the action tools; repeating it here would cost every conversation.
        ref: z.string().optional(),
        selector: z.string().optional(),
        reload: z.boolean().optional().describe('performance: reload without cache first, measure that load.'),
        tab: tabArg,
      },
      handler: (args, ctx) =>
        withPage(env, ctx, args.tab, { access: args.reload || args.type === 'keyboard' ? 'control' : 'read' }, async call => {
          if (args.type === 'performance') {
            if (args.ref !== undefined || args.selector !== undefined) throw new ToolError('invalid_input', 'The performance check covers the whole page; leave out ref and selector.');
            return performanceAudit(call, { reload: Boolean(args.reload) });
          }
          if (args.reload) throw new ToolError('invalid_input', 'reload applies to the performance check only.');
          const root = (await resolveTarget(call, args, { waitMs: 2000 })) as ElementTarget | undefined;
          if (args.type === 'keyboard') return keyboardAudit(call, root);
          return accessibilityAudit(call, root, env.services.context.extensionPath);
        }),
    }),
  ];
}
