// Registration with Codex: the `[mcp_servers.vscode]` table in `~/.codex/config.toml` (or
// `$CODEX_HOME/config.toml`).
//
// The file is edited as text: only the lines of our tables are replaced or removed, everything else
// (comments included) stays byte for byte. `codex mcp add` would rewrite the whole file and drops
// inline comments, and there is no TOML library in the bundle. The scanner below understands as much
// TOML as it needs to find table boundaries safely: strings, multi-line strings and arrays, comments.
// A "vscode" server defined in a form it does not edit (dotted keys, an inline table) is reported as
// someone else's and left alone.
//
// Codex starts MCP servers with only a small allow-list of environment variables plus `env` and
// `env_vars`, so the entry lists the variables a terminal sets for finding the window.
import * as path from 'node:path';
import { MCP_SERVER_NAME } from '../../shared/protocol';
import { readTextIfExists, writeFileAtomic } from './files';
import { isOurEntry, type ChangeOutcome, type EntryState } from './claudeCode';
import type { ServerSpec } from './launcher';

export function codexConfigFile(env: NodeJS.ProcessEnv, home: string): string {
  return path.join(env.CODEX_HOME?.trim() || path.join(home, '.codex'), 'config.toml');
}

const MARKER = '# Added by the Agent Bridge VS Code extension; remove it with the command "Agent Bridge: Unregister from Claude Code and Codex".';
/** Variables Codex must pass through so the server finds the window of the terminal it runs in. */
const PASS_THROUGH = ['AGENT_BRIDGE_INSTANCE', 'AGENT_BRIDGE_SESSION'];
/** Codex's default per-call timeout is 60 s; browser waits and terminal commands can take longer. */
const TOOL_TIMEOUT_SEC = 600;

interface Line {
  text: string;
  /** Table path when this line is a `[table]` or `[[array]]` header. */
  header?: string[];
  /** Dotted key path when this line starts a `key = value` pair. */
  key?: string[];
}

/** Splits a TOML document into lines, marking table headers and key lines at top level. */
export function scanToml(text: string): Line[] {
  const raw = text.split('\n');
  const lines: Line[] = [];
  let inString: '"""' | "'''" | undefined;
  let depth = 0; // [] and {} nesting of a value that spans lines
  for (const lineText of raw) {
    const line: Line = { text: lineText };
    if (!inString && depth === 0) {
      const trimmed = lineText.trimStart();
      if (trimmed.startsWith('[')) {
        const match = /^\[\[?\s*(.+?)\s*\]\]?\s*(#.*)?\r?$/.exec(trimmed);
        if (match) line.header = splitKey(match[1]!);
      } else if (trimmed && !trimmed.startsWith('#')) {
        const eq = findTopLevelEquals(trimmed);
        if (eq > 0) line.key = splitKey(trimmed.slice(0, eq).trim());
      }
    }
    // Track multi-line strings and brackets through the line.
    for (let i = 0; i < lineText.length; i++) {
      const rest = lineText.slice(i);
      if (inString) {
        if (rest.startsWith(inString)) {
          i += 2;
          inString = undefined;
        } else if (inString === '"""' && lineText[i] === '\\') i++;
        continue;
      }
      const c = lineText[i];
      if (c === '#') break;
      if (rest.startsWith('"""') || rest.startsWith("'''")) {
        inString = rest.slice(0, 3) as '"""' | "'''";
        i += 2;
        continue;
      }
      if (c === '"' || c === "'") {
        i = skipString(lineText, i);
        continue;
      }
      if (line.header && depth === 0) break; // The header's own brackets are not value nesting.
      if (c === '[' || c === '{') depth++;
      else if (c === ']' || c === '}') depth = Math.max(0, depth - 1);
    }
    lines.push(line);
  }
  return lines;
}

function skipString(s: string, start: number): number {
  const quote = s[start];
  for (let i = start + 1; i < s.length; i++) {
    if (quote === '"' && s[i] === '\\') {
      i++;
      continue;
    }
    if (s[i] === quote) return i;
  }
  return s.length;
}

function findTopLevelEquals(s: string): number {
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'") i = skipString(s, i);
    else if (c === '=') return i;
    else if (c === '#') return -1;
  }
  return -1;
}

/** `mcp_servers."vscode".env` → ['mcp_servers', 'vscode', 'env'] */
export function splitKey(key: string): string[] {
  const parts: string[] = [];
  let i = 0;
  while (i < key.length) {
    while (key[i] === ' ' || key[i] === '\t') i++;
    if (key[i] === '"' || key[i] === "'") {
      const end = skipString(key, i);
      const raw = key.slice(i, end + 1);
      parts.push(key[i] === '"' ? safeJson(raw) : raw.slice(1, -1));
      i = end + 1;
    } else {
      let j = i;
      while (j < key.length && key[j] !== '.') j++;
      parts.push(key.slice(i, j).trim());
      i = j;
    }
    while (key[i] === ' ' || key[i] === '\t') i++;
    if (key[i] === '.') i++;
  }
  return parts;
}

