// Quake .map (brush format) loader: parses entities / brushes / planes, builds each convex brush
// polyhedron by intersecting its half-spaces, and turns the level into a MapDef: brushes become
// exact convex collision prims ('brush'), faces become render data with Quake texture axes.
// Quake is Z-up and right-handed like the sim's ENU frame, so only a scale + offset is applied.
import manifestJson from '../../public/maps/quake/textures/manifest.json';
import type { BrushPrim, MapDef, Material } from './world';

type Vec = [number, number, number];

export interface QPlaneDef { p: [Vec, Vec, Vec]; tex: string; ox: number; oy: number; rot: number; sx: number; sy: number }
export interface QEntity { props: Record<string, string>; brushes: QPlaneDef[][] }

/** One renderable brush face, already in ENU metres. s/t give texel coordinates: s = dot(P, s.xyz) + s[3]. */
export interface QuakeFace {
  verts: number[];            // x,y,z per vertex, convex polygon wound CCW seen from the front
  n: Vec;
  tex: string;                // id texture name (lower case); see TEXTURES for the replacement image
  s: [number, number, number, number];
  t: [number, number, number, number];
  kind: 'solid' | 'liquid' | 'light' | 'masked'; // masked: alpha-tested (Doom mid textures)
  light?: number;             // fixed light level 0..255 (Doom sector light) instead of baked light entities
}
export interface QuakeLight { pos: Vec; value: number; range: number; color: Vec }
export interface QuakeLevel {
  faces: QuakeFace[]; lights: QuakeLight[]; ambient: number; scale: number; textureBase: string;
  textures?: Record<string, { file: string; w: number; h: number }>; // texture manifest (default: TEXTURES)
}

/** id texture name -> vendored LibreQuake replacement (file + pixel size), written by scripts/vendor-quake.mjs. */
export const TEXTURES: Record<string, { file: string; w: number; h: number }> = manifestJson;

// ---------------------------------------------------------------------------------------------
// Parsing

export function parseQuakeMap(text: string): QEntity[] {
  const ents: QEntity[] = [];
  const n = text.length;
  let i = 0;
  const ws = () => {
    for (;;) {
      while (i < n && text.charCodeAt(i) <= 32) i++;
      if (text.charCodeAt(i) === 47 && text.charCodeAt(i + 1) === 47) { while (i < n && text[i] !== '\n') i++; } else return;
    }
  };
  const fail = (what: string): never => { throw new Error(`quake map: expected ${what} at offset ${i}`); };
  const expect = (c: string) => { ws(); if (text[i] !== c) fail(`'${c}'`); i++; };
  const quoted = () => { ws(); if (text[i] !== '"') fail('"'); const j = text.indexOf('"', i + 1); const s = text.slice(i + 1, j); i = j + 1; return s; };
  const word = () => { ws(); const s = i; while (i < n && text.charCodeAt(i) > 32 && text[i] !== '(' && text[i] !== ')') i++; if (s === i) fail('token'); return text.slice(s, i); };
  const num = () => { const w = word(); const v = Number(w); if (!Number.isFinite(v)) fail(`number, got ${w}`); return v; };
  const point = (): Vec => { expect('('); const p: Vec = [num(), num(), num()]; expect(')'); return p; };
  for (;;) {
    ws();
    if (i >= n) break;
    expect('{');
    const ent: QEntity = { props: {}, brushes: [] };
    for (;;) {
      ws();
      const c = text[i];
      if (c === '"') { const k = quoted(); ent.props[k] = quoted(); }
      else if (c === '{') {
        i++;
        const brush: QPlaneDef[] = [];
        for (;;) {
          ws();
          if (text[i] === '}') { i++; break; }
          const p: [Vec, Vec, Vec] = [point(), point(), point()];
          brush.push({ p, tex: word().toLowerCase(), ox: num(), oy: num(), rot: num(), sx: num(), sy: num() });
        }
        ent.brushes.push(brush);
      } else if (c === '}') { i++; break; }
      else fail('entity key, brush or }');
    }
    ents.push(ent);
  }
  return ents;
}

// ---------------------------------------------------------------------------------------------
// Brush geometry (Quake units)

const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec, b: Vec): Vec => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

export interface Plane { n: Vec; d: number }

/** qbsp's PlaneFromPoints: outward normal for the .map point order. */
export function planeFromPoints(a: Vec, b: Vec, c: Vec): Plane | null {
  const n = cross(sub(a, b), sub(c, b));
  const l = Math.hypot(n[0], n[1], n[2]);
  if (l < 1e-9) return null;
  n[0] /= l; n[1] /= l; n[2] /= l;
  for (let k = 0; k < 3; k++) if (Math.abs(Math.abs(n[k]) - 1) < 1e-9) { const sg = Math.sign(n[k]); n[0] = n[1] = n[2] = 0; n[k] = sg; }
  return { n, d: dot(a, n) };
}

