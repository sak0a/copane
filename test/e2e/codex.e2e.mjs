// Codex end to end. The first cases are free and always run: what Copane does for a Codex session
// (label, window matching with a resolved working directory, the registered entry as Codex reads it).
// The last cases start real `codex exec` runs, which spend the Codex subscription's quota (two short
// runs), so they run only with COPANE_E2E_CODEX=1.
//
//   node scripts/dev-host.mjs --name codex
//   node test/e2e/codex.e2e.mjs --name codex
//   COPANE_E2E_CODEX=1 node test/e2e/codex.e2e.mjs --name codex
//
// The real runs use a throwaway CODEX_HOME under /tmp/copane-dev/<name>/codex-e2e with the entry the
// extension registered and a copy of Codex's login (auth.json, read from $COPANE_E2E_CODEX_AUTH or
// ~/.codex/auth.json and never written back). The real ~/.codex is not changed.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { startFixtureServer } from '../fixtures/pages/server.mjs';
import { agent, assert, hostDir, run, test } from './harness.mjs';

const codexDir = join(hostDir, 'codex');
const e2eHome = join(hostDir, 'codex-e2e');
const workspace = join(hostDir, 'ws');
const real = process.env.COPANE_E2E_CODEX === '1';

function available(cli) {
  return spawnSync(process.platform === 'win32' ? 'where' : 'which', [cli], { encoding: 'utf8' }).status === 0;
}

/** Environment for the real codex CLI: throwaway home, none of this agent's own session variables. */
function codexEnv(home) {
  const env = { ...process.env, CODEX_HOME: home };
  for (const k of ['COPANE_INSTANCE', 'COPANE_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDECODE']) delete env[k];
  return env;
}

async function command(a, id, ...args) {
  const text = await a.ok('debug_vscode_command', { command: id, args });
  return text === 'ok' ? undefined : JSON.parse(text);
}

test('a Codex client gets a "Codex" session label and color', async () => {
  // Codex 0.16x introduces itself as "codex-mcp-client" (title "Codex").
  const a = await agent({ client: 'codex-mcp-client' });
  try {
    const info = JSON.parse(/^\{[\s\S]*?\n\}/.exec(await a.ok('session_info'))[0]);
    assert.match(info.you?.label ?? '', /^Codex \d+$/);
    assert.ok(info.you.color, 'has a color');
  } finally {
    await a.close();
  }
});

test('a resolved working directory (as Codex passes it) still finds the window by its folder', async () => {
  const resolved = realpathSync(workspace);
  if (resolved === workspace) {
    console.log(`      (${workspace} is not behind a symbolic link here: nothing to check)`);
    return;
  }
  const a = await agent({ client: 'codex-mcp-client', cwd: resolved });
  try {
    const status = await a.ok('window_status');
    assert.match(status, /the working directory is inside its workspace/, status);
  } finally {
    await a.close();
  }
});

test('Codex reads the registered entry: command, pass-through variables, tool timeout', async () => {
  if (!available('codex')) return console.log('      (codex not installed: skipped)');
  const a = await agent();
  try {
    await command(a, 'copane.registerAgents');
  } finally {
    await a.close();
  }
  const listed = JSON.parse(execFileSync('codex', ['mcp', 'list', '--json'], { env: codexEnv(codexDir), encoding: 'utf8', timeout: 30_000 }));
  const ours = listed.find(s => s.name === 'copane');
  assert.ok(ours, 'codex lists the copane server');
  assert.deepEqual(ours.transport.env_vars, ['COPANE_INSTANCE', 'COPANE_SESSION']);
  assert.equal(ours.tool_timeout_sec, 600);
});

/**
 * Runs `codex exec --json` in the workspace and returns its events. Asynchronous on purpose: the
 * fixture pages are served by this process, which must keep answering while Codex runs.
 */
