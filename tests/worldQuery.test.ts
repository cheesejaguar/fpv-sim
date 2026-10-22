// PrimitiveWorld.sphere() (packed per-cell records, bounding-radius rejection, shared terrain
// planes) against a straightforward reference: every solid prim of the map tested one by one with
// the plain geometry, the terrain evaluated exactly at the sphere.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { bandoMap, MAPS, provideMapSource } from '../src/maps/maps';
import { BrushGrid, MapDef, Prim, PrimitiveWorld, spawnGroundZ } from '../src/maps/world';
import { ContactHit, MATERIALS } from '../src/sim/contact';
import { Rng, V3 } from '../src/sim/math';

type Hit = { depth: number; nx: number; ny: number; nz: number; material: string };
const NONE: Hit = { depth: 0, nx: 0, ny: 0, nz: 0, material: '' };

/** The solid prims PrimitiveWorld collides with: map prims except foliage volumes, plus tree trunks / cores. */
function solids(m: MapDef): Prim[] {
  const out = m.prims.filter((p) => !(p.mat === 'foliage' && (p.kind === 'sphere' || (p.kind === 'box' && Math.min(p.half.x, p.half.y, p.half.z) > 0.25))));
  for (const t of m.trees) {
    const g = m.terrain(t.x, t.y);
    out.push({ kind: 'cyl', c: { x: t.x, y: t.y, z: g - 0.2 }, r: t.r * 0.12, h: t.h * 0.5, mat: 'wood' });
    out.push({ kind: 'sphere', c: { x: t.x, y: t.y, z: g + t.h * 0.62 }, r: t.r * 0.3, mat: 'wood' });
  }
  return out.filter((p) => p.kind !== 'brush');
}

/** Deepest penetration of the sphere (p, r) into one prim, or null. */
function primHit(pr: Prim, p: V3, r: number): Hit | null {
  if (pr.kind === 'box') {
    const c = Math.cos(pr.yaw), s = Math.sin(pr.yaw), cp = Math.cos(pr.pitch ?? 0), sp = Math.sin(pr.pitch ?? 0);
    const dx = p.x - pr.c.x, dy = p.y - pr.c.y, dz = p.z - pr.c.z;
    const yx = c * dx + s * dy, ly = -s * dx + c * dy;
    const lx = cp * yx - sp * dz, lz = sp * yx + cp * dz; // yaw about z, then pitch about local y
    const h = pr.half;
    const qx = Math.max(-h.x, Math.min(h.x, lx)), qy = Math.max(-h.y, Math.min(h.y, ly)), qz = Math.max(-h.z, Math.min(h.z, lz));
    let nx = lx - qx, ny = ly - qy, nz = lz - qz, depth: number;
    const dist = Math.hypot(nx, ny, nz);
    if (dist > 1e-9) {
      if (dist >= r) return null;
      depth = r - dist; nx /= dist; ny /= dist; nz /= dist;
    } else {
      const ex = h.x - Math.abs(lx), ey = h.y - Math.abs(ly), ez = h.z - Math.abs(lz);
      if (ex < ey && ex < ez) { nx = Math.sign(lx) || 1; ny = 0; nz = 0; depth = ex + r; }
      else if (ey < ez) { nx = 0; ny = Math.sign(ly) || 1; nz = 0; depth = ey + r; }
      else { nx = 0; ny = 0; nz = Math.sign(lz) || 1; depth = ez + r; }
    }
    const wx0 = cp * nx + sp * nz;
    return { depth, nx: c * wx0 - s * ny, ny: s * wx0 + c * ny, nz: -sp * nx + cp * nz, material: pr.mat };
  }
  if (pr.kind === 'cyl') {
    const top = pr.c.z + pr.h;
    if (p.z < pr.c.z - r || p.z > top + r) return null;
    const dx = p.x - pr.c.x, dy = p.y - pr.c.y, rr = Math.hypot(dx, dy), side = pr.r + r - rr;
    if (side <= 0) return null;
    const dTop = top + r - p.z;
    if (dTop < side && p.z > top) return rr < pr.r ? { depth: dTop, nx: 0, ny: 0, nz: 1, material: pr.mat } : null;
    return { depth: side, nx: dx / (rr || 1), ny: dy / (rr || 1), nz: 0, material: pr.mat };
  }
  if (pr.kind === 'sphere') {
    const dx = p.x - pr.c.x, dy = p.y - pr.c.y, dz = p.z - pr.c.z, d = Math.hypot(dx, dy, dz);
    return d > 1e-6 && pr.r + r - d > 0 ? { depth: pr.r + r - d, nx: dx / d, ny: dy / d, nz: dz / d, material: pr.mat } : null;
  }
  return null;
}

