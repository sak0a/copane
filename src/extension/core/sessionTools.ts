import { z } from 'zod';
import type { BridgeServices } from './services';
import { sessionDisplayName } from './sessions';
import { defineTool, json } from './tools';

/** Tools about the agent session itself. */
export function activateSessionTools(services: BridgeServices): void {
  const { sessions, context } = services;
  context.subscriptions.push(
    services.tools.register([
      defineTool({
        name: 'session_info',
        title: 'Session info',
        description:
          'Shows who you are in this VS Code window (your session label and color, as the user sees them on your tabs and terminals), the window and workspace, and the other agent sessions connected to it.',
        input: {},
        annotations: { readOnlyHint: true },
        handler: (_args, ctx) =>
          [
            json({
              you: { id: ctx.session.id, label: ctx.session.label, color: ctx.session.color.id, title: ctx.session.title ?? null },
              window: services.window,
              browserAvailable: services.browser.available,
              otherSessions: sessions
                .list()
                .filter(s => s.id !== ctx.session.id)
                .map(s => ({ label: sessionDisplayName(s), connected: s.connected })),
            }),
          ],
      }),
      defineTool({
        name: 'session_set_title',
        title: 'Name this session',
        description:
          'Sets a short title (2-5 words) for what this session is working on, e.g. "checkout flow tests". The user sees it next to your label on your browser tabs and terminals, which helps when several agent sessions run at once. Call it once near the start of a task.',
        input: { title: z.string().max(60).describe('Short task summary. Empty string clears it.') },
        annotations: { idempotentHint: true },
        handler: (args, ctx) => {
          sessions.setTitle(ctx.session.id, args.title);
          return `Session title set. You appear as "${sessionDisplayName(ctx.session)}".`;
        },
      }),
    ]),
  );
}
