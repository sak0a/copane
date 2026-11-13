// The "Agent Bridge: Show Status" report: one place that answers "why doesn't Claude see the tools?".
// Rendered from plain data so the wording is testable without VS Code.
import type { InstanceMatch } from '../../shared/protocol';
import type { ArgvState } from './argv';
import type { EntryState } from './claudeCode';
import type { ServerSpec } from './launcher';

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
}

export interface StatusData {
  generatedAt: Date;
  extensionVersion: string;
  vscode: { appName: string; version: string; remoteName: string | null; platform: string; arch: string };
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
  browser: { available: boolean; argvPath: string | undefined; argvState: ArgvState | undefined; remote: boolean };
  server: { spec: ServerSpec; installedVersion: string | undefined; runtimes: string[]; selfTest: { ok: boolean; text: string } };
  registrationMode: string;
  consent: string;
  agents: AgentStatus[];
  sessions: Array<{
    label: string;
    title: string | undefined;
    client: string;
    connected: boolean;
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
      return `another server named "vscode" is configured, not Agent Bridge's: ${state.command}`;
    case 'unreadable':
      return `cannot read the config: ${state.error}`;
  }
}

function argvText(d: StatusData['browser']): string {
  if (d.available) return 'available ✓';
  const s = d.argvState;
  if (d.remote && !d.argvPath) return 'not enabled. This is a remote window: argv.json is on your local machine; run "Agent Bridge: Enable Integrated Browser".';
  if (!s) return 'not enabled';
  switch (s.kind) {
    case 'enabled':
      return 'enabled in argv.json, but VS Code has not been restarted since. Quit VS Code completely and start it again (reloading the window is not enough).';
    case 'not-enabled':
    case 'missing':
      return 'not enabled. Run "Agent Bridge: Enable Integrated Browser" (one-time; needs a VS Code restart).';
    case 'invalid':
      return `not enabled, and argv.json cannot be parsed (${s.error}); fix it with "Preferences: Configure Runtime Arguments".`;
  }
}

export function renderStatus(d: StatusData): string {
  const out: string[] = [];
  const line = (s = '') => out.push(s);
  line('# Agent Bridge status');
  line();
  line(
    `${d.generatedAt.toISOString()} · Agent Bridge ${d.extensionVersion} · ${d.vscode.appName} ${d.vscode.version} · ${d.vscode.platform}-${d.vscode.arch}` +
      (d.vscode.remoteName ? ` · remote window (${d.vscode.remoteName}; this report describes the remote side)` : ' · local window'),
  );
  line();

  line('## This window');
  line(`- Window id: ${d.window.id} (extension host process)`);
  line(`- Workspace: ${d.window.workspaceName ?? '(none)'}${d.window.folders.length ? ` — ${d.window.folders.join(', ')}` : ''}`);
  line(`- Bridge socket: ${d.window.socketPath} — ${d.window.listening ? 'listening ✓' : 'NOT listening (see "Agent Bridge: Show Log")'}`);
  line(`- Instance file: ${d.window.instanceFile} — ${d.window.instanceFilePresent ? 'present ✓' : 'MISSING: agents cannot find this window'}`);
  line(`- Bridge home: ${d.bridgeHome}`);
  if (d.otherWindows.length) {
    line(`- Other windows with Agent Bridge: ${d.otherWindows.length}`);
    for (const w of d.otherWindows) line(`  - ${w.id}: ${w.workspaceName ?? '(no folder)'}${w.folders.length ? ` — ${w.folders.join(', ')}` : ''}${w.remoteName ? ` [${w.remoteName}]` : ''}`);
  } else {
    line('- Other windows with Agent Bridge: none');
  }
  line();

  line('## Integrated browser');
  line(`- Browser API: ${argvText(d.browser)}`);
  if (d.browser.argvPath) line(`- argv.json: ${d.browser.argvPath}`);
  line();

  line('## Agents');
  line(`- Registration mode: ${d.registrationMode} (setting agentBridge.registration.mode); consent: ${d.consent}`);
  for (const agent of d.agents) {
    line(`### ${agent.name}`);
    if (!agent.enabled) {
      line('- Turned off in settings.');
      continue;
    }
    line(`- Installed: ${agent.detected ? `yes (${agent.detectedBy})` : 'not found'}`);
    line(`- Config: ${agent.configFile}`);
    line(`- MCP server "vscode": ${stateText(agent.state)}`);
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
  line(`- Self-test (started the way an agent would, from this window): ${d.server.selfTest.ok ? 'ok ✓' : 'FAILED'}`);
  for (const l of d.server.selfTest.text.split('\n')) if (l.trim()) line(`  ${l}`);
  line();

  line('## Agent sessions in this window');
  if (d.sessions.length === 0) line('- None connected. Start a new Claude Code session (chat or `claude` in a terminal) after registering; running sessions do not reload their MCP servers.');
  for (const s of d.sessions) {
    const how = s.matchedBy ? MATCH[s.matchedBy] : 'unknown';
    line(`- ${s.label}${s.title ? ` · ${s.title}` : ''} — ${s.client}, ${s.connected ? 'connected' : 'disconnected (grace period)'}; found this window: ${how}${s.pid ? `; pid ${s.pid}` : ''}${s.cwd ? `; cwd ${s.cwd}` : ''}`);
  }
  line();

  line('## If an agent does not see the tools');
  line('1. The agent must be started after registering: start a new Claude Code chat, or restart `claude` / `codex`. In Claude Code, `/mcp` lists the "vscode" server and its state.');
  line('2. The agent sees `window_status` and `window_select` even when it cannot reach a window; ask it to call `window_status`, which says why.');
  line('3. Several VS Code windows and an agent started outside any of them: the agent asks which window to use (window_select).');
  line('4. Still stuck: copy this report and the output of "Agent Bridge: Show Log".');
  return out.join('\n') + '\n';
}
