// Registration with Codex: the `[mcp_servers.copane]` table in `~/.codex/config.toml` (or
// `$CODEX_HOME/config.toml`).
//
// The file is edited as text: only the lines of our tables are replaced or removed, everything else
// (comments included) stays byte for byte. `codex mcp add` would rewrite the whole file and drops
// inline comments, and there is no TOML library in the bundle. The scanner below understands as much
// TOML as it needs to find table boundaries safely: strings, multi-line strings and arrays, comments.
// A "copane" server defined in a form it does not edit (dotted keys, an inline table) is reported as
// someone else's and left alone.
//
// Codex starts MCP servers with only a small allow-list of environment variables plus `env` and
// `env_vars`, so the entry lists the variables a terminal sets for finding the window.
import * as path from 'node:path';
import { MCP_SERVER_NAME } from '../../shared/protocol';
import { readTextIfExists, writeFileAtomic } from './files';
import { isOurEntry, type ChangeOutcome, type EntryState } from './claudeCode';
import { compareEntry, type ServerSpec } from './launcher';

export function codexConfigFile(env: NodeJS.ProcessEnv, home: string): string {
  return path.join(env.CODEX_HOME?.trim() || path.join(home, '.codex'), 'config.toml');
}

const MARKER = '# Added by the Copane VS Code extension; remove it with the command "Copane: Unregister from Claude Code and Codex".';
/** Variables Codex must pass through so the server finds the window of the terminal it runs in. */
const PASS_THROUGH = ['COPANE_INSTANCE', 'COPANE_SESSION'];
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

/** `mcp_servers."copane".env` → ['mcp_servers', 'copane', 'env'] */
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

interface Table {
  path: string[];
  /** First line: the header, or our marker comment right above it. */
  start: number;
  /** Exclusive. Blank lines and comments before the next table belong to what follows. */
  end: number;
}

interface KeySpan {
  key: string;
  start: number;
  /** Exclusive: a value can continue on later lines. */
  end: number;
  value: string;
}

interface Located {
  /** Our tables: `[mcp_servers.copane]` and its sub-tables. */
  tables: Table[];
  main: Table | undefined;
  env: Table | undefined;
  /** Keys of `[mcp_servers.copane]`. */
  keys: KeySpan[];
  /** Keys of `[mcp_servers.copane.env]`, raw TOML values. */
  envValues: Map<string, string>;
  /** The server is (also) defined with dotted keys or an inline table, which this editor does not touch. */
  inline: boolean;
}

