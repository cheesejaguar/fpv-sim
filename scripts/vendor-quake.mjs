// Vendors the Quake maps used by the simulator into public/maps/quake/.
//
//   node scripts/vendor-quake.mjs <romero-map-sources-dir> <LibreQuake-checkout>
//
// <romero-map-sources-dir>: the unpacked https://rome.ro/s/1996-quake-map-sources.zip (id Software's
//   original .MAP files, released by John Romero in October 2006 under the GNU GPL; see
//   release_readme.txt / gnu.txt in that archive). Only the .map sources are GPL: Quake's original
//   textures are NOT, and are not used here.
// <LibreQuake-checkout>: a clone of https://github.com/lavenderdotpet/LibreQuake (BSD-3-Clause art,
//   docs/COPYING). Every id texture name used by the maps is replaced by a LibreQuake texture chosen
//   for the same role (wall / floor / light / trim ...) via the SUB table below.
//
// Output: <id>.map, textures/<librequake-name>.png and textures/manifest.json
// ({ idTextureName: { file, w, h } }; the sizes are needed to compute UVs before the images load).
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { optimizePng } from './optimize-png.mjs';

const MAPS = { e1m1: 'E1M1.MAP', dm3: 'DM3.MAP' };

// id texture name -> LibreQuake texture name. Names not listed fall back to an identically-named
// LibreQuake texture when one exists (with + -> plus_, * -> star_).
const SUB = {
  // base tech walls
  tech01_1: 't_blok10', tech01_2: 't_blok02', tech01_5: 't_trim1a', tech01_6: 't_blok08', tech01_7: 't_blok11', tech01_9: 't_blok09',
  tech02_6: 't_tech02', tech02_7: 't_tech03', tech03_1: 't_tech04', tech03_2: 't_tech05',
  tech04_1: 't_blok05', tech04_2: 't_wall2a', tech04_3: 't_blok06', tech04_4: 't_trim2a', tech04_5: 't_wall3a', tech04_6: 't_trim1b', tech04_7: 't_wall2b', tech04_8: 't_trim2b',
  tech05_1: 't_blok10', tech05_2: 't_blok11', tech06_1: 't_metalsheeta', tech06_2: 't_metalsheetb', tech07_1: 'aqmetl01', tech07_2: 'aqmetl14',
  tech09_3: 'tech14-1', tech10_1: 'tech10_3', tech11_2: 't_tech06',
  twall1_1: 't_wall6a', twall1_2: 't_wall6b', twall2_1: 'twall2_3', twall2_2: 't_wall7a', twall2_5: 't_wall7b', twall2_6: 't_wall6c', twall3_1: 't_wall3b', twall5_1: 't_wall05', twall5_3: 't_wall6d',
  ecop1_6: 'ecop1_4', emetal1_3: 'met_brn_pan1',
  // floors / ground
  sfloor4_1: 't_flor1a', sfloor4_2: 't_flor2a', sfloor4_4: 't_flor1b', sfloor4_5: 't_flor2b', sfloor4_7: 't_flor2c', sfloor4_8: 'tek_grate',
  sfloor1_2: 't_flor2d', sfloor3_2: 'tek_flr3', ground1_2: 'med_rock3', ground1_6: 'gravel1', ground1_7: 'med_rock10',
  // lights
  tlight01: 'tlight11_fbr', tlight02: 'tlight12_fbr', tlight03: 'tlight13_fbr', tlight07: 'tek_lit1_fbr', tlight08: 'tek_lit2_fbr', tlight09: 'tek_lit3_fbr', tlight10: 'tlightfb_fbr', tlight11: 'tlight11_fbr',
  // slipgate, buttons, misc
  slip1: 'plus_0slipbot', '+0slip': 'plus_0slipbot', slipbotsd: 't_trim2c', sliptopsd: 't_trim2c', slipside: 't_trim1c', sliplite: 'tlightblfb_fbr',
  switch_1: 'plus_0button1', basebutn3: 'plus_abasebtn', '+0basebtn': 'plus_0basebtn_fbr', '+0planet': 'plus_0planet_a_fbr', key01_3: 'met_brn_det1',
  tele_top: 'tele_frame1', z_exit: 'z_exit_fbr', '*slime0': 'star_slime1',
};
// Never rendered (tool brushes / sky): no texture needed.
const SKIP = new Set(['clip', 'trigger', 'skip', 'hint', 'sky4', 'sky1', 'sky3']);

const [src, lq] = process.argv.slice(2);
if (!src || !lq) { console.error('usage: node scripts/vendor-quake.mjs <romero-map-sources-dir> <LibreQuake-checkout>'); process.exit(1); }
const out = new URL('../public/maps/quake/', import.meta.url);
await mkdir(new URL('textures/', out), { recursive: true });

// index LibreQuake textures by lower-case name
const index = new Map();
const wadRoot = join(lq, 'texture-wads');
for (const wad of await readdir(wadRoot, { withFileTypes: true })) {
  if (!wad.isDirectory()) continue;
  for (const f of await readdir(join(wadRoot, wad.name))) if (f.endsWith('.png')) index.set(f.slice(0, -4).toLowerCase(), join(wadRoot, wad.name, f));
}

const pngSize = (buf) => ({ w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) });
const manifest = {};
const missing = [];
for (const [id, file] of Object.entries(MAPS)) {
  const text = await readFile(join(src, file), 'latin1');
  await writeFile(new URL(`${id}.map`, out), text, 'latin1');
  for (const m of text.matchAll(/\)\s+(\S+)\s+-?[\d.]+\s+-?[\d.]+\s+-?[\d.]+\s+-?[\d.]+\s+-?[\d.]+/g)) {
    const name = m[1].toLowerCase();
    if (manifest[name] || SKIP.has(name)) continue;
    const lqName = SUB[name] ?? name.replace(/^\+/, 'plus_').replace(/^\*/, 'star_');
    const path = index.get(lqName);
    if (!path) { if (!missing.includes(name)) missing.push(name); continue; }
    const buf = await readFile(path);
    // re-encoded losslessly (palette PNG, editor metadata dropped): same pixels, ~1/3 the bytes
    await writeFile(new URL(`textures/${lqName}.png`, out), optimizePng(buf) ?? buf);
    manifest[name] = { file: `${lqName}.png`, ...pngSize(buf) };
  }
}
await writeFile(new URL('textures/manifest.json', out), JSON.stringify(manifest, null, 1) + '\n');
console.log(`${Object.keys(manifest).length} textures`);
if (missing.length) console.warn(`no LibreQuake texture for: ${missing.join(' ')}`);
