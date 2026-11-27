// Registration with GitHub Copilot: the "copane" entry in `~/.copilot/mcp-config.json` (or
// `$COPILOT_HOME/mcp-config.json`). The Copilot CLI reads that file, and so do Copilot chat sessions
// in VS Code that run on the Copilot harness (VS Code's docs: "Copilot harness sessions read the
// GitHub Copilot CLI MCP configuration independently"), so one entry covers both.
//
// The file is edited directly, as JSONC, touching only `mcpServers.copane`: comments, unknown keys
// and other servers stay. `copilot mcp add` would rewrite the whole file without its comments
// (checked with Copilot CLI 1.0.105), has no "replace", and starting the CLI may update itself.
// Unlike Claude Code, Copilot does not rewrite this file while it runs: only its `mcp add/remove`
// commands write it. They hold `.mcp-writer.lock` next to it, an empty file locked by the operating
// system that Node cannot take part in; Copane instead reads, edits and replaces the file atomically
// in one synchronous step and checks the result, so a concurrent `copilot mcp add` can at worst win
// the race, which the next check repairs.
//
// Local servers get only PATH from the environment (GitHub's docs), so the entry passes the variables
// a terminal sets for finding the window as references, `${COPANE_INSTANCE:-}`: Copilot resolves them
// from its own environment, and to an empty string when unset (which the MCP server treats as unset).
// `COPILOT_SESSION_CWD` (Copilot CLI 1.0.107: "for launching and expanding LSP and local MCP server
// configs") is passed the same way: the folder the Copilot session works in, which is how the server
// finds the right window when Copilot does not start it from that folder (the Copilot harness in
// VS Code starts servers from a host shared by all windows). Older CLIs resolve it to nothing.
//
// The entry sets `timeout`: Copilot stops a tool call after 30 s by its documentation (3 minutes
// by its changelog) unless the server's entry says otherwise, and terminal commands, page waits
// and hand-offs to the user take longer. A timeout the user chose is kept.
//
// Keys the user may change, or that Copilot adds, do not make the entry out of date and are kept on
// update: `tools` (a filter of the tools the model sees), the value of `timeout`, `cwd`, and the
// default part of the references.
import * as path from 'node:path';
import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser';
import { MCP_SERVER_NAME } from '../../shared/protocol';
import { isOurEntry, registeredCommand, type ChangeOutcome, type EntryState } from './claudeCode';
import { readTextIfExists, writeFileAtomic } from './files';
import { compareEntry, type ServerSpec } from './launcher';

/** Where Copilot keeps its configuration: `$COPILOT_HOME`, else `~/.copilot`. */
export function copilotHome(env: NodeJS.ProcessEnv, home: string): string {
  return env.COPILOT_HOME?.trim() || path.join(home, '.copilot');
}

export function copilotConfigFile(env: NodeJS.ProcessEnv, home: string): string {
  return path.join(copilotHome(env, home), 'mcp-config.json');
}

/** Where `copilot mcp disable` records turned-off servers (`disabledMcpServers`). */
export function copilotSettingsFile(env: NodeJS.ProcessEnv, home: string): string {
  return path.join(copilotHome(env, home), 'settings.json');
}

/**
 * Variables Copilot must pass through so the server finds its window: the window of the terminal it
 * runs in, and the folder the Copilot session works in.
 */
export const PASS_THROUGH = ['COPANE_INSTANCE', 'COPANE_SESSION', 'COPILOT_SESSION_CWD'] as const;

/** Per-call time limit in the entry, as for Codex (`tool_timeout_sec`): the longest default wait of a tool. */
export const TOOL_TIMEOUT_MS = 600_000;

const reference = (name: string) => `\${${name}:-}`;
/** `${NAME}` or `${NAME:-default}`: the variable is passed through, whatever the default. */
const isReferenceTo = (value: unknown, name: string) => typeof value === 'string' && new RegExp(`^\\$\\{${name}(:-[^}]*)?\\}$`).test(value);

export interface CopilotEntry {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  tools?: string[];
  /** Milliseconds, for tool discovery and tool calls. */
  timeout?: number;
  [key: string]: unknown;
}

