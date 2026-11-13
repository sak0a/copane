// Registration with Claude Code and Codex, browser enablement, the status report and the MCP server's
// reconnect after a window reload, against a running dev host. Everything is written to the dev
// host's throwaway config (CLAUDE_CONFIG_DIR, CODEX_HOME, AGENT_BRIDGE_ARGV_JSON under
// /tmp/agent-bridge-dev/<name>/), never to the real one.
//
//   node scripts/dev-host.mjs --name registration
//   node test/e2e/registration.e2e.mjs --name registration
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agent, assert, hostDir, run, sleep, test, until } from './harness.mjs';

const claudeDir = join(hostDir, 'claude');
const claudeFile = join(claudeDir, '.claude.json');
const codexDir = join(hostDir, 'codex');
const codexFile = join(codexDir, 'config.toml');
const argvFile = join(hostDir, 'argv.json');
const setupFile = join(hostDir, 'home', 'setup.json');
const launcher = join(hostDir, 'home', 'bin', process.platform === 'win32' ? 'mcp-server.js' : 'mcp-server');
const historyFile = join(hostDir, 'home', 'registration-history.json');
const readHistory = () => (existsSync(historyFile) ? JSON.parse(readFileSync(historyFile, 'utf8')) : []);

const CLAUDE_BEFORE = { numStartups: 7, mcpServers: { github: { type: 'http', url: 'https://example.com/mcp' } }, projects: { '/p': { allowedTools: [] } } };
const CODEX_BEFORE = '# my codex settings\nmodel = "o3" # keep this comment\n\n[mcp_servers.other]\ncommand = "x"\n';
const ARGV_BEFORE = `// This configuration file allows you to pass permanent command line arguments to VS Code.
{
\t// Allows to disable crash reporting.
\t"enable-crash-reporter": false,
\t"locale": "en"
}
`;

function resetConfigs() {
  mkdirSync(claudeDir, { recursive: true });
  mkdirSync(codexDir, { recursive: true });
  writeFileSync(claudeFile, JSON.stringify(CLAUDE_BEFORE, null, 2));
  writeFileSync(codexFile, CODEX_BEFORE);
  rmSync(setupFile, { force: true });
}

const readClaude = () => JSON.parse(readFileSync(claudeFile, 'utf8'));
const readCodex = () => readFileSync(codexFile, 'utf8');

/** Runs a VS Code command in the dev host and returns its (JSON) result. */
async function command(a, id, ...args) {
  const text = await a.ok('debug_vscode_command', { command: id, args });
  return text === 'ok' ? undefined : JSON.parse(text);
}

async function answers(a, list) {
  return JSON.parse(await a.ok('debug_answer_prompts', { answers: list, clear: true }));
}

async function shownPrompts(a) {
  return JSON.parse(await a.ok('debug_answer_prompts', {})).shown;
}

/** An environment for running the real CLIs against the throwaway config, without this agent's own session variables. */
function cliEnv(extra) {
  const env = { ...process.env, ...extra };
  for (const k of Object.keys(env)) if (/^(CLAUDE|AGENT_BRIDGE|AI_AGENT$|ELECTRON_RUN_AS_NODE$)/.test(k)) delete env[k];
  return { ...env, ...extra };
}

