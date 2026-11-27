import { scopedLogger } from '../core/log';
import type { BridgeServices } from '../core/services';
import type { ToolRegistry } from '../core/tools';
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
  // Without the proposed browser API every browser tool can only fail, and tool definitions cost every
  // conversation, so they are not listed (the instructions say how to enable it). `available` is read
  // once: enabling the API takes a restart of VS Code, which activates the extension again.
  const toolServices = browser.available ? services : withoutTools(services);
  const certificates = new CertificateGate(services);
  browser.certificateRefusal = url => certificates.refusalFor(url);
  // One owner of CDP `Fetch` per tab, serving request mocking and login prompts (in that order).
  const interception = new FetchInterception(scopedLogger(services.log, 'fetch'));
  const routes = new RequestRoutes(services, browser, interception);
  const credentials = new CredentialPrompts(services, interception);
  browser.loginAskedByVsCode = tabId => credentials.vscodeAsks(tabId);
  browser.deferFirstLoad = url => (credentials.defersFirstLoad(url) ? tabId => credentials.loadWhenAttached(tabId, url) : undefined);
  browser.holdsRequests = tabId => interception.isActive(tabId);
  services.context.subscriptions.push(
    browser,
    interception.onDidChangeActive(() => browser.requestsHeldChanged()),
    certificates,
    browser.onDidAttachPage(page => interception.attach(page)),
    routes,
    credentials,
    interception,
    toolServices.tools.register(routes.tools()),
  );
  const page = registerPageTools(toolServices, browser, { interception });
  registerTabTools(toolServices, browser, page);
  registerBrowserCommands(services, browser);
  // Handing a tab to the user (sign-ins, captchas, decisions): handoff.ts.
  const handoffs = new BrowserHandoffs(services, browser, page);
  services.context.subscriptions.push(handoffs, toolServices.tools.register(handoffs.tools()));
  // Registers nothing at all without the browser.
  services.context.subscriptions.push(...activateProfiles(services, browser));
}

/** `services` whose tool registry lists nothing registered through it; everything else is `services` itself. */
function withoutTools(services: BridgeServices): BridgeServices {
  const tools = Object.assign(Object.create(services.tools) as ToolRegistry, { register: () => ({ dispose() {} }) });
  return new Proxy(services, { get: (target, key, receiver) => (key === 'tools' ? tools : Reflect.get(target, key, receiver)) });
}
