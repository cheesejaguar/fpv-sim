// The Grand Prix stadium course: every gate counts in order along a clean racing line that never
// touches an obstacle, openings keep the FAI free space, and pass detection for every gate kind.
import { describe, expect, test } from 'vitest';
import { gatePassed, inOpening, openingCentre } from '../src/maps/gates';
import { MAP_LIST, MAPS } from '../src/maps/maps';
import { BoxPrim, GateDef, MapDef, PrimitiveWorld, spawnGroundZ } from '../src/maps/world';
import { WORLD_CUP_LINE } from '../src/maps/worldCup';
import { ContactHit, MATERIALS } from '../src/sim/contact';
import type { V3 } from '../src/sim/math';
import * as THREE from 'three';
import { primMatrix } from '../src/render/scene';

const map = MAPS.field();
const world = new PrimitiveWorld(map);
const hit: ContactHit = { depth: 0, nx: 0, ny: 0, nz: 0, material: MATERIALS.grass };

/** Closed Catmull-Rom spline through the racing line (from just before the start gate), sampled every ~2 cm. */
function racingLine(laps: number): V3[] {
  const P = WORLD_CUP_LINE, n = P.length, out: V3[] = [];
  for (let j = 0; j < laps * n; j++) {
    const i = (j + n - 1) % n;
    const p0 = P[(i - 1 + n) % n], p1 = P[i], p2 = P[(i + 1) % n], p3 = P[(i + 2) % n];
    const steps = Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]) / 0.02);
    for (let k = 0; k < steps; k++) {
      const t = k / steps, t2 = t * t, t3 = t2 * t;
      const f = (j: number) => 0.5 * (2 * p1[j] + (-p0[j] + p2[j]) * t + (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * t2 + (-p0[j] + 3 * p1[j] - 3 * p2[j] + p3[j]) * t3);
      out.push({ x: f(0), y: f(1), z: f(2) });
    }
  }
  return out;
}

