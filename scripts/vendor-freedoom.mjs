// Vendors one Freedoom level used by the simulator into public/maps/freedoom/.
//
//   node scripts/vendor-freedoom.mjs <freedoom-release-dir>
//
// <freedoom-release-dir>: the unpacked https://github.com/freedoom/freedoom/releases/download/v0.13.0/freedoom-0.13.0.zip
//   (freedoom2.wad, COPYING.txt, CREDITS.txt). Freedoom is BSD-3-Clause; no original id Doom / Doom II
//   data is read or written here.
//
// Output:
//   map01.json            the level's raw lumps (THINGS, LINEDEFS, SIDEDEFS, VERTEXES, SECTORS) as base64;
//                         src/maps/doomMap.ts parses them
//   textures/*.png        the wall textures (composited from their patches) and flats the level uses,
//                         converted through PLAYPAL to RGBA (transparent where a masked texture has no patch)
//   textures/manifest.json { "w/NAME" | "f/NAME": { file, w, h } }; sizes are needed for UVs before images load
//   COPYING.txt, CREDITS.txt, ATTRIBUTION.md
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

const WAD = 'freedoom2.wad';
const LEVEL = 'MAP01';
const TITLE = 'Hydroelectric Plant';
const RELEASE = '0.13.0';
const LEVEL_LUMPS = ['THINGS', 'LINEDEFS', 'SIDEDEFS', 'VERTEXES', 'SECTORS'];
const SKY_FLAT = 'F_SKY1';

const [dir] = process.argv.slice(2);
if (!dir) { console.error('usage: node scripts/vendor-freedoom.mjs <freedoom-release-dir>'); process.exit(1); }
const out = new URL('../public/maps/freedoom/', import.meta.url);
await rm(out, { recursive: true, force: true });
await mkdir(new URL('textures/', out), { recursive: true });

// ---- WAD directory ----
const wad = await readFile(join(dir, WAD));
if (wad.toString('latin1', 0, 4) !== 'IWAD') throw new Error(`${WAD}: not an IWAD`);
const lumps = [];
for (let i = 0, n = wad.readInt32LE(4), o = wad.readInt32LE(8); i < n; i++, o += 16)
  lumps.push({ name: wad.toString('latin1', o + 8, o + 16).replace(/\0.*$/s, '').toUpperCase(), data: wad.subarray(wad.readInt32LE(o), wad.readInt32LE(o) + wad.readInt32LE(o + 4)) });
const lump = (name) => { for (let i = lumps.length - 1; i >= 0; i--) if (lumps[i].name === name) return lumps[i].data; return null; };
const name8 = (b, o) => b.toString('latin1', o, o + 8).replace(/\0.*$/s, '').toUpperCase();

// ---- level lumps ----
const li = lumps.findIndex((l) => l.name === LEVEL);
if (li < 0) throw new Error(`${LEVEL} not in ${WAD}`);
const level = {};
for (const l of lumps.slice(li + 1, li + 11)) if (LEVEL_LUMPS.includes(l.name)) level[l.name] = l.data;
for (const n of LEVEL_LUMPS) if (!level[n]) throw new Error(`${LEVEL}: missing ${n}`);
await writeFile(new URL(`${LEVEL.toLowerCase()}.json`, out), JSON.stringify({
  wad: `Freedoom ${RELEASE} ${WAD}`, level: LEVEL, title: TITLE,
  lumps: Object.fromEntries(LEVEL_LUMPS.map((n) => [n, level[n].toString('base64')])),
}) + '\n');

// textures / flats this level references
const walls = new Set(), flats = new Set();
for (let o = 0; o < level.SIDEDEFS.length; o += 30) for (const k of [4, 12, 20]) { const t = name8(level.SIDEDEFS, o + k); if (t && t !== '-') walls.add(t); }
for (let o = 0; o < level.SECTORS.length; o += 26) for (const k of [4, 12]) { const f = name8(level.SECTORS, o + k); if (f !== SKY_FLAT) flats.add(f); }

