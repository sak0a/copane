// Getting from "extension installed" to "the agent has the tools", and keeping it that way:
// installs the MCP server launcher, registers it with Claude Code and Codex (after asking once),
// enables the integrated browser API, checks and repairs all of it, and reports its state in one place.
//
// Commands: agentBridge.registerAgents (Turn On), agentBridge.unregisterAgents (Turn Off),
// agentBridge.repair (Check and Repair Setup), agentBridge.enableBrowser, agentBridge.showStatus,
// agentBridge.copyStatus (the UI module links to some of these ids), and
// agentBridge.registration.runStartupCheck (internal: the startup check, which development hosts do
// not run on their own).
//
// Every change to an agent's configuration goes through `applyChange`, which logs it with its reason
// in the output channel and appends it to `<bridge home>/registration-history.json`. Changes are
// serialised across windows and VS Code builds with a lock in the bridge home. Nothing is ever
// removed except by Turn Off.
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { bridgeHome, instanceFile, readLiveInstances, socketPathFor } from '../../shared/paths';
import { Env } from '../../shared/protocol';
import { scopedLogger, type Logger } from '../core/log';
import type { BridgeServices } from '../core/services';
import { applyTextEdits, argvJsonPath, argvState, enableProposedApiEdits, newArgvJson, type ArgvState } from './argv';
import {
  claudeConfigFile,
  inspectClaude,
  locateClaudeCli,
  registerClaude,
  unregisterClaude,
  type ChangeOutcome,
  type EntryState,
  type RegisteredCommand,
} from './claudeCode';
import { codexConfigFile, inspectCodexText, registerCodex, unregisterCodex } from './codex';
import { readTextIfExists, tildify, withFileLock, writeFileAtomic } from './files';
import { appendHistory, readHistory, recentReAdds, type Trigger } from './history';
import { installServer, readInstalledManifest, scriptPath, serverSpec, type ServerSpec } from './launcher';
import { DEFAULT_TITLES, planAgent, type CommandTitles, type Mode, type Plan } from './plan';
import { diagnose, handshake, type HandshakeResult } from './probe';
import { renderStatus, type AgentStatus, type CheckResult, type StatusData } from './status';

type AgentId = 'claude-code' | 'codex';

/** Machine-wide setup decisions, shared by all windows and VS Code builds using this bridge home. */
interface SetupState {
  /** The user's answer to "register with agents?". */
  consent?: 'granted' | 'declined';
  /** Agents the consent covered; an agent installed later is asked about separately. */
  agents?: AgentId[];
  decidedAt?: string;
  /** "Not now": do not ask again before this time. */
  snoozedUntil?: number;
  /** Turn Off switched registration mode from "automatic" to "manual"; Turn On switches it back. */
  modeChangedByTurnOff?: boolean;
  /** The last start test run by the startup check, so it runs again only when something changed. */
  lastProbe?: { key: string; ok: boolean; at: number };
}

interface Agent {
  id: AgentId;
  name: string;
  setting: 'claudeCode' | 'codex';
  configFile: string;
  /** Why changes are refused (a development host without throwaway config). */
  blocked: string | undefined;
  detect(): { detected: boolean; by?: string };
  inspect(): { state: EntryState; notes: string[]; problems: string[] };
  register(replaceForeign: boolean): Promise<ChangeOutcome>;
  unregister(): Promise<ChangeOutcome>;
}

export interface AgentResult {
  agent: string;
  outcome: ChangeOutcome | { kind: 'skipped'; detail: string };
}

/** One finding of "Check and Repair": fine, fixed, or a problem it could not fix. */
export interface CheckLine {
  kind: 'ok' | 'fixed' | 'problem';
  text: string;
}

export interface RepairReport {
  at: string;
  ok: boolean;
  lines: CheckLine[];
}

const STATUS_SCHEME = 'agent-bridge-status';
const BROWSER_NOTICE_KEY = 'agentBridge.browserNoticeShown';
const WARNED_KEY = 'agentBridge.registration.warned';
const SNOOZE_MS = 7 * 24 * 3600_000;
const PROBE_EVERY_MS = 24 * 3600_000;

export function activateRegistration(services: BridgeServices): void {
  const registration = new Registration(services);
  const { context } = services;
  const statusProvider = new StatusDocuments();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(STATUS_SCHEME, statusProvider),
    statusProvider,
    vscode.commands.registerCommand('agentBridge.registerAgents', () => registration.registerAgents()),
    vscode.commands.registerCommand('agentBridge.unregisterAgents', () => registration.unregisterAgents()),
    vscode.commands.registerCommand('agentBridge.repair', (options?: { quiet?: boolean }) => registration.repair(options)),
    // The options are for tests: edit argv.json even though the API is already on (dev hosts start
    // with it enabled), and go through an editor as in a remote window.
    vscode.commands.registerCommand('agentBridge.enableBrowser', (options?: { evenIfAvailable?: boolean; viaEditor?: boolean }) =>
      registration.enableBrowser(options),
    ),
    vscode.commands.registerCommand('agentBridge.showStatus', async (options?: { show?: boolean }) => {
      const text = await registration.statusReport();
      if (options?.show !== false) await statusProvider.show(text);
      return text;
    }),
    // `toClipboard: false` is for tests: a dev host shares the clipboard of the person using the machine.
    vscode.commands.registerCommand('agentBridge.copyStatus', async (options?: { quiet?: boolean; toClipboard?: boolean }) => {
      // From the status document's title bar: copy what is shown; from the palette: a fresh report.
      const text = statusProvider.isActive() ? statusProvider.current : await registration.statusReport();
      if (options?.toClipboard === false) return text;
      await vscode.env.clipboard.writeText(text);
      if (!options?.quiet) void services.prompts.ask({ message: `${registration.titles.product}: the status report is on the clipboard (${text.split('\n').length} lines).`, choices: [] });
      return text;
    }),
    vscode.commands.registerCommand('agentBridge.registration.runStartupCheck', () => registration.startup({ probe: 'wait' })),
  );

  registration.installServerSafely();
  // A development host must not ask on its own: tests queue answers for the prompts they expect, and
  // an unexpected one would take them. Tests run the check with the internal command instead.
  if (context.extensionMode !== vscode.ExtensionMode.Production) return;
  setTimeout(() => void registration.startup().catch(err => registration.log.error('startup check failed', err)), 1500);
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('agentBridge.registration')) void registration.startup({ browserNotice: false, trigger: 'settings' });
    }),
  );
}

