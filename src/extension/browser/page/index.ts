// Page automation: everything an agent does inside a browser tab. Navigation, reading the page
// (snapshot, screenshot), acting on it with real input, waiting, console and network, dialogs, and
// JavaScript evaluation. Every tool goes through `services.browser.acquire`, with "read" for tools that
// only look and "control" for tools that change the page.
//
// State kept here, never on the shared CdpPage: one PageState per tab (recorders, frames, dialog), and
// per-session ref tables, read cursors and the last view of each page (for reporting changes).
import type { Event } from '../../core/events';
import type { BridgeServices, CdpPage } from '../../core/services';
import type { ToolContext } from '../../core/tools';
import { actionTools } from './actionTools';
import { DownloadManager } from './downloads';
import { downloadTools } from './downloadTools';
import { EmulationManager, type TabInfoHost } from './emulation';
import { emulationTools } from './emulationTools';
import type { PageEnv } from './call';
import { debugCdpTools } from './debugCdp';
import { logTools } from './logTools';
import { describeOpened, navigationTools } from './navigationTools';
import { PageStates } from './pageState';
import { RefStore } from './refs';
import { scriptTools } from './scriptTools';
import { snapshotTools } from './snapshotTools';
import { waitTools } from './waitTools';

/** Sources of per-tab information from the rest of the browser module (request interception). */
export interface PageToolExtras {
  interception?: {
    /** A sentence for the agent driving the tab, shown with its next action result. */
    readonly onDidNote: Event<{ tabId: string; text: string; topic?: string; to?: string }>;
    /** A request was answered by the bridge (mocked, delayed, ...): marked in the network log. */
    readonly onDidIntercept: Event<{ tabId: string; networkId: string; note: string }>;
    /** Serves a cross-origin frame target of a tab too; resolves once what the tab needs is in effect there. */
    attachFrame?(session: CdpPage): Promise<void>;
  };
}

export interface PageHooks {
  /** Waits for a tab just opened on `url` to load, and describes it (see describeOpened). */
  describeOpened(ctx: ToolContext, tabId: string, url: string): Promise<string>;
}

export function registerPageTools(services: BridgeServices, host: TabInfoHost, extras: PageToolExtras = {}): PageHooks {
  const { browser, context } = services;
  // Frame targets are served by request interception too (rules and login prompts reach into frames).
  const attachFrame = extras.interception?.attachFrame?.bind(extras.interception);
  const env: PageEnv = { services, states: new PageStates(services.log, attachFrame), refs: new RefStore(), cursors: new Map(), baselines: new Map() };
  // Downloads and device emulation (downloads.ts, emulation.ts) hook into page tool calls.
  const downloads = new DownloadManager(services, host, tabId => env.states.get(tabId)?.nextSeq() ?? 0);
  const emulation = new EmulationManager(services, host);
  env.hooks = [downloads, emulation];
  context.subscriptions.push(downloads, emulation);
  if (extras.interception) {
    context.subscriptions.push(
      extras.interception.onDidNote(({ tabId, text, topic, to }) => env.states.get(tabId)?.addNote(text, { topic, to })),
      extras.interception.onDidIntercept(({ tabId, networkId, note }) => env.states.get(tabId)?.network.annotate(networkId, note)),
    );
  }

  // Recording starts as soon as a tab's CDP connection exists.
  context.subscriptions.push(
    browser.onDidAttachPage(page => {
      env.states.forPage(page);
      page.onDidClose(() => {
        // A closed connection of a tab that still exists is re-attached later; keep its history.
        setTimeout(() => {
          if (browser.getTab(page.tabId)) return;
          env.states.delete(page.tabId);
          env.refs.dropTab(page.tabId);
          for (const map of [env.cursors, env.baselines]) for (const key of [...map.keys()]) if (key.endsWith(`\u0000${page.tabId}`)) map.delete(key);
        }, 0);
      });
    }),
    // Focus emulation (input.ts) lasts as long as an agent controls the tab.
    services.tabLeases.onDidChange(change => {
      if (!change.lease) env.states.get(change.resourceId)?.endFocusEmulation();
    }),
    services.sessions.onDidChange(change => {
      if (change.type !== 'removed') return;
      env.refs.dropSession(change.session.id);
      for (const map of [env.cursors, env.baselines]) for (const key of [...map.keys()]) if (key.startsWith(`${change.session.id}\u0000`)) map.delete(key);
    }),
    { dispose: () => env.states.dispose() },
    services.tools.register([
      ...navigationTools(env),
      ...snapshotTools(env),
      ...actionTools(env),
      ...waitTools(env),
      ...logTools(env),
      ...scriptTools(env),
      ...downloadTools(env, downloads),
      ...emulationTools(env, emulation),
      ...debugCdpTools(services),
    ]),
  );
  return { describeOpened: (ctx, tabId, url) => describeOpened(env, ctx, tabId, url) };
}
