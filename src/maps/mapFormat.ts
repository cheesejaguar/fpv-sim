// fpvsim-map v1: declarative JSON map packages (docs/MAP_FORMAT.md, schemas/map.v1.schema.json).
// A package is a folder with map.json + assets. loadMapPackage() reads and strictly validates it
// (structure, budgets, licence files, asset formats), decodes what collision needs (heightfield
// PNG, Quake .map / Doom lump JSON, .glb triangles), and returns a synchronous MapDef builder that
// the physics worker and the renderer both run, so they agree exactly.
//
// NOTE: maps.ts imports this module and this module imports maps.ts (gate geometry). Keep this
// module's top level free of calls into maps.ts, and packageEntry() free of top-level state access.
import { V3 } from '../sim/math';
import type { WakeZone, WindVolume } from '../sim/wind';
import { doomMapDef } from './doomMap';
import { buildGatePrims, type MapEntry } from './maps';
import { quakeMapDef } from './quakeMap';
import { ActorDef, BoxPrim, BrushPrim, CourseDef, fbm, GateDef, MapDef, Material, MeshInstance, Prim, SpawnDef } from './world';
import { type ActorDoc, ASSET_EXT, assetPathError, BUDGETS, decodePngChannel, DOC_FILE, FORBIDDEN_EXT, GATE_SIZE, type GateDoc, type GroundDoc, imageSize, MapFormatError, type MapDocV1, NEEDS_TEXT, type SpawnDoc, validateMapDoc } from './mapDoc';

export * from './mapDoc';

/** Triangles (ENU metres, before placement) of a binary glTF 2.0 file, its drawn triangle count and its embedded images. */
export function glbTriangles(b: Uint8Array): { positions: Float64Array; triangles: number; images: Uint8Array[] } {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length < 20 || dv.getUint32(0, true) !== 0x46546c67) throw new Error('not a binary glTF (.glb) file');
  if (dv.getUint32(4, true) !== 2) throw new Error(`glTF version ${dv.getUint32(4, true)} is not supported (need 2.0)`);
  let json: any = null, bin: Uint8Array | null = null;
  for (let o = 12; o + 8 <= Math.min(b.length, dv.getUint32(8, true));) {
    const len = dv.getUint32(o, true), type = dv.getUint32(o + 4, true);
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(b.subarray(o + 8, o + 8 + len)));
    else if (type === 0x004e4942 && !bin) bin = b.subarray(o + 8, o + 8 + len);
    o += 8 + len;
  }
  if (!json) throw new Error('.glb has no JSON chunk');
  const okExt = /^KHR_(materials_|texture_transform|mesh_quantization$)/;
  const bad = (json.extensionsRequired ?? []).filter((e: string) => !okExt.test(e));
  if (bad.length) throw new Error(`required glTF extensions are not supported: ${bad.join(', ')} (no Draco / meshopt / KTX2; export uncompressed)`);
  for (const buf of json.buffers ?? []) if (buf.uri !== undefined) throw new Error('.glb must embed its buffers (external or data: URIs are not supported)');
  for (const img of json.images ?? []) if (img.uri !== undefined) throw new Error('.glb must embed its images in the binary chunk');
  const COMP: Record<number, [number, (o: number) => number]> = {
    5120: [1, (o) => dv.getInt8(o)], 5121: [1, (o) => dv.getUint8(o)], 5122: [2, (o) => dv.getInt16(o, true)],
    5123: [2, (o) => dv.getUint16(o, true)], 5125: [4, (o) => dv.getUint32(o, true)], 5126: [4, (o) => dv.getFloat32(o, true)],
  };
  const NUM: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
  const accessor = (i: number): number[] => {
    const a = json.accessors?.[i];
    if (!a) throw new Error(`glTF accessor ${i} missing`);
    if (a.sparse) throw new Error('sparse glTF accessors are not supported');
    const [size, get] = COMP[a.componentType] ?? []; const n = NUM[a.type];
    if (!get || !n) throw new Error(`glTF accessor ${i}: unsupported type`);
    if (a.bufferView === undefined) return new Array(a.count * n).fill(0);
    const bv = json.bufferViews[a.bufferView];
    if (!bin || bv.buffer !== 0) throw new Error('glTF buffer view outside the .glb binary chunk');
    const stride = bv.byteStride ?? size * n, out: number[] = new Array(a.count * n);
    const off0 = bin.byteOffset - b.byteOffset + (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
    if (off0 + stride * (a.count - 1) + size * n > bin.byteOffset - b.byteOffset + bin.length) throw new Error(`glTF accessor ${i} runs past the binary chunk`);
    const norm = a.normalized ? ({ 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 } as Record<number, number>)[a.componentType] ?? 1 : 1;
    for (let e = 0; e < a.count; e++) for (let k = 0; k < n; k++) out[e * n + k] = get(off0 + e * stride + k * size) / norm;
    return out;
  };
  const mul = (a: number[], m: number[]) => { const r = new Array(16).fill(0); for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) for (let k = 0; k < 4; k++) r[j * 4 + i] += a[k * 4 + i] * m[j * 4 + k]; return r; };
  const local = (n: any): number[] => {
    if (n.matrix) return n.matrix;
    const [x, y, z, w] = n.rotation ?? [0, 0, 0, 1], [sx, sy, sz] = n.scale ?? [1, 1, 1], [tx, ty, tz] = n.translation ?? [0, 0, 0];
    return [(1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
      2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
      2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0, tx, ty, tz, 1];
  };
  const pos: number[] = [];
  let triangles = 0;
  const visit = (ni: number, parent: number[], depth: number) => {
    const n = json.nodes?.[ni];
    if (!n || depth > 64) return;
    const m = mul(parent, local(n));
    if (n.mesh !== undefined) for (const p of json.meshes[n.mesh].primitives ?? []) {
      if ((p.mode ?? 4) !== 4 || p.attributes?.POSITION === undefined) continue;
      const v = accessor(p.attributes.POSITION);
      const idx = p.indices !== undefined ? accessor(p.indices) : [...Array(v.length / 3).keys()];
      triangles += Math.floor(idx.length / 3);
      for (const i of idx) {
        const x = v[i * 3], y = v[i * 3 + 1], z = v[i * 3 + 2];
        const gx = m[0] * x + m[4] * y + m[8] * z + m[12], gy = m[1] * x + m[5] * y + m[9] * z + m[13], gz = m[2] * x + m[6] * y + m[10] * z + m[14];
        pos.push(gx, -gz, gy); // glTF (+X right, +Y up, +Z toward the viewer) -> ENU: x = east, y = north = -Z, z = up = +Y
      }
    }
    for (const c of n.children ?? []) visit(c, m, depth + 1);
  };
  const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const scene = json.scenes?.[json.scene ?? 0];
  for (const ni of scene?.nodes ?? []) visit(ni, I, 0);
  const images: Uint8Array[] = [];
  for (const img of json.images ?? []) {
    const bv = json.bufferViews?.[img.bufferView];
    if (bin && bv) images.push(bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength));
  }
  return { positions: new Float64Array(pos), triangles, images };
}

