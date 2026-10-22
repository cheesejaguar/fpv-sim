// Every test file: buildDrone() reads a catalogue prop's BEMT table from public/bemt/ (written by
// globalSetup.ts) instead of solving it again, when those tables still match the physics sources
// (checked here, so a watch session after an edit to src/sim never sees stale ones). The tables are
// bit-identical to computed ones (scripts/build-bemt-tables.mjs checks the round trip).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BEMT_DIR, currentBemtManifest } from '../../scripts/lib/bemt-inputs.mjs';
import { decodeTable } from '../../src/builder/bemtTables';
import { setPropTableSource } from '../../src/builder/derive';

const root = fileURLToPath(new URL('../../', import.meta.url));
const m = currentBemtManifest(root);
if (m) {
  setPropTableSource((id) => {
    const f = m.tables[id];
    return f ? decodeTable(readFileSync(join(root, BEMT_DIR, f))) : null;
  });
}
