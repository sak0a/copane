import { Emitter } from '../core/events';
import type { BridgeServices, TerminalService } from '../core/services';

/** Integrated terminals: agent-owned terminals, output capture, user hand-off, and the terminal_* tools. */
export function activateTerminals(services: BridgeServices): void {
  // Placeholder so the extension runs end to end. Replaced by the terminal work package.
  const changed = new Emitter<void>();
  const terminals: TerminalService = {
    onDidChange: changed.event,
    list: () => [],
    get: () => undefined,
    reveal: () => {},
    interrupt: () => {},
    close: () => {},
  };
  services.terminals = terminals;
}
