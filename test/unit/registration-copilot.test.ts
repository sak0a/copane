// GitHub Copilot registration: JSONC edits of mcp-config.json in a temporary COPILOT_HOME; checked
// with the real `copilot` CLI when installed (with COPILOT_HOME pointing into the temporary folder).
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse } from 'jsonc-parser';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  compareCopilotEntry,
  copilotConfigFile,
  copilotEntryFor,
  copilotHome,
  copilotSettingsFile,
  inspectCopilot,
  inspectCopilotText,
  registerCopilot,
  removeCopilotEntry,
  unregisterCopilot,
  upsertCopilotEntry,
} from '../../src/extension/registration/copilot';
import type { ServerSpec } from '../../src/extension/registration/launcher';

const spec: ServerSpec = { command: '/home/u/.copane/bin/mcp-server', args: [], env: {} };
const devSpec: ServerSpec = { command: '/tmp/copane-dev/r/home/bin/mcp-server', args: [], env: { COPANE_HOME: '/tmp/copane-dev/r/home' } };
const PASS = { COPANE_INSTANCE: '${COPANE_INSTANCE:-}', COPANE_SESSION: '${COPANE_SESSION:-}', COPILOT_SESSION_CWD: '${COPILOT_SESSION_CWD:-}' };

const USER_CONFIG = `// my Copilot servers
{
  "mcpServers": {
    // keep this comment
    "github": { "type": "http", "url": "https://example.com/mcp", "tools": ["*"] },
    "other": { "type": "local", "command": "npx", "args": ["other"], "tools": ["a", "b"], },
  },
  "somethingNew": { "x": 1 },
}
`;

const read = (file: string) => parse(fs.readFileSync(file, 'utf8'), [], { allowTrailingComma: true });

describe('copilot config location', () => {
  it('is ~/.copilot/mcp-config.json, or under COPILOT_HOME', () => {
    expect(copilotHome({}, '/h')).toBe(path.join('/h', '.copilot'));
    expect(copilotConfigFile({}, '/h')).toBe(path.join('/h', '.copilot', 'mcp-config.json'));
    expect(copilotConfigFile({ COPILOT_HOME: '/c' }, '/h')).toBe(path.join('/c', 'mcp-config.json'));
    expect(copilotConfigFile({ COPILOT_HOME: '  ' }, '/h')).toBe(path.join('/h', '.copilot', 'mcp-config.json'));
    expect(copilotSettingsFile({ COPILOT_HOME: '/c' }, '/h')).toBe(path.join('/c', 'settings.json'));
  });
});

describe('the entry and its comparison', () => {
  it('is what `copilot mcp add` writes, plus the pass-through references', () => {
    expect(copilotEntryFor(devSpec)).toEqual({ type: 'local', command: devSpec.command, args: [], env: { ...devSpec.env, ...PASS }, tools: ['*'], timeout: 600_000 });
  });

  it('accepts what the user may change: tools, timeout, type stdio, the default of a reference', () => {
    const entry = { ...copilotEntryFor(spec), type: 'stdio', tools: ['browser_click'], timeout: 900_000, cwd: '/w', env: { COPANE_INSTANCE: '${COPANE_INSTANCE}', COPANE_SESSION: '${COPANE_SESSION:-x}', COPILOT_SESSION_CWD: '${COPILOT_SESSION_CWD}' } };
    expect(compareCopilotEntry(entry, spec)).toEqual({ current: true });
  });

  it('is out of date without a timeout (Copilot would stop a call after its default), whatever value the user chose is fine', () => {
    const { timeout: _timeout, ...without } = copilotEntryFor(spec);
    expect(compareCopilotEntry(without, spec)).toEqual({ current: false, reason: expect.stringContaining('sets no timeout') });
    expect(compareCopilotEntry({ ...without, timeout: 45_000 }, spec)).toEqual({ current: true });
    // An entry as earlier versions wrote it gets the timeout and the session folder added.
    const before = { type: 'local', command: spec.command, args: [], env: { COPANE_INSTANCE: '${COPANE_INSTANCE:-}', COPANE_SESSION: '${COPANE_SESSION:-}' }, tools: ['*'] };
    expect(compareCopilotEntry(before, spec)).toEqual({ current: false, reason: 'it does not pass COPILOT_SESSION_CWD through to the server' });
    const updated = parse(upsertCopilotEntry(JSON.stringify({ mcpServers: { copane: before } }), spec), [], { allowTrailingComma: true });
    expect(updated.mcpServers.copane).toEqual(copilotEntryFor(spec));
  });

  it('is out of date when it does not pass the variables through, or starts something else', () => {
    expect(compareCopilotEntry({ ...copilotEntryFor(spec), env: { COPANE_SESSION: '${COPANE_SESSION:-}' } }, spec)).toEqual({
      current: false,
      reason: 'it does not pass COPANE_INSTANCE and COPILOT_SESSION_CWD through to the server',
    });
    expect(compareCopilotEntry({ ...copilotEntryFor(spec), env: { ...PASS, COPANE_INSTANCE: '42' } }, spec)).toMatchObject({ current: false });
    expect(compareCopilotEntry({ ...copilotEntryFor(spec), command: '/old/.copane/bin/mcp-server' }, spec)).toMatchObject({ current: false, reason: expect.stringContaining('/old/') });
    expect(compareCopilotEntry({ ...copilotEntryFor(spec), type: 'http' }, spec)).toMatchObject({ current: false });
    expect(compareCopilotEntry(copilotEntryFor(spec), { ...spec, env: devSpec.env })).toMatchObject({ current: false, reason: expect.stringContaining('COPANE_HOME') });
  });
});

