// Claude Code registration against temporary config files; with the real `claude` CLI when installed.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  claudeConfigFile,
  findClaudeCli,
  inspectClaude,
  isOurEntry,
  locateClaudeCli,
  registerClaude,
  unregisterClaude,
  type ClaudeTarget,
} from '../../src/extension/registration/claudeCode';
import { serverSpec, type ServerSpec } from '../../src/extension/registration/launcher';

let dir: string;
let file: string;
const spec: ServerSpec = { command: '/home/u/.vscode-agent-bridge/bin/mcp-server', args: [], env: {} };
const direct = (): ClaudeTarget => ({ configFile: file, configDir: dir, cli: undefined });

const existing = {
  numStartups: 42,
  mcpServers: { github: { type: 'http', url: 'https://example.com/mcp' } },
  projects: { '/p': { allowedTools: [], mcpServers: {} } },
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-claude-'));
  file = path.join(dir, '.claude.json');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));

describe('locating Claude Code', () => {
  it('follows CLAUDE_CONFIG_DIR like Claude Code does', () => {
    expect(claudeConfigFile({}, '/h')).toEqual({ configFile: path.join('/h', '.claude.json'), configDir: undefined });
    expect(claudeConfigFile({ CLAUDE_CONFIG_DIR: '/c' }, '/h')).toEqual({ configFile: path.join('/c', '.claude.json'), configDir: '/c' });
  });

  it.skipIf(process.platform === 'win32')('finds an executable claude on the PATH, then in extra locations', () => {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    expect(findClaudeCli({ PATH: bin }, dir, process.platform)).toBeUndefined();
    const bundled = path.join(dir, 'bundled-claude');
    fs.writeFileSync(bundled, '#!/bin/sh\n', { mode: 0o755 });
    expect(findClaudeCli({ PATH: bin }, dir, process.platform, [bundled])).toBe(bundled);
    fs.writeFileSync(path.join(bin, 'claude'), '', { mode: 0o644 }); // not executable: skipped
    expect(findClaudeCli({ PATH: bin }, dir, process.platform, [bundled])).toBe(bundled);
    fs.chmodSync(path.join(bin, 'claude'), 0o755);
    expect(findClaudeCli({ PATH: bin }, dir, process.platform, [bundled])).toBe(path.join(bin, 'claude'));
  });
});

describe('recognising entries', () => {
  it('knows its own entries from any bridge home or version', () => {
    expect(isOurEntry({ command: '/Users/x/.vscode-agent-bridge/bin/mcp-server' })).toBe(true);
    expect(isOurEntry({ command: 'C:\\Code.exe', args: ['C:\\Users\\x\\.vscode-agent-bridge\\bin\\mcp-server.js'] })).toBe(true);
    expect(isOurEntry({ command: '/tmp/agent-bridge-dev/r/home/bin/mcp-server' })).toBe(true);
    expect(isOurEntry({ command: 'npx', args: ['some-vscode-mcp'] })).toBe(false);
  });
});

