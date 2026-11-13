import { scopedLogger } from '../core/log';
import type { BridgeServices } from '../core/services';
import { CertificateGate } from './certificates';
import { registerBrowserCommands } from './commands';
import { CredentialPrompts } from './credentials';
import { FetchInterception } from './interception';
import { registerPageTools } from './page';
import { RequestRoutes } from './routes';
import { BrowserServiceImpl } from './service';
import { registerTabTools } from './tabTools';

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
  services.context.subscriptions.push(
    browser,
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
}
