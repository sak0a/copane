// Writes THIRD_PARTY_NOTICES.md: the license of every npm package whose code is bundled into
// dist/*.js. Their licenses (MIT and similar) require the notice to travel with the code, and the
// VSIX ships the bundles, so the file ships too. Input: esbuild metafiles of the builds.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Packages that publish no license file: the text from their repository, kept in scripts/licenses/.
const FALLBACK = { '@xterm/headless': 'xterm.txt' };
const fallbackDir = join(dirname(fileURLToPath(import.meta.url)), 'licenses');

/** @param {Array<{ inputs: Record<string, unknown> }>} metafiles */
export function writeThirdPartyNotices(metafiles, root = process.cwd()) {
  const packages = new Map();
  for (const meta of metafiles) {
    for (const input of Object.keys(meta.inputs)) {
      const m = /^(.*node_modules\/((?:@[^/]+\/)?[^/]+))\//.exec(input);
      if (!m) continue;
      const dir = join(root, m[1]);
      if (packages.has(dir)) continue;
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      const file = readdirSync(dir).find(f => /^(licen[cs]e|copying)(\.|$)/i.test(f));
      packages.set(dir, { name: pkg.name, version: pkg.version, license: pkg.license ?? 'see text', text: file ? readFileSync(join(dir, file), 'utf8').trim() : FALLBACK[pkg.name] ? readFileSync(join(fallbackDir, FALLBACK[pkg.name]), 'utf8').trim() : undefined, repository: typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url });
    }
  }
  const sorted = [...packages.values()].sort((a, b) => a.name.localeCompare(b.name));
  const missing = sorted.filter(p => !p.text);
  if (missing.length) throw new Error(`no license file found for: ${missing.map(p => p.name).join(', ')}`);
  const out = [
    '# Third-party notices',
    '',
    'Copane bundles the following open-source packages. Their licenses apply to their code; Copane itself is',
    'licensed under the PolyForm Shield License 1.0.0 (see LICENSE).',
    '',
    ...sorted.map(p => `- ${p.name} ${p.version} (${p.license})`),
    '',
    ...sorted.flatMap(p => ['---', '', `## ${p.name} ${p.version}`, '', ...(p.repository ? [p.repository.replace(/^git\+/, ''), ''] : []), '```', p.text, '```', '']),
  ]
    .join('\n')
    // Some packages ship CRLF license files: normalized, so a build never leaves the committed file changed.
    .replace(/\r\n?/g, '\n');
  writeFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), out);
  return sorted.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const metas = process.argv.slice(2).map(f => JSON.parse(readFileSync(f, 'utf8')));
  console.log(`${writeThirdPartyNotices(metas)} packages`);
}
