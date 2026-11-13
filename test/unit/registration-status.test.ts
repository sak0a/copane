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
    expect(text).toMatch(/### Codex[\s\S]*another server named "vscode" is configured, not Agent Bridge's: npx other/);
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
    expect(text).toMatch(/None connected\. Start a new Claude Code session/);
  });
});
