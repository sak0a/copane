// The "Copane: Show Status" report: one place that answers "why doesn't Claude see the tools?".
// Rendered from plain data so the wording is testable without VS Code.
import type { InstanceMatch } from '../../shared/protocol';
import type { ArgvState } from './argv';
import type { EntryState, RegisteredCommand } from './claudeCode';
import { formatRecord, type HistoryRecord } from './history';
import type { ServerSpec } from './launcher';
import { DEFAULT_TITLES, type CommandTitles } from './plan';

export interface AgentStatus {
  name: string;
  enabled: boolean;
  detected: boolean;
  /** How it was detected ("claude CLI at ...", "config file", ...). */
  detectedBy: string | undefined;
  configFile: string;
  state: EntryState;
  /** A safety guard that blocks changes (dev hosts without throwaway config). */
  blocked?: string;
  notes: string[];
  /** What the agent's config registers, and whether the files it names exist. */
  registered?: RegisteredCommand & { commandExists: boolean; scriptExists?: boolean };
}

/** A start test of the server, as in probe.ts. */
export interface CheckResult {
  ok: boolean;
  text: string;
  stderr?: string;
}

export interface PlatformInfo {
  os: string;
  arch: string;
  /** The extension host's runtime (`process.execPath`) and versions. */
  runtime: string;
  node: string;
  electron: string | null;
  appHost: string;
  uiKind: string;
  shell: string;
  /** Environment variables that change where things are, as set for the extension host. */
  env: Record<string, string | undefined>;
}

export interface StatusData {
  generatedAt: Date;
  extensionVersion: string;
  vscode: { appName: string; version: string; remoteName: string | null; platform: string; arch: string };
  platform?: PlatformInfo;
  window: {
    id: string;
    socketPath: string;
    listening: boolean;
    instanceFile: string;
    instanceFilePresent: boolean;
    workspaceName: string | null;
    folders: string[];
  };
  otherWindows: Array<{ id: string; workspaceName: string | null; folders: string[]; remoteName: string | null }>;
  bridgeHome: string;
  browser: {
    available: boolean;
    argvPath: string | undefined;
    argvState: ArgvState | undefined;
    remote: boolean;
    /** Set when this editor has no integrated browser: why, in a sentence (setup.ts). */
    unsupported?: string;
  };
  server: {
    spec: ServerSpec;
    installedVersion: string | undefined;
    runtimes: string[];
    /** `--diagnose` started the way an agent would: which window it finds, and whether that answers. */
    selfTest: CheckResult;
    /** An MCP handshake with the registered command (`--no-connect`). */
    handshake?: CheckResult;
    scriptPath?: string;
    scriptExists?: boolean;
  };
  /** Command names as shown in the Command Palette. */
  titles?: CommandTitles;
  /** The newest registration changes, oldest first. */
  history?: HistoryRecord[];
  registrationMode: string;
  consent: string;
  agents: AgentStatus[];
  sessions: Array<{
    label: string;
    title: string | undefined;
    client: string;
    connected: boolean;
    /** Kept from before a reload or restart; its agent has not reconnected. */
    away?: boolean;
    matchedBy: InstanceMatch | undefined;
    pid: number | undefined;
    cwd: string | undefined;
  }>;
}

const MATCH: Record<InstanceMatch, string> = {
  ancestor: 'started by an extension in this window (e.g. a Claude Code chat)',
  env: 'started in an integrated terminal of this window',
  reconnect: 'reconnected after this window reloaded',
  cwd: 'working directory inside this workspace',
  worktree: 'working directory in a git worktree of a repository open in this workspace',
  single: 'the only open window',
  explicit: 'chosen by the agent (window_select)',
};

function stateText(state: EntryState): string {
  switch (state.kind) {
    case 'absent':
      return 'not registered';
    case 'ours':
      return state.current ? 'registered ✓' : `registered, but outdated (${state.command})`;
    case 'foreign':
      return `another server named "copane" is configured, not Copane's: ${state.command}`;
    case 'unreadable':
      return `cannot read the config: ${state.error}`;
  }
}

