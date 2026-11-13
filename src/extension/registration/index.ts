// Getting from "extension installed" to "the agent has the tools", and keeping it that way:
// installs the MCP server launcher, registers it with Claude Code and Codex (after asking once),
// enables the integrated browser API, and reports the state of all of it in one place.
//
// Commands: agentBridge.registerAgents, agentBridge.unregisterAgents, agentBridge.enableBrowser,
// agentBridge.showStatus (the UI module links to these ids), and agentBridge.registration.runStartupCheck
// (internal: the startup check, which development hosts do not run on their own).
import { execFile } from 'node:child_process';
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
  findClaudeCli,
  inspectClaude,
  registerClaude,
  unregisterClaude,
  type ChangeOutcome,
  type EntryState,
} from './claudeCode';
import { codexConfigFile, inspectCodexText, registerCodex, unregisterCodex } from './codex';
import { readTextIfExists, tildify, writeFileAtomic } from './files';
import { installServer, readInstalledManifest, serverSpec, type ServerSpec } from './launcher';
import { renderStatus, type AgentStatus, type StatusData } from './status';

type Mode = 'ask' | 'automatic' | 'manual';
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
}

interface Agent {
  id: AgentId;
  name: string;
  setting: 'claudeCode' | 'codex';
  configFile: string;
  /** Why changes are refused (a development host without throwaway config). */
  blocked: string | undefined;
  detect(): { detected: boolean; by?: string };
  inspect(): { state: EntryState; notes: string[] };
  register(replaceForeign: boolean): Promise<ChangeOutcome>;
  unregister(): Promise<ChangeOutcome>;
}

export interface AgentResult {
  agent: string;
  outcome: ChangeOutcome | { kind: 'skipped'; detail: string };
}

const STATUS_SCHEME = 'agent-bridge-status';
const BROWSER_NOTICE_KEY = 'agentBridge.browserNoticeShown';
const SNOOZE_MS = 7 * 24 * 3600_000;

