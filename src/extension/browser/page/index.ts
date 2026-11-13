import { z } from 'zod';
import { ToolError } from '../../core/errors';
import type { BridgeServices } from '../../core/services';
import { defineTool } from '../../core/tools';

/** Tools that act on a page through CDP. Everything goes through `services.browser.acquire`. */
export function registerPageTools(services: BridgeServices): void {
  const { browser, context } = services;
  context.subscriptions.push(
    services.tools.register([
      defineTool({
        name: 'browser_evaluate',
        title: 'Run JavaScript in page',
        description: 'Evaluates a JavaScript expression in the page and returns its JSON-serialisable result. Promises are awaited.',
        input: {
          expression: z.string().describe('JavaScript expression, e.g. "document.title".'),
          tab: z.string().optional().describe('Tab id. Defaults to your current tab.'),
        },
        handler: async (args, ctx) => {
          const { page } = await browser.acquire(ctx.session, args.tab, 'control', ctx.signal);
          const result = await page.send('Runtime.evaluate', { expression: args.expression, returnByValue: true, awaitPromise: true });
          if (result.exceptionDetails) {
            throw new ToolError('failed', `The script threw: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
          }
          return JSON.stringify(result.result.value ?? null, null, 2);
        },
      }),
    ]),
  );
}