function locate(lines: Line[]): Located {
  const tables: Table[] = [];
  const keys: KeySpan[] = [];
  const envValues = new Map<string, string>();
  let inline = false;
  let table: string[] = [];
  let current: Table | undefined;
  const close = (at: number) => {
    if (!current) return;
    let end = at;
    while (end > current.start + 1 && /^\s*(#.*)?\r?$/.test(lines[end - 1]!.text)) end--;
    current.end = end;
    tables.push(current);
    current = undefined;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.header) {
      close(i);
      table = line.header;
      if (isOurs(table)) {
        const start = i > 0 && lines[i - 1]!.text.trim() === MARKER ? i - 1 : i;
        current = { path: table, start, end: lines.length };
      }
      continue;
    }
    if (!line.key) continue;
    const full = [...table, ...line.key];
    if (!current && full.length >= 2 && full[0] === 'mcp_servers' && full[1] === MCP_SERVER_NAME) inline = true;
    if (current && table.length === 2) {
      const end = valueEnd(lines, i);
      keys.push({ key: line.key.join('.'), start: i, end, value: valueText(lines, i, end) });
    }
    if (current && table.length === 3 && table[2] === 'env') envValues.set(line.key.join('.'), valueText(lines, i, valueEnd(lines, i)));
  }
  close(lines.length);
  return {
    tables,
    main: tables.find(t => t.path.length === 2),
    env: tables.find(t => t.path.length === 3 && t.path[2] === 'env'),
    keys,
    envValues,
    inline,
  };
}

/** Line after the value of the key on line `i` (values with open brackets continue on later lines). */
function valueEnd(lines: Line[], i: number): number {
  const first = lines[i]!.text;
  let text = first.slice(findTopLevelEquals(first) + 1);
  let j = i + 1;
  for (; j < lines.length && !balanced(text); j++) text += `\n${lines[j]!.text}`;
  return j;
}

function valueText(lines: Line[], i: number, end: number): string {
  const first = lines[i]!.text;
  return [first.slice(findTopLevelEquals(first) + 1), ...lines.slice(i + 1, end).map(l => l.text)].join('\n').trim();
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
const tomlKey = (k: string) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : tomlString(k));

function commandLines(spec: ServerSpec): string[] {
  return [`command = ${tomlString(spec.command)}`, `args = [${spec.args.map(tomlString).join(', ')}]`];
}

function envTable(spec: ServerSpec): string[] {
  const env = Object.entries(spec.env);
  return env.length ? [`[mcp_servers.${MCP_SERVER_NAME}.env]`, ...env.map(([k, v]) => `${tomlKey(k)} = ${tomlString(v)}`)] : [];
}

export function renderCodexEntry(spec: ServerSpec): string {
  const lines = [
    MARKER,
    `[mcp_servers.${MCP_SERVER_NAME}]`,
    ...commandLines(spec),
    `env_vars = [${PASS_THROUGH.map(tomlString).join(', ')}]`,
    `tool_timeout_sec = ${TOOL_TIMEOUT_SEC}`,
  ];
  const env = envTable(spec);
  if (env.length) lines.push('', ...env);
  return lines.join('\n');
}

function entryOf(found: Located): { command: string | undefined; args: string[]; env: Record<string, string> | undefined } {
  const value = (key: string) => found.keys.find(k => k.key === key)?.value;
  const command = parseTomlStrings(value('command') ?? '');
  const args = parseTomlStrings(value('args') ?? '[]');
  let env: Record<string, string> | undefined = {};
  if (value('env') !== undefined) env = undefined; // An inline env table: not in the form we write.
  for (const [k, raw] of found.envValues) {
    const v = parseTomlStrings(raw);
    if (env && typeof v === 'string') env[splitKey(k).join('.')] = v;
    else env = undefined;
  }
  return { command: typeof command === 'string' ? command : undefined, args: Array.isArray(args) ? args : [], env };
}

export function inspectCodexText(text: string | undefined, spec: ServerSpec): EntryState {
  if (text === undefined) return { kind: 'absent' };
  const found = locate(scanToml(text));
  if (found.inline) return { kind: 'foreign', command: `"${MCP_SERVER_NAME}" defined with dotted keys or an inline table` };
  if (!found.main) return found.tables.length ? { kind: 'foreign', command: `only sub-tables of "${MCP_SERVER_NAME}"` } : { kind: 'absent' };
  const entry = entryOf(found);
  const described = [entry.command ?? '(no command)', ...entry.args].join(' ');
  if (!isOurEntry(entry)) return { kind: 'foreign', command: described };
  // Current when what makes it start is right. Other keys (timeouts, enabled, ...) are the user's.
  const registered = { command: entry.command ?? '', args: entry.args, env: entry.env ?? {} };
  if (!entry.env) return { kind: 'ours', current: false, command: described, reason: 'its env table is not in the form Copane writes', entry: registered };
  const compared = compareEntry({ command: entry.command, args: entry.args, env: entry.env }, spec);
  return { kind: 'ours', current: compared.current, command: described, ...(compared.current ? {} : { reason: compared.reason }), entry: registered };
}

/** The document with our tables removed (and no other change). */
export function removeCodexEntry(text: string): string {
  const lines = scanToml(text);
  const { tables } = locate(lines);
  if (tables.length === 0) return text;
  const drop = new Set<number>();
  for (const { start: s, end: e } of tables) {
    for (let i = s; i < e; i++) drop.add(i);
    // One blank line that separated the removed table from what follows goes with it.
    if (lines[e] && lines[e]!.text.trim() === '' && (s === 0 || lines[s - 1]!.text.trim() === '')) drop.add(e);
  }
  const kept = lines.filter((_, i) => !drop.has(i)).map(l => l.text);
  while (kept.length > 1 && kept[kept.length - 1] === '' && kept[kept.length - 2] === '') kept.pop();
  return kept.join('\n');
}

/**
 * The document with the current entry: appended when there is none; our own entry updated in
 * place (command, args and env only, so keys the user added stay); someone else's replaced whole
 * (only called for that after the user agreed).
 */
export function upsertCodexEntry(text: string, spec: ServerSpec): string {
  const lines = scanToml(text);
  const found = locate(lines);
  if (!found.main) {
    const base = text.replace(/\s*$/, '');
    if (found.tables.length === 0) return base ? `${base}\n\n${renderCodexEntry(spec)}\n` : `${renderCodexEntry(spec)}\n`;
  }
  const replace = new Map<number, string[]>(); // line index → lines to put there instead
  const drop = new Set<number>();
  const dropRange = (s: number, e: number) => {
    for (let i = s; i < e; i++) drop.add(i);
  };
  if (found.main && isOurEntry(entryOf(found))) {
    const main = found.main;
    const header = lines.findIndex((l, i) => i >= main.start && l.header);
    const managed = found.keys.filter(k => k.key === 'command' || k.key === 'args' || k.key === 'env');
    for (const k of managed) dropRange(k.start, k.end);
    replace.set(header, [lines[header]!.text, ...commandLines(spec)]);
    const env = envTable(spec);
    if (found.env) {
      dropRange(found.env.start, found.env.end);
      if (env.length) replace.set(found.env.start, env);
      else if (lines[found.env.end]?.text.trim() === '') drop.add(found.env.end);
    } else if (env.length) {
      const last = main.end - 1;
      const base = replace.get(last) ?? (drop.has(last) ? [] : [lines[last]!.text]);
      replace.set(last, [...base, '', ...env]);
    }
  } else {
    // Someone else's server, which the user chose to replace: our block where theirs started.
    const first = found.tables[0]!;
    for (const t of found.tables) dropRange(t.start, t.end);
    replace.set(first.start, renderCodexEntry(spec).split('\n'));
  }
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const instead = replace.get(i);
    if (instead) out.push(...instead);
    else if (!drop.has(i)) out.push(lines[i]!.text);
  }
  return out.join('\n');
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
    if (before.kind === 'foreign') return { kind: 'conflict', detail: `the "${MCP_SERVER_NAME}" server there is not Copane's (${before.command}); left it alone` };
    writeFileAtomic(target.configFile, removeCodexEntry(text!), 0o600);
    if (inspectCodexText(readTextIfExists(target.configFile), spec).kind !== 'absent') return { kind: 'failed', detail: 'the entry is still there' };
    return { kind: 'changed', detail: 'removed', via: 'file' };
  } catch (err) {
    return { kind: 'failed', detail: err instanceof Error ? err.message : String(err) };
  }
}
