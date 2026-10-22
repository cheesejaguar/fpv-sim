#!/usr/bin/env node
// Lossless PNG re-encoder for the map textures (no dependencies). The vendored Quake / Freedoom
// textures were 8-bit RGBA truecolor although they are paletted art (at most 256 colours, nearly all
// opaque), and several carried image-editor metadata (EXIF thumbnails, XMP). This writes each one as
// the smallest of: an exact palette PNG (1/2/4/8-bit, tRNS for the few with transparency), RGB, or
// RGBA, keeping the colour-space chunks (iCCP, sRGB, gAMA, cHRM) that change how a browser decodes
// it. Every candidate is decoded again and must give the same RGBA pixels as the original; a file
// is only replaced when that output is smaller.
//   node scripts/optimize-png.mjs [dir or file ...]     default: the Quake and Freedoom textures
//   node scripts/optimize-png.mjs --check [...]         exit 1 if a file would still shrink
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { constants, deflateSync, inflateSync } from 'node:zlib';

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
/** Ancillary chunks that change the decoded colours: copied through unchanged. */
const KEEP = new Set(['iCCP', 'sRGB', 'gAMA', 'cHRM']);

const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const b = Buffer.alloc(12 + data.length);
  b.writeUInt32BE(data.length, 0); b.write(type, 4, 'latin1'); data.copy(b, 8);
  b.writeUInt32BE(crc32(b.subarray(4, 8 + data.length)), 8 + data.length);
  return b;
}

function chunks(buf) {
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error('not a PNG');
  const out = [];
  for (let p = 8; p < buf.length;) {
    const n = buf.readUInt32BE(p), type = buf.toString('latin1', p + 4, p + 8);
    out.push({ type, data: buf.subarray(p + 8, p + 8 + n), raw: buf.subarray(p, p + 12 + n) });
    p += 12 + n;
    if (type === 'IEND') break;
  }
  return out;
}

const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };

/** Decode to RGBA (8-bit samples, any colour type, bit depths 1-8, not interlaced). */
export function decodePng(buf) {
  const cs = chunks(buf), ih = cs.find((c) => c.type === 'IHDR').data;
  const w = ih.readUInt32BE(0), h = ih.readUInt32BE(4), depth = ih[8], ct = ih[9];
  if (ih[12] !== 0) throw new Error('interlaced PNGs are not supported');
  if (depth > 8 || ![0, 2, 3, 4, 6].includes(ct)) throw new Error(`unsupported PNG (depth ${depth}, colour type ${ct})`);
  const chans = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ct];
  const bitsPP = chans * depth, bpp = Math.max(1, bitsPP >> 3), stride = Math.ceil((w * bitsPP) / 8);
  const z = inflateSync(Buffer.concat(cs.filter((c) => c.type === 'IDAT').map((c) => c.data)));
  const rows = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = z[y * (stride + 1)], src = z.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = rows.subarray(y * stride, (y + 1) * stride), prev = y ? rows.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev ? prev[i] : 0, c = prev && i >= bpp ? prev[i - bpp] : 0;
      cur[i] = (src[i] + (f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, c))) & 255;
    }
  }
  const plte = cs.find((c) => c.type === 'PLTE')?.data, trns = cs.find((c) => c.type === 'tRNS')?.data;
  const rgba = Buffer.alloc(w * h * 4), max = (1 << depth) - 1;
  const sample = (row, x, k) => {
    if (depth === 8) return row[x * chans + k];
    const bit = (x * chans + k) * depth;
    return (row[bit >> 3] >> (8 - depth - (bit & 7))) & max;
  };
  const scale = (v) => (depth === 8 ? v : Math.round((v * 255) / max));
  for (let y = 0; y < h; y++) {
    const row = rows.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (ct === 3) {
        const i = sample(row, x, 0);
        rgba[o] = plte[i * 3]; rgba[o + 1] = plte[i * 3 + 1]; rgba[o + 2] = plte[i * 3 + 2]; rgba[o + 3] = trns && i < trns.length ? trns[i] : 255;
      } else if (ct === 0 || ct === 4) {
        const g = scale(sample(row, x, 0));
        rgba[o] = rgba[o + 1] = rgba[o + 2] = g;
        rgba[o + 3] = ct === 4 ? scale(sample(row, x, 1)) : trns && trns.readUInt16BE(0) === sample(row, x, 0) ? 0 : 255;
      } else {
        const r = sample(row, x, 0), g = sample(row, x, 1), b = sample(row, x, 2);
        rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b;
        rgba[o + 3] = ct === 6 ? sample(row, x, 3) : trns && trns.readUInt16BE(0) === r && trns.readUInt16BE(2) === g && trns.readUInt16BE(4) === b ? 0 : 255;
      }
    }
  }
  return { w, h, rgba, keep: cs.filter((c) => KEEP.has(c.type)).map((c) => c.raw) };
}

