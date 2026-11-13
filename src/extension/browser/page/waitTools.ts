// browser_wait_for: waiting for text, an element, a URL, the network, or plain time.
import { z } from 'zod';
import { ToolError } from '../../core/errors';
import { defineTool, type ToolDefinition } from '../../core/tools';
import { dialogMessage, withPage, type PageEnv } from './call';
import { checkAcrossFrames } from './frameQuery';
import { urlMatcher } from './networkLog';
import { DialogInterrupt } from './pageState';
import { clip, formatMs } from './ringBuffer';
import { tabArg } from './schema';
import { PAGE_TEXT_EXCERPT } from './scripts';

interface Checks {
  text?: boolean;
  textGone?: boolean;
  selector?: boolean;
  selectorCount?: number;
  selectorVisible?: number;
  error?: string;
}

export function waitTools(env: PageEnv): ToolDefinition<any>[] {
  return [
    defineTool({
      name: 'browser_wait_for',
      title: 'Wait for page',
      description:
        'Waits until all given conditions hold: text appears or disappears (visible text, case-insensitive, including shadow DOM and iframes), a CSS selector becomes visible/hidden/attached/detached, the URL matches, the page reaches a load state or the network goes idle. With only `time` it simply waits. Fails with what the page shows when the timeout passes.',
      input: {
        text: z.string().optional().describe('Wait until this text is visible on the page.'),
        textGone: z.string().optional().describe('Wait until this text is no longer visible.'),
        selector: z.string().optional().describe('CSS selector to wait for (see state).'),
        state: z.enum(['visible', 'hidden', 'attached', 'detached']).optional().describe('For selector: visible (default), hidden (absent or invisible), attached (in the DOM), detached (gone from the DOM).'),
        url: z.string().optional().describe('Wait until the tab URL contains this text, matches this glob (with *), or /regex/.'),
        loadState: z.enum(['domcontentloaded', 'load', 'networkidle']).optional().describe('Wait until the current document reaches this state; networkidle = no requests for 500 ms.'),
        time: z.number().min(0).max(60).optional().describe('Seconds to wait. Alone: a plain pause. With other conditions: ignored.'),
        timeout: z.number().min(0.1).max(120).optional().describe('Seconds before giving up. Default 10.'),
        tab: tabArg,
      },
      annotations: { readOnlyHint: true },
      handler: (args, ctx) =>
        withPage(env, ctx, args.tab, { access: 'read', skipReady: true }, async call => {
          const { state } = call;
          const conditions = args.text !== undefined || args.textGone !== undefined || args.selector !== undefined || args.url !== undefined || args.loadState !== undefined;
          if (!conditions) {
            if (args.time === undefined) throw new ToolError('invalid_input', 'Give at least one condition (text, textGone, selector, url, loadState) or a time to wait.');
            const result = await state.waitFor(() => false, { timeoutMs: args.time * 1000, signal: call.signal });
            if (result.ok === false && result.reason === 'dialog') throw new ToolError('failed', dialogMessage(call.tab.id, state.dialog!));
            return `Waited ${formatMs(args.time * 1000)}.`;
          }
          if (args.state && args.selector === undefined) throw new ToolError('invalid_input', 'state applies to selector; pass selector too.');
          let matchUrl: (u: string) => boolean;
          try {
            matchUrl = urlMatcher(args.url);
          } catch (err) {
            throw new ToolError('invalid_input', err instanceof Error ? err.message : String(err));
          }
          const timeoutMs = (args.timeout ?? 10) * 1000;
          const started = Date.now();
          const needsDom = args.text !== undefined || args.textGone !== undefined || args.selector !== undefined;
          let last: Checks = {};
          const unmet = (): string[] => {
            const out: string[] = [];
            if (args.text !== undefined && !last.text) out.push(`text "${clip(args.text, 100)}" did not appear`);
            if (args.textGone !== undefined && !last.textGone) out.push(`text "${clip(args.textGone, 100)}" is still visible`);
            if (args.selector !== undefined && !last.selector) {
              const st = args.state ?? 'visible';
              out.push(`selector "${args.selector}" is not ${st} (${last.selectorCount ?? 0} in the DOM, ${last.selectorVisible ?? 0} visible)`);
            }
            if (args.url !== undefined && !matchUrl(state.url)) out.push(`URL is ${clip(state.url, 200)}, not matching "${args.url}"`);
            if (args.loadState !== undefined && !loadReached()) out.push(`page has not reached ${args.loadState}`);
            return out;
          };
          const loadReached = () => {
            const life = state.lifecycleOf();
            if (args.loadState === 'domcontentloaded') return life.has('DOMContentLoaded');
            if (args.loadState === 'load') return life.has('load');
            return life.has('load') && state.networkIdleFor() >= 500;
          };
          for (;;) {
            if (state.dialog) throw new ToolError('failed', `Stopped waiting: ${dialogMessage(call.tab.id, state.dialog)}`);
            if (needsDom && state.lifecycleOf().has('DOMContentLoaded')) {
              try {
                // The page and its cross-origin frames (frameQuery.ts).
                last = await checkAcrossFrames(call, { text: args.text, textGone: args.textGone, selector: args.selector, state: args.state });
              } catch (err) {
                if (err instanceof DialogInterrupt) continue;
                if (err instanceof ToolError) throw err;
                last = {}; // The document is being replaced; check again.
              }
              if (last.error) throw new ToolError('invalid_input', `"${args.selector}" is not a valid CSS selector: ${last.error}.`);
            }
            const remaining = unmet();
            if (remaining.length === 0 && (!needsDom || state.lifecycleOf().has('DOMContentLoaded'))) {
              const met = [
                args.text !== undefined ? `"${clip(args.text, 60)}" is visible` : '',
                args.textGone !== undefined ? `"${clip(args.textGone, 60)}" is gone` : '',
                args.selector !== undefined ? `"${args.selector}" is ${args.state ?? 'visible'}` : '',
                args.url !== undefined ? `URL is ${clip(state.url, 200)}` : '',
                args.loadState !== undefined ? `page reached ${args.loadState}` : '',
              ].filter(Boolean);
              return `Done after ${formatMs(Date.now() - started)}: ${met.join(', ')}.`;
            }
            if (Date.now() - started >= timeoutMs) {
              let excerpt = '';
              try {
                excerpt = await call.evaluate<string>(PAGE_TEXT_EXCERPT, [400], { timeoutMs: 3000 });
              } catch (err) {
                if (err instanceof ToolError && err.code === 'cancelled') throw err;
              }
              throw new ToolError('timeout', `Gave up after ${formatMs(timeoutMs)}: ${remaining.join('; ')}.${excerpt ? `\nThe page (${clip(state.url, 200)}) shows: ${excerpt}` : ''}`);
            }
            await state.waitFor(() => false, { timeoutMs: needsDom ? 150 : 250, signal: call.signal, ignoreDialogs: false });
          }
        }),
    }),
  ];
}
