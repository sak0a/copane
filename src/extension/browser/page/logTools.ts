// Console and network: reading what the tab recorded since the bridge attached to it.
import { z } from 'zod';
import { ToolError } from '../../core/errors';
import { defineTool, type ToolDefinition } from '../../core/tools';
import { withPage, type PageCall, type PageEnv } from './call';
import { formatConsoleEntry, levelAtLeast, shortLocation, type ConsoleEntry, type ConsoleLevel } from './consoleLog';
import { filterNetwork, formatNetworkEntry, urlMatcher, type NetworkEntry } from './networkLog';
import { clip, formatBytes, formatMs } from './ringBuffer';
import { tabArg } from './schema';

const OUTPUT_BUDGET = 24_000;

function cursorFor(env: PageEnv, call: PageCall) {
  const key = `${call.ctx.session.id}\u0000${call.tab.id}`;
  let c = env.cursors.get(key);
  if (!c) env.cursors.set(key, (c = { console: 0, network: 0 }));
  return c;
}

/** Keeps the newest lines that fit the budget; returns them oldest first and how many were dropped. */
function fitNewest(lines: string[], budget: number): { kept: string[]; dropped: number } {
  const kept: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const len = lines[i]!.length + 1;
    if (used + len > budget) return { kept: kept.reverse(), dropped: i + 1 };
    kept.push(lines[i]!);
    used += len;
  }
  return { kept: kept.reverse(), dropped: 0 };
}

function time(ms: number): string {
  return new Date(ms).toTimeString().slice(0, 8);
}