function safeJson(raw: string): string {
  try {
    return JSON.parse(raw);
  } catch {
    return raw.slice(1, -1);
  }
}

const isOurs = (p: string[] | undefined) => !!p && p.length >= 2 && p[0] === 'mcp_servers' && p[1] === MCP_SERVER_NAME;

interface Located {
  /** [start, end) line ranges of our tables, including a marker comment right above. */
  ranges: Array<[number, number]>;
  /** The server is (also) defined with dotted keys or an inline table, which this editor does not touch. */
  inline: boolean;
  /** Values found in `[mcp_servers.vscode]`, as raw TOML. */
  values: Map<string, string>;
}

function locate(lines: Line[]): Located {
  const ranges: Array<[number, number]> = [];
  const values = new Map<string, string>();
  let inline = false;
  let table: string[] = [];
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.header) {
      if (start >= 0) ranges.push([start, i]);
      start = -1;
      table = line.header;
      if (isOurs(table)) {
        start = i > 0 && lines[i - 1]!.text.trim() === MARKER ? i - 1 : i;
      }
      continue;
    }
    if (line.key) {
      const full = [...table, ...line.key];
      if (start < 0 && full.length >= 2 && full[0] === 'mcp_servers' && full[1] === MCP_SERVER_NAME) inline = true;
      if (start >= 0 && table.length === 2) values.set(line.key.join('.'), valueText(lines, i));
    }
  }
  if (start >= 0) ranges.push([start, lines.length]);
  // Do not swallow the blank lines that separate our table from the next one.
  const trimmed = ranges.map(([s, e]): [number, number] => {
    let end = e;
    while (end > s + 1 && lines[end - 1]!.text.trim() === '') end--;
    return [s, end];
  });
  return { ranges: trimmed, inline, values };
}

/** The raw value of the key on line `i`, following it onto later lines while brackets are open. */
function valueText(lines: Line[], i: number): string {
  const first = lines[i]!.text;
  let text = first.slice(findTopLevelEquals(first) + 1);
  for (let j = i + 1; j < lines.length && !balanced(text); j++) text += `\n${lines[j]!.text}`;
  return text.trim();
}

function balanced(text: string): boolean {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'") i = skipString(text, i);
    else if (c === '#') {
      const nl = text.indexOf('\n', i);
      if (nl < 0) break;
      i = nl;
    } else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
  }
  return depth <= 0;
}

/** Reads a TOML string or array of strings well enough to compare with what we would write. */
export function parseTomlStrings(value: string): string | string[] | undefined {
  const v = value.replace(/\s+#[^\n"']*$/, '').trim();
  const one = (s: string): string | undefined => {
    if (s.startsWith('"') && s.endsWith('"')) return safeJson(s);
    if (s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1);
    return undefined;
  };
  if (!v.startsWith('[')) return one(v);
  const items: string[] = [];
  const inner = v.slice(1, v.lastIndexOf(']'));
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === '"' || c === "'") {
      const end = skipString(inner, i);
      const item = one(inner.slice(i, end + 1));
      if (item !== undefined) items.push(item);
      i = end;
    } else if (c === '#') {
      const nl = inner.indexOf('\n', i);
      if (nl < 0) break;
      i = nl;
    }
  }
  return items;
}

const tomlString = (s: string) => JSON.stringify(s);

export function renderCodexEntry(spec: ServerSpec): string {
  const lines = [
    MARKER,
    `[mcp_servers.${MCP_SERVER_NAME}]`,
    `command = ${tomlString(spec.command)}`,
    `args = [${spec.args.map(tomlString).join(', ')}]`,
    `env_vars = [${PASS_THROUGH.map(tomlString).join(', ')}]`,
    `tool_timeout_sec = ${TOOL_TIMEOUT_SEC}`,
  ];
  const env = Object.entries(spec.env);
  if (env.length > 0) {
    lines.push('', `[mcp_servers.${MCP_SERVER_NAME}.env]`, ...env.map(([k, v]) => `${/^[A-Za-z0-9_-]+$/.test(k) ? k : tomlString(k)} = ${tomlString(v)}`));
  }
  return lines.join('\n');
}