const SLAB_T = 0.05; // mesh collision: each triangle is a solid slab this thick behind its front face (m)

/** One triangle as a thin convex brush (front face, back face, three edge planes): exact sphere / ray collision. */
export function triangleBrush(a: number[], b: number[], c: number[], mat: Material, tag?: string): BrushPrim | null {
  const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  let n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
  const l = Math.hypot(n[0], n[1], n[2]);
  if (l < 1e-8) return null; // degenerate
  n = n.map((x) => x / l);
  const dot = (p: number[], q: number[]) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
  const back = [a, b, c].map((p) => p.map((x, k) => x - n[k] * SLAB_T));
  const planes = [n[0], n[1], n[2], dot(n, a), -n[0], -n[1], -n[2], -dot(n, back[0])];
  const tri = [a, b, c];
  for (let i = 0; i < 3; i++) {
    const p = tri[i], q = tri[(i + 1) % 3], e = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
    let m = [e[1] * n[2] - e[2] * n[1], e[2] * n[0] - e[0] * n[2], e[0] * n[1] - e[1] * n[0]]; // outward for CCW seen from n
    const ml = Math.hypot(m[0], m[1], m[2]);
    m = m.map((x) => x / ml);
    planes.push(m[0], m[1], m[2], dot(m, p));
  }
  const edges: number[] = [];
  for (let i = 0; i < 3; i++) { const j = (i + 1) % 3; edges.push(...tri[i], ...tri[j], ...back[i], ...back[j], ...tri[i], ...back[i]); }
  const all = [...tri, ...back];
  const min = { x: Math.min(...all.map((p) => p[0])), y: Math.min(...all.map((p) => p[1])), z: Math.min(...all.map((p) => p[2])) };
  const max = { x: Math.max(...all.map((p) => p[0])), y: Math.max(...all.map((p) => p[1])), z: Math.max(...all.map((p) => p[2])) };
  return { kind: 'brush', c: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 }, planes: new Float64Array(planes), edges: new Float64Array(edges), min, max, mat, tag };
}

