// Argument fields shared by the page tools, so every tool names and explains them the same way.
import { z } from 'zod';

export const tabArg = z.string().optional().describe('Tab id, e.g. "tab-2". Defaults to your current tab.');

export const refArg = z.string().optional().describe('Element ref from your latest browser_snapshot of this tab, e.g. "e12".');
export const selectorArg = z
  .string()
  .optional()
  .describe('CSS selector, instead of ref. Searches open shadow roots and same-origin iframes too; the first visible match is used.');
export const xArg = z.number().optional().describe('Viewport x coordinate in CSS pixels, instead of ref/selector (e.g. for canvas or a cross-origin iframe; see browser_screenshot).');
export const yArg = z.number().optional().describe('Viewport y coordinate in CSS pixels, with x.');

export const elementArgs = { ref: refArg, selector: selectorArg };
export const pointArgs = { ref: refArg, selector: selectorArg, x: xArg, y: yArg };

export const modifiersArg = z
  .array(z.enum(['Alt', 'Control', 'Meta', 'Shift', 'ControlOrMeta']))
  .optional()
  .describe('Modifier keys held during the action. ControlOrMeta is Meta (Cmd) on macOS and Control elsewhere.');
