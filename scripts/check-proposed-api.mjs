#!/usr/bin/env node
// Compares the proposed-API typings Copane vendors (src/typings/vscode.proposed.*.d.ts) with the
// current ones in microsoft/vscode, to notice before users do that a proposal Copane relies on changed.
//
//   node scripts/check-proposed-api.mjs [--ref main] [--report <file.md>]
//
// Prints a Markdown report (also written to --report). Exit code: 0 all identical, 1 a file differs
// or is gone upstream, 2 the comparison could not be made (network). Needs `git` for the diffs.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Line endings and trailing whitespace do not count as a change. */
export const normalize = text => text.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trimEnd() + '\n';

/** A unified diff of two texts (labelled a/<name>, b/<name>), via `git diff --no-index`. */
export function unifiedDiff(name, ours, theirs) {
  const dir = mkdtempSync(join(tmpdir(), 'copane-api-'));
  try {
    writeFileSync(join(dir, 'vendored'), ours);
    writeFileSync(join(dir, 'upstream'), theirs);
    const r = spawnSync('git', ['diff', '--no-index', '--no-color', '--unified=3', 'vendored', 'upstream'], { cwd: dir, encoding: 'utf8' });
    if (r.error) throw r.error;
    return r.stdout
      .split('\n')
      .filter(l => !/^(diff --git|index |--- |\+\+\+ )/.test(l))
      .join('\n')
      .trim()
      .replace(/^/, `--- vendored/${name}\n+++ upstream/${name}\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Compares each vendored file with `fetchUpstream(name)` (text, or null when the file does not exist
 * upstream). Returns `{ status: 'same' | 'changed' | 'error', files: [{ name, status, diff? , error? }] }`.
 */
export async function compareTypings(vendored, fetchUpstream) {
  const files = [];
  for (const [name, ours] of Object.entries(vendored)) {
    try {
      const theirs = await fetchUpstream(name);
      if (theirs === null) files.push({ name, status: 'gone' });
      else if (normalize(ours) === normalize(theirs)) files.push({ name, status: 'same' });
      else files.push({ name, status: 'differs', diff: unifiedDiff(name, normalize(ours), normalize(theirs)) });
    } catch (err) {
      files.push({ name, status: 'error', error: String(err?.message ?? err) });
    }
  }
  const status = files.some(f => f.status === 'differs' || f.status === 'gone') ? 'changed' : files.some(f => f.status === 'error') ? 'error' : 'same';
  return { status, files };
}

/** Markdown report of a comparison. */
export function report({ status, files }, ref) {
  const head = {
    same: `The proposed-API typings in \`src/typings/\` match microsoft/vscode \`${ref}\`.`,
    changed: `Proposed-API typings that Copane vendors in \`src/typings/\` changed in microsoft/vscode \`${ref}\`. Check whether Copane's use of them still holds, then copy the new files from \`src/vscode-dts/\` and adapt.`,
    error: `The proposed-API typings could not be compared with microsoft/vscode \`${ref}\`.`,
  }[status];
  const lines = [head, ''];
  for (const f of files) {
    if (f.status === 'same') lines.push(`- \`${f.name}\`: unchanged`);
    if (f.status === 'gone') lines.push(`- \`${f.name}\`: **no longer exists upstream** (the proposal was removed, renamed or finalized)`);
    if (f.status === 'error') lines.push(`- \`${f.name}\`: could not be fetched: ${f.error}`);
    if (f.status === 'differs') lines.push(`- \`${f.name}\`: **differs**`, '', '<details><summary>diff</summary>', '', '```diff', f.diff, '```', '', '</details>', '');
  }
  return lines.join('\n').trim() + '\n';
}

async function main() {
  const args = process.argv.slice(2);
  const option = n => (args.indexOf(`--${n}`) >= 0 ? args[args.indexOf(`--${n}`) + 1] : undefined);
  const ref = option('ref') ?? 'main';
  const dir = join(root, 'src', 'typings');
  const vendored = Object.fromEntries(readdirSync(dir).filter(f => /^vscode\.proposed\..+\.d\.ts$/.test(f)).map(f => [f, readFileSync(join(dir, f), 'utf8')]));
  const result = await compareTypings(vendored, async name => {
    const res = await fetch(`https://raw.githubusercontent.com/microsoft/vscode/${ref}/src/vscode-dts/${name}`, { signal: AbortSignal.timeout(30_000) });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  });
  const text = report(result, ref);
  console.log(text);
  const file = option('report');
  if (file) writeFileSync(resolve(file), text);
  process.exit({ same: 0, changed: 1, error: 2 }[result.status]);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