// ---------------------------------------------------------------------------------------------
// Terrain

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Height function for a ground spec (heightfield already decoded). Shared by worker and renderer. */
export function makeTerrain(g: GroundDoc | undefined, hf?: { w: number; h: number; data: Float32Array }): (x: number, y: number) => number {
  if (!g) return () => 0;
  if (g.type === 'flat') { const z = g.z ?? 0; return () => z; }
  if (g.type === 'heightfield') {
    const { w, h, data } = hf!, [ex, ey] = g.extent, [cx, cy] = g.center ?? [0, 0], z0 = g.zMin, dz = g.zMax - g.zMin;
    const x0 = cx - ex / 2, y1 = cy + ey / 2;
    return (x, y) => {
      // pixel (0, 0) is the north-west corner; columns run east, rows run south; edges clamp
      const u = Math.min(w - 1, Math.max(0, ((x - x0) / ex) * (w - 1))), v = Math.min(h - 1, Math.max(0, ((y1 - y) / ey) * (h - 1)));
      const i = Math.min(w - 2, Math.floor(u)), j = Math.min(h - 2, Math.floor(v)), fu = u - i, fv = v - j;
      const a = data[j * w + i], b = data[j * w + i + 1], c = data[(j + 1) * w + i], d = data[(j + 1) * w + i + 1];
      return z0 + dz * (a + (b - a) * fu + (c - a) * fv + (a - b - c + d) * fu * fv);
    };
  }
  const base = g.base ?? 0;
  const layers = g.layers.map((l) => {
    const oct = l.octaves ?? 4, seed = l.seed ?? 1, s = l.scale, amp = l.amplitude, mk = l.mask;
    if (!mk) return (x: number, y: number) => fbm(x / s, y / s, oct, seed) * amp;
    const [mx, my] = mk.center ?? [0, 0], span = mk.to - mk.from, inv = !!mk.invert, sq = mk.shape === 'square';
    return (x: number, y: number) => {
      const r = sq ? Math.max(Math.abs(x - mx), Math.abs(y - my)) : Math.hypot(x - mx, y - my);
      const m = clamp01((r - mk.from) / span);
      return (inv ? 1 - m : m) * fbm(x / s, y / s, oct, seed) * amp;
    };
  });
  return (x, y) => { let z = base; for (const f of layers) z += f(x, y); return z; };
}

// ---------------------------------------------------------------------------------------------
// Package loading

export interface PackageSource {
  /** Read a package file by its relative path (rejects when it does not exist). */
  read(path: string): Promise<Uint8Array>;
  /** A URL the renderer can load the file from (textures, meshes). */
  url(path: string): string;
  /** Every file in the package with its size, when the source can list them (validation, budgets). */
  list?(): Promise<{ path: string; size: number }[]>;
}

export interface LoadOptions {
  /** Repository rules: ATTRIBUTION.md + licence text required, meta.id must equal this folder name. */
  strict?: boolean;
  folderId?: string;
  /** Also open every texture / preview to check its format and size (validator, local loading). */
  checkAssets?: boolean;
}

export interface MapStats { primitives: number; gates: number; trees: number; brushes: number; meshTriangles: number; collisionTriangles: number; bytes?: number }

export interface LoadedMap {
  doc: MapDocV1;
  warnings: string[];
  stats: MapStats;
  /** Build a fresh MapDef (synchronous; same result every call). */
  build(id?: string): MapDef;
  /** The decoded assets build() uses: with buildMapDef, rebuild an edited document without re-reading the package. */
  assets: MapAssets;
}

/** What a package's assets decode to: everything buildMapDef needs besides the document. */
export interface MapAssets {
  /** Decoded heightfield (0..1 per pixel, rows north to south), for ground type "heightfield". */
  hf?: { w: number; h: number; data: Float32Array };
  /** Quake / Doom base level. */
  baseDef: ((id: string) => MapDef) | null;
  /** glTF meshes: what to draw and their collision. */
  meshes: { inst: MeshInstance; brushes: BrushPrim[]; box?: BoxPrim }[];
}

const text = (b: Uint8Array) => new TextDecoder().decode(b);
const hex = (s: string | undefined) => (s === undefined ? undefined : parseInt(s.slice(1), 16));
const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '');
const deg = Math.PI / 180;

