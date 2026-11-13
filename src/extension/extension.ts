// Extension entry point: builds the core services, lets each module register its tools and UI, then
// starts the bridge server and publishes this window so agents can connect.
import * as vscode from 'vscode';
import { activateBrowser } from './browser';
import { BridgeServer } from './core/bridgeServer';
import { activateDebugTools } from './core/debugTools';
import { describeWindow, InstanceRegistration } from './core/instance';
import { buildInstructions } from './core/instructions';
import { LeaseManager } from './core/leases';
import type { Logger } from './core/log';
import { VscodePrompts } from './core/prompts';
import type { BridgeServices } from './core/services';
import { SessionManager } from './core/sessions';
import { ToolRegistry } from './core/tools';
import { activateRegistration } from './registration';
import { activateSessionTools } from './core/sessionTools';
import { activateTerminals } from './terminal';
import { activateUi } from './ui';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const channel = vscode.window.createOutputChannel('Agent Bridge', { log: true });
  const log: Logger = {
    debug: (m, ...a) => channel.debug(m, ...a),
    info: (m, ...a) => channel.info(m, ...a),
    warn: (m, ...a) => channel.warn(m, ...a),
    error: (m, ...a) => channel.error(m, ...a),
  };
  context.subscriptions.push(channel, vscode.commands.registerCommand('agentBridge.showLog', () => channel.show()));

  const config = () => vscode.workspace.getConfiguration('agentBridge');
  const sessions = new SessionManager({ graceMs: () => Math.max(0, config().get<number>('sessionGraceSeconds', 20)) * 1000 });
  const tools = new ToolRegistry();
  const tabLeases = new LeaseManager();
  const instance = new InstanceRegistration(context, log);
  // Leases end with their session, and when they have not been used for a while.
  const idleSweep = setInterval(() => tabLeases.releaseIdle(), 10_000);
  context.subscriptions.push(
    sessions,
    tabLeases,
    instance,
    sessions.onDidChange(change => {
      if (change.type === 'removed') tabLeases.releaseAllOf(change.session.id);
    }),
    { dispose: () => clearInterval(idleSweep) },
  );

  // `browser` and `terminals` are assigned by their modules below, before anything can call them.
  const prompts = new VscodePrompts(log);
  const services: BridgeServices = {
    context,
    log,
    window: describeWindow(),
    sessions,
    tools,
    prompts,
    tabLeases,
    browser: undefined!,
    terminals: undefined!,
  };

  // Order matters: the UI and registration modules read the browser and terminal services.
  activateSessionTools(services);
  activateDebugTools(services, prompts);
  activateBrowser(services);
  activateTerminals(services);
  activateUi(services);
  activateRegistration(services);

  const server = new BridgeServer({
    socketPath: instance.info.socketPath,
    token: instance.info.token,
    extensionVersion: instance.info.extensionVersion,
    window: services.window,
    sessions,
    tools,
    log,
    instructions: () => buildInstructions(services),
  });
  context.subscriptions.push(server);
  try {
    await server.listen();
    instance.publish();
    log.info(`listening on ${instance.info.socketPath} (window ${instance.info.id}, browser API ${services.browser.available ? 'available' : 'not enabled'})`);
  } catch (err) {
    log.error('could not start the bridge server', err);
    void vscode.window.showErrorMessage(`Agent Bridge could not start: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function deactivate(): void {}
