// Page automation: everything an agent does inside a browser tab. Navigation, reading the page
// (snapshot, screenshot), acting on it with real input, waiting, console and network, dialogs, and
// JavaScript evaluation. Every tool goes through `services.browser.acquire`, with "read" for tools that
// only look and "control" for tools that change the page.
//
// State kept here, never on the shared CdpPage: one PageState per tab (recorders, frames, dialog), and
// per-session ref tables and read cursors.
import type { BridgeServices } from '../../core/services';
import { actionTools } from './actionTools';
import { DownloadManager } from './downloads';
import { downloadTools } from './downloadTools';
import { EmulationManager, type TabInfoHost } from './emulation';
import { emulationTools } from './emulationTools';
import type { PageEnv } from './call';
import { debugCdpTools } from './debugCdp';
import { logTools } from './logTools';
import { navigationTools } from './navigationTools';
import { PageStates } from './pageState';
import { RefStore } from './refs';
import { scriptTools } from './scriptTools';
import { snapshotTools } from './snapshotTools';
import { waitTools } from './waitTools';

export function registerPageTools(services: BridgeServices, host: TabInfoHost): void {
  const { browser, context } = services;
  const env: PageEnv = { services, states: new PageStates(services.log), refs: new RefStore(), cursors: new Map() };
  // Downloads and device emulation (downloads.ts, emulation.ts) hook into page tool calls.
  const downloads = new DownloadManager(services, host, tabId => env.states.get(tabId)?.nextSeq() ?? 0);
  const emulation = new EmulationManager(services, host);
  env.hooks = [downloads, emulation];
  context.subscriptions.push(downloads, emulation);

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
      ...downloadTools(env, downloads),
      ...emulationTools(env, emulation),
      ...debugCdpTools(services),
    ]),
  );
}