/** Read, validate and decode a map package. Throws MapFormatError listing every problem. */
export async function loadMapPackage(src: PackageSource, opts: LoadOptions = {}): Promise<LoadedMap> {
  const errors: string[] = [], warnings: string[] = [];
  const files = src.list ? await src.list() : null;
  const has = (p: string) => !files || files.some((f) => f.path === p);
  const tryRead = async (p: string, what: string): Promise<Uint8Array | null> => {
    if (!has(p)) { errors.push(`${what}: file "${p}" is not in the package`); return null; }
    try { return await src.read(p); } catch (e) { errors.push(`${what}: cannot read "${p}" (${(e as Error).message ?? e})`); return null; }
  };

  // ---- files and budgets ----
  if (files) {
    let total = 0;
    for (const f of files) {
      total += f.size;
      const e = assetPathError(f.path);
      if (e) errors.push(`file "${f.path}": name ${e}`);
      else if (FORBIDDEN_EXT.test(f.path)) errors.push(`file "${f.path}": this file type is not allowed in map packages (no game archives, executables or scripts)`);
      else if (!ASSET_EXT.test(f.path)) errors.push(`file "${f.path}": unsupported file type (allowed: .json .png .jpg .webp .glb .map .md .txt)`);
      if (f.size > BUDGETS.fileBytes) errors.push(`file "${f.path}": ${(f.size / 1048576).toFixed(1)} MiB exceeds the per-file budget of ${BUDGETS.fileBytes / 1048576} MiB`);
    }
    if (total > BUDGETS.packageBytes) errors.push(`package is ${(total / 1048576).toFixed(1)} MiB; the budget is ${BUDGETS.packageBytes / 1048576} MiB`);
    const mj = files.find((f) => f.path === 'map.json');
    if (mj && mj.size > BUDGETS.mapJsonBytes) errors.push(`map.json is ${(mj.size / 1024).toFixed(0)} KiB; the budget is ${BUDGETS.mapJsonBytes / 1024} KiB`);
  }

  const mapBytes = await tryRead('map.json', 'package');
  if (!mapBytes) throw new MapFormatError(errors);
  let raw: unknown;
  try { raw = JSON.parse(text(mapBytes)); } catch (e) { throw new MapFormatError([...errors, `map.json: not valid JSON (${(e as Error).message})`]); }
  let doc: MapDocV1;
  try { ({ doc } = validateMapDoc(raw)); } catch (e) { if (e instanceof MapFormatError) throw new MapFormatError([...errors, ...e.errors], e.warnings); throw e; }

  // ---- licence files ----
  if (opts.folderId !== undefined && doc.meta.id !== opts.folderId) errors.push(`map.json.meta.id: "${doc.meta.id}" must equal the package folder name "${opts.folderId}"`);
  if (files) {
    const names = files.map((f) => f.path);
    const need = opts.strict ? errors : warnings;
    if (!names.includes('ATTRIBUTION.md')) need.push('ATTRIBUTION.md is missing: state who made the map and every asset in it, their sources and licences');
    if (NEEDS_TEXT.test(doc.meta.license.replace(/[()]/g, '')) && !names.some((n) => /^(LICENSE|COPYING)(\.txt|\.md)?$/i.test(n)))
      need.push(`${doc.meta.license} requires its full licence text: add LICENSE.txt to the package`);
  }

  // ---- referenced assets ----
  const referenced = new Set(['map.json']);
  const images: [string, string, number, number][] = []; // path, what, max px, max bytes
  if (doc.meta.preview) { referenced.add(doc.meta.preview); images.push([doc.meta.preview, 'map.json.meta.preview', 4096, BUDGETS.previewBytes]); }
  if (doc.ground?.texture) { referenced.add(doc.ground.texture); images.push([doc.ground.texture, 'map.json.ground.texture', BUDGETS.texturePx, BUDGETS.textureBytes]); }
  (doc.primitives ?? []).forEach((p, i) => { if (p.type === 'box' && p.texture && !referenced.has(p.texture)) { referenced.add(p.texture); images.push([p.texture, `map.json.primitives[${i}].texture`, BUDGETS.texturePx, BUDGETS.textureBytes]); } });

  let hf: { w: number; h: number; data: Float32Array } | undefined;
  if (doc.ground?.type === 'heightfield') {
    const g = doc.ground;
    referenced.add(g.image);
    const b = await tryRead(g.image, 'map.json.ground.image');
    if (b) {
      const sz = imageSize(b);
      if (!sz || sz.type !== 'png') errors.push(`map.json.ground.image: "${g.image}" is not a PNG file`);
      else if (sz.w > BUDGETS.heightfieldPx || sz.h > BUDGETS.heightfieldPx || sz.w < 2 || sz.h < 2) errors.push(`map.json.ground.image: ${sz.w}x${sz.h} px; heightfields must be 2..${BUDGETS.heightfieldPx} px per side`);
      else try { hf = await decodePngChannel(b); } catch (e) { errors.push(`map.json.ground.image: ${(e as Error).message}`); }
    }
  }

  let baseDef: ((id: string) => MapDef) | null = null;
  const meshes: MapAssets['meshes'] = [];
  let meshTriangles = 0, collisionTriangles = 0;
  for (const [gi, g] of (doc.geometry ?? []).entries()) {
    const P = `map.json.geometry[${gi}]`;
    referenced.add(g.src);
    const b = await tryRead(g.src, `${P}.src`);
    if (!b) continue;
    if (g.type === 'quake') {
      const srcText = text(b);
      let tex: Record<string, { file: string; w: number; h: number }> | undefined, texDir = '';
      if (g.textures && g.textures !== 'builtin:librequake') {
        referenced.add(g.textures); texDir = dirOf(g.textures);
        const t = await tryRead(g.textures, `${P}.textures`);
        if (t) try { tex = JSON.parse(text(t)); for (const v of Object.values(tex!)) referenced.add(texDir + v.file); } catch (e) { errors.push(`${P}.textures: not valid JSON (${(e as Error).message})`); }
      }
      baseDef = (id) => {
        const m = quakeMapDef(srcText, { id, name: doc.meta.name, scale: g.scale, ambient: g.ambient ?? 40, spawnClass: g.spawnClass });
        if (tex) { m.quake!.textures = tex; m.quake!.textureUrl = (f) => src.url(texDir + f); }
        return m;
      };
    } else if (g.type === 'doom') {
      const srcText = text(b);
      referenced.add(g.textures);
      const texDir = dirOf(g.textures);
      const t = await tryRead(g.textures, `${P}.textures`);
      if (t) try {
        const tex = JSON.parse(text(t)) as Record<string, { file: string; w: number; h: number }>;
        for (const v of Object.values(tex)) referenced.add(texDir + v.file);
        baseDef = (id) => {
          const m = doomMapDef(srcText, { id, name: doc.meta.name, scale: g.scale, textures: tex, textureBase: '' });
          m.quake!.textureUrl = (f) => src.url(texDir + f);
          return m;
        };
      } catch (e) { errors.push(`${P}.textures: not valid JSON (${(e as Error).message})`); }
    } else {
      let tri: ReturnType<typeof glbTriangles>;
      try { tri = glbTriangles(b); } catch (e) { errors.push(`${P}.src: ${(e as Error).message}`); continue; }
      meshTriangles += tri.triangles;
      if (opts.checkAssets) tri.images.forEach((im, k) => {
        const sz = imageSize(im), what = `${P}.src: "${g.src}" image ${k}`;
        if (!sz) errors.push(`${what} is not PNG, JPEG or WebP (KTX2 / Basis are not supported)`);
        else if (sz.w > BUDGETS.texturePx || sz.h > BUDGETS.texturePx) errors.push(`${what} is ${sz.w}x${sz.h} px; the budget is ${BUDGETS.texturePx}x${BUDGETS.texturePx}`);
        if (im.length > BUDGETS.textureBytes) errors.push(`${what} is ${(im.length / 1024).toFixed(0)} KiB; the budget is ${BUDGETS.textureBytes / 1024} KiB`);
      });
      const s = g.scale ?? 1, yaw = (g.yawDeg ?? 0) * deg, [px, py, pz] = g.pos ?? [0, 0, 0], co = Math.cos(yaw), si = Math.sin(yaw);
      const P3 = tri.positions, place = (i: number) => { const x = P3[i] * s, y = P3[i + 1] * s; return [px + co * x - si * y, py + si * x + co * y, pz + P3[i + 2] * s]; };
      const entry: (typeof meshes)[number] = { inst: { url: src.url(g.src), pos: { x: px, y: py, z: pz }, yaw, scale: s }, brushes: [] };
      const mat = g.material ?? 'concrete', coll = g.collision ?? 'mesh';
      if (coll === 'mesh') {
        collisionTriangles += tri.triangles;
        for (let i = 0; i + 8 < P3.length; i += 9) { const br = triangleBrush(place(i), place(i + 3), place(i + 6), mat, `mesh${gi}`); if (br) entry.brushes.push(br); }
      } else if (coll === 'box' && P3.length) {
        let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < P3.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], P3[i + k] * s); hi[k] = Math.max(hi[k], P3[i + k] * s); }
        const cx = (lo[0] + hi[0]) / 2, cy = (lo[1] + hi[1]) / 2;
        entry.box = { kind: 'box', c: { x: px + co * cx - si * cy, y: py + si * cx + co * cy, z: pz + (lo[2] + hi[2]) / 2 }, half: { x: (hi[0] - lo[0]) / 2, y: (hi[1] - lo[1]) / 2, z: (hi[2] - lo[2]) / 2 }, yaw, mat, tag: `mesh${gi}` };
      }
      meshes.push(entry);
    }
  }
  if (meshTriangles > BUDGETS.meshTriangles) errors.push(`glTF meshes have ${meshTriangles} triangles; the budget is ${BUDGETS.meshTriangles}`);
  if (collisionTriangles > BUDGETS.collisionTriangles) errors.push(`glTF meshes with collision "mesh" have ${collisionTriangles} triangles; the budget is ${BUDGETS.collisionTriangles} (use collision "box" or "none", or a simpler collision mesh)`);

  if (opts.checkAssets) for (const [p, what, px, bytes] of images) {
    const b = await tryRead(p, what);
    if (!b) continue;
    const sz = imageSize(b);
    if (!sz) errors.push(`${what}: "${p}" is not a PNG, JPEG or WebP image`);
    else if (sz.w > px || sz.h > px) errors.push(`${what}: "${p}" is ${sz.w}x${sz.h} px; the budget is ${px}x${px}`);
    if (b.length > bytes) errors.push(`${what}: "${p}" is ${(b.length / 1024).toFixed(0)} KiB; the budget is ${bytes / 1024} KiB`);
  } else for (const [p, what] of images) if (!has(p)) errors.push(`${what}: file "${p}" is not in the package`);

  for (const [i, p] of (doc.scenarios ?? []).entries()) {
    referenced.add(p);
    const b = await tryRead(p, `map.json.scenarios[${i}]`);
    if (b) try { const j = JSON.parse(text(b)); if (j?.format !== 'fpvsim-scenario') errors.push(`map.json.scenarios[${i}]: "${p}" is not an fpvsim-scenario file`); } catch (e) { errors.push(`map.json.scenarios[${i}]: "${p}" is not valid JSON (${(e as Error).message})`); }
  }

  if (files) for (const f of files) if (!referenced.has(f.path) && !DOC_FILE.test(f.path)) warnings.push(`file "${f.path}" is not referenced by map.json (remove it, or it ships for nothing)`);

  // ---- build once now: catches errors in external sources and counts the result against the budgets ----
  const assets: MapAssets = { hf, baseDef, meshes };
  const build = (id = doc.meta.id): MapDef => buildMapDef(doc, assets, src.url, id);

  let stats: MapStats = { primitives: 0, gates: 0, trees: 0, brushes: 0, meshTriangles, collisionTriangles, bytes: files?.reduce((s, f) => s + f.size, 0) };
  if (!errors.length) {
    try {
      const m = build();
      const brushes = m.prims.filter((p) => p.kind === 'brush').length;
      stats = { ...stats, primitives: m.prims.length - brushes, gates: m.gates.length, trees: m.trees.length, brushes };
      if (stats.primitives > BUDGETS.primitives) errors.push(`map has ${stats.primitives} primitives including generated gate parts; the budget is ${BUDGETS.primitives}`);
      if (brushes > BUDGETS.brushes) errors.push(`map has ${brushes} convex brushes (Quake / Doom geometry and mesh collision); the budget is ${BUDGETS.brushes}`);
      const sp = m.spawn.pos;
      if (Math.abs(sp.x) > m.size || Math.abs(sp.y) > m.size) warnings.push(`spawn (${sp.x}, ${sp.y}) is outside the playable area (size ${m.size} m)`);
    } catch (e) { errors.push(`map does not build: ${(e as Error).message ?? e}`); }
  }
  if (errors.length) throw new MapFormatError(errors, warnings);
  return { doc, warnings, stats, build, assets };
}

