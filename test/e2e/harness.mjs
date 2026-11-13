// Shared helpers for end-to-end tests. An e2e test is a plain Node script that talks to a running
// dev host through the real MCP server, exactly as an agent does:
//
//   node scripts/dev-host.mjs --name <n>
//   node test/e2e/<module>.e2e.mjs --name <n>      # exits 0 when every case passes
//
// See core.e2e.mjs for the shape.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export { assert };
export const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const nameIndex = process.argv.indexOf('--name');
/** The dev host under test (`--name`, default "dev"). */
export const hostName = nameIndex >= 0 ? process.argv[nameIndex + 1] : 'dev';
export const hostDir = join(process.platform === 'win32' ? process.env.TEMP : '/tmp', 'agent-bridge-dev', hostName);

/**
 * Starts an MCP server process and connects to it: one agent session. `session` is the session key
 * (omit for a fresh one each time), `client` the MCP client name ("claude-code", "codex", ...).
 */
export async function agent({ session, client = 'claude-code', cwd, env = {} } = {}) {
  const childEnv = { ...process.env, AGENT_BRIDGE_HOME: join(hostDir, 'home'), ...env };
  delete childEnv.AGENT_BRIDGE_INSTANCE;
  delete childEnv.CLAUDE_CODE_SESSION_ID;
  if (session) childEnv.AGENT_BRIDGE_SESSION = session;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(root, 'dist', 'mcp-server.js')],
    env: childEnv,
    cwd: cwd ?? join(hostDir, 'ws'),
    stderr: process.env.DEBUG ? 'inherit' : 'ignore',
  });
  const mcp = new Client({ name: client, version: '0.0.0-e2e' });
  await mcp.connect(transport);
  return {
    mcp,
    /** Calls a tool. Returns `{ text, images, isError }`; `text` joins all text blocks. */
    async call(tool, args = {}, { timeoutMs = 120_000 } = {}) {
      const result = await mcp.callTool({ name: tool, arguments: args }, undefined, { timeout: timeoutMs });
      const blocks = result.content ?? [];
      return {
        text: blocks.filter(b => b.type === 'text').map(b => b.text).join('\n'),
        images: blocks.filter(b => b.type === 'image'),
        isError: result.isError === true,
      };
    },
    /** Like `call`, but throws when the tool reports an error. Returns the text. */
    async ok(tool, args, options) {
      const result = await this.call(tool, args, options);
      assert.ok(!result.isError, `${tool} failed: ${result.text}`);
      return result.text;
    },
    async tools() {
      return (await mcp.listTools()).tools;
    },
    close: () => mcp.close(),
  };
}

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Polls until `fn` returns a truthy value; throws with `what` after the timeout. */
export async function until(fn, what = 'condition', { timeoutMs = 10_000, intervalMs = 150 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(intervalMs);
  }
}

const cases = [];
/** Registers a test case. Cases run in order; a failure does not stop the others. */
export function test(name, fn) {
  cases.push({ name, fn });
}

/** Runs the registered cases and exits with 0 (all passed) or 1. `--only <text>` filters by name. */
export async function run() {
  const onlyIndex = process.argv.indexOf('--only');
  const only = onlyIndex >= 0 ? process.argv[onlyIndex + 1] : undefined;
  let failed = 0;
  for (const { name, fn } of cases) {
    if (only && !name.includes(only)) continue;
    const started = Date.now();
    try {
      await fn();
      console.log(`PASS  ${name}  (${Date.now() - started} ms)`);
    } catch (err) {
      failed++;
      console.log(`FAIL  ${name}\n      ${String(err?.stack ?? err).split('\n').join('\n      ')}`);
    }
  }
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
}
