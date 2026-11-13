// browser_navigate and browser_history: moving the tab to another page and waiting until it is usable.
import { z } from 'zod';
import { ToolError } from '../../core/errors';
import { defineTool, type ToolDefinition } from '../../core/tools';
import { withPage, type PageCall, type PageEnv } from './call';
import { describeEffects, markAction, pageTitle, type ActionMark } from './effects';
import { DialogInterrupt } from './pageState';
import { clip, formatMs } from './ringBuffer';
import { tabArg } from './schema';

type WaitUntil = 'commit' | 'domcontentloaded' | 'load' | 'networkidle';

const waitUntilArg = z
  .enum(['commit', 'domcontentloaded', 'load', 'networkidle'])
  .optional()
  .describe('When to return: commit (the server answered), domcontentloaded, load (default), or networkidle (load, then no requests for 500 ms).');
const timeoutArg = z.number().min(1).max(120).optional().describe('Seconds to wait for the page. Default 20.');

/** Adds a scheme to "localhost:3000" or "example.com". */
export function normalizeUrl(input: string): string {
  const url = input.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) && !/^(localhost|[\w.-]+):\d+/i.test(url)) return url;
  if (/^(localhost|127\.|\[?::1\]?|0\.0\.0\.0|10\.|192\.168\.|[\w-]+\.local)/i.test(url)) return `http://${url}`;
  return `https://${url}`;
}

function reached(call: PageCall, waitUntil: WaitUntil): boolean {
  const life = call.state.lifecycleOf();
  if (waitUntil === 'commit') return true;
  if (waitUntil === 'domcontentloaded') return life.has('DOMContentLoaded');
  if (waitUntil === 'load') return life.has('load');
  return life.has('load') && call.state.networkIdleFor() >= 500;
}

/**
 * Waits for a navigation that started after `mark` to commit and reach `waitUntil`. Accepts a
 * beforeunload dialog (the agent asked to leave) and stops at any other dialog.
 */
async function waitForNavigation(call: PageCall, mark: ActionMark, options: { waitUntil: WaitUntil; timeoutMs: number; loaderId?: string; sameDocumentOk?: boolean }): Promise<{ notes: string[]; timedOut: boolean }> {
  const { state } = call;
  const notes: string[] = [];
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    const result = await state.waitFor(
      () => {
        const committed = options.loaderId ? state.loaderId === options.loaderId : state.loaderId !== mark.loaderId;
        if (committed) return reached(call, options.waitUntil);
        if (options.sameDocumentOk && state.navigations.after(mark.seq).some(n => n.sameDocument)) return true;
        return false;
      },
      { timeoutMs: Math.max(0, deadline - Date.now()), signal: call.signal, pollMs: 100 },
    );
    if (result.ok) return { notes, timedOut: false };
    if (result.reason === 'dialog' && state.dialog?.type === 'beforeunload') {
      notes.push('The page asked to confirm leaving it (unsaved changes?); the bridge confirmed, since you asked to navigate.');
      try {
        await call.send('Page.handleJavaScriptDialog', { accept: true }, { allowDialog: true, timeoutMs: 5000 });
      } catch (err) {
        if (err instanceof ToolError && err.code === 'cancelled') throw err;
        // Already answered by the browser.
      }
      continue;
    }
    return { notes, timedOut: result.reason === 'timeout' };
  }
}

async function navigationResult(call: PageCall, mark: ActionMark, started: number, verb: string, extra: { notes: string[]; timedOut: boolean }, waitUntil: WaitUntil): Promise<string> {
  const { state } = call;
  if (state.dialog) {
    const effects = await describeEffects(call, mark);
    return [`${verb.replace(/( to|:)$/, '')}.`, ...extra.notes, ...effects].join('\n');
  }
  const title = await pageTitle(call);
  const doc = state.loaderId ? state.network.byRequestId(state.loaderId) : undefined;
  const status = doc?.status !== undefined ? `HTTP ${doc.status}${doc.status >= 400 ? ' (error page)' : ''}, ` : '';
  const life = state.lifecycleOf();
  const progress = extra.timedOut
    ? life.has('DOMContentLoaded')
      ? `the document is ready but still loading resources after ${formatMs(Date.now() - started)}; it is usable`
      : `still loading after ${formatMs(Date.now() - started)}`
    : `${waitUntil === 'commit' ? 'committed' : waitUntil === 'networkidle' ? 'loaded and network idle' : 'loaded'} in ${formatMs(Date.now() - started)}`;
  const effects = (await describeEffects(call, mark)).filter(l => !l.startsWith('Navigated to') && !l.startsWith('URL changed'));
  return [`${verb} ${clip(state.url, 500)}${title ? ` — "${clip(title, 200)}"` : ''} (${status}${progress}).`, ...extra.notes, ...effects].join('\n');
}

