import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { compareVersions, installServer, launcherPath, serverSpec, unixLauncher } from '../../src/extension/registration/launcher';

let dir: string;
let source: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-launch-'));
  source = path.join(dir, 'dist-mcp-server.js');
  fs.writeFileSync(source, "process.stdout.write('server ' + process.argv.slice(2).join(' ') + ' ' + (process.env.ELECTRON_RUN_AS_NODE ?? '-'))");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const opts = (over: Partial<Parameters<typeof installServer>[0]> = {}) => ({
  binDir: path.join(dir, 'home', 'bin'),
  sourceScript: source,
  version: '1.2.0',
  runtime: process.execPath,
  platform: process.platform,
  ...over,
});

describe('serverSpec', () => {
  it('registers the stable launcher on unix and the runtime itself on Windows', () => {
    expect(serverSpec({ binDir: '/h/bin', runtime: '/rt', platform: 'darwin' })).toEqual({ command: '/h/bin/mcp-server', args: [], env: {} });
    expect(serverSpec({ binDir: '/h/bin', runtime: '/rt', platform: 'linux', bridgeHomeOverride: '/h' })).toEqual({
      command: '/h/bin/mcp-server',
      args: [],
      env: { AGENT_BRIDGE_HOME: '/h' },
    });
    const win = serverSpec({ binDir: 'C:\\h\\bin', runtime: 'C:\\VS Code\\Code.exe', platform: 'win32' });
    expect(win.command).toBe('C:\\VS Code\\Code.exe');
    expect(win.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' });
    expect(win.args[0]).toMatch(/mcp-server\.js$/);
  });
});

describe('installServer', () => {
  it('installs the script and the launcher once, then does nothing', () => {
    const first = installServer(opts());
    expect(first).toMatchObject({ version: '1.2.0', scriptUpdated: true, launcherUpdated: true });
    expect(fs.readFileSync(path.join(dir, 'home', 'bin', 'mcp-server.js'), 'utf8')).toBe(fs.readFileSync(source, 'utf8'));
    const second = installServer(opts());
    expect(second).toMatchObject({ scriptUpdated: false, launcherUpdated: false });
  });

  it('does not replace a newer server with an older one, but records the runtime', () => {
    installServer(opts({ version: '2.0.0' }));
    fs.writeFileSync(source, '// older build');
    const older = installServer(opts({ version: '1.0.0', runtime: '/other/runtime' }));
    expect(older.scriptUpdated).toBe(false);
    expect(older.version).toBe('2.0.0');
    expect(older.runtimes[0]).toBe('/other/runtime');
    const newer = installServer(opts({ version: '2.0.1' }));
    expect(newer.scriptUpdated).toBe(true);
    expect(newer.runtimes).not.toContain('/other/runtime'); // does not exist on disk
  });

  it.skipIf(process.platform === 'win32')('the launcher runs the script with the recorded runtime, and falls back to node', () => {
    installServer(opts());
    const launcher = launcherPath(path.join(dir, 'home', 'bin'), process.platform);
    expect(fs.statSync(launcher).mode & 0o111).not.toBe(0);
    expect(execFileSync(launcher, ['--diagnose'], { encoding: 'utf8' })).toBe('server --diagnose 1');
    // The recorded runtime is gone (VS Code was updated or uninstalled): `node` from the PATH.
    const script = path.join(dir, 'home', 'bin', 'mcp-server.js');
    fs.writeFileSync(launcher, unixLauncher(['/gone/runtime'], script));
    const env = { ...process.env, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin` };
    expect(execFileSync(launcher, [], { encoding: 'utf8', env })).toMatch(/^server/);
  });

  it.skipIf(process.platform === 'win32')('quotes paths with spaces and quotes in the launcher', () => {
    const text = unixLauncher(["/Applications/Visual Studio Code.app/it's/Code Helper"], '/h/bin/mcp-server.js');
    expect(text).toContain(`'/Applications/Visual Studio Code.app/it'\\''s/Code Helper'`);
  });
});

describe('compareVersions', () => {
  it('compares numerically with pre-releases first', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.0-beta', '1.0.0')).toBe(-1);
    expect(compareVersions('1.0', '1.0.1')).toBe(-1);
  });
});
