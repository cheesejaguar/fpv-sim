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
    const g = m.terrain(t.x, t.y), rt = t.r * 0.12;
    let low = g; // the trunk's foot reaches below the lowest ground under it
    for (let k = 0; k < 8; k++) low = Math.min(low, m.terrain(t.x + rt * Math.cos(k * 0.785), t.y + rt * Math.sin(k * 0.785)));
    out.push({ kind: 'cyl', c: { x: t.x, y: t.y, z: low - 0.2 }, r: rt, h: t.h * 0.5 + g - low, mat: 'wood' });
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
    // closed cylinder: nearest point of the solid (radial clamp, z clamp); inside: the nearest face
    const z0 = pr.c.z, z1 = pr.c.z + pr.h, dx = p.x - pr.c.x, dy = p.y - pr.c.y, rr = Math.hypot(dx, dy);
    if (rr <= pr.r && p.z >= z0 && p.z <= z1) {
      const faces = [{ e: pr.r - rr, n: [rr > 1e-9 ? dx / rr : 1, rr > 1e-9 ? dy / rr : 0, 0] }, { e: z1 - p.z, n: [0, 0, 1] }, { e: p.z - z0, n: [0, 0, -1] }];
      const f = faces.reduce((a, b) => (b.e < a.e ? b : a));
      return { depth: f.e + r, nx: f.n[0], ny: f.n[1], nz: f.n[2], material: pr.mat };
    }
    const qr = Math.min(rr, pr.r), qx = rr > 1e-12 ? (dx / rr) * qr : 0, qy = rr > 1e-12 ? (dy / rr) * qr : 0, qz = Math.max(z0, Math.min(z1, p.z));
    const ux = dx - qx, uy = dy - qy, uz = p.z - qz, d = Math.hypot(ux, uy, uz);
    if (d >= r) return null;
    return { depth: r - d, nx: ux / d, ny: uy / d, nz: uz / d, material: pr.mat };
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
      let maxErr = 0, maxNz = 0, terrainHits = 0;
      for (let i = 0; i < 300; i++) {
        const cx = (rng.next() - 0.5) * 2 * S, cy = (rng.next() - 0.5) * 2 * S, g = m.terrain(cx, cy);
        for (let j = 0; j < 40; j++) {
          const p = { x: cx + (rng.next() - 0.5) * 0.4, y: cy + (rng.next() - 0.5) * 0.4, z: g + 0.004 + rng.next() * 0.03 }, r = 0.008 + rng.next() * 0.03;
          const ref = reference(m, prims, p, r), got = query(w, p, r);
          if (ref.prim.depth > 0 || (got.depth > 0 && got.material !== m.groundMat)) continue;
          terrainHits++;
          maxErr = Math.max(maxErr, Math.abs(got.depth - ref.terrain.depth));
          if (ref.terrain.depth > 1e-3) maxNz = Math.max(maxNz, Math.abs(got.nz - ref.terrain.nz));
        }
      }
      // (worst on the hilly / baked-heightfield maps: field 3.0 mm in the country outside the bowl,
      // park 1.5 mm, mountains 1.0 mm; a tenth of a millimetre or less on the flat fields)
      expect(terrainHits).toBeGreaterThan(10_000); // of 12 000 samples: most land on bare ground
      expect(maxErr).toBeLessThan(4e-3);
      expect(maxNz).toBeLessThan(2e-2);
    }, 30000);
  }

  test('a sphere touching a cylinder from below is pushed down, not flung sideways', () => {
    // the Bando water tower's tank: a 3.2 m cylinder whose base hangs 14 m up
    const m: MapDef = { ...MAPS.field(), prims: [{ kind: 'cyl', c: { x: 0, y: 0, z: 14 }, r: 3.2, h: 6, mat: 'metal' }], trees: [], gates: [] };
    const w = new PrimitiveWorld(m), o: ContactHit = { depth: 0, nx: 0, ny: 0, nz: 0, material: MATERIALS.grass };
    expect(w.sphere({ x: 0.5, y: 0, z: 13.99 }, 0.02, o)).toBe(true);
    expect(o.depth).toBeCloseTo(0.01, 9); expect(o.nz).toBeCloseTo(-1, 9);
    expect(w.sphere({ x: 0.5, y: 0, z: 13.95 }, 0.02, o)).toBe(false);
    // the rim: diagonally out and down
    expect(w.sphere({ x: 3.21, y: 0, z: 13.99 }, 0.02, o)).toBe(true);
    expect(o.nx).toBeGreaterThan(0.5); expect(o.nz).toBeLessThan(-0.5);
  });

  test('sphereNear() inside the sphere given to near() = sphere()', () => {
    let hits = 0;
    for (const [, make] of maps) {
      const m = make(), w = new PrimitiveWorld(m), prims = solids(m), rng = new Rng(9);
      for (let i = 0; i < 400; i++) {
        const pr = prims[Math.floor(rng.next() * prims.length)], R = 0.05 + rng.next() * 0.3;
        const c = { x: pr.c.x + (rng.next() - 0.5) * 2, y: pr.c.y + (rng.next() - 0.5) * 2, z: pr.c.z + (rng.next() - 0.5) * 2 };
        w.near(c, R);
        for (let j = 0; j < 20; j++) {
          // a sphere inside (c, R)
          const r = rng.next() * R * 0.5, d = (R - r) * rng.next(), u = { x: rng.next() - 0.5, y: rng.next() - 0.5, z: rng.next() - 0.5 }, l = Math.hypot(u.x, u.y, u.z) || 1;
          const p = { x: c.x + (u.x / l) * d, y: c.y + (u.y / l) * d, z: c.z + (u.z / l) * d };
          const a = query(w, p, r), o: ContactHit = { depth: 0, nx: 0, ny: 0, nz: 0, material: MATERIALS.grass };
          const b = w.sphereNear(p, r, o) ? { depth: o.depth, nx: o.nx, ny: o.ny, nz: o.nz, material: o.material.name } : NONE;
          expect(b).toEqual(a);
          if (a.depth > 0) hits++;
        }
      }
    }
    expect(hits).toBeGreaterThan(5000);
  }, 30000);

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

