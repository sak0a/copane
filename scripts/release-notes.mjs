#!/usr/bin/env node
// Checks that a release tag matches package.json's version and prints that version's section of
// CHANGELOG.md, the GitHub release notes. Used by .github/workflows/release.yml.
//
//   node scripts/release-notes.mjs <tag> [--notes <file>]
//
// Exits 1 with a reason when the tag is not "v<version>" or CHANGELOG.md has no "## <version>"
// section. With $GITHUB_OUTPUT set it also writes version=, vsix= and prerelease= (true below 1.0).
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The body of `## <version>` in a changelog (up to the next `## `), trimmed; undefined if there is none. */
export function changelogSection(changelog, version) {
  const lines = changelog.replace(/\r\n?/g, '\n').split('\n');
  const heading = new RegExp(`^## \\[?v?${version.replace(/\./g, '\\.')}\\]?(\\s|$)`);
  const start = lines.findIndex(l => heading.test(l));
  if (start < 0) return undefined;
  const end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  const body = lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim();
  return body || undefined;
}

/** A problem with releasing `tag` for `version`, or undefined when they match. */
export function tagProblem(tag, version) {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) return `package.json has the version "${version}", which is not a semantic version`;
  if (tag !== `v${version}`) return `the tag "${tag}" does not match package.json's version ${version}: tag v${version}, or change the version and tag again`;
  return undefined;
}

/** Below 1.0, or with a suffix like -beta.1, a release is a pre-release. */
export const isPrerelease = version => /^0\./.test(version) || version.includes('-');

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const args = process.argv.slice(2);
  const tag = (args[0] ?? '').replace(/^refs\/tags\//, '');
  const notesIndex = args.indexOf('--notes');
  const { name, version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const problem = tagProblem(tag, version);
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
  const notes = changelogSection(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), version);
  if (!notes) {
    console.error(`CHANGELOG.md has no "## ${version}" section with content; add the release notes there and tag again`);
    process.exit(1);
  }
  if (notesIndex >= 0) writeFileSync(resolve(args[notesIndex + 1]), notes + '\n');
  else console.log(notes);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\nvsix=${name}-${version}.vsix\nprerelease=${isPrerelease(version)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