function available(cmd) {
  try {
    execFileSync(cmd, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test('asks once, then registers with Claude Code and Codex, keeping everything else in their files', async () => {
  resetConfigs();
  const a = await agent({ session: 'reg-1' });
  try {
    await answers(a, ['Register', null]);
    const results = await command(a, 'agentBridge.registration.runStartupCheck');
    assert.deepEqual(results.map(r => [r.agent, r.outcome.kind]), [
      ['Claude Code', 'changed'],
      ['Codex', 'changed'],
    ]);
    const prompts = await shownPrompts(a);
    const consent = prompts.find(p => p.message.includes('let Claude Code and Codex use'));
    assert.ok(consent, 'the consent prompt was shown');
    assert.deepEqual(consent.choices, ['Register', 'Not Now', 'Never']);

    const claude = readClaude();
    assert.equal(claude.mcpServers.vscode.command, launcher);
    assert.equal(claude.mcpServers.vscode.env.AGENT_BRIDGE_HOME, join(hostDir, 'home'));
    assert.deepEqual(claude.mcpServers.github, CLAUDE_BEFORE.mcpServers.github);
    assert.equal(claude.numStartups, 7);
    assert.deepEqual(claude.projects, CLAUDE_BEFORE.projects);

    const codex = readCodex();
    assert.ok(codex.startsWith(CODEX_BEFORE.trimEnd()), 'the existing Codex config is unchanged');
    assert.match(codex, /\[mcp_servers\.vscode\]\ncommand = ".*mcp-server"/);
    assert.match(codex, /env_vars = \["AGENT_BRIDGE_INSTANCE", "AGENT_BRIDGE_SESSION"\]/);

    // Idempotent and quiet the second time.
    const before = (await shownPrompts(a)).length;
    const again = await command(a, 'agentBridge.registration.runStartupCheck');
    assert.deepEqual(again, []);
    assert.equal((await shownPrompts(a)).length, before, 'no second prompt');
  } finally {
    await a.close();
  }
});

test('the registered server is what the real claude and codex start, and it reaches this window', async () => {
  if (available('claude')) {
    const out = execFileSync('claude', ['mcp', 'list'], { env: cliEnv({ CLAUDE_CONFIG_DIR: claudeDir }), cwd: join(hostDir, 'ws'), encoding: 'utf8', timeout: 60_000 });
    assert.match(out, /vscode: .*mcp-server.*Connected/);
  } else console.log('      (claude not installed: skipped the claude part)');
  if (available('codex')) {
    const listed = JSON.parse(execFileSync('codex', ['mcp', 'list', '--json'], { env: cliEnv({ CODEX_HOME: codexDir }), encoding: 'utf8', timeout: 30_000 }));
    const ours = listed.find(s => s.name === 'vscode');
    assert.equal(ours.transport.command, launcher);
    assert.equal(ours.tool_timeout_sec, 600);
  } else console.log('      (codex not installed: skipped the codex part)');
  // The launcher itself, started like an agent would from the workspace folder.
  const diagnose = JSON.parse(
    execFileSync(launcher, ['--diagnose'], { env: cliEnv({ AGENT_BRIDGE_HOME: join(hostDir, 'home') }), cwd: join(hostDir, 'ws'), encoding: 'utf8' }),
  );
  assert.ok(diagnose.selected, `the server finds a window: ${diagnose.problem}`);
});

test('never replaces a "vscode" server the user configured, unless they say so', async () => {
  resetConfigs();
  const theirs = { type: 'stdio', command: 'npx', args: ['their-vscode-server'] };
  writeFileSync(claudeFile, JSON.stringify({ ...CLAUDE_BEFORE, mcpServers: { ...CLAUDE_BEFORE.mcpServers, vscode: theirs } }, null, 2));
  const a = await agent({ session: 'reg-2' });
  try {
    await answers(a, ['Keep It', null]);
    let results = await command(a, 'agentBridge.registerAgents');
    assert.equal(results.find(r => r.agent === 'Claude Code').outcome.kind, 'conflict');
    assert.deepEqual(readClaude().mcpServers.vscode, theirs);
    const prompt = (await shownPrompts(a)).find(p => p.message.includes('did not add'));
    assert.ok(prompt?.message.includes('npx their-vscode-server'), 'the prompt names their server');

    // Unregistering leaves their server alone too.
    await answers(a, [null]);
    results = await command(a, 'agentBridge.unregisterAgents');
    assert.equal(results.find(r => r.agent === 'Claude Code').outcome.kind, 'conflict');
    assert.deepEqual(readClaude().mcpServers.vscode, theirs);

    await answers(a, ['Replace', null]);
    results = await command(a, 'agentBridge.registerAgents');
    assert.equal(results.find(r => r.agent === 'Claude Code').outcome.kind, 'changed');
    assert.equal(readClaude().mcpServers.vscode.command, launcher);
  } finally {
    await a.close();
  }
});

test('the status report covers this window, the browser, both agents and the sessions', async () => {
  const a = await agent({ session: 'reg-status' });
  try {
    await a.ok('session_set_title', { title: 'status check' });
    const report = await command(a, 'agentBridge.showStatus', { show: false });
    assert.match(report, /## This window/);
    assert.match(report, /listening ✓/);
    assert.match(report, /### Claude Code[\s\S]*registered ✓/);
    assert.match(report, /### Codex[\s\S]*registered ✓/);
    assert.match(report, /Self-test .*: ok ✓/);
    assert.match(report, /Claude \d+ · status check — claude-code/);
  } finally {
    await a.close();
  }
});

test('unregister removes only Agent Bridge entries and is not undone on the next start', async () => {
  resetConfigs();
  const a = await agent({ session: 'reg-3' });
  try {
    await answers(a, [null]);
    await command(a, 'agentBridge.registerAgents');
    assert.ok(readClaude().mcpServers.vscode);
    await answers(a, [null]);
    const results = await command(a, 'agentBridge.unregisterAgents');
    assert.deepEqual(results.map(r => r.outcome.kind), ['changed', 'changed']);
    // The claude CLI adds its own first-run fields to a fresh config; ours are exactly as before.
    const claude = readClaude();
    for (const key of Object.keys(CLAUDE_BEFORE)) assert.deepEqual(claude[key], CLAUDE_BEFORE[key], key);
    assert.equal(readCodex(), CODEX_BEFORE);
    assert.equal(JSON.parse(readFileSync(setupFile, 'utf8')).consent, 'declined');
    const before = (await shownPrompts(a)).length;
    assert.deepEqual(await command(a, 'agentBridge.registration.runStartupCheck'), []);
    assert.equal((await shownPrompts(a)).length, before, 'no prompt after the user unregistered');
    assert.equal(readClaude().mcpServers.vscode, undefined);
  } finally {
    await a.close();
  }
});

test('enabling the browser adds the extension to argv.json, keeps comments, and is idempotent', async () => {
  const a = await agent({ session: 'reg-4' });
  try {
    writeFileSync(argvFile, ARGV_BEFORE);
    await answers(a, ['Later']);
    let result = await command(a, 'agentBridge.enableBrowser', { evenIfAvailable: true });
    assert.equal(result.state, 'enabled');
    assert.equal(result.changed, true);
    let text = readFileSync(argvFile, 'utf8');
    assert.match(text, /"enable-proposed-api": \[\s*"sak0a\.vscode-agent-bridge"\s*\]/);
    assert.match(text, /\/\/ Allows to disable crash reporting\./);
    assert.match(text, /"locale": "en"/);
    const restart = (await shownPrompts(a)).at(-1);
    assert.match(restart.message, /quit VS Code completely/);
    assert.deepEqual(restart.choices, ['Quit VS Code', 'Show argv.json', 'Later']);

    await answers(a, ['Later']);
    result = await command(a, 'agentBridge.enableBrowser', { evenIfAvailable: true });
    assert.equal(result.changed, false);

    // The way it works in a remote window: through the editor of argv.json.
    writeFileSync(argvFile, '{\n\t"enable-proposed-api": ["other.extension"]\n}\n');
    await answers(a, ['Later']);
    result = await command(a, 'agentBridge.enableBrowser', { evenIfAvailable: true, viaEditor: true });
    assert.equal(result.changed, true);
    text = readFileSync(argvFile, 'utf8');
    assert.match(text, /"other\.extension",\s*"sak0a\.vscode-agent-bridge"/);
    await command(a, 'workbench.action.closeActiveEditor');
  } finally {
    await a.close();
  }
});

test('the MCP server reconnects after the window reloads and keeps its session key', async () => {
  const key = 'reg-reload';
  const a = await agent({ session: key });
  try {
    const before = JSON.parse(await a.ok('session_info'));
    assert.equal(before.you.id, key);
    const windowBefore = before.window.instanceId;
    // The reload takes the extension host down with this very call, so its result does not matter.
    await a.call('debug_vscode_command', { command: 'workbench.action.reloadWindow' }).catch(() => {});
    // Wait until the old window is gone: the next call must wait for the new one.
    const instanceFile = join(hostDir, 'home', 'instances', `${windowBefore}.json`);
    await until(() => !existsSync(instanceFile), 'the old window to go away', { timeoutMs: 20_000 });
    const after = JSON.parse(await a.ok('session_info', {}, { timeoutMs: 60_000 }));
    assert.notEqual(after.window.instanceId, windowBefore, 'a new extension host');
    assert.equal(after.you.id, key, 'same session key');
    const status = await a.ok('window_status');
    assert.match(status, /replaced the window this session used before/);
    assert.ok((await a.tools()).some(t => t.name === 'session_info'));
  } finally {
    await a.close();
  }
  await sleep(500);
});

/** Turned on, with both agents registered: the state the owner was in before the entry disappeared. */
async function turnedOn(a) {
  resetConfigs();
  await answers(a, [null]);
  const results = await command(a, 'agentBridge.registerAgents');
  assert.deepEqual(results.map(r => r.outcome.kind), ['changed', 'changed']);
}

test('an entry removed outside Agent Bridge comes back at startup, with the reason in the history', async () => {
  const a = await agent({ session: 'repair-1' });
  try {
    await turnedOn(a);
    // `claude mcp remove vscode`, or Claude Code resetting its config: the entry is gone, consent stays.
    const claude = readClaude();
    delete claude.mcpServers.vscode;
    writeFileSync(claudeFile, JSON.stringify(claude, null, 2));
    const prompts = (await shownPrompts(a)).length;
    const results = await command(a, 'agentBridge.registration.runStartupCheck');
    assert.deepEqual(results.map(r => [r.agent, r.outcome.kind]), [['Claude Code', 'changed']]);
    assert.equal(readClaude().mcpServers.vscode.command, launcher);
    assert.equal((await shownPrompts(a)).length, prompts, 'quiet: no prompt for a repair it could make');
    const record = readHistory().at(-1);
    assert.equal(record.agent, 'Claude Code');
    assert.equal(record.action, 'add');
    assert.equal(record.trigger, 'startup');
    assert.match(record.reason, /missing although registration was agreed to/);
    // The start test ran and passed, and is remembered so the next start does not repeat it.
    assert.equal(JSON.parse(readFileSync(setupFile, 'utf8')).lastProbe.ok, true);
  } finally {
    await a.close();
  }
});

test('an update never passes through "no entry": while the config is locked the old entry stays, then it is updated in one step', async () => {
  const a = await agent({ session: 'repair-2' });
  try {
    await turnedOn(a);
    const old = { type: 'stdio', command: '/old/place/.vscode-agent-bridge/bin/mcp-server', args: [], env: { AGENT_BRIDGE_HOME: join(hostDir, 'home') } };
    writeFileSync(claudeFile, JSON.stringify({ ...readClaude(), mcpServers: { ...readClaude().mcpServers, vscode: old } }, null, 2));
    // A running Claude Code holds its config lock for longer than Agent Bridge waits (15 s).
    const lock = `${claudeFile}.lock`;
    mkdirSync(lock);
    const keepFresh = setInterval(() => utimesSync(lock, new Date(), new Date()), 1000);
    const seen = [];
    const watch = setInterval(() => seen.push(readClaude().mcpServers.vscode?.command ?? 'MISSING'), 50);
    let results;
    try {
      results = await command(a, 'agentBridge.registration.runStartupCheck');
    } finally {
      clearInterval(keepFresh);
      clearInterval(watch);
      rmSync(lock, { recursive: true, force: true });
    }
    assert.deepEqual(results.map(r => [r.agent, r.outcome.kind]), [['Claude Code', 'failed']]);
    assert.match(results[0].outcome.detail, /locked by another program.*the previous entry is unchanged/);
    assert.deepEqual(readClaude().mcpServers.vscode, old);
    assert.ok(seen.length > 100 && seen.every(c => c === old.command), 'the entry was there the whole time');
    const failed = readHistory().at(-1);
    assert.equal(failed.outcome, 'failed');
    assert.match(failed.reason, /out of date: it starts \/old\/place/);
    assert.equal(failed.before, old.command);

    results = await command(a, 'agentBridge.registration.runStartupCheck');
    assert.deepEqual(results.map(r => [r.agent, r.outcome.kind, r.outcome.detail]), [['Claude Code', 'changed', 'updated']]);
    assert.equal(readClaude().mcpServers.vscode.command, launcher);
  } finally {
    await a.close();
  }
});

test('Check and Repair checks end to end, fixes Agent Bridge\'s entries and reports what it cannot fix', async () => {
  const a = await agent({ session: 'repair-3' });
  try {
    await turnedOn(a);
    let report = await command(a, 'agentBridge.repair', { quiet: true });
    assert.equal(report.ok, true, JSON.stringify(report.lines, null, 2));
    const texts = report.lines.map(l => `${l.kind}: ${l.text}`).join('\n');
    assert.match(texts, /ok: The MCP server script is in place/);
    assert.match(texts, /ok: Claude Code: registered and current/);
    assert.match(texts, /ok: Codex: registered and current/);
    assert.match(texts, /ok: Start test: the server answered the MCP handshake and listed \d+ tools, and ended when its input closed/);
    assert.match(texts, /ok: Window test: .*finds this window .*and the window answers/);
    assert.match(texts, /ok: This window is published and listening/);

    // Broken: Codex's entry is gone, Claude's is outdated, and Claude Code has the server turned off in this folder.
    writeFileSync(codexFile, CODEX_BEFORE);
    const ws = join(hostDir, 'ws');
    const claude = readClaude();
    claude.mcpServers.vscode.command = '/somewhere/else/.vscode-agent-bridge/bin/mcp-server';
    claude.projects[ws] = { disabledMcpServers: ['vscode'] };
    writeFileSync(claudeFile, JSON.stringify(claude, null, 2));
    report = await command(a, 'agentBridge.repair', { quiet: true });
    const fixed = report.lines.filter(l => l.kind === 'fixed').map(l => l.text);
    assert.equal(fixed.length, 2, JSON.stringify(report.lines, null, 2));
    assert.match(fixed[0], /^Claude Code: the registered entry is out of date: it starts \/somewhere\/else.*; updated it/);
    assert.match(fixed[1], /^Codex: .*registered it/);
    const problems = report.lines.filter(l => l.kind === 'problem').map(l => l.text);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /turned off in the project .*\/ws: in a Claude Code session there, run \/mcp and enable it/);
    assert.equal(readClaude().mcpServers.vscode.command, launcher);
    assert.match(readCodex(), /\[mcp_servers\.vscode\]/);
    assert.deepEqual(readClaude().projects[ws], { disabledMcpServers: ['vscode'] }, 'the user\'s choice is left alone');
    assert.deepEqual(readHistory().slice(-2).map(r => [r.agent, r.action, r.trigger, r.outcome]), [
      ['Claude Code', 'update', 'repair', 'changed'],
      ['Codex', 'add', 'repair', 'changed'],
    ]);
  } finally {
    await a.close();
  }
});

test('Turn Off removes everything and Check and Repair respects it; Turn On brings it back', async () => {
  const a = await agent({ session: 'repair-4' });
  try {
    await turnedOn(a);
    await answers(a, [null]);
    await command(a, 'agentBridge.unregisterAgents');
    assert.equal(readClaude().mcpServers.vscode, undefined);
    assert.equal(readCodex(), CODEX_BEFORE);
    const report = await command(a, 'agentBridge.repair', { quiet: true });
    const problems = report.lines.filter(l => l.kind === 'problem').map(l => l.text);
    assert.equal(problems.length, 2);
    for (const p of problems) assert.match(p, /not registered, because it was turned off; run "Agent Bridge: Turn On \(Register with Claude Code and Codex\)"/);
    assert.equal(readClaude().mcpServers.vscode, undefined, 'repair does not undo Turn Off');
    assert.deepEqual(await command(a, 'agentBridge.registration.runStartupCheck'), [], 'nor does the startup check');
    assert.deepEqual(readHistory().slice(-2).map(r => [r.action, r.trigger, r.outcome]), [
      ['remove', 'turn-off', 'changed'],
      ['remove', 'turn-off', 'changed'],
    ]);
    await answers(a, [null]);
    const on = await command(a, 'agentBridge.registerAgents');
    assert.deepEqual(on.map(r => r.outcome.kind), ['changed', 'changed']);
    assert.equal(readClaude().mcpServers.vscode.command, launcher);
  } finally {
    await a.close();
  }
});

test('the status report has what is needed to diagnose remotely, and Copy returns it', async () => {
  const a = await agent({ session: 'repair-5' });
  try {
    const report = await command(a, 'agentBridge.showStatus', { show: false });
    assert.match(report, /## Platform\n- OS: .*\n- Extension host runtime: .*\(Node v[\d.]+, Electron [\d.]+\)/);
    assert.match(report, /### Claude Code[\s\S]*Registered command: ".*mcp-server" — exists ✓[\s\S]*Registered env: AGENT_BRIDGE_HOME=/);
    assert.match(report, /Start test \(MCP handshake and tool list, as an agent starts it\): ok ✓\n  answered the MCP handshake/);
    assert.match(report, /Self-test .*: ok ✓\n  runs on .*finds this window .*and the window answers.*process lookup: ps/);
    assert.match(report, /## Recent registration changes\n[\s\S]*- \S+ · Claude Code · add \(turn-on\) → changed: registered\. Why: the user ran "Agent Bridge: Turn On/);
    assert.match(report, /## Last "Agent Bridge: Check and Repair Setup" \(/);
    const copied = await command(a, 'agentBridge.copyStatus', { quiet: true, toClipboard: false });
    assert.match(copied, /^# Agent Bridge status/);
  } finally {
    await a.close();
  }
});

await run();
