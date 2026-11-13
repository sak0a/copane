import type { BridgeServices } from '../core/services';
import { registerPageTools } from './page';
import { BrowserServiceImpl } from './service';
import { registerTabTools } from './tabTools';

/** Integrated browser: tab tracking, CDP, consent and leases, and the browser_* tools. */
export function activateBrowser(services: BridgeServices): void {
  const browser = new BrowserServiceImpl(services);
  services.browser = browser;
  services.context.subscriptions.push(browser);
  registerTabTools(services);
  registerPageTools(services);
}