function codexExec(prompt, extraArgs = []) {
  return new Promise((resolve, reject) => {
    const child = spawn('codex', ['exec', '--skip-git-repo-check', '-s', 'read-only', '--json', ...extraArgs, prompt], {
      env: codexEnv(e2eHome),
      cwd: workspace,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => (stdout += d));
    child.stderr.on('data', d => (stderr += d));
    const timer = setTimeout(() => child.kill(), 300_000);
    child.on('close', () => {
      clearTimeout(timer);
      writeFileSync(join(e2eHome, 'last-run.jsonl'), stdout); // For diagnosing a failure.
      const events = stdout.split('\n').filter(Boolean).map(l => JSON.parse(l));
      if (!events.some(e => e.type === 'turn.completed')) return reject(new Error(`codex exec did not complete: ${stderr.slice(-1500)}`));
      const calls = events.filter(e => e.type === 'item.completed' && e.item?.type === 'mcp_tool_call').map(e => e.item);
      resolve({ events, calls, call: tool => calls.find(c => c.tool === tool) });
    });
  });
}

function prepareCodexHome() {
  rmSync(e2eHome, { recursive: true, force: true });
  mkdirSync(e2eHome, { recursive: true });
  // The entry exactly as the extension wrote it for this dev host.
  const config = readFileSync(join(codexDir, 'config.toml'), 'utf8');
  const start = config.indexOf('[mcp_servers.copane]');
  assert.ok(start >= 0, 'the dev host has registered copane with Codex');
  writeFileSync(join(e2eHome, 'config.toml'), config.slice(config.lastIndexOf('\n#', start) + 1));
  const auth = process.env.COPANE_E2E_CODEX_AUTH || join(homedir(), '.codex', 'auth.json');
  assert.ok(existsSync(auth), `no Codex login at ${auth}; log in with codex, or set COPANE_E2E_CODEX_AUTH`);
  copyFileSync(auth, join(e2eHome, 'auth.json'));
  chmodSync(join(e2eHome, 'auth.json'), 0o600);
}

test('real Codex session: tools work, images and long results come through, Codex sandbox does not cover Copane terminals', async () => {
  if (!real) return console.log('      (set COPANE_E2E_CODEX=1 to run real codex exec sessions; they use the Codex quota)');
  if (!available('codex')) throw new Error('codex is not installed');
  prepareCodexHome();
  const site = await startFixtureServer();
  const marker = join(hostDir, 'codex-e2e-marker.txt');
  rmSync(marker, { force: true });
  try {
    const run = await codexExec(
      `Use only the copane MCP tools, nothing else. 1) session_info. 2) browser_open ${site.url}/long.html, then browser_screenshot. ` +
        `3) browser_snapshot with maxChars 60000 and tell me the last line of its result. 4) terminal_run: echo codex-was-here > ${marker}. ` +
        '5) browser_release_tab. Then reply with your session label only.',
      ['-c', 'mcp_servers.copane.default_tools_approval_mode="approve"'],
    );
    const label = JSON.parse(run.call('session_info').result.content[0].text).you.label;
    assert.match(label, /^Codex \d+$/);
    const shot = run.call('browser_screenshot');
    const shotSummary = JSON.stringify(shot?.result?.content?.map(c => ({ type: c.type, size: (c.data ?? c.text ?? '').length })) ?? shot?.error);
    assert.ok(shot?.result?.content.some(c => c.type === 'image' && c.data.length > 1000), `the screenshot reached Codex as an image: ${shotSummary}`);
    const snapshot = run.call('browser_snapshot')?.result?.content[0]?.text ?? '';
    assert.ok(snapshot.length > 20_000, `a long snapshot came through whole (${snapshot.length} chars)`);
    // Codex ran with a read-only sandbox, yet the command wrote a file: Copane's terminals are VS Code's,
    // outside Codex's sandbox. Codex's approval of the tool call is the control that applies.
    assert.equal(readFileSync(marker, 'utf8').trim(), 'codex-was-here');
  } finally {
    await site.close();
    rmSync(marker, { force: true });
  }
});

test('real Codex session: tools that change something need approval, read-only ones do not', async () => {
  if (!real) return console.log('      (set COPANE_E2E_CODEX=1 to run real codex exec sessions; they use the Codex quota)');
  if (!existsSync(join(e2eHome, 'auth.json'))) prepareCodexHome();
  // `codex exec` never asks, so a call that needs approval fails instead of prompting.
  const run = await codexExec('Call the copane tool window_status, then the copane tool browser_open with url about:blank. Report each result in one line.');
  assert.equal(run.call('window_status')?.status, 'completed');
  const opened = run.call('browser_open');
  assert.equal(opened?.status, 'failed');
  assert.match(opened?.error?.message ?? '', /requires approval/);
});

await run();
