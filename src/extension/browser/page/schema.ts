// Argument fields shared by the page tools, so every tool names and explains them the same way.
// Descriptions say only what the name and type do not; what applies to all tools is in instructions.ts.
import { z } from 'zod';

/** Without it, tools act on the session's current tab (said once, in instructions.ts). */
export const tabArg = z.string().optional();

export const refArg = z.string().optional().describe('From browser_snapshot, e.g. "e12".');
export const selectorArg = z.string().optional().describe('CSS selector instead of ref; searches shadow DOM and iframes too ("iframe-selector >>> selector" for one iframe).');
export const xArg = z.number().optional().describe('Viewport CSS px, instead of ref/selector (e.g. a canvas).');
export const yArg = z.number().optional();

export const elementArgs = { ref: refArg, selector: selectorArg };
export const pointArgs = { ref: refArg, selector: selectorArg, x: xArg, y: yArg };

export const modifiersArg = z
  .array(z.enum(['Alt', 'Control', 'Meta', 'Shift', 'ControlOrMeta']))
  .optional()
  .describe('ControlOrMeta: Cmd on macOS, Control elsewhere.');