describe('FPV Grand Prix Stadium course', () => {
  test('is named FPV Grand Prix Stadium (no "World Cup": that echoes the FAI Drone Racing World Cup)', () => {
    expect(map.name).toBe('FPV Grand Prix Stadium');
    expect(MAP_LIST.field.name).toBe(map.name);
    const texts = [...map.prims, ...(map.decor ?? [])].map((p) => (p.kind === 'box' ? p.text ?? '' : '')).join(' ');
    expect(texts).not.toMatch(/world\s*cup/i);
    expect(texts).toMatch(/GRAND PRIX/);
  });

  test('is a championship-sized course of mixed gate kinds', () => {
    const kinds = new Set(map.gates.map((g) => g.kind));
    for (const k of ['square', 'arch', 'flag', 'dive', 'hurdle', 'ladder'] as const) expect(kinds.has(k)).toBe(true);
    expect(map.gates.length).toBeGreaterThanOrEqual(12);
    map.gates.forEach((g, i) => expect(g.id).toBe(i));
    // bigger than the 7'x6' MultiGP championship gate, and well above the FAI 1.5 m free space
    for (const g of map.gates) if (g.kind !== 'flag') expect(Math.min(g.width, g.height)).toBeGreaterThanOrEqual(1.8);
    const line = racingLine(1);
    let len = 0;
    for (let i = 1; i < line.length; i++) len += Math.hypot(line[i].x - line[i - 1].x, line[i].y - line[i - 1].y, line[i].z - line[i - 1].z);
    expect(len).toBeGreaterThan(250);  // FAI minimum race length is 250 m: one lap already is
    expect(len / 12).toBeGreaterThan(20); // ~12 m/s average for a good pilot: 20-30 s laps
    expect(len / 12).toBeLessThan(32);
  });

  test('the racing line clears every obstacle and counts all gates in order, lap after lap', () => {
    const line = racingLine(2);
    let next = 0;
    const events: number[] = [];
    let worst = Infinity, where: V3 | null = null;
    for (let i = 1; i < line.length; i++) {
      const p = line[i];
      if (world.sphere(p, 0.15, hit) && p.z > 0.3) { worst = Math.min(worst, -hit.depth); where ??= p; }
      const g = map.gates[next % map.gates.length];
      if (gatePassed(g, line[i - 1], p)) { events.push(g.id); next++; }
    }
    expect(where, `racing line touches an obstacle at ${JSON.stringify(where)}`).toBeNull();
    const n = map.gates.length;
    expect(events).toEqual([...Array(2 * n).keys()].map((k) => k % n));
  });

  test('gate openings keep the FAI 1.5 m free space clear of all structure', () => {
    for (const g of map.gates) {
      if (g.kind === 'flag') continue;
      const c = openingCentre(g);
      // sphere of 1.5 m diameter centred in the opening touches nothing
      expect(world.sphere(c, 0.75, hit), `gate ${g.id} (${g.kind}) opening obstructed`).toBe(false);
      // ...while the frame itself is solid (sanity check of the probe): just inside the right post / rim
      const edge = g.kind === 'dive'
        ? { x: c.x + Math.cos(g.yaw) * (g.width / 2 + 0.06), y: c.y + Math.sin(g.yaw) * (g.width / 2 + 0.06), z: c.z }
        : { x: c.x + Math.cos(g.yaw) * (g.width / 2 + 0.06), y: c.y + Math.sin(g.yaw) * (g.width / 2 + 0.06), z: g.c.z + 0.3 };
      expect(world.sphere(edge, 0.05, hit), `gate ${g.id} (${g.kind}) frame missing`).toBe(true);
    }
  });

  test('flags leave room to turn round them and consecutive gates are spread out', () => {
    const line = racingLine(1);
    for (const g of map.gates.filter((x) => x.kind === 'flag')) {
      const d = Math.min(...line.map((p) => Math.hypot(p.x - g.c.x, p.y - g.c.y)));
      expect(d).toBeGreaterThan(1.25); // FAI: 2.5 m free space around obstacles to avoid
      expect(d).toBeLessThan(6);       // ...but close enough to count
    }
    for (let i = 0; i < map.gates.length; i++) {
      const a = map.gates[i], b = map.gates[(i + 1) % map.gates.length];
      const d = Math.hypot(a.c.x - b.c.x, a.c.y - b.c.y);
      if (d > 0.01) expect(d).toBeGreaterThan(10); // split-S passes share one stack
    }
  });

  test('spawns on a start pad behind the start gate with a clear run to it', () => {
    const s = map.spawn.pos, g0 = map.gates[0];
    expect(spawnGroundZ(map)).toBeCloseTo(0, 1);
    expect(Math.hypot(s.x - g0.c.x, s.y - g0.c.y)).toBeLessThan(12);
    for (let t = 0; t <= 1; t += 0.01) {
      const p = { x: s.x + (g0.c.x - s.x) * t, y: s.y + (g0.c.y - s.y) * t, z: 1 };
      expect(world.sphere(p, 0.15, hit)).toBe(false);
    }
  });
});