describe('registerClaude (direct edit, no CLI)', () => {
  it('adds the server and keeps everything else', async () => {
    fs.writeFileSync(file, JSON.stringify(existing, null, 2), { mode: 0o600 });
    const result = await registerClaude(direct(), spec);
    expect(result).toMatchObject({ kind: 'changed', via: 'file' });
    const config = read();
    expect(config.mcpServers.vscode).toEqual({ type: 'stdio', command: spec.command, args: [], env: {} });
    expect(config.mcpServers.github).toEqual(existing.mcpServers.github);
    expect(config.numStartups).toBe(42);
    expect(config.projects).toEqual(existing.projects);
    expect(inspectClaude(file, spec).state).toMatchObject({ kind: 'ours', current: true, command: spec.command });
  });

  it('creates the file when Claude Code has not written one yet', async () => {
    expect(inspectClaude(file, spec)).toMatchObject({ configExists: false, state: { kind: 'absent' } });
    expect(await registerClaude(direct(), spec)).toMatchObject({ kind: 'changed' });
    expect(read().mcpServers.vscode.command).toBe(spec.command);
  });

  it('is idempotent and updates its own outdated entry', async () => {
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { vscode: { type: 'stdio', command: '/old/.vscode-agent-bridge/bin/mcp-server', args: [] } } }));
    expect(inspectClaude(file, spec).state).toMatchObject({ kind: 'ours', current: false });
    expect(await registerClaude(direct(), spec)).toMatchObject({ kind: 'changed', detail: 'updated' });
    const text = fs.readFileSync(file, 'utf8');
    expect(await registerClaude(direct(), spec)).toMatchObject({ kind: 'unchanged' });
    expect(fs.readFileSync(file, 'utf8')).toBe(text);
  });

  it('never replaces a different server of the same name unless told to', async () => {
    const theirs = { type: 'stdio', command: 'npx', args: ['their-vscode-server'] };
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { vscode: theirs } }));
    expect(await registerClaude(direct(), spec)).toMatchObject({ kind: 'conflict' });
    expect(read().mcpServers.vscode).toEqual(theirs);
    expect(await unregisterClaude(direct(), spec)).toMatchObject({ kind: 'conflict' });
    expect(read().mcpServers.vscode).toEqual(theirs);
    expect(await registerClaude(direct(), spec, { replaceForeign: true })).toMatchObject({ kind: 'changed' });
    expect(read().mcpServers.vscode.command).toBe(spec.command);
  });

  it('unregisters only its own entry and leaves the rest', async () => {
    fs.writeFileSync(file, JSON.stringify(existing, null, 2));
    await registerClaude(direct(), spec);
    expect(await unregisterClaude(direct(), spec)).toMatchObject({ kind: 'changed', detail: 'removed' });
    expect(read()).toEqual(existing);
    expect(await unregisterClaude(direct(), spec)).toMatchObject({ kind: 'unchanged' });
  });

  it('refuses to touch a file it cannot parse', async () => {
    fs.writeFileSync(file, '{ "broken": ');
    expect(await registerClaude(direct(), spec)).toMatchObject({ kind: 'failed' });
    expect(fs.readFileSync(file, 'utf8')).toBe('{ "broken": ');
  });

  it('waits for Claude Code to release its lock on the file', async () => {
    fs.writeFileSync(file, JSON.stringify(existing));
    fs.mkdirSync(`${file}.lock`);
    let released = false;
    setTimeout(() => {
      // Claude Code saves its config while holding the lock...
      fs.writeFileSync(file, JSON.stringify({ ...existing, numStartups: 43 }));
      fs.rmdirSync(`${file}.lock`);
      released = true;
    }, 200);
    expect(await registerClaude(direct(), spec)).toMatchObject({ kind: 'changed' });
    expect(released).toBe(true);
    // ...and our change is made on top of its write, not on a stale copy.
    expect(read()).toMatchObject({ numStartups: 43, mcpServers: { vscode: { command: spec.command } } });
  });

  it('reports projects whose local-scope "vscode" server wins over the user-scope one', () => {
    fs.writeFileSync(file, JSON.stringify({ projects: { '/p': { mcpServers: { vscode: { command: 'x' } } }, '/q': {} } }));
    expect(inspectClaude(file, spec).overriddenIn).toEqual([{ project: '/p', ours: false }]);
  });
});

