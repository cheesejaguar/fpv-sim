// Map description shared by the physics worker (collision) and the renderer (geometry).
// Everything is analytic primitives (incl. convex brushes from Quake maps) + a heightfield, so
// collision is exact and needs no meshes.
// Coordinates: ENU metres (x east, y north, z up).
import { CollisionWorld, ContactHit, MATERIALS, SurfaceMaterial } from '../sim/contact';
import { V3 } from '../sim/math';
import type { WakeZone, WindVolume } from '../sim/wind';
import type { QuakeLevel } from './quakeMap';

export type Material = keyof typeof MATERIALS;

export interface BoxPrim { kind: 'box'; c: V3; half: V3; yaw: number; pitch?: number; mat: Material; color?: number; tag?: string; visual?: 'concrete' | 'brick' | 'metal' | 'wood' | 'gate' | 'pad' | 'glass' | 'plain' | BoxDecor; text?: string; texture?: string } // texture: image URL (map packages), overrides visual
/** Render looks for boxes: self-lit LED panel, printed banner / video screen (showing `text`), see-through safety net. */
export type BoxDecor = 'led' | 'banner' | 'screen' | 'net';
export interface CylPrim { kind: 'cyl'; c: V3; r: number; h: number; mat: Material; color?: number; tag?: string } // c = base centre, vertical
export interface SpherePrim { kind: 'sphere'; c: V3; r: number; mat: Material; color?: number; tag?: string }
/** Convex polyhedron: planes = (nx, ny, nz, d) per face, outward normals, inside where n·p <= d. edges = (a, b) xyz pairs. */
export interface BrushPrim { kind: 'brush'; c: V3; planes: Float64Array; edges: Float64Array; min: V3; max: V3; mat: Material; tag?: string }
export type Prim = BoxPrim | CylPrim | SpherePrim | BrushPrim;

/**
 * A timed obstacle. c = bottom centre of the counted opening (dive: frame centre; flag: pole foot),
 * yaw = direction of travel (CCW from +y), width x height = clear opening.
 * hurdle: wide low opening under a banner; ladder: `stack` openings on top of each other, only the
 * top one counts; onTop: the gate sits on the gate below it (no legs / bottom bar, e.g. a split-S stack).
 */
export interface GateDef {
  id: number; c: V3; yaw: number; width: number; height: number;
  kind: 'square' | 'arch' | 'flag' | 'dive' | 'hurdle' | 'ladder';
  stack?: number; onTop?: boolean;
  /** Frame tube half thickness (m), default GATE_T (12 cm tube); tiny-whoop gates use a thin one. */
  tube?: number;
}

/**
 * A light source in the map (interior fixtures, floodlights), drawn as a point light. At most
 * MAX_MAP_LIGHTS per map. intensity: three.js PointLight intensity with physical decay 2, in the
 * renderer's light units (the sun is ~4.5), so the illuminance at distance d is ~intensity / d².
 * range: cut-off distance (m), PointLight.distance.
 */
export interface MapLight { pos: V3; color: number; intensity: number; range: number }
export const MAX_MAP_LIGHTS = 8;

/**
 * A separately timed gate sequence on the same map (a drill area: slalom, figure-8 ...), flown
 * instead of `gates` when selected (withCourse). Gate ids are unique across the whole map, so the
 * renderer draws every course's gates and lights up the selected course's next gate.
 */
export interface CourseDef { id: string; name: string; gates: GateDef[]; spawn?: MapDef['spawn'] }

export interface MapDef {
  id: string; name: string;
  size: number;                       // half-extent of playable area (m)
  terrain: (x: number, y: number) => number;
  groundMat: Material;
  prims: Prim[];
  gates: GateDef[];
  spawn: { pos: V3; yaw: number; groundZ?: number }; // groundZ: floor height at spawn (default: terrain)
  sun: { azimuthDeg: number; elevationDeg: number }; // sky 'night': the moon
  sky: 'clear' | 'overcast' | 'dusk' | 'night';
  wakeZones: WakeZone[];               // obstacle footprints (building / tree line): wake laid out downwind
  elevationM: number;
  trees: { x: number; y: number; h: number; r: number; type: 'pine' | 'oak' }[];
  ground?: boolean;                   // render the terrain mesh (default true)
  pilot?: V3;                         // pilot / video receiver position (default: beside the spawn)
  windScale?: number;                 // indoor maps: scale the configured wind
  indoor?: WindVolume[];              // enclosed spaces in an outdoor map: wind × scale inside
  quake?: QuakeLevel;                 // render data for maps loaded from Quake .map sources
  decor?: Prim[];                     // render-only scenery (crowds, screens, LED strips): no collision
  fog?: { color: number; density: number }; // FogExp2 override (default: from sky)
  groundTexture?: string;             // image URL for the terrain (default: from groundMat)
  meshes?: MeshInstance[];            // glTF meshes to draw (their collision, if any, is in prims)
  lights?: MapLight[];                // point lights (<= MAX_MAP_LIGHTS): interior fixtures, floodlights
  courses?: CourseDef[];              // drill areas timed on their own (gates = the default course)
  spawns?: SpawnDef[];                // named start variants (withSpawn); spawn = the default
  wind?: { speed: number; direction: number; turbulence: number; gusts: number }; // the map's suggested wind (FROM, deg)
  paths?: PathDef[];                  // polylines actors move along
  actors?: ActorDef[];                // RF components, detectors, targets (src/sim/actors.ts)
  scenarios?: { path: string; url: string }[]; // bundled fpvsim-scenario files
  collisionCell?: number;             // collision grid cell size (m), default 8; dense interiors use a finer grid
}

