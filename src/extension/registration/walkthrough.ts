// The getting-started walkthrough (contributes/walkthrough.json) and the setup state it shows.
// The walkthrough's steps complete on context keys (setup.ts) that this file keeps current: at
// activation, after every registration change, when an agent session connects, and when the window
// gets focus (another window or a terminal may have changed agent configuration meanwhile).
//
// Commands: copane.openWalkthrough (Command Palette, Sessions view), copane.walkthrough.copyPrompt
// (the "try it" step), copane.registration.setupState (internal: the state as data, for tests).
import * as vscode from 'vscode';
import type { BridgeServices } from '../core/services';
import type { Logger } from '../core/log';
import {
  agentsSetup,
  browserSetup,
  setupContext,
  shouldOpenWalkthrough,
  stepStates,
  TRY_IT_PROMPT,
  WALKTHROUGH_ID,
  type AgentInput,
  type BrowserSetup,
  type SetupContext,
} from './setup';
import type { ArgvState } from './argv';

const OPENED_KEY = 'copane.walkthrough.opened';
const SESSION_SEEN_KEY = 'copane.walkthrough.sessionSeen';

export interface SetupSources {
  agents(): AgentInput[];
  /** argv.json's state when this extension host can read it (a local window), else undefined. */
  argv(): ArgvState | undefined;
}

