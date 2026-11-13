// Development only: raw CDP access to a tab, for probing what the integrated browser supports.
import * as vscode from 'vscode';
import { z } from 'zod';
import type { BridgeServices } from '../../core/services';
import { defineTool, type ToolDefinition } from '../../core/tools';

export function debugCdpTools(services: BridgeServices): ToolDefinition<any>[] {
  if (services.context.extensionMode !== vscode.ExtensionMode.Development) return [];
  return [
    defineTool({
      name: 'debug_cdp',
      description: 'Development only. Sends raw CDP commands to a tab page target in order and collects events for `listenMs`.',
      input: {
        tab: z.string().optional(),
        commands: z.array(z.object({ method: z.string(), params: z.record(z.string(), z.any()).optional(), timeoutMs: z.number().optional(), noWait: z.boolean().optional(), session: z.string().optional() })),
        events: z.array(z.string()).optional(),
        watch: z.array(z.string()).optional().describe('Child session ids whose events to collect too.'),
        listenMs: z.number().optional(),
        maxChars: z.number().optional(),
      },
      handler: async (args, ctx) => {
        const { page } = await services.browser.acquire(ctx.session, args.tab, 'control', ctx.signal);
        const seen: unknown[] = [];
        const subs = (args.events ?? []).map(e => page.on(e, p => seen.push({ event: e, params: p, t: Date.now() })));
        // Child sessions (out-of-process iframes): the same events, tagged with the session.
        const watchChild = (sessionId: string) => {
          const child = page.childSession?.(sessionId);
          if (!child) return;
          for (const e of [...(args.events ?? []), 'Target.attachedToTarget']) subs.push(child.on(e, p => {
            if (e === 'Target.attachedToTarget') watchChild(p.sessionId);
            if ((args.events ?? []).includes(e)) seen.push({ session: sessionId, event: e, params: p, t: Date.now() });
          }));
        };
        subs.push(page.on('Target.attachedToTarget', p => watchChild(p.sessionId)));
        for (const id of args.watch ?? []) watchChild(id);
        const out: unknown[] = [];
        try {
          for (const c of args.commands) {
            const t = Date.now();
            const target = c.session ? page.childSession?.(c.session) ?? page : page;
            const p = target.send(c.method, c.params ?? {}, { timeoutMs: c.timeoutMs ?? 15000 });
            if (c.noWait) {
              p.then(r => out.push({ late: c.method, ms: Date.now() - t, r }), e => out.push({ late: c.method, error: String(e) }));
              continue;
            }
            try {
              const r = await p;
              out.push({ method: c.method, ms: Date.now() - t, size: JSON.stringify(r).length, result: (args.maxChars ?? 20000) < 0 ? undefined : r });
            } catch (err) {
              out.push({ method: c.method, ms: Date.now() - t, error: String(err) });
            }
          }
          if (args.listenMs) await new Promise(r => setTimeout(r, args.listenMs));
        } finally {
          for (const s of subs) s.dispose();
        }
        const s = JSON.stringify({ out, events: seen }, null, 1);
        return s.length > (args.maxChars ?? 20000) ? s.slice(0, args.maxChars ?? 20000) + `\n...[${s.length} chars]` : s;
      },
    }),
  ];
}
