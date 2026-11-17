// Offers Copane to VS Code's own MCP client (chat and agent mode) as an extension-provided server
// definition, opt-in with `copane.vscodeChat.serverDefinition`. The definition starts the same
// launcher agents are registered with, plus `COPANE_INSTANCE` = this window, so the server connects to
// this window wherever VS Code starts it: under the Local harness this window's extension host spawns
// it; the Copilot harness gets the definition forwarded (with its env) and its Agent Host, shared by
// all windows, spawns it. See docs/ARCHITECTURE.md, "VS Code chat".
//
// Command (internal, not in the palette): copane.vscodeChat.serverDefinitions returns what the
// provider offers now and whether VS Code has asked for it, for tests and diagnosis.
import * as vscode from 'vscode';
import { scopedLogger } from '../core/log';
import type { BridgeServices } from '../core/services';
import { PROVIDER_ID, serverDefinitions, type DefinitionData } from './definition';

const SETTING = 'copane.vscodeChat.serverDefinition';

interface ProviderState {
  /** VS Code has the API (`vscode.lm.registerMcpServerDefinitionProvider`). */
  apiAvailable: boolean;
  /** The provider is registered with VS Code. */
  registered: boolean;
  /** Why it is not registered, if it is not. */
  problem?: string;
  enabled: boolean;
  definitions: DefinitionData[];
  /** Why nothing is offered, when nothing is. */
  reason?: string;
  /** How often VS Code asked the provider for its definitions (it does after registration and each change). */
  provided: number;
}

export function activateVscodeChat(services: BridgeServices): void {
  const { context } = services;
  const log = scopedLogger(services.log, 'vscode-chat');
  const enabled = () => vscode.workspace.getConfiguration().get<boolean>(SETTING, false) === true;
  const current = () =>
    serverDefinitions({
      enabled: enabled(),
      spec: services.mcpServer?.spec(),
      installError: services.mcpServer?.installError(),
      instanceId: services.window.instanceId,
      version: String(context.extension.packageJSON.version),
    });

  const state: ProviderState = { apiAvailable: false, registered: false, enabled: false, definitions: [], provided: 0 };
  const snapshot = (): ProviderState => {
    const { definitions, reason } = current();
    return { ...state, enabled: enabled(), definitions, ...(reason ? { reason } : {}) };
  };
  context.subscriptions.push(vscode.commands.registerCommand('copane.vscodeChat.serverDefinitions', () => snapshot()));

  // Feature detection: forks of VS Code and older builds may lack the API. The engine requirement
  // (1.140) has it, but a missing API must cost nothing more than one log line.
  const lm = (vscode as { lm?: Partial<typeof vscode.lm> }).lm;
  const StdioDefinition = (vscode as { McpStdioServerDefinition?: typeof vscode.McpStdioServerDefinition }).McpStdioServerDefinition;
  if (typeof lm?.registerMcpServerDefinitionProvider !== 'function' || typeof StdioDefinition !== 'function') {
    state.problem = 'this VS Code has no MCP server definition provider API (vscode.lm.registerMcpServerDefinitionProvider)';
    log.info(`not offering the server to VS Code's chat: ${state.problem}`);
    return;
  }
  state.apiAvailable = true;

  const changed = new vscode.EventEmitter<void>();
  let lastLogged = '';
  const provider: vscode.McpServerDefinitionProvider<vscode.McpStdioServerDefinition> = {
    onDidChangeMcpServerDefinitions: changed.event,
    provideMcpServerDefinitions: () => {
      state.provided++;
      const { definitions, reason } = current();
      const summary = definitions.length ? `offering ${definitions[0]!.command} with ${Object.keys(definitions[0]!.env).join(', ')}` : `offering nothing: ${reason}`;
      if (summary !== lastLogged) log.info(summary);
      lastLogged = summary;
      return definitions.map(d => new StdioDefinition(d.label, d.command, d.args, d.env, d.version));
    },
  };
  try {
    context.subscriptions.push(changed, lm.registerMcpServerDefinitionProvider(PROVIDER_ID, provider));
    state.registered = true;
  } catch (err) {
    state.problem = `VS Code refused the provider: ${err instanceof Error ? err.message : String(err)}`;
    log.warn(state.problem);
    changed.dispose();
    return;
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration(SETTING)) changed.fire();
    }),
  );
  // Set by the registration module, which activates before this one (extension.ts).
  if (services.mcpServer) context.subscriptions.push(services.mcpServer.onDidChange(() => changed.fire()));
  // The instance id is this extension host's pid: it does not change while this provider exists.
}