/** A named start: the quad's pose, and optionally where the pilot / video receiver stands for it. */
export interface SpawnDef { id: string; name: string; pos: V3; yaw: number; groundZ?: number; pilot?: V3 }

/** An actor path: points in order, travelled at speed (m/s) from sim time delay (s). */
export interface PathDef { id: string; points: V3[]; speed: number; mode: 'loop' | 'pingpong' | 'once'; delay: number }

/**
 * Something in the world besides the quad: an RF emitter (jammer, other traffic), a ground station
 * (relay / diversity site), a detector (camera, radar, RF) or a target. pos is where it stands (for
 * an actor on a path: the path's first point; see posAt in src/sim/actors.ts). Angles are radians.
 */
export type ActorDef = { id: string; name: string; pos: V3; path?: string } & (
  | { type: 'rf-emitter'; freqMHz: number; eirpDbm: number; bwMHz: number; duty: number; antenna?: { yaw: number; pitch: number; beam: number } }
  | { type: 'ground-station'; link: 'rc' | 'video' | 'both'; txPowerMw?: number; gainDbi: number }
  | { type: 'detector'; sensor: 'camera' | 'radar' | 'rf'; yaw: number; pitch: number; fovH: number; fovV: number; rangeM: number; r50M: number; sensitivityDbm: number; rateHz: number; confirmM: number; confirmN: number }
  | { type: 'target'; shape: 'box' | 'sphere' | 'cylinder' | 'quad' | 'vehicle' | 'person'; size: V3; radius: number; solid: boolean; color?: number }
);

/** A .glb drawn by the renderer: placed at pos (ENU), rotated by yaw about +z, uniformly scaled. */
export interface MeshInstance { url: string; pos: V3; yaw: number; scale: number }

/** The map flying course `courseId` (its gates and start), or the map itself for the default course / an unknown id. */
export function withCourse(m: MapDef, courseId?: string): MapDef {
  const c = courseId ? m.courses?.find((x) => x.id === courseId) : undefined;
  return c ? { ...m, gates: c.gates, spawn: c.spawn ?? m.spawn } : m;
}

/** The map starting from spawn variant `spawnId` (its pose and pilot position), or the map itself for '' / an unknown id. */
export function withSpawn(m: MapDef, spawnId?: string): MapDef {
  const s = spawnId ? m.spawns?.find((x) => x.id === spawnId) : undefined;
  if (!s) return m;
  const out: MapDef = { ...m, spawn: { pos: { ...s.pos }, yaw: s.yaw, ...(s.groundZ !== undefined && { groundZ: s.groundZ }) } };
  if (s.pilot) out.pilot = { ...s.pilot };
  return out;
}

/** Floor height under the spawn point. */
export const spawnGroundZ = (m: MapDef) => m.spawn.groundZ ?? m.terrain(m.spawn.pos.x, m.spawn.pos.y);
/** Where the pilot stands (eye height): the video link is modelled from here. */
export function pilotPos(m: MapDef, o: V3): V3 {
  if (m.pilot) { o.x = m.pilot.x; o.y = m.pilot.y; o.z = m.pilot.z; return o; }
  o.x = m.spawn.pos.x - 2; o.y = m.spawn.pos.y - 2; o.z = m.terrain(o.x, o.y) + 1.6;
  return o;
}

// ---------------------------------------------------------------------------------------------

// Sphere queries (8 kHz x ~75 collider spheres) read packed per-cell records instead of the Prim
// objects: one Float64Array per grid cell, REC numbers per prim (kind, centre, size, rotation,
// material index, bounding radius), so the hot loop has no Map lookups, no megamorphic property
// loads and rejects far prims with one squared-distance test.
const REC = 13;
const K_BOX = 0, K_CYL = 1, K_SPHERE = 2;
/** Terrain under the sphere queries: tangent planes (height + normal from 5 terrain samples), each
 *  used within PLANE_REUSE m (per axis) of where it was taken; a few kept so that all of a quad's
 *  collider spheres find one. */
const PLANE_REUSE = 0.15, PLANES = 8, PL = 8; // per plane: x, y, h, gx, gy, nx, ny, nz

