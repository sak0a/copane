import { scopedLogger } from '../core/log';
import type { BridgeServices } from '../core/services';
import { CertificateGate } from './certificates';
import { registerBrowserCommands } from './commands';
import { CredentialPrompts } from './credentials';
import { BrowserHandoffs } from './handoff';
import { FetchInterception } from './interception';
import { registerPageTools } from './page';
import { RequestRoutes } from './routes';
import { BrowserServiceImpl } from './service';
import { registerTabTools } from './tabTools';
import { activateProfiles } from './profiles';

/** Integrated browser: tab tracking, CDP, consent and leases, marking, and the browser_* tools. */
export function activateBrowser(services: BridgeServices): void {
  const browser = new BrowserServiceImpl(services);
  services.browser = browser;
  const certificates = new CertificateGate(services);
  browser.certificateRefusal = url => certificates.refusalFor(url);
  // One owner of CDP `Fetch` per tab, serving request mocking and login prompts (in that order).
  const interception = new FetchInterception(scopedLogger(services.log, 'fetch'));
  const routes = new RequestRoutes(services, browser, interception);
  const credentials = new CredentialPrompts(services, interception);
  browser.holdsRequests = tabId => interception.isActive(tabId);
  services.context.subscriptions.push(
    browser,
    interception.onDidChangeActive(() => browser.requestsHeldChanged()),
    certificates,
    browser.onDidAttachPage(page => interception.attach(page)),
    routes,
    credentials,
    interception,
    services.tools.register(routes.tools()),
  );
  const page = registerPageTools(services, browser, { interception });
  registerTabTools(services, browser, page);
  registerBrowserCommands(services, browser);
  // Handing a tab to the user (sign-ins, captchas, decisions): handoff.ts.
  const handoffs = new BrowserHandoffs(services, browser, page);
  services.context.subscriptions.push(handoffs, services.tools.register(handoffs.tools()));
  services.context.subscriptions.push(...activateProfiles(services, browser));
}