class Registration {
  readonly log: Logger;
  private readonly env = process.env;
  private readonly home = os.homedir();
  private readonly isDev: boolean;
  private readonly binDir: string;
  private readonly stateFile: string;
  private readonly historyFile: string;
  private readonly lastCheckFile: string;
  private spec: ServerSpec;
  private installError: string | undefined;

  constructor(private readonly services: BridgeServices) {
    this.log = scopedLogger(services.log, 'registration');
    this.isDev = services.context.extensionMode !== vscode.ExtensionMode.Production;
    this.binDir = path.join(bridgeHome(), 'bin');
    this.stateFile = path.join(bridgeHome(), 'setup.json');
    this.historyFile = path.join(bridgeHome(), 'registration-history.json');
    this.lastCheckFile = path.join(bridgeHome(), 'last-check.json');
    this.spec = this.currentSpec();
  }

  private get extensionId(): string {
    return this.services.context.extension.id;
  }

  private get version(): string {
    return String(this.services.context.extension.packageJSON.version);
  }

  /** Command names as the Command Palette shows them, read from the manifest so a rename follows. */
  get titles(): CommandTitles {
    const commands: Array<{ command: string; title: string; category?: string }> = this.services.context.extension.packageJSON.contributes?.commands ?? [];
    const title = (id: string, fallback: string) => {
      const c = commands.find(x => x.command === id);
      return c ? `${c.category ? `${c.category}: ` : ''}${c.title}` : fallback;
    };
    return {
      product: commands.find(c => c.command === 'agentBridge.repair')?.category ?? DEFAULT_TITLES.product,
      turnOn: title('agentBridge.registerAgents', DEFAULT_TITLES.turnOn),
      turnOff: title('agentBridge.unregisterAgents', DEFAULT_TITLES.turnOff),
      repair: title('agentBridge.repair', DEFAULT_TITLES.repair),
      status: title('agentBridge.showStatus', DEFAULT_TITLES.status),
      copy: title('agentBridge.copyStatus', DEFAULT_TITLES.copy),
      log: title('agentBridge.showLog', DEFAULT_TITLES.log),
    };
  }

  private currentSpec(): ServerSpec {
    return serverSpec({
      binDir: this.binDir,
      runtime: process.execPath,
      platform: process.platform,
      bridgeHomeOverride: this.env[Env.home] || undefined,
      knownRuntimes: readInstalledManifest(this.binDir)?.runtimes ?? [],
    });
  }

  private mode(): Mode {
    const value = vscode.workspace.getConfiguration('agentBridge.registration').get<string>('mode', 'ask');
    return value === 'automatic' || value === 'manual' ? value : 'ask';
  }

  /** Who made a change, for the history: several VS Code builds and windows share one bridge home. */
  private get by(): string {
    return `${vscode.env.appName} ${vscode.version}, window ${this.services.window.instanceId}`;
  }

  // ------------------------------------------------------------------ server

  installServerSafely(): void {
    try {
      const result = installServer({
        binDir: this.binDir,
        sourceScript: this.services.context.asAbsolutePath(path.join('dist', 'mcp-server.js')),
        version: this.version,
        runtime: process.execPath,
        platform: process.platform,
        bridgeHomeOverride: this.env[Env.home] || undefined,
      });
      this.installError = undefined;
      if (result.scriptUpdated || result.launcherUpdated) this.log.info(`MCP server ${result.version} installed in ${this.binDir} (runtime ${process.execPath})`);
    } catch (err) {
      this.installError = err instanceof Error ? err.message : String(err);
      this.log.error(`could not install the MCP server in ${this.binDir}`, err);
    }
    this.spec = this.currentSpec();
  }

  // ------------------------------------------------------------------ agents

  /**
   * In a development host every config path must point into the host's throwaway folder
   * (scripts/dev-host.mjs sets CLAUDE_CONFIG_DIR, CODEX_HOME and AGENT_BRIDGE_ARGV_JSON there), so a
   * dev host can never change the real configuration of the machine it runs on.
   */
  private guard(file: string, variable: string): string | undefined {
    if (!this.isDev) return undefined;
    const sandbox = this.env[Env.home] ? path.dirname(this.env[Env.home]!) : undefined;
    if (sandbox && isInsideDir(file, sandbox)) return undefined;
    return `this is an extension development host and ${file} is not in its throwaway folder; set ${variable} (scripts/dev-host.mjs does)`;
  }