export class PrimitiveWorld implements CollisionWorld {
  private cell: number;
  private grid = new Map<number, Prim[]>();
  private boxRot = new Map<BoxPrim, { c: number; s: number; cp: number; sp: number }>();
  /** grid cells as packed records for sphere() (REC numbers per prim) */
  private packed = new Map<number, Float64Array>();
  private mats: SurfaceMaterial[] = [];
  private groundMat: SurfaceMaterial;
  private planes = new Float64Array(PLANES * PL).fill(Infinity); // (no plane anywhere yet)
  private nPlanes = 0; private lastPlane = 0; private nextPlane = 0;
  private cand = new Float64Array(64 * REC); private nCand = 0; // near(): records within reach
  readonly brushes = new BrushGrid();
  // porous drag volumes (tree canopies, foliage spheres, hedges): not solid, see foliage()
  private canopies = new Map<number, (SpherePrim | BoxPrim)[]>();
  private hasCanopy = false;
  constructor(public map: MapDef) {
    this.cell = map.collisionCell ?? 8;
    this.groundMat = MATERIALS[map.groundMat];
    for (const p of map.prims) {
      // foliage spheres and thick foliage boxes are volumes; thin ones (safety nets, flags) stay solid
      if (p.mat === 'foliage' && (p.kind === 'sphere' || (p.kind === 'box' && Math.min(p.half.x, p.half.y, p.half.z) > 0.25))) this.insertCanopy(p);
      else this.insert(p);
    }
    for (const t of map.trees) {
      const g = map.terrain(t.x, t.y);
      this.insert({ kind: 'cyl', c: { x: t.x, y: t.y, z: g - 0.2 }, r: t.r * 0.12, h: t.h * 0.5, mat: 'wood' });
      const c = { x: t.x, y: t.y, z: g + t.h * 0.62 };
      this.insertCanopy({ kind: 'sphere', c, r: t.r, mat: 'foliage' });
      this.insert({ kind: 'sphere', c, r: t.r * 0.3, mat: 'wood' }); // trunk top + main limbs: solid core
    }
    this.pack();
  }
  private pack() {
    const matIx = new Map<string, number>();
    for (const [k, l] of this.grid) {
      const a = new Float64Array(l.length * REC);
      l.forEach((pr, i) => {
        if (pr.kind === 'brush') { a[i * REC] = K_SPHERE; a[i * REC + 4] = -Infinity; return; } // (never: brushes live in this.brushes)
        let m = matIx.get(pr.mat);
        if (m === undefined) { m = this.mats.length; matIx.set(pr.mat, m); this.mats.push(MATERIALS[pr.mat]); }
        const o = i * REC;
        a[o + 1] = pr.c.x; a[o + 2] = pr.c.y; a[o + 3] = pr.c.z; a[o + 11] = m;
        if (pr.kind === 'box') {
          const r = this.boxRot.get(pr)!, h = pr.half;
          a[o] = K_BOX; a[o + 4] = h.x; a[o + 5] = h.y; a[o + 6] = h.z;
          a[o + 7] = r.c; a[o + 8] = r.s; a[o + 9] = r.cp; a[o + 10] = r.sp;
          // bounding radius, a hair generous so that rounding can never reject a touching box
          a[o + 12] = Math.sqrt(h.x * h.x + h.y * h.y + h.z * h.z) * (1 + 1e-9) + 1e-9;
        } else if (pr.kind === 'cyl') { a[o] = K_CYL; a[o + 4] = pr.r; a[o + 5] = pr.h; }
        else { a[o] = K_SPHERE; a[o + 4] = pr.r; }
      });
      this.packed.set(k, a);
    }
  }
  private insertCanopy(p: SpherePrim | BoxPrim) {
    const r = p.kind === 'sphere' ? p.r : Math.hypot(p.half.x, p.half.y, p.half.z);
    if (p.kind === 'box') this.boxRot.set(p, { c: Math.cos(p.yaw), s: Math.sin(p.yaw), cp: Math.cos(p.pitch ?? 0), sp: Math.sin(p.pitch ?? 0) });
    for (let ix = Math.floor((p.c.x - r) / this.cell); ix <= Math.floor((p.c.x + r) / this.cell); ix++) for (let iy = Math.floor((p.c.y - r) / this.cell); iy <= Math.floor((p.c.y + r) / this.cell); iy++) {
      const k = this.key(ix, iy);
      let l = this.canopies.get(k); if (!l) { l = []; this.canopies.set(k, l); }
      l.push(p);
    }
    this.hasCanopy = true;
  }

  /** Depth of p inside the deepest canopy / foliage volume (m), 0 outside. */
  foliage(p: V3): number {
    if (!this.hasCanopy) return 0;
    const l = this.canopies.get(this.key(Math.floor(p.x / this.cell), Math.floor(p.y / this.cell)));
    if (!l) return 0;
    let best = 0;
    for (const pr of l) {
      let d: number;
      if (pr.kind === 'sphere') { const dx = p.x - pr.c.x, dy = p.y - pr.c.y, dz = p.z - pr.c.z; d = pr.r - Math.sqrt(dx * dx + dy * dy + dz * dz); }
      else {
        const rot = this.boxRot.get(pr)!;
        const dx = p.x - pr.c.x, dy = p.y - pr.c.y, dz = p.z - pr.c.z;
        let lx = rot.c * dx + rot.s * dy; const ly = -rot.s * dx + rot.c * dy; let lz = dz;
        const tx = rot.cp * lx - rot.sp * lz; lz = rot.sp * lx + rot.cp * lz; lx = tx;
        d = Math.min(pr.half.x - Math.abs(lx), pr.half.y - Math.abs(ly), pr.half.z - Math.abs(lz));
      }
      if (d > best) best = d;
    }
    return best;
  }
  private key(ix: number, iy: number) { return (ix + 4096) * 8192 + (iy + 4096); }
  private insert(p: Prim) {
    if (p.kind === 'brush') { this.brushes.insert(p); return; }
    let r: number;
    if (p.kind === 'box') { r = Math.hypot(p.half.x, p.half.y, p.half.z); this.boxRot.set(p, { c: Math.cos(p.yaw), s: Math.sin(p.yaw), cp: Math.cos(p.pitch ?? 0), sp: Math.sin(p.pitch ?? 0) }); }
    else if (p.kind === 'cyl') r = Math.max(p.r, p.h);
    else r = p.r;
    const x0 = Math.floor((p.c.x - r) / this.cell), x1 = Math.floor((p.c.x + r) / this.cell);
    const y0 = Math.floor((p.c.y - r) / this.cell), y1 = Math.floor((p.c.y + r) / this.cell);
    for (let ix = x0; ix <= x1; ix++) for (let iy = y0; iy <= y1; iy++) {
      const k = this.key(ix, iy);
      let l = this.grid.get(k); if (!l) { l = []; this.grid.set(k, l); }
      l.push(p);
    }
  }