/** Reference: deepest prim hit (prims in map order; ties keep the first) and the exact terrain hit. */
function reference(m: MapDef, prims: Prim[], p: V3, r: number): { prim: Hit; terrain: Hit } {
  let prim = NONE;
  for (const pr of prims) { const h = primHit(pr, p, r); if (h && h.depth > prim.depth) prim = h; }
  const t = m.terrain, e = 0.05, h = t(p.x, p.y);
  const gx = (t(p.x + e, p.y) - t(p.x - e, p.y)) / (2 * e), gy = (t(p.x, p.y + e) - t(p.x, p.y - e)) / (2 * e), nl = Math.hypot(gx, gy, 1);
  const depth = p.z - r < h + 0.5 ? r - (p.z - h) / nl : 0;
  return { prim, terrain: depth > 0 ? { depth, nx: -gx / nl, ny: -gy / nl, nz: 1 / nl, material: m.groundMat } : NONE };
}

const query = (w: PrimitiveWorld, p: V3, r: number): Hit => {
  const o: ContactHit = { depth: 0, nx: 0, ny: 0, nz: 0, material: MATERIALS.grass };
  return w.sphere(p, r, o) ? { depth: o.depth, nx: o.nx, ny: o.ny, nz: o.nz, material: o.material.name } : NONE;
};

const maps: [string, () => MapDef][] = [
  ['field', () => MAPS.field()], ['gym', () => MAPS.gym()], ['park', () => MAPS.park()], ['practice', () => MAPS.practice()],
  ['night', () => MAPS.night()], ['mountains', () => MAPS.mountains()], ['bando', bandoMap],
];

