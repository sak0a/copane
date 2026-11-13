// browser_downloads: the downloads of a tab, and waiting for one to finish.
import { z } from 'zod';
import { defineTool, type ToolDefinition } from '../../core/tools';
import { withPage, type PageEnv } from './call';
import { describeDownload, isFinished } from './downloadLogic';
import type { DownloadManager } from './downloads';
import { tabArg } from './schema';

const LIST_LIMIT = 10;

export function downloadTools(env: PageEnv, manager: DownloadManager): ToolDefinition<any>[] {
  return [
    defineTool({
      name: 'browser_downloads',
      title: 'Downloads',
      description:
        "Lists the tab's recent downloads with their state and the path of each saved file (read it with your own file tools), or waits for one to finish. Action results already report downloads they start; use wait when a download starts late (e.g. an export that is generated first) or is still running.",
      input: {
        wait: z.boolean().optional().describe('Wait until the newest download finishes; if none is running, wait for the next one to start and finish.'),
        timeoutSeconds: z.number().min(1).max(300).optional().describe('For wait. Default 30.'),
        tab: tabArg,
      },
      annotations: { readOnlyHint: true },
      handler: (args, ctx) =>
        withPage(env, ctx, args.tab, { access: args.wait ? 'control' : 'read', allowDialog: true, skipReady: true }, async call => {
          if (args.wait) {
            const timeoutSeconds = args.timeoutSeconds ?? 30;
            const { entry, timedOut } = await manager.waitFor(call, timeoutSeconds * 1000);
            if (!entry) return `No download started in ${call.tab.id} within ${timeoutSeconds} s.`;
            if (timedOut && !isFinished(entry)) return `Still not finished after ${timeoutSeconds} s: ${describeDownload(entry)} Call again to keep waiting.`;
            return describeDownload(entry);
          }
          const entries = manager.list(call.tab.id);
          if (entries.length === 0) return `No downloads in ${call.tab.id} since the bridge attached to it.`;
          const shown = entries.slice(0, LIST_LIMIT).map(describeDownload);
          if (entries.length > LIST_LIMIT) shown.push(`… ${entries.length - LIST_LIMIT} older downloads.`);
          return shown.join('\n');
        }),
    }),
  ];
}