const v3 = (p: readonly number[]): V3 => ({ x: p[0], y: p[1], z: p[2] });

/** An actor's runtime description: defaults filled in, angles in radians. */
function actorDef(a: ActorDoc, pos: V3): ActorDef {
  const base = { id: a.id, name: a.name ?? a.id, pos, ...(a.path !== undefined && { path: a.path }) };
  switch (a.type) {
    case 'rf-emitter': return { ...base, type: a.type, freqMHz: a.freqMHz, eirpDbm: a.eirpDbm, bwMHz: a.bwMHz ?? 20, duty: a.duty ?? 1, ...(a.antenna && { antenna: { yaw: a.antenna.yawDeg * deg, pitch: (a.antenna.pitchDeg ?? 0) * deg, beam: a.antenna.beamDeg * deg } }) };
    case 'ground-station': return { ...base, type: a.type, link: a.link ?? 'both', ...(a.txPowerMw !== undefined && { txPowerMw: a.txPowerMw }), gainDbi: a.gainDbi ?? 2 };
    case 'detector': {
      const fov = a.fovDeg ?? (a.sensor === 'camera' ? [60, 40] : a.sensor === 'radar' ? [90, 30] : [360, 180]);
      const [m, n] = a.confirm ?? [2, 3];
      const r50 = a.r50M ?? (a.sensor === 'camera' ? 0.4 * a.rangeM : 0.7 * a.rangeM);
      return { ...base, type: a.type, sensor: a.sensor, yaw: (a.yawDeg ?? 0) * deg, pitch: (a.pitchDeg ?? 0) * deg, fovH: fov[0] * deg, fovV: fov[1] * deg, rangeM: a.rangeM, r50M: r50, sensitivityDbm: a.sensitivityDbm ?? -90, rateHz: a.rateHz ?? 10, confirmM: m, confirmN: n };
    }
    case 'target': {
      const shape = a.shape ?? 'box', r = a.radiusM ?? 1;
      const size = a.size ? v3(a.size) : shape === 'person' ? { x: 0.5, y: 0.3, z: 1.8 } : shape === 'vehicle' ? { x: 4.5, y: 1.9, z: 1.5 } : shape === 'quad' ? { x: 0.3, y: 0.3, z: 0.1 } : { x: 2 * r, y: 2 * r, z: 2 * r };
      return { ...base, type: a.type, shape, size, radius: r, solid: !!a.solid, ...(a.color !== undefined && { color: hex(a.color) }) };
    }
  }
}