describe('PrimitiveWorld.sphere matches a brute-force reference', () => {
  for (const [id, make] of maps) {
    test(id, () => {
      const m = make(), w = new PrimitiveWorld(m), prims = solids(m), rng = new Rng(17);
      // a fresh world has no terrain plane yet (not even at the origin)
      const g0 = m.terrain(0, 0);
      expect(query(w, { x: 0, y: 0, z: g0 + 0.3 }, 0.1).depth).toBeCloseTo(reference(m, prims, { x: 0, y: 0, z: g0 + 0.3 }, 0.1).prim.depth, 9);
      // prim contacts: random spheres around random prims, high above the ground
      let primHits = 0;
      for (let i = 0; i < 3000; i++) {
        const pr = prims[Math.floor(rng.next() * prims.length)];
        const p = { x: pr.c.x + (rng.next() - 0.5) * 3, y: pr.c.y + (rng.next() - 0.5) * 3, z: pr.c.z + (rng.next() - 0.5) * 3 };
        const r = 0.005 + rng.next() * 0.3;
        const ref = reference(m, prims, p, r), got = query(w, p, r);
        if (ref.terrain.depth > 0 || got.material === m.groundMat && ref.prim.depth === 0) continue; // terrain cases below
        if (ref.prim.depth > 0) primHits++;
        expect(Math.abs(got.depth - ref.prim.depth)).toBeLessThan(1e-9);
        if (ref.prim.depth > 0) {
          expect(Math.max(Math.abs(got.nx - ref.prim.nx), Math.abs(got.ny - ref.prim.ny), Math.abs(got.nz - ref.prim.nz))).toBeLessThan(1e-9);
          expect(got.material).toBe(ref.prim.material);
        }
      }
      expect(primHits).toBeGreaterThan(300);
      // terrain contacts: a quad-sized cluster of spheres resting on the ground (they share the
      // terrain planes) at random spots; the plane is the exact terrain where it was taken
      const S = m.size * 0.8;
      let maxErr = 0, maxNz = 0;
      for (let i = 0; i < 300; i++) {
        const cx = (rng.next() - 0.5) * 2 * S, cy = (rng.next() - 0.5) * 2 * S, g = m.terrain(cx, cy);
        for (let j = 0; j < 40; j++) {
          const p = { x: cx + (rng.next() - 0.5) * 0.4, y: cy + (rng.next() - 0.5) * 0.4, z: g + 0.004 + rng.next() * 0.03 }, r = 0.008 + rng.next() * 0.03;
          const ref = reference(m, prims, p, r), got = query(w, p, r);
          if (ref.prim.depth > 0 || (got.depth > 0 && got.material !== m.groundMat)) continue;
          maxErr = Math.max(maxErr, Math.abs(got.depth - ref.terrain.depth));
          if (ref.terrain.depth > 1e-3) maxNz = Math.max(maxNz, Math.abs(got.nz - ref.terrain.nz));
        }
      }
      // (worst on the hilly / baked-heightfield maps: field 3.0 mm in the country outside the bowl,
      // park 1.5 mm, mountains 1.0 mm; a tenth of a millimetre or less on the flat fields)
      expect(maxErr).toBeLessThan(4e-3);
      expect(maxNz).toBeLessThan(2e-2);
    }, 30000);
  }

  test('brush grid (quake-dm3) agrees with a single-cell brush list', () => {
    provideMapSource('quake-dm3', readFileSync(new URL('../public/maps/quake/dm3.map', import.meta.url), 'latin1'));
    const m = MAPS['quake-dm3'](), w = new PrimitiveWorld(m), all = new BrushGrid(1e6), rng = new Rng(3);
    for (const b of w.brushes.list) all.insert(b);
    let hits = 0;
    for (let i = 0; i < 20000; i++) {
      const b = w.brushes.list[Math.floor(rng.next() * w.brushes.list.length)];
      const p = { x: b.min.x + (b.max.x - b.min.x) * (rng.next() * 1.4 - 0.2), y: b.min.y + (b.max.y - b.min.y) * (rng.next() * 1.4 - 0.2), z: b.min.z + (b.max.z - b.min.z) * (rng.next() * 1.4 - 0.2) };
      const r = 0.01 + rng.next() * 0.3;
      const o1: ContactHit = { depth: 0, nx: 0, ny: 0, nz: 0, material: MATERIALS.grass }, o2 = { ...o1 };
      const d1 = w.brushes.sphere(p, r, o1, 0), d2 = all.sphere(p, r, o2, 0);
      expect(d1).toBe(d2);
      if (d1 > 0) { hits++; expect([o1.nx, o1.ny, o1.nz]).toEqual([o2.nx, o2.ny, o2.nz]); }
    }
    expect(hits).toBeGreaterThan(2000);
  }, 30000);

  test('a vertical raycast sees the terrain right under it', () => {
    const m: MapDef = { ...MAPS.field(), prims: [], trees: [] }, w = new PrimitiveWorld(m), rng = new Rng(5);
    for (let i = 0; i < 200; i++) {
      const x = (rng.next() - 0.5) * 300, y = (rng.next() - 0.5) * 300, g = m.terrain(x, y), z = g + 0.2 + rng.next() * 30;
      const t = w.raycast({ x, y, z }, { x: 0, y: 0, z: -1 }, z - g + 0.5);
      expect(t).toBeGreaterThanOrEqual(z - g - 1e-9);
      expect(t).toBeLessThan(z - g + Math.max(0.05, (z - g + 0.5) / 400) + 1e-9);
    }
    // with the stadium's boxes: the spawn pad below
    const f = MAPS.field(), sp = f.spawn.pos;
    expect(new PrimitiveWorld(f).raycast({ x: sp.x, y: sp.y, z: spawnGroundZ(f) + 2 }, { x: 0, y: 0, z: -1 }, 3)).toBeLessThan(2.06);
  });
});
