// What the precomputed BEMT tables (scripts/build-bemt-tables.mjs) are made from, shared with
// vite.config.ts: the build only ships tables whose physics sources hash to the same value, so a
// changed solver, prop or drone model can never meet tables made by an older one.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Directory (under the repo root) the tables are written to; served at /bemt/. */
export const BEMT_DIR = 'public/bemt';
export const MANIFEST = 'manifest.json';
/** Every source the tables and the preset card numbers depend on (and the generator itself). */
const INPUTS = ['src/sim', 'src/builder', 'src/data', 'scripts/build-bemt-tables.mjs', 'scripts/lib/bemt-inputs.mjs'];

function files(root, p) {
  const abs = join(root, p);
  if (!existsSync(abs)) return [];
  if (!statSync(abs).isDirectory()) return [abs];
  return readdirSync(abs).sort().flatMap((f) => files(root, join(p, f))).filter((f) => /\.(ts|mjs|js|json)$/.test(f));
}

/** sha256 over the input files' paths and contents (line endings normalised). */
export function bemtInputHash(root) {
  const h = createHash('sha256');
  for (const f of INPUTS.flatMap((p) => files(root, p))) {
    h.update(relative(root, f).replace(/\\/g, '/')); h.update('\0');
    h.update(readFileSync(f, 'utf8').replace(/\r\n/g, '\n')); h.update('\0');
  }
  return h.digest('hex');
}

/** The manifest the generator wrote, or null. */
export function readBemtManifest(root) {
  const f = join(root, BEMT_DIR, MANIFEST);
  if (!existsSync(f)) return null;
  const m = JSON.parse(readFileSync(f, 'utf8'));
  return m && m.format === 'fpvsim-bemt' && typeof m.inputs === 'string' && m.tables && typeof m.tables === 'object' ? m : null;
}

/** The manifest, only if it was made from the current sources and every table file is there. */
export function currentBemtManifest(root) {
  try {
    const m = readBemtManifest(root);
    if (!m || m.inputs !== bemtInputHash(root)) return null;
    for (const f of Object.values(m.tables)) if (typeof f !== 'string' || !existsSync(join(root, BEMT_DIR, f))) return null;
    return m;
  } catch { return null; }
}

/** Is `file` (absolute) one of the inputs? (the dev server stops using the tables when one changes) */
export function isBemtInput(root, file) {
  const r = relative(root, file).replace(/\\/g, '/');
  return INPUTS.some((p) => r === p || r.startsWith(p + '/'));
}