describe('raycast and line of sight', () => {
  const flat = (prims: Prim[], terrain = (_x: number, _y: number) => 0): MapDef => ({ ...MAPS.field(), terrain, prims, trees: [], gates: [], wakeZones: [] });
  const X = { x: 1, y: 0, z: 0 };
  test('rays see boxes in every cell they cross, cylinders and spheres', () => {
    const box = (x: number): Prim => ({ kind: 'box', c: { x, y: 0, z: 2 }, half: { x: 0.5, y: 2, z: 2 }, yaw: 0, mat: 'concrete' });
    for (const x of [5, 12, 19]) expect(new PrimitiveWorld(flat([box(x)])).raycast({ x: 0, y: 0, z: 2 }, X, 30)).toBeCloseTo(x - 0.5, 6);
    expect(new PrimitiveWorld(flat([{ kind: 'cyl', c: { x: 5, y: 0, z: 0 }, r: 1, h: 4, mat: 'metal' }])).raycast({ x: 0, y: 0, z: 2 }, X, 20)).toBeCloseTo(4, 6);
    expect(new PrimitiveWorld(flat([{ kind: 'sphere', c: { x: 3, y: 0, z: 2 }, r: 1, mat: 'metal' }])).raycast({ x: 0, y: 0, z: 2 }, X, 20)).toBeCloseTo(2, 6);
    // a ray over the top of a pole misses it
    expect(new PrimitiveWorld(flat([{ kind: 'cyl', c: { x: 5, y: 0, z: 0 }, r: 1, h: 1.5, mat: 'metal' }])).raycast({ x: 0, y: 0, z: 2 }, X, 20)).toBe(Infinity);
  });
  test('terrain: long rays find a cliff to the centimetre, and do not skip a narrow ridge', () => {
    const cliff = new PrimitiveWorld(flat([], (x) => (x > 99 ? 50 : 0)));
    expect(cliff.raycast({ x: 0, y: 0, z: 10 }, X, 1000)).toBeCloseTo(99, 1);
    const ridge = new PrimitiveWorld(flat([], (x) => Math.max(0, 3 - Math.abs(x - 300) * 3))); // 2 m wide, 3 m high
    expect(ridge.raycast({ x: 0, y: 0, z: 2 }, X, 1000)).toBeLessThan(300);
    expect(new PrimitiveWorld(flat([])).raycast({ x: 0, y: 0, z: 10 }, { x: 0, y: 0, z: -1 }, 20)).toBeCloseTo(10, 9);
  });
  test('a thin wall blocks the line of sight at any range; a hill costs the same on a short or a long link', () => {
    const wall: Prim = { kind: 'box', c: { x: 50, y: 0, z: 5 }, half: { x: 0.15, y: 20, z: 5 }, yaw: 0, mat: 'concrete' };
    const w = new PrimitiveWorld(flat([wall]));
    for (const L of [60, 100, 121, 800, 1500]) expect(w.losLoss({ x: 0, y: 0, z: 2 }, { x: L, y: 0, z: 2 }).hardDb, `link ${L} m`).toBeGreaterThan(5);
    const hill = (x: number) => Math.max(0, 12 - Math.abs(x - 50) * 0.8); // a 30 m wide, 12 m high hill 50 m out
    const h = new PrimitiveWorld(flat([], hill)), loss = (L: number) => h.obstructionDb({ x: 0, y: 0, z: 2 }, { x: L, y: 0, z: 2 });
    expect(loss(100)).toBeGreaterThan(20);
    expect(Math.abs(loss(1000) - loss(100))).toBeLessThan(10); // (was 24 dB at 100 m, 2.4 dB at 1 km)
    // clear line, but grazing a ridge: some loss, not counted as blocked
    const graze = new PrimitiveWorld(flat([], (x) => (Math.abs(x - 50) < 1 ? 1.9 : 0))).losLoss({ x: 0, y: 0, z: 2 }, { x: 100, y: 0, z: 2 });
    expect(graze.db).toBeGreaterThan(2); expect(graze.hardDb).toBe(0);
    // foliage: by the length of path through the canopies
    const canopy = (x: number): Prim => ({ kind: 'sphere', c: { x, y: 0, z: 5 }, r: 3, mat: 'foliage' });
    const f = new PrimitiveWorld(flat([canopy(20), canopy(40)])).losLoss({ x: 0, y: 0, z: 5 }, { x: 60, y: 0, z: 5 });
    expect(f.foliageDb).toBeCloseTo(0.8 * 12, 6); expect(f.hardDb).toBe(0);
  });
});


describe('creased terrain', () => {
  test('a heightfield crease: a sphere beside it meets the surface, not a tangent plane taken at the crease', () => {
    // a V valley along x = 0, slope 3 (a bilinear heightfield creases like this at every cell edge)
    const m: MapDef = { ...MAPS.field(), terrain: (x: number) => 3 * Math.abs(x), terrainRes: 1, prims: [], trees: [], gates: [], wakeZones: [] };
    const w = new PrimitiveWorld(m), hit: ContactHit = { depth: 0, nx: 0, ny: 0, nz: 1, material: MATERIALS.grass };
    w.sphere({ x: 0, y: 0, z: 0.05 }, 0.1, hit); // takes the terrain plane at the crease (flat: h = 0)
    // 12 cm up the slope (the plane is reused within 15 cm) the ground is 36 cm up: 5 cm into it
    expect(w.sphere({ x: 0.12, y: 0, z: 0.41 }, 0.1, hit)).toBe(true);
    expect(hit.depth).toBeGreaterThan(0.03);
  });
});
