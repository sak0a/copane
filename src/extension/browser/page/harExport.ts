// browser_network_requests with `har`: writes the tab's recorded requests as a HAR 1.2 file
// (harLogic.ts builds it) and answers with the path and a summary, never the content.
//
// Response bodies are read from the browser only when asked ("bodies"): it keeps them for the current
// document and while its buffer has room, and a HAR with every body is easily tens of megabytes.
// Secrets are masked unless asked ("secrets"); the file is where the agent can read it either way.
import { ToolError } from '../../core/errors';
import { agentFilePath, writeAgentFile } from './agentFile';
import type { PageCall } from './call';
import { buildHar, isTextual, type BodyResult, type HarPageInfo } from './harLogic';
import type { NetworkEntry } from './networkLog';
import { DialogInterrupt } from './pageState';
import { formatBytes } from './ringBuffer';

const MAX_BODY = 2_000_000;
const MAX_BODIES_TOTAL = 25_000_000;
const LONG_LIVED = new Set(['EventSource', 'WebSocket']);
const OURS = /^\{\s*"log":\s*\{\s*"version":\s*"1\.2",\s*"creator":\s*\{\s*"name":\s*"Copane"/;

export type HarInclude = 'bodies' | 'secrets';

/** The current document's title, load timings and browser version, read in the bridge's isolated world. */
const READ_PAGE = `function () {
  const nav = performance.getEntriesByType('navigation')[0];
  return {
    start: performance.timeOrigin,
    title: document.title,
    onContentLoad: nav && nav.domContentLoadedEventStart > 0 ? nav.domContentLoadedEventStart : undefined,
    onLoad: nav && nav.loadEventStart > 0 ? nav.loadEventStart : undefined,
    chrome: (/Chrome\\/([\\d.]+)/.exec(navigator.userAgent) || [])[1] || '',
  };
}`;

export async function exportHar(call: PageCall, entries: NetworkEntry[], path: string, include: HarInclude[]): Promise<string> {
  const { state } = call;
  const target = agentFilePath(call.env, call.ctx, path, {
    extensions: ['.har'],
    extensionHint: 'The path must end in .har (e.g. "network.har").',
    isOurs: head => OURS.test(head),
    tool: 'browser_network_requests',
  });
  const secrets = include.includes('secrets');
  const wantBodies = include.includes('bodies');

  let page: { start?: number; title?: string; onContentLoad?: number; onLoad?: number; chrome?: string } = {};
  if (!state.dialog) {
    try {
      page = await call.evaluate(READ_PAGE, [], { timeoutMs: 3000 });
    } catch (err) {
      if (err instanceof ToolError && err.code === 'cancelled') throw err;
    }
  }
  const current: HarPageInfo = { loaderId: state.loaderId, startedAt: page.start, url: state.url, title: page.title, onContentLoad: page.onContentLoad, onLoad: page.onLoad };

  const bodies = wantBodies ? new Map<string, BodyResult>() : undefined;
  const postData = wantBodies ? new Map<string, string>() : undefined;
  if (bodies && postData) await readBodies(call, entries, bodies, postData);

  const version = String(call.env.services.context.extension?.packageJSON?.version ?? '0');
  const { har, stats } = buildHar({
    entries,
    mainFrameId: state.mainFrameId,
    current,
    bodies,
    postData,
    secrets,
    creator: { name: 'Copane', version },
    browser: { name: "VS Code's integrated browser (Chromium)", version: page.chrome || '' },
    comment: [
      `Recorded by Copane from ${call.tab.id} since ${new Date(state.recordingSince).toISOString()}.`,
      secrets ? 'Secrets were not masked (Authorization headers are never recorded).' : 'Cookie values and secret-looking headers, query parameters and body fields are replaced by "(masked)"; Authorization headers are never recorded.',
      wantBodies ? '' : 'Response bodies are not included.',
      'headersSize and response bodySize are not recorded (-1); _transferSize is the bytes received.',
    ]
      .filter(Boolean)
      .join(' '),
  });
  const data = JSON.stringify(har, null, 2);
  writeAgentFile(target, data);

  const lines = [
    `Wrote ${target.shown} (${formatBytes(Buffer.byteLength(data))}): ${stats.entries} request${stats.entries === 1 ? '' : 's'}${stats.frameEntries ? ` (${stats.frameEntries} from cross-origin frames)` : ''} on ${stats.pages} page${stats.pages === 1 ? '' : 's'}, HAR 1.2. It opens in Chrome DevTools (Network, Import HAR), Firefox or a HAR viewer.`,
  ];
  if (secrets) lines.push('Nothing was masked (Authorization headers are never recorded, only their scheme). Treat the file as secret.');
  else if (stats.masked.empty) lines.push('No cookies or secret-looking values were found to mask (Authorization headers are never recorded). harInclude ["secrets"] would keep them.');
  else lines.push(`Masked: ${stats.masked.summary()}. Authorization headers are never recorded. harInclude ["secrets"] keeps the values, which you can then read too.`);
  if (!wantBodies) lines.push('Response bodies are not included; harInclude ["bodies"] adds those the browser still has (current page).');
  else {
    const missing = [...stats.bodies.missing].map(([why, n]) => `${n} ${why}`).join('; ');
    lines.push(
      `Response bodies: ${stats.bodies.included} included${missing ? `; not included: ${missing}` : ''}.${secrets ? '' : ' In bodies only JSON and form fields with secret-looking names and JWT-like values are masked; HTML, scripts and other text are as the server sent them.'}`,
    );
  }
  if (stats.withheld) lines.push(`${stats.withheld} request${stats.withheld === 1 ? ' was' : 's were'} sent while the user had the tab: in the file without URL query, headers or bodies.`);
  if (stats.pending) lines.push(`${stats.pending} not finished when exported (marked in the entry's comment).`);
  if (state.network.entries.dropped) lines.push(`The log keeps the last ${state.network.entries.capacity} requests; ${state.network.entries.dropped} older ones are not in the file.`);
  return lines.join('\n');
}

async function readBodies(call: PageCall, entries: NetworkEntry[], bodies: Map<string, BodyResult>, postData: Map<string, string>): Promise<void> {
  const { state } = call;
  let total = 0;
  const queue = [...entries];
  const worker = async () => {
    for (let e = queue.shift(); e; e = queue.shift()) {
      if (e.withheld) continue;
      const at = call.at(state.frames.targetOf(e.frameId));
      if (e.hasPostData && (e.postData === undefined || e.postData.length >= 20_000)) {
        try {
          postData.set(e.id, (await at.send('Network.getRequestPostData', { requestId: e.requestId }, { timeoutMs: 5000 })).postData);
        } catch (err) {
          if (err instanceof ToolError && err.code === 'cancelled') throw err;
        }
      }
      if (e.redirectedTo || e.failed || LONG_LIVED.has(e.type) || e.method === 'OPTIONS') continue;
      if (e.end === undefined) {
        bodies.set(e.id, { missing: 'not finished' });
        continue;
      }
      if (state.dialog) {
        bodies.set(e.id, { missing: 'unreadable while a dialog blocks the page' });
        continue;
      }
      if (total >= MAX_BODIES_TOTAL) {
        bodies.set(e.id, { missing: `over the ${formatBytes(MAX_BODIES_TOTAL)} total` });
        continue;
      }
      try {
        const r = await at.send<{ body: string; base64Encoded: boolean }>('Network.getResponseBody', { requestId: e.requestId }, { timeoutMs: 10_000 });
        let text = r.body;
        let base64 = r.base64Encoded;
        let size = base64 ? Math.floor((text.length * 3) / 4) : Buffer.byteLength(text);
        if (base64 && isTextual(e.mimeType)) {
          text = Buffer.from(text, 'base64').toString('utf8');
          base64 = false;
          size = Buffer.byteLength(text);
        }
        if (size > MAX_BODY) {
          bodies.set(e.id, { missing: `over ${formatBytes(MAX_BODY)} each` });
          continue;
        }
        total += size;
        bodies.set(e.id, { text, base64, size });
      } catch (err) {
        if (err instanceof ToolError && err.code === 'cancelled') throw err;
        if (err instanceof DialogInterrupt) bodies.set(e.id, { missing: 'unreadable while a dialog blocks the page' });
        else bodies.set(e.id, { missing: 'no longer kept by the browser (an earlier page, or its buffer was full)' });
      }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
}