/** The entry Copane writes; `type: "local"` as `copilot mcp add` writes it. */
export function copilotEntryFor(spec: ServerSpec): CopilotEntry {
  return { type: 'local', command: spec.command, args: spec.args, env: envFor(spec, undefined), tools: ['*'], timeout: TOOL_TIMEOUT_MS };
}

/** The spec's env plus the pass-through references, keeping the user's form of a reference. */
function envFor(spec: ServerSpec, existing: Record<string, unknown> | undefined): Record<string, string> {
  const env: Record<string, string> = { ...spec.env };
  for (const name of PASS_THROUGH) env[name] = isReferenceTo(existing?.[name], name) ? String(existing![name]) : reference(name);
  return env;
}

/** Whether a registered entry starts the server the way `spec` would, and if not, why not. */
export function compareCopilotEntry(entry: CopilotEntry, spec: ServerSpec): { current: true } | { current: false; reason: string } {
  if (entry.type !== undefined && entry.type !== 'local' && entry.type !== 'stdio') return { current: false, reason: `it is a "${String(entry.type)}" server, not a local command` };
  const env = entry.env && typeof entry.env === 'object' ? { ...(entry.env as Record<string, unknown>) } : {};
  const missing = PASS_THROUGH.filter(name => !isReferenceTo(env[name], name));
  for (const name of PASS_THROUGH) delete env[name];
  const compared = compareEntry({ command: entry.command, args: entry.args, env }, spec);
  if (!compared.current) return compared;
  if (missing.length) return { current: false, reason: `it does not pass ${missing.join(' and ')} through to the server` };
  if (entry.timeout === undefined) return { current: false, reason: 'it sets no timeout, so Copilot stops a tool call after its default time limit' };
  return { current: true };
}

export function copilotStateOf(entry: unknown, spec: ServerSpec): EntryState {
  if (entry === undefined || entry === null) return { kind: 'absent' };
  if (typeof entry !== 'object') return { kind: 'foreign', command: JSON.stringify(entry) };
  const e = entry as CopilotEntry;
  const command = typeof e.command === 'string' ? [e.command, ...(Array.isArray(e.args) ? e.args : [])].join(' ') : typeof e.url === 'string' ? e.url : JSON.stringify(e);
  if (!isOurEntry(e)) return { kind: 'foreign', command };
  const compared = compareCopilotEntry(e, spec);
  return { kind: 'ours', current: compared.current, command, ...(compared.current ? {} : { reason: compared.reason }), entry: registeredCommand(e) };
}

export interface CopilotInspection {
  configExists: boolean;
  state: EntryState;
  /** The user turned the server off (`copilot mcp disable copane`). */
  disabled: boolean;
}

function parseJsonc(text: string): { value: any; ok: boolean } {
  const errors: ParseError[] = [];
  const value = parse(text, errors, { allowTrailingComma: true });
  return { value, ok: errors.length === 0 && !!value && typeof value === 'object' && !Array.isArray(value) };
}

export function inspectCopilotText(text: string | undefined, spec: ServerSpec, file = 'mcp-config.json'): EntryState {
  if (text === undefined) return { kind: 'absent' };
  if (!text.trim()) return { kind: 'absent' };
  const { value, ok } = parseJsonc(text);
  if (!ok) return { kind: 'unreadable', error: `${file} is not valid JSON` };
  return copilotStateOf(value.mcpServers?.[MCP_SERVER_NAME], spec);
}

export function inspectCopilot(configFile: string, spec: ServerSpec, settingsFile?: string): CopilotInspection {
  let text: string | undefined;
  try {
    text = readTextIfExists(configFile);
  } catch (err) {
    return { configExists: true, state: { kind: 'unreadable', error: String(err) }, disabled: false };
  }
  let disabled = false;
  if (settingsFile) {
    try {
      const settings = readTextIfExists(settingsFile);
      const list = settings ? parse(settings, [], { allowTrailingComma: true })?.disabledMcpServers : undefined;
      disabled = Array.isArray(list) && list.includes(MCP_SERVER_NAME);
    } catch {
      // Unreadable settings say nothing about our entry.
    }
  }
  return { configExists: text !== undefined, state: inspectCopilotText(text, spec, configFile), disabled };
}