/**
 * Build the MapDef of a validated document from its decoded assets (synchronous, deterministic).
 * loadMapPackage's build() is this; the map editor calls it directly on every edit. url resolves a
 * package path to a URL the renderer can load (textures).
 */
export function buildMapDef(doc: MapDocV1, assets: MapAssets, url: (path: string) => string, id = doc.meta.id): MapDef {
  const { hf, baseDef, meshes } = assets;
  const base = baseDef?.(id) ?? null;
  const terrain = doc.ground ? makeTerrain(doc.ground, hf) : base ? base.terrain : makeTerrain(undefined);
  const prims: Prim[] = base ? [...base.prims] : [];
  let gateId = 0;
  const gateDef = (g: GateDoc): GateDef => {
    const [w, h] = GATE_SIZE[g.kind];
    return { id: gateId++, kind: g.kind, c: { x: g.pos[0], y: g.pos[1], z: g.pos[2] ?? terrain(g.pos[0], g.pos[1]) }, yaw: (g.yawDeg ?? 0) * deg, width: g.width ?? w, height: g.height ?? h, ...(g.stack != null ? { stack: g.stack } : {}), ...(g.onTop ? { onTop: true } : {}) };
  };
  const gates: GateDef[] = (doc.gates ?? []).map(gateDef);
  buildGatePrims(gates, prims, terrain);
  // course gates: ids continue after the default course's, so every gate of the map has its own id
  const spawnDef = (s: SpawnDoc): SpawnDef => ({ id: s.id, name: s.name ?? s.id, pos: v3(s.pos), yaw: (s.yawDeg ?? 0) * deg, ...(s.groundZ !== undefined && { groundZ: s.groundZ }), ...(s.pilot && { pilot: v3(s.pilot) }) });
  const spawns = (doc.spawns ?? []).map(spawnDef);
  const courses: CourseDef[] = (doc.courses ?? []).map((c) => {
    const cg = c.gates.map(gateDef);
    buildGatePrims(cg, prims, terrain);
    const sp = c.spawn ? spawns.find((s) => s.id === c.spawn) : undefined;
    return { id: c.id, name: c.name, gates: cg, ...(sp && { spawn: { pos: { ...sp.pos }, yaw: sp.yaw, ...(sp.groundZ !== undefined && { groundZ: sp.groundZ }) } }) };
  });
  const paths = new Map((doc.paths ?? []).map((p) => [p.id, p]));
  const actors = (doc.actors ?? []).map((a) => actorDef(a, a.pos ? v3(a.pos) : v3(paths.get(a.path!)!.points[0])));
  for (const a of actors) if (a.type === 'target' && a.solid) {
    const c = a.pos, tag = `target-${a.id}`, mat: Material = 'metal';
    if (a.shape === 'sphere') prims.push({ kind: 'sphere', c: { ...c }, r: a.radius, mat, tag, ...(a.color !== undefined && { color: a.color }) });
    else if (a.shape === 'cylinder') prims.push({ kind: 'cyl', c: { ...c }, r: a.radius, h: a.size.z, mat, tag, ...(a.color !== undefined && { color: a.color }) });
    else prims.push({ kind: 'box', c: { x: c.x, y: c.y, z: c.z + a.size.z / 2 }, half: { x: a.size.x / 2, y: a.size.y / 2, z: a.size.z / 2 }, yaw: 0, mat, tag, visual: 'plain', color: a.color ?? 0xe8433a });
  }
  for (const p of doc.primitives ?? []) {
    const c: V3 = { x: p.pos[0], y: p.pos[1], z: p.pos[2] }, mat: Material = p.material ?? 'concrete';
    const extra = { ...(p.color !== undefined && { color: hex(p.color) }), ...(p.tag !== undefined && { tag: p.tag }) };
    if (p.type === 'box') prims.push({ kind: 'box', c, half: { x: p.size[0] / 2, y: p.size[1] / 2, z: p.size[2] / 2 }, yaw: (p.yawDeg ?? 0) * deg, ...(p.pitchDeg && { pitch: p.pitchDeg * deg }), mat, visual: p.visual ?? (p.texture ? 'plain' : 'concrete'), ...extra, ...(p.texture && { texture: url(p.texture) }), ...(p.text && { text: p.text }) });
    else if (p.type === 'cylinder') prims.push({ kind: 'cyl', c, r: p.radius, h: p.height, mat: p.material ?? 'metal', ...extra });
    else prims.push({ kind: 'sphere', c, r: p.radius, mat, ...extra });
  }
  for (const m of meshes) { prims.push(...m.brushes); if (m.box) prims.push({ ...m.box, c: { ...m.box.c }, half: { ...m.box.half } }); }
  const env = doc.environment ?? {};
  const wakeZones: WakeZone[] = (doc.wakeZones ?? []).map((w) => ({ x: w.pos[0], y: w.pos[1], radius: w.radius, height: w.height, intensity: w.intensity }));
  const def: MapDef = {
    id, name: doc.meta.name, size: doc.size, terrain,
    groundMat: doc.ground?.material ?? base?.groundMat ?? 'grass', prims, gates,
    spawn: doc.spawn ? { pos: { x: doc.spawn.pos[0], y: doc.spawn.pos[1], z: doc.spawn.pos[2] }, yaw: (doc.spawn.yawDeg ?? 0) * deg, ...(doc.spawn.groundZ !== undefined && { groundZ: doc.spawn.groundZ }) } : base!.spawn,
    sun: env.sun ? { ...env.sun } : base?.sun ?? { azimuthDeg: 200, elevationDeg: 45 },
    sky: env.sky ?? base?.sky ?? 'clear',
    wakeZones: [...(base?.wakeZones ?? []), ...wakeZones],
    elevationM: doc.elevationM ?? base?.elevationM ?? 0,
    trees: (doc.trees ?? []).map((t) => ({ x: t.pos[0], y: t.pos[1], h: t.height, r: t.radius, type: t.type })),
  };
  const indoor: WindVolume[] = [...(base?.indoor ?? []), ...(doc.indoor ?? []).map((v) => ({ min: { x: v.min[0], y: v.min[1], z: v.min[2] }, max: { x: v.max[0], y: v.max[1], z: v.max[2] }, scale: v.windScale ?? 0.1 }))];
  if (indoor.length) def.indoor = indoor;
  const ground = doc.ground ? doc.ground.visible : base?.ground;
  if (ground !== undefined) def.ground = ground;
  const pilot = doc.pilot ? { x: doc.pilot[0], y: doc.pilot[1], z: doc.pilot[2] } : doc.spawn ? undefined : base?.pilot;
  if (pilot) def.pilot = pilot;
  const windScale = env.windScale ?? base?.windScale;
  if (windScale !== undefined) def.windScale = windScale;
  if (base?.quake) def.quake = base.quake;
  if (env.fog) def.fog = { color: hex(env.fog.color)!, density: env.fog.density };
  if (doc.lights?.length) def.lights = doc.lights.map((l) => ({ pos: { x: l.pos[0], y: l.pos[1], z: l.pos[2] }, color: hex(l.color) ?? 0xffffff, intensity: l.intensity, range: l.range }));
  if (doc.ground?.texture) def.groundTexture = url(doc.ground.texture);
  if (meshes.length) def.meshes = meshes.map((m) => ({ ...m.inst, pos: { ...m.inst.pos } }));
  if (courses.length) def.courses = courses;
  if (spawns.length) def.spawns = spawns;
  if (env.wind) def.wind = { speed: env.wind.speed, direction: env.wind.directionDeg, turbulence: env.wind.turbulence ?? 1, gusts: env.wind.gusts ?? 2 };
  if (paths.size) def.paths = [...paths.values()].map((p) => ({ id: p.id, points: p.points.map(v3), speed: p.speedMs, mode: p.mode ?? 'loop', delay: p.delayS ?? 0 }));
  if (actors.length) def.actors = actors;
  if (doc.scenarios?.length) def.scenarios = doc.scenarios.map((p) => ({ path: p, url: url(p) }));
  return def;
}