function baseWinding(pl: Plane, big = 1 << 17): Vec[] {
  let ax = 0;
  for (let k = 1; k < 3; k++) if (Math.abs(pl.n[k]) > Math.abs(pl.n[ax])) ax = k;
  const up: Vec = ax === 2 ? [1, 0, 0] : [0, 0, 1];
  const v = dot(up, pl.n);
  for (let k = 0; k < 3; k++) up[k] -= v * pl.n[k];
  const ul = Math.hypot(up[0], up[1], up[2]);
  for (let k = 0; k < 3; k++) up[k] *= big / ul;
  const right = cross(up, pl.n);
  const o: Vec = [pl.n[0] * pl.d, pl.n[1] * pl.d, pl.n[2] * pl.d];
  return [
    [o[0] - right[0] + up[0], o[1] - right[1] + up[1], o[2] - right[2] + up[2]],
    [o[0] + right[0] + up[0], o[1] + right[1] + up[1], o[2] + right[2] + up[2]],
    [o[0] + right[0] - up[0], o[1] + right[1] - up[1], o[2] + right[2] - up[2]],
    [o[0] - right[0] - up[0], o[1] - right[1] - up[1], o[2] - right[2] - up[2]],
  ];
}

/** Keep the part of a convex polygon behind the plane (dot(p, n) <= d). */
function clipBack(w: Vec[], pl: Plane, eps = 0.01): Vec[] {
  const dists = w.map((p) => dot(p, pl.n) - pl.d);
  const sides = dists.map((d) => (d > eps ? 1 : d < -eps ? -1 : 0));
  if (!sides.includes(1)) return w;
  if (!sides.includes(-1)) return [];
  const out: Vec[] = [];
  for (let i = 0; i < w.length; i++) {
    const j = (i + 1) % w.length;
    if (sides[i] <= 0) out.push(w[i]);
    if (sides[i] === 0 || sides[j] === 0 || sides[j] === sides[i]) continue;
    const t = dists[i] / (dists[i] - dists[j]);
    const m: Vec = [0, 0, 0];
    for (let k = 0; k < 3; k++) m[k] = pl.n[k] === 1 ? pl.d : pl.n[k] === -1 ? -pl.d : w[i][k] + t * (w[j][k] - w[i][k]);
    out.push(m);
  }
  return out;
}

export interface BrushPoly { planes: Plane[]; faces: { def: QPlaneDef; plane: Plane; w: Vec[] }[] }

/** Intersect a brush's half-spaces: one polygon per non-degenerate face. */
export function buildBrush(defs: QPlaneDef[]): BrushPoly | null {
  const planes: Plane[] = [], used: QPlaneDef[] = [];
  for (const def of defs) {
    const pl = planeFromPoints(...def.p);
    if (!pl || planes.some((q) => dot(q.n, pl.n) > 0.99999 && Math.abs(q.d - pl.d) < 0.01)) continue;
    planes.push(pl); used.push(def);
  }
  const faces: BrushPoly['faces'] = [];
  for (let i = 0; i < planes.length; i++) {
    let w = baseWinding(planes[i]);
    for (let j = 0; j < planes.length && w.length >= 3; j++) if (j !== i) w = clipBack(w, planes[j]);
    if (w.length >= 3) faces.push({ def: used[i], plane: planes[i], w });
  }
  // open (unbounded) brushes keep base-winding corners: reject them like qbsp does
  if (faces.length < 4 || faces.some((f) => f.w.some((p) => Math.abs(p[0]) > 16384 || Math.abs(p[1]) > 16384 || Math.abs(p[2]) > 16384))) return null;
  return { planes: faces.map((f) => f.plane), faces };
}