export function navigationTools(env: PageEnv): ToolDefinition<any>[] {
  return [
    defineTool({
      name: 'browser_navigate',
      title: 'Go to URL',
      description:
        'Loads a URL in your current tab (or `tab`) and returns once the page has loaded, with its final URL, title and HTTP status, plus console errors and failed requests during the load. "localhost:3000" works without a scheme. To open a new tab instead, use browser_open.',
      input: {
        url: z.string().min(1).describe('URL to load.'),
        waitUntil: waitUntilArg,
        timeout: timeoutArg,
        tab: tabArg,
      },
      annotations: { openWorldHint: true },
      handler: (args, ctx) =>
        withPage(env, ctx, args.tab, { access: 'control', skipReady: true }, async call => {
          const url = normalizeUrl(args.url);
          const mark = markAction(call);
          const started = Date.now();
          const waitUntil = args.waitUntil ?? 'load';
          let result: { frameId: string; loaderId?: string; errorText?: string };
          try {
            result = await call.send('Page.navigate', { url, transitionType: 'typed' }, { timeoutMs: (args.timeout ?? 20) * 1000 });
          } catch (err) {
            if (!(err instanceof DialogInterrupt)) throw err;
            // A beforeunload dialog holds Page.navigate until it is answered.
            const waited = await waitForNavigation(call, mark, { waitUntil, timeoutMs: (args.timeout ?? 20) * 1000 });
            return navigationResult(call, mark, started, `Navigated ${call.tab.id} to`, waited, waitUntil);
          }
          if (result.errorText && result.errorText !== 'net::ERR_ABORTED') {
            const hint = /CONNECTION_REFUSED|ADDRESS_UNREACHABLE|CONNECTION_RESET|EMPTY_RESPONSE/.test(result.errorText)
              ? ' Nothing answered at that address: is the server running, and on that port?'
              : /NAME_NOT_RESOLVED/.test(result.errorText)
                ? ' The host name does not resolve; check the URL.'
                : /CERT/.test(result.errorText)
                  ? ' The certificate is not trusted.'
                  : '';
            throw new ToolError('failed', `Could not load ${url}: ${result.errorText}.${hint} The tab now shows the browser's error page.`);
          }
          if (!result.loaderId) {
            // Same-document navigation (only the #fragment changed).
            await call.sleep(50);
            return `Navigated ${call.tab.id} within the page to ${clip(call.state.url, 500)} (only the fragment changed).`;
          }
          const waited = await waitForNavigation(call, mark, { waitUntil, timeoutMs: (args.timeout ?? 20) * 1000, loaderId: result.loaderId });
          if (result.errorText === 'net::ERR_ABORTED' && call.state.loaderId !== result.loaderId) {
            const effects = await describeEffects(call, mark);
            return [`The navigation to ${url} was aborted (it may have been a download, or the page navigated elsewhere).`, ...effects].join('\n');
          }
          if (waited.timedOut && call.state.loaderId !== result.loaderId) {
            throw new ToolError('timeout', `${url} did not respond within ${args.timeout ?? 20} s. The tab may still be waiting for it; check later with browser_snapshot, or try again.`);
          }
          return navigationResult(call, mark, started, `Navigated ${call.tab.id} to`, waited, waitUntil);
        }),
    }),
    defineTool({
      name: 'browser_history',
      title: 'Back, forward or reload',
      description: 'Goes back or forward in the tab\'s history, or reloads the page, and returns once the page is usable (same details as browser_navigate). Single-page apps that change the URL without loading a page are handled too.',
      input: {
        action: z.enum(['back', 'forward', 'reload']).describe('What to do.'),
        ignoreCache: z.boolean().optional().describe('For reload: bypass the cache (like Shift+Reload).'),
        waitUntil: waitUntilArg,
        timeout: timeoutArg,
        tab: tabArg,
      },
      handler: (args, ctx) =>
        withPage(env, ctx, args.tab, { access: 'control', skipReady: true }, async call => {
          const mark = markAction(call);
          const started = Date.now();
          const waitUntil = args.waitUntil ?? 'load';
          const timeoutMs = (args.timeout ?? 20) * 1000;
          const verb = `${args.action === 'reload' ? 'Reloaded' : args.action === 'back' ? 'Went back in' : 'Went forward in'} ${call.tab.id}:`;
          try {
            if (args.action === 'reload') {
              await call.send('Page.reload', { ignoreCache: Boolean(args.ignoreCache) });
            } else {
              const { currentIndex, entries } = await call.send('Page.getNavigationHistory');
              const index = currentIndex + (args.action === 'back' ? -1 : 1);
              const entry = entries[index];
              if (!entry) throw new ToolError('failed', `There is no ${args.action === 'back' ? 'previous' : 'next'} page in ${call.tab.id}'s history.`);
              await call.send('Page.navigateToHistoryEntry', { entryId: entry.id });
            }
          } catch (err) {
            if (!(err instanceof DialogInterrupt)) throw err;
          }
          const waited = await waitForNavigation(call, mark, { waitUntil, timeoutMs, sameDocumentOk: args.action !== 'reload' });
          if (waited.timedOut && call.state.loaderId === mark.loaderId && !call.state.navigations.after(mark.seq).length && !call.state.dialog) {
            throw new ToolError('timeout', `${verb} no page loaded within ${args.timeout ?? 20} s.`);
          }
          if (call.state.loaderId === mark.loaderId && call.state.navigations.after(mark.seq).length) {
            return `${verb} the URL is now ${clip(call.state.url, 500)} (same page, no reload).`;
          }
          return navigationResult(call, mark, started, verb, waited, waitUntil);
        }),
    }),
  ];
}
