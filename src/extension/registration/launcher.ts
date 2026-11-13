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
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ensurePrivateDir } from '../../shared/paths';
import { writeFileAtomic } from './files';

/** How an agent starts the MCP server: the stdio command it is registered with. */
export interface ServerSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
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
  /** `AGENT_BRIDGE_HOME` when it is set (dev hosts, tests): agents must use the same bridge home. */
  bridgeHomeOverride?: string;
}

interface Manifest {
  version: string;
  runtimes: string[];
  updatedAt: string;
}

const MAX_RUNTIMES = 4;

export function scriptPath(binDir: string): string {
  return path.join(binDir, 'mcp-server.js');
}

export function launcherPath(binDir: string, platform: NodeJS.Platform): string {
  return path.join(binDir, platform === 'win32' ? 'mcp-server.cmd' : 'mcp-server');
}

/** The command agents are registered with. */
export function serverSpec(options: Pick<LauncherOptions, 'binDir' | 'runtime' | 'platform' | 'bridgeHomeOverride'>): ServerSpec {
  const env: Record<string, string> = options.bridgeHomeOverride ? { AGENT_BRIDGE_HOME: options.bridgeHomeOverride } : {};
  if (options.platform === 'win32') {
    // Agents on Windows start commands without a shell, which cannot run a .cmd file. Register the
    // runtime itself; activation re-registers when VS Code's install path changes.
    return { command: options.runtime, args: [scriptPath(options.binDir)], env: { ...env, ELECTRON_RUN_AS_NODE: '1' } };
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
  const script = scriptPath(binDir);
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

  const runtimes = [options.runtime, ...(manifest?.runtimes ?? []).filter(r => r !== options.runtime && fs.existsSync(r))].slice(0, MAX_RUNTIMES);
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
    '# Starts the Agent Bridge MCP server (stdio). Written by the Agent Bridge VS Code extension and',
    '# refreshed each time it starts; edits are overwritten. Remove the agent registrations with the',
    '# VS Code command "Agent Bridge: Unregister from Claude Code and Codex".',
    `script=${shellQuote(script)}`,
    `for runtime in ${runtimes.map(shellQuote).join(' ')}; do`,
    '  if [ -x "$runtime" ]; then ELECTRON_RUN_AS_NODE=1 exec "$runtime" "$script" "$@"; fi',
    'done',
    'if command -v node >/dev/null 2>&1; then exec node "$script" "$@"; fi',
    'echo "Agent Bridge: cannot start the MCP server: the VS Code runtime it used is gone and node is not on the PATH. Open VS Code once with the Agent Bridge extension to repair this." >&2',
    'exit 1',
    '',
  ].join('\n');
}

/** For people running the server by hand on Windows; agents are registered with the runtime directly. */
export function windowsLauncher(runtimes: string[], script: string): string {
  const lines = ['@echo off', 'rem Starts the Agent Bridge MCP server (stdio). Written by the Agent Bridge VS Code extension.', 'setlocal'];
  for (const runtime of runtimes) {
    lines.push(`if exist "${runtime}" (`, '  set ELECTRON_RUN_AS_NODE=1', `  "${runtime}" "${script}" %*`, '  exit /b %ERRORLEVEL%', ')');
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