function argvText(d: StatusData['browser']): string {
  if (d.unsupported) return `not supported in this editor. ${d.unsupported}`;
  if (d.available) return 'available ✓';
  const s = d.argvState;
  if (d.remote && !d.argvPath) return 'not enabled. This is a remote window: argv.json is on your local machine; run "Copane: Enable Integrated Browser".';
  if (!s) return 'not enabled';
  switch (s.kind) {
    case 'enabled':
      return 'enabled in argv.json, but VS Code has not been restarted since. Quit VS Code completely and start it again (reloading the window is not enough).';
    case 'not-enabled':
    case 'missing':
      return 'not enabled. Run "Copane: Enable Integrated Browser" (one-time; needs a VS Code restart).';
    case 'invalid':
      return `not enabled, and argv.json cannot be parsed (${s.error}); fix it with "Preferences: Configure Runtime Arguments".`;
  }
}

function check(line: (s?: string) => void, title: string, result: CheckResult): void {
  line(`- ${title}: ${result.ok ? 'ok ✓' : 'FAILED'}`);
  for (const l of result.text.split('\n')) if (l.trim()) line(`  ${l}`);
  if (result.stderr?.trim()) {
    line('  stderr:');
    line('  ```');
    for (const l of result.stderr.trim().split(/\r?\n/).slice(-25)) line(`  ${l}`);
    line('  ```');
  }
}