describe('an update can never lose the entry (the Windows "it got removed" report)', () => {
  // A `claude` whose `mcp remove` works and whose `mcp add-json` fails, as when a running Claude Code
  // holds the config lock, the CLI times out, or a virus scanner holds the file. The old update ran
  // remove, then add-json, then fell back to editing the file, which failed as well (lock still held):
  // the entry was gone.
  const fakeCli = () => {
    const script = path.join(dir, 'fake-claude.cjs');
    const calls = path.join(dir, 'calls.log');
    fs.writeFileSync(
      script,
      `const fs = require('fs'); const [cmd, sub, ...rest] = process.argv.slice(2);
       fs.appendFileSync(${JSON.stringify(calls)}, [cmd, sub].join(' ') + '\\n');
       const file = ${JSON.stringify(file)};
       if (sub === 'remove') { const c = JSON.parse(fs.readFileSync(file, 'utf8')); delete c.mcpServers.vscode; fs.writeFileSync(file, JSON.stringify(c)); process.exit(0); }
       process.stderr.write('Error: Lock file is already being held\\n'); process.exit(1);`,
    );
    const cli = path.join(dir, 'claude');
    fs.writeFileSync(cli, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`, { mode: 0o755 });
    return { cli, calls: () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n') : []) };
  };
  const holdLock = () => {
    fs.mkdirSync(`${file}.lock`);
    const timer = setInterval(() => fs.utimesSync(`${file}.lock`, new Date(), new Date()), 100);
    return () => {
      clearInterval(timer);
      fs.rmSync(`${file}.lock`, { recursive: true, force: true });
    };
  };

  it.skipIf(process.platform === 'win32')('a failed update leaves the previous entry in place and never calls `claude mcp remove`', async () => {
    const old = { type: 'stdio', command: 'C:\\Old VS Code\\Code.exe', args: ['C:\\Users\\u\\.vscode-agent-bridge\\bin\\mcp-server.js'], env: { ELECTRON_RUN_AS_NODE: '1' } };
    fs.writeFileSync(file, JSON.stringify({ ...existing, mcpServers: { ...existing.mcpServers, vscode: old } }));
    const { cli, calls } = fakeCli();
    const release = holdLock();
    try {
      const result = await registerClaude({ configFile: file, configDir: dir, cli, lockTimeoutMs: 300 }, spec);
      expect(result.kind).toBe('failed');
      expect(result.detail).toMatch(/previous entry is unchanged/);
    } finally {
      release();
    }
    expect(read().mcpServers.vscode).toEqual(old);
    expect(calls()).toEqual([]);
    // Once the lock is free, the same update goes through in one step.
    expect(await registerClaude({ configFile: file, configDir: dir, cli }, spec)).toMatchObject({ kind: 'changed', detail: 'updated', via: 'file' });
    expect(read().mcpServers.vscode.command).toBe(spec.command);
    expect(calls()).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('a new entry falls back to the file when `claude mcp add-json` fails', async () => {
    fs.writeFileSync(file, JSON.stringify(existing));
    const { cli, calls } = fakeCli();
    const result = await registerClaude({ configFile: file, configDir: dir, cli }, spec);
    expect(result).toMatchObject({ kind: 'changed', via: 'file' });
    expect(result.detail).toMatch(/Lock file is already being held/);
    expect(calls()).toEqual(['mcp add-json']);
    expect(read().mcpServers.vscode.command).toBe(spec.command);
  });
});

describe('Windows entries (simulated: win32 paths, case-insensitive)', () => {
  const stable = 'C:\\Users\\u\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe';
  const insiders = 'C:\\Users\\u\\AppData\\Local\\Programs\\Microsoft VS Code Insiders\\Code - Insiders.exe';
  const binDir = 'C:\\Users\\u\\.vscode-agent-bridge\\bin';
  const installed = new Set([stable, insiders]);
  const exists = (f: string) => installed.has(f);
  const specOf = (runtime: string) => serverSpec({ binDir, runtime, platform: 'win32', knownRuntimes: [stable, insiders], exists });

  it('Stable and Insiders accept each other\'s entry while both are installed: no rewrite on every start', async () => {
    fs.writeFileSync(file, JSON.stringify(existing));
    expect(await registerClaude(direct(), specOf(stable))).toMatchObject({ kind: 'changed', detail: 'registered' });
    const text = fs.readFileSync(file, 'utf8');
    expect(inspectClaude(file, specOf(insiders)).state).toMatchObject({ kind: 'ours', current: true });
    expect(await registerClaude(direct(), specOf(insiders))).toMatchObject({ kind: 'unchanged' });
    expect(fs.readFileSync(file, 'utf8')).toBe(text);
  });

  it('rewrites once when the runtime the entry names is uninstalled, and says why', async () => {
    fs.writeFileSync(file, JSON.stringify(existing));
    await registerClaude(direct(), specOf(stable));
    installed.delete(stable);
    try {
      const spec = specOf(insiders);
      const state = inspectClaude(file, spec).state;
      expect(state).toMatchObject({ kind: 'ours', current: false });
      expect(state.kind === 'ours' && state.reason).toMatch(/runtime it starts no longer exists/);
      expect(await registerClaude(direct(), spec)).toMatchObject({ kind: 'changed', detail: 'updated' });
      expect(read().mcpServers.vscode.command).toBe(insiders);
    } finally {
      installed.add(stable);
    }
  });

  it('ignores case and slash differences in Windows paths', () => {
    const lower = { type: 'stdio', command: stable.toLowerCase(), args: [specOf(stable).args[0]!.replace(/\\\\/g, '/')], env: { ELECTRON_RUN_AS_NODE: '1' } };
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { vscode: lower } }));
    expect(inspectClaude(file, specOf(stable)).state).toMatchObject({ kind: 'ours', current: true });
  });

  it('finds claude.exe on a Windows Path and reports an npm claude.cmd it cannot use', () => {
    const files = new Set(['C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd']);
    const has = (f: string) => files.has(f);
    // Windows: a copied env object keeps the case "Path"; directories may be quoted.
    const env = { Path: 'C:\\Windows\\system32;C:\\Users\\u\\AppData\\Roaming\\npm;"C:\\Program Files\\Claude"' };
    expect(locateClaudeCli(env, 'C:\\Users\\u', 'win32', [], has)).toEqual({ cli: undefined, shims: ['C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd'] });
    files.add('C:\\Program Files\\Claude\\claude.exe');
    expect(locateClaudeCli(env, 'C:\\Users\\u', 'win32', [], has).cli).toBe('C:\\Program Files\\Claude\\claude.exe');
    files.add('C:\\Users\\u\\.local\\bin\\claude.exe');
    expect(locateClaudeCli({}, 'C:\\Users\\u', 'win32', [], has).cli).toBe('C:\\Users\\u\\.local\\bin\\claude.exe');
  });
});

describe('Claude Code turned the server off in a project', () => {
  it('is reported', () => {
    fs.writeFileSync(file, JSON.stringify({ projects: { '/p': { disabledMcpServers: ['vscode'] }, '/q': { disabledMcpServers: ['x'] } } }));
    expect(inspectClaude(file, spec).disabledIn).toEqual(['/p']);
  });
});

const cli = process.platform === 'win32' ? undefined : findClaudeCli(process.env, os.homedir(), process.platform);

describe.skipIf(!cli)('registerClaude with the real claude CLI (temporary CLAUDE_CONFIG_DIR)', () => {
  const target = (): ClaudeTarget => ({ configFile: file, configDir: dir, cli });

  it('registers, updates and unregisters through `claude mcp`, which Claude Code then lists', async () => {
    fs.writeFileSync(file, JSON.stringify(existing, null, 2), { mode: 0o600 });
    const withEnv: ServerSpec = { ...spec, env: { AGENT_BRIDGE_HOME: '/tmp/x' } };
    expect(await registerClaude(target(), withEnv)).toMatchObject({ kind: 'changed', via: 'cli' });
    expect(read().mcpServers.github).toEqual(existing.mcpServers.github);
    const listed = execFileSync(cli!, ['mcp', 'get', 'vscode'], { env: { ...process.env, CLAUDE_CONFIG_DIR: dir }, encoding: 'utf8', cwd: dir });
    expect(listed).toMatch(/Scope: User config/);
    expect(listed).toContain(spec.command);
    expect(await registerClaude(target(), withEnv)).toMatchObject({ kind: 'unchanged' });
    // An update is one atomic edit of the file, never `claude mcp remove` + `add-json`.
    expect(await registerClaude(target(), spec)).toMatchObject({ kind: 'changed', detail: 'updated', via: 'file' });
    expect(await unregisterClaude(target(), spec)).toMatchObject({ kind: 'changed', via: 'cli' });
    expect(read().mcpServers).toEqual(existing.mcpServers);
  }, 60_000);
});
