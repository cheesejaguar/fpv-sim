#!/usr/bin/env node
// Validate fpvsim-map packages: JSON Schema, structure, budgets, licence files and that the map
// actually loads and builds (the same loader the app uses: src/maps/mapFormat.ts).
//   npm run map:validate -- public/maps/community/my-map      a package folder
//   npm run map:validate -- my-map.zip                        a zipped package
//   npm run map:validate -- --all                             every community map (CI)
// Options: --local  relax the repository rules (licence files, folder name) for a private map.
// Exit code 1 if any package has errors.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import { loadTs } from './lib/load-ts.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const COMMUNITY = join(ROOT, 'public/maps/community');
const args = process.argv.slice(2);
const local = args.includes('--local');
let targets = args.filter((a) => !a.startsWith('--'));
if (args.includes('--all')) targets = readdirSync(COMMUNITY).map((d) => join(COMMUNITY, d)).filter((p) => statSync(p).isDirectory());
if (!targets.length) { console.error('usage: npm run map:validate -- <package folder | .zip> [...] [--local] | --all'); process.exit(2); }

const schema = JSON.parse(readFileSync(join(ROOT, 'schemas/map.v1.schema.json'), 'utf8'));
const ajv = new Ajv({ allErrors: true, strict: false });
const schemaCheck = ajv.compile(schema);

function walk(dir, base = dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, base, out); else out.push({ path: relative(base, p).split(sep).join('/'), size: statSync(p).size, abs: p });
  }
  return out;
}

const { mods: [mf, zip], close } = await loadTs('src/maps/mapFormat.ts', 'src/maps/zip.ts');
let failed = 0;
for (const t of targets) {
  const abs = resolve(t);
  let files, read, folderId;
  if (!existsSync(abs)) { console.error(`\n✗ ${t}: no such file or folder`); failed++; continue; }
  if (statSync(abs).isDirectory()) {
    files = walk(abs);
    read = async (p) => { const f = files.find((x) => x.path === p); if (!f) throw new Error('no such file'); return new Uint8Array(readFileSync(f.abs)); };
    folderId = basename(abs);
  } else {
    const entries = zip.readZip(new Uint8Array(readFileSync(abs)));
    // the package root is the folder holding the shallowest map.json
    const mj = entries.filter((e) => e.path.split('/').pop() === 'map.json').sort((a, b) => a.path.length - b.path.length)[0];
    const prefix = mj ? mj.path.slice(0, -'map.json'.length) : '';
    const inPkg = entries.filter((e) => e.path.startsWith(prefix) && !/(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db)/.test(e.path));
    files = inPkg.map((e) => ({ path: e.path.slice(prefix.length), size: e.size, entry: e }));
    read = async (p) => { const f = files.find((x) => x.path === p); if (!f) throw new Error('no such file'); return f.entry.read(); };
    folderId = prefix ? prefix.replace(/\/$/, '').split('/').pop() : undefined;
  }
  const strict = !local;
  const src = { read, url: (p) => p, list: async () => files.map(({ path, size }) => ({ path, size })) };
  const errors = [], warnings = [];
  // 1. the loader: structure, budgets, licences, assets, and that the map builds (clearest messages) ...
  let stats;
  try {
    const m = await mf.loadMapPackage(src, { strict, folderId: strict ? folderId : undefined, checkAssets: true });
    warnings.push(...m.warnings); stats = m.stats;
  } catch (e) {
    if (e instanceof mf.MapFormatError) { errors.push(...e.errors); warnings.push(...e.warnings); } else errors.push(String(e?.stack ?? e));
  }
  // 2. ... and the JSON Schema that editors check against: the two must agree
  if (!errors.length) try {
    const doc = JSON.parse(new TextDecoder().decode(await read('map.json')));
    if (!schemaCheck(doc)) for (const e of schemaCheck.errors) errors.push(`schema: map.json${e.instancePath.replace(/\/(\d+)/g, '[$1]').replace(/\//g, '.')} ${e.message}${e.params?.additionalProperty ? ` ("${e.params.additionalProperty}")` : ''}`);
  } catch (e) { errors.push(`map.json: ${e.message}`); }
  const name = relative(process.cwd(), abs) || t;
  if (errors.length) { failed++; console.error(`\n✗ ${name}`); for (const e of [...new Set(errors)]) console.error(`  error   ${e}`); }
  else console.log(`\n✓ ${name}`);
  for (const w of warnings) console.log(`  warning ${w}`);
  if (stats) console.log(`  ${stats.primitives}/${mf.BUDGETS.primitives} primitives, ${stats.gates} gates, ${stats.trees} trees, ${stats.brushes} brushes, ${stats.meshTriangles} mesh triangles (${stats.collisionTriangles} with collision), ${((stats.bytes ?? 0) / 1024).toFixed(0)} KiB`);
}
await close();
console.log(failed ? `\n${failed} of ${targets.length} map package(s) failed validation` : `\nall ${targets.length} map package(s) valid`);
process.exit(failed ? 1 : 0);
