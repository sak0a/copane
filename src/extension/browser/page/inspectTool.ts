// browser_inspect: the code that renders an element (source.ts). Read-only.
import { z } from 'zod';
import { ToolError } from '../../core/errors';
import { defineTool, type ToolDefinition } from '../../core/tools';
import { withPage, type PageEnv } from './call';
import { tabArg } from './schema';
import { elementSource } from './source';
import { resolveTarget, type ElementTarget } from './targets';

export function inspectTools(env: PageEnv): ToolDefinition<any>[] {
  return [
    defineTool({
      name: 'browser_inspect',
      title: 'Find element source',
      description:
        'Finds the code that renders an element: its components, innermost first, with workspace file:line (React, Vue, Svelte dev builds, inspector plugin attributes; source maps resolved).',
      // ref and selector are explained on the action tools; repeating it here would cost every conversation.
      input: { ref: z.string().optional(), selector: z.string().optional(), tab: tabArg },
      annotations: { readOnlyHint: true },
      handler: (args, ctx) =>
        withPage(env, ctx, args.tab, { access: 'read' }, async call => {
          if (args.ref === undefined && args.selector === undefined) throw new ToolError('invalid_input', 'Pass the element: ref (from browser_snapshot) or selector.');
          const target = (await resolveTarget(call, args, { waitMs: 2000 })) as ElementTarget;
          return elementSource(call, target);
        }),
    }),
  ];
}