describe('inspectCopilotText', () => {
  it('tells absent, ours (current or not), foreign and unreadable apart', () => {
    expect(inspectCopilotText(undefined, spec)).toEqual({ kind: 'absent' });
    expect(inspectCopilotText('', spec)).toEqual({ kind: 'absent' });
    expect(inspectCopilotText(USER_CONFIG, spec)).toEqual({ kind: 'absent' });
    const ours = JSON.stringify({ mcpServers: { copane: copilotEntryFor(spec) } });
    expect(inspectCopilotText(ours, spec)).toMatchObject({ kind: 'ours', current: true, entry: { command: spec.command, env: PASS } });
    expect(inspectCopilotText(ours, devSpec)).toMatchObject({ kind: 'ours', current: false });
    expect(inspectCopilotText(JSON.stringify({ mcpServers: { copane: { type: 'local', command: 'npx', args: ['their-server'] } } }), spec)).toEqual({ kind: 'foreign', command: 'npx their-server' });
    expect(inspectCopilotText('{ "mcpServers": { ', spec)).toMatchObject({ kind: 'unreadable' });
    expect(inspectCopilotText('[]', spec)).toMatchObject({ kind: 'unreadable' });
  });
});

describe('editing the text', () => {
  it('adds the entry and keeps comments, other servers and unknown keys', () => {
    const next = upsertCopilotEntry(USER_CONFIG, spec);
    expect(next).toContain('// my Copilot servers');
    expect(next).toContain('// keep this comment');
    const value = parse(next, [], { allowTrailingComma: true });
    expect(value.mcpServers.copane).toEqual(copilotEntryFor(spec));
    expect(value.mcpServers.other).toEqual({ type: 'local', command: 'npx', args: ['other'], tools: ['a', 'b'] });
    expect(value.mcpServers.github.url).toBe('https://example.com/mcp');
    expect(value.somethingNew).toEqual({ x: 1 });
    expect(inspectCopilotText(next, spec)).toMatchObject({ kind: 'ours', current: true });
  });

  it('creates the document when there is none', () => {
    const next = upsertCopilotEntry('', spec);
    expect(JSON.parse(next)).toEqual({ mcpServers: { copane: copilotEntryFor(spec) } });
  });

  it('updates its own entry in place, keeping the user\'s tools filter, timeout and other keys', () => {
    const old = { tools: ['browser_click', 'terminal_run'], type: 'stdio', command: '/old/.copane/bin/mcp-server', args: [], env: { COPANE_INSTANCE: '${COPANE_INSTANCE}' }, timeout: 900000, cwd: '/w' };
    const text = `{\n  // mine\n  "mcpServers": { "copane": ${JSON.stringify(old)}, "other": { "command": "x" } }\n}\n`;
    const next = upsertCopilotEntry(text, devSpec);
    expect(next).toContain('// mine');
    const value = parse(next, [], { allowTrailingComma: true });
    expect(value.mcpServers.copane).toEqual({
      tools: ['browser_click', 'terminal_run'],
      type: 'stdio',
      command: devSpec.command,
      args: [],
      env: { COPANE_HOME: devSpec.env.COPANE_HOME, COPANE_INSTANCE: '${COPANE_INSTANCE}', COPANE_SESSION: '${COPANE_SESSION:-}', COPILOT_SESSION_CWD: '${COPILOT_SESSION_CWD:-}' },
      timeout: 900000,
      cwd: '/w',
    });
    expect(value.mcpServers.other).toEqual({ command: 'x' });
    expect(inspectCopilotText(next, devSpec)).toMatchObject({ kind: 'ours', current: true });
  });

  it('removes only its own entry', () => {
    const next = removeCopilotEntry(upsertCopilotEntry(USER_CONFIG, spec));
    expect(next).toContain('// keep this comment');
    const value = parse(next, [], { allowTrailingComma: true });
    expect(value.mcpServers.copane).toBeUndefined();
    expect(Object.keys(value.mcpServers)).toEqual(['github', 'other']);
    expect(value.somethingNew).toEqual({ x: 1 });
  });
});

