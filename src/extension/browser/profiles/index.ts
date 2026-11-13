// Login profiles: tabs in separate in-memory login stores, chosen by the agent (browser_open `profile`,
// browser_profiles) or the user (commands, Sessions view). See model.ts and docs/browser-profiles.md.
import type * as vscode from 'vscode';
import type { BridgeServices } from '../../core/services';
import type { BrowserServiceImpl } from '../service';
import { registerProfileCommands } from './commands';
import { debugProfileTools } from './debug';
import { ProfileManager } from './manager';
import { profileTools } from './tools';

export { PRECEDENCE } from './tools';

export function activateProfiles(services: BridgeServices, browser: BrowserServiceImpl): vscode.Disposable[] {
  if (!browser.available) return [];
  const profiles = new ProfileManager(services, browser);
  browser.opener = (session, url, options) => profiles.openForAgent(session, url, options);
  browser.markerNote = tabId => profiles.markerNote(tabId);
  browser.sessionProfile = sessionId => profiles.sessionProfile(sessionId);
  browser.openNote = tabId => profiles.takeNote(tabId);
  return [
    profiles,
    services.tools.register([...profileTools(services, browser, profiles), ...debugProfileTools(services)]),
    ...registerProfileCommands(services, browser, profiles),
  ];
}
