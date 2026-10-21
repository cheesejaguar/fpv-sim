// Map description shared by the physics worker (collision) and the renderer (geometry).
// Everything is analytic primitives (incl. convex brushes from Quake maps) + a heightfield, so
// collision is exact and needs no meshes.
// Coordinates: ENU metres (x east, y north, z up).
import { CollisionWorld, ContactHit, MATERIALS, SurfaceMaterial } from '../sim/contact';
import { V3 } from '../sim/math';
import type { WakeZone } from '../sim/wind';
import type { QuakeLevel } from './quakeMap';

export type Material = keyof typeof MATERIALS;

export interface BoxPrim { kind: 'box'; c: V3; half: V3; yaw: number; pitch?: number; mat: Material; color?: number; tag?: string; visual?: 'concrete' | 'brick' | 'metal' | 'wood' | 'gate' | 'pad' | 'glass' | 'plain' | BoxDecor; text?: string }
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
}

export interface MapDef {
  id: string; name: string;
  size: number;                       // half-extent of playable area (m)
  terrain: (x: number, y: number) => number;
  groundMat: Material;
  prims: Prim[];
  gates: GateDef[];
  spawn: { pos: V3; yaw: number; groundZ?: number }; // groundZ: floor height at spawn (default: terrain)
  sun: { azimuthDeg: number; elevationDeg: number };
  sky: 'clear' | 'overcast' | 'dusk';
  wakeZones: WakeZone[];
  elevationM: number;
  trees: { x: number; y: number; h: number; r: number; type: 'pine' | 'oak' }[];
  ground?: boolean;                   // render the terrain mesh (default true)
  pilot?: V3;                         // pilot / video receiver position (default: beside the spawn)
  windScale?: number;                 // indoor maps: scale the configured wind
  quake?: QuakeLevel;                 // render data for maps loaded from Quake .map sources
  decor?: Prim[];                     // render-only scenery (crowds, screens, LED strips): no collision
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

export class PrimitiveWorld implements CollisionWorld {
  private cell = 8;
  private grid = new Map<number, Prim[]>();
  private boxRot = new Map<BoxPrim, { c: number; s: number; cp: number; sp: number }>();
  readonly brushes = new BrushGrid();
  constructor(public map: MapDef) {
    for (const p of map.prims) this.insert(p);
    for (const t of map.trees) {
      this.insert({ kind: 'cyl', c: { x: t.x, y: t.y, z: map.terrain(t.x, t.y) - 0.2 }, r: t.r * 0.12, h: t.h * 0.5, mat: 'wood' });
      this.insert({ kind: 'sphere', c: { x: t.x, y: t.y, z: map.terrain(t.x, t.y) + t.h * 0.62 }, r: t.r, mat: 'foliage' });
    }
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

  sphere(p: V3, radius: number, out: ContactHit): boolean {
    let best = 0;
    // terrain: approximate surface by tangent plane under the sphere
    const h = this.map.terrain(p.x, p.y);
    if (p.z - radius < h + 0.5) {
      const e = 0.05;
      const gx = (this.map.terrain(p.x + e, p.y) - this.map.terrain(p.x - e, p.y)) / (2 * e);
      const gy = (this.map.terrain(p.x, p.y + e) - this.map.terrain(p.x, p.y - e)) / (2 * e);
      const nl = Math.hypot(gx, gy, 1);
      const nx = -gx / nl, ny = -gy / nl, nz = 1 / nl;
      const d = radius - (p.z - h) * nz;
      if (d > best) { best = d; out.depth = d; out.nx = nx; out.ny = ny; out.nz = nz; out.material = MATERIALS[this.map.groundMat]; }
    }
    const l = this.grid.get(this.key(Math.floor(p.x / this.cell), Math.floor(p.y / this.cell)));
    if (l) for (const pr of l) {
      if (pr.kind === 'box') {
        const rot = this.boxRot.get(pr)!;
        // into box frame: yaw about z then pitch about local y
        let dx = p.x - pr.c.x, dy = p.y - pr.c.y, dz = p.z - pr.c.z;
        let lx = rot.c * dx + rot.s * dy, ly = -rot.s * dx + rot.c * dy, lz = dz;
        const tx = rot.cp * lx - rot.sp * lz; lz = rot.sp * lx + rot.cp * lz; lx = tx;
        const hx = pr.half.x, hy = pr.half.y, hz = pr.half.z;
        const qx = Math.max(-hx, Math.min(hx, lx)), qy = Math.max(-hy, Math.min(hy, ly)), qz = Math.max(-hz, Math.min(hz, lz));
        let nx = lx - qx, ny = ly - qy, nz = lz - qz;
        let dist = Math.hypot(nx, ny, nz), depth: number;
        if (dist > 1e-9) {
          if (dist >= radius) continue;
          depth = radius - dist; nx /= dist; ny /= dist; nz /= dist;
        } else {
          // centre inside: push out along the axis of least penetration
          const px = hx - Math.abs(lx), py = hy - Math.abs(ly), pz = hz - Math.abs(lz);
          if (px < py && px < pz) { nx = Math.sign(lx) || 1; ny = 0; nz = 0; depth = px + radius; }
          else if (py < pz) { nx = 0; ny = Math.sign(ly) || 1; nz = 0; depth = py + radius; }
          else { nx = 0; ny = 0; nz = Math.sign(lz) || 1; depth = pz + radius; }
        }
        if (depth > best) {
          // back to world: inverse pitch then inverse yaw
          const wx0 = rot.cp * nx + rot.sp * nz, wz = -rot.sp * nx + rot.cp * nz;
          const wx = rot.c * wx0 - rot.s * ny, wy = rot.s * wx0 + rot.c * ny;
          best = depth; out.depth = depth; out.nx = wx; out.ny = wy; out.nz = wz; out.material = MATERIALS[pr.mat];
        }
      } else if (pr.kind === 'cyl') {
        if (p.z < pr.c.z - radius || p.z > pr.c.z + pr.h + radius) continue;
        const dx = p.x - pr.c.x, dy = p.y - pr.c.y;
        const rr = Math.hypot(dx, dy);
        const side = pr.r + radius - rr;
        if (side <= 0) continue;
        const top = pr.c.z + pr.h + radius - p.z;
        if (top < side && p.z > pr.c.z + pr.h) {
          if (top > best && rr < pr.r) { best = top; out.depth = top; out.nx = 0; out.ny = 0; out.nz = 1; out.material = MATERIALS[pr.mat]; }
        } else if (side > best) {
          best = side; out.depth = side; out.nx = dx / (rr || 1); out.ny = dy / (rr || 1); out.nz = 0; out.material = MATERIALS[pr.mat];
        }
      } else if (pr.kind === 'sphere') {
        const dx = p.x - pr.c.x, dy = p.y - pr.c.y, dz = p.z - pr.c.z;
        const d = Math.hypot(dx, dy, dz);
        const depth = pr.r + radius - d;
        if (depth > best && d > 1e-6) { best = depth; out.depth = depth; out.nx = dx / d; out.ny = dy / d; out.nz = dz / d; out.material = MATERIALS[pr.mat]; }
      }
    }
    if (this.brushes.count) best = this.brushes.sphere(p, radius, out, best);
    return best > 0;
  }

  raycast(p: V3, dir: V3, maxDist: number): number {
    let best = Infinity;
    // terrain by marching (short rays only: ground effect / LOS)
    const steps = Math.ceil(maxDist / 0.05);
    for (let i = 1; i <= Math.min(steps, 400); i++) {
      const t = (i / Math.min(steps, 400)) * maxDist;
      const x = p.x + dir.x * t, y = p.y + dir.y * t, z = p.z + dir.z * t;
      if (z <= this.map.terrain(x, y)) { best = t; break; }
    }
    // boxes in the start cell and end cell
    const cells = new Set<number>();
    cells.add(this.key(Math.floor(p.x / this.cell), Math.floor(p.y / this.cell)));
    cells.add(this.key(Math.floor((p.x + dir.x * maxDist) / this.cell), Math.floor((p.y + dir.y * maxDist) / this.cell)));
    for (const k of cells) {
      const l = this.grid.get(k); if (!l) continue;
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
      const l = this.grid.get(this.key(Math.floor(x / this.cell), Math.floor(y / this.cell)));
      if (!l) continue;
      for (const pr of l) {
        if (seen.has(pr)) continue;
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
  private key(ix: number, iy: number, iz: number) { return ((ix + 1024) * 2048 + (iy + 1024)) * 2048 + (iz + 1024); }
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
