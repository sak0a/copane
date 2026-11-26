// Console and network: reading what the tab recorded since the bridge attached to it. Lists show the
// current page by default (logScope.ts); allPages shows everything, onlyNew what the session has not read.
import { z } from 'zod';
import { ToolError } from '../../core/errors';
import { blockByteLimit, utf8Bytes } from '../../core/resultSize';
import { defineTool, type ToolDefinition } from '../../core/tools';
import { withPage, type PageCall, type PageEnv } from './call';
import { exportHar } from './harExport';
import { formatConsoleEntry, levelAtLeast, shortLocation, type ConsoleEntry, type ConsoleLevel } from './consoleLog';
import { filterNetwork, formatBody, formatNetworkEntry, notableHeaders, pageOrigin, urlMatcher, type NetworkEntry } from './networkLog';
import { currentPageScope, earlierNote, type PageScope } from './logScope';
import type { PageState } from './pageState';
import { clip, formatBytes, formatMs } from './ringBuffer';
import { tabArg } from './schema';

const OUTPUT_BUDGET = 24_000;

function cursorFor(env: PageEnv, call: PageCall) {
  const key = `${call.ctx.session.id}\u0000${call.tab.id}`;
  let c = env.cursors.get(key);
  if (!c) env.cursors.set(key, (c = { console: 0, network: 0 }));
  return c;
}

/**
 * Keeps the newest lines that fit `budget` characters and, for a client with a byte limit on
 * results (core/resultSize.ts), `maxBytes` too; returns them oldest first and how many were dropped.
 */
function fitNewest(lines: string[], budget: number, maxBytes?: number): { kept: string[]; dropped: number } {
  const kept: string[] = [];
  let used = 0;
  let bytes = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const len = lines[i]!.length + 1;
    const size = maxBytes === undefined ? 0 : utf8Bytes(lines[i]!) + 1;
    if (used + len > budget || (maxBytes !== undefined && bytes + size > maxBytes)) return { kept: kept.reverse(), dropped: i + 1 };
    kept.push(lines[i]!);
    used += len;
    bytes += size;
  }
  return { kept: kept.reverse(), dropped: 0 };
}

function time(ms: number): string {
  return new Date(ms).toTimeString().slice(0, 8);
}

const ALL: PageScope = { startSeq: 0 };

/** The current page's part of the tab's logs (logScope.ts). */
function pageScope(state: PageState): PageScope {
  return currentPageScope({ navigations: state.navigations.all(), loaderId: state.loaderId, requests: state.network.entries.all() });
}

/** "new since your last read", "on the current page (loaded 12:00:01)", "since 11:58:40 (when the bridge attached)". */
function scopeText(state: PageState, onlyNew: boolean | undefined, page: PageScope): string {
  if (onlyNew) return 'new since your last read';
  if (page.startSeq > 0) return `on the current page (loaded ${time(page.loadedAt ?? state.recordingSince)})`;
  return `since ${time(state.recordingSince)} (when the bridge attached)`;
}

const allPagesArg = z.boolean().optional().describe('Also list earlier pages, not only the current one.');