export function inspectCodexText(text: string | undefined, spec: ServerSpec): EntryState {
  if (text === undefined) return { kind: 'absent' };
  const lines = scanToml(text);
  const found = locate(lines);
  if (found.inline) return { kind: 'foreign', command: `"${MCP_SERVER_NAME}" defined with dotted keys or an inline table` };
  if (found.ranges.length === 0) return { kind: 'absent' };
  const command = parseTomlStrings(found.values.get('command') ?? '');
  const args = parseTomlStrings(found.values.get('args') ?? '[]');
  const entry = { command: typeof command === 'string' ? command : undefined, args: Array.isArray(args) ? args : [] };
  const described = [entry.command ?? '(no command)', ...entry.args].join(' ');
  if (!isOurEntry(entry)) return { kind: 'foreign', command: described };
  // Ours: current when the exact block we would write is there.
  const current = found.ranges.length > 0 && rangesText(lines, found.ranges) === renderCodexEntry(spec);
  return { kind: 'ours', current, command: described };
}

function rangesText(lines: Line[], ranges: Array<[number, number]>): string {
  return ranges
    .map(([s, e]) => lines.slice(s, e).map(l => l.text.replace(/\r$/, '')).join('\n'))
    .join('\n\n');
}

/** The document with our tables removed (and no other change). */
export function removeCodexEntry(text: string): string {
  const lines = scanToml(text);
  const { ranges } = locate(lines);
  if (ranges.length === 0) return text;
  const drop = new Set<number>();
  for (const [s, e] of ranges) {
    for (let i = s; i < e; i++) drop.add(i);
    // One blank line that separated the removed table from what follows goes with it.
    if (lines[e] && lines[e]!.text.trim() === '' && (s === 0 || lines[s - 1]!.text.trim() === '')) drop.add(e);
  }
  const kept = lines.filter((_, i) => !drop.has(i)).map(l => l.text);
  while (kept.length > 1 && kept[kept.length - 1] === '' && kept[kept.length - 2] === '') kept.pop();
  return kept.join('\n');
}

/** The document with our tables replaced by the current entry, appended at the end if absent. */
export function upsertCodexEntry(text: string, spec: ServerSpec): string {
  const lines = scanToml(text);
  const { ranges } = locate(lines);
  const block = renderCodexEntry(spec);
  if (ranges.length > 0) {
    const [first] = ranges;
    const out: string[] = [];
    let inserted = false;
    for (let i = 0; i < lines.length; i++) {
      const range = ranges.find(([s, e]) => i >= s && i < e);
      if (!range) {
        out.push(lines[i]!.text);
        continue;
      }
      if (!inserted && range === first) {
        out.push(block);
        inserted = true;
      }
      if (range !== first && i === range[0] && out[out.length - 1]?.trim() === '') out.pop();
    }
    return out.join('\n');
  }
  const base = text.replace(/\s*$/, '');
  return base ? `${base}\n\n${block}\n` : `${block}\n`;
}

export interface CodexTarget {
  configFile: string;
}

export async function registerCodex(target: CodexTarget, spec: ServerSpec, options: { replaceForeign?: boolean } = {}): Promise<ChangeOutcome> {
  try {
    const text = readTextIfExists(target.configFile);
    const before = inspectCodexText(text, spec);
    if (before.kind === 'ours' && before.current) return { kind: 'unchanged', detail: 'already registered' };
    if (before.kind === 'foreign') {
      if (!options.replaceForeign || /inline table/.test(before.command)) {
        return { kind: 'conflict', detail: `another server named "${MCP_SERVER_NAME}" is configured (${before.command})` };
      }
    }
    writeFileAtomic(target.configFile, upsertCodexEntry(text ?? '', spec), 0o600);
    const after = inspectCodexText(readTextIfExists(target.configFile), spec);
    if (after.kind !== 'ours' || !after.current) return { kind: 'failed', detail: `the change did not stick in ${target.configFile}` };
    return { kind: 'changed', detail: before.kind === 'absent' ? 'registered' : 'updated', via: 'file' };
  } catch (err) {
    return { kind: 'failed', detail: err instanceof Error ? err.message : String(err) };
  }
}

export async function unregisterCodex(target: CodexTarget, spec: ServerSpec): Promise<ChangeOutcome> {
  try {
    const text = readTextIfExists(target.configFile);
    const before = inspectCodexText(text, spec);
    if (before.kind === 'absent') return { kind: 'unchanged', detail: 'not registered' };
    if (before.kind === 'foreign') return { kind: 'conflict', detail: `the "${MCP_SERVER_NAME}" server there is not Agent Bridge's (${before.command}); left it alone` };
    writeFileAtomic(target.configFile, removeCodexEntry(text!), 0o600);
    if (inspectCodexText(readTextIfExists(target.configFile), spec).kind !== 'absent') return { kind: 'failed', detail: 'the entry is still there' };
    return { kind: 'changed', detail: 'removed', via: 'file' };
  } catch (err) {
    return { kind: 'failed', detail: err instanceof Error ? err.message : String(err) };
  }
}
