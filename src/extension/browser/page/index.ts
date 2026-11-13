// Page automation: everything an agent does inside a browser tab. Navigation, reading the page
// (snapshot, screenshot), acting on it with real input, waiting, console and network, dialogs, and
// JavaScript evaluation. Every tool goes through `services.browser.acquire`, with "read" for tools that
// only look and "control" for tools that change the page.
//
// State kept here, never on the shared CdpPage: one PageState per tab (recorders, frames, dialog), and
// per-session ref tables and read cursors.
import type { Event } from '../../core/events';
import type { BridgeServices } from '../../core/services';
import { actionTools } from './actionTools';
import type { PageEnv } from './call';
import { debugCdpTools } from './debugCdp';
import { logTools } from './logTools';
import { navigationTools } from './navigationTools';
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
  };
}

export function registerPageTools(services: BridgeServices, extras: PageToolExtras = {}): void {
  const { browser, context } = services;
  const env: PageEnv = { services, states: new PageStates(services.log), refs: new RefStore(), cursors: new Map() };
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
          for (const key of [...env.cursors.keys()]) if (key.endsWith(`\u0000${page.tabId}`)) env.cursors.delete(key);
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
      for (const key of [...env.cursors.keys()]) if (key.startsWith(`${change.session.id}\u0000`)) env.cursors.delete(key);
    }),
    { dispose: () => env.states.dispose() },
    services.tools.register([
      ...navigationTools(env),
      ...snapshotTools(env),
      ...actionTools(env),
      ...waitTools(env),
      ...logTools(env),
      ...scriptTools(env),
      ...debugCdpTools(services),
    ]),
  );
}
