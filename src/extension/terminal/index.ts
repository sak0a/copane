import * as vscode from 'vscode';
import type { BridgeServices } from '../core/services';
import { TerminalManager, type Tracked } from './manager';
import { terminalTools } from './tools';

/** Integrated terminals: agent-owned terminals, output capture, user hand-off, and the terminal_* tools. */
export function activateTerminals(services: BridgeServices): void {
  const manager = new TerminalManager(services);
  services.terminals = manager;
  services.context.subscriptions.push(manager, services.tools.register(terminalTools(services, manager)));

  // The user ends a hand-off from the terminal panel's title bar or the command palette.
  const pick = async (terminalId: unknown): Promise<Tracked | undefined> => {
    if (typeof terminalId === 'string') return manager.find(terminalId);
    const pending = manager.pendingHandoffs();
    const active = manager.forTerminal(vscode.window.activeTerminal);
    if (active?.handoff) return active;
    if (pending.length <= 1) return pending[0];
    const answer = await services.prompts.ask({ message: 'Which terminal request is this about?', choices: pending.map(t => `${t.name}: ${t.handoff!.message}`.slice(0, 80)) });
    return pending.find(t => answer === `${t.name}: ${t.handoff!.message}`.slice(0, 80));
  };
  services.context.subscriptions.push(
    vscode.commands.registerCommand('agentBridge.terminal.finishRequest', async (terminalId?: unknown) => {
      const t = await pick(terminalId);
      if (t) manager.resolveUserRequest(t.id, 'done');
    }),
    vscode.commands.registerCommand('agentBridge.terminal.declineRequest', async (terminalId?: unknown) => {
      const t = await pick(terminalId);
      if (t) manager.resolveUserRequest(t.id, 'declined');
    }),
  );
  void vscode.commands.executeCommand('setContext', 'agentBridge.terminal.waitingForUser', false);
}
