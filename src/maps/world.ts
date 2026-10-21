// Map description shared by the physics worker (collision) and the renderer (geometry).
// Everything is analytic primitives + a heightfield, so collision is exact and needs no meshes.
// Coordinates: ENU metres (x east, y north, z up).
import { CollisionWorld, ContactHit, MATERIALS, SurfaceMaterial } from '../sim/contact';
import { V3 } from '../sim/math';
import type { WakeZone } from '../sim/wind';

export type Material = keyof typeof MATERIALS;

export interface BoxPrim { kind: 'box'; c: V3; half: V3; yaw: number; pitch?: number; mat: Material; color?: number; tag?: string; visual?: 'concrete' | 'brick' | 'metal' | 'wood' | 'gate' | 'pad' | 'glass' | 'plain' }
export interface CylPrim { kind: 'cyl'; c: V3; r: number; h: number; mat: Material; color?: number; tag?: string } // c = base centre, vertical
export interface SpherePrim { kind: 'sphere'; c: V3; r: number; mat: Material; color?: number; tag?: string }
export type Prim = BoxPrim | CylPrim | SpherePrim;

export interface GateDef { id: number; c: V3; yaw: number; width: number; height: number; kind: 'square' | 'arch' | 'flag' | 'dive' }

export interface MapDef {
  id: string; name: string;
  size: number;                       // half-extent of playable area (m)
  terrain: (x: number, y: number) => number;
  groundMat: Material;
  prims: Prim[];
  gates: GateDef[];
  spawn: { pos: V3; yaw: number };
  sun: { azimuthDeg: number; elevationDeg: number };
  sky: 'clear' | 'overcast' | 'dusk';
  wakeZones: WakeZone[];
  elevationM: number;
  trees: { x: number; y: number; h: number; r: number; type: 'pine' | 'oak' }[];
}

// ---------------------------------------------------------------------------------------------

export class PrimitiveWorld implements CollisionWorld {
  private cell = 8;
  private grid = new Map<number, Prim[]>();
  private boxRot = new Map<BoxPrim, { c: number; s: number; cp: number; sp: number }>();
  constructor(public map: MapDef) {
    for (const p of map.prims) this.insert(p);
    for (const t of map.trees) {
      this.insert({ kind: 'cyl', c: { x: t.x, y: t.y, z: map.terrain(t.x, t.y) - 0.2 }, r: t.r * 0.12, h: t.h * 0.5, mat: 'wood' });
      this.insert({ kind: 'sphere', c: { x: t.x, y: t.y, z: map.terrain(t.x, t.y) + t.h * 0.62 }, r: t.r, mat: 'foliage' });
    }
  }
  private key(ix: number, iy: number) { return (ix + 4096) * 8192 + (iy + 4096); }
  private insert(p: Prim) {
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
      } else {
        const dx = p.x - pr.c.x, dy = p.y - pr.c.y, dz = p.z - pr.c.z;
        const d = Math.hypot(dx, dy, dz);
        const depth = pr.r + radius - d;
        if (depth > best && d > 1e-6) { best = depth; out.depth = depth; out.nx = dx / d; out.ny = dy / d; out.nz = dz / d; out.material = MATERIALS[pr.mat]; }
      }
    }
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
    return Math.hypot(x - pr.c.x, y - pr.c.y, z - pr.c.z) <= pr.r;
  }

  material(name: Material): SurfaceMaterial { return MATERIALS[name]; }
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
