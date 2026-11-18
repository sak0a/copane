#!/usr/bin/env node
// Calls the extension's tools the way an agent does: through the real MCP stdio server (dist/mcp-server.js).
//
//   node scripts/mcp-call.mjs [options] --list
//   node scripts/mcp-call.mjs [options] <tool> ['<json arguments>']
//   node scripts/mcp-call.mjs [options] --repl          # one "<tool> <json>" per line on stdin, one session
//
// Options:
//   --name <name>       dev host to talk to (default "dev"; see scripts/dev-host.mjs)
//   --session <key>     session key; calls with the same key within the grace period are one agent session
//   --client <name>     MCP client name to present (default "claude-code")
//   --cwd <dir>         working directory of the MCP server (used to pick the window)
//   --instance <id>     connect to this window id instead of discovering one
//   --meta '<json>'     `_meta` to send with every tool call
//   --conversation <id> send `_meta["vscode.conversationId"]` with every tool call, as VS Code's chat does
//                       (with --client "Visual Studio Code"); in --repl, a line "@<id> <tool> <json>" sends
//                       that call in conversation <id>
// Images in results are written to .dev/shots/ and printed as file paths.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const options = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--list' || a === '--repl') options[a.slice(2)] = true;
  else if (a.startsWith('--')) options[a.slice(2)] = argv[++i];
  else positional.push(a);
}

const name = options.name ?? 'dev';
const home = join(process.platform === 'win32' ? process.env.TEMP : '/tmp', 'copane-dev', name, 'home');
const env = { ...process.env, COPANE_HOME: home };
delete env.COPANE_INSTANCE;
delete env.CLAUDE_CODE_SESSION_ID;
delete env.COPILOT_AGENT_SESSION_ID;
if (options.session) env.COPANE_SESSION = options.session;
if (options.instance) env.COPANE_INSTANCE = options.instance;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(root, 'dist', 'mcp-server.js')],
  env,
  cwd: options.cwd ?? join(home, '..', 'ws'),
  stderr: process.env.DEBUG ? 'inherit' : 'ignore',
});
const client = new Client({ name: options.client ?? 'claude-code', version: '0.0.0-test' });
await client.connect(transport);

let shot = 0;
function print(result) {
  for (const block of result.content ?? []) {
    if (block.type === 'text') console.log(block.text);
    else if (block.type === 'image') {
      const dir = join(root, '.dev', 'shots');
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${Date.now()}-${shot++}.${block.mimeType.split('/')[1] ?? 'png'}`);
      writeFileSync(file, Buffer.from(block.data, 'base64'));
      console.log(`[image] ${file}`);
    }
  }
  if (result.isError) console.log('[isError]');
}

const baseMeta = options.meta ? JSON.parse(options.meta) : {};
function metaFor(conversation) {
  const meta = { ...baseMeta, ...(conversation ? { 'vscode.conversationId': conversation } : {}) };
  return Object.keys(meta).length ? { _meta: meta } : {};
}

async function call(tool, json, conversation = options.conversation) {
  const result = await client.callTool({ name: tool, arguments: json ? JSON.parse(json) : {}, ...metaFor(conversation) }, undefined, { timeout: 600_000 });
  print(result);
  return !result.isError;
}

let ok = true;
if (options.list) {
  const { tools } = await client.listTools();
  for (const t of tools) console.log(`${t.name}\n    ${t.description.split('\n')[0]}`);
  if (tools.length === 0) console.log('(no tools: not connected to a window?)');
} else if (options.repl) {
  for await (const line of createInterface({ input: process.stdin })) {
    let trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    console.log(`> ${trimmed}`);
    let conversation = options.conversation;
    if (trimmed.startsWith('@')) {
      const end = trimmed.indexOf(' ');
      conversation = end < 0 ? trimmed.slice(1) : trimmed.slice(1, end);
      trimmed = end < 0 ? '' : trimmed.slice(end + 1).trim();
    }
    const space = trimmed.indexOf(' ');
    const tool = space < 0 ? trimmed : trimmed.slice(0, space);
    try {
      ok = (await call(tool, space < 0 ? '' : trimmed.slice(space + 1), conversation)) && ok;
    } catch (err) {
      ok = false;
      console.log(`[error] ${err.message}`);
    }
  }
} else if (positional[0]) {
  ok = await call(positional[0], positional[1]);
} else {
  console.error('usage: mcp-call.mjs [--name n] [--session key] (--list | --repl | <tool> [json])');
  ok = false;
}
await client.close();
process.exit(ok ? 0 : 1);
