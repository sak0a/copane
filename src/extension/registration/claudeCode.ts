// Registration with Claude Code: a user-scope MCP server named "vscode" in Claude Code's global
// config file (`~/.claude.json`, or `$CLAUDE_CONFIG_DIR/.claude.json`). User scope is what both the
// `claude` CLI and the Claude Code VS Code extension load in every project: the extension starts its
// sessions with `settingSources: ["user", "project", "local"]` and no `--strict-mcp-config`.
//
// Claude Code rewrites that file constantly (history, project state) and guards it with a lock
// (`<file>.lock`, proper-lockfile). Changes therefore go through Claude Code's own
// `claude mcp add-json/remove --scope user` when a `claude` executable can be found, which takes
// the lock and merges with the current file. Without one, the file is edited directly under the
// same lock, atomically, touching only `mcpServers.vscode`. Reading is always direct.
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser';
import { MCP_SERVER_NAME } from '../../shared/protocol';
import { readTextIfExists, withFileLock, writeFileAtomic } from './files';
import type { ServerSpec } from './launcher';

export interface ClaudeTarget {
  /** The config file, e.g. `~/.claude.json`. */
  configFile: string;
  /** CLAUDE_CONFIG_DIR to pass to the CLI, when the config lives there. */
  configDir: string | undefined;
  /** A `claude` executable to make changes with; undefined to edit the file directly. */
  cli: string | undefined;
}

/** Where Claude Code keeps its global config, following CLAUDE_CONFIG_DIR like Claude Code does. */
export function claudeConfigFile(env: NodeJS.ProcessEnv, home: string): { configFile: string; configDir: string | undefined } {
  const dir = env.CLAUDE_CONFIG_DIR?.trim();
  return dir ? { configFile: path.join(dir, '.claude.json'), configDir: dir } : { configFile: path.join(home, '.claude.json'), configDir: undefined };
}

/**
 * Finds a `claude` executable: the PATH, the native installer's locations, then any extra
 * candidates (the binary bundled with the Claude Code VS Code extension).
 */
