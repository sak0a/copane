// MCP stdio server. One process per agent session, spawned by the agent (Claude Code, Codex, ...).
// It finds the VS Code window the agent runs in, connects to that window's bridge and forwards the
// tool list and tool calls. It holds no tool logic of its own.
//
//   mcp-server.js               serve MCP on stdin/stdout
//   mcp-server.js --diagnose    print, as JSON, which window it would connect to and why, then exit
//   mcp-server.js --version
//
// stdout carries MCP messages only. Everything else goes to stderr, which agents put in their logs.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { bridgeHome, readLiveInstances } from '../shared/paths';
import { ancestorPids } from './ancestors';
import { BridgeClient, sessionKeyFrom } from './bridgeClient';
import { explainNoMatch, selectInstance } from './discovery';
import { createProxyServer } from './proxy';

declare const __VERSION__: string | undefined;
const VERSION = typeof __VERSION__ === 'string' ? __VERSION__ : '0.0.0-dev';

// Anything a dependency prints with console.log would corrupt the MCP stream.
for (const method of ['log', 'info', 'debug', 'warn'] as const) console[method] = console.error;

function log(message: string): void {
  process.stderr.write(`[agent-bridge] ${message}\n`);
}

async function diagnose(): Promise<void> {
  const instances = readLiveInstances();
  const ancestors = await ancestorPids();
  const found = selectInstance({ instances, env: process.env, cwd: process.cwd(), ancestors });
  const report = {
    version: VERSION,
    runtime: { execPath: process.execPath, node: process.version, platform: process.platform },
    bridgeHome: bridgeHome(),
    cwd: process.cwd(),
    windows: instances.map(i => ({ id: i.id, workspace: i.workspaceName, folders: i.workspaceFolders, remoteName: i.remoteName })),
    selected: found ? { id: found.instance.id, matchedBy: found.matchedBy, note: found.note ?? null } : null,
    problem: found ? null : explainNoMatch({ instances, cwd: process.cwd(), env: process.env }),
  };
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}

async function serve(): Promise<void> {
  const bridge = new BridgeClient({
    env: process.env,
    cwd: process.cwd(),
    pid: process.pid,
    sessionKey: sessionKeyFrom(process.env),
    readInstances: () => readLiveInstances(),
    ancestors: () => ancestorPids(),
    log,
  });
  const server = createProxyServer(bridge, { version: VERSION, initWaitMs: 3000 });
  await server.connect(new StdioServerTransport());
  // The agent closing our stdin means the session ended.
  process.stdin.on('close', () => {
    bridge.dispose();
    process.exit(0);
  });
}

const args = process.argv.slice(2);
const main = args.includes('--version')
  ? async () => void process.stdout.write(`${VERSION}\n`)
  : args.includes('--diagnose')
    ? diagnose
    : serve;
main().catch(err => {
  log(`fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
