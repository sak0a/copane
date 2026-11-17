// MCP stdio server. One process per agent session, spawned by the agent (Claude Code, Codex, ...).
// It finds the VS Code window the agent runs in, connects to that window's bridge and forwards the
// tool list and tool calls. It holds no tool logic of its own.
//
//   mcp-server.js               serve MCP on stdin/stdout
//   mcp-server.js --diagnose    print, as JSON, which window it would connect to and why (and whether
//                               that window answers), then exit
//   mcp-server.js --no-connect  serve MCP without ever connecting to a window: the extension's start
//                               test, which must not create an agent session in the user's window
//   mcp-server.js --version
//
// stdout carries MCP messages only. Everything else goes to stderr, which agents put in their logs.
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { RpcPeer } from '../shared/jsonrpc';
import { bridgeHome, readLiveInstances } from '../shared/paths';
import { Methods, type InstanceInfo } from '../shared/protocol';
import { ancestorPids, lookupAncestors } from './ancestors';
import { BridgeClient, sessionKeyFrom } from './bridgeClient';
import { explainNoMatch, selectInstance } from './discovery';
import { createProxyServer } from './proxy';

declare const __VERSION__: string | undefined;
const VERSION = typeof __VERSION__ === 'string' ? __VERSION__ : '0.0.0-dev';

// Anything a dependency prints with console.log would corrupt the MCP stream.
for (const method of ['log', 'info', 'debug', 'warn'] as const) console[method] = console.error;

function log(message: string): void {
  process.stderr.write(`[copane] ${message}\n`);
}

// The agent drops a server whose process exits, so a stray rejection must not end the session.
process.on('unhandledRejection', err => log(`unhandled rejection (continuing): ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`));
process.on('uncaughtException', err => {
  log(`fatal: ${err.stack ?? err.message}`);
  process.exit(1);
});
// The agent went away while we were writing: nothing left to serve.
process.stdout.on('error', err => {
  if ((err as NodeJS.ErrnoException).code === 'EPIPE' || (err as NodeJS.ErrnoException).code === 'EOF') process.exit(0);
  log(`stdout: ${err.message}`);
});

/** Opens the window's socket and sends `ping` (no `hello`, so no session is created). */
function pingWindow(instance: InstanceInfo, timeoutMs = 3000): Promise<{ ok: boolean; ms: number; error: string | null }> {
  const started = Date.now();
  return new Promise(resolve => {
    let peer: RpcPeer | undefined;
    const done = (error: string | null) => {
      peer?.close();
      socket.destroy();
      resolve({ ok: !error, ms: Date.now() - started, error });
    };
    const socket = net.connect(instance.socketPath);
    socket.once('error', err => done(err.message));
    socket.once('connect', () => {
      peer = new RpcPeer(socket);
      peer.request(Methods.ping, undefined, { timeoutMs }).then(
        () => done(null),
        err => done(err instanceof Error ? err.message : String(err)),
      );
    });
  });
}

async function diagnose(): Promise<void> {
  const instances = readLiveInstances();
  const ancestry = await lookupAncestors();
  const found = selectInstance({ instances, env: process.env, cwd: process.cwd(), ancestors: ancestry.pids, realpath: p => fs.realpathSync.native(p), readFile: p => fs.readFileSync(p, 'utf8') });
  let username: string;
  try {
    username = os.userInfo().username;
  } catch (err) {
    username = `(unknown: ${err instanceof Error ? err.message : String(err)})`;
  }
  const report = {
    version: VERSION,
    runtime: { execPath: process.execPath, node: process.version, electron: process.versions.electron ?? null, platform: process.platform, arch: process.arch },
    os: { release: os.release(), username },
    bridgeHome: bridgeHome(),
    cwd: process.cwd(),
    ancestry: { method: ancestry.method, ms: ancestry.ms, count: ancestry.pids.length, errors: ancestry.errors },
    windows: instances.map(i => ({ id: i.id, workspace: i.workspaceName, folders: i.workspaceFolders, remoteName: i.remoteName })),
    selected: found ? { id: found.instance.id, matchedBy: found.matchedBy, note: found.note ?? null, socketPath: found.instance.socketPath } : null,
    ping: found ? await pingWindow(found.instance) : null,
    problem: found ? null : explainNoMatch({ instances, cwd: process.cwd(), env: process.env }),
  };
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}

async function serve(options: { connect: boolean }): Promise<void> {
  const bridge = new BridgeClient({
    env: process.env,
    cwd: process.cwd(),
    pid: process.pid,
    sessionKey: clientName => sessionKeyFrom(process.env, clientName),
    readInstances: options.connect ? () => readLiveInstances() : () => [],
    ancestors: options.connect ? () => ancestorPids() : async () => [],
    log,
  });
  const server = createProxyServer(bridge, { version: VERSION, initWaitMs: options.connect ? 3000 : 0 });
  await server.connect(new StdioServerTransport());
  // The agent closing our stdin means the session ended.
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    bridge.dispose();
    process.exit(0);
  };
  process.stdin.on('end', end);
  process.stdin.on('close', end);
}

const args = process.argv.slice(2);
const main = args.includes('--version')
  ? async () => void process.stdout.write(`${VERSION}\n`)
  : args.includes('--diagnose')
    ? diagnose
    : () => serve({ connect: !args.includes('--no-connect') });
main().catch(err => {
  log(`fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