export function logTools(env: PageEnv): ToolDefinition<any>[] {
  return [
    defineTool({
      name: 'browser_console_messages',
      title: 'Console messages',
      description: "Lists the current page's console messages, uncaught errors and browser warnings, oldest first.",
      input: {
        level: z.enum(['error', 'warning', 'info', 'debug']).optional().describe('Minimum level; default info (includes log).'),
        filter: z.string().optional().describe('Text or /regex/.'),
        onlyNew: z.boolean().optional().describe('Only what you have not read yet.'),
        allPages: allPagesArg,
        limit: z.number().int().min(1).max(500).optional().describe('Newest N, default 100.'),
        tab: tabArg,
      },
      annotations: { readOnlyHint: true },
      handler: (args, ctx) =>
        withPage(env, ctx, args.tab, { access: 'read', allowDialog: true, skipReady: true }, async call => {
          const { state } = call;
          const cursor = cursorFor(env, call);
          // onlyNew is not scoped to the page: what was not read yet is shown once, whatever page it came from.
          const page = args.onlyNew || args.allPages ? ALL : pageScope(state);
          const since = args.onlyNew ? cursor.console : Math.max(0, page.startSeq - 1);
          let match: (s: string) => boolean;
          try {
            match = urlMatcher(args.filter);
          } catch (err) {
            throw new ToolError('invalid_input', err instanceof Error ? err.message : String(err));
          }
          const min: ConsoleLevel = args.level ?? 'info';
          const wanted = (e: ConsoleEntry) => levelAtLeast(e.level, min) && match(e.text);
          const entries = state.console.since(since).filter(wanted);
          const earlier = page.startSeq > 0 ? earlierNote(state.console.entries.all().filter(e => e.seq < page.startSeq && wanted(e)).length, { one: 'message', many: 'messages' }) : '';
          cursor.console = state.seq;
          const limited = entries.slice(-(args.limit ?? 100));
          const navs = state.navigations.after(since).filter(n => !n.sameDocument);
          type Item = { seq: number; line: string };
          const items: Item[] = [
            ...limited.map((e: ConsoleEntry) => ({ seq: e.seq, line: `${time(e.time)} ${formatConsoleEntry(e, { withLocation: false })}${e.location ? `  (${shortLocation(e.location, state.url)})` : ''}` })),
            // Page loads between the first shown message (or the start of the range) and now.
            ...navs.filter(n => limited.length === entries.length || n.seq > limited[0]!.seq).map(n => ({ seq: n.seq, line: `${time(n.time)} --- page loaded: ${clip(n.url, 200)} ---` })),
          ].sort((a, b) => a.seq - b.seq);
          const { kept, dropped } = fitNewest(items.map(i => i.line), OUTPUT_BUDGET, blockByteLimit(ctx.session.client));
          const counts = { error: entries.filter(e => e.level === 'error').length, warning: entries.filter(e => e.level === 'warning').length };
          const scope = scopeText(state, args.onlyNew, page);
          if (entries.length === 0) {
            return `No console messages${min !== 'debug' ? ` at level ${min} or above` : ''}${args.filter ? ` matching "${args.filter}"` : ''} in ${call.tab.id}, ${scope}${earlier ? `; ${earlier}` : ''}.${state.dialog ? '\nNote: a dialog is open and blocks the page; see browser_handle_dialog.' : ''}`;
          }
          const head = `${entries.length} console message${entries.length === 1 ? '' : 's'} in ${call.tab.id} ${scope} (${counts.error} errors, ${counts.warning} warnings)${earlier ? `; ${earlier}` : ''}:`;
          // Discarded messages matter only when some of them may have been in the listed range.
          const lost = state.console.entries.dropped > 0 && !args.onlyNew && (state.console.entries.all()[0]?.seq ?? 0) > page.startSeq;
          const notes = [
            entries.length > limited.length || dropped ? `(${entries.length - limited.length + dropped} older messages not shown; raise limit or use filter)` : '',
            lost ? `(the buffer keeps the last ${state.console.entries.capacity}; ${state.console.entries.dropped} older messages were discarded)` : '',
          ].filter(Boolean);
          return [head, ...notes, ...kept].join('\n');
        }),
    }),
    defineTool({
      name: 'browser_network_requests',
      title: 'Network requests',
      description: "Lists the current page's network requests (redirects included), oldest first; with id, shows one request's headers and bodies.",
      input: {
        id: z.string().optional().describe('e.g. "r12", from a list or an action result.'),
        filter: z.string().optional().describe('URL text, glob (*) or /regex/.'),
        method: z.string().optional(),
        status: z.string().optional().describe('"failed", "pending", "2xx", "404", ...'),
        types: z.array(z.string()).optional().describe('fetch, xhr, document, script, image, websocket, ...'),
        includeStatic: z.boolean().optional().describe('Also list images, fonts, styles and scripts.'),
        onlyNew: z.boolean().optional().describe('Only what you have not read yet.'),
        allPages: allPagesArg,
        limit: z.number().int().min(1).max(500).optional().describe('Newest N, default 100.'),
        maxBodyChars: z.number().int().min(100).max(20_000).optional().describe('With id: cut bodies here, default 4000.'),
        har: z.string().optional().describe('Write the matching requests (static included) to this HAR file, e.g. "network.har"; cookies and tokens are masked.'),
        harInclude: z.array(z.enum(['bodies', 'secrets'])).optional().describe('With har: response bodies; secrets unmasked (you can then read them; only if the user needs them).'),
        tab: tabArg,
      },
      annotations: { readOnlyHint: true },
      handler: (args, ctx) =>
        withPage(env, ctx, args.tab, { access: 'read', allowDialog: true, skipReady: true }, async call => {
          if (args.id !== undefined) return requestDetails(call, args.id, args.maxBodyChars ?? 4000);
          const { state } = call;
          const cursor = cursorFor(env, call);
          if (args.har !== undefined) {
            // A HAR file holds everything recorded (or everything unread), not just the current page.
            let entries: NetworkEntry[];
            try {
              entries = filterNetwork(state.network.entries.after(args.onlyNew ? cursor.network : 0), { url: args.filter, method: args.method, status: args.status, types: args.types, includeStatic: args.includeStatic ?? true }).matched;
            } catch (err) {
              throw new ToolError('invalid_input', err instanceof Error ? err.message : String(err));
            }
            return exportHar(call, entries, args.har, args.harInclude ?? []);
          }
          if (args.harInclude) throw new ToolError('invalid_input', 'harInclude applies only with har (the path of the HAR file to write).');
          // onlyNew is not scoped to the page: what was not read yet is shown once, whatever page it came from.
          const page = args.onlyNew || args.allPages ? ALL : pageScope(state);
          const since = args.onlyNew ? cursor.network : Math.max(0, page.startSeq - 1);
          const filter = { url: args.filter, method: args.method, status: args.status, types: args.types, includeStatic: args.includeStatic };
          let result: { matched: NetworkEntry[]; hiddenStatic: number };
          let earlierCount = 0;
          try {
            result = filterNetwork(state.network.entries.after(since), filter);
            if (page.startSeq > 0) earlierCount = filterNetwork(state.network.entries.all().filter(e => e.seq < page.startSeq), filter).matched.length;
          } catch (err) {
            throw new ToolError('invalid_input', err instanceof Error ? err.message : String(err));
          }
          const earlier = earlierNote(earlierCount, { one: 'request', many: 'requests' });
          cursor.network = state.seq;
          const now = Date.now();
          const limited = result.matched.slice(-(args.limit ?? 100));
          const origin = pageOrigin(state.url);
          const { kept, dropped } = fitNewest(limited.map(e => formatNetworkEntry(e, now, origin)), OUTPUT_BUDGET, blockByteLimit(ctx.session.client));
          const onOrigin = origin !== undefined && limited.some(e => e.url.startsWith(`${origin}/`));
          const scope = scopeText(state, args.onlyNew, page);
          const hidden = result.hiddenStatic ? `${result.hiddenStatic} static resources (images, scripts, styles, fonts) hidden; pass includeStatic: true to see them.` : '';
          if (result.matched.length === 0) return [`No matching requests in ${call.tab.id}, ${scope}${earlier ? `; ${earlier}` : ''}.`, hidden].filter(Boolean).join('\n');
          const failed = result.matched.filter(e => e.failed || (e.status ?? 0) >= 400).length;
          const head = `${result.matched.length} request${result.matched.length === 1 ? '' : 's'} in ${call.tab.id} ${scope}${failed ? ` (${failed} failed)` : ''}${earlier ? `; ${earlier}` : ''}${onOrigin ? `; paths are relative to ${origin}` : ''}:`;
          const older = result.matched.length - limited.length + dropped;
          return [head, ...(older ? [`(${older} older requests not shown; raise limit or filter)`] : []), ...kept, ...(hidden ? [hidden] : [])].join('\n');
        }),
    }),
  ];
}