// qbsp TextureAxisFromPlane
const BASE_AXIS: Vec[] = [
  [0, 0, 1], [1, 0, 0], [0, -1, 0], [0, 0, -1], [1, 0, 0], [0, -1, 0],
  [1, 0, 0], [0, 1, 0], [0, 0, -1], [-1, 0, 0], [0, 1, 0], [0, 0, -1],
  [0, 1, 0], [1, 0, 0], [0, 0, -1], [0, -1, 0], [1, 0, 0], [0, 0, -1],
];
/** Quake texture vectors for a face: texel s = dot(P, s.xyz) + s[3] (P in Quake units). */
export function textureVecs(n: Vec, def: QPlaneDef): { s: [number, number, number, number]; t: [number, number, number, number] } {
  let best = 0, bi = 0;
  for (let i = 0; i < 6; i++) { const d = dot(n, BASE_AXIS[i * 3]); if (d > best) { best = d; bi = i; } }
  const xv = [...BASE_AXIS[bi * 3 + 1]] as Vec, yv = [...BASE_AXIS[bi * 3 + 2]] as Vec;
  let sinv: number, cosv: number;
  if (def.rot === 0) { sinv = 0; cosv = 1; } else if (def.rot === 90) { sinv = 1; cosv = 0; }
  else if (def.rot === 180) { sinv = 0; cosv = -1; } else if (def.rot === 270) { sinv = -1; cosv = 0; }
  else { const a = (def.rot * Math.PI) / 180; sinv = Math.sin(a); cosv = Math.cos(a); }
  const sv = xv[0] ? 0 : xv[1] ? 1 : 2, tv = yv[0] ? 0 : yv[1] ? 1 : 2;
  for (const v of [xv, yv]) { const ns = cosv * v[sv] - sinv * v[tv], nt = sinv * v[sv] + cosv * v[tv]; v[sv] = ns; v[tv] = nt; }
  const sx = def.sx || 1, sy = def.sy || 1;
  return { s: [xv[0] / sx, xv[1] / sx, xv[2] / sx, def.ox], t: [yv[0] / sy, yv[1] / sy, yv[2] / sy, def.oy] };
}

// ---------------------------------------------------------------------------------------------
// Level -> MapDef

const NO_DRAW = /^(clip|trigger|skip|hint|sky.*|origin|null)$/;
const isLiquid = (t: string) => t.startsWith('*');
const isLightTex = (t: string) => /^(tlight|light|sliplite|z_exit|\+\dplanet|\+\dbasebtn)/.test(t) || (TEXTURES[t]?.file.includes('_fbr') ?? false);
// brush entities that are removed (doors stay open) or have no collision
const REMOVED = /^(func_door|func_door_secret|trigger_.*)$/;
const NON_SOLID = /^(func_illusionary)$/;

function materialFor(tex: string[]): Material {
  const t = tex.find((x) => !NO_DRAW.test(x)) ?? '';
  if (/^(ground|uwall|rock|city|brick|wall|stone)/.test(t)) return 'concrete';
  if (/^(crate|wood|wizwood|plank)/.test(t)) return 'wood';
  return 'metal';
}

export interface QuakeMapOptions {
  id: string; name: string;
  scale?: number;               // metres per Quake unit (player hull 56 u ≈ 1.75 m at 1/32)
  spawnClass?: string;          // entity to spawn at (default info_player_start)
  ambient?: number;             // minimum light level, Quake 0..255 scale
  textureBase?: string;
}

const vec = (s: string | undefined): Vec | null => {
  if (!s) return null;
  const v = s.trim().split(/\s+/).map(Number);
  return v.length === 3 && v.every(Number.isFinite) ? (v as Vec) : null;
};

