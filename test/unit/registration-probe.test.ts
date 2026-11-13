// The start test: runs a registered command the way an agent does, against stand-in servers that
// behave well or fail in the ways that make an agent show a server as failed or closed.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { childEnv, diagnose, handshake, type Launch } from '../../src/extension/registration/probe';

let dir: string;
beforeAll(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-probe-'))));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

/** A server script; registered like the Windows entry: the runtime itself, the script as argument. */
function server(name: string, body: string): Launch {
  const file = path.join(dir, `${name}.cjs`);
  fs.writeFileSync(file, body);
  return { command: process.execPath, args: [file], env: { ELECTRON_RUN_AS_NODE: '1' } };
}

const MCP = `
const rl = require('readline').createInterface({ input: process.stdin });
const send = m => process.stdout.write(JSON.stringify(m) + '\\n');
rl.on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: {}, serverInfo: { name: 'vscode', version: '9.9.9' } } });
  if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'window_status' }, { name: 'window_select' }], noConnect: process.argv.includes('--no-connect') } });
});
`;

const options = () => ({ baseEnv: process.env, cwd: dir, timeoutMs: 8000 });

describe('handshake', () => {
  it('passes for a server that answers and ends when its input closes', async () => {
    const result = await handshake(server('good', `${MCP}\nprocess.stdin.on('end', () => process.exit(0));`), options());
    expect(result).toMatchObject({ ok: true, server: 'vscode 9.9.9', tools: ['window_status', 'window_select'], exitCode: 0 });
    expect(result.text).toMatch(/ended when its input closed/);
  });

  it('reports a server that exits at once, with its stderr', async () => {
    const result = await handshake(server('crash', `process.stderr.write('Error: Cannot find module mcp-server.js\\n'); process.exit(3);`), options());
    expect(result.ok).toBe(false);
    expect(result.text).toMatch(/exited before answering the MCP handshake \(exit code 3\)/);
    expect(result.stderr).toContain('Cannot find module');
  });

  it('reports a server that keeps running after its input closed (orphans on Windows)', async () => {
    const result = await handshake(server('linger', `${MCP}\nsetInterval(() => {}, 1000);`), options());
    expect(result).toMatchObject({ ok: true, lingered: true });
    expect(result.text).toMatch(/kept running/);
  }, 15_000);

  it('reports a server that writes something other than MCP to stdout', async () => {
    const result = await handshake(server('noisy', `console.log('hello from a dependency'); setInterval(() => {}, 1000);`), options());
    expect(result.ok).toBe(false);
    expect(result.text).toMatch(/not MCP to stdout: hello from a dependency/);
  });

  it('reports a runtime that does not exist (VS Code moved or was uninstalled)', async () => {
    const result = await handshake({ command: path.join(dir, 'gone', 'Code.exe'), args: ['x.js'], env: {} }, options());
    expect(result.ok).toBe(false);
    expect(result.text).toMatch(/could not be started: .*ENOENT/);
  });

  it('passes --no-connect, so the test creates no agent session in the window', async () => {
    const file = path.join(dir, 'args.cjs');
    fs.writeFileSync(file, `${MCP}\nrequire('fs').writeFileSync(${JSON.stringify(path.join(dir, 'argv.json'))}, JSON.stringify(process.argv.slice(2)));\nprocess.stdin.on('end', () => process.exit(0));`);
    await handshake({ command: process.execPath, args: [file], env: {} }, options());
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'argv.json'), 'utf8'))).toEqual(['--no-connect']);
  });
});

describe('diagnose', () => {
  const report = (selected: object | null, extra = '') =>
    server(
      `diag-${Math.random().toString(36).slice(2)}`,
      `process.stdout.write(JSON.stringify({ version: '1', runtime: { execPath: 'rt', node: 'v22' }, ancestry: { method: 'wmic', ms: 900, errors: ['powershell: blocked by policy'] }, selected: ${JSON.stringify(selected)}, problem: 'no window', ping: ${selected ? "{ ok: true, ms: 3 }" : 'null'} }));${extra}`,
    );

  it('says whether it finds this window, and how it looked up processes', async () => {
    const ok = await diagnose(report({ id: '42', matchedBy: 'ancestor' }), { ...options(), windowId: '42' });
    expect(ok.ok).toBe(true);
    expect(ok.text).toMatch(/finds this window \(matched by ancestor\), and the window answers \(3 ms\); process lookup: wmic in 900 ms \(powershell: blocked by policy\)/);
    const other = await diagnose(report({ id: '43', matchedBy: 'cwd' }), { ...options(), windowId: '42' });
    expect(other).toMatchObject({ ok: false });
    expect(other.text).toMatch(/connects to window 43 instead/);
    const none = await diagnose(report(null), { ...options(), windowId: '42' });
    expect(none.text).toMatch(/finds no window: no window/);
  });
});

describe('the environment an agent gives the server', () => {
  it('drops the extension host\'s own variables and adds the registration\'s', () => {
    const env = childEnv({ command: 'x', args: [], env: { ELECTRON_RUN_AS_NODE: '1', AGENT_BRIDGE_HOME: '/h' } }, { PATH: '/bin', ELECTRON_RUN_AS_NODE: '1', AGENT_BRIDGE_INSTANCE: '7' });
    expect(env).toEqual({ PATH: '/bin', ELECTRON_RUN_AS_NODE: '1', AGENT_BRIDGE_HOME: '/h' });
    expect(childEnv({ command: 'x', args: [], env: {} }, { ELECTRON_RUN_AS_NODE: '1' })).toEqual({});
  });
});