  groundHeight(x: number, y: number): number { return this.map.terrain(x, y); }

  /** Index (into this.planes) of a terrain tangent plane usable at (x, y); takes a new one if none is. */
  private plane(x: number, y: number): number {
    const P = this.planes;
    let o = this.lastPlane;
    if (Math.abs(x - P[o]) <= PLANE_REUSE && Math.abs(y - P[o + 1]) <= PLANE_REUSE) return o;
    for (let i = 0; i < this.nPlanes; i++) {
      o = i * PL;
      if (Math.abs(x - P[o]) <= PLANE_REUSE && Math.abs(y - P[o + 1]) <= PLANE_REUSE) return (this.lastPlane = o);
    }
    // central differences around (x, y); the slot is reused round-robin
    o = this.nextPlane * PL;
    this.nextPlane = (this.nextPlane + 1) % PLANES;
    if (this.nPlanes < PLANES) this.nPlanes++;
    const t = this.map.terrain, e = 0.05;
    const gx = (t(x + e, y) - t(x - e, y)) / (2 * e), gy = (t(x, y + e) - t(x, y - e)) / (2 * e);
    const nl = Math.sqrt(gx * gx + gy * gy + 1);
    P[o] = x; P[o + 1] = y; P[o + 2] = t(x, y); P[o + 3] = gx; P[o + 4] = gy; P[o + 5] = -gx / nl; P[o + 6] = -gy / nl; P[o + 7] = 1 / nl;
    return (this.lastPlane = o);
  }

  /** Terrain part of sphere(): the deepest-so-far result written to out (0 = none). */
  private terrainHit(px: number, py: number, pz: number, radius: number, out: ContactHit): number {
    // the tangent plane under the sphere (all of a quad's spheres share a few)
    const P = this.planes, o = this.plane(px, py);
    const h = P[o + 2] + P[o + 3] * (px - P[o]) + P[o + 4] * (py - P[o + 1]);
    if (pz - radius >= h + 0.5) return 0;
    const nz = P[o + 7], d = radius - (pz - h) * nz;
    if (d <= 0) return 0;
    out.depth = d; out.nx = P[o + 5]; out.ny = P[o + 6]; out.nz = nz; out.material = this.groundMat;
    return d;
  }