// ---------------------------------------------------------------------------------------------
// Registry adapters (used by maps.ts; no module-level state touched here, see the note at the top)

/** Source for a package served over HTTP under `baseUrl` (ends with "/"). */
export function httpSource(baseUrl: string): PackageSource {
  return {
    url: (p) => baseUrl + p,
    async read(p) {
      const r = await fetch(baseUrl + p);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return new Uint8Array(await r.arrayBuffer());
    },
  };
}

/** Source for a package held as a path -> URL table (blob: URLs of a package loaded from disk). */
export function urlTableSource(urls: Record<string, string>): PackageSource {
  return {
    url: (p) => urls[p] ?? '',
    async read(p) {
      if (!urls[p]) throw new Error('no such file');
      return new Uint8Array(await (await fetch(urls[p])).arrayBuffer());
    },
  };
}

/** A map-registry entry for a package. */
export function packageEntry(id: string, info: { name: string; author: string; license: string; local?: boolean; user?: boolean }, src: () => PackageSource): MapEntry {
  return {
    name: info.name,
    // user maps: published by players, not reviewed (see server/src/mapStore.ts)
    credit: info.user ? `User map by ${info.author} · not reviewed (${info.license})` : `${info.local ? 'Loaded from disk' : 'Community map'} by ${info.author} (${info.license})`,
    community: { author: info.author, license: info.license, local: !!info.local, ...(info.user ? { user: true } : {}) },
    build: () => { throw new Error(`map ${id} not loaded: await preloadMap('${id}') first`); },
    prepare: async () => { const m = await loadMapPackage(src()); return () => m.build(id); },
  };
}
