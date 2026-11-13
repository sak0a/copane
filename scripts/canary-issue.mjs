#!/usr/bin/env node
// Keeps one GitHub issue (label "vscode-canary") in step with the nightly VS Code canary
// (.github/workflows/vscode-canary.yml): opens it when the e2e suites fail against VS Code Insiders or
// the vendored proposed-API typings differ from microsoft/vscode, updates it while that lasts
// (a comment only when what is broken changed), and closes it once everything is fine again.
//
//   node scripts/canary-issue.mjs --e2e <report.json> --api <api.md> --api-exit <0|1|2> [--run-url <url>] [--dry-run]
//
// A missing e2e report or an API comparison that could not be made (exit 2) counts as "unknown":
// it never opens or closes the issue, so a network hiccup does not make noise. Needs `gh` with
// GH_TOKEN (issues: write) and GH_REPO or a checkout of the repository.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LABEL = 'vscode-canary';
const MARKER = 'copane-canary-fingerprint';

/**
 * What the canary found. `e2e`: the report written by scripts/e2e.mjs (undefined when the job left
 * none); `api`: `{ exit, text }` from scripts/check-proposed-api.mjs.
 */
export function assess({ e2e, api }) {
  const failures = e2e ? e2e.results.flatMap(r => (r.ok ? [] : r.cases.some(c => c.status === 'fail') ? r.cases.filter(c => c.status === 'fail').map(c => `${r.suite}: ${c.name}`) : [`${r.suite}: ${r.problem ?? 'failed'}`])) : [];
  const e2eState = !e2e ? 'unknown' : failures.length ? 'broken' : 'ok';
  const apiState = api?.exit === 0 ? 'ok' : api?.exit === 1 ? 'broken' : 'unknown';
  const broken = e2eState === 'broken' || apiState === 'broken';
  const allOk = e2eState === 'ok' && apiState === 'ok';
  const fingerprint = broken
    ? createHash('sha256')
        .update(JSON.stringify({ failures: [...failures].sort(), api: apiState === 'broken' ? api.text : '' }))
        .digest('hex')
        .slice(0, 16)
    : undefined;
  return { e2eState, apiState, failures, broken, allOk, fingerprint };
}

/** The issue body for a broken state. */
export function issueBody(state, { e2e, api, runUrl, now = new Date() }) {
  const lines = [
    'The nightly VS Code canary found something that may break Copane for users once it reaches VS Code stable.',
    '',
    `Last checked: ${now.toISOString()}${runUrl ? ` in [this run](${runUrl})` : ''}.`,
    '',
    `## End-to-end suites against VS Code Insiders${e2e?.vscodeVersion ? ` ${e2e.vscodeVersion}` : ''}`,
    '',
  ];
  if (state.e2eState === 'unknown') lines.push('Not known: the job produced no report (see the run).');
  else if (state.e2eState === 'ok') lines.push('All passed.');
  else lines.push(...state.failures.map(f => `- ❌ ${f}`), '', 'The run has screenshots and VS Code logs of each failed suite as an artifact. Check first whether the same suites pass against VS Code stable (the Checks workflow).');
  lines.push('', '## Proposed-API typings', '', state.apiState === 'unknown' ? `Not known: ${api?.text?.split('\n')[0] ?? 'the comparison did not run'}` : api.text.trim());
  lines.push('', 'This issue is updated by the canary while the problem lasts and closed by it once everything passes again.', '', `<!-- ${MARKER}:${state.fingerprint} -->`);
  return lines.join('\n');
}

/** The fingerprint an existing issue body was written for. */
export const fingerprintOf = body => new RegExp(`<!-- ${MARKER}:([0-9a-f]+) -->`).exec(body ?? '')?.[1];

/**
 * What to do with the issue: `{ kind: 'none' | 'create' | 'update' | 'close', comment?: string }`.
 * `existing`: the open canary issue (`{ number, body }`) or undefined.
 */
export function plan(state, existing) {
  if (state.broken) {
    if (!existing) return { kind: 'create' };
    const changed = fingerprintOf(existing.body) !== state.fingerprint;
    return { kind: 'update', comment: changed ? 'What is broken changed since the last report; the description is updated.' : undefined };
  }
  if (state.allOk && existing) return { kind: 'close', comment: 'The end-to-end suites pass against the current VS Code Insiders and the proposed-API typings match microsoft/vscode again. Closing.' };
  return { kind: 'none' };
}

function gh(args, input) {
  return execFileSync('gh', args, { encoding: 'utf8', input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'inherit'] });
}

function main() {
  const args = process.argv.slice(2);
  const option = n => (args.indexOf(`--${n}`) >= 0 ? args[args.indexOf(`--${n}`) + 1] : undefined);
  const dryRun = args.includes('--dry-run');
  const e2eFile = option('e2e');
  const e2e = e2eFile && existsSync(e2eFile) ? JSON.parse(readFileSync(e2eFile, 'utf8')) : undefined;
  const apiFile = option('api');
  const apiExit = option('api-exit');
  const api = apiFile && existsSync(apiFile) && apiExit !== undefined ? { exit: Number(apiExit), text: readFileSync(apiFile, 'utf8') } : undefined;
  const state = assess({ e2e, api });
  console.log(`e2e: ${state.e2eState}, proposed API: ${state.apiState}${state.failures.length ? `\n  ${state.failures.join('\n  ')}` : ''}`);

  const open = dryRun ? [] : JSON.parse(gh(['issue', 'list', '--label', LABEL, '--state', 'open', '--json', 'number,body', '--limit', '5']));
  const existing = open[0];
  const action = plan(state, existing);
  console.log(`issue: ${action.kind}${existing ? ` #${existing.number}` : ''}`);
  if (dryRun || action.kind === 'none') {
    if (dryRun && state.broken) console.log(`\n${issueBody(state, { e2e, api, runUrl: option('run-url') })}`);
    return;
  }
  const body = state.broken ? issueBody(state, { e2e, api, runUrl: option('run-url') }) : undefined;
  if (action.kind === 'create') {
    gh(['label', 'create', LABEL, '--color', 'D93F0B', '--description', 'Found by the nightly VS Code canary', '--force']);
    gh(['issue', 'create', '--title', 'VS Code canary: a coming VS Code change may break Copane', '--label', LABEL, '--body-file', '-'], body);
  } else if (action.kind === 'update') {
    gh(['issue', 'edit', String(existing.number), '--body-file', '-'], body);
    if (action.comment) gh(['issue', 'comment', String(existing.number), '--body-file', '-'], `${action.comment}${option('run-url') ? ` ([run](${option('run-url')}))` : ''}`);
  } else if (action.kind === 'close') {
    gh(['issue', 'close', String(existing.number), '--comment', action.comment]);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