  /** Packed records a[0 .. end) against the sphere: returns the new best depth (hit written to out). */
  private records(a: Float64Array, end: number, px: number, py: number, pz: number, radius: number, best: number, out: ContactHit): number {
    const mats = this.mats, r2 = radius * radius;
    for (let i = 0; i < end; i += REC) {
      const kind = a[i], dx = px - a[i + 1], dy = py - a[i + 2], dz = pz - a[i + 3];
      if (kind === K_BOX) {
        const rb = a[i + 12] + radius;
        if (dx * dx + dy * dy + dz * dz > rb * rb) continue; // out of reach
        const hx = a[i + 4], hy = a[i + 5], hz = a[i + 6], c = a[i + 7], s = a[i + 8], cp = a[i + 9], sp = a[i + 10];
        // into box frame: yaw about z then pitch about local y
        let lx = c * dx + s * dy, lz = dz;
        const ly = -s * dx + c * dy;
        const tx = cp * lx - sp * lz; lz = sp * lx + cp * lz; lx = tx;
        const qx = lx < -hx ? -hx : lx > hx ? hx : lx, qy = ly < -hy ? -hy : ly > hy ? hy : ly, qz = lz < -hz ? -hz : lz > hz ? hz : lz;
        let nx = lx - qx, ny = ly - qy, nz = lz - qz;
        const n2 = nx * nx + ny * ny + nz * nz;
        let depth: number;
        if (n2 > 1e-18) {
          if (n2 >= r2) continue;
          const dist = Math.sqrt(n2);
          depth = radius - dist; nx /= dist; ny /= dist; nz /= dist;
        } else {
          // centre inside: push out along the axis of least penetration
          const ex = hx - Math.abs(lx), ey = hy - Math.abs(ly), ez = hz - Math.abs(lz);
          if (ex < ey && ex < ez) { nx = Math.sign(lx) || 1; ny = 0; nz = 0; depth = ex + radius; }
          else if (ey < ez) { nx = 0; ny = Math.sign(ly) || 1; nz = 0; depth = ey + radius; }
          else { nx = 0; ny = 0; nz = Math.sign(lz) || 1; depth = ez + radius; }
        }
        if (depth > best) {
          // back to world: inverse pitch then inverse yaw
          const wx0 = cp * nx + sp * nz;
          best = depth; out.depth = depth; out.nx = c * wx0 - s * ny; out.ny = s * wx0 + c * ny; out.nz = -sp * nx + cp * nz; out.material = mats[a[i + 11]];
        }
      } else if (kind === K_CYL) {
        const r = a[i + 4], top = a[i + 3] + a[i + 5];
        if (pz < a[i + 3] - radius || pz > top + radius) continue;
        const rr = Math.sqrt(dx * dx + dy * dy), side = r + radius - rr;
        if (side <= 0) continue;
        const dTop = top + radius - pz;
        if (dTop < side && pz > top) {
          if (dTop > best && rr < r) { best = dTop; out.depth = dTop; out.nx = 0; out.ny = 0; out.nz = 1; out.material = mats[a[i + 11]]; }
        } else if (side > best) {
          best = side; out.depth = side; out.nx = dx / (rr || 1); out.ny = dy / (rr || 1); out.nz = 0; out.material = mats[a[i + 11]];
        }
      } else {
        const rs = a[i + 4] + radius, d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= rs * rs) continue;
        const d = Math.sqrt(d2), depth = rs - d;
        if (depth > best && d > 1e-6) { best = depth; out.depth = depth; out.nx = dx / d; out.ny = dy / d; out.nz = dz / d; out.material = mats[a[i + 11]]; }
      }
    }
    return best;
  }

  sphere(p: V3, radius: number, out: ContactHit): boolean {
    const px = p.x, py = p.y, pz = p.z;
    let best = this.terrainHit(px, py, pz, radius, out);
    // every grid cell the sphere overlaps (a prim just across a cell border is not listed in this one)
    const C = this.cell, cells = this.packed;
    const cx0 = Math.floor((px - radius) / C), cx1 = Math.floor((px + radius) / C);
    const cy0 = Math.floor((py - radius) / C), cy1 = Math.floor((py + radius) / C);
    for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) {
      const a = cells.get(this.key(cx, cy));
      if (a !== undefined) best = this.records(a, a.length, px, py, pz, radius, best, out);
    }
    if (this.brushes.count) best = this.brushes.sphere(p, radius, out, best);
    return best > 0;
  }

  /**
   * Collect the prims within reach of the sphere (p, r), e.g. an airframe's bound sphere, for the
   * sphereNear() queries of spheres inside it that follow: those then skip the grid and every prim
   * out of reach. (Same results as sphere(): a prim missing from the list can't touch them.)
   */
  near(p: V3, r: number): void {
    const R = r * (1 + 1e-9) + 1e-9, px = p.x, py = p.y, pz = p.z, C = this.cell;
    let c = this.cand, n = 0;
    for (let cx = Math.floor((px - R) / C), cx1 = Math.floor((px + R) / C); cx <= cx1; cx++) for (let cy = Math.floor((py - R) / C), cy1 = Math.floor((py + R) / C); cy <= cy1; cy++) {
      const a = this.packed.get(this.key(cx, cy));
      if (a === undefined) continue;
      for (let i = 0; i < a.length; i += REC) {
        const dx = px - a[i + 1], dy = py - a[i + 2], dz = pz - a[i + 3], kind = a[i];
        const reach = (kind === K_BOX ? a[i + 12] : a[i + 4]) + R;
        if (kind === K_CYL ? pz < a[i + 3] - R || pz > a[i + 3] + a[i + 5] + R || dx * dx + dy * dy > reach * reach : dx * dx + dy * dy + dz * dz > reach * reach) continue;
        if ((n + 1) * REC > c.length) { const g = new Float64Array(c.length * 2); g.set(c); this.cand = c = g; }
        for (let j = 0, o = n * REC; j < REC; j++) c[o + j] = a[i + j];
        n++;
      }
    }
    this.nCand = n;
  }

  /** sphere() for a sphere inside the one last passed to near(). */
  sphereNear(p: V3, radius: number, out: ContactHit): boolean {
    const px = p.x, py = p.y, pz = p.z;
    let best = this.terrainHit(px, py, pz, radius, out);
    if (this.nCand) best = this.records(this.cand, this.nCand * REC, px, py, pz, radius, best, out);
    if (this.brushes.count) best = this.brushes.sphere(p, radius, out, best);
    return best > 0;
  }

  raycast(p: V3, dir: V3, maxDist: number): number {
    let best = Infinity;
    // terrain by marching (short rays only: ground effect / LOS)
    const n = Math.min(Math.ceil(maxDist / 0.05), 400);
    // a vertical ray (the height above ground) sees one terrain height
    const hv = dir.x === 0 && dir.y === 0 ? this.map.terrain(p.x, p.y) : NaN;
    for (let i = 1; i <= n; i++) {
      const t = (i / n) * maxDist;
      const z = p.z + dir.z * t;
      if (z <= (hv === hv ? hv : this.map.terrain(p.x + dir.x * t, p.y + dir.y * t))) { best = t; break; }
    }
    // boxes in the start cell and end cell
    const k0 = this.key(Math.floor(p.x / this.cell), Math.floor(p.y / this.cell));
    const k1 = this.key(Math.floor((p.x + dir.x * maxDist) / this.cell), Math.floor((p.y + dir.y * maxDist) / this.cell));
    for (let c = 0; c < 2; c++) {
      if (c === 1 && k1 === k0) break;
      const l = this.grid.get(c ? k1 : k0); if (!l) continue;
      for (const pr of l) {
        if (pr.kind !== 'box') continue;
        const rot = this.boxRot.get(pr)!;
        const dx = p.x - pr.c.x, dy = p.y - pr.c.y, dz = p.z - pr.c.z;
        let ox = rot.c * dx + rot.s * dy, oy = -rot.s * dx + rot.c * dy, oz = dz;
        let vx = rot.c * dir.x + rot.s * dir.y, vy = -rot.s * dir.x + rot.c * dir.y, vz = dir.z;
        const t1 = rot.cp * ox - rot.sp * oz; oz = rot.sp * ox + rot.cp * oz; ox = t1;
        const t2 = rot.cp * vx - rot.sp * vz; vz = rot.sp * vx + rot.cp * vz; vx = t2;
        let tmin = 0, tmax = maxDist;
        const slab = (o: number, v: number, h: number) => {
          if (Math.abs(v) < 1e-9) return Math.abs(o) <= h;
          let a = (-h - o) / v, b = (h - o) / v; if (a > b) { const t = a; a = b; b = t; }
          tmin = Math.max(tmin, a); tmax = Math.min(tmax, b); return tmin <= tmax;
        };
        if (slab(ox, vx, pr.half.x) && slab(oy, vy, pr.half.y) && slab(oz, vz, pr.half.z)) best = Math.min(best, tmin);
      }
    }
    if (this.brushes.count) best = Math.min(best, this.brushes.raycast(p, dir, Math.min(maxDist, best)));
    return best;
  }

  /** Line-of-sight obstruction loss (dB) between two points, used by the video link model. */
  obstructionDb(a: V3, b: V3): number {
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const L = Math.hypot(dx, dy, dz);
    if (L < 0.5) return 0;
    let loss = 0;
    const n = Math.min(80, Math.ceil(L / 1.5));
    const seen = new Set<Prim>();
    for (let i = 1; i < n; i++) {
      const t = i / n;
      const x = a.x + dx * t, y = a.y + dy * t, z = a.z + dz * t;
      if (z < this.map.terrain(x, y)) loss += 1.2;
      const key = this.key(Math.floor(x / this.cell), Math.floor(y / this.cell));
      const cl = this.canopies.get(key);
      if (cl) for (const pr of cl) if (!seen.has(pr) && this.inside(pr, x, y, z)) { seen.add(pr); loss += 4; }
      const l = this.grid.get(key);
      if (!l) continue;
      for (const pr of l) {
        if (seen.has(pr)) continue;
        if (pr.mat === 'wood' && pr.kind === 'sphere') continue; // canopy core: already counted as foliage
        if (this.inside(pr, x, y, z)) { seen.add(pr); loss += pr.mat === 'concrete' ? 14 : pr.mat === 'metal' ? 18 : pr.mat === 'foliage' ? 4 : 6; }
      }
    }
    if (this.brushes.count) loss += this.brushes.obstructionDb(a, b);
    return Math.min(loss, 60);
  }

  private inside(pr: Prim, x: number, y: number, z: number): boolean {
    if (pr.kind === 'box') {
      const rot = this.boxRot.get(pr)!;
      const dx = x - pr.c.x, dy = y - pr.c.y, dz = z - pr.c.z;
      let lx = rot.c * dx + rot.s * dy; const ly = -rot.s * dx + rot.c * dy; let lz = dz;
      const t = rot.cp * lx - rot.sp * lz; lz = rot.sp * lx + rot.cp * lz; lx = t;
      return Math.abs(lx) <= pr.half.x && Math.abs(ly) <= pr.half.y && Math.abs(lz) <= pr.half.z;
    }
    if (pr.kind === 'cyl') return z >= pr.c.z && z <= pr.c.z + pr.h && Math.hypot(x - pr.c.x, y - pr.c.y) <= pr.r;
    if (pr.kind === 'brush') return brushContains(pr, x, y, z);
    return Math.hypot(x - pr.c.x, y - pr.c.y, z - pr.c.z) <= pr.r;
  }

  material(name: Material): SurfaceMaterial { return MATERIALS[name]; }
}

