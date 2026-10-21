// Doom-format level loader (Freedoom; see public/maps/freedoom/ATTRIBUTION.md): parses the binary
// THINGS / LINEDEFS / SIDEDEFS / VERTEXES / SECTORS lumps, traces each sector's boundary loops (with
// holes) from its linedefs, triangulates them, and extrudes floors, ceilings and upper / lower / middle
// wall segments from the sector heights. Collision is convex 'brush' prims (a prism per floor / ceiling
// triangle, a box per one-sided wall), so PrimitiveWorld's contacts, rays and video obstruction work
// unchanged. Render data reuses the Quake level format (textured convex faces, here with per-sector
// light instead of light entities).
import { ShapeUtils, Vector2 } from 'three';
import type { QuakeFace, QuakeLevel } from './quakeMap';
import type { BrushPrim, MapDef, Material } from './world';

// ---------------------------------------------------------------------------------------------
// Lumps

export interface DThing { x: number; y: number; angle: number; type: number; flags: number }
export interface DLine { v1: number; v2: number; flags: number; special: number; tag: number; front: number; back: number }
export interface DSide { xoff: number; yoff: number; upper: string; lower: string; mid: string; sector: number }
export interface DSector { floor: number; ceil: number; floorTex: string; ceilTex: string; light: number; special: number; tag: number }
export interface DoomLevelData { things: DThing[]; lines: DLine[]; sides: DSide[]; verts: [number, number][]; sectors: DSector[] }

export const ML_BLOCKING = 1, ML_TWOSIDED = 4, ML_DONTPEGTOP = 8, ML_DONTPEGBOTTOM = 16;
const SKY = 'F_SKY1';

function b64(s: string): DataView {
  const bin = atob(s), u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return new DataView(u.buffer);
}
function name8(d: DataView, o: number): string {
  let s = '';
  for (let i = 0; i < 8; i++) { const c = d.getUint8(o + i); if (!c) break; s += String.fromCharCode(c); }
  return s.toUpperCase();
}

/** Parse the level JSON written by scripts/vendor-freedoom.mjs (raw lumps, base64). */
export function parseDoomLevel(json: string): DoomLevelData {
  const { lumps } = JSON.parse(json) as { lumps: Record<string, string> };
  const T = b64(lumps.THINGS), L = b64(lumps.LINEDEFS), S = b64(lumps.SIDEDEFS), V = b64(lumps.VERTEXES), E = b64(lumps.SECTORS);
  const i16 = (d: DataView, o: number) => d.getInt16(o, true), u16 = (d: DataView, o: number) => d.getUint16(o, true);
  const things: DThing[] = [], lines: DLine[] = [], sides: DSide[] = [], verts: [number, number][] = [], sectors: DSector[] = [];
  for (let o = 0; o + 10 <= T.byteLength; o += 10) things.push({ x: i16(T, o), y: i16(T, o + 2), angle: i16(T, o + 4), type: i16(T, o + 6), flags: i16(T, o + 8) });
  for (let o = 0; o + 14 <= L.byteLength; o += 14) {
    const back = u16(L, o + 12);
    lines.push({ v1: u16(L, o), v2: u16(L, o + 2), flags: u16(L, o + 4), special: u16(L, o + 6), tag: u16(L, o + 8), front: u16(L, o + 10), back: back === 0xffff ? -1 : back });
  }
  for (let o = 0; o + 30 <= S.byteLength; o += 30) sides.push({ xoff: i16(S, o), yoff: i16(S, o + 2), upper: name8(S, o + 4), lower: name8(S, o + 12), mid: name8(S, o + 20), sector: u16(S, o + 28) });
  for (let o = 0; o + 4 <= V.byteLength; o += 4) verts.push([i16(V, o), i16(V, o + 2)]);
  for (let o = 0; o + 26 <= E.byteLength; o += 26) sectors.push({ floor: i16(E, o), ceil: i16(E, o + 2), floorTex: name8(E, o + 4), ceilTex: name8(E, o + 12), light: i16(E, o + 20), special: i16(E, o + 22), tag: i16(E, o + 24) });
  return { things, lines, sides, verts, sectors };
}