/** One request in full: timing, headers and bodies. */
async function requestDetails(call: PageCall, rawId: string, max: number): Promise<string> {
  const { state } = call;
  const id = rawId.trim().replace(/^#/, '');
  const e = state.network.byId(id);
  if (!e) throw new ToolError('not_found', `No request "${rawId}" is recorded for ${call.tab.id} (the buffer keeps the last ${state.network.entries.capacity}). List them with browser_network_requests without id.`);
  const lines: string[] = [formatNetworkEntry(e, Date.now()), `Started ${new Date(e.startedAt).toTimeString().slice(0, 8)}${e.end !== undefined ? `, took ${formatMs((e.end - e.start) * 1000)}` : ''}${e.mimeType ? `, ${e.mimeType}` : ''}${e.size !== undefined ? `, ${formatBytes(e.size)} transferred` : ''}.`];
  if (e.redirectedTo) lines.push(`Redirected to ${clip(e.redirectedTo, 500)}.`);
  if (e.intercepted) lines.push(`Not a real network response: ${e.intercepted} (browser_route).`);
  if (e.statusText) lines.push(`Status text: ${e.statusText}`);
  if (e.withheld) {
    lines.push('Sent while the user had the tab (browser_request_user_input): its URL query, headers and bodies are withheld because they may carry what the user typed.');
    return lines.join('\n');
  }
  let routine = 0;
  const headerBlock = (title: string, h: Record<string, string> | undefined) => {
    if (!h || Object.keys(h).length === 0) return [`${title}: (none recorded)`];
    const notable = notableHeaders(h);
    routine += notable.routine;
    return notable.shown.length ? [`${title}:`, ...notable.shown.map(([k, v]) => `  ${k}: ${v}`)] : [`${title}: (only routine ones)`];
  };
  lines.push(...headerBlock('Request headers', e.requestHeaders), ...headerBlock('Response headers', e.responseHeaders));
  if (routine) lines.push(`(${routine} routine header${routine === 1 ? '' : 's'} left out: pseudo-headers, sec-ch-*, sec-fetch-*, priority, accept-encoding; a har export has them all.)`);
  let post = e.postData;
  if (e.hasPostData && post === undefined && !state.dialog) {
    try {
      post = (await call.at(call.state.frames.targetOf(e.frameId)).send('Network.getRequestPostData', { requestId: e.requestId }, { timeoutMs: 5000 })).postData;
    } catch {
      post = undefined;
    }
  }
  if (e.hasPostData) lines.push('Request body:', post !== undefined ? formatBody(post, max) : '  (not available)');
  if (e.redirectedTo) lines.push('Response body: (a redirect has no body)');
  else if (e.failed) lines.push(`Response body: (none; the request failed: ${e.failed})`);
  else if (e.end === undefined) lines.push('Response body: (not complete yet)');
  else if (state.dialog) lines.push('Response body: (cannot be read while a dialog blocks the page)');
  else {
    try {
      const r = await call.at(call.state.frames.targetOf(e.frameId)).send('Network.getResponseBody', { requestId: e.requestId }, { timeoutMs: 10_000 });
      if (r.base64Encoded) {
        const bytes = Buffer.from(r.body, 'base64');
        const textual = /^(text\/|application\/(json|javascript|xml|x-www-form-urlencoded|.*\+json|.*\+xml))/.test(e.mimeType ?? '');
        lines.push(textual ? 'Response body:' : `Response body: (binary ${e.mimeType ?? ''}, ${formatBytes(bytes.length)}; not shown)`);
        if (textual) lines.push(formatBody(bytes.toString('utf8'), max));
      } else {
        lines.push(`Response body (${formatBytes(r.body.length)}):`, formatBody(r.body, max));
      }
    } catch (err) {
      if (err instanceof ToolError && err.code === 'cancelled') throw err;
      lines.push(`Response body: (no longer available: ${err instanceof Error ? err.message : String(err)}. The browser keeps bodies only for the current page and while its buffer has room.)`);
    }
  }
  return lines.join('\n');
}
