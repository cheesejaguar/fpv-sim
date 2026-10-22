#!/usr/bin/env node
// Precomputes the propeller BEMT table of every catalogue prop (src/builder/bemtTables.ts) and the
// preset drone cards' headline numbers, so the app doesn't spend ~1.2 s per prop building them on
// every page load (twice: page and simulation worker). Runs before `npm run dev` / `npm run build`.
// Output (gitignored): public/bemt/<prop id>.<content hash>.bin and public/bemt/manifest.json, which
// records the hash of the physics sources the tables came from (scripts/lib/bemt-inputs.mjs);
// vite.config.ts ships them only while the sources still match. Skipped when up to date.
//   node scripts/build-bemt-tables.mjs           write the tables (if the sources changed)
//   node scripts/build-bemt-tables.mjs --force   rebuild them anyway
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { BEMT_DIR, bemtInputHash, currentBemtManifest, MANIFEST } from './lib/bemt-inputs.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const OUT = join(ROOT, BEMT_DIR);

const load = async () => {
  const { loadTs } = await import('./lib/load-ts.mjs');
  const { mods: [derive, catalog, codec, stats], close } = await loadTs('src/builder/derive.ts', 'src/data/catalog.ts', 'src/builder/bemtTables.ts', 'src/ui/menu/droneStats.ts');
  return { derive, catalog, codec, stats, close };
};

if (!isMainThread) {
  // a helper thread: the tables of some props, and the card numbers of the presets that use them
  const { props } = workerData;
  const { derive, catalog, codec, stats, close } = await load();
  try {
    const tables = {}, cards = {};
    for (const id of props) {
      const p = catalog.PROPS.find((x) => x.id === id);
      const bytes = codec.encodeTable(derive.propTable(p));
      // what the app will read back must be bit-identical to what it would compute
      const back = codec.decodeTable(bytes), t = derive.propTable(p);
      for (const [k, v] of Object.entries(t)) {
        const w = back[k];
        if (v instanceof Float32Array ? !(w instanceof Float32Array) || Buffer.compare(Buffer.from(v.buffer, v.byteOffset, v.byteLength), Buffer.from(w.buffer, w.byteOffset, w.byteLength)) !== 0 : !Object.is(v, w)) throw new Error(`${id}: field ${k} does not round-trip`);
      }
      tables[id] = bytes;
    }
    for (const spec of derive.PRESETS) if (props.includes(spec.prop)) cards[stats.prebuiltKey(spec)] = derive.droneCardStats(derive.buildDrone(spec).info);
    parentPort.postMessage({ tables, cards });
  } finally { await close(); }
} else {
  const force = process.argv.includes('--force');
  const t0 = performance.now();
  if (!force && currentBemtManifest(ROOT)) {
    console.log('BEMT tables: up to date');
  } else {
    const inputs = bemtInputHash(ROOT);
    // the prop list, then the work split over a few threads (each table is ~1.2 s of solving)
    const { catalog, close } = await (async () => { const { loadTs } = await import('./lib/load-ts.mjs'); const { mods: [catalog], close } = await loadTs('src/data/catalog.ts'); return { catalog, close }; })();
    const ids = catalog.PROPS.map((p) => p.id);
    await close();
    const n = Math.max(1, Math.min(ids.length, availableParallelism() - 1, 4));
    const groups = Array.from({ length: n }, (_, i) => ids.filter((_, k) => k % n === i));
    const parts = await Promise.all(groups.map((props) => new Promise((res, rej) => {
      const w = new Worker(fileURLToPath(import.meta.url), { workerData: { props } });
      w.once('message', res); w.once('error', rej);
      w.once('exit', (code) => { if (code) rej(new Error(`BEMT table thread exited with ${code}`)); });
    })));
    mkdirSync(OUT, { recursive: true });
    const tables = {}, stats = {};
    for (const part of parts) {
      for (const [id, bytes] of Object.entries(part.tables)) {
        const file = `${id}.${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}.bin`;
        writeFileSync(join(OUT, file), bytes);
        tables[id] = file;
      }
      Object.assign(stats, part.cards);
    }
    // the stale tables of older sources go
    for (const f of readdirSync(OUT)) if (f !== MANIFEST && !Object.values(tables).includes(f)) rmSync(join(OUT, f));
    const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    writeFileSync(join(OUT, MANIFEST), JSON.stringify({ format: 'fpvsim-bemt', inputs, tables: sorted(tables), stats: sorted(stats) }, null, 1) + '\n');
    console.log(`BEMT tables: ${Object.keys(tables).length} props, ${Object.keys(stats).length} preset cards, ${n} threads, ${((performance.now() - t0) / 1000).toFixed(1)} s -> ${BEMT_DIR}/`);
    if (!existsSync(join(OUT, MANIFEST))) process.exit(1);
  }
}