export function findClaudeCli(env: NodeJS.ProcessEnv, home: string, platform: NodeJS.Platform, extra: string[] = []): string | undefined {
  const exe = platform === 'win32' ? 'claude.exe' : 'claude';
  const pathDirs = (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  const candidates = [
    ...pathDirs.map(d => path.join(d, exe)),
    path.join(home, '.local', 'bin', exe),
    path.join(home, '.claude', 'local', exe),
    ...extra,
  ];
  return candidates.find(c => isExecutable(c, platform));
}

function isExecutable(file: string, platform: NodeJS.Platform): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false;
    if (platform !== 'win32') fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export interface ClaudeEntry {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  [key: string]: unknown;
}

export type EntryState =
  /** No server of that name. */
  | { kind: 'absent' }
  /** Registered by Agent Bridge; `current` when it matches what would be registered now. */
  | { kind: 'ours'; current: boolean; command: string }
  /** A different server the user configured under the same name. Never changed without asking. */
  | { kind: 'foreign'; command: string }
  /** The config file cannot be read or parsed; nothing is changed. */
  | { kind: 'unreadable'; error: string };

export interface ClaudeInspection {
  configExists: boolean;
  state: EntryState;
  /** Projects whose local-scope config has its own "vscode" server, which wins over user scope there. */
  overriddenIn: Array<{ project: string; ours: boolean }>;
}

/** Recognises a registration made by Agent Bridge, from any version or bridge home. */
export function isOurEntry(entry: { command?: unknown; args?: unknown }): boolean {
  const parts = [entry.command, ...(Array.isArray(entry.args) ? entry.args : [])].filter(p => typeof p === 'string').join(' ');
  return /agent-bridge/i.test(parts) && /mcp-server/i.test(parts);
}

export function entryFor(spec: ServerSpec): ClaudeEntry {
  return { type: 'stdio', command: spec.command, args: spec.args, env: spec.env };
}

export function matchesSpec(entry: ClaudeEntry, spec: ServerSpec): boolean {
  return (
    entry.command === spec.command &&
    JSON.stringify(entry.args ?? []) === JSON.stringify(spec.args) &&
    JSON.stringify(sortKeys(entry.env ?? {})) === JSON.stringify(sortKeys(spec.env)) &&
    (entry.type === undefined || entry.type === 'stdio')
  );
}

function sortKeys(o: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
}

function describeCommand(entry: ClaudeEntry): string {
  if (typeof entry.command === 'string') return [entry.command, ...(entry.args ?? [])].join(' ');
  if (typeof entry.url === 'string') return String(entry.url);
  return JSON.stringify(entry);
}

export function stateOf(entry: unknown, spec: ServerSpec): EntryState {
  if (entry === undefined || entry === null) return { kind: 'absent' };
  if (typeof entry !== 'object') return { kind: 'foreign', command: JSON.stringify(entry) };
  const e = entry as ClaudeEntry;
  if (isOurEntry(e)) return { kind: 'ours', current: matchesSpec(e, spec), command: describeCommand(e) };
  return { kind: 'foreign', command: describeCommand(e) };
}

export function inspectClaude(configFile: string, spec: ServerSpec): ClaudeInspection {
  let text: string | undefined;
  try {
    text = readTextIfExists(configFile);
  } catch (err) {
    return { configExists: true, state: { kind: 'unreadable', error: String(err) }, overriddenIn: [] };
  }
  if (text === undefined) return { configExists: false, state: { kind: 'absent' }, overriddenIn: [] };
  const errors: ParseError[] = [];
  const config = parse(text, errors, { allowTrailingComma: true });
  if (errors.length > 0 || !config || typeof config !== 'object') {
    return { configExists: true, state: { kind: 'unreadable', error: `${configFile} is not valid JSON` }, overriddenIn: [] };
  }
  const overriddenIn: ClaudeInspection['overriddenIn'] = [];
  for (const [project, value] of Object.entries((config.projects ?? {}) as Record<string, any>)) {
    const local = value?.mcpServers?.[MCP_SERVER_NAME];
    if (local) overriddenIn.push({ project, ours: isOurEntry(local) });
  }
  return { configExists: true, state: stateOf(config.mcpServers?.[MCP_SERVER_NAME], spec), overriddenIn };
}

export type ChangeOutcome =
  | { kind: 'unchanged'; detail: string }
  | { kind: 'changed'; detail: string; via: 'cli' | 'file' }
  | { kind: 'conflict'; detail: string }
  | { kind: 'failed'; detail: string };

/**
 * Registers the server. Leaves another server of the same name alone unless `replaceForeign`.
 * Idempotent: does nothing when the current registration already matches.
 */
export async function registerClaude(target: ClaudeTarget, spec: ServerSpec, options: { replaceForeign?: boolean } = {}): Promise<ChangeOutcome> {
  const before = inspectClaude(target.configFile, spec).state;
  if (before.kind === 'unreadable') return { kind: 'failed', detail: before.error };
  if (before.kind === 'ours' && before.current) return { kind: 'unchanged', detail: 'already registered' };
  if (before.kind === 'foreign' && !options.replaceForeign) {
    return { kind: 'conflict', detail: `another server named "${MCP_SERVER_NAME}" is configured (${before.command})` };
  }
  let via: 'cli' | 'file' = 'file';
  let cliError: string | undefined;
  if (target.cli) {
    try {
      if (before.kind !== 'absent') await runClaude(target, ['mcp', 'remove', '--scope', 'user', MCP_SERVER_NAME]);
      await runClaude(target, ['mcp', 'add-json', '--scope', 'user', MCP_SERVER_NAME, JSON.stringify(entryFor(spec))]);
      via = 'cli';
    } catch (err) {
      cliError = err instanceof Error ? err.message : String(err);
    }
  }
  if (via === 'file') {
    try {
      await editConfig(target.configFile, config => modify(config, ['mcpServers', MCP_SERVER_NAME], entryFor(spec), FORMAT));
    } catch (err) {
      return { kind: 'failed', detail: `${err instanceof Error ? err.message : String(err)}${cliError ? ` (the claude CLI also failed: ${cliError})` : ''}` };
    }
  }
  const after = inspectClaude(target.configFile, spec).state;
  if (after.kind !== 'ours' || !after.current) return { kind: 'failed', detail: `the change did not stick in ${target.configFile}` };
  const detail = before.kind === 'absent' ? 'registered' : 'updated';
  return { kind: 'changed', detail: cliError ? `${detail} (edited the file; the claude CLI failed: ${cliError})` : detail, via };
}

/** Removes the server if it is Agent Bridge's. Never removes someone else's server of that name. */
export async function unregisterClaude(target: ClaudeTarget, spec: ServerSpec): Promise<ChangeOutcome> {
  const before = inspectClaude(target.configFile, spec).state;
  if (before.kind === 'unreadable') return { kind: 'failed', detail: before.error };
  if (before.kind === 'absent') return { kind: 'unchanged', detail: 'not registered' };
  if (before.kind === 'foreign') return { kind: 'conflict', detail: `the "${MCP_SERVER_NAME}" server there is not Agent Bridge's (${before.command}); left it alone` };
  let via: 'cli' | 'file' = 'file';
  if (target.cli) {
    try {
      await runClaude(target, ['mcp', 'remove', '--scope', 'user', MCP_SERVER_NAME]);
      via = 'cli';
    } catch {
      // Fall back to editing the file.
    }
  }
  if (via === 'file') {
    try {
      await editConfig(target.configFile, config => modify(config, ['mcpServers', MCP_SERVER_NAME], undefined, FORMAT));
    } catch (err) {
      return { kind: 'failed', detail: err instanceof Error ? err.message : String(err) };
    }
  }
  if (inspectClaude(target.configFile, spec).state.kind !== 'absent') return { kind: 'failed', detail: `the entry is still in ${target.configFile}` };
  return { kind: 'changed', detail: 'removed', via };
}

const FORMAT = { formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' } };

/** Read-modify-write of the config file under Claude Code's lock, replaced atomically. */
async function editConfig(file: string, edits: (text: string) => ReturnType<typeof modify>): Promise<void> {
  await withFileLock(file, () => {
    const text = readTextIfExists(file) ?? '{}\n';
    const errors: ParseError[] = [];
    parse(text, errors, { allowTrailingComma: true });
    if (errors.length > 0) throw new Error(`${file} is not valid JSON; not changing it`);
    const next = applyEdits(text, edits(text));
    if (next !== text) writeFileAtomic(file, next.endsWith('\n') ? next : `${next}\n`, 0o600);
  });
}

function existingDir(dir: string): string {
  for (let d = dir; ; d = path.dirname(d)) {
    if (fs.existsSync(d)) return d;
    if (path.dirname(d) === d) return d;
  }
}

function runClaude(target: ClaudeTarget, args: string[]): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  if (target.configDir) env.CLAUDE_CONFIG_DIR = target.configDir;
  return new Promise((resolve, reject) => {
    execFile(
      target.cli!,
      args,
      // The config folder may not exist yet; any existing folder will do as the working directory.
      { env, cwd: existingDir(path.dirname(target.configFile)), timeout: 60_000, windowsHide: true, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`claude ${args.slice(0, 2).join(' ')} failed: ${(stderr || stdout || err.message).trim().split('\n')[0]}`));
        else resolve(stdout);
      },
    );
  });
}
