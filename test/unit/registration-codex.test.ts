// Codex registration: text-level edits of config.toml; checked with the real `codex` CLI when installed.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  codexConfigFile,
  inspectCodexText,
  parseTomlStrings,
  registerCodex,
  removeCodexEntry,
  renderCodexEntry,
  scanToml,
  splitKey,
  unregisterCodex,
  upsertCodexEntry,
} from '../../src/extension/registration/codex';
import type { ServerSpec } from '../../src/extension/registration/launcher';

const spec: ServerSpec = { command: '/home/u/.vscode-agent-bridge/bin/mcp-server', args: [], env: {} };
const devSpec: ServerSpec = { command: '/tmp/agent-bridge-dev/r/home/bin/mcp-server', args: [], env: { AGENT_BRIDGE_HOME: '/tmp/agent-bridge-dev/r/home' } };

const USER_CONFIG = `# my settings
model = "o3" # inline comment stays
notes = """
[not a table]
"""
paths = [
  "a",
  [ "nested" ],
]

[mcp_servers.other]
command = "x" # keep
args = ["--flag"]

[projects."/a"]
trust_level = "trusted"
`;

describe('TOML scanning', () => {
  it('finds headers and keys, not brackets inside strings or arrays', () => {
    const lines = scanToml(USER_CONFIG);
    const headers = lines.filter(l => l.header).map(l => l.header!.join('.'));
    expect(headers).toEqual(['mcp_servers.other', 'projects./a']);
    expect(lines.filter(l => l.key && !l.header).map(l => l.key!.join('.'))).toEqual(['model', 'notes', 'paths', 'command', 'args', 'trust_level']);
  });

  it('splits dotted and quoted keys', () => {
    expect(splitKey('mcp_servers."vscode".env')).toEqual(['mcp_servers', 'vscode', 'env']);
    expect(splitKey(" a . 'b.c' ")).toEqual(['a', 'b.c']);
  });

  it('reads strings and string arrays', () => {
    expect(parseTomlStrings('"C:\\\\x\\\\y"')).toBe('C:\\x\\y');
    expect(parseTomlStrings("'lit'")).toBe('lit');
    expect(parseTomlStrings('[ "a", \'b\', # c\n "d" ]')).toEqual(['a', 'b', 'd']);
  });
});

describe('editing config.toml', () => {
  it('appends the entry and changes nothing else, byte for byte', () => {
    const next = upsertCodexEntry(USER_CONFIG, spec);
    expect(next.startsWith(USER_CONFIG.trimEnd())).toBe(true);
    expect(next).toContain(renderCodexEntry(spec));
    expect(inspectCodexText(next, spec)).toMatchObject({ kind: 'ours', current: true });
    expect(removeCodexEntry(next)).toBe(USER_CONFIG);
  });

  it('works on an empty or missing file', () => {
    expect(inspectCodexText(undefined, spec)).toEqual({ kind: 'absent' });
    const created = upsertCodexEntry('', devSpec);
    expect(created).toContain('[mcp_servers.vscode.env]\nAGENT_BRIDGE_HOME = "/tmp/agent-bridge-dev/r/home"');
    expect(inspectCodexText(created, devSpec)).toMatchObject({ kind: 'ours', current: true });
    expect(removeCodexEntry(created).trim()).toBe('');
  });

  it('replaces its own outdated entry in place, including its sub-tables', () => {
    const before = `${USER_CONFIG}\n${renderCodexEntry(devSpec)}\n\n[profiles.fast]\nmodel = "x"\n`;
    expect(inspectCodexText(before, spec)).toMatchObject({ kind: 'ours', current: false });
    const after = upsertCodexEntry(before, spec);
    expect(inspectCodexText(after, spec)).toMatchObject({ kind: 'ours', current: true });
    expect(after).not.toContain('AGENT_BRIDGE_HOME');
    expect(after).toContain('\n\n[profiles.fast]\nmodel = "x"\n');
    expect(upsertCodexEntry(after, spec)).toBe(after);
    expect(removeCodexEntry(after)).toBe(`${USER_CONFIG}\n[profiles.fast]\nmodel = "x"\n`);
  });

  it('keeps comments that sit between its table and the next one', () => {
    const before = `${renderCodexEntry(spec)}\n\n# My GitHub server\n[mcp_servers.github]\ncommand = "gh"\n\n# trailing note\n`;
    expect(inspectCodexText(before, spec)).toMatchObject({ kind: 'ours', current: true });
    expect(upsertCodexEntry(before, spec)).toBe(before);
    const updated = upsertCodexEntry(before, devSpec);
    expect(updated).toContain('\n\n# My GitHub server\n[mcp_servers.github]');
    expect(removeCodexEntry(before)).toBe('# My GitHub server\n[mcp_servers.github]\ncommand = "gh"\n\n# trailing note\n');
    const atEnd = `model = "x"\n\n${renderCodexEntry(spec)}\n# a comment at the end\n`;
    expect(removeCodexEntry(atEnd)).toBe('model = "x"\n\n# a comment at the end\n');
  });

  it('keeps keys the user added to its table, and updates only what makes it start', () => {
    const custom = renderCodexEntry(devSpec).replace('tool_timeout_sec = 600', 'tool_timeout_sec = 900\nenabled = false # paused for now');
    expect(inspectCodexText(custom, devSpec)).toMatchObject({ kind: 'ours', current: true });
    expect(upsertCodexEntry(custom, devSpec)).toBe(custom);
    const moved = upsertCodexEntry(custom, spec);
    expect(inspectCodexText(moved, spec)).toMatchObject({ kind: 'ours', current: true });
    expect(moved).toContain('enabled = false # paused for now');
    expect(moved).toContain('tool_timeout_sec = 900');
    expect(moved).not.toContain('AGENT_BRIDGE_HOME');
    // And back: the env table is added after the user's keys.
    const back = upsertCodexEntry(moved, devSpec);
    expect(inspectCodexText(back, devSpec)).toMatchObject({ kind: 'ours', current: true });
    expect(back).toContain('enabled = false');
  });

  it('updates an entry whose last line is args without bringing the old line back', () => {
    const minimal = `[mcp_servers.vscode]\ncommand = "/old/.vscode-agent-bridge/bin/mcp-server"\nargs = [\n  "x",\n]\n`;
    const next = upsertCodexEntry(minimal, devSpec);
    expect(inspectCodexText(next, devSpec)).toMatchObject({ kind: 'ours', current: true });
    expect(next).not.toContain('/old/');
    expect(next).not.toContain('"x"');
  });

  it('treats a user-defined vscode server as theirs, in table and in inline form', () => {
    const table = `${USER_CONFIG}\n[mcp_servers.vscode]\ncommand = "npx"\nargs = ["their-server"]\n`;
    expect(inspectCodexText(table, spec)).toEqual({ kind: 'foreign', command: 'npx their-server' });
    const inline = `[mcp_servers]\nvscode = { command = "npx" }\n`;
    expect(inspectCodexText(inline, spec)).toMatchObject({ kind: 'foreign' });
    const dotted = `mcp_servers.vscode.command = "npx"\n`;
    expect(inspectCodexText(dotted, spec)).toMatchObject({ kind: 'foreign' });
  });

  it('writes Windows paths as valid TOML strings', () => {
    const win: ServerSpec = { command: 'C:\\Program Files\\Microsoft VS Code\\Code.exe', args: ['C:\\Users\\me\\.vscode-agent-bridge\\bin\\mcp-server.js'], env: { ELECTRON_RUN_AS_NODE: '1' } };
    const text = upsertCodexEntry('', win);
    expect(text).toContain('command = "C:\\\\Program Files\\\\Microsoft VS Code\\\\Code.exe"');
    expect(inspectCodexText(text, win)).toMatchObject({ kind: 'ours', current: true });
  });
});