/** Filtered scanlines -> zlib stream: the smaller of "no filter" and per-row adaptive filtering. */
function compress(rows, h, stride, bpp) {
  const none = Buffer.alloc(h * (stride + 1)), adaptive = Buffer.alloc(h * (stride + 1));
  const cand = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const cur = rows.subarray(y * stride, (y + 1) * stride), prev = y ? rows.subarray((y - 1) * stride, y * stride) : null;
    none[y * (stride + 1)] = 0; cur.copy(none, y * (stride + 1) + 1);
    let bestSum = Infinity;
    for (let f = 0; f < 5; f++) {
      let sum = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? cur[i - bpp] : 0, b = prev ? prev[i] : 0, c = prev && i >= bpp ? prev[i - bpp] : 0;
        const v = (cur[i] - (f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, c))) & 255;
        cand[i] = v; sum += v < 128 ? v : 256 - v;
      }
      if (sum < bestSum) { bestSum = sum; adaptive[y * (stride + 1)] = f; cand.copy(adaptive, y * (stride + 1) + 1); }
    }
  }
  let out = null;
  for (const raw of [none, adaptive]) for (const strategy of [constants.Z_DEFAULT_STRATEGY, constants.Z_FILTERED]) {
    const z = deflateSync(raw, { level: 9, memLevel: 9, strategy });
    if (!out || z.length < out.length) out = z;
  }
  return out;
}

function ihdr(w, h, depth, ct) {
  const b = Buffer.alloc(13);
  b.writeUInt32BE(w, 0); b.writeUInt32BE(h, 4); b[8] = depth; b[9] = ct;
  return chunk('IHDR', b);
}

/** Every lossless encoding worth trying, smallest first. */
export function encodings({ w, h, rgba, keep }) {
  const n = w * h, out = [];
  let opaque = true;
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 255) { opaque = false; break; }
  // exact palette: the translucent entries first (a short tRNS), then by first use
  const index = new Map(), order = [];
  for (let i = 0; i < n && order.length <= 256; i++) { const c = rgba.readUInt32BE(i * 4); if (!index.has(c)) { index.set(c, 0); order.push(c); } }
  if (order.length <= 256) {
    const pal = [...order.filter((c) => (c & 255) !== 255), ...order.filter((c) => (c & 255) === 255)];
    pal.forEach((c, i) => index.set(c, i));
    const depth = pal.length <= 2 ? 1 : pal.length <= 4 ? 2 : pal.length <= 16 ? 4 : 8;
    const stride = Math.ceil((w * depth) / 8), rows = Buffer.alloc(h * stride);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = index.get(rgba.readUInt32BE((y * w + x) * 4)), bit = x * depth;
      rows[y * stride + (bit >> 3)] |= i << (8 - depth - (bit & 7));
    }
    const plte = Buffer.alloc(pal.length * 3), alphas = pal.map((c) => c & 255);
    pal.forEach((c, i) => { plte[i * 3] = c >>> 24; plte[i * 3 + 1] = (c >>> 16) & 255; plte[i * 3 + 2] = (c >>> 8) & 255; });
    const nt = alphas.findLastIndex((a) => a !== 255) + 1;
    out.push(Buffer.concat([SIG, ihdr(w, h, depth, 3), ...keep, chunk('PLTE', plte), ...(nt ? [chunk('tRNS', Buffer.from(alphas.slice(0, nt)))] : []), chunk('IDAT', compress(rows, h, stride, 1)), chunk('IEND', Buffer.alloc(0))]));
  }
  // truecolour: RGB when opaque, else RGBA
  const ch = opaque ? 3 : 4, stride = w * ch, rows = Buffer.alloc(h * stride);
  for (let i = 0; i < n; i++) for (let k = 0; k < ch; k++) rows[i * ch + k] = rgba[i * 4 + k];
  out.push(Buffer.concat([SIG, ihdr(w, h, 8, opaque ? 2 : 6), ...keep, chunk('IDAT', compress(rows, h, stride, ch)), chunk('IEND', Buffer.alloc(0))]));
  return out.sort((a, b) => a.length - b.length);
}

/** The smallest pixel-identical re-encoding of `buf`, or null when none is smaller. */
export function optimizePng(buf) {
  const img = decodePng(buf);
  for (const enc of encodings(img)) {
    if (enc.length >= buf.length) return null;
    if (decodePng(enc).rgba.equals(img.rgba)) return enc; // (verified, never assumed)
  }
  return null;
}

function pngFiles(p) {
  if (!statSync(p).isDirectory()) return p.endsWith('.png') ? [p] : [];
  return readdirSync(p).sort().flatMap((f) => pngFiles(join(p, f)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2), check = args.includes('--check');
  const roots = args.filter((a) => !a.startsWith('--'));
  const dirs = roots.length ? roots : ['public/maps/quake/textures', 'public/maps/freedoom/textures'].map((d) => fileURLToPath(new URL(`../${d}`, import.meta.url)));
  let before = 0, after = 0, changed = 0, files = 0;
  for (const f of dirs.flatMap(pngFiles)) {
    const buf = readFileSync(f);
    let better = null;
    try { better = optimizePng(buf); } catch (e) { console.warn(`${f}: skipped (${e.message})`); }
    files++; before += buf.length; after += better ? better.length : buf.length;
    if (better) { changed++; if (!check) writeFileSync(f, better); }
  }
  console.log(`${check ? 'would re-encode' : 're-encoded'} ${changed} of ${files} PNGs: ${(before / 1024).toFixed(0)} -> ${(after / 1024).toFixed(0)} KiB`);
  if (check && changed) process.exit(1);
}