  private agents(): Agent[] {
    const claude = claudeConfigFile(this.env, this.home);
    const claudeExtension = vscode.extensions.getExtension('anthropic.claude-code');
    const bundled = claudeExtension
      ? [
          path.join(claudeExtension.extensionPath, 'resources', 'native-binaries', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'claude.exe' : 'claude'),
          path.join(claudeExtension.extensionPath, 'resources', 'native-binary', process.platform === 'win32' ? 'claude.exe' : 'claude'),
        ]
      : [];
    const located = () => locateClaudeCli(this.env, this.home, process.platform, bundled);
    const cli = () => located().cli;
    const codexFile = codexConfigFile(this.env, this.home);
    const spec = () => this.spec;
    return [
      {
        id: 'claude-code',
        name: 'Claude Code',
        setting: 'claudeCode',
        configFile: claude.configFile,
        blocked: this.guard(claude.configFile, 'CLAUDE_CONFIG_DIR'),
        detect: () => {
          if (fs.existsSync(claude.configFile)) return { detected: true, by: `config file ${tildify(claude.configFile, this.home)}` };
          const found = cli();
          if (found) return { detected: true, by: `claude at ${found}` };
          if (claudeExtension) return { detected: true, by: 'Claude Code extension' };
          return { detected: false };
        },
        inspect: () => {
          const result = inspectClaude(claude.configFile, spec());
          const problems = [
            ...result.overriddenIn.filter(o => !o.ours).map(o => `The project ${o.project} has its own "vscode" MCP server (local scope), which Claude Code uses there instead of Agent Bridge's.`),
            ...result.disabledIn.map(p => `Claude Code has the "vscode" server turned off in the project ${p}: in a Claude Code session there, run /mcp and enable it.`),
          ];
          const notes: string[] = [];
          const { cli: found, shims } = located();
          notes.push(found ? `Adds and removes with ${found} (claude mcp); updates by editing the file in one step.` : 'No claude executable found; changes are made by editing the file under Claude Code\'s lock.');
          if (!found && shims.length) notes.push(`Found ${shims.join(', ')} (npm install); a .cmd/.ps1 shim cannot be run without a shell, so the file is edited instead.`);
          const backups = claudeBackups(claude.configFile, claude.configDir ?? path.join(this.home, '.claude'));
          if (backups.length) notes.push(`Claude Code found its config damaged and reset it (which drops all MCP servers): ${backups.join('; ')}`);
          return { state: result.state, notes, problems };
        },
        register: replaceForeign => registerClaude({ ...claude, cli: cli() }, spec(), { replaceForeign }),
        unregister: () => unregisterClaude({ ...claude, cli: cli() }, spec()),
      },
      {
        id: 'codex',
        name: 'Codex',
        setting: 'codex',
        configFile: codexFile,
        blocked: this.guard(codexFile, 'CODEX_HOME'),
        detect: () => {
          if (fs.existsSync(path.dirname(codexFile))) return { detected: true, by: `config folder ${tildify(path.dirname(codexFile), this.home)}` };
          const found = findOnPath(this.env, process.platform === 'win32' ? 'codex.exe' : 'codex');
          if (found) return { detected: true, by: `codex at ${found}` };
          if (vscode.extensions.getExtension('openai.chatgpt')) return { detected: true, by: 'Codex extension' };
          return { detected: false };
        },
        inspect: () => {
          try {
            return { state: inspectCodexText(readTextIfExists(codexFile), spec()), notes: [], problems: [] };
          } catch (err) {
            return { state: { kind: 'unreadable', error: err instanceof Error ? err.message : String(err) }, notes: [], problems: [] };
          }
        },
        register: replaceForeign => registerCodex({ configFile: codexFile }, spec(), { replaceForeign }),
        unregister: () => unregisterCodex({ configFile: codexFile }, spec()),
      },
    ];
  }

  private enabledAgents(): Agent[] {
    const config = vscode.workspace.getConfiguration('agentBridge.registration');
    return this.agents().filter(a => config.get<boolean>(a.setting, true));
  }

  private consentFor(agent: Agent, setup = this.readState()): 'granted' | 'declined' | undefined {
    return setup.consent && setup.agents?.includes(agent.id) ? setup.consent : undefined;
  }

  private plan(agent: Agent, trigger: 'startup' | 'repair'): Plan {
    const setup = this.readState();
    return planAgent(
      {
        agent: agent.name,
        state: agent.inspect().state,
        mode: this.mode(),
        consent: this.consentFor(agent, setup),
        ...(setup.decidedAt ? { consentAt: setup.decidedAt } : {}),
        detected: agent.detect().detected,
        ...(agent.blocked ? { blocked: agent.blocked } : {}),
        snoozed: !!setup.snoozedUntil && setup.snoozedUntil > Date.now(),
        recentReAdds: recentReAdds(readHistory(this.historyFile), agent.name, Date.now()),
      },
      trigger,
      this.titles,
    );
  }

  /**
   * The one way an agent's configuration is changed: logs the change and its reason in the output
   * channel and records it in the bridge home's history.
   */
  private async applyChange(agent: Agent, action: 'add' | 'update' | 'replace' | 'remove', reason: string, trigger: Trigger): Promise<AgentResult> {
    const before = agent.inspect().state;
    let outcome: ChangeOutcome;
    try {
      outcome = action === 'remove' ? await agent.unregister() : await agent.register(action === 'replace');
    } catch (err) {
      outcome = { kind: 'failed', detail: err instanceof Error ? err.message : String(err) };
    }
    const line = `${agent.name}: ${action} (${trigger}) → ${outcome.kind}: ${outcome.detail}. Reason: ${reason}`;
    if (outcome.kind === 'failed' || outcome.kind === 'conflict') this.log.warn(line);
    else this.log.info(line);
    if (outcome.kind !== 'unchanged') {
      appendHistory(this.historyFile, {
        at: new Date().toISOString(),
        agent: agent.name,
        action,
        trigger,
        reason,
        outcome: outcome.kind,
        detail: outcome.detail,
        ...(before.kind === 'ours' || before.kind === 'foreign' ? { before: before.command } : {}),
        by: this.by,
      });
    }
    return { agent: agent.name, outcome };
  }

  /** Serialises registration changes across windows and VS Code builds (they share the bridge home). */
  private withRegistrationLock<T>(fn: () => Promise<T>): Promise<T> {
    return withFileLock(path.join(bridgeHome(), 'registration'), fn, { timeoutMs: 60_000 });
  }

  // ------------------------------------------------------------------ startup

