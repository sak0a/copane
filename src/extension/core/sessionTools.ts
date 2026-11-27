import { z } from 'zod';
import { ToolError } from './errors';
import type { BridgeServices } from './services';
import { sessionDisplayName } from './sessions';
import { defineTool, text } from './tools';

/**
 * Longest name an agent may give its session. It replaces "Claude 2" on terminal tabs and in the
 * page indicator of browser tabs, where there is little room. The user may give longer names.
 */
export const AGENT_SESSION_NAME_MAX = 24;

/** Tools about the agent session itself. */
export function activateSessionTools(services: BridgeServices): void {
  const { sessions, context } = services;
  context.subscriptions.push(
    services.tools.register([
      defineTool({
        name: 'session_info',
        title: 'Session info',
        description:
          'Shows your session name and color as the user sees them, the window and workspace, and the other agent sessions in it.',
        input: {},
        annotations: { readOnlyHint: true },
        // Compact JSON: read as data, and pretty-printing would only add characters.
        handler: (_args, ctx) =>
          [
            text(JSON.stringify({
              you: {
                id: ctx.session.id,
                label: ctx.session.label,
                ...(ctx.session.title ? { automaticLabel: ctx.session.autoLabel, namedBy: ctx.session.titleBy === 'user' ? 'the user' : 'you' } : {}),
                color: ctx.session.color.id,
              },
              window: services.window,
              browserAvailable: services.browser.available,
              otherSessions: sessions
                .list()
                .filter(s => s.id !== ctx.session.id)
                .map(s => ({ label: sessionDisplayName(s), connected: s.connected, ...(s.away ? { away: true } : {}) })),
            })),
          ],
      }),
      defineTool({
        name: 'session_set_title',
        title: 'Name this session',
        description:
          'Names your session after your task in 2-3 words (e.g. "checkout tests"), shown to the user instead of "Claude 2" on your terminals and tabs.',
        input: {
          title: z
            .string()
            .max(AGENT_SESSION_NAME_MAX, `At most ${AGENT_SESSION_NAME_MAX} characters: it labels terminal tabs. Use 2-3 words.`)
            .describe('Empty: the automatic name.'),
        },
        annotations: { idempotentHint: true },
        handler: (args, ctx) => {
          const before = ctx.session.label;
          const refusal = sessions.setTitle(ctx.session.id, args.title, 'agent');
          if (refusal?.reason === 'named-by-user') {
            return `The user named this session "${refusal.name}", so that name stays; yours was not applied. Do not set a title again.`;
          }
          if (refusal?.reason === 'taken') throw new ToolError('invalid_input', `Another session in this window is called "${refusal.by.label}". Choose a different title.`);
          if (refusal?.reason === 'automatic') throw new ToolError('invalid_input', `"${args.title.trim()}" reads like the automatic name of another session. Choose a title that describes your task.`);
          if (ctx.session.label !== before) ctx.log.info(`named "${ctx.session.label}" by the agent (was "${before}")`);
          return ctx.session.title
            ? `The user now sees this session as "${ctx.session.label}" (automatic name: ${ctx.session.autoLabel}).`
            : `This session has no name now; the user sees it as "${ctx.session.label}".`;
        },
      }),
    ]),
  );
}
