import { ToolError } from '../core/errors';
import { Emitter } from '../core/events';
import type { BridgeServices, BrowserService } from '../core/services';

const unavailable = (): never => {
  throw new ToolError('unavailable', 'Browser tools are not implemented yet.');
};

/** Integrated browser: tab tracking, CDP, consent and leases, and the browser_* tools. */
export function activateBrowser(services: BridgeServices): void {
  // Placeholder so the extension runs end to end. Replaced by the browser work package.
  const changed = new Emitter<void>();
  const attached = new Emitter<never>();
  const browser: BrowserService = {
    available: false,
    onDidChange: changed.event,
    onDidAttachPage: attached.event,
    listTabs: () => [],
    getTab: () => undefined,
    acquire: unavailable,
    openTab: unavailable,
    closeTab: unavailable,
    revealTab: unavailable,
    releaseTab: () => {},
    setPaused: () => {},
  };
  services.browser = browser;
}