// ---------------------------------------------------------------------------------------------
// Convex brushes (Quake maps): uniform 3D grid with exact sphere / segment queries

export function brushContains(b: BrushPrim, x: number, y: number, z: number): boolean {
  const P = b.planes;
  for (let i = 0; i < P.length; i += 4) if (P[i] * x + P[i + 1] * y + P[i + 2] * z > P[i + 3]) return false;
  return true;
}

/** Clip the segment p + d·t, t in [0, len] against a brush; out.t0/t1 = entry/exit. False if it misses. */
export function clipSegment(b: BrushPrim, p: V3, d: V3, len: number, out: { t0: number; t1: number }): boolean {
  let t0 = 0, t1 = len;
  const P = b.planes;
  for (let i = 0; i < P.length; i += 4) {
    const dist = P[i] * p.x + P[i + 1] * p.y + P[i + 2] * p.z - P[i + 3];
    const den = P[i] * d.x + P[i + 1] * d.y + P[i + 2] * d.z;
    if (Math.abs(den) < 1e-12) { if (dist > 0) return false; continue; }
    const t = -dist / den;
    if (den < 0) { if (t > t0) t0 = t; } else if (t < t1) t1 = t;
    if (t0 > t1) return false;
  }
  out.t0 = t0; out.t1 = t1;
  return true;
}

