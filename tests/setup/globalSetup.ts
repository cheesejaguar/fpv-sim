// Once per test run: the precomputed propeller BEMT tables, from the same generator `npm run dev` and
// `npm run build` run (scripts/build-bemt-tables.mjs; skipped while they match the physics sources).
// Every test file then reads a prop's table from disk (propTables.ts) instead of solving it again
// (~1.2 s per prop, per file). If the generator fails, the tests compute the tables, as before.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export default function setup() {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  try {
    execFileSync(process.execPath, ['scripts/build-bemt-tables.mjs'], { cwd: root, stdio: 'inherit' });
  } catch (e) {
    console.warn(`precomputed BEMT tables unavailable (${(e as Error).message}): tests build them as they go`);
  }
}