export function logTools(env: PageEnv): ToolDefinition<any>[] {
  return [
    defineTool({
      name: 'browser_console_messages',
      title: 'Console messages',
      description: "Lists the tab's console messages, uncaught errors and browser warnings, oldest first, with page loads marked.",
      input: {
        level: z.enum(['error', 'warning', 'info', 'debug']).optional().describe('Minimum level; default info (includes log).'),
        filter: z.string().optional().describe('Text or /regex/.'),
        onlyNew: z.boolean().optional().describe('Only what you have not read yet.'),
        limit: z.number().int().min(1).max(500).optional().describe('Newest N, default 100.'),
        tab: tabArg,
      },
      annotations: { readOnlyHint: true },
      handler: (args, ctx) =>
        withPage(env, ctx, args.tab, { access: 'read', allowDialog: true, skipReady: true }, async call => {
          const { state } = call;
          const cursor = cursorFor(env, call);
          const since = args.onlyNew ? cursor.console : 0;
          let match: (s: string) => boolean;
          try {
            match = urlMatcher(args.filter);
          } catch (err) {
            throw new ToolError('invalid_input', err instanceof Error ? err.message : String(err));
          }
          const min: ConsoleLevel = args.level ?? 'info';
          const entries = state.console.entries.after(since).filter(e => levelAtLeast(e.level, min) && match(e.text));
          cursor.console = state.seq;
          const limited = entries.slice(-(args.limit ?? 100));
          const navs = state.navigations.after(since).filter(n => !n.sameDocument);
          type Item = { seq: number; line: string };
          const items: Item[] = [
            ...limited.map((e: ConsoleEntry) => ({ seq: e.seq, line: `${time(e.time)} ${formatConsoleEntry(e, { withLocation: false })}${e.location ? `  (${shortLocation(e.location, state.url)})` : ''}` })),
            // Page loads between the first shown message (or the start of the range) and now.
            ...navs.filter(n => limited.length === entries.length || n.seq > limited[0]!.seq).map(n => ({ seq: n.seq, line: `${time(n.time)} --- page loaded: ${clip(n.url, 200)} ---` })),
          ].sort((a, b) => a.seq - b.seq);
          const { kept, dropped } = fitNewest(items.map(i => i.line), OUTPUT_BUDGET);
          const counts = { error: entries.filter(e => e.level === 'error').length, warning: entries.filter(e => e.level === 'warning').length };
          const scope = args.onlyNew ? 'new since your last read' : `since ${time(state.recordingSince)} (when the bridge attached)`;
          if (entries.length === 0) {
            return `No console messages${min !== 'debug' ? ` at level ${min} or above` : ''}${args.filter ? ` matching "${args.filter}"` : ''} in ${call.tab.id}, ${scope}.${state.dialog ? '\nNote: a dialog is open and blocks the page; see browser_handle_dialog.' : ''}`;
          }
          const head = `${entries.length} console message${entries.length === 1 ? '' : 's'} in ${call.tab.id} ${scope} (${counts.error} errors, ${counts.warning} warnings):`;
          const notes = [
            entries.length > limited.length || dropped ? `(${entries.length - limited.length + dropped} older messages not shown; raise limit or use filter)` : '',
            state.console.entries.dropped && !args.onlyNew ? `(the buffer keeps the last ${state.console.entries.capacity}; ${state.console.entries.dropped} older messages were discarded)` : '',
          ].filter(Boolean);
          return [head, ...notes, ...kept].join('\n');
        }),
    }),
    defineTool({
      name: 'browser_network_requests',
      title: 'Network requests',
      description: "Lists the tab's network requests (id, method, status, type, URL, time, size), oldest first; with id, shows one request's headers and bodies.",
      input: {
        id: z.string().optional().describe('e.g. "r12", from a list or an action result.'),
        filter: z.string().optional().describe('URL text, glob (*) or /regex/.'),
        method: z.string().optional(),
        status: z.string().optional().describe('"failed", "pending", "2xx", "404", ...'),
        types: z.array(z.string()).optional().describe('fetch, xhr, document, script, image, websocket, ...'),
        includeStatic: z.boolean().optional().describe('Also list images, fonts, styles and scripts.'),
        onlyNew: z.boolean().optional().describe('Only what you have not read yet.'),
        limit: z.number().int().min(1).max(500).optional().describe('Newest N, default 100.'),
        maxBodyChars: z.number().int().min(100).max(20_000).optional().describe('With id: cut bodies here, default 4000.'),
        tab: tabArg,
      },
      annotations: { readOnlyHint: true },
      handler: (args, ctx) =>
        withPage(env, ctx, args.tab, { access: 'read', allowDialog: true, skipReady: true }, async call => {
          if (args.id !== undefined) return requestDetails(call, args.id, args.maxBodyChars ?? 4000);
          const { state } = call;
          const cursor = cursorFor(env, call);
          const since = args.onlyNew ? cursor.network : 0;
          let result: { matched: NetworkEntry[]; hiddenStatic: number };
          try {
            result = filterNetwork(state.network.entries.after(since), { url: args.filter, method: args.method, status: args.status, types: args.types, includeStatic: args.includeStatic });
          } catch (err) {
            throw new ToolError('invalid_input', err instanceof Error ? err.message : String(err));
          }
          cursor.network = state.seq;
          const now = Date.now();
          const limited = result.matched.slice(-(args.limit ?? 100));
          const { kept, dropped } = fitNewest(limited.map(e => formatNetworkEntry(e, now)), OUTPUT_BUDGET);
          const scope = args.onlyNew ? 'new since your last read' : `since ${time(state.recordingSince)} (when the bridge attached)`;
          const hidden = result.hiddenStatic ? `${result.hiddenStatic} static resources (images, scripts, styles, fonts) hidden; pass includeStatic: true to see them.` : '';
          if (result.matched.length === 0) return [`No matching requests in ${call.tab.id}, ${scope}.`, hidden].filter(Boolean).join('\n');
          const failed = result.matched.filter(e => e.failed || (e.status ?? 0) >= 400).length;
          const head = `${result.matched.length} request${result.matched.length === 1 ? '' : 's'} in ${call.tab.id} ${scope}${failed ? ` (${failed} failed)` : ''}:`;
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
  const headerBlock = (title: string, h: Record<string, string> | undefined) => {
    if (!h || Object.keys(h).length === 0) return [`${title}: (none recorded)`];
    return [`${title}:`, ...Object.entries(h).map(([k, v]) => `  ${k}: ${v}`)];
  };
  lines.push(...headerBlock('Request headers', e.requestHeaders), ...headerBlock('Response headers', e.responseHeaders));
  let post = e.postData;
  if (e.hasPostData && post === undefined && !state.dialog) {
    try {
      post = (await call.at(call.state.frames.targetOf(e.frameId)).send('Network.getRequestPostData', { requestId: e.requestId }, { timeoutMs: 5000 })).postData;
    } catch {
      post = undefined;
    }
  }
  if (e.hasPostData) lines.push('Request body:', post !== undefined ? indentBody(post, max) : '  (not available)');
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
        if (textual) lines.push(indentBody(bytes.toString('utf8'), max));
      } else {
        lines.push(`Response body (${formatBytes(r.body.length)}):`, indentBody(r.body, max));
      }
    } catch (err) {
      if (err instanceof ToolError && err.code === 'cancelled') throw err;
      lines.push(`Response body: (no longer available: ${err instanceof Error ? err.message : String(err)}. The browser keeps bodies only for the current page and while its buffer has room.)`);
    }
  }
  return lines.join('\n');
}

function indentBody(body: string, max: number): string {
  let text = body;
  if (/^\s*[{[]/.test(text) && text.length < 200_000) {
    try {
      text = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      // not JSON after all
    }
  }
  const cut = text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters; raise maxBodyChars to see more)` : text;
  return cut
    .split('\n')
    .map(l => `  ${l}`)
    .join('\n');
}