export class BrushGrid {
  readonly list: BrushPrim[] = [];
  private cells = new Map<number, number[]>();
  private mark = new Uint32Array(64);
  private stamp = 0;
  private seg = { t0: 0, t1: 0 };
  private nx = 0; private ny = 0; private nz = 0;
  constructor(readonly cell = 4) {}
  get count() { return this.list.length; }
  /** 10 bits per axis: a small-integer key (no boxed number per lookup); cells 4 km apart share a
   *  list, which only costs a bounding-box test (every query checks the brush itself) */
  private key(ix: number, iy: number, iz: number) { return ((ix & 1023) << 20) | ((iy & 1023) << 10) | (iz & 1023); }
  private next() { if (++this.stamp === 0xffffffff) { this.mark.fill(0); this.stamp = 1; } return this.stamp; }

  insert(b: BrushPrim) {
    const idx = this.list.push(b) - 1;
    if (this.mark.length < this.list.length) { const m = new Uint32Array(this.list.length * 2); m.set(this.mark); this.mark = m; }
    const C = this.cell;
    for (let ix = Math.floor(b.min.x / C); ix <= Math.floor(b.max.x / C); ix++)
      for (let iy = Math.floor(b.min.y / C); iy <= Math.floor(b.max.y / C); iy++)
        for (let iz = Math.floor(b.min.z / C); iz <= Math.floor(b.max.z / C); iz++) {
          const k = this.key(ix, iy, iz);
          let l = this.cells.get(k); if (!l) { l = []; this.cells.set(k, l); }
          l.push(idx);
        }
  }

  /** Deepest sphere penetration over all brushes, if deeper than `best` (written to out). */
  sphere(p: V3, r: number, out: ContactHit, best: number): number {
    const C = this.cell, st = this.next();
    const x1 = Math.floor((p.x + r) / C), y1 = Math.floor((p.y + r) / C), z1 = Math.floor((p.z + r) / C);
    for (let ix = Math.floor((p.x - r) / C); ix <= x1; ix++) for (let iy = Math.floor((p.y - r) / C); iy <= y1; iy++) for (let iz = Math.floor((p.z - r) / C); iz <= z1; iz++) {
      const l = this.cells.get(this.key(ix, iy, iz));
      if (!l) continue;
      for (let n = 0; n < l.length; n++) {
        const idx = l[n];
        if (this.mark[idx] === st) continue;
        this.mark[idx] = st;
        const b = this.list[idx];
        if (p.x + r < b.min.x || p.x - r > b.max.x || p.y + r < b.min.y || p.y - r > b.max.y || p.z + r < b.min.z || p.z - r > b.max.z) continue;
        const depth = this.sphereBrush(b, p, r);
        if (depth > best) { best = depth; out.depth = depth; out.nx = this.nx; out.ny = this.ny; out.nz = this.nz; out.material = MATERIALS[b.mat]; }
      }
    }
    return best;
  }

