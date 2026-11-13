// A remote window (the extension on the remote side, the browser on the user's machine), against a
// remote dev host. The window is an attached Docker container (scripts/remote-dev-host.mjs), the same
// split as WSL or SSH; this script runs inside that container, next to the extension, as an agent does:
//
//   node scripts/remote-dev-host.mjs --name <n>
//   docker exec copane-remote-<n> node /copane/test/e2e/remote.e2e.mjs --name <n> [--only <text>]
//
// "The user's machine" is the host running the dev host; the extension is pointed at a throwaway home
// there (COPANE_UI_HOME, /tmp/copane-dev/<n>/uihome), which this test reads through the extension
// (vscode.workspace.fs with vscode-local URIs) since it cannot see that machine itself.
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { agent, assert, run, test, until } from './harness.mjs';

let helper;
async function user() {
  helper ??= await agent({ session: 'remote-e2e-user' });
  return helper;
}
/** Runs code in the extension host (the remote side) and returns its JSON result. */
async function inHost(code) {
  return JSON.parse(await (await user()).ok('debug_extension_eval', { code }));
}
/** A file or folder on the user's machine, read through the extension. */
const uiList = path => inHost(`try { return (await vscode.workspace.fs.readDirectory(vscode.Uri.from({ scheme: 'vscode-local', path: ${JSON.stringify(path)} }))).map(e => e[0]); } catch { return null; }`);
const uiRead = path => inHost(`try { return new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.from({ scheme: 'vscode-local', path: ${JSON.stringify(path)} }))); } catch { return null; }`);
const uiWrite = (path, text) => inHost(`await vscode.workspace.fs.writeFile(vscode.Uri.from({ scheme: 'vscode-local', path: ${JSON.stringify(path)} }), new TextEncoder().encode(${JSON.stringify(text)})); return true;`);

const uiHome = process.env.COPANE_UI_HOME;
const agentFolder = join(homedir(), 'Downloads', 'Copane');
const page = (name, body) => `data:text/html,<a id=a download='${name}' href='data:text/plain,${encodeURIComponent(body)}'>download</a>`;

async function stagingFiles() {
  const root = (await inHost('const f = await services.remote.uiFolder("download-staging"); return f.uri.path;'));
  return (await uiList(root)) ?? [];
}

test('this is a remote window, and the user\'s machine is found', async () => {
  assert.ok(uiHome, 'COPANE_UI_HOME is set in the container (scripts/remote-dev-host.mjs)');
  const facts = await inHost('const m = await services.remote.uiHome(); return { remoteName: vscode.env.remoteName, where: services.remote.where, home: m.home && m.home.uri.path, platform: m.platform, error: m.error };');
  assert.ok(facts.remoteName, 'remoteName is set');
  assert.equal(facts.where, 'the container');
  assert.equal(facts.home, uiHome);
  assert.equal(facts.platform, process.platform === 'linux' && uiHome.startsWith('/Users/') ? 'darwin' : facts.platform);
});

test('an agent download is copied to the remote side, where the agent reads it', async () => {
  const a = await agent({ session: 'remote-dl' });
  try {
    const name = `remote-${Date.now()}.txt`;
    await (await user()).ok('debug_answer_prompts', { answers: ['Allow'], clear: true });
    await a.ok('browser_open', { url: page(name, 'made on the user side') });
    const clicked = await a.ok('browser_click', { selector: '#a' });
    let line = clicked;
    if (!/saved to/.test(line)) line = await a.ok('browser_downloads', { wait: true, timeoutSeconds: 20 });
    const path = /saved to (\S+) \(/.exec(line)?.[1];
    assert.ok(path, `a saved path in: ${line}`);
    assert.equal(path, join(agentFolder, name));
    assert.equal(readFileSync(path, 'utf8'), 'made on the user side');
    assert.deepEqual(await stagingFiles(), [], 'nothing left in the staging folder on the user side');
    rmSync(path, { force: true });
    await a.ok('browser_release_tab');
  } finally {
    await (await user()).ok('debug_answer_prompts', { answers: [], clear: true });
    await a.close();
  }
});

test('a download the user refuses is deleted on the user side and never reaches the remote side', async () => {
  const a = await agent({ session: 'remote-dl-deny' });
  try {
    const name = `refused-${Date.now()}.txt`;
    await (await user()).ok('debug_answer_prompts', { answers: ['Deny'], clear: true });
    await a.ok('browser_open', { url: page(name, 'secret') });
    await a.ok('browser_click', { selector: '#a' });
    const line = await until(async () => {
      const listed = await a.ok('browser_downloads');
      return listed.split('\n').find(l => l.includes(name) && /not saved/.test(l));
    }, 'the download reported as not saved');
    assert.match(line, /declined|did not allow/);
    assert.ok(!existsSync(join(agentFolder, name)));
    assert.deepEqual(await stagingFiles(), []);
    await a.ok('browser_release_tab');
  } finally {
    await (await user()).ok('debug_answer_prompts', { answers: [], clear: true });
    await a.close();
  }
});

test('enabling the browser edits argv.json on the user\'s machine, keeping what is there', async () => {
  const file = `${uiHome}/.vscode/argv.json`;
  const original = '// user comment\n{\n\t"enable-crash-reporter": false\n}\n';
  await uiWrite(file, original);
  try {
    await (await user()).ok('debug_answer_prompts', { answers: ['Later'], clear: true });
    const result = JSON.parse(await (await user()).ok('debug_vscode_command', { command: 'copane.enableBrowser', args: [{ evenIfAvailable: true }] }));
    assert.equal(result.state, 'enabled');
    assert.equal(result.changed, true);
    const text = await uiRead(file);
    assert.match(text, /\/\/ user comment/);
    assert.match(text, /"enable-crash-reporter": false/);
    assert.match(text, /"enable-proposed-api": \[\s*"saka\.copane"\s*\]/);
    const shown = JSON.parse(await (await user()).ok('debug_answer_prompts', {})).shown;
    assert.match(shown.at(-1).message, /quit VS Code completely/);
    await (await user()).ok('debug_answer_prompts', { answers: ['Later'], clear: true });
    const again = JSON.parse(await (await user()).ok('debug_vscode_command', { command: 'copane.enableBrowser', args: [{ evenIfAvailable: true }] }));
    assert.equal(again.changed, false);
    const status = JSON.parse(await (await user()).ok('debug_vscode_command', { command: 'copane.showStatus', args: [{ show: false }] }));
    assert.ok(status.includes(`argv.json: ${file} (on the user's computer)`), 'status names the file on the user side');
  } finally {
    await uiWrite(file, original);
    await (await user()).ok('debug_answer_prompts', { answers: [], clear: true });
  }
});

test('nothing was written to the remote side\'s own Downloads beyond the agent folder', async () => {
  const downloads = join(homedir(), 'Downloads');
  const entries = existsSync(downloads) ? readdirSync(downloads) : [];
  assert.ok(entries.every(e => e === 'Copane'), `unexpected: ${entries.join(', ')}`);
});

await run();
await helper?.close();