export function renderStatus(d: StatusData): string {
  const out: string[] = [];
  const line = (s = '') => out.push(s);
  line('# Copane status');
  line();
  line(
    `${d.generatedAt.toISOString()} · Copane ${d.extensionVersion} · ${d.vscode.appName} ${d.vscode.version} · ${d.vscode.platform}-${d.vscode.arch}` +
      (d.vscode.remoteName ? ` · remote window (${d.vscode.remoteName}; this report describes the remote side)` : ' · local window'),
  );
  line();

  if (d.platform) {
    const p = d.platform;
    line('## Platform');
    line(`- OS: ${p.os} (${p.arch}); UI: ${p.uiKind}, app host: ${p.appHost}; default shell: ${p.shell || '(not set)'}`);
    line(`- Extension host runtime: ${p.runtime} (Node ${p.node}${p.electron ? `, Electron ${p.electron}` : ''})`);
    const vars = Object.entries(p.env).map(([k, v]) => `${k}=${v ?? '(unset)'}`);
    if (vars.length) line(`- Environment: ${vars.join(' · ')}`);
    line();
  }

  line('## This window');
  line(`- Window id: ${d.window.id} (extension host process)`);
  line(`- Workspace: ${d.window.workspaceName ?? '(none)'}${d.window.folders.length ? ` — ${d.window.folders.join(', ')}` : ''}`);
  line(`- Bridge socket: ${d.window.socketPath} — ${d.window.listening ? 'listening ✓' : 'NOT listening (see "Copane: Show Log")'}`);
  line(`- Instance file: ${d.window.instanceFile} — ${d.window.instanceFilePresent ? 'present ✓' : 'MISSING: agents cannot find this window'}`);
  line(`- Bridge home: ${d.bridgeHome}`);
  if (d.otherWindows.length) {
    line(`- Other windows with Copane: ${d.otherWindows.length}`);
    for (const w of d.otherWindows) line(`  - ${w.id}: ${w.workspaceName ?? '(no folder)'}${w.folders.length ? ` — ${w.folders.join(', ')}` : ''}${w.remoteName ? ` [${w.remoteName}]` : ''}`);
  } else {
    line('- Other windows with Copane: none');
  }
  line();

  line('## Integrated browser');
  line(`- Browser API: ${argvText(d.browser)}`);
  if (d.browser.argvPath && !d.browser.unsupported) line(`- argv.json: ${d.browser.argvPath}`);
  line();

  line('## Agents');
  line(`- Registration mode: ${d.registrationMode} (setting copane.registration.mode); consent: ${d.consent}`);
  for (const agent of d.agents) {
    line(`### ${agent.name}`);
    if (!agent.enabled) {
      line('- Turned off in settings.');
      continue;
    }
    line(`- Installed: ${agent.detected ? `yes (${agent.detectedBy})` : 'not found'}`);
    line(`- Config: ${agent.configFile}`);
    line(`- MCP server "copane": ${stateText(agent.state)}`);
    if (agent.state.kind === 'ours' && !agent.state.current && agent.state.reason) line(`- Out of date because ${agent.state.reason}`);
    if (agent.registered) {
      const r = agent.registered;
      line(`- Registered command: ${JSON.stringify(r.command)} — ${r.commandExists ? 'exists ✓' : 'DOES NOT EXIST'}`);
      line(`- Registered args: ${JSON.stringify(r.args)}${r.scriptExists === undefined ? '' : r.scriptExists ? ' — script exists ✓' : ' — SCRIPT DOES NOT EXIST'}`);
      const env = Object.entries(r.env);
      line(`- Registered env: ${env.length ? env.map(([k, v]) => `${k}=${v}`).join(' ') : '(none)'}`);
    }
    if (agent.blocked) line(`- Changes blocked: ${agent.blocked}`);
    for (const note of agent.notes) line(`- ${note}`);
  }
  line();

  line('## MCP server');
  line(`- Agents start: ${[d.server.spec.command, ...d.server.spec.args].join(' ')}`);
  const env = Object.entries(d.server.spec.env);
  if (env.length) line(`- With environment: ${env.map(([k, v]) => `${k}=${v}`).join(' ')}`);
  line(`- Installed server version: ${d.server.installedVersion ?? 'not installed'}`);
  if (d.server.runtimes.length) line(`- Runtimes it tries: ${d.server.runtimes.join(', ')}`);
  if (d.server.scriptPath) line(`- Server script: ${d.server.scriptPath} — ${d.server.scriptExists ? 'present ✓' : 'MISSING'}`);
  if (d.server.handshake) check(line, 'Start test (MCP handshake and tool list, as an agent starts it)', d.server.handshake);
  check(line, 'Self-test (started the way an agent would, from this window)', d.server.selfTest);
  line();

  if (d.history) {
    line('## Recent registration changes');
    if (d.history.length === 0) line('- None recorded.');
    for (const r of d.history) line(`- ${formatRecord(r)}`);
    line();
  }

  line('## Agent sessions in this window');
  if (d.sessions.length === 0) line('- None connected. Start a new agent session after registering (a Claude Code or Copilot chat, or `claude`, `codex` or `copilot` in a terminal); running sessions do not reload their MCP servers.');
  for (const s of d.sessions) {
    const how = s.matchedBy ? MATCH[s.matchedBy] : 'unknown';
    line(`- ${s.label}${s.title ? ` · ${s.title}` : ''} — ${s.client}, ${s.connected ? 'connected' : s.away ? 'away (from before a reload or restart; its agent has not reconnected)' : 'disconnected (grace period)'}; found this window: ${how}${s.pid ? `; pid ${s.pid}` : ''}${s.cwd ? `; cwd ${s.cwd}` : ''}`);
  }
  line();

  line('## If an agent does not see the tools');
  line('1. The agent must be started after registering: start a new chat, or restart `claude` / `codex` / `copilot`. In Claude Code and the Copilot CLI, `/mcp` lists the "copane" server and its state.');
  line('2. The agent sees `window_status` and `window_select` even when it cannot reach a window; ask it to call `window_status`, which says why.');
  line('3. Several VS Code windows and an agent started outside any of them: the agent asks which window to use (window_select).');
  const t = d.titles ?? DEFAULT_TITLES;
  line(`4. Run "${t.repair}": it repairs what it can and says what it did.`);
  line(`5. Still stuck: copy this report (the Copy button in the editor title bar, or "${t.copy}") and the output of "${t.log}".`);
  return out.join('\n') + '\n';
}
