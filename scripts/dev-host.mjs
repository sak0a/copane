#!/usr/bin/env node
// Starts (or stops) an isolated VS Code with this extension loaded from the working tree. It uses its
// own user-data dir, extensions dir and bridge home, so the user's real VS Code, settings and agent
// configuration are never touched, and several dev hosts (one per --name) can run side by side.
//
//   node scripts/dev-host.mjs --name <name> [--folder <dir>] [--no-build] [--no-proposed] [--no-ui-port] [--foreground]
//   node scripts/dev-host.mjs --name <name> --stop
//
// --folder may be repeated to open several windows. On macOS the windows open in the background
// (they do not take focus) unless --foreground. Prints the bridge home and live instances.
// The workbench UI is inspectable through scripts/ui.mjs (screenshots, DOM) unless --no-ui-port.
// State (open tabs, terminals) persists per name; delete /tmp/agent-bridge-dev/<name> for a clean start.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = name => args.includes(`--${name}`);
const values = name => args.flatMap((a, i) => (a === `--${name}` && args[i + 1] ? [args[i + 1]] : []));

const name = values('name')[0] ?? 'dev';
// Short path on purpose: unix socket paths are limited to ~104 bytes.
const base = join(process.platform === 'win32' ? process.env.TEMP : '/tmp', 'agent-bridge-dev', name);
const dirs = { userData: join(base, 'ud'), extensions: join(base, 'ext'), home: join(base, 'home'), workspace: join(base, 'ws') };
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const extensionId = `${pkg.publisher}.${pkg.name}`;

function stop() {
  if (process.platform === 'win32') return console.log('Close the dev host window manually on Windows.');
  spawnSync('pkill', ['-f', `user-data-dir ${dirs.userData}`]);
}

if (flag('stop')) {
  stop();
  console.log(`stopped dev host "${name}"`);
  process.exit(0);
}

if (!flag('no-build')) execFileSync(process.execPath, ['esbuild.mjs'], { cwd: root, stdio: 'inherit' });

for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
const settingsFile = join(dirs.userData, 'User', 'settings.json');
if (!existsSync(settingsFile)) {
  mkdirSync(dirname(settingsFile), { recursive: true });
  writeFileSync(
    settingsFile,
    JSON.stringify(
      {
        'workbench.startupEditor': 'none',
        'security.workspace.trust.enabled': false,
        'telemetry.telemetryLevel': 'off',
        'update.mode': 'none',
        'extensions.autoUpdate': false,
        'window.restoreWindows': 'none',
        // Native macOS sheets cannot be seen or answered through scripts/ui.mjs; custom dialogs are in the DOM.
        'window.dialogStyle': 'custom',
        // No Copilot sign-in dialog on first start (it covers the window in screenshots), no chat panel.
        'chat.disableAIFeatures': true,
      },
      null,
      2,
    ),
  );
}

const folders = values('folder').length ? values('folder') : [dirs.workspace];

// A Chrome DevTools port on the workbench itself, so its UI can be inspected without desktop automation.
const uiPortFile = join(base, 'ui-port');
rmSync(uiPortFile, { force: true });
let uiPort;
if (!flag('no-ui-port')) {
  uiPort = await new Promise(resolve => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
  writeFileSync(uiPortFile, String(uiPort));
}
const env = { ...process.env, AGENT_BRIDGE_HOME: dirs.home };
// Variables that would make `code` talk to the VS Code this script was started from.
for (const k of ['VSCODE_IPC_HOOK_CLI', 'ELECTRON_RUN_AS_NODE', 'AGENT_BRIDGE_INSTANCE', 'VSCODE_PID', 'VSCODE_CWD']) delete env[k];

// macOS: VS Code activates itself when a window opens, even when started in the background. Remember
// who had focus and give it back, so a dev host never interrupts whoever is working on this machine.
const frontmost = () => {
  if (process.platform !== 'darwin' || flag('foreground')) return undefined;
  try {
    return execFileSync('osascript', ['-e', 'tell application "System Events" to get unix id of first application process whose frontmost is true'], { encoding: 'utf8', timeout: 5000 }).trim();
  } catch {
    return undefined;
  }
};
const previousFront = frontmost();
const restoreFocus = () => {
  const now = frontmost();
  if (!previousFront || !now || now === previousFront) return;
  spawnSync('osascript', ['-e', `tell application "System Events" to set frontmost of (first application process whose unix id is ${previousFront}) to true`], { timeout: 5000 });
};

for (const folder of folders) {
  mkdirSync(folder, { recursive: true });
  const codeArgs = [
    '--user-data-dir', dirs.userData,
    '--extensions-dir', dirs.extensions,
    `--extensionDevelopmentPath=${root}`,
    ...(flag('no-proposed') ? [] : [`--enable-proposed-api=${extensionId}`]),
    ...(uiPort ? [`--remote-debugging-port=${uiPort}`] : []),
    '--new-window',
    folder,
  ];
  if (process.platform === 'darwin' && !flag('foreground')) {
    // `open -g` starts the window in the background, so it does not take focus from whoever is working.
    const app = execFileSync('sh', ['-c', 'dirname "$(dirname "$(dirname "$(dirname "$(dirname "$(readlink -f "$(command -v code)" 2>/dev/null || python3 -c "import os,sys;print(os.path.realpath(sys.argv[1]))" "$(command -v code)")")")")")"'], { encoding: 'utf8' }).trim();
    spawn('open', ['-g', '-n', '-a', app, '--env', `AGENT_BRIDGE_HOME=${dirs.home}`, '--args', ...codeArgs], { env, stdio: 'ignore', detached: true }).unref();
  } else {
    spawn('code', codeArgs, { env, stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref();
  }
  for (let i = 0; i < 5; i++) {
    await new Promise(r => setTimeout(r, 500));
    restoreFocus();
  }
}

const instances = join(dirs.home, 'instances');
const deadline = Date.now() + 45_000;
let found = [];
while (Date.now() < deadline) {
  found = existsSync(instances) ? readdirSync(instances).filter(f => f.endsWith('.json')) : [];
  if (found.length >= folders.length) break;
  await new Promise(r => setTimeout(r, 500));
  restoreFocus();
}
restoreFocus();
console.log(`dev host "${name}"`);
console.log(`  AGENT_BRIDGE_HOME=${dirs.home}`);
if (uiPort) console.log(`  UI inspection: node scripts/ui.mjs --name ${name} shot|eval|text`);
for (const f of found) {
  const i = JSON.parse(readFileSync(join(instances, f), 'utf8'));
  console.log(`  window ${i.id}: ${i.workspaceFolders.join(', ') || '(no folder)'}`);
}
if (found.length < folders.length) {
  console.error(`only ${found.length} of ${folders.length} windows registered within 45 s; check "Agent Bridge" in the Output panel`);
  process.exit(1);
}