export class SetupTracker implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  /** Until the command list has been read, assume the editor has the integrated browser. */
  private integratedBrowser = true;
  /** Testing only: behave as in an editor without the integrated browser. */
  private simulateNoBrowser = false;
  /** Testing only: the test's own MCP connections do not count as "an agent session connected". */
  private ignoreSessions = false;
  private current: SetupContext | undefined;
  private refreshing: Promise<SetupContext> | undefined;
  /** Step states last given to VS Code; a step is set again only when its state changes. */
  private readonly steps = new Map<string, boolean>();
  private stepRetry: ReturnType<typeof setTimeout> | undefined;
  private stepRetries = 0;

  constructor(
    private readonly services: BridgeServices,
    private readonly sources: SetupSources,
    private readonly log: Logger,
  ) {
    const { context, sessions } = services;
    this.disposables.push(
      vscode.commands.registerCommand('copane.openWalkthrough', (step?: unknown) => this.open(typeof step === 'string' ? step : undefined)),
      vscode.commands.registerCommand('copane.walkthrough.copyPrompt', async (options?: { toClipboard?: boolean }) => {
        // `toClipboard: false` is for tests: a dev host shares the clipboard of the person using the machine.
        if (options?.toClipboard !== false) await vscode.env.clipboard.writeText(TRY_IT_PROMPT);
        vscode.window.setStatusBarMessage('$(check) Copane: prompt copied. Paste it into a new Claude Code or Codex session.', 6000);
        return TRY_IT_PROMPT;
      }),
      vscode.commands.registerCommand('copane.registration.setupState', async (options?: { simulateNoIntegratedBrowser?: boolean; ignoreSessions?: boolean }) => {
        if (context.extensionMode !== vscode.ExtensionMode.Production) {
          if (options?.simulateNoIntegratedBrowser !== undefined) this.simulateNoBrowser = options.simulateNoIntegratedBrowser;
          if (options?.ignoreSessions !== undefined) {
            this.ignoreSessions = options.ignoreSessions;
            if (this.ignoreSessions) {
              // The test's own connection may have just been recorded: let that finish, then forget it.
              await new Promise(resolve => setTimeout(resolve, 300));
              await context.globalState.update(SESSION_SEEN_KEY, undefined);
            }
          }
        }
        return this.refresh();
      }),
      sessions.onDidChange(change => {
        if (change.type !== 'added' || this.ignoreSessions || context.globalState.get<boolean>(SESSION_SEEN_KEY)) return;
        void context.globalState.update(SESSION_SEEN_KEY, true).then(() => this.refresh());
      }),
      vscode.window.onDidChangeWindowState(state => {
        if (state.focused) void this.refresh();
      }),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('copane.registration')) void this.refresh();
      }),
    );
  }

  /** The editor has VS Code's integrated browser when its commands exist (forks may leave it out). */
  async detectIntegratedBrowser(): Promise<boolean> {
    try {
      const commands = await vscode.commands.getCommands(true);
      this.integratedBrowser = commands.some(c => c.startsWith('workbench.action.browser.'));
    } catch {
      this.integratedBrowser = true;
    }
    return this.integratedBrowser;
  }

  /** Whether this editor can have browser tools at all; false means there is nothing to enable. */
  get browserSupported(): boolean {
    return this.integratedBrowser && !this.simulateNoBrowser;
  }

  browserState(): BrowserSetup {
    return browserSetup({
      available: this.services.browser.available && !this.simulateNoBrowser,
      remote: !!vscode.env.remoteName,
      argv: this.sources.argv(),
      integratedBrowser: this.browserSupported,
    });
  }

  /** Recomputes the setup state and publishes it as context keys. Calls in flight are shared. */
  refresh(): Promise<SetupContext> {
    this.refreshing ??= this.compute().finally(() => (this.refreshing = undefined));
    return this.refreshing;
  }

  private async compute(): Promise<SetupContext> {
    let agents: AgentInput[] = [];
    try {
      agents = this.sources.agents();
    } catch (err) {
      this.log.warn(`setup state: could not inspect the agents: ${err instanceof Error ? err.message : String(err)}`);
    }
    const next = setupContext(this.browserState(), agentsSetup(agents), this.services.context.globalState.get<boolean>(SESSION_SEEN_KEY, false));
    const previous = this.current;
    this.current = next;
    for (const [key, value] of Object.entries(next) as Array<[keyof SetupContext, unknown]>) {
      if (previous?.[key] !== value) await vscode.commands.executeCommand('setContext', key, value);
    }
    void this.syncSteps(next);
    if (JSON.stringify(previous) !== JSON.stringify(next)) this.log.info(`setup: browser ${next['copane.setup.browser']}, agents ${next['copane.setup.agents']}${next['copane.setup.sessionSeen'] ? ', a session has connected' : ''}`);
    return next;
  }

  /**
   * Checks and un-checks the walkthrough's steps to match the setup state, with VS Code's own
   * commands. Until the walkthrough is registered (shortly after startup) VS Code does not know the
   * steps: then this tries again a little later.
   */
  private async syncSteps(context: SetupContext): Promise<void> {
    const prefix = `${this.services.context.extension.id}#${WALKTHROUGH_ID}#`;
    let missing = false;
    for (const [step, done] of Object.entries(stepStates(context))) {
      if (this.steps.get(step) === done) continue;
      try {
        await vscode.commands.executeCommand(done ? 'welcome.markStepComplete' : 'welcome.markStepIncomplete', prefix + step);
        this.steps.set(step, done);
      } catch {
        missing = true; // Not registered yet, or an editor without these commands.
      }
    }
    clearTimeout(this.stepRetry);
    if (missing && this.stepRetries++ < 10) this.stepRetry = setTimeout(() => this.current && void this.syncSteps(this.current), 3000);
  }

  async open(step?: string): Promise<void> {
    const id = `${this.services.context.extension.id}#${WALKTHROUGH_ID}`;
    await vscode.commands.executeCommand('workbench.action.openWalkthrough', step ? { category: id, step } : id, false);
  }

  /**
   * Opens the walkthrough once per VS Code installation, at the first start with Copane, unless
   * everything is already set up. Returns whether it opened, so the startup check can leave its own
   * setup notifications for a later start instead of showing them on top.
   */
  async openOnFirstRun(): Promise<boolean> {
    const memento = this.services.context.globalState;
    const context = await this.refresh();
    const open = shouldOpenWalkthrough({
      alreadyOpened: memento.get<boolean>(OPENED_KEY, false),
      context,
      development: this.services.context.extensionMode !== vscode.ExtensionMode.Production,
    });
    if (!memento.get<boolean>(OPENED_KEY, false)) await memento.update(OPENED_KEY, true);
    if (!open) return false;
    try {
      await this.open();
      return true;
    } catch (err) {
      this.log.warn(`could not open the walkthrough: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  dispose(): void {
    clearTimeout(this.stepRetry);
    for (const d of this.disposables) d.dispose();
  }
}
