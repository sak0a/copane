import { z } from 'zod';
import type { BridgeServices } from './services';
import { sessionDisplayName } from './sessions';
import { defineTool, text } from './tools';

/** Tools about the agent session itself. */
export function activateSessionTools(services: BridgeServices): void {
  const { sessions, context } = services;
  context.subscriptions.push(
    services.tools.register([
      defineTool({
        name: 'session_info',
        title: 'Session info',
        description:
          'Shows your session label and color as the user sees them, the window and workspace, and the other agent sessions in it.',
        input: {},
        annotations: { readOnlyHint: true },
        // Compact JSON: read as data, and pretty-printing would only add characters.
        handler: (_args, ctx) =>
          [
            text(JSON.stringify({
              you: { id: ctx.session.id, label: ctx.session.label, color: ctx.session.color.id, title: ctx.session.title ?? null },
              window: services.window,
              browserAvailable: services.browser.available,
              otherSessions: sessions
                .list()
                .filter(s => s.id !== ctx.session.id)
                .map(s => ({ label: sessionDisplayName(s), connected: s.connected })),
            })),
          ],
      }),
      defineTool({
        name: 'session_set_title',
        title: 'Name this session',
        description:
          'Sets a 2-5 word title for your task (e.g. "checkout flow tests"), shown next to your label on your tabs and terminals. Call it once near the start of a task.',
        input: { title: z.string().max(60).describe('Empty clears it.') },
        annotations: { idempotentHint: true },
        handler: (args, ctx) => {
          sessions.setTitle(ctx.session.id, args.title);
          return `Session title set. You appear as "${sessionDisplayName(ctx.session)}".`;
        },
      }),
    ]),
  );
}