describe('registerCopilot / unregisterCopilot', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copane-copilot-'));
    file = copilotConfigFile({ COPILOT_HOME: dir }, '/nonexistent-home');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('registers into a missing file (creating COPILOT_HOME), is idempotent, and updates in one step', async () => {
    fs.rmSync(dir, { recursive: true, force: true });
    expect(await registerCopilot({ configFile: file }, spec)).toEqual({ kind: 'changed', detail: 'registered', via: 'file' });
    expect(read(file).mcpServers.copane).toEqual(copilotEntryFor(spec));
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(await registerCopilot({ configFile: file }, spec)).toEqual({ kind: 'unchanged', detail: 'already registered' });
    expect(await registerCopilot({ configFile: file }, devSpec)).toEqual({ kind: 'changed', detail: 'updated', via: 'file' });
    expect(read(file).mcpServers.copane.env.COPANE_HOME).toBe(devSpec.env.COPANE_HOME);
  });

  it('keeps other servers and unknown keys, and unregistering leaves them intact', async () => {
    fs.writeFileSync(file, USER_CONFIG);
    await registerCopilot({ configFile: file }, spec);
    expect(await unregisterCopilot({ configFile: file }, spec)).toEqual({ kind: 'changed', detail: 'removed', via: 'file' });
    const text = fs.readFileSync(file, 'utf8');
    expect(text).toContain('// keep this comment');
    expect(read(file)).toEqual(parse(USER_CONFIG, [], { allowTrailingComma: true }));
    expect(await unregisterCopilot({ configFile: file }, spec)).toEqual({ kind: 'unchanged', detail: 'not registered' });
  });

  it('a user\'s tools filter does not read as out of date and is kept', async () => {
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { copane: { ...copilotEntryFor(spec), tools: ['terminal_run'], timeout: 120000 } } }));
    expect(inspectCopilot(file, spec).state).toMatchObject({ kind: 'ours', current: true });
    expect(await registerCopilot({ configFile: file }, spec)).toMatchObject({ kind: 'unchanged' });
    expect(read(file).mcpServers.copane.tools).toEqual(['terminal_run']);
  });

  it('never touches someone else\'s "copane" server unless told to', async () => {
    const theirs = { type: 'local', command: 'npx', args: ['their-server'], tools: ['*'] };
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { copane: theirs } }));
    expect(await registerCopilot({ configFile: file }, spec)).toMatchObject({ kind: 'conflict', detail: expect.stringContaining('npx their-server') });
    expect(await unregisterCopilot({ configFile: file }, spec)).toMatchObject({ kind: 'conflict' });
    expect(read(file).mcpServers.copane).toEqual(theirs);
    expect(await registerCopilot({ configFile: file }, spec, { replaceForeign: true })).toMatchObject({ kind: 'changed', detail: 'replaced the other server' });
    expect(read(file).mcpServers.copane).toEqual(copilotEntryFor(spec));
  });

  it('changes nothing in a file it cannot parse', async () => {
    const broken = '{ "mcpServers": { "a": ';
    fs.writeFileSync(file, broken);
    expect(inspectCopilot(file, spec).state).toMatchObject({ kind: 'unreadable' });
    expect(await registerCopilot({ configFile: file }, spec)).toMatchObject({ kind: 'failed', detail: expect.stringContaining('not valid JSON') });
    expect(await unregisterCopilot({ configFile: file }, spec)).toMatchObject({ kind: 'failed' });
    expect(fs.readFileSync(file, 'utf8')).toBe(broken);
  });

  it('reports a server the user turned off with `copilot mcp disable`', () => {
    const settings = copilotSettingsFile({ COPILOT_HOME: dir }, '/h');
    expect(inspectCopilot(file, spec, settings).disabled).toBe(false);
    fs.writeFileSync(settings, JSON.stringify({ disabledMcpServers: ['copane'] }));
    expect(inspectCopilot(file, spec, settings)).toMatchObject({ configExists: false, disabled: true });
  });

  const copilot = (() => {
    try {
      execFileSync('copilot', ['--version'], { stdio: 'ignore', env: { ...process.env, COPILOT_HOME: path.join(os.tmpdir(), 'copane-copilot-version') } });
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(!copilot)('the real copilot CLI reads the entry next to the user\'s servers', async () => {
    fs.writeFileSync(file, USER_CONFIG);
    await registerCopilot({ configFile: file }, devSpec);
    // Reads only: `mcp list` makes no model request. COPILOT_HOME keeps it away from the real ~/.copilot.
    const listed = JSON.parse(execFileSync('copilot', ['mcp', 'list', '--json'], { env: { ...process.env, COPILOT_HOME: dir }, encoding: 'utf8', timeout: 30_000 }));
    expect(listed.mcpServers.copane).toMatchObject({ type: 'local', command: devSpec.command, env: { ...devSpec.env, ...PASS }, tools: ['*'], source: 'user', enabled: true });
    expect(listed.mcpServers.other).toBeTruthy();
  }, 30_000);
});

describe('contributes/registration.json', () => {
  it('has a setting for Copilot like the other agents', () => {
    const fragment = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'contributes', 'registration.json'), 'utf8'));
    const props = fragment.configuration.properties;
    expect(props['copane.registration.copilot']).toMatchObject({ type: 'boolean', default: true, scope: props['copane.registration.codex'].scope });
  });
});
