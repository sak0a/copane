// browser_emulate: device size, colour scheme, touch, locale, time zone and reduced motion for a tab.
import { z } from 'zod';
import { defineTool, type ToolDefinition } from '../../core/tools';
import { withPage, type PageEnv } from './call';
import type { EmulationManager } from './emulation';
import { MAX_SIZE, MIN_SIZE, PRESET_IDS } from './emulationLogic';
import { tabArg } from './schema';

export function emulationTools(env: PageEnv, manager: EmulationManager): ToolDefinition<any>[] {
  const size = z.number().min(MIN_SIZE).max(MAX_SIZE).optional();
  return [
    defineTool({
      name: 'browser_emulate',
      title: 'Emulate device or media',
      description:
        'Emulates a device (viewport in CSS px, pixel ratio, touch), color scheme, reduced motion, locale, time zone, a slow network or offline, or a slow CPU in the tab, e.g. to check a responsive layout. A call changes only what it passes; releasing the tab ends it all. Without arguments: reports what is emulated.',
      input: {
        preset: z
          .enum(PRESET_IDS)
          .optional()
          .describe('iphone-15-pro 393×852@3, iphone-se 375×667@2, pixel-8 412×915@2.625, ipad-mini 768×1024@2 (mobile UA), laptop 1366×768, desktop 1920×1080; none ends the device.'),
        width: size,
        height: size,
        deviceScaleFactor: z.number().optional(),
        mobile: z.boolean().optional().describe('Touch input: clicks become taps.'),
        landscape: z.boolean().optional(),
        colorScheme: z.enum(['light', 'dark', 'auto']).optional().describe('auto: the system\'s.'),
        reducedMotion: z.boolean().optional(),
        locale: z.string().optional().describe('e.g. "de-DE" (Intl, navigator.language, Accept-Language); "" ends it.'),
        timezone: z.string().optional().describe('e.g. "America/New_York"; "" ends it.'),
        network: z.string().optional().describe('offline, 3g, slow-4g, fast-4g (DevTools presets), "<down kbit/s>/<up kbit/s>/<latency ms>", or none.'),
        cpu: z.number().optional().describe('Slowdown factor, e.g. 4 or 6; 1 ends it.'),
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
