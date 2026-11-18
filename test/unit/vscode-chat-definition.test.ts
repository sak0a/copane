import { describe, expect, it } from 'vitest';
import { agentKind, sessionKeyFrom } from '../../src/mcp/bridgeClient';
import { serverDefinitions, SERVER_LABEL } from '../../src/extension/vscodeChat/definition';

const unixSpec = { command: '/home/me/.copane/bin/mcp-server', args: [], env: {} };
const base = { enabled: true, spec: unixSpec, installError: undefined, instanceId: '4242', version: '0.3.0' };

describe('serverDefinitions', () => {
  it('offers nothing while the setting is off', () => {
    const result = serverDefinitions({ ...base, enabled: false });
    expect(result.definitions).toEqual([]);
    expect(result.reason).toMatch(/copane\.vscodeChat\.serverDefinition is off/);
  });

  it('offers the launcher with COPANE_INSTANCE naming this window', () => {
    const { definitions, reason } = serverDefinitions(base);
    expect(reason).toBeUndefined();
    expect(definitions).toEqual([{ label: SERVER_LABEL, command: unixSpec.command, args: [], env: { COPANE_INSTANCE: '4242' }, version: '0.3.0' }]);
    expect(SERVER_LABEL).toBe('copane');
  });

  it('keeps the env the launcher needs (bridge home override; the runtime flag on Windows)', () => {
    const spec = {
      command: 'C:\\Program Files\\Microsoft VS Code\\Code.exe',
      args: ['C:\\Users\\me\\.copane\\bin\\mcp-server.js'],
      env: { COPANE_HOME: 'C:\\tmp\\home', ELECTRON_RUN_AS_NODE: '1' },
    };
    const [def] = serverDefinitions({ ...base, spec }).definitions;
    expect(def).toMatchObject({ command: spec.command, args: spec.args, env: { COPANE_HOME: 'C:\\tmp\\home', ELECTRON_RUN_AS_NODE: '1', COPANE_INSTANCE: '4242' } });
    // A copy: VS Code may change a definition it is given.
    def!.args.push('x');
    expect(spec.args).toHaveLength(1);
  });

  it('never passes a session key or a working directory', () => {
    const [def] = serverDefinitions({ ...base, spec: { ...unixSpec, env: { COPANE_HOME: '/h' } } }).definitions;
    expect(Object.keys(def!.env).sort()).toEqual(['COPANE_HOME', 'COPANE_INSTANCE']);
    expect(def).not.toHaveProperty('cwd');
  });

  it('offers nothing when the server is not installed or the launcher is unknown, and says why', () => {
    expect(serverDefinitions({ ...base, installError: 'EACCES' })).toEqual({ definitions: [], reason: 'the MCP server could not be installed: EACCES' });
    expect(serverDefinitions({ ...base, spec: undefined }).reason).toMatch(/launcher is not known/);
  });
});

describe('VS Code as the MCP client', () => {
  // VS Code's MCP client calls itself by its product name (productService.nameLong).
  it.each(['Visual Studio Code', 'Visual Studio Code - Insiders', 'Code - OSS'])('%s is a generic agent with its own session key', name => {
    expect(agentKind(name)).toBe('other');
    // Variables another agent left in VS Code's environment are not taken over.
    const key = sessionKeyFrom({ CLAUDE_CODE_SESSION_ID: 'claude-1', COPILOT_AGENT_SESSION_ID: 'copilot-1' }, name);
    expect(key).not.toBe('claude-1');
    expect(key).not.toBe('copilot-1');
  });
});
