// Development only: raw, long-lived CDP sessions started from any tab (`BrowserTab.startCDPSession`),
// to probe browser contexts and their lifetime. Sessions are kept by name until closed.
import * as vscode from 'vscode';
import { z } from 'zod';
import type { BridgeServices } from '../../core/services';
import { defineTool, type ToolDefinition } from '../../core/tools';

interface Raw {
  session: vscode.BrowserCDPSession;
  nextId: number;
  pending: Map<number, (m: any) => void>;
  events: unknown[];
  closed: boolean;
}

export function debugProfileTools(services: BridgeServices): ToolDefinition<any>[] {
  if (services.context.extensionMode !== vscode.ExtensionMode.Development) return [];
  const raws = new Map<string, Raw>();
  const tabFor = (spec: string): vscode.BrowserTab => {
    const tabs = vscode.window.browserTabs;
    if (/^\d+$/.test(spec)) return tabs[Number(spec)]!;
    const byId = services.browser.getTab(spec);
    const t = tabs.find(t => (byId ? t.url === byId.url : t.url.includes(spec)));
    if (!t) throw new Error(`no tab ${spec}`);
    return t;
  };
  return [
    defineTool({
      name: 'debug_cdp_raw',
      description:
        'Development only. Long-lived raw CDP sessions: {start: name, tab} starts one from a tab (index, Copane id or URL part); {name, commands:[{method, params, sessionId}]} sends; {name, close: true} closes; {list: true}.',
      input: {
        name: z.string().optional(),
        start: z.string().optional(),
        tab: z.string().optional(),
        commands: z.array(z.object({ method: z.string(), params: z.record(z.string(), z.any()).optional(), sessionId: z.string().optional() })).optional(),
        close: z.boolean().optional(),
        list: z.boolean().optional(),
        events: z.boolean().optional(),
      },
      handler: async args => {
        if (args.list) {
          return JSON.stringify({
            sessions: [...raws].map(([k, r]) => ({ name: k, closed: r.closed })),
            tabs: vscode.window.browserTabs.map((t, i) => ({ i, url: t.url, title: t.title })),
          });
        }
        if (args.start) {
          const session = await tabFor(args.tab ?? '0').startCDPSession();
          const raw: Raw = { session, nextId: 1, pending: new Map(), events: [], closed: false };
          session.onDidReceiveMessage((m: any) => {
            if (typeof m?.id === 'number' && raw.pending.has(m.id)) {
              raw.pending.get(m.id)!(m);
              raw.pending.delete(m.id);
            } else if (raw.events.length < 200) raw.events.push(m);
          });
          session.onDidClose(() => (raw.closed = true));
          raws.set(args.start, raw);
          return `started ${args.start}`;
        }
        const raw = raws.get(args.name ?? '');
        if (!raw) throw new Error(`no session ${args.name}`);
        if (args.close) {
          await raw.session.close();
          raws.delete(args.name!);
          return 'closed';
        }
        const out: unknown[] = [];
        for (const c of args.commands ?? []) {
          const id = raw.nextId++;
          const reply = new Promise<any>(resolve => {
            raw.pending.set(id, resolve);
            setTimeout(() => resolve({ error: 'timeout' }), 10_000);
          });
          try {
            await raw.session.sendMessage({ id, method: c.method, params: c.params ?? {}, ...(c.sessionId ? { sessionId: c.sessionId } : {}) });
            const m = await reply;
            out.push({ method: c.method, result: m.result, error: m.error });
          } catch (err) {
            out.push({ method: c.method, thrown: String(err) });
          }
        }
        const result: Record<string, unknown> = { out, closed: raw.closed };
        if (args.events) result.events = raw.events.splice(0).map((e: any) => ({ method: e.method, sessionId: e.sessionId, params: JSON.stringify(e.params).slice(0, 300) }));
        return JSON.stringify(result, null, 1);
      },
    }),
  ];
}
