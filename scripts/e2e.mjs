#!/usr/bin/env node
// Runs end-to-end suites, each against its own fresh dev host, and summarizes what passed, failed and
// was skipped. What CI runs; works the same on a developer machine.
//
//   node scripts/e2e.mjs [suite ...] [--set ci|all] [--vscode system|stable|insiders|<version>|<executable>]
//                        [--report <file.json>] [--keep]
//
// Suites are names of test/e2e/<suite>.e2e.mjs; without any, --set picks them (default "ci": the ones
// reliable on a CI runner of this platform, see SUITES). --vscode: "system" (default) is `code` on the
// PATH, as for scripts/dev-host.mjs; "stable", "insiders" or a version are downloaded into .vscode-test/.
// Each suite gets a dev host named "e2e-<suite>" whose state is deleted first; --keep leaves it running.
// On a failure the workbench screenshot and VS Code's logs are copied to .dev/e2e/<suite>/.
// Writes a Markdown summary to $GITHUB_STEP_SUMMARY when set. Exits 1 when a suite failed.
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { vscodeExecutable } from './vscode-download.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const devBase = join(process.platform === 'win32' ? process.env.TEMP : '/tmp', 'copane-dev');

/**
 * Every suite, with the dev host flags it needs and, per platform, why it is left out of the "ci" set
 * there (it cannot run, or not reliably). Individual cases that need something a machine lacks skip
 * themselves and say why (see test/e2e/harness.mjs).
 */
export const SUITES = {
  core: {},
  registration: { notInCi: { win32: 'not adapted to Windows: it checks and runs the POSIX launcher (bin/mcp-server)' } },
  terminal: { notInCi: { win32: 'its commands need a POSIX shell; Windows terminals run PowerShell' } },
  ui: {},
  'ui-panel': {},
  'browser-tabs': {},
  'browser-page': {},
  'browser-frames': {},
  'browser-route': {},
  'browser-emulation': {},
  'browser-throttle': {},
  'browser-har': {},
  'browser-downloads': {},
  'browser-certs': {},
  'browser-auth': { hostArgs: ['--test-proxy'] },
  'browser-handoff': {},
  'browser-profiles': {},
  'browser-devtools': {},
  'browser-frame-requests': {},
  'browser-tab-ids': {},
  'browser-prompts': {},
  codex: {},
  remote: {
    notInCi: {
      linux: 'needs a remote dev host in a Docker container (scripts/remote-dev-host.mjs) and runs inside it',
      darwin: 'needs a remote dev host in a Docker container (scripts/remote-dev-host.mjs) and runs inside it',
      win32: 'needs a remote dev host in a Docker container (scripts/remote-dev-host.mjs) and runs inside it',
    },
  },
};

/** Parses a suite's output (PASS/FAIL/SKIP lines written by test/e2e/harness.mjs). */
export function parseSuiteOutput(output) {
  const cases = [];
  for (const line of output.split(/\r?\n/)) {
    const m = /^(PASS|FAIL|SKIP) {2}(.*?)(?: {2}\((.*)\))?$/.exec(line);
    if (m) cases.push({ status: m[1].toLowerCase(), name: m[2], detail: m[3] });
  }
  return cases;
}

/** The suites to run for the given arguments, and those left out with the reason. */
export function selectSuites(names, set, platform = process.platform) {
  for (const n of names) if (!SUITES[n]) throw new Error(`unknown suite "${n}"; known: ${Object.keys(SUITES).join(', ')}`);
  if (names.length) return { run: names, left: [] };
  if (set === 'all') return { run: Object.keys(SUITES), left: [] };
  if (set !== 'ci') throw new Error(`unknown set "${set}" (ci or all)`);
  const all = Object.keys(SUITES);
  return {
    run: all.filter(suite => !SUITES[suite].notInCi?.[platform]),
    left: all.filter(suite => SUITES[suite].notInCi?.[platform]).map(suite => ({ suite, reason: SUITES[suite].notInCi[platform] })),
  };
}

/** Markdown summary of the results; `left`: suites not run, with the reason. */
export function summarize(results, { title = 'End-to-end tests', vscode, left = [] } = {}) {
  const lines = [`### ${title}${vscode ? ` (VS Code ${vscode})` : ''}`, '', '| Suite | Result | Passed | Failed | Skipped | Time |', '|---|---|---|---|---|---|'];
  for (const r of results) {
    const count = s => r.cases.filter(c => c.status === s).length;
    const result = r.ok ? '✅' : `❌ ${r.problem ?? ''}`.trim();
    lines.push(`| ${r.suite} | ${result} | ${count('pass')} | ${count('fail')} | ${count('skip')} | ${Math.round(r.ms / 1000)} s |`);
  }
  for (const l of left) lines.push(`| ${l.suite} | ⏭️ not run here: ${l.reason} | | | | |`);
  const notable = results.flatMap(r => r.cases.filter(c => c.status !== 'pass').map(c => `- ${c.status === 'fail' ? '❌' : '⏭️'} **${r.suite}**: ${c.name}${c.detail ? ` (${c.detail})` : ''}`));
  if (notable.length) lines.push('', ...notable);
  return lines.join('\n') + '\n';
}

