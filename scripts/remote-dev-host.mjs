#!/usr/bin/env node
// Starts (or stops) an isolated VS Code whose window is a real remote window: the workspace and this
// extension run in a local Docker container ("attached container", the Dev Containers extension), the
// UI and the integrated browser on this machine. That is the same split as a WSL or SSH window, so it
// is how the remote behaviour of the extension is tested without a remote machine.
//
//   node scripts/remote-dev-host.mjs --name <name> [--image node:24-bookworm] [--no-build]
//   node scripts/remote-dev-host.mjs --name <name> --stop [--rm]
//
// Needs Docker. The Dev Containers extension is installed into this dev host's own extensions folder
// (never into the user's). The working tree is mounted into the container at /copane, so the remote
// extension host loads the extension from there; the workspace is /ws in the container. Inside the
// container COPANE_HOME is /tmp/copane-dev/<name>/home, so scripts/mcp-call.mjs works there:
//
//   docker exec copane-remote-<name> node /copane/scripts/mcp-call.mjs --name <name> --list
//
// "The user's machine" is this one. So that the extension never looks for (or writes into) the real
// home folder here, COPANE_UI_HOME points it at /tmp/copane-dev/<name>/uihome on this machine, a
// throwaway home with a .vscode/argv.json: browser downloads are staged and argv.json is edited there.
//
// --stop closes the dev host; --rm also removes the container.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = name => args.includes(`--${name}`);
const value = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const name = value('name', 'remote');
const image = value('image', 'node:24-bookworm');
const container = `copane-remote-${name}`;
const base = join('/tmp', 'copane-dev', name);
const dirs = { userData: join(base, 'ud'), extensions: join(base, 'ext') };
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const extensionId = `${pkg.publisher}.${pkg.name}`;
const cleanEnv = { ...process.env };
for (const k of ['VSCODE_IPC_HOOK_CLI', 'ELECTRON_RUN_AS_NODE', 'COPANE_INSTANCE', 'VSCODE_PID', 'VSCODE_CWD']) delete cleanEnv[k];
const docker = (...a) => execFileSync('docker', a, { encoding: 'utf8' }).trim();

if (process.platform === 'win32') {
  console.error('remote-dev-host.mjs supports macOS and Linux.');
  process.exit(1);
}

if (flag('stop')) {
  spawnSync('pkill', ['-f', `user-data-dir ${dirs.userData}`]);
  if (flag('rm')) spawnSync('docker', ['rm', '-f', container], { stdio: 'ignore' });
  console.log(`stopped remote dev host "${name}"${flag('rm') ? ` and removed container ${container}` : ''}`);
  process.exit(0);
}

if (!flag('no-build')) execFileSync(process.execPath, ['esbuild.mjs'], { cwd: root, stdio: 'inherit' });

for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
if (!readdirSync(dirs.extensions).some(d => d.startsWith('ms-vscode-remote.remote-containers-'))) {
  execFileSync('code', ['--user-data-dir', dirs.userData, '--extensions-dir', dirs.extensions, '--install-extension', 'ms-vscode-remote.remote-containers'], { env: cleanEnv, stdio: 'inherit' });
}
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
        'window.dialogStyle': 'custom',
        'chat.disableAIFeatures': true,
        'dev.containers.copyGitConfig': false,
        'dev.containers.gitCredentialHelperConfigLocation': 'none',
        'dev.containers.dockerCredentialHelper': false,
        'remote.downloadExtensionsLocally': true,
      },
      null,
      2,
    ),
  );
}

// The throwaway home of "the user" on this machine (see above).
const uiHome = join(base, 'uihome');
mkdirSync(join(uiHome, '.vscode'), { recursive: true });
if (!existsSync(join(uiHome, '.vscode', 'argv.json'))) {
  writeFileSync(join(uiHome, '.vscode', 'argv.json'), '// This configuration file allows you to pass permanent command line arguments to VS Code.\n{\n\t"enable-crash-reporter": false\n}\n');
}

