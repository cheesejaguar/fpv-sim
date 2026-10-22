// Precomputed propeller BEMT tables. Building one (buildBemtTable: 34 x 31 operating points, each a
// blade-element solve) costs ~1.1-1.8 s, and the page did it on every load in the main thread and
// again in the simulation worker. scripts/build-bemt-tables.mjs (prebuild / predev) computes the
// table of every catalogue prop with this same code and writes it to public/bemt/ under a
// content-hashed name; vite.config.ts hands the list to the app as __BEMT_TABLES__, only when the
// physics sources still hash to what the tables were made from. Without it (tests, a stale or
// missing build, a failed download) the table is simply computed as before.
import type { BemtTable } from '../sim/bemt';

/** Defined by vite.config.ts: base path and file name of each prop's table (null: none usable). */
declare const __BEMT_TABLES__: BemtManifest | null | undefined;

export interface BemtManifest {
  /** directory under the site root, e.g. "bemt/" */
  base: string;
  /** prop id -> file name in `base` (content-hashed: served immutable) */
  tables: Record<string, string>;
}

export function bemtManifest(): BemtManifest | null {
  const m = typeof __BEMT_TABLES__ !== 'undefined' ? __BEMT_TABLES__ : null;
  return m && typeof m === 'object' && m.tables ? m : null;
}

const MAGIC = 0x544d4542; // "BEMT" little-endian
const VERSION = 1;

/**
 * Binary form of a table: magic, version, header length, a JSON header (every number field, and the
 * name and length of every Float32Array field, in order), padding to 4 bytes, then the arrays.
 * Generic over the fields, so a table that grows a field still round-trips; JSON keeps doubles exact.
 */
export function encodeTable(t: BemtTable): Uint8Array<ArrayBuffer> {
  const scalars: Record<string, number> = {}, arrays: [string, number][] = [], data: Float32Array[] = [];
  for (const [k, v] of Object.entries(t)) {
    if (v instanceof Float32Array) { arrays.push([k, v.length]); data.push(v); }
    else if (typeof v === 'number') { if (!Number.isFinite(v)) throw new Error(`BEMT table field ${k}: ${v}`); scalars[k] = v; }
    else throw new Error(`BEMT table field ${k}: unsupported type`);
  }
  const head = new TextEncoder().encode(JSON.stringify({ scalars, arrays }));
  const off = (12 + head.length + 3) & ~3;
  const out = new Uint8Array(off + data.reduce((a, d) => a + d.byteLength, 0));
  const dv = new DataView(out.buffer);
  dv.setUint32(0, MAGIC, true); dv.setUint32(4, VERSION, true); dv.setUint32(8, head.length, true);
  out.set(head, 12);
  let o = off;
  for (const d of data) { out.set(new Uint8Array(d.buffer, d.byteOffset, d.byteLength), o); o += d.byteLength; }
  return out;
}

export function decodeTable(bytes: ArrayBuffer | Uint8Array): BemtTable {
  // a plain view (a Node Buffer's slice() is a view of its memory, not the copy the arrays need below)
  const u8 = bytes instanceof Uint8Array ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : new Uint8Array(bytes);
  if (u8.length < 12) throw new Error('BEMT table: truncated');
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (dv.getUint32(0, true) !== MAGIC || dv.getUint32(4, true) !== VERSION) throw new Error('BEMT table: not a table');
  const hl = dv.getUint32(8, true);
  if (12 + hl > u8.length) throw new Error('BEMT table: truncated');
  const head = JSON.parse(new TextDecoder().decode(u8.subarray(12, 12 + hl))) as { scalars: Record<string, number>; arrays: [string, number][] };
  const t: Record<string, number | Float32Array> = { ...head.scalars };
  let o = (12 + hl + 3) & ~3;
  for (const [k, n] of head.arrays) {
    if (o + n * 4 > u8.length) throw new Error('BEMT table: truncated');
    t[k] = new Float32Array(u8.slice(o, o + n * 4).buffer); // copied: 4-byte aligned, its own buffer
    o += n * 4;
  }
  if (o !== u8.length) throw new Error('BEMT table: trailing bytes');
  const r = t as unknown as BemtTable;
  if (!(r.nb > 1 && r.ng > 1) || !(r.ct instanceof Float32Array) || r.ct.length !== r.nb * r.ng) throw new Error('BEMT table: bad shape');
  return r;
}