// ---- palette, PNG ----
const pal = lump('PLAYPAL');
const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const b = Buffer.alloc(12 + data.length);
  b.writeUInt32BE(data.length, 0); b.write(type, 4, 'latin1'); data.copy(b, 8);
  b.writeUInt32BE(crc32(b.subarray(4, 8 + data.length)), 8 + data.length);
  return b;
};
/** idx: palette index per pixel, -1 = transparent. */
function png(w, h, idx) {
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = idx[y * w + x], o = y * (1 + w * 4) + 1 + x * 4;
    if (i >= 0) { raw[o] = pal[i * 3]; raw[o + 1] = pal[i * 3 + 1]; raw[o + 2] = pal[i * 3 + 2]; raw[o + 3] = 255; }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const manifest = {};
const fileName = (n) => n.toLowerCase().replace(/[^a-z0-9_-]/g, (c) => `_${c.charCodeAt(0).toString(16)}`) + '.png';

// ---- flats: 64x64 palette indices between F_START / F_END ----
const fs0 = lumps.findIndex((l) => l.name === 'F_START'), fs1 = lumps.findIndex((l) => l.name === 'F_END');
const flatLump = (n) => { for (let i = fs1; i > fs0; i--) if (lumps[i].name === n && lumps[i].data.length === 4096) return lumps[i].data; return null; };
const missing = [];
for (const f of [...flats].sort()) {
  const d = flatLump(f);
  if (!d) { missing.push(`flat ${f}`); continue; }
  const file = `flat_${fileName(f)}`;
  await writeFile(new URL(`textures/${file}`, out), png(64, 64, Int16Array.from(d)));
  manifest[`f/${f}`] = { file, w: 64, h: 64 };
}

// ---- wall textures: TEXTURE1/2 composites of PNAMES patches ----
const pn = lump('PNAMES');
const pnames = Array.from({ length: pn.readInt32LE(0) }, (_, i) => name8(pn, 4 + i * 8));
const defs = new Map();
for (const tl of ['TEXTURE1', 'TEXTURE2']) {
  const t = lump(tl);
  if (!t) continue;
  for (let i = 0, n = t.readInt32LE(0); i < n; i++) {
    const o = t.readInt32LE(4 + i * 4), np = t.readInt16LE(o + 20);
    defs.set(name8(t, o), {
      w: t.readInt16LE(o + 12), h: t.readInt16LE(o + 14),
      patches: Array.from({ length: np }, (_, k) => ({ x: t.readInt16LE(o + 22 + k * 10), y: t.readInt16LE(o + 24 + k * 10), name: pnames[t.readInt16LE(o + 26 + k * 10)] })),
    });
  }
}
/** Doom picture format: column offsets, posts of (topdelta, length, pad, pixels..., pad), 0xff ends a column. */
function drawPatch(p, dst, w, h, ox, oy) {
  const pw = p.readInt16LE(0);
  for (let x = 0; x < pw; x++) {
    const dx = ox + x;
    if (dx < 0 || dx >= w) continue;
    let o = p.readUInt32LE(8 + x * 4), top = -1;
    while (p[o] !== 0xff) {
      const delta = p[o], len = p[o + 1];
      top = delta <= top ? top + delta : delta; // tall patches: relative offsets
      for (let k = 0; k < len; k++) { const dy = oy + top + k; if (dy >= 0 && dy < h) dst[dy * w + dx] = p[o + 3 + k]; }
      o += len + 4;
    }
  }
}
for (const t of [...walls].sort()) {
  const def = defs.get(t);
  if (!def) { missing.push(`texture ${t}`); continue; }
  const idx = new Int16Array(def.w * def.h).fill(-1);
  for (const pp of def.patches) { const p = lump(pp.name); if (p) drawPatch(p, idx, def.w, def.h, pp.x, pp.y); else missing.push(`patch ${pp.name}`); }
  const file = fileName(t);
  await writeFile(new URL(`textures/${file}`, out), png(def.w, def.h, idx));
  manifest[`w/${t}`] = { file, w: def.w, h: def.h };
}
await writeFile(new URL('textures/manifest.json', out), JSON.stringify(manifest, null, 1) + '\n');

// ---- licence + attribution ----
await copyFile(join(dir, 'COPYING.txt'), new URL('COPYING.txt', out));
await copyFile(join(dir, 'CREDITS.txt'), new URL('CREDITS.txt', out));
const sha = createHash('sha256').update(wad).digest('hex');
await writeFile(new URL('ATTRIBUTION.md', out), `# Freedoom ${LEVEL}: ${TITLE}

The level geometry and textures in this folder come from **Freedoom**
(https://freedoom.github.io/), Phase 2, level ${LEVEL} "${TITLE}".

- Source: Freedoom ${RELEASE} release, \`${WAD}\` (SHA-256 \`${sha}\`), from
  https://github.com/freedoom/freedoom/releases/tag/v${RELEASE}
- Copyright © 2001-2024 Contributors to the Freedoom project. All rights reserved.
- License: BSD-3-Clause. The full text is in [COPYING.txt](COPYING.txt).
- The Freedoom contributors are listed in [CREDITS.txt](CREDITS.txt).

## What is included

- \`${LEVEL.toLowerCase()}.json\`: the level's ${LEVEL_LUMPS.join(', ')} lumps, unmodified, base64-encoded.
- \`textures/\`: the ${Object.keys(manifest).filter((k) => k.startsWith('w/')).length} wall textures and ${Object.keys(manifest).filter((k) => k.startsWith('f/')).length} flats this level uses. They
  were converted to PNG through Freedoom's PLAYPAL palette. Wall textures are composited from their patches
  as defined in TEXTURE1 / PNAMES. Pixels are otherwise unmodified.

At load time the simulator changes the level as follows:
- It opens doors and scales the geometry to metres.
- It ignores monsters, items and line specials.

## Not included

No original id Software Doom / Doom II data (IWADs, textures, sprites, sounds or levels) is used.

## No endorsement

This project is not affiliated with or endorsed by the Freedoom project or its contributors. Under the
BSD-3-Clause license, the Freedoom name and its contributors' names may not be used to endorse or promote
this project.

Regenerate this folder with \`node scripts/vendor-freedoom.mjs <freedoom-${RELEASE}-dir>\`.
`);
console.log(`${LEVEL}: ${Object.keys(manifest).length} textures/flats`);
if (missing.length) console.warn(`missing: ${[...new Set(missing)].join(' ')}`);
