// Bundles the two entry points: the extension (runs in the VS Code extension host) and the
// MCP stdio server (runs as a plain Node process spawned by the agent, e.g. Claude Code).
import * as esbuild from 'esbuild';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const watch = process.argv.includes('--watch');
execFileSync(process.execPath, ['scripts/gen-manifest.mjs'], { stdio: 'inherit' });

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));

const common = {
  define: { __VERSION__: JSON.stringify(version) },
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
  logLevel: 'info',
};
const builds = [
  { ...common, entryPoints: ['src/extension/extension.ts'], outfile: 'dist/extension.js', external: ['vscode'] },
  { ...common, entryPoints: ['src/mcp/server.ts'], outfile: 'dist/mcp-server.js' },
];
if (watch) {
  for (const b of builds) (await esbuild.context(b)).watch();
} else {
  await Promise.all(builds.map(b => esbuild.build(b)));
}
