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
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export { assert };
export const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const nameIndex = process.argv.indexOf('--name');
/** The dev host under test (`--name`, default "dev"). */
export const hostName = nameIndex >= 0 ? process.argv[nameIndex + 1] : 'dev';
export const hostDir = join(process.platform === 'win32' ? process.env.TEMP : '/tmp', 'copane-dev', hostName);

/**
 * Starts an MCP server process and connects to it: one agent session. `session` is the session key
 * (omit for a fresh one each time), `client` the MCP client name ("claude-code", "codex", ...).
 */
export async function agent({ session, client = 'claude-code', cwd, env = {} } = {}) {
  const childEnv = { ...process.env, COPANE_HOME: join(hostDir, 'home'), ...env };
  delete childEnv.COPANE_INSTANCE;
  delete childEnv.CLAUDE_CODE_SESSION_ID;
  if (session) childEnv.COPANE_SESSION = session;
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
/**
 * Registers a test case. Cases run in order; a failure does not stop the others. `skip`: a reason
 * (string) to skip the case on this machine, printed as `SKIP  <name>  (<reason>)`; falsy runs it.
 */
export function test(name, fn, { skip } = {}) {
  cases.push({ name, fn, skip });
}

/** Why `command` cannot be run here, or undefined when `<command> <versionArg>` works. */
export function missingCommand(command, versionArg = '--version') {
  try {
    execFileSync(command, [versionArg], { stdio: 'ignore', timeout: 15_000 });
    return undefined;
  } catch {
    return `needs \`${command}\` on the PATH`;
  }
}

/** Why the IPv6 loopback address [::1] cannot be used here (CI containers often have no IPv6), or undefined. */
export async function missingIpv6Loopback() {
  return new Promise(resolve => {
    const probe = createServer();
    probe.once('error', () => resolve('needs the IPv6 loopback address [::1], which this machine does not have'));
    probe.listen(0, '::1', () => probe.close(() => resolve(undefined)));
  });
}

/** Why cases that load real public sites are skipped: COPANE_E2E_OFFLINE=1 (set in CI, where they would be flaky). */
export const offline = /^(1|true)$/i.test(process.env.COPANE_E2E_OFFLINE ?? '') ? 'loads a real public site; skipped with COPANE_E2E_OFFLINE=1' : undefined;

/** Runs the registered cases and exits with 0 (all passed) or 1. `--only <text>` filters by name. */
export async function run() {
  const onlyIndex = process.argv.indexOf('--only');
  const only = onlyIndex >= 0 ? process.argv[onlyIndex + 1] : undefined;
  let failed = 0;
  let skipped = 0;
  for (const { name, fn, skip } of cases) {
    if (only && !name.includes(only)) continue;
    if (skip) {
      skipped++;
      console.log(`SKIP  ${name}  (${skip})`);
      continue;
    }
    const started = Date.now();
    try {
      await fn();
      console.log(`PASS  ${name}  (${Date.now() - started} ms)`);
    } catch (err) {
      failed++;
      console.log(`FAIL  ${name}\n      ${String(err?.stack ?? err).split('\n').join('\n      ')}`);
    }
  }
  const skippedNote = skipped ? `, ${skipped} skipped` : '';
  console.log(failed ? `\n${failed} failed${skippedNote}` : `\nall passed${skippedNote}`);
  process.exit(failed ? 1 : 0);
}