// The container: the working tree at /copane, a workspace at /ws, and sandbox paths for the agent side.
let running = '';
try {
  running = docker('inspect', '-f', '{{.State.Running}}', container);
} catch {
  running = '';
}
if (running !== 'true') {
  spawnSync('docker', ['rm', '-f', container], { stdio: 'ignore' });
  docker(
    'run', '-d', '--name', container,
    '-v', `${root}:/copane`,
    '-e', `COPANE_HOME=${base}/home`,
    '-e', `CLAUDE_CONFIG_DIR=${base}/claude`,
    '-e', `CODEX_HOME=${base}/codex`,
    '-e', `COPILOT_HOME=${base}/copilot`,
    '-e', `COPANE_UI_HOME=${uiHome}`,
    image, 'sleep', 'infinity',
  );
  docker('exec', container, 'sh', '-c', `mkdir -p /ws ${base}/ws && echo "remote dev host workspace" > /ws/README.txt`);
}

const authority = `attached-container+${Buffer.from(JSON.stringify({ containerName: `/${container}` }), 'utf8').toString('hex')}`;
const uiPortFile = join(base, 'ui-port');
rmSync(uiPortFile, { force: true });
const uiPort = await new Promise(resolve => {
  const probe = createServer().listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});
writeFileSync(uiPortFile, String(uiPort));
const codeArgs = [
  '--user-data-dir', dirs.userData,
  '--extensions-dir', dirs.extensions,
  `--extensionDevelopmentPath=vscode-remote://${authority}/copane`,
  `--enable-proposed-api=${extensionId}`,
  `--remote-debugging-port=${uiPort}`,
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--new-window',
  '--folder-uri', `vscode-remote://${authority}/ws`,
];
const app = execFileSync('sh', ['-c', 'dirname "$(dirname "$(dirname "$(dirname "$(dirname "$(readlink -f "$(command -v code)")")")")")"'], { encoding: 'utf8' }).trim();
if (process.platform === 'darwin') {
  spawn('open', ['-g', '-n', '-a', app, '--args', ...codeArgs], { env: cleanEnv, stdio: 'ignore', detached: true }).unref();
} else {
  spawn('code', codeArgs, { env: cleanEnv, stdio: 'ignore', detached: true }).unref();
}

// Dev Containers asks once whether to trust attaching to a container; answer it in the dev host's own
// workbench (through its DevTools port, as scripts/ui.mjs does), never with desktop automation.
const acceptAttachWarning = async () => {
  try {
    execFileSync(process.execPath, [join(root, 'scripts/ui.mjs'), '--name', name, 'eval', '(() => { const b = [...document.querySelectorAll(".monaco-dialog-box .monaco-button")].find(b => b.textContent.trim() === "Got It"); if (b) b.click(); return !!b; })()'], { stdio: 'ignore', timeout: 10_000 });
  } catch {
    // The window is not up yet.
  }
};

// The extension publishes its window inside the container once the remote extension host is up
// (the first start installs the VS Code server in the container, which takes a while).
const deadline = Date.now() + 180_000;
let found = [];
while (Date.now() < deadline) {
  try {
    found = docker('exec', container, 'sh', '-c', `ls ${base}/home/instances 2>/dev/null || true`).split('\n').filter(f => f.endsWith('.json'));
  } catch {
    found = [];
  }
  if (found.length) break;
  await acceptAttachWarning();
  await new Promise(r => setTimeout(r, 1000));
}
console.log(`remote dev host "${name}" (container ${container}, ${image})`);
console.log(`  UI inspection: node scripts/ui.mjs --name ${name} shot|eval|text`);
console.log(`  tools: docker exec ${container} node /copane/scripts/mcp-call.mjs --name ${name} --list`);
if (!found.length) {
  console.error('the extension did not publish its window in the container within 180 s; look at the dev host window (node scripts/ui.mjs shot)');
  process.exit(1);
}
console.log(`  window ${found[0].replace(/\.json$/, '')} in the container`);
