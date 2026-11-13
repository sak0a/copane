// browser_navigate and browser_history: moving the tab to another page and waiting until it is usable.
import { z } from 'zod';
import { ToolError } from '../../core/errors';
import { defineTool, type ToolContext, type ToolDefinition } from '../../core/tools';
import { withPage, type PageCall, type PageEnv } from './call';
import { describeEffects, markAction, pageTitle, type ActionMark } from './effects';
import { DialogInterrupt } from './pageState';
import { clip, formatMs } from './ringBuffer';
import { tabArg } from './schema';

type WaitUntil = 'commit' | 'domcontentloaded' | 'load' | 'networkidle';

const waitUntilArg = z
  .enum(['commit', 'domcontentloaded', 'load', 'networkidle'])
  .optional()
  .describe('Default load; networkidle: load, then 500 ms without requests.');
const timeoutArg = z.number().min(1).max(120).optional().describe('Seconds, default 20.');

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

/** A tab's URL before its first navigation has committed. */
export function isBlank(url: string): boolean {
  return url === '' || url === 'about:blank';
}

/**
 * For browser_open: waits until the page a new tab was opened on has loaded (bounded), and describes
 * it like browser_navigate does. Without this, the agent's usual next call (a snapshot) could read the
 * empty document a tab starts with.
 */
export async function describeOpened(env: PageEnv, ctx: ToolContext, tabId: string, url: string, timeoutMs = 10_000): Promise<string> {
  return withPage(env, ctx, tabId, { access: 'control', skipReady: true }, async call => {
    const { state } = call;
    const started = Date.now();
    const mark: ActionMark = { seq: 0, loaderId: undefined, url: '', tabs: new Set(env.services.browser.listTabs().map(t => t.id)) };
    const wantsBlank = isBlank(url);
    const result = await state.waitFor(() => (wantsBlank || !isBlank(state.url)) && state.lifecycleOf().has('load') && !state.pendingNavigation, { timeoutMs, signal: call.signal, pollMs: 100 });
    if (result.ok === false && result.reason === 'dialog') return [`Opened ${call.tab.id}.`, ...(await describeEffects(call, mark))].join('\n');
    if (state.url.startsWith('chrome-error://')) {
      const failed = state.network.entries.all().find(e => e.type === 'Document' && e.failed);
      return `Opened ${call.tab.id}, but ${url} could not be loaded${failed?.failed ? `: ${failed.failed}` : ''}. The tab shows the browser's error page.`;
    }
    const life = state.lifecycleOf();
    const timedOut = result.ok === false;
    const progress = !timedOut ? `loaded in ${formatMs(Date.now() - started)}` : isBlank(state.url) ? `nothing loaded yet after ${formatMs(timeoutMs)}` : life.has('DOMContentLoaded') ? 'the document is ready but still loading resources; it is usable' : `still loading after ${formatMs(timeoutMs)}`;
    const title = isBlank(state.url) ? undefined : await pageTitle(call);
    // The document request often starts before the bridge records the tab: ask the page then.
    const doc = state.loaderId ? state.network.byRequestId(state.loaderId) : undefined;
    const code = doc?.status ?? (isBlank(state.url) ? undefined : await documentStatus(call));
    const status = code ? `HTTP ${code}${code >= 400 ? ' (error page)' : ''}, ` : '';
    const effects = (await describeEffects(call, mark)).filter(l => !l.startsWith('Navigated to') && !l.startsWith('URL changed'));
    return [`Opened ${call.tab.id}: ${clip(isBlank(state.url) ? url : state.url, 500)}${title ? ` — "${clip(title, 200)}"` : ''} (${status}${progress}).`, ...effects].join('\n');
  });
}

async function documentStatus(call: PageCall): Promise<number | undefined> {
  try {
    const code = await call.evaluate<number>("function () { return performance.getEntriesByType('navigation')[0]?.responseStatus ?? 0; }", [], { timeoutMs: 2000 });
    return code > 0 ? code : undefined;
  } catch (err) {
    if (err instanceof ToolError && err.code === 'cancelled') throw err;
    return undefined;
  }
}

/** What the rest of the bridge noted for the tab during this call (e.g. a login prompt), or "". Each note is returned once. */
function notesSince(call: PageCall, mark: ActionMark): string {
  const notes = call.state.notesFor(call.ctx.session.id, mark.seq);
  return notes.length ? ` ${notes.join(' ')}` : '';
}

export function navigationTools(env: PageEnv): ToolDefinition<any>[] {
  return [
    defineTool({
      name: 'browser_navigate',
      title: 'Go to URL',
      description: 'Loads a URL in the tab and returns once it has loaded, with its final URL, title and HTTP status. For a new tab, use browser_open.',
      input: {
        url: z.string().min(1).describe('"localhost:3000" works without a scheme.'),
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
            // A paused request (a login prompt the user has not answered) holds Page.navigate too.
            const notes = err instanceof ToolError && err.code === 'timeout' ? notesSince(call, mark) : '';
            if (notes) throw new ToolError('timeout', `${url} has not loaded yet.${notes}`);
            if (!(err instanceof DialogInterrupt)) throw err;
            // A beforeunload dialog holds Page.navigate until it is answered.
            const waited = await waitForNavigation(call, mark, { waitUntil, timeoutMs: (args.timeout ?? 20) * 1000 });
            return navigationResult(call, mark, started, `Navigated ${call.tab.id} to`, waited, waitUntil);
          }
          // A certificate error that was not approved shows up as an aborted navigation.
          const refused = result.errorText ? env.services.browser.certificateRefusal?.(url) : undefined;
          if (refused) {
            throw new ToolError('access_denied', `Could not load ${url}: its security certificate is not trusted and ${refused}. Do not retry right away. Tell the user; they can approve the host when asked, or add it to the trusted certificate hosts in the extension's settings.`);
          }
          if (result.errorText && result.errorText !== 'net::ERR_ABORTED') {
            const hint = /CONNECTION_REFUSED|ADDRESS_UNREACHABLE|CONNECTION_RESET|EMPTY_RESPONSE/.test(result.errorText)
              ? ' Nothing answered at that address: is the server running, and on that port?'
              : /NAME_NOT_RESOLVED/.test(result.errorText)
                ? ' The host name does not resolve; check the URL.'
                : /CERT/.test(result.errorText)
                  ? " The site's certificate is not trusted, and proceeding past certificate errors was not approved or is turned off in the extension's settings. Do not retry; tell the user."
                  : '';
            throw new ToolError('failed', `Could not load ${url}: ${result.errorText}.${notesSince(call, mark) || hint} The tab now shows the browser's error page.`);
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
            throw new ToolError('timeout', `${url} did not respond within ${args.timeout ?? 20} s.${notesSince(call, mark) || ' The tab may still be waiting for it; check later with browser_snapshot, or try again.'}`);
          }
          return navigationResult(call, mark, started, `Navigated ${call.tab.id} to`, waited, waitUntil);
        }),
    }),
    defineTool({
      name: 'browser_history',
      title: 'Back, forward or reload',
      description: "Goes back or forward in the tab's history, or reloads the page, and returns once it has loaded.",
      input: {
        action: z.enum(['back', 'forward', 'reload']),
        ignoreCache: z.boolean().optional().describe('Reload bypassing the cache.'),
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
