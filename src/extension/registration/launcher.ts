// Where the MCP server lives and how agents start it.
//
// Agents' configuration must not point into the extension's install folder: that path changes with
// every extension update, and old folders are deleted. So the extension copies its bundled
// `dist/mcp-server.js` to `<bridge home>/bin/` and writes a launcher there. Agents are registered
// with the launcher, a path that never changes, and every activation refreshes what is behind it.
//
// The launcher runs the script with the runtime of the extension host itself (`process.execPath`
// with ELECTRON_RUN_AS_NODE=1): VS Code's Electron locally, the VS Code server's Node in a WSL or
// SSH window. `node` need not be on the PATH of a VS Code started from the Dock or Start menu.
// Several VS Code builds (Stable, Insiders) may share the bridge home, so the launcher remembers a
// few runtimes and uses the first that still exists, then `node` from the PATH as a last resort.
//
// Windows is different: agents start their servers without a shell and cannot run a .cmd file, so
// they are registered with a runtime directly (`Code.exe` with ELECTRON_RUN_AS_NODE=1). Every VS Code
// build has its own runtime, so an entry naming another build's runtime that is still installed counts
// as current (`alternativeCommands`); otherwise Stable and Insiders would rewrite each other's entry on
// every start. It is rewritten only when the runtime it names is gone.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ensurePrivateDir } from '../../shared/paths';
import { writeFileAtomic } from './files';

/** How an agent starts the MCP server: the stdio command it is registered with. */
export interface ServerSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
  /**
   * Other commands an existing registration may name and still be current: on Windows, the runtimes
   * of other VS Code builds on this machine that ran Copane and are still installed.
   */
  alternativeCommands?: string[];
  /** Compare paths ignoring case and slash direction, as Windows does. */
  windowsPaths?: boolean;
}

/** The path module for `platform`, so Windows paths can be built and tested on any OS. */
export function pathFor(platform: NodeJS.Platform): typeof path.posix {
  return platform === 'win32' ? path.win32 : path.posix;
}

