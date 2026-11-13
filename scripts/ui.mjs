#!/usr/bin/env node
// Looks at the workbench UI of a dev host through its DevTools port: no mouse, no keyboard, no focus.
//
//   node scripts/ui.mjs --name <name> windows                 # list workbench windows
//   node scripts/ui.mjs --name <name> shot [file.png]          # screenshot of a workbench window
//   node scripts/ui.mjs --name <name> text [css selector]      # visible text (default: whole workbench)
//   node scripts/ui.mjs --name <name> eval '<js expression>'   # evaluate in the workbench page
//
// --window <n> picks the nth workbench window (default 0). Use `eval` to query the DOM, e.g. the
// labels of editor tabs: [...document.querySelectorAll('.tab .label-name')].map(e => e.textContent)
// Read-only by convention: do not use it to click or type in the user's stead for anything a test
// can do through tools or `debug_vscode_command`.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const options = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) options[argv[i].slice(2)] = argv[++i];
  else positional.push(argv[i]);
}
const name = options.name ?? 'dev';
const base = join(process.platform === 'win32' ? process.env.TEMP : '/tmp', 'agent-bridge-dev', name);
let port;
try {
  port = Number(readFileSync(join(base, 'ui-port'), 'utf8'));
} catch {
  console.error(`dev host "${name}" has no UI port (not running, or started with --no-ui-port)`);
  process.exit(1);
}

const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter(t => t.type === 'page' && t.url.includes('workbench'));
const [command, arg] = positional;
if (command === 'windows' || !command) {
  targets.forEach((t, i) => console.log(`${i}: ${t.title}`));
  process.exit(command ? 0 : 1);
}
const target = targets[Number(options.window ?? 0)];
if (!target) {
  console.error(`no workbench window ${options.window ?? 0} (found ${targets.length})`);
  process.exit(1);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((ok, fail) => {
  ws.onopen = ok;
  ws.onerror = () => fail(new Error('cannot connect to the workbench'));
});
let nextId = 1;
const pending = new Map();
ws.onmessage = event => {
  const message = JSON.parse(event.data);
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result);
};
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}

try {
  if (command === 'shot') {
    const file = resolve(arg ?? join(root, '.dev', 'shots', `ui-${Date.now()}.png`));
    mkdirSync(dirname(file), { recursive: true });
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(file, Buffer.from(data, 'base64'));
    console.log(file);
  } else if (command === 'text') {
    const selector = JSON.stringify(arg ?? '.monaco-workbench');
    console.log(await evaluate(`[...document.querySelectorAll(${selector})].map(e => e.innerText).join('\\n---\\n')`));
  } else if (command === 'eval') {
    const value = await evaluate(arg);
    console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  } else {
    console.error('usage: ui.mjs --name <name> windows | shot [file] | text [selector] | eval <js>');
    process.exitCode = 1;
  }
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}
ws.close();