// ---------------------------------------------------------------------------------------------
// Doors: the level is flown without line specials, so every door starts (and stays) open

// manual doors (opened by using the line: the door is the line's back sector) and tagged door triggers
const MANUAL_DOORS = new Set([1, 26, 27, 28, 31, 32, 33, 34, 117, 118]);
const TAGGED_DOORS = new Set([2, 4, 16, 29, 46, 61, 63, 76, 86, 90, 99, 103, 105, 106, 108, 109, 111, 112, 114, 115, 133, 134, 135, 136, 137]);

function sideSector(d: DoomLevelData, side: number) { return side < 0 ? -1 : d.sides[side].sector; }

/** Raise each door sector's ceiling to its lowest neighbouring ceiling minus 4, as an opened door does. */
export function openDoors(d: DoomLevelData): number {
  const doors = new Set<number>();
  for (const l of d.lines) {
    if (MANUAL_DOORS.has(l.special) && l.back >= 0) doors.add(sideSector(d, l.back));
    if (TAGGED_DOORS.has(l.special) && l.tag) d.sectors.forEach((s, i) => { if (s.tag === l.tag) doors.add(i); });
  }
  for (const si of doors) {
    let lowest = Infinity;
    for (const l of d.lines) {
      const f = sideSector(d, l.front), b = sideSector(d, l.back);
      if (f === si && b >= 0 && b !== si) lowest = Math.min(lowest, d.sectors[b].ceil);
      if (b === si && f >= 0 && f !== si) lowest = Math.min(lowest, d.sectors[f].ceil);
    }
    const s = d.sectors[si];
    if (Number.isFinite(lowest) && lowest - 4 > s.floor) s.ceil = Math.max(s.ceil, lowest - 4);
  }
  return doors.size;
}

// ---------------------------------------------------------------------------------------------
// Sector polygons

type P2 = [number, number];
export interface SectorPoly { outer: P2[]; holes: P2[][] }

const area = (l: P2[]) => { let a = 0; for (let i = 0; i < l.length; i++) { const p = l[i], q = l[(i + 1) % l.length]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; };
function inside(p: P2, l: P2[]): boolean {
  let c = false;
  for (let i = 0, j = l.length - 1; i < l.length; j = i++) {
    const a = l[i], b = l[j];
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) c = !c;
  }
  return c;
}

/**
 * Trace a sector's closed boundary loops from the linedefs that separate it from other space (the
 * sector lies right of each directed edge), then nest them: even depth = outer boundary, odd = hole.
 */
export function sectorPolygons(d: DoomLevelData, si: number): SectorPoly[] {
  const out = new Map<number, number[][]>(); // start vertex -> edges [v1, v2]
  let n = 0;
  for (const l of d.lines) {
    const f = sideSector(d, l.front), b = sideSector(d, l.back);
    if (f === b) continue; // both sides in this sector (or neither): not a boundary
    const e = f === si ? [l.v1, l.v2] : b === si ? [l.v2, l.v1] : null;
    if (!e || e[0] === e[1]) continue;
    let a = out.get(e[0]); if (!a) out.set(e[0], (a = []));
    a.push(e); n++;
  }
  const used = new Set<number[]>();
  const loops: P2[][] = [];
  for (const start of out.values()) for (const e0 of start) {
    if (used.has(e0)) continue;
    const loop: number[] = [];
    let e = e0;
    for (let guard = 0; guard <= n; guard++) {
      used.add(e); loop.push(e[0]);
      if (e[1] === e0[0]) break;
      const cands = (out.get(e[1]) ?? []).filter((c) => !used.has(c));
      if (!cands.length) { loop.length = 0; break; } // unclosed: drop
      // at a pinch vertex keep the region on the right: smallest CCW turn from the reversed incoming edge
      const [px, py] = d.verts[e[0]], [cx, cy] = d.verts[e[1]];
      const back = Math.atan2(py - cy, px - cx);
      let best = cands[0], ba = Infinity;
      for (const c of cands) {
        const [nx, ny] = d.verts[c[1]];
        let a = Math.atan2(ny - cy, nx - cx) - back;
        while (a <= 1e-9) a += 2 * Math.PI;
        if (a < ba) { ba = a; best = c; }
      }
      e = best;
    }
    if (loop.length >= 3) { const pts = loop.map((v) => [...d.verts[v]] as P2); if (Math.abs(area(pts)) > 1) loops.push(pts); }
  }
  // nesting by containment (majority of a loop's vertices inside a larger loop)
  const absA = loops.map((l) => Math.abs(area(l)));
  const contains = (o: number, i: number) => absA[o] > absA[i] && loops[i].filter((p) => inside(p, loops[o])).length * 2 > loops[i].length;
  const parents = loops.map((_, i) => loops.map((_, o) => o).filter((o) => o !== i && contains(o, i)));
  const polys = new Map<number, SectorPoly>();
  loops.forEach((l, i) => { if (parents[i].length % 2 === 0) polys.set(i, { outer: l, holes: [] }); });
  loops.forEach((l, i) => {
    if (parents[i].length % 2 === 0) return;
    // the innermost enclosing outer loop
    const p = parents[i].filter((o) => polys.has(o)).sort((a, b) => absA[a] - absA[b])[0];
    if (p !== undefined) polys.get(p)!.holes.push(l);
  });
  return [...polys.values()];
}

