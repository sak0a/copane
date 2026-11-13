// browser_emulate: device size, colour scheme, touch, locale, time zone and reduced motion for a tab.
import { z } from 'zod';
import { defineTool, type ToolDefinition } from '../../core/tools';
import { withPage, type PageEnv } from './call';
import type { EmulationManager } from './emulation';
import { MAX_SIZE, MIN_SIZE, PRESET_IDS } from './emulationLogic';
import { tabArg } from './schema';

export function emulationTools(env: PageEnv, manager: EmulationManager): ToolDefinition<any>[] {
  const size = z.number().min(MIN_SIZE).max(MAX_SIZE).optional().describe('CSS px.');
  return [
    defineTool({
      name: 'browser_emulate',
      title: 'Emulate device or media',
      description:
        'Emulates a device (viewport size, pixel ratio, touch), colour scheme, reduced motion, locale or time zone in the tab, e.g. to check a responsive layout; screenshots show the emulated viewport. A call changes only what it passes; reset: true ends all of it, as does releasing the tab. Without arguments it reports what is emulated.',
      input: {
        preset: z
          .enum(PRESET_IDS)
          .optional()
          .describe('iphone-15-pro 393×852@3, iphone-se 375×667@2, pixel-8 412×915@2.625, ipad-mini 768×1024@2 (mobile, own user agent), laptop 1366×768, desktop 1920×1080; none ends the device.'),
        width: size,
        height: size,
        deviceScaleFactor: z.number().optional().describe('Device pixel ratio.'),
        mobile: z.boolean().optional().describe('Mobile viewport and touch input: clicks become taps.'),
        landscape: z.boolean().optional(),
        colorScheme: z.enum(['light', 'dark', 'auto']).optional().describe('auto follows the system.'),
        reducedMotion: z.boolean().optional().describe('prefers-reduced-motion: reduce.'),
        locale: z.string().optional().describe('e.g. "de-DE": Intl formats, navigator.language, Accept-Language. "" ends it.'),
        timezone: z.string().optional().describe('IANA, e.g. "America/New_York". "" ends it.'),
        reset: z.boolean().optional().describe('End all emulation first.'),
        tab: tabArg,
      },
      handler: (args, ctx) => {
        const { tab, ...rest } = args;
        return withPage(env, ctx, tab, { access: 'control' }, call => manager.emulate(call, rest));
      },
    }),
  ];
}