describe('registerCodex / unregisterCodex', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-codex-'));
    file = path.join(dir, 'config.toml');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('follows CODEX_HOME', () => {
    expect(codexConfigFile({ CODEX_HOME: '/c' }, '/h')).toBe(path.join('/c', 'config.toml'));
    expect(codexConfigFile({}, '/h')).toBe(path.join('/h', '.codex', 'config.toml'));
  });

  it('registers idempotently, refuses foreign entries, unregisters cleanly', async () => {
    fs.writeFileSync(file, USER_CONFIG);
    expect(await registerCodex({ configFile: file }, spec)).toMatchObject({ kind: 'changed', detail: 'registered' });
    expect(await registerCodex({ configFile: file }, spec)).toMatchObject({ kind: 'unchanged' });
    expect(await unregisterCodex({ configFile: file }, spec)).toMatchObject({ kind: 'changed' });
    expect(fs.readFileSync(file, 'utf8')).toBe(USER_CONFIG);
    fs.appendFileSync(file, '\n[mcp_servers.vscode]\ncommand = "npx"\n');
    expect(await registerCodex({ configFile: file }, spec)).toMatchObject({ kind: 'conflict' });
    expect(await unregisterCodex({ configFile: file }, spec)).toMatchObject({ kind: 'conflict' });
    expect(await registerCodex({ configFile: file }, spec, { replaceForeign: true })).toMatchObject({ kind: 'changed' });
  });

  const codex = (() => {
    try {
      execFileSync('codex', ['--version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(!codex)('the real codex CLI reads the entry, including env_vars and the timeout', async () => {
    fs.writeFileSync(file, USER_CONFIG);
    await registerCodex({ configFile: file }, devSpec);
    const listed = JSON.parse(execFileSync('codex', ['mcp', 'list', '--json'], { env: { ...process.env, CODEX_HOME: dir }, encoding: 'utf8' }));
    const ours = listed.find((s: { name: string }) => s.name === 'vscode');
    expect(ours.transport).toMatchObject({
      type: 'stdio',
      command: devSpec.command,
      env: devSpec.env,
      env_vars: ['AGENT_BRIDGE_INSTANCE', 'AGENT_BRIDGE_SESSION'],
    });
    expect(ours.tool_timeout_sec).toBe(600);
    expect(listed.find((s: { name: string }) => s.name === 'other')).toBeTruthy();
  }, 30_000);
});