const FORMAT = { formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' } };

/**
 * The document with the current entry: added when there is none; our own entry updated in place
 * (type, command, args and env, and a timeout where there is none; `tools`, the user's `timeout` and other keys stay); someone else's
 * replaced whole (only called for that after the user agreed).
 */
export function upsertCopilotEntry(text: string, spec: ServerSpec): string {
  const base = text.trim() ? text : '{}\n';
  const { value, ok } = parseJsonc(base);
  if (!ok) throw new Error('the file is not valid JSON; not changing it');
  const existing = value.mcpServers?.[MCP_SERVER_NAME];
  const at = ['mcpServers', MCP_SERVER_NAME];
  let next: string;
  if (existing && typeof existing === 'object' && !Array.isArray(existing) && isOurEntry(existing)) {
    next = base;
    const env = envFor(spec, existing.env && typeof existing.env === 'object' ? existing.env : undefined);
    const type = existing.type === 'stdio' ? 'stdio' : 'local';
    for (const [key, v] of [['type', type], ['command', spec.command], ['args', spec.args], ['env', env]] as const) {
      if (JSON.stringify(existing[key]) !== JSON.stringify(v)) next = applyEdits(next, modify(next, [...at, key], v, FORMAT));
    }
    // Only where there is none: the user's own value stays.
    if (existing.timeout === undefined) next = applyEdits(next, modify(next, [...at, 'timeout'], TOOL_TIMEOUT_MS, FORMAT));
  } else {
    next = applyEdits(base, modify(base, at, copilotEntryFor(spec), FORMAT));
  }
  return next.endsWith('\n') ? next : `${next}\n`;
}

/** The document without our entry (and no other change). */
export function removeCopilotEntry(text: string): string {
  const next = applyEdits(text, modify(text, ['mcpServers', MCP_SERVER_NAME], undefined, FORMAT));
  return next.endsWith('\n') ? next : `${next}\n`;
}

export interface CopilotTarget {
  configFile: string;
}

export async function registerCopilot(target: CopilotTarget, spec: ServerSpec, options: { replaceForeign?: boolean } = {}): Promise<ChangeOutcome> {
  try {
    const text = readTextIfExists(target.configFile);
    const before = inspectCopilotText(text, spec, target.configFile);
    if (before.kind === 'unreadable') return { kind: 'failed', detail: `${before.error}; nothing was changed` };
    if (before.kind === 'ours' && before.current) return { kind: 'unchanged', detail: 'already registered' };
    if (before.kind === 'foreign' && !options.replaceForeign) return { kind: 'conflict', detail: `another server named "${MCP_SERVER_NAME}" is configured (${before.command})` };
    writeFileAtomic(target.configFile, upsertCopilotEntry(text ?? '', spec), 0o600);
    const after = inspectCopilotText(readTextIfExists(target.configFile), spec, target.configFile);
    if (after.kind !== 'ours' || !after.current) return { kind: 'failed', detail: `the change did not stick in ${target.configFile}` };
    return { kind: 'changed', detail: before.kind === 'absent' ? 'registered' : before.kind === 'foreign' ? 'replaced the other server' : 'updated', via: 'file' };
  } catch (err) {
    return { kind: 'failed', detail: err instanceof Error ? err.message : String(err) };
  }
}

/** Removes the server if it is Copane's. Never removes someone else's server of that name. */
export async function unregisterCopilot(target: CopilotTarget, spec: ServerSpec): Promise<ChangeOutcome> {
  try {
    const text = readTextIfExists(target.configFile);
    const before = inspectCopilotText(text, spec, target.configFile);
    if (before.kind === 'unreadable') return { kind: 'failed', detail: before.error };
    if (before.kind === 'absent') return { kind: 'unchanged', detail: 'not registered' };
    if (before.kind === 'foreign') return { kind: 'conflict', detail: `the "${MCP_SERVER_NAME}" server there is not Copane's (${before.command}); left it alone` };
    writeFileAtomic(target.configFile, removeCopilotEntry(text!), 0o600);
    if (inspectCopilotText(readTextIfExists(target.configFile), spec).kind !== 'absent') return { kind: 'failed', detail: `the entry is still in ${target.configFile}` };
    return { kind: 'changed', detail: 'removed', via: 'file' };
  } catch (err) {
    return { kind: 'failed', detail: err instanceof Error ? err.message : String(err) };
  }
}