export function samePath(a: string, b: string, windows: boolean): boolean {
  if (!windows) return a === b;
  const norm = (p: string) => path.win32.normalize(p).replace(/[\\/]+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

/** Whether a registered entry starts the server the way `spec` would, and if not, why not. */
export function compareEntry(
  entry: { type?: unknown; command?: unknown; args?: unknown; env?: unknown },
  spec: ServerSpec,
  exists: (file: string) => boolean = fs.existsSync,
): { current: true } | { current: false; reason: string } {
  const windows = !!spec.windowsPaths;
  if (entry.type !== undefined && entry.type !== 'stdio') return { current: false, reason: `it is a "${String(entry.type)}" server, not a stdio command` };
  const command = typeof entry.command === 'string' ? entry.command : '';
  const accepted = [spec.command, ...(spec.alternativeCommands ?? [])];
  if (!accepted.some(c => samePath(c, command, windows))) {
    if (windows && command && !exists(command)) return { current: false, reason: `the runtime it starts no longer exists (${command})` };
    return { current: false, reason: `it starts ${command || '(no command)'} instead of ${spec.command}` };
  }
  const args = Array.isArray(entry.args) ? entry.args.map(String) : [];
  if (args.length !== spec.args.length || args.some((a, i) => !samePath(a, spec.args[i]!, windows))) {
    return { current: false, reason: `its arguments are [${args.join(', ')}] instead of [${spec.args.join(', ')}]` };
  }
  const env = entry.env && typeof entry.env === 'object' ? (entry.env as Record<string, unknown>) : {};
  const want = spec.env;
  const keys = new Set([...Object.keys(env), ...Object.keys(want)]);
  const differing = [...keys].filter(k => String(env[k] ?? '') !== (want[k] ?? '') || !(k in env) !== !(k in want));
  if (differing.length) return { current: false, reason: `its environment differs in ${differing.join(', ')}` };
  return { current: true };
}

export interface LauncherOptions {
  /** `<bridge home>/bin` */
  binDir: string;
  /** The extension's bundled server, `<extension>/dist/mcp-server.js`. */
  sourceScript: string;
  /** Extension version, so an older build in another VS Code does not replace a newer server. */
  version: string;
  /** `process.execPath` of the extension host. */
  runtime: string;
  platform: NodeJS.Platform;
  /** `COPANE_HOME` when it is set (dev hosts, tests): agents must use the same bridge home. */
  bridgeHomeOverride?: string;
}

interface Manifest {
  version: string;
  runtimes: string[];
  updatedAt: string;
}

const MAX_RUNTIMES = 4;

export function scriptPath(binDir: string, platform: NodeJS.Platform = process.platform): string {
  return pathFor(platform).join(binDir, 'mcp-server.js');
}

export function launcherPath(binDir: string, platform: NodeJS.Platform): string {
  return pathFor(platform).join(binDir, platform === 'win32' ? 'mcp-server.cmd' : 'mcp-server');
}

export interface SpecOptions extends Pick<LauncherOptions, 'binDir' | 'runtime' | 'platform' | 'bridgeHomeOverride'> {
  /** Runtimes recorded in the manifest (other VS Code builds using this bridge home). */
  knownRuntimes?: string[];
  exists?: (file: string) => boolean;
}

/** The command agents are registered with. */
export function serverSpec(options: SpecOptions): ServerSpec {
  const env: Record<string, string> = options.bridgeHomeOverride ? { COPANE_HOME: options.bridgeHomeOverride } : {};
  if (options.platform === 'win32') {
    // Agents on Windows start commands without a shell, which cannot run a .cmd file. Register the
    // runtime itself; an entry naming another installed build's runtime stays as it is.
    const exists = options.exists ?? fs.existsSync;
    const alternativeCommands = (options.knownRuntimes ?? []).filter(r => !samePath(r, options.runtime, true) && exists(r));
    return {
      command: options.runtime,
      args: [scriptPath(options.binDir, 'win32')],
      env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
      ...(alternativeCommands.length ? { alternativeCommands } : {}),
      windowsPaths: true,
    };
  }
  return { command: launcherPath(options.binDir, options.platform), args: [], env };
}

export interface InstallResult {
  /** Version of the server script now in the bin folder. */
  version: string;
  scriptUpdated: boolean;
  launcherUpdated: boolean;
  runtimes: string[];
}

/** Installs or refreshes the server script and the launcher. Idempotent; cheap when nothing changed. */
export function installServer(options: LauncherOptions): InstallResult {
  const { binDir, platform } = options;
  ensurePrivateDir(binDir);
  const manifestFile = path.join(binDir, 'manifest.json');
  const manifest = readManifest(manifestFile);
  const script = scriptPath(binDir, platform);
  const source = fs.readFileSync(options.sourceScript, 'utf8');
  const installed = fs.existsSync(script) ? fs.readFileSync(script, 'utf8') : undefined;

  let version = manifest?.version ?? options.version;
  let scriptUpdated = false;
  const newerOrSame = !manifest || !installed || compareVersions(options.version, manifest.version) >= 0;
  if (newerOrSame && installed !== source) {
    writeFileAtomic(script, source, 0o644);
    scriptUpdated = true;
  }
  if (newerOrSame) version = options.version;

  const windows = platform === 'win32';
  const runtimes = [options.runtime, ...(manifest?.runtimes ?? []).filter(r => !samePath(r, options.runtime, windows) && fs.existsSync(r))].slice(0, MAX_RUNTIMES);
  const launcher = launcherPath(binDir, platform);
  const content = platform === 'win32' ? windowsLauncher(runtimes, script) : unixLauncher(runtimes, script);
  let launcherUpdated = false;
  if (readIfExists(launcher) !== content) {
    writeFileAtomic(launcher, content, 0o755);
    launcherUpdated = true;
  }
  if (platform !== 'win32') fs.chmodSync(launcher, 0o755);

  const next: Manifest = { version, runtimes, updatedAt: manifest?.updatedAt ?? new Date().toISOString() };
  if (scriptUpdated || launcherUpdated || !manifest || JSON.stringify(manifest.runtimes) !== JSON.stringify(runtimes)) next.updatedAt = new Date().toISOString();
  if (!manifest || JSON.stringify(manifest) !== JSON.stringify(next)) writeFileAtomic(manifestFile, JSON.stringify(next, null, 2) + '\n', 0o644);
  return { version, scriptUpdated, launcherUpdated, runtimes };
}

export function readInstalledManifest(binDir: string): Manifest | undefined {
  return readManifest(path.join(binDir, 'manifest.json'));
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function unixLauncher(runtimes: string[], script: string): string {
  return [
    '#!/bin/sh',
    '# Starts the Copane MCP server (stdio). Written by the Copane VS Code extension and',
    '# refreshed each time it starts; edits are overwritten. Remove the agent registrations with the',
    '# VS Code command "Copane: Turn Off".',
    `script=${shellQuote(script)}`,
    `for runtime in ${runtimes.map(shellQuote).join(' ')}; do`,
    '  if [ -x "$runtime" ]; then ELECTRON_RUN_AS_NODE=1 exec "$runtime" "$script" "$@"; fi',
    'done',
    'if command -v node >/dev/null 2>&1; then exec node "$script" "$@"; fi',
    'echo "Copane: cannot start the MCP server: the VS Code runtime it used is gone and node is not on the PATH. Open VS Code once with the Copane extension to repair this." >&2',
    'exit 1',
    '',
  ].join('\n');
}

/** For people running the server by hand on Windows; agents are registered with the runtime directly. */
export function windowsLauncher(runtimes: string[], script: string): string {
  const lines = ['@echo off', 'rem Starts the Copane MCP server (stdio). Written by the Copane VS Code extension.', 'setlocal'];
  for (const runtime of runtimes) {
    // `exit /b` without a number keeps the runtime's exit code; `%ERRORLEVEL%` inside the block
    // would be expanded before the runtime runs.
    lines.push(`if exist "${runtime}" (`, '  set ELECTRON_RUN_AS_NODE=1', `  "${runtime}" "${script}" %*`, '  exit /b', ')');
  }
  lines.push(`node "${script}" %*`, '');
  return lines.join('\r\n');
}

/** Compares dotted versions numerically; a pre-release suffix sorts before the release. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [main = '', pre] = v.split('-', 2);
    return { parts: main.split('.').map(n => Number.parseInt(n, 10) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.parts.length, y.parts.length); i++) {
    const d = (x.parts[i] ?? 0) - (y.parts[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === undefined) return 1;
  if (y.pre === undefined) return -1;
  return x.pre < y.pre ? -1 : 1;
}

function readManifest(file: string): Manifest | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof value?.version === 'string' && Array.isArray(value.runtimes)) return value as Manifest;
  } catch {
    // Missing or damaged: rewritten below.
  }
  return undefined;
}

function readIfExists(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}
