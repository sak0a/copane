import { describe, expect, it } from 'vitest';
import { renderStatus, type StatusData } from '../../src/extension/registration/status';

function data(over: Partial<StatusData> = {}): StatusData {
  return {
    generatedAt: new Date('2026-11-13T00:00:00Z'),
    extensionVersion: '0.1.0',
    vscode: { appName: 'Visual Studio Code', version: '1.146.0', remoteName: null, platform: 'darwin', arch: 'arm64' },
    window: { id: '42', socketPath: '/h/run/42.sock', listening: true, instanceFile: '/h/instances/42.json', instanceFilePresent: true, workspaceName: 'shop', folders: ['/w/shop'] },
    otherWindows: [{ id: '43', workspaceName: 'blog', folders: ['/w/blog'], remoteName: 'wsl' }],
    bridgeHome: '/h',
    browser: { available: false, argvPath: '/u/.vscode/argv.json', argvState: { kind: 'enabled' }, remote: false },
    server: { spec: { command: '/h/bin/mcp-server', args: [], env: {} }, installedVersion: '0.1.0', runtimes: ['/rt'], selfTest: { ok: true, text: 'finds this window (matched by ancestor).' } },
    registrationMode: 'ask',
    consent: 'granted (claude-code)',
    agents: [
      { name: 'Claude Code', enabled: true, detected: true, detectedBy: 'claude at /bin/claude', configFile: '/u/.claude.json', state: { kind: 'ours', current: true, command: '/h/bin/mcp-server' }, notes: [] },
      { name: 'Codex', enabled: true, detected: true, detectedBy: 'codex', configFile: '/u/.codex/config.toml', state: { kind: 'foreign', command: 'npx other' }, notes: [] },
      {
        name: 'GitHub Copilot',
        enabled: true,
        detected: true,
        detectedBy: 'copilot at /bin/copilot',
        configFile: '/u/.copilot/mcp-config.json',
        state: { kind: 'ours', current: false, command: '/h/bin/mcp-server', reason: 'it does not pass COPANE_INSTANCE through to the server' },
        notes: ['PROBLEM: Copilot has the "copane" server turned off: run `copilot mcp enable copane`.'],
      },
    ],
    sessions: [{ label: 'Claude 1', title: 'checkout', client: 'claude-code 2.1.323', connected: true, matchedBy: 'ancestor', pid: 7, cwd: '/w/shop' }],
    ...over,
  };
}

describe('renderStatus', () => {
  it('answers the usual questions in one report', () => {
    const text = renderStatus(data());
    expect(text).toContain('Window id: 42');
    expect(text).toContain('listening ✓');
    expect(text).toContain('43: blog — /w/blog [wsl]');
    expect(text).toMatch(/enabled in argv\.json, but VS Code has not been restarted/);
    expect(text).toMatch(/### Claude Code[\s\S]*registered ✓/);
    expect(text).toMatch(/### Codex[\s\S]*another server named "copane" is configured, not Copane's: npx other/);
    expect(text).toMatch(/### GitHub Copilot\n- Installed: yes \(copilot at \/bin\/copilot\)\n- Config: \/u\/\.copilot\/mcp-config\.json\n- MCP server "copane": registered, but outdated/);
    expect(text).toContain('- Out of date because it does not pass COPANE_INSTANCE through to the server');
    expect(text).toContain('- PROBLEM: Copilot has the "copane" server turned off: run `copilot mcp enable copane`.');
    expect(text).toMatch(/In Claude Code and the Copilot CLI, `\/mcp` lists the "copane" server/);
    expect(text).toContain('Self-test (started the way an agent would, from this window): ok ✓');
    expect(text).toContain('Claude 1 · checkout — claude-code 2.1.323, connected; found this window: started by an extension in this window');
  });

  it('says what to do when nothing is connected or broken', () => {
    const text = renderStatus(
      data({
        window: { ...data().window, listening: false, instanceFilePresent: false },
        browser: { available: false, argvPath: undefined, argvState: undefined, remote: true },
        sessions: [],
      }),
    );
    expect(text).toContain('NOT listening');
    expect(text).toContain('MISSING: agents cannot find this window');
    expect(text).toMatch(/remote window: argv\.json is on your local machine/);
    expect(text).toMatch(/None connected\. Start a new agent session/);
  });

  it('has what is needed to diagnose a Windows failure remotely', () => {
    const win = 'C:\\Users\\u\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe';
    const script = 'C:\\Users\\u\\.copane\\bin\\mcp-server.js';
    const text = renderStatus(
      data({
        vscode: { appName: 'Visual Studio Code', version: '1.146.0', remoteName: null, platform: 'win32', arch: 'x64' },
        platform: {
          os: 'Windows_NT 10.0.26100 (win32)',
          arch: 'x64',
          runtime: win,
          node: 'v22.1.0',
          electron: '37.0.0',
          appHost: 'desktop',
          uiKind: 'desktop',
          shell: 'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
          env: { CLAUDE_CONFIG_DIR: undefined },
        },
        agents: [
          {
            name: 'Claude Code',
            enabled: true,
            detected: true,
            detectedBy: 'config file',
            configFile: 'C:\\Users\\u\\.claude.json',
            state: { kind: 'ours', current: false, command: `C:\\old\\Code.exe ${script}`, reason: 'the runtime it starts no longer exists (C:\\old\\Code.exe)' },
            notes: ['PROBLEM: Claude Code has the "copane" server turned off in the project C:\\w.'],
            registered: { command: 'C:\\old\\Code.exe', args: [script], env: { ELECTRON_RUN_AS_NODE: '1' }, commandExists: false, scriptExists: true },
          },
        ],
        server: {
          spec: { command: win, args: [script], env: { ELECTRON_RUN_AS_NODE: '1' } },
          installedVersion: '0.1.0',
          runtimes: [win],
          selfTest: { ok: false, text: 'finds no window', stderr: '' },
          handshake: { ok: false, text: 'the server exited before answering the MCP handshake (exit code 1)', stderr: 'Error: EPERM: operation not permitted\r\n    at open' },
          scriptPath: script,
          scriptExists: true,
        },
        history: [
          { at: '2026-11-12T09:00:00.000Z', agent: 'Claude Code', action: 'update', trigger: 'startup', reason: 'out of date', outcome: 'failed', detail: 'locked; the previous entry is unchanged', before: 'C:\\old\\Code.exe x' },
        ],
      }),
    );
    expect(text).toContain('## Platform');
    expect(text).toContain('OS: Windows_NT 10.0.26100 (win32) (x64)');
    expect(text).toContain('Electron 37.0.0');
    expect(text).toContain('CLAUDE_CONFIG_DIR=(unset)');
    expect(text).toContain('Registered command: "C:\\\\old\\\\Code.exe" — DOES NOT EXIST');
    expect(text).toContain('script exists ✓');
    expect(text).toContain('Registered env: ELECTRON_RUN_AS_NODE=1');
    expect(text).toContain('Out of date because the runtime it starts no longer exists');
    expect(text).toContain('PROBLEM: Claude Code has the "copane" server turned off');
    expect(text).toMatch(/Start test \(MCP handshake[^)]*\): FAILED\n  the server exited before answering/);
    expect(text).toContain('  Error: EPERM: operation not permitted');
    expect(text).toContain('## Recent registration changes');
    expect(text).toContain('Claude Code · update (startup) → failed: locked; the previous entry is unchanged. Why: out of date; was: C:\\old\\Code.exe x');
    expect(text).toContain('Check and Repair Setup');
  });
});