  /**
   * Runs at startup, quietly: keeps Agent Bridge's own registrations present and current (re-adds a
   * missing one the user agreed to, updates an outdated one in one step), asks once (mode "ask")
   * before adding one, never touches another server named "vscode", and tests that the registered
   * command starts. Says something only when something is wrong that it could not fix.
   */
  async startup(options: { browserNotice?: boolean; trigger?: Trigger; probe?: 'background' | 'wait' } = {}): Promise<AgentResult[]> {
    const trigger = options.trigger ?? 'startup';
    this.installServerSafely();
    const results: AgentResult[] = [];
    const toAsk: Agent[] = [];
    const problems: string[] = [];
    await this.withRegistrationLock(async () => {
      for (const agent of this.enabledAgents()) {
        const plan = this.plan(agent, 'startup');
        if (plan.action === 'add' || plan.action === 'update') {
          const result = await this.applyChange(agent, plan.action, plan.reason, trigger);
          results.push(result);
          if (result.outcome.kind === 'changed' && !this.consentFor(agent)) this.recordConsent('granted', [agent]);
          if (result.outcome.kind === 'failed') problems.push(`${agent.name}: could not ${plan.action} the registration (${result.outcome.detail})`);
        } else if (plan.action === 'ask') {
          toAsk.push(agent);
        } else if (plan.action === 'report') {
          this.log.warn(`${agent.name}: ${plan.problem}`);
          if (/keeps disappearing/.test(plan.problem)) problems.push(`${agent.name}: ${plan.problem}`);
        } else if (plan.action === 'none') {
          this.log.info(`${agent.name}: ${plan.note}`);
        }
      }
    });
    if (toAsk.length > 0) results.push(...(await this.askToRegister(toAsk)));
    for (const problem of problems) this.warnOnce(problem, `${this.titles.product}: ${problem}.`);

    const probe = this.startupProbe().catch(err => this.log.error('start test failed', err));
    if (options.probe === 'wait') await probe;
    if (options.browserNotice !== false) void this.browserNotice();
    return results;
  }

  /**
   * Starts the registered command once with an MCP handshake, when it changed since the last test or
   * a day has passed. A failure here is what makes an agent show the server as failed or closed.
   */
  private async startupProbe(): Promise<void> {
    const manifest = readInstalledManifest(this.binDir);
    const key = JSON.stringify([this.spec.command, this.spec.args, this.spec.env, manifest?.version]);
    const last = this.readState().lastProbe;
    if (last && last.key === key && last.ok && Date.now() - last.at < PROBE_EVERY_MS) return;
    const result = await this.handshake();
    this.writeState({ ...this.readState(), lastProbe: { key, ok: result.ok, at: Date.now() } });
    if (result.ok) {
      this.log.info(`start test: ${result.text} (${result.ms} ms)`);
      return;
    }
    this.log.error(`start test FAILED: ${result.text}${result.stderr ? `\nstderr:\n${result.stderr}` : ''}`);
    this.warnOnce(
      `probe:${key}`,
      `${this.titles.product}: the MCP server that agents start does not work on this machine: ${result.text}. Agents will show the "vscode" server as failed.`,
    );
  }

  private handshake(): Promise<HandshakeResult> {
    return handshake(this.spec, { baseEnv: this.env, cwd: this.workspaceCwd() });
  }

  private workspaceCwd(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? this.home;
  }

  /** A warning with a way to act on it, shown once per distinct problem per VS Code installation. */
  private warnOnce(key: string, message: string): void {
    const memento = this.services.context.globalState;
    const warned = memento.get<string[]>(WARNED_KEY, []);
    if (warned.includes(key)) return;
    void memento.update(WARNED_KEY, [...warned, key].slice(-20));
    void this.services.prompts.ask({ message, choices: ['Check and Repair', 'Show Status'] }).then(choice => {
      if (choice === 'Check and Repair') void vscode.commands.executeCommand('agentBridge.repair');
      if (choice === 'Show Status') void vscode.commands.executeCommand('agentBridge.showStatus');
    });
  }

