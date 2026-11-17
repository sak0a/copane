// How far setup is, as the getting-started walkthrough and the Sessions view see it. Decided from
// plain data so every state is unit-tested; walkthrough.ts publishes the result as context keys.
//
//   copane.setup.browser        'ready' | 'off' | 'restart' | 'remote' | 'unsupported'
//   copane.setup.browserReady   true when the browser tools work in this window
//   copane.setup.agents         'ready' | 'off' | 'none'
//   copane.setup.agentsReady    true when at least one agent has Copane's MCP server registered
//   copane.setup.sessionSeen    true once an agent session has connected to Copane in this VS Code
//   copane.setup.done           browser (or unsupported) and agents both settled
import type { ArgvState } from './argv';
import type { EntryState } from './claudeCode';

/** The walkthrough as VS Code addresses it: `<extension id>#<walkthrough id>`. */
export const WALKTHROUGH_ID = 'copane.gettingStarted';

export type BrowserSetup =
  /** The browser API is available: browser tools work. */
  | 'ready'
  /** Local window, not enabled in argv.json yet: "Enable Integrated Browser" fixes it. */
  | 'off'
  /** Enabled in argv.json, but this VS Code was started before: a full restart is what is missing. */
  | 'restart'
  /** Remote window (WSL, SSH, container): argv.json belongs to the local VS Code; partly manual. */
  | 'remote'
  /** This editor has no integrated browser an extension can drive: nothing to enable, terminals only. */
  | 'unsupported';

export interface BrowserInput {
  available: boolean;
  /** `vscode.env.remoteName` is set. */
  remote: boolean;
  /** What argv.json says, when this extension host can read it (local windows). */
  argv: ArgvState | undefined;
  /** The editor has VS Code's integrated browser at all (its commands exist). */
  integratedBrowser: boolean;
}

export function browserSetup(input: BrowserInput): BrowserSetup {
  if (input.available) return 'ready';
  if (!input.integratedBrowser) return 'unsupported';
  if (input.remote) return 'remote';
  return input.argv?.kind === 'enabled' ? 'restart' : 'off';
}

export type AgentsSetup =
  /** At least one agent has Copane's server registered. */
  | 'ready'
  /** An agent is installed, but none has Copane's server: "Turn On" fixes it. */
  | 'off'
  /** None of Claude Code, Codex and GitHub Copilot was found (or they are turned off in settings). */
  | 'none';

export interface AgentInput {
  /** `copane.registration.<agent>` is on. */
  enabled: boolean;
  detected: boolean;
  state: EntryState;
}

export function agentsSetup(agents: AgentInput[]): AgentsSetup {
  const considered = agents.filter(a => a.enabled);
  if (considered.some(a => a.state.kind === 'ours')) return 'ready';
  return considered.some(a => a.detected) ? 'off' : 'none';
}

export interface SetupContext {
  'copane.setup.browser': BrowserSetup;
  'copane.setup.browserReady': boolean;
  'copane.setup.agents': AgentsSetup;
  'copane.setup.agentsReady': boolean;
  'copane.setup.sessionSeen': boolean;
  'copane.setup.done': boolean;
}

export function setupContext(browser: BrowserSetup, agents: AgentsSetup, sessionSeen: boolean): SetupContext {
  return {
    'copane.setup.browser': browser,
    'copane.setup.browserReady': browser === 'ready',
    'copane.setup.agents': agents,
    'copane.setup.agentsReady': agents === 'ready',
    'copane.setup.sessionSeen': sessionSeen,
    // An editor without the browser is as set up as it can be.
    'copane.setup.done': (browser === 'ready' || browser === 'unsupported') && agents === 'ready',
  };
}

/**
 * Whether to open the walkthrough on its own: once per VS Code installation (the caller remembers),
 * and only while something is left to do. Someone who is already set up (an update from a version
 * without the walkthrough, a second machine with synced settings) never sees it unasked.
 */
export function shouldOpenWalkthrough(input: { alreadyOpened: boolean; context: SetupContext; development: boolean }): boolean {
  if (input.alreadyOpened || input.development) return false;
  return !input.context['copane.setup.done'];
}

/**
 * Which walkthrough steps are done according to the setup state (step ids of contributes/walkthrough.json).
 * The steps also complete on their context keys, but VS Code ignores a context key that is already
 * true when it registers the walkthrough, and never un-checks a step; so walkthrough.ts sets them.
 */
export function stepStates(context: SetupContext): Record<string, boolean> {
  const browser = context['copane.setup.browserReady'] || context['copane.setup.browser'] === 'unsupported';
  return {
    browser,
    browserRestart: browser,
    browserRemote: browser,
    browserUnsupported: browser,
    agents: context['copane.setup.agentsReady'],
    agentsNone: context['copane.setup.agentsReady'],
    tryIt: context['copane.setup.sessionSeen'],
  };
}

/** The prompt the walkthrough offers to copy: one browser tab and one terminal command, and a title. */
export const TRY_IT_PROMPT =
  'Use the copane tools: set your session title to "Copane tour", open https://example.com in a VS Code browser tab and tell me the page heading, then run node --version in a VS Code terminal and tell me what it printed.';

/** Why the browser tools are missing in an editor without the integrated browser, for people and agents. */
export function unsupportedBrowserText(appName: string, version: string): string {
  return `${appName} ${version} has no integrated browser that extensions can drive (VS Code's proposed "browser" API), so agents get Copane's terminal tools here but no browser tabs. The browser tools need an editor that includes VS Code's integrated browser, such as Visual Studio Code 1.140 or newer.`;
}