/** Triangles (as point triples) of a polygon with holes. */
export function triangulate(p: SectorPoly): P2[][] {
  const v = (q: P2) => new Vector2(q[0], q[1]);
  const contour = p.outer.map(v), holes = p.holes.map((h) => h.map(v));
  const all = [...p.outer, ...p.holes.flat()];
  return ShapeUtils.triangulateShape(contour, holes).map((t) => t.map((i) => all[i]));
}

// ---------------------------------------------------------------------------------------------
// Level -> MapDef

export interface DoomMapOptions {
  id: string; name: string;
  scale?: number;               // metres per Doom unit (player 56 u tall ≈ 1.75 m at 1/32)
  textures: Record<string, { file: string; w: number; h: number }>; // "w/NAME" / "f/NAME" (vendor-freedoom.mjs)
  textureBase: string;
}

const WALL_T = 0.15;            // thickness of one-sided wall boxes behind the line (m)
const SLAB = 1;                 // floor / ceiling slabs reach this far past the level's lowest floor / highest ceiling (m)

function materialFor(tex: string): Material {
  if (/^(ROCK|ASH|BROWN|STONE|BRICK|A-BRICK|AQCONC|FLAT2|RROCK|CEIL5|FLOOR5|GRASS|DIRT|SLIME|NUKAGE|FWATER)/.test(tex)) return 'concrete';
  if (/^(WOOD|CRATE|AQF07)/.test(tex)) return 'wood';
  return 'metal';
}

type V3 = [number, number, number];
type V4 = [number, number, number, number];

