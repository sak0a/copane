// Generates package.json#contributes from contributes/*.json so that each module owns its own
// fragment (commands, configuration, views, menus ...) and parallel work never collides in
// package.json. Arrays are concatenated, objects are merged recursively. Run by `npm run build`.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'contributes');

function merge(a, b, path) {
  if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b];
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const out = { ...a };
    for (const [k, v] of Object.entries(b)) out[k] = k in out ? merge(out[k], v, `${path}.${k}`) : v;
    return out;
  }
  if (JSON.stringify(a) === JSON.stringify(b)) return a;
  throw new Error(`contributes conflict at ${path}: two fragments define different values`);
}

// core.json first, the rest alphabetically, for a stable output order.
const files = readdirSync(dir).filter(f => f.endsWith('.json')).sort((a, b) => (a === 'core.json' ? -1 : b === 'core.json' ? 1 : a.localeCompare(b)));
let contributes = {};
for (const f of files) contributes = merge(contributes, JSON.parse(readFileSync(join(dir, f), 'utf8')), f);

const pkgPath = join(root, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const next = JSON.stringify({ ...pkg, contributes }, null, 2) + '\n';
if (next !== readFileSync(pkgPath, 'utf8')) writeFileSync(pkgPath, next);
