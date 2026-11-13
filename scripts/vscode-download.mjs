#!/usr/bin/env node
// Downloads a VS Code build (into .vscode-test/, reused when present) and prints the path of its
// executable on the last line of stdout, for `scripts/dev-host.mjs --code <path>`.
//
//   node scripts/vscode-download.mjs [stable|insiders|<version like 1.146.0>]
//
// Used by CI, where no VS Code is installed; on a developer machine dev hosts use `code` on the PATH.
import { downloadAndUnzipVSCode } from '@vscode/test-electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Returns the executable of the requested build, downloading it first if needed. */
export async function vscodeExecutable(version = 'stable') {
  // Progress goes to stderr, so stdout stays the path alone.
  const log = console.log;
  console.log = (...args) => console.error(...args);
  try {
    return await downloadAndUnzipVSCode({ version, cachePath: join(root, '.vscode-test') });
  } finally {
    console.log = log;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log(await vscodeExecutable(process.argv[2] ?? 'stable'));
}
