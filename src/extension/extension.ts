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
import { SessionManager, type RememberedSession } from './core/sessions';
import { ToolRegistry } from './core/tools';
import { activateRegistration } from './registration';
import { activateRemote } from './remote';
import { activateSessionTools } from './core/sessionTools';
import { activateTerminals } from './terminal';
import { activateUi } from './ui';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const channel = vscode.window.createOutputChannel('Copane', { log: true });
  const log: Logger = {
    debug: (m, ...a) => channel.debug(m, ...a),
    info: (m, ...a) => channel.info(m, ...a),
    warn: (m, ...a) => channel.warn(m, ...a),
    error: (m, ...a) => channel.error(m, ...a),
  };
  context.subscriptions.push(channel, vscode.commands.registerCommand('copane.showLog', () => channel.show()));

  const config = () => vscode.workspace.getConfiguration('copane');
  // Sessions are remembered in the window's workspace state, so after a reload each one gets its label
  // and color back (its terminals survive the reload and are named after it).
  const sessions = new SessionManager({
    graceMs: () => Math.max(0, config().get<number>('sessionGraceSeconds', 20)) * 1000,
    memory: {
      load: () => context.workspaceState.get<RememberedSession[]>('copane.sessions.v1', []),
      save: list => void context.workspaceState.update('copane.sessions.v1', list),
    },
  });
  const tools = new ToolRegistry();
  // Idle timeout of tab control: the browser module's setting (contributes/browser.json).
  const tabLeases = new LeaseManager({ idleMs: () => Math.max(5, config().get<number>('browser.leaseIdleSeconds', 120)) * 1000 });
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
  context.subscriptions.push(prompts.register());
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
  activateRemote(services);
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
    void vscode.window.showErrorMessage(`Copane could not start: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function deactivate(): void {}
