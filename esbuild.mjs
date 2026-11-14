// Bundles the two entry points: the extension (runs in the VS Code extension host) and the
// MCP stdio server (runs as a plain Node process spawned by the agent, e.g. Claude Code).
import * as esbuild from 'esbuild';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { writeThirdPartyNotices } from './scripts/third-party-notices.mjs';

const watch = process.argv.includes('--watch');
execFileSync(process.execPath, ['scripts/gen-manifest.mjs'], { stdio: 'inherit' });

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));

const common = {
  define: { __VERSION__: JSON.stringify(version) },
  bundle: true,
  platform: 'node',
  // Prefer a package's ES module build: jsonc-parser's default (UMD) build loads its parts with
  // dynamic require() calls that a bundle cannot resolve.
  mainFields: ['module', 'main'],
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
  logLevel: 'info',
  metafile: true,
};
const builds = [
  { ...common, entryPoints: ['src/extension/extension.ts'], outfile: 'dist/extension.js', external: ['vscode'] },
  { ...common, entryPoints: ['src/mcp/server.ts'], outfile: 'dist/mcp-server.js' },
];
if (watch) {
  for (const b of builds) (await esbuild.context(b)).watch();
} else {
  const results = await Promise.all(builds.map(b => esbuild.build(b)));
  // axe-core (browser_audit accessibility) ships unmodified next to the bundles and is read only when
  // the check runs, so it adds nothing to the extension's activation. Listed in the notices like a bundled package.
  mkdirSync('dist', { recursive: true });
  copyFileSync('node_modules/axe-core/axe.min.js', 'dist/axe.min.js');
  writeThirdPartyNotices([...results.map(r => r.metafile), { inputs: { 'node_modules/axe-core/axe.min.js': {} } }]);
}