  private async askToRegister(agents: Agent[]): Promise<AgentResult[]> {
    // Several windows start at once after a restart: only one of them asks.
    const lock = path.join(bridgeHome(), 'setup-prompt.lock');
    try {
      fs.mkdirSync(path.dirname(lock), { recursive: true });
      fs.mkdirSync(lock);
    } catch {
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs < 10 * 60_000) return [];
        fs.rmSync(lock, { recursive: true, force: true });
        fs.mkdirSync(lock);
      } catch {
        return [];
      }
    }
    try {
      const names = agents.map(a => a.name).join(' and ');
      const files = agents.map(a => tildify(a.configFile, this.home)).join(', ');
      const answer = await this.services.prompts.ask({
        message: `${this.titles.product}: let ${names} use this VS Code's browser tabs and terminals? This adds an MCP server named "vscode" to ${files}.`,
        choices: ['Register', 'Not Now', 'Never'],
      });
      if (answer === 'Register') {
        const results: AgentResult[] = [];
        await this.withRegistrationLock(async () => {
          for (const agent of agents) results.push(await this.applyChange(agent, 'add', 'the user answered "Register" when asked', 'startup'));
        });
        this.recordConsent('granted', agents);
        this.reportResults(results);
        return results;
      }
      if (answer === 'Never') {
        this.recordConsent('declined', agents);
      } else {
        this.writeState({ ...this.readState(), snoozedUntil: Date.now() + SNOOZE_MS });
      }
      return agents.map(a => ({ agent: a.name, outcome: { kind: 'skipped', detail: answer === 'Never' ? 'declined' : 'not now' } }));
    } finally {
      fs.rmSync(lock, { recursive: true, force: true });
    }
  }

  // ------------------------------------------------------------------ commands

  /** Turn On: registers with every enabled agent that is installed, and remembers the user wants it. */
  async registerAgents(): Promise<AgentResult[]> {
    this.installServerSafely();
    const results: AgentResult[] = [];
    const registered: Agent[] = [];
    for (const agent of this.enabledAgents()) {
      if (agent.blocked) {
        results.push({ agent: agent.name, outcome: { kind: 'failed', detail: agent.blocked } });
        continue;
      }
      if (!agent.detect().detected) {
        results.push({ agent: agent.name, outcome: { kind: 'skipped', detail: 'not installed' } });
        continue;
      }
      let result = await this.withRegistrationLock(() => this.applyChange(agent, agent.inspect().state.kind === 'ours' ? 'update' : 'add', `the user ran "${this.titles.turnOn}"`, 'turn-on'));
      if (result.outcome.kind === 'conflict') {
        const { state } = agent.inspect();
        const answer = await this.services.prompts.ask({
          message: `${agent.name} already has an MCP server named "vscode" that ${this.titles.product} did not add${state.kind === 'foreign' ? ` (${state.command})` : ''}. Replace it with ${this.titles.product}'s?`,
          detail: `It is in ${agent.configFile}. Keeping it means ${agent.name} does not get ${this.titles.product}'s tools.`,
          choices: ['Replace', 'Keep It'],
          modal: true,
        });
        if (answer === 'Replace') result = await this.withRegistrationLock(() => this.applyChange(agent, 'replace', 'the user chose to replace the other "vscode" server', 'turn-on'));
      }
      if (result.outcome.kind === 'changed' || result.outcome.kind === 'unchanged') registered.push(agent);
      results.push(result);
    }
    if (registered.length > 0) this.recordConsent('granted', registered);
    const setup = this.readState();
    if (setup.modeChangedByTurnOff && this.mode() === 'manual') {
      await vscode.workspace.getConfiguration('agentBridge.registration').update('mode', 'automatic', vscode.ConfigurationTarget.Global);
      this.writeState({ ...this.readState(), modeChangedByTurnOff: false });
    }
    this.reportResults(results);
    return results;
  }

  /** Turn Off: removes Agent Bridge's entries from every agent and keeps them off until Turn On. */
  async unregisterAgents(): Promise<AgentResult[]> {
    const results: AgentResult[] = [];
    const agents = this.agents(); // All of them, also those turned off in settings.
    await this.withRegistrationLock(async () => {
      for (const agent of agents) {
        if (agent.blocked) {
          results.push({ agent: agent.name, outcome: { kind: 'failed', detail: agent.blocked } });
          continue;
        }
        results.push(await this.applyChange(agent, 'remove', `the user ran "${this.titles.turnOff}"`, 'turn-off'));
      }
    });
    // Do not put it back on the next start.
    this.recordConsent('declined', agents);
    if (this.mode() === 'automatic') {
      await vscode.workspace.getConfiguration('agentBridge.registration').update('mode', 'manual', vscode.ConfigurationTarget.Global);
      this.writeState({ ...this.readState(), modeChangedByTurnOff: true });
    }
    const lines = results.map(r => `${r.agent}: ${r.outcome.kind === 'changed' ? 'removed' : r.outcome.detail}`);
    void this.services.prompts.ask({
      message: `${this.titles.product}: ${lines.join('; ')}. Running agent sessions keep the tools until they restart. "${this.titles.turnOn}" adds them back.`,
      choices: ['Show Status'],
    }).then(choice => choice && vscode.commands.executeCommand('agentBridge.showStatus'));
    return results;
  }

  /**
   * Check and Repair: checks everything an agent needs, end to end, fixes what belongs to Agent Bridge
   * and says in plain words what was wrong and what it did. Respects Turn Off.
   */
  async repair(options: { quiet?: boolean } = {}): Promise<RepairReport> {
    const lines: CheckLine[] = [];
    const ok = (text: string) => lines.push({ kind: 'ok', text });
    const fixed = (text: string) => lines.push({ kind: 'fixed', text });
    const problem = (text: string) => lines.push({ kind: 'problem', text });

    // 1. The server script and how agents start it.
    this.installServerSafely();
    if (this.installError) problem(`The MCP server could not be installed in ${this.binDir}: ${this.installError}`);
    const script = scriptPath(this.binDir);
    if (fs.existsSync(script)) ok(`The MCP server script is in place (${script}).`);
    else problem(`The MCP server script is missing (${script}).`);
    if (fs.existsSync(this.spec.command)) ok(`Agents start it with ${this.spec.command}, which exists.`);
    else problem(`Agents would start it with ${this.spec.command}, which does not exist.`);

    // 2. Each agent's registration.
    const config = vscode.workspace.getConfiguration('agentBridge.registration');
    for (const agent of this.agents()) {
      if (!config.get<boolean>(agent.setting, true)) {
        ok(`${agent.name}: turned off in settings (agentBridge.registration.${agent.setting}); not checked.`);
        continue;
      }
      const plan = this.plan(agent, 'repair');
      if (plan.action === 'none') {
        if (plan.note === 'not installed') ok(`${agent.name}: not installed.`);
        else ok(`${agent.name}: ${plan.note}.`);
      } else if (plan.action === 'add' || plan.action === 'update') {
        const result = await this.withRegistrationLock(() => this.applyChange(agent, plan.action as 'add' | 'update', plan.reason, 'repair'));
        if (result.outcome.kind === 'changed') {
          fixed(`${agent.name}: ${plan.reason}; ${plan.action === 'add' ? 'registered it' : 'updated it'}. Start a new ${agent.name} session to get the tools.`);
          this.recordConsent('granted', [agent]);
        } else if (result.outcome.kind === 'unchanged') ok(`${agent.name}: registered and current.`);
        else problem(`${agent.name}: ${plan.reason}, and fixing it failed: ${result.outcome.detail}`);
      } else if (plan.action === 'ask-replace') {
        const answer = await this.services.prompts.ask({
          message: `${agent.name} has an MCP server named "vscode" that ${this.titles.product} did not add (${plan.command}). Replace it with ${this.titles.product}'s?`,
          detail: `It is in ${agent.configFile}. Keeping it means ${agent.name} does not get ${this.titles.product}'s tools.`,
          choices: ['Replace', 'Keep It'],
          modal: true,
        });
        if (answer === 'Replace') {
          const result = await this.withRegistrationLock(() => this.applyChange(agent, 'replace', 'the user chose to replace the other "vscode" server', 'repair'));
          if (result.outcome.kind === 'changed') fixed(`${agent.name}: replaced the other "vscode" server (${plan.command}) with ${this.titles.product}'s.`);
          else problem(`${agent.name}: replacing the other "vscode" server failed: ${result.outcome.detail}`);
        } else {
          problem(`${agent.name}: another MCP server named "vscode" is configured (${plan.command}); kept it, so ${agent.name} does not get ${this.titles.product}'s tools.`);
        }
      } else if (plan.action === 'report') {
        problem(`${agent.name}: ${plan.problem}.`);
      }
      for (const p of agent.inspect().problems) problem(`${agent.name}: ${p}`);
    }

    // 3. The registered command really starts and speaks MCP, and finds and reaches this window.
    const started = await this.handshake();
    if (started.ok) ok(`Start test: the server ${started.text} (${started.ms} ms).`);
    else problem(`Start test: ${started.text}.${started.stderr ? ` It printed: ${started.stderr.split(/\r?\n/).slice(-3).join(' / ')}` : ''}`);
    const found = await diagnose(this.spec, { baseEnv: this.env, cwd: this.workspaceCwd(), windowId: this.services.window.instanceId });
    if (found.ok) ok(`Window test: ${found.text}`);
    else problem(`Window test: ${found.text}`);

    // 4. This window is published and listening.
    const id = this.services.window.instanceId;
    const listening = await canConnect(socketPathFor(id));
    const published = fs.existsSync(instanceFile(id));
    if (listening && published) ok('This window is published and listening for agents.');
    else problem(`This window is ${published ? '' : 'not published (instance file missing) and '}${listening ? 'listening' : 'not listening'}; reload the window ("Developer: Reload Window").`);

    const report: RepairReport = { at: new Date().toISOString(), ok: !lines.some(l => l.kind === 'problem'), lines };
    try {
      writeFileAtomic(this.lastCheckFile, JSON.stringify(report, null, 2) + '\n', 0o600);
    } catch {
      // Only for the status report.
    }
    for (const l of lines) (l.kind === 'problem' ? this.log.warn : this.log.info).call(this.log, `check: ${l.kind}: ${l.text}`);
    if (!options.quiet) {
      const fixes = lines.filter(l => l.kind === 'fixed');
      const problems = lines.filter(l => l.kind === 'problem');
      const summary = problems.length
        ? `found ${problems.length} problem${problems.length > 1 ? 's' : ''} it could not fix: ${problems.map(p => p.text).join(' ')}`
        : fixes.length
          ? `fixed ${fixes.length} thing${fixes.length > 1 ? 's' : ''}: ${fixes.map(f => f.text).join(' ')} Everything else is fine.`
          : 'everything is fine: registrations are current, the server starts and answers, and this window is reachable.';
      void this.services.prompts.ask({ message: `${this.titles.product}: ${summary}`, choices: ['Show Status', 'Copy Report'] }).then(async choice => {
        if (choice === 'Show Status') await vscode.commands.executeCommand('agentBridge.showStatus');
        if (choice === 'Copy Report') await vscode.commands.executeCommand('agentBridge.copyStatus');
      });
    }
    return report;
  }

  private reportResults(results: AgentResult[]): void {
    const parts = results.map(r => {
      const o = r.outcome;
      if (o.kind === 'changed') return `${r.agent}: ${o.detail}`;
      if (o.kind === 'unchanged') return `${r.agent}: already registered`;
      if (o.kind === 'skipped') return `${r.agent}: ${o.detail}`;
      if (o.kind === 'conflict') return `${r.agent}: not registered, ${o.detail}`;
      return `${r.agent}: failed, ${o.detail}`;
    });
    const anyRegistered = results.some(r => r.outcome.kind === 'changed' || r.outcome.kind === 'unchanged');
    const none = results.every(r => r.outcome.kind === 'skipped');
    const message = none
      ? `${this.titles.product}: neither Claude Code nor Codex was found. Install one, then run "${this.titles.turnOn}".`
      : `${this.titles.product}: ${parts.join('; ')}.${anyRegistered ? ' New agent sessions get the tools; restart sessions that are already running.' : ''}`;
    void this.services.prompts.ask({ message, choices: ['Show Status'] }).then(choice => choice && vscode.commands.executeCommand('agentBridge.showStatus'));
  }

  // ------------------------------------------------------------------ browser

  private argvTarget(): { file: string | undefined; blocked: string | undefined; viaEditor: boolean } {
    const override = this.env.AGENT_BRIDGE_ARGV_JSON;
    if (override) return { file: override, blocked: this.guard(override, 'AGENT_BRIDGE_ARGV_JSON'), viaEditor: this.env.AGENT_BRIDGE_ARGV_VIA_EDITOR === '1' };
    if (this.isDev) return { file: undefined, blocked: 'this is an extension development host without AGENT_BRIDGE_ARGV_JSON (scripts/dev-host.mjs sets it)', viaEditor: false };
    // In a remote window this code runs on the remote side; argv.json is on the machine running the UI.
    if (vscode.env.remoteName) return { file: undefined, blocked: undefined, viaEditor: true };
    return { file: argvJsonPath({ appRoot: vscode.env.appRoot, home: this.home, env: this.env }), blocked: undefined, viaEditor: false };
  }

  async enableBrowser(options: { evenIfAvailable?: boolean; viaEditor?: boolean } = {}): Promise<{ state: string; file?: string; changed?: boolean; error?: string }> {
    if (this.services.browser.available && !options.evenIfAvailable) {
      void this.services.prompts.ask({ message: 'Agent Bridge: the integrated browser is already enabled.', choices: [] });
      return { state: 'available' };
    }
    const target = this.argvTarget();
    if (target.blocked) {
      void this.services.prompts.ask({ message: `Agent Bridge: not changing argv.json: ${target.blocked}.`, choices: [] });
      return { state: 'blocked', error: target.blocked };
    }
    try {
      const result = target.viaEditor || options.viaEditor ? await this.enableViaEditor(target.file) : this.enableInFile(target.file!);
      void this.offerRestart(result.changed, result.file);
      return { state: 'enabled', ...result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error('could not enable the integrated browser', err);
      void this.manualBrowserInstructions(message);
      return { state: 'failed', error: message, ...(target.file ? { file: target.file } : {}) };
    }
  }

  private enableInFile(file: string): { file: string; changed: boolean } {
    const text = readTextIfExists(file);
    if (text === undefined) {
      writeFileAtomic(file, newArgvJson(this.extensionId), 0o644);
      this.log.info(`created ${file} with enable-proposed-api`);
      return { file, changed: true };
    }
    const edits = enableProposedApiEdits(text, this.extensionId);
    if (edits.length === 0) return { file, changed: false };
    writeFileAtomic(file, applyTextEdits(text, edits), 0o644);
    this.log.info(`added ${this.extensionId} to enable-proposed-api in ${file}`);
    return { file, changed: true };
  }

  /**
   * Edits argv.json through an editor: in a remote window, "Preferences: Configure Runtime Arguments"
   * opens the file of the local VS Code, which this (remote) extension host cannot reach on disk.
   */
  private async enableViaEditor(testFile: string | undefined): Promise<{ file: string; changed: boolean }> {
    let document: vscode.TextDocument | undefined;
    if (testFile) {
      document = await vscode.workspace.openTextDocument(vscode.Uri.file(testFile));
      await vscode.window.showTextDocument(document, { preview: false });
    } else {
      await vscode.commands.executeCommand('workbench.action.configureRuntimeArguments');
      for (let i = 0; i < 40 && !document; i++) {
        document = [vscode.window.activeTextEditor?.document, ...vscode.workspace.textDocuments].find(d => d && path.basename(d.uri.path) === 'argv.json');
        if (!document) await new Promise(r => setTimeout(r, 100));
      }
    }
    if (!document) throw new Error('the argv.json editor did not open where this extension can see it');
    const text = document.getText();
    const edits = enableProposedApiEdits(text, this.extensionId);
    if (edits.length === 0) return { file: document.uri.toString(true), changed: false };
    const edit = new vscode.WorkspaceEdit();
    for (const e of edits) edit.replace(document.uri, new vscode.Range(document.positionAt(e.offset), document.positionAt(e.offset + e.length)), e.content);
    if (!(await vscode.workspace.applyEdit(edit))) throw new Error('VS Code refused the edit to argv.json');
    if (!(await document.save())) throw new Error('argv.json could not be saved');
    this.log.info(`added ${this.extensionId} to enable-proposed-api in ${document.uri.toString(true)}`);
    return { file: document.uri.toString(true), changed: true };
  }

  private async offerRestart(changed: boolean, file: string): Promise<void> {
    const answer = await this.services.prompts.ask({
      message: `Agent Bridge: the integrated browser is ${changed ? 'now enabled' : 'already enabled'} in argv.json. VS Code reads it only at startup: quit VS Code completely and start it again (reloading the window is not enough).`,
      choices: ['Quit VS Code', 'Show argv.json', 'Later'],
    });
    if (answer === 'Quit VS Code') await vscode.commands.executeCommand('workbench.action.quit');
    if (answer === 'Show argv.json') {
      if (file.includes('://')) await vscode.commands.executeCommand('workbench.action.configureRuntimeArguments');
      else await vscode.window.showTextDocument(vscode.Uri.file(file));
    }
  }

  private async manualBrowserInstructions(reason: string): Promise<void> {
    const snippet = `"enable-proposed-api": ["${this.extensionId}"]`;
    const answer = await this.services.prompts.ask({
      message: `Agent Bridge could not change argv.json (${reason}). Add ${snippet} to it by hand: run "Preferences: Configure Runtime Arguments", add the line, save, and restart VS Code.`,
      choices: ['Copy Line and Open argv.json'],
    });
    if (answer) {
      await vscode.env.clipboard.writeText(`${snippet},`);
      await vscode.commands.executeCommand('workbench.action.configureRuntimeArguments');
    }
  }

  /** Tells the user once (per VS Code installation) that browser tools need the API enabled. */
  private async browserNotice(): Promise<void> {
    const memento = this.services.context.globalState;
    if (this.services.browser.available || memento.get<boolean>(BROWSER_NOTICE_KEY)) return;
    await memento.update(BROWSER_NOTICE_KEY, true);
    const target = this.argvTarget();
    const state = target.file && !target.blocked ? argvState(readTextIfExists(target.file), this.extensionId) : undefined;
    if (state?.kind === 'enabled') {
      void this.offerRestart(false, target.file!);
      return;
    }
    const answer = await this.services.prompts.ask({
      message:
        'Agent Bridge: agents can use the integrated browser once it is enabled for this extension. That is a one-time change to VS Code\'s argv.json ("enable-proposed-api") and a restart of VS Code.',
      choices: ['Enable', 'Not Now'],
    });
    if (answer === 'Enable') await this.enableBrowser();
  }

  // ------------------------------------------------------------------ status

  async statusReport(): Promise<string> {
    this.installServerSafely();
    const { services } = this;
    const id = services.window.instanceId;
    const socketPath = socketPathFor(id);
    const others = readLiveInstances().filter(i => i.id !== id);
    const argv = this.argvTarget();
    let argvStateValue: ArgvState | undefined;
    if (argv.file && !argv.blocked && !argv.viaEditor) argvStateValue = argvState(readTextIfExists(argv.file), this.extensionId);
    const config = vscode.workspace.getConfiguration('agentBridge.registration');
    const agents: AgentStatus[] = this.agents().map(agent => {
      const enabled = config.get<boolean>(agent.setting, true);
      const detected = agent.detect();
      const inspected = agent.inspect();
      const entry: RegisteredCommand | undefined = inspected.state.kind === 'ours' ? inspected.state.entry : undefined;
      return {
        name: agent.name,
        enabled,
        detected: detected.detected,
        detectedBy: detected.by,
        configFile: agent.configFile,
        state: inspected.state,
        ...(agent.blocked ? { blocked: agent.blocked } : {}),
        notes: [...inspected.problems.map(p => `PROBLEM: ${p}`), ...inspected.notes],
        ...(entry
          ? {
              registered: {
                ...entry,
                commandExists: !!entry.command && fs.existsSync(entry.command),
                ...(entry.args[0] && /mcp-server\.js$/i.test(entry.args[0]) ? { scriptExists: fs.existsSync(entry.args[0]) } : {}),
              },
            }
          : {}),
      };
    });
    const setup = this.readState();
    const manifest = readInstalledManifest(this.binDir);
    const cwd = this.workspaceCwd();
    const [started, found, listening] = await Promise.all([
      this.handshake(),
      diagnose(this.spec, { baseEnv: this.env, cwd, windowId: id }),
      canConnect(socketPath),
    ]);
    const handshakeCheck: CheckResult = {
      ok: started.ok,
      text: `${started.text} (${started.ms} ms${started.server ? `; ${started.server}` : ''}${started.tools ? `; tools: ${started.tools.join(', ')}` : ''}${started.exitCode !== undefined ? `; exit code ${started.exitCode}` : ''})`,
      stderr: started.stderr,
    };
    const data: StatusData = {
      generatedAt: new Date(),
      extensionVersion: this.version,
      vscode: { appName: vscode.env.appName, version: vscode.version, remoteName: vscode.env.remoteName ?? null, platform: process.platform, arch: process.arch },
      platform: {
        os: `${os.type()} ${os.release()} (${process.platform})`,
        arch: process.arch,
        runtime: process.execPath,
        node: process.version,
        electron: process.versions.electron ?? null,
        appHost: vscode.env.appHost,
        uiKind: vscode.env.uiKind === vscode.UIKind.Web ? 'web' : 'desktop',
        shell: vscode.env.shell,
        env: Object.fromEntries(['AGENT_BRIDGE_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'ELECTRON_RUN_AS_NODE'].map(k => [k, this.env[k]])),
      },
      window: {
        id,
        socketPath,
        listening,
        instanceFile: instanceFile(id),
        instanceFilePresent: fs.existsSync(instanceFile(id)),
        workspaceName: vscode.workspace.name ?? null,
        folders: (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath),
      },
      otherWindows: others.map(i => ({ id: i.id, workspaceName: i.workspaceName, folders: i.workspaceFolders, remoteName: i.remoteName })),
      bridgeHome: bridgeHome(),
      browser: { available: services.browser.available, argvPath: argv.file, argvState: argvStateValue, remote: !!vscode.env.remoteName },
      server: {
        spec: this.spec,
        installedVersion: manifest?.version,
        runtimes: manifest?.runtimes ?? [],
        selfTest: { ok: found.ok, text: found.text, stderr: found.stderr },
        handshake: handshakeCheck,
        scriptPath: scriptPath(this.binDir),
        scriptExists: fs.existsSync(scriptPath(this.binDir)),
      },
      registrationMode: this.mode(),
      consent: setup.consent ? `${setup.consent}${setup.agents?.length ? ` (${setup.agents.join(', ')})` : ''}${setup.decidedAt ? ` on ${setup.decidedAt}` : ''}` : 'not asked yet',
      agents,
      titles: this.titles,
      history: readHistory(this.historyFile).slice(-12),
      sessions: services.sessions.list().map(s => ({
        label: s.label,
        title: s.title,
        client: `${s.client.name}${s.client.version ? ` ${s.client.version}` : ''}`,
        connected: s.connected,
        matchedBy: s.matchedBy,
        pid: s.pid,
        cwd: s.cwd,
      })),
    };
    let text = renderStatus(data);
    const lastCheck = this.readLastCheck();
    if (lastCheck) {
      const lines = lastCheck.lines.map(l => `- ${l.kind === 'ok' ? 'ok' : l.kind === 'fixed' ? 'FIXED' : 'PROBLEM'}: ${l.text}`);
      text += `\n## Last "${this.titles.repair}" (${lastCheck.at})\n${lines.join('\n')}\n`;
    }
    return text;
  }

  // ------------------------------------------------------------------ state

  private readLastCheck(): RepairReport | undefined {
    try {
      return JSON.parse(fs.readFileSync(this.lastCheckFile, 'utf8')) as RepairReport;
    } catch {
      return undefined;
    }
  }

  private readState(): SetupState {
    try {
      return JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) as SetupState;
    } catch {
      return {};
    }
  }

  private writeState(state: SetupState): void {
    try {
      writeFileAtomic(this.stateFile, JSON.stringify(state, null, 2) + '\n', 0o600);
    } catch (err) {
      this.log.error(`could not save ${this.stateFile}`, err);
    }
  }

  private recordConsent(consent: 'granted' | 'declined', agents: Agent[]): void {
    const state = this.readState();
    const ids = new Set<AgentId>(state.consent === consent ? (state.agents ?? []) : []);
    for (const a of agents) ids.add(a.id);
    this.writeState({ ...state, consent, agents: [...ids], decidedAt: new Date().toISOString(), snoozedUntil: undefined });
  }
}

/** Shows the status report as a read-only document: selectable and copyable, no "save?" on close. */
class StatusDocuments implements vscode.TextDocumentContentProvider, vscode.Disposable {
  current = '';
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;
  private readonly uri = vscode.Uri.parse(`${STATUS_SCHEME}:Agent Bridge Status.md`);

  provideTextDocumentContent(): string {
    return this.current;
  }

  isActive(): boolean {
    return vscode.window.activeTextEditor?.document.uri.scheme === STATUS_SCHEME && !!this.current;
  }

  async show(text: string): Promise<void> {
    this.current = text;
    this.emitter.fire(this.uri);
    const document = await vscode.workspace.openTextDocument(this.uri);
    await vscode.languages.setTextDocumentLanguage(document, 'markdown');
    await vscode.window.showTextDocument(document, { preview: true });
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

/** Copies Claude Code keeps of a config file it found damaged before resetting it, newest first: "name (time)". */
function claudeBackups(configFile: string, claudeDir: string): string[] {
  const found: Array<{ name: string; mtime: number }> = [];
  for (const dir of [path.dirname(configFile), path.join(claudeDir, 'backups')]) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      // `.claude.json.backup.<time>` files are written on ordinary saves; only `corrupted` ones mean a reset.
      if (!/^\.claude\.json\..*corrupted/.test(name)) continue;
      try {
        found.push({ name: path.join(dir, name), mtime: fs.statSync(path.join(dir, name)).mtimeMs });
      } catch {
        // Gone meanwhile.
      }
    }
  }
  return found
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 3)
    .map(f => `${f.name} (${new Date(f.mtime).toISOString()})`);
}

function canConnect(socketPath: string): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.connect(socketPath);
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    setTimeout(() => done(false), 2000).unref();
  });
}

function findOnPath(env: NodeJS.ProcessEnv, exe: string): string | undefined {
  for (const dir of (env.PATH ?? env.Path ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const file = path.join(dir, exe);
    try {
      if (fs.statSync(file).isFile()) return file;
    } catch {
      // Not here.
    }
  }
  return undefined;
}

function isInsideDir(file: string, dir: string): boolean {
  const rel = path.relative(path.resolve(dir), path.resolve(file));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}