export function quakeMapDef(text: string, o: QuakeMapOptions): MapDef {
  const S = o.scale ?? 1 / 32;
  const ents = parseQuakeMap(text);
  const world = ents.find((e) => e.props.classname === 'worldspawn');
  if (!world) throw new Error('quake map: no worldspawn');

  // build all brush polyhedra first (Quake units) to find the level bounds
  const built: { ent: QEntity; poly: BrushPoly }[] = [];
  const lo: Vec = [Infinity, Infinity, Infinity], hi: Vec = [-Infinity, -Infinity, -Infinity];
  for (const ent of ents) {
    const cls = ent.props.classname ?? '';
    if (REMOVED.test(cls)) continue;
    for (const b of ent.brushes) {
      const poly = buildBrush(b);
      if (!poly) continue;
      built.push({ ent, poly });
      if (ent === world) for (const f of poly.faces) for (const p of f.w) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); }
    }
  }
  // Quake units -> ENU metres: centre x/y on the origin, lowest world brush at z = 0
  const off: Vec = [-(lo[0] + hi[0]) / 2, -(lo[1] + hi[1]) / 2, -lo[2]];
  const toM = (p: Vec): Vec => [(p[0] + off[0]) * S, (p[1] + off[1]) * S, (p[2] + off[2]) * S];

  const prims: BrushPrim[] = [];
  const faces: QuakeFace[] = [];
  for (const { ent, poly } of built) {
    const cls = ent.props.classname ?? '';
    const texs = poly.faces.map((f) => f.def.tex);
    const liquid = texs.some(isLiquid);
    if (!liquid && !NON_SOLID.test(cls)) {
      const planes = new Float64Array(poly.planes.length * 4);
      poly.planes.forEach((pl, i) => { planes.set([pl.n[0], pl.n[1], pl.n[2], (pl.d + dot(pl.n, off)) * S], i * 4); });
      const min: Vec = [Infinity, Infinity, Infinity], max: Vec = [-Infinity, -Infinity, -Infinity];
      const edges: number[] = [], seen = new Set<string>();
      for (const f of poly.faces) {
        const wm = f.w.map(toM);
        for (let i = 0; i < wm.length; i++) {
          const a = wm[i], b = wm[(i + 1) % wm.length];
          for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], a[k]); max[k] = Math.max(max[k], a[k]); }
          const ka = a.map((x) => x.toFixed(3)).join(), kb = b.map((x) => x.toFixed(3)).join();
          const key = ka < kb ? ka + '|' + kb : kb + '|' + ka;
          if (seen.has(key)) continue;
          seen.add(key); edges.push(...a, ...b);
        }
      }
      prims.push({
        kind: 'brush', c: { x: (min[0] + max[0]) / 2, y: (min[1] + max[1]) / 2, z: (min[2] + max[2]) / 2 },
        planes, edges: new Float64Array(edges), min: { x: min[0], y: min[1], z: min[2] }, max: { x: max[0], y: max[1], z: max[2] },
        mat: materialFor(texs), tag: cls === 'worldspawn' ? undefined : cls,
      });
    }
    for (const f of poly.faces) {
      const tex = f.def.tex;
      if (NO_DRAW.test(tex)) continue;
      const tv = textureVecs(f.plane.n, f.def);
      // fold the offset + scale into the texture vectors so they take ENU metres
      const fold = (v: [number, number, number, number]): [number, number, number, number] => [v[0] / S, v[1] / S, v[2] / S, v[3] - (v[0] * off[0] + v[1] * off[1] + v[2] * off[2])];
      // wind CCW seen from the front (Newell normal vs plane normal)
      let nn = 0;
      for (let i = 0; i < f.w.length; i++) { const a = f.w[i], b = f.w[(i + 1) % f.w.length]; nn += dot(f.plane.n, [(a[1] - b[1]) * (a[2] + b[2]), (a[2] - b[2]) * (a[0] + b[0]), (a[0] - b[0]) * (a[1] + b[1])]); }
      const w = nn >= 0 ? f.w : [...f.w].reverse();
      const verts: number[] = [];
      for (const p of w) verts.push(...toM(p));
      faces.push({ verts, n: f.plane.n, tex, s: fold(tv.s), t: fold(tv.t), kind: isLiquid(tex) ? 'liquid' : isLightTex(tex) ? 'light' : 'solid' });
    }
  }

  // lights
  const lights: QuakeLight[] = [];
  for (const e of ents) {
    const cls = e.props.classname ?? '';
    if (!cls.startsWith('light')) continue;
    const org = vec(e.props.origin);
    if (!org) continue;
    const value = Number(e.props.light ?? (/torch|flame/.test(cls) ? 200 : 300)) || 300;
    const wait = Number(e.props.wait ?? 1) || 1;
    const col = vec(e.props._color) ?? [1, 1, 1];
    const cm = Math.max(...col) || 1;
    lights.push({ pos: toM(org), value, range: (value / wait) * S, color: [col[0] / cm, col[1] / cm, col[2] / cm] });
  }

  // spawn: player origin is the hull centre (24 u above the floor); find the floor exactly
  const spawnEnt = ents.find((e) => e.props.classname === (o.spawnClass ?? 'info_player_start')) ?? ents.find((e) => e.props.classname === 'info_player_deathmatch');
  const sOrg = vec(spawnEnt?.props.origin) ?? [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, lo[2] + 64];
  const sp = toM(sOrg);
  let groundZ = sp[2] - 24 * S;
  for (const b of prims) {
    if (sp[0] < b.min.x || sp[0] > b.max.x || sp[1] < b.min.y || sp[1] > b.max.y || b.max.z > sp[2]) continue;
    let inside = true;
    for (let i = 0; i < b.planes.length && inside; i += 4) {
      const nz = b.planes[i + 2];
      if (Math.abs(nz) < 1e-6) inside = b.planes[i] * sp[0] + b.planes[i + 1] * sp[1] - b.planes[i + 3] <= 1e-6;
    }
    if (inside) groundZ = Math.max(groundZ, b.max.z);
  }
  const yaw = ((Number(spawnEnt?.props.angle ?? 0) || 0) * Math.PI) / 180;

  const size = Math.max(hi[0] - lo[0], hi[1] - lo[1]) * S / 2;
  return {
    id: o.id, name: o.name, size, terrain: () => -2, ground: false, groundMat: 'concrete', prims, gates: [],
    spawn: { pos: { x: sp[0], y: sp[1], z: groundZ }, yaw, groundZ },
    pilot: { x: sp[0], y: sp[1], z: groundZ + 1.6 },
    sun: { azimuthDeg: 200, elevationDeg: 55 }, sky: 'overcast', wakeZones: [], elevationM: 0, trees: [], windScale: 0.1,
    quake: { faces, lights, ambient: o.ambient ?? Number(world.props.light ?? 0) ?? 0, scale: S, textureBase: o.textureBase ?? 'maps/quake/textures/' },
  };
}