describe('gate pass detection', () => {
  const base = { id: 0, yaw: 0, c: { x: 0, y: 0, z: 0 } };
  const cross = (g: GateDef, x: number, z: number, dir = 1) => gatePassed(g, { x, y: -0.5 * dir, z }, { x, y: 0.5 * dir, z });

  test('square / tower', () => {
    const g: GateDef = { ...base, kind: 'square', width: 2.3, height: 2, c: { x: 0, y: 0, z: 2 } };
    expect(cross(g, 0, 3)).toBe(true);
    expect(cross(g, 0, 3, -1)).toBe(false); // backwards
    expect(cross(g, 1.3, 3)).toBe(false);   // beside the post
    expect(cross(g, 0, 1.5)).toBe(false);   // under the tower
    expect(cross(g, 0, 4.2)).toBe(false);   // over the top
  });

  test('yawed gates detect along their own travel direction', () => {
    const g: GateDef = { ...base, kind: 'square', width: 2.3, height: 2, yaw: Math.PI / 2 }; // travel -x
    expect(gatePassed(g, { x: 0.5, y: 0, z: 1 }, { x: -0.5, y: 0, z: 1 })).toBe(true);
    expect(gatePassed(g, { x: -0.5, y: 0, z: 1 }, { x: 0.5, y: 0, z: 1 })).toBe(false);
  });

  test('arch: round head', () => {
    const g: GateDef = { ...base, kind: 'arch', width: 3.2, height: 3 };
    expect(cross(g, 0, 2.9)).toBe(true);     // crown
    expect(cross(g, 1.5, 1.0)).toBe(true);   // beside the post, below the springing line
    expect(cross(g, 1.5, 2.8)).toBe(false);  // the square corner the arch cuts off
    expect(inOpening(g, 1.5, 2.8)).toBe(false);
  });

  test('hurdle: under the banner only', () => {
    const g: GateDef = { ...base, kind: 'hurdle', width: 3.6, height: 1.8 };
    expect(cross(g, 1.6, 0.5)).toBe(true);
    expect(cross(g, 0, 2.2)).toBe(false);
  });

  test('ladder: only the top opening counts', () => {
    const g: GateDef = { ...base, kind: 'ladder', width: 2.3, height: 2, stack: 3, c: { x: 0, y: 0, z: 4.24 } };
    expect(cross(g, 0, 5.2)).toBe(true);
    expect(cross(g, 0, 1.0)).toBe(false);
    expect(cross(g, 0, 3.1)).toBe(false);
  });

  test('dive: downwards through the frame', () => {
    const g: GateDef = { ...base, kind: 'dive', width: 2.4, height: 2.4, c: { x: 0, y: 0, z: 4.6 } };
    expect(gatePassed(g, { x: 0.2, y: 0.3, z: 5 }, { x: 0.3, y: 0.6, z: 4.2 })).toBe(true);
    expect(gatePassed(g, { x: 0, y: 0, z: 4.2 }, { x: 0, y: 0, z: 5 })).toBe(false); // upwards
    expect(gatePassed(g, { x: 1.4, y: 0, z: 5 }, { x: 1.4, y: 0, z: 4.2 })).toBe(false); // outside
  });

  test('flag: round it, close by', () => {
    const g: GateDef = { ...base, kind: 'flag', width: 0.6, height: 3.6 };
    expect(cross(g, 3, 1)).toBe(true);
    expect(cross(g, -2, 2)).toBe(true);
    expect(cross(g, 8, 1)).toBe(false);
    expect(cross(g, 3, 1, -1)).toBe(false);
  });
});

test('rendered gate boxes (incl. the pitched arch head) sit exactly where they collide', () => {
  const boxes = map.prims.filter((p): p is BoxPrim => p.kind === 'box' && /^gate\d+$/.test(p.tag ?? ''));
  expect(boxes.some((b) => b.pitch)).toBe(true);
  const m4 = new THREE.Matrix4(), v = new THREE.Vector3();
  for (const b of boxes) {
    const solo = new PrimitiveWorld({ ...map, prims: [b], trees: [], terrain: () => -100 } as MapDef);
    primMatrix(b, m4);
    for (const [sx, sy, sz] of [[1, 1, 1], [-1, 1, -1], [1, -1, -1], [-1, -1, 1]]) {
      for (const k of [0.9, 1.15]) {
        // box geometry local axes in three: (x, z, -y) of the collision box frame
        v.set(sx * b.half.x * k, sz * b.half.z * k, -sy * b.half.y * k).applyMatrix4(m4);
        const enu = { x: v.x, y: -v.z, z: v.y };
        expect(solo.sphere(enu, 1e-4, hit), `${b.tag} corner ${sx},${sy},${sz} x${k}`).toBe(k < 1);
      }
    }
  }
});