  /** Exact sphere vs convex polyhedron: penetration depth (0 if apart), normal in this.n*. */
  private sphereBrush(b: BrushPrim, p: V3, r: number): number {
    const P = b.planes, k = P.length;
    let maxd = -Infinity, im = 0;
    for (let i = 0; i < k; i += 4) {
      const d = P[i] * p.x + P[i + 1] * p.y + P[i + 2] * p.z - P[i + 3];
      if (d >= r) return 0; // separating plane
      if (d > maxd) { maxd = d; im = i; }
    }
    if (maxd <= 0) { this.nx = P[im]; this.ny = P[im + 1]; this.nz = P[im + 2]; return r - maxd; } // centre inside: least-penetration face
    // centre outside: the closest point lies on a face whose projection stays inside the brush, else on an edge / vertex
    for (let i = 0; i < k; i += 4) {
      const d = P[i] * p.x + P[i + 1] * p.y + P[i + 2] * p.z - P[i + 3];
      if (d <= 0) continue;
      const qx = p.x - d * P[i], qy = p.y - d * P[i + 1], qz = p.z - d * P[i + 2];
      let ok = true;
      for (let j = 0; j < k && ok; j += 4) if (j !== i && P[j] * qx + P[j + 1] * qy + P[j + 2] * qz - P[j + 3] > 1e-7) ok = false;
      if (ok) { this.nx = P[i]; this.ny = P[i + 1]; this.nz = P[i + 2]; return r - d; }
    }
    const E = b.edges;
    let bd = Infinity, bx = 0, by = 0, bz = 0;
    for (let e = 0; e < E.length; e += 6) {
      const ax = E[e], ay = E[e + 1], az = E[e + 2], ex = E[e + 3] - ax, ey = E[e + 4] - ay, ez = E[e + 5] - az;
      const ll = ex * ex + ey * ey + ez * ez;
      let t = ll > 0 ? ((p.x - ax) * ex + (p.y - ay) * ey + (p.z - az) * ez) / ll : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = p.x - ax - t * ex, dy = p.y - ay - t * ey, dz = p.z - az - t * ez;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < bd) { bd = d2; bx = dx; by = dy; bz = dz; }
    }
    const dist = Math.sqrt(bd);
    if (dist >= r || dist < 1e-9) return 0;
    this.nx = bx / dist; this.ny = by / dist; this.nz = bz / dist;
    return r - dist;
  }

  /** Visit each brush whose cells the segment passes through (3D DDA), in order; stop when visit returns true. */
  walk(p: V3, d: V3, len: number, visit: (b: BrushPrim, tCell: number) => boolean | void) {
    const C = this.cell, st = this.next();
    let ix = Math.floor(p.x / C), iy = Math.floor(p.y / C), iz = Math.floor(p.z / C);
    const sx = d.x > 0 ? 1 : -1, sy = d.y > 0 ? 1 : -1, sz = d.z > 0 ? 1 : -1;
    const dx = Math.abs(d.x) > 1e-12 ? C / Math.abs(d.x) : Infinity, dy = Math.abs(d.y) > 1e-12 ? C / Math.abs(d.y) : Infinity, dz = Math.abs(d.z) > 1e-12 ? C / Math.abs(d.z) : Infinity;
    let tx = dx === Infinity ? Infinity : ((ix + (sx > 0 ? 1 : 0)) * C - p.x) / d.x;
    let ty = dy === Infinity ? Infinity : ((iy + (sy > 0 ? 1 : 0)) * C - p.y) / d.y;
    let tz = dz === Infinity ? Infinity : ((iz + (sz > 0 ? 1 : 0)) * C - p.z) / d.z;
    let t = 0;
    for (let guard = 0; guard < 4096 && t <= len; guard++) {
      const l = this.cells.get(this.key(ix, iy, iz));
      if (l) for (let n = 0; n < l.length; n++) {
        const idx = l[n];
        if (this.mark[idx] === st) continue;
        this.mark[idx] = st;
        if (visit(this.list[idx], t)) return;
      }
      if (tx <= ty && tx <= tz) { t = tx; tx += dx; ix += sx; } else if (ty <= tz) { t = ty; ty += dy; iy += sy; } else { t = tz; tz += dz; iz += sz; }
    }
  }

  /** Distance along unit dir to the first brush surface, or Infinity. */
  raycast(p: V3, dir: V3, maxDist: number): number {
    let best = Infinity;
    const seg = this.seg;
    this.walk(p, dir, maxDist, (b, tCell) => {
      if (tCell > best) return true;
      if (clipSegment(b, p, dir, Math.min(maxDist, best), seg) && seg.t0 < best) best = seg.t0;
    });
    return best;
  }

  /** True if any brush blocks the segment a -> b (used for light occlusion). */
  blocked(a: V3, b: V3): boolean {
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z, L = Math.hypot(dx, dy, dz);
    if (L < 1e-6) return false;
    const d = { x: dx / L, y: dy / L, z: dz / L }, seg = this.seg;
    let hit = false;
    this.walk(a, d, L, (br) => { if (clipSegment(br, a, d, L, seg) && seg.t1 - seg.t0 > 1e-4) return (hit = true); });
    return hit;
  }

  /** Video-link loss through walls: each brush crossed costs more the thicker it is. */
  obstructionDb(a: V3, b: V3): number {
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z, L = Math.hypot(dx, dy, dz);
    if (L < 1e-6) return 0;
    const d = { x: dx / L, y: dy / L, z: dz / L }, seg = this.seg;
    let loss = 0;
    this.walk(a, d, L, (br) => {
      if (!clipSegment(br, a, d, L, seg)) return;
      const thick = seg.t1 - seg.t0;
      if (thick > 1e-3) loss += Math.min(25, 8 + 12 * thick) + (br.mat === 'metal' ? 4 : 0);
      return loss >= 60;
    });
    return loss;
  }
}

// ---------------------------------------------------------------------------------------------
// Deterministic value noise for terrain (shared by worker and renderer so both agree exactly)

function hash2(ix: number, iy: number, seed: number): number {
  let h = (ix * 374761393 + iy * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
export function valueNoise(x: number, y: number, seed = 1): number {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy, seed), b = hash2(ix + 1, iy, seed), c = hash2(ix, iy + 1, seed), d = hash2(ix + 1, iy + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
export function fbm(x: number, y: number, oct = 4, seed = 1): number {
  let s = 0, a = 0.5, f = 1;
  for (let i = 0; i < oct; i++) { s += a * (valueNoise(x * f, y * f, seed + i) * 2 - 1); a *= 0.5; f *= 2.03; }
  return s;
}
export function seededRandom(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = Math.imul(s ^ (s >>> 15), s | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