export function doomMapDef(json: string, o: DoomMapOptions): MapDef {
  const S = o.scale ?? 1 / 32;
  const d = parseDoomLevel(json);
  openDoors(d);
  const TX = o.textures;

  let lo0 = Infinity, lo1 = Infinity, hi0 = -Infinity, hi1 = -Infinity;
  for (const [x, y] of d.verts) { lo0 = Math.min(lo0, x); hi0 = Math.max(hi0, x); lo1 = Math.min(lo1, y); hi1 = Math.max(hi1, y); }
  const floorMin = Math.min(...d.sectors.map((s) => s.floor)), ceilMax = Math.max(...d.sectors.map((s) => s.ceil));
  // Doom units -> ENU metres: centre x/y on the origin, lowest floor at z = 0
  const off: V3 = [-(lo0 + hi0) / 2, -(lo1 + hi1) / 2, -floorMin];
  const toM = (x: number, y: number, z: number): V3 => [(x + off[0]) * S, (y + off[1]) * S, (z + off[2]) * S];
  const zBot = (floorMin + off[2]) * S - SLAB, zTop = (ceilMax + off[2]) * S + SLAB;

  // ---- collision: convex prisms over xy polygons (metres) ----
  const prims: BrushPrim[] = [];
  const prism = (poly: P2[], z0: number, z1: number, mat: Material, tag?: string) => {
    const pts = poly.map((p) => toM(p[0], p[1], 0));
    if (area(pts.map((p) => [p[0], p[1]] as P2)) < 0) pts.reverse(); // CCW
    const planes: number[] = [0, 0, 1, z1, 0, 0, -1, -z0];
    const edges: number[] = [];
    let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const ex = b[0] - a[0], ey = b[1] - a[1], l = Math.hypot(ex, ey);
      if (l < 1e-6) continue;
      const nx = ey / l, ny = -ex / l; // outward for CCW
      planes.push(nx, ny, 0, nx * a[0] + ny * a[1]);
      edges.push(a[0], a[1], z0, b[0], b[1], z0, a[0], a[1], z1, b[0], b[1], z1, a[0], a[1], z0, a[0], a[1], z1);
      mnx = Math.min(mnx, a[0]); mxx = Math.max(mxx, a[0]); mny = Math.min(mny, a[1]); mxy = Math.max(mxy, a[1]);
    }
    if (planes.length < 20) return;
    prims.push({
      kind: 'brush', c: { x: (mnx + mxx) / 2, y: (mny + mxy) / 2, z: (z0 + z1) / 2 }, planes: new Float64Array(planes), edges: new Float64Array(edges),
      min: { x: mnx, y: mny, z: z0 }, max: { x: mxx, y: mxy, z: z1 }, mat, tag,
    });
  };

  // ---- render faces (built in Doom units, converted to metres by fold()) ----
  const faces: QuakeFace[] = [];
  const fold = (v: V4): V4 => [v[0] / S, v[1] / S, v[2] / S, v[3] - (v[0] * off[0] + v[1] * off[1] + v[2] * off[2])];
  const face = (pts: V3[], n: V3, tex: string, s: V4, t: V4, light: number, kind: QuakeFace['kind'] = 'solid') => {
    if (!TX[tex]) return;
    const verts: number[] = [];
    for (const p of pts) verts.push(...toM(p[0], p[1], p[2]));
    faces.push({ verts, n, tex, s: fold(s), t: fold(t), kind, light });
  };

  // floors and ceilings
  const sectorPolys: SectorPoly[][] = d.sectors.map((_, i) => sectorPolygons(d, i));
  d.sectors.forEach((sec, si) => {
    const fz = (sec.floor + off[2]) * S, cz = (sec.ceil + off[2]) * S;
    for (const poly of sectorPolys[si]) for (const tri of triangulate(poly)) {
      if (Math.abs(area(tri)) < 0.5) continue;
      const ccw = area(tri) > 0 ? tri : [...tri].reverse();
      prism(ccw, zBot, fz, materialFor(sec.floorTex), 'floor');
      prism(ccw, cz, zTop, materialFor(sec.ceilTex), 'ceiling');
      // flats are aligned to the world grid: s = x, t = -y
      face(ccw.map((p) => [p[0], p[1], sec.floor]), [0, 0, 1], `f/${sec.floorTex}`, [1, 0, 0, 0], [0, -1, 0, 0], sec.light);
      if (sec.ceilTex !== SKY) face([...ccw].reverse().map((p) => [p[0], p[1], sec.ceil]), [0, 0, -1], `f/${sec.ceilTex}`, [1, 0, 0, 0], [0, -1, 0, 0], sec.light);
    }
  });

  // walls: each sidedef draws its own face, seen from its own sector
  for (const l of d.lines) {
    for (const back of [false, true]) {
      const sideIdx = back ? l.back : l.front;
      if (sideIdx < 0) continue;
      const side = d.sides[sideIdx], sec = d.sectors[side.sector];
      const otherIdx = back ? l.front : l.back;
      const other = otherIdx >= 0 ? d.sectors[d.sides[otherIdx].sector] : null;
      // the side's sector is on the right of a -> b
      const [ax, ay] = d.verts[back ? l.v2 : l.v1], [bx, by] = d.verts[back ? l.v1 : l.v2];
      const len = Math.hypot(bx - ax, by - ay);
      if (len < 1e-6) continue;
      const ux = (bx - ax) / len, uy = (by - ay) / len;
      const n: V3 = [uy, -ux, 0];
      // texel s = distance along the wall from a + x offset; t = (top - z) + y offset
      const sv: V4 = [ux, uy, 0, -(ux * ax + uy * ay) + side.xoff];
      const quad = (tex: string, z0: number, z1: number, top: number, kind: QuakeFace['kind'] = 'solid') => {
        if (z1 - z0 < 1e-6 || tex === '-' || !tex) return;
        face([[ax, ay, z0], [bx, by, z0], [bx, by, z1], [ax, ay, z1]], n, `w/${tex}`, sv, [0, 0, -1, top + side.yoff], sec.light, kind);
      };
      const th = (tex: string) => TX[`w/${tex}`]?.h ?? 128;
      if (!other) {
        quad(side.mid, sec.floor, sec.ceil, l.flags & ML_DONTPEGBOTTOM ? sec.floor + th(side.mid) : sec.ceil);
        if (!back) {
          // a box behind the line (into the void), the full height of the level
          const nx = -n[0] * WALL_T / S, ny = -n[1] * WALL_T / S;
          prism([[ax, ay], [bx, by], [bx + nx, by + ny], [ax + nx, ay + ny]], zBot, zTop, materialFor(side.mid), 'wall');
        }
        continue;
      }
      const bothSky = sec.ceilTex === SKY && other.ceilTex === SKY;
      if (other.ceil < sec.ceil && !bothSky) quad(side.upper, other.ceil, sec.ceil, l.flags & ML_DONTPEGTOP ? sec.ceil : other.ceil + th(side.upper));
      if (other.floor > sec.floor) quad(side.lower, sec.floor, other.floor, l.flags & ML_DONTPEGBOTTOM ? sec.ceil : other.floor);
      if (side.mid && side.mid !== '-' && TX[`w/${side.mid}`]) {
        // masked middle texture: one texture tall, clipped to the opening
        const open0 = Math.max(sec.floor, other.floor), open1 = Math.min(sec.ceil, other.ceil);
        const h = th(side.mid);
        const top = (l.flags & ML_DONTPEGBOTTOM ? open0 + h : open1) + side.yoff;
        const z0 = Math.max(open0, top - h), z1 = Math.min(open1, top);
        if (z1 > z0) {
          face([[ax, ay, z0], [bx, by, z0], [bx, by, z1], [ax, ay, z1]], n, `w/${side.mid}`, sv, [0, 0, -1, top], sec.light, 'masked');
          if (!back) { // grates / fences: a thin box on the line
            const tx = n[0] * 0.025 / S, ty = n[1] * 0.025 / S;
            prism([[ax - tx, ay - ty], [bx - tx, by - ty], [bx + tx, by + ty], [ax + tx, ay + ty]], (z0 + off[2]) * S, (z1 + off[2]) * S, 'metal', 'grate');
          }
        }
      }
    }
  }

  // spawn: player 1 start (thing type 1), standing on the floor of the sector it is in
  const start = d.things.find((t) => t.type === 1) ?? { x: (lo0 + hi0) / 2, y: (lo1 + hi1) / 2, angle: 0, type: 1, flags: 0 };
  let ssec = 0;
  sectorPolys.forEach((ps, si) => { for (const p of ps) if (inside([start.x, start.y], p.outer) && !p.holes.some((h) => inside([start.x, start.y], h))) ssec = si; });
  const sp = toM(start.x, start.y, d.sectors[ssec].floor);
  const yaw = (start.angle * Math.PI) / 180;

  const level: QuakeLevel = { faces, lights: [], ambient: 0, scale: S, textureBase: o.textureBase, textures: TX };
  return {
    id: o.id, name: o.name, size: Math.max(hi0 - lo0, hi1 - lo1) * S / 2, terrain: () => zBot - 1, ground: false, groundMat: 'concrete', prims, gates: [],
    spawn: { pos: { x: sp[0], y: sp[1], z: sp[2] }, yaw, groundZ: sp[2] },
    pilot: { x: sp[0], y: sp[1], z: sp[2] + 1.6 },
    sun: { azimuthDeg: 200, elevationDeg: 55 }, sky: 'overcast', wakeZones: [], elevationM: 0, trees: [], windScale: 0.3,
    quake: level,
  };
}