export function activateRegistration(services: BridgeServices): void {
  const registration = new Registration(services);
  const { context } = services;
  const statusProvider = new StatusDocuments();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(STATUS_SCHEME, statusProvider),
    statusProvider,
    vscode.commands.registerCommand('agentBridge.registerAgents', () => registration.registerAgents()),
    vscode.commands.registerCommand('agentBridge.unregisterAgents', () => registration.unregisterAgents()),
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
    vscode.commands.registerCommand('agentBridge.registration.runStartupCheck', () => registration.startup()),
  );

  registration.installServerSafely();
  // A development host must not ask on its own: tests queue answers for the prompts they expect, and
  // an unexpected one would take them. Tests run the check with the internal command instead.
  if (context.extensionMode !== vscode.ExtensionMode.Production) return;
  setTimeout(() => void registration.startup().catch(err => registration.log.error('startup check failed', err)), 1500);
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('agentBridge.registration')) void registration.startup({ browserNotice: false });
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
  private spec: ServerSpec;

  constructor(private readonly services: BridgeServices) {
    this.log = scopedLogger(services.log, 'registration');
    this.isDev = services.context.extensionMode !== vscode.ExtensionMode.Production;
    this.binDir = path.join(bridgeHome(), 'bin');
    this.stateFile = path.join(bridgeHome(), 'setup.json');
    this.spec = this.currentSpec();
  }

  private get extensionId(): string {
    return this.services.context.extension.id;
  }

  private get version(): string {
    return String(this.services.context.extension.packageJSON.version);
  }

  private currentSpec(): ServerSpec {
    return serverSpec({ binDir: this.binDir, runtime: process.execPath, platform: process.platform, bridgeHomeOverride: this.env[Env.home] || undefined });
  }

  private mode(): Mode {
    const value = vscode.workspace.getConfiguration('agentBridge.registration').get<string>('mode', 'ask');
    return value === 'automatic' || value === 'manual' ? value : 'ask';
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
      if (result.scriptUpdated || result.launcherUpdated) this.log.info(`MCP server ${result.version} installed in ${this.binDir} (runtime ${process.execPath})`);
    } catch (err) {
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
    const cli = () => findClaudeCli(this.env, this.home, process.platform, bundled);
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
          const notes = result.overriddenIn.filter(o => !o.ours).map(o => `The project ${o.project} has its own "vscode" server (local scope), which Claude Code uses there instead.`);
          const found = cli();
          notes.push(found ? `Changes are made with ${found} (claude mcp).` : 'No claude executable found; changes are made by editing the file under Claude Code\'s lock.');
          return { state: result.state, notes };
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
        inspect: () => ({ state: inspectCodexText(readTextIfExists(codexFile), spec()), notes: [] }),
        register: replaceForeign => registerCodex({ configFile: codexFile }, spec(), { replaceForeign }),
        unregister: () => unregisterCodex({ configFile: codexFile }, spec()),
      },
    ];
  }

  private enabledAgents(): Agent[] {
    const config = vscode.workspace.getConfiguration('agentBridge.registration');
    return this.agents().filter(a => config.get<boolean>(a.setting, true));
  }

  // ------------------------------------------------------------------ startup

  /**
   * Runs at startup. Keeps Agent Bridge's own registrations current; asks once (mode "ask") before
   * adding one; never touches another server named "vscode". Then tells the user once if the
   * integrated browser is not enabled.
   */
  async startup(options: { browserNotice?: boolean } = {}): Promise<AgentResult[]> {
    this.installServerSafely();
    const mode = this.mode();
    const results: AgentResult[] = [];
    const candidates = this.enabledAgents().filter(a => !a.blocked && a.detect().detected);
    const absent: Agent[] = [];
    for (const agent of candidates) {
      const { state } = agent.inspect();
      if (state.kind === 'ours' && !state.current && mode !== 'manual') {
        // Our own entry, out of date (bridge home moved, VS Code moved on Windows): refreshing it is
        // part of what the user agreed to.
        const outcome = await agent.register(false);
        this.log.info(`${agent.name}: refreshed the registration: ${outcome.kind} (${outcome.detail})`);
        results.push({ agent: agent.name, outcome });
      } else if (state.kind === 'absent') {
        absent.push(agent);
      } else if (state.kind === 'foreign') {
        this.log.warn(`${agent.name}: ${agent.configFile} has a "vscode" MCP server that Agent Bridge did not add (${state.command}); not touching it`);
      }
    }

    const setup = this.readState();
    const pending = absent.filter(a => !(setup.consent === 'granted' && setup.agents?.includes(a.id)) && !(setup.consent === 'declined' && setup.agents?.includes(a.id)));
    if (pending.length > 0 && mode === 'automatic') {
      for (const agent of pending) results.push({ agent: agent.name, outcome: await agent.register(false) });
      this.recordConsent('granted', pending);
    } else if (pending.length > 0 && mode === 'ask' && !(setup.snoozedUntil && setup.snoozedUntil > Date.now())) {
      results.push(...(await this.askToRegister(pending)));
    }
    for (const r of results) this.log.info(`${r.agent}: ${r.outcome.kind} (${r.outcome.detail})`);

    if (options.browserNotice !== false) void this.browserNotice();
    return results;
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
        message: `Agent Bridge: let ${names} use this VS Code's browser tabs and terminals? This adds an MCP server named "vscode" to ${files}.`,
        choices: ['Register', 'Not Now', 'Never'],
      });
      if (answer === 'Register') {
        const results: AgentResult[] = [];
        for (const agent of agents) results.push({ agent: agent.name, outcome: await agent.register(false) });
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
      let outcome = await agent.register(false);
      if (outcome.kind === 'conflict') {
        const { state } = agent.inspect();
        const answer = await this.services.prompts.ask({
          message: `${agent.name} already has an MCP server named "vscode" that Agent Bridge did not add${state.kind === 'foreign' ? ` (${state.command})` : ''}. Replace it with Agent Bridge's?`,
          detail: `It is in ${agent.configFile}. Keeping it means ${agent.name} does not get Agent Bridge's tools.`,
          choices: ['Replace', 'Keep It'],
          modal: true,
        });
        if (answer === 'Replace') outcome = await agent.register(true);
      }
      if (outcome.kind === 'changed' || outcome.kind === 'unchanged') registered.push(agent);
      results.push({ agent: agent.name, outcome });
    }
    if (registered.length > 0) this.recordConsent('granted', registered);
    this.reportResults(results);
    return results;
  }

  async unregisterAgents(): Promise<AgentResult[]> {
    const results: AgentResult[] = [];
    const agents = this.agents(); // All of them, also those turned off in settings.
    for (const agent of agents) {
      if (agent.blocked) {
        results.push({ agent: agent.name, outcome: { kind: 'failed', detail: agent.blocked } });
        continue;
      }
      results.push({ agent: agent.name, outcome: await agent.unregister() });
    }
    // Do not put it back on the next start.
    this.recordConsent('declined', agents);
    if (this.mode() === 'automatic') {
      await vscode.workspace.getConfiguration('agentBridge.registration').update('mode', 'manual', vscode.ConfigurationTarget.Global);
    }
    const lines = results.map(r => `${r.agent}: ${r.outcome.kind === 'changed' ? 'removed' : r.outcome.detail}`);
    void this.services.prompts.ask({
      message: `Agent Bridge: ${lines.join('; ')}. Running agent sessions keep the tools until they restart.`,
      choices: ['Show Status'],
    }).then(choice => choice && vscode.commands.executeCommand('agentBridge.showStatus'));
    return results;
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
      ? 'Agent Bridge: neither Claude Code nor Codex was found. Install one, then run "Agent Bridge: Register with Claude Code and Codex".'
      : `Agent Bridge: ${parts.join('; ')}.${anyRegistered ? ' New agent sessions get the tools; restart sessions that are already running.' : ''}`;
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
      return {
        name: agent.name,
        enabled,
        detected: detected.detected,
        detectedBy: detected.by,
        configFile: agent.configFile,
        state: inspected.state,
        ...(agent.blocked ? { blocked: agent.blocked } : {}),
        notes: inspected.notes,
      };
    });
    const setup = this.readState();
    const manifest = readInstalledManifest(this.binDir);
    const data: StatusData = {
      generatedAt: new Date(),
      extensionVersion: this.version,
      vscode: { appName: vscode.env.appName, version: vscode.version, remoteName: vscode.env.remoteName ?? null, platform: process.platform, arch: process.arch },
      window: {
        id,
        socketPath,
        listening: await canConnect(socketPath),
        instanceFile: instanceFile(id),
        instanceFilePresent: fs.existsSync(instanceFile(id)),
        workspaceName: vscode.workspace.name ?? null,
        folders: (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath),
      },
      otherWindows: others.map(i => ({ id: i.id, workspaceName: i.workspaceName, folders: i.workspaceFolders, remoteName: i.remoteName })),
      bridgeHome: bridgeHome(),
      browser: { available: services.browser.available, argvPath: argv.file, argvState: argvStateValue, remote: !!vscode.env.remoteName },
      server: { spec: this.spec, installedVersion: manifest?.version, runtimes: manifest?.runtimes ?? [], selfTest: await this.selfTest() },
      registrationMode: this.mode(),
      consent: setup.consent ? `${setup.consent}${setup.agents?.length ? ` (${setup.agents.join(', ')})` : ''}` : 'not asked yet',
      agents,
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
    return renderStatus(data);
  }

  /** Starts the registered command with --diagnose, as an extension in this window would start it. */
  private selfTest(): Promise<{ ok: boolean; text: string }> {
    const { command, args, env } = this.spec;
    const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
    delete childEnv[Env.instance];
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? this.home;
    return new Promise(resolve => {
      execFile(command, [...args, '--diagnose'], { env: childEnv, cwd, timeout: 15_000, windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) => {
        if (err) {
          resolve({ ok: false, text: `${command} could not be started: ${(stderr || err.message).trim().split('\n')[0]}` });
          return;
        }
        try {
          const report = JSON.parse(stdout);
          const runtime = `runs on ${report.runtime?.execPath} (Node ${report.runtime?.node}), server ${report.version}`;
          if (report.selected?.id === this.services.window.instanceId) {
            resolve({ ok: true, text: `${runtime}; finds this window (matched by ${report.selected.matchedBy}).` });
          } else if (report.selected) {
            resolve({ ok: false, text: `${runtime}; but connects to window ${report.selected.id} instead of this one (matched by ${report.selected.matchedBy}).` });
          } else {
            resolve({ ok: false, text: `${runtime}; but finds no window: ${report.problem}` });
          }
        } catch {
          resolve({ ok: false, text: `unexpected output: ${stdout.slice(0, 200)}` });
        }
      });
    });
  }

  // ------------------------------------------------------------------ state

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
    this.writeState({ consent, agents: [...ids], decidedAt: new Date().toISOString() });
  }
}

/** Shows the status report as a read-only document: selectable and copyable, no "save?" on close. */
class StatusDocuments implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private text = '';
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;
  private readonly uri = vscode.Uri.parse(`${STATUS_SCHEME}:Agent Bridge Status.md`);

  provideTextDocumentContent(): string {
    return this.text;
  }

  async show(text: string): Promise<void> {
    this.text = text;
    this.emitter.fire(this.uri);
    const document = await vscode.workspace.openTextDocument(this.uri);
    await vscode.languages.setTextDocumentLanguage(document, 'markdown');
    await vscode.window.showTextDocument(document, { preview: true });
  }

  dispose(): void {
    this.emitter.dispose();
  }
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
