import type { BridgeServices } from '../core/services';
import { registerBrowserCommands } from './commands';
import { registerPageTools } from './page';
import { BrowserServiceImpl } from './service';
import { registerTabTools } from './tabTools';

/** Integrated browser: tab tracking, CDP, consent and leases, marking, and the browser_* tools. */
export function activateBrowser(services: BridgeServices): void {
  const browser = new BrowserServiceImpl(services);
  services.browser = browser;
  services.context.subscriptions.push(browser);
  registerTabTools(services, browser);
  registerBrowserCommands(services, browser);
  registerPageTools(services);
}