/** The version (and commit) of the VS Code build at `executable`, or of `code` on the PATH; undefined if not found. */
export function vscodeVersion(executable) {
  try {
    if (!executable) {
      const [version, commit] = spawnSync('code', ['--version'], { encoding: 'utf8', timeout: 30_000, shell: process.platform === 'win32' }).stdout.split(/\r?\n/);
      return version ? `${version}${commit ? ` (${commit.slice(0, 10)})` : ''}` : undefined;
    }
    // resources/app next to the executable (Linux, Windows), in a <commit> folder (newer Windows builds), or Contents/Resources/app (macOS).
    const dir = dirname(executable);
    const candidates = [join(dir, 'resources', 'app'), join(dir, '..', 'Resources', 'app'), ...readdirSync(dir).map(d => join(dir, d, 'resources', 'app'))];
    const app = candidates.find(c => existsSync(join(c, 'product.json')));
    if (!app) return undefined;
    const { version } = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8'));
    const { commit, quality } = JSON.parse(readFileSync(join(app, 'product.json'), 'utf8'));
    // Insiders builds already say "-insider" in their version.
    const suffix = quality && quality !== 'stable' && !version.includes(quality) ? `-${quality}` : '';
    return `${version}${suffix}${commit ? ` (${commit.slice(0, 10)})` : ''}`;
  } catch {
    return undefined;
  }
}

function option(args, name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function run(command, args, { timeoutMs, env } = {}) {
  return new Promise(resolvePromise => {
    const child = spawn(command, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const onData = stream => chunk => {
      output += chunk;
      stream.write(chunk);
    };
    child.stdout.on('data', onData(process.stdout));
    child.stderr.on('data', onData(process.stderr));
    let timedOut = false;
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill();
        }, timeoutMs)
      : undefined;
    child.on('close', code => {
      clearTimeout(timer);
      resolvePromise({ code, output, timedOut });
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const valued = new Set(['--set', '--vscode', '--report']);
  const names = args.filter((a, i) => !a.startsWith('--') && !valued.has(args[i - 1]));
  const { run: suites, left } = selectSuites(names, option(args, 'set') ?? 'ci');
  const keep = args.includes('--keep');
  const vscode = option(args, 'vscode') ?? 'system';

  const hostArgs = [];
  let exe;
  if (vscode !== 'system') {
    exe = isAbsolute(vscode) || existsSync(vscode) ? resolve(vscode) : await vscodeExecutable(vscode);
    hostArgs.push('--code', exe);
    // A downloaded Linux build has no setuid sandbox helper and finds no keyring on a CI runner.
    if (process.platform === 'linux') for (const a of ['--no-sandbox', '--disable-gpu', '--password-store=basic']) hostArgs.push('--code-arg', a);
  }

  const version = vscodeVersion(exe);
  console.log(`e2e: ${suites.join(', ')} against VS Code ${vscode}${version ? ` ${version}` : ''}`);
  const build = spawnSync(process.execPath, ['esbuild.mjs'], { cwd: root, stdio: 'inherit' });
  if (build.status !== 0) process.exit(1);

  const results = [];
  for (const suite of suites) {
    const name = `e2e-${suite}`;
    const started = Date.now();
    console.log(`\n=== ${suite} ===`);
    try {
      rmSync(join(devBase, name), { recursive: true, force: true });
    } catch (err) {
      console.log(`could not delete the previous state of dev host "${name}" (${err.code}); it starts with it`);
    }
    const devHost = [join(root, 'scripts', 'dev-host.mjs'), '--name', name, '--no-build', ...hostArgs, ...(SUITES[suite].hostArgs ?? [])];
    const host = await run(process.execPath, devHost, { timeoutMs: 120_000 });
    let result;
    if (host.code !== 0) {
      result = { suite, ok: false, problem: host.timedOut ? 'dev host did not start in 2 min' : 'dev host did not start', cases: [] };
    } else {
      const testRun = await run(process.execPath, [join(root, 'test', 'e2e', `${suite}.e2e.mjs`), '--name', name], { timeoutMs: 15 * 60_000 });
      const cases = parseSuiteOutput(testRun.output);
      const problem = testRun.timedOut ? 'timed out after 15 min' : testRun.code !== 0 && !cases.some(c => c.status === 'fail') ? `exited with code ${testRun.code}` : undefined;
      result = { suite, ok: testRun.code === 0, problem, cases };
    }
    result.ms = Date.now() - started;
    if (!result.ok) collectEvidence(suite, name);
    if (!keep) spawnSync(process.execPath, [join(root, 'scripts', 'dev-host.mjs'), '--name', name, '--stop'], { cwd: root, stdio: 'ignore' });
    results.push(result);
  }

  const summary = summarize(results, { vscode: version ? `${vscode} ${version}` : vscode, left });
  console.log(`\n${summary}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  const report = option(args, 'report');
  if (report) {
    mkdirSync(dirname(resolve(report)), { recursive: true });
    writeFileSync(report, JSON.stringify({ vscode, vscodeVersion: version, platform: process.platform, results, left }, null, 2));
  }
  process.exit(results.every(r => r.ok) ? 0 : 1);
}

/** Copies what helps to understand a failure (screenshot, VS Code logs including Copane's) to .dev/e2e/<suite>/. */
function collectEvidence(suite, name) {
  const out = join(root, '.dev', 'e2e', suite);
  mkdirSync(out, { recursive: true });
  spawnSync(process.execPath, [join(root, 'scripts', 'ui.mjs'), '--name', name, 'shot', join(out, 'workbench.png')], { cwd: root, stdio: 'ignore', timeout: 30_000 });
  const logs = join(devBase, name, 'ud', 'logs');
  if (existsSync(logs)) cpSync(logs, join(out, 'logs'), { recursive: true });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
