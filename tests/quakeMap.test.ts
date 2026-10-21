// Quake .map loader + convex brush collision: geometry sanity, spawn on the floor, exact contacts,
// no tunnelling through walls at 30 m/s, and video-link obstruction through walls.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { buildDrone, DEFAULT_SPEC } from '../src/builder/derive';
import { MAPS, provideMapSource } from '../src/maps/maps';
import { buildBrush, parseQuakeMap, QEntity, TEXTURES } from '../src/maps/quakeMap';
import { brushContains, BrushPrim, PrimitiveWorld, spawnGroundZ } from '../src/maps/world';
import { ContactHit, MATERIALS } from '../src/sim/contact';
import { QuadSim } from '../src/sim/quad';
import { WakeField } from '../src/sim/wake';
import { DEFAULT_WIND, Wind } from '../src/sim/wind';

const read = (f: string) => readFileSync(new URL(`../public/maps/quake/${f}`, import.meta.url), 'latin1');

test('parses a minimal brush with outward planes and Quake texture axes', () => {
  const ents: QEntity[] = parseQuakeMap(`// comment
{
"classname" "worldspawn"
{
( 0 0 64 ) ( 0 64 64 ) ( 64 0 64 ) TOP 0 0 0 1 1
( 0 0 0 ) ( 64 0 0 ) ( 0 64 0 ) BOT 0 0 0 1 1
( 0 0 0 ) ( 0 0 64 ) ( 64 0 64 ) S 0 0 0 1 1
( 0 64 0 ) ( 64 64 64 ) ( 0 64 64 ) N 0 0 0 1 1
( 0 0 0 ) ( 0 64 0 ) ( 0 64 64 ) W 0 0 0 1 1
( 64 0 0 ) ( 64 64 64 ) ( 64 64 0 ) E 0 0 0 1 1
}
}
{ "classname" "info_player_start" "origin" "32 32 24" }`);
  expect(ents).toHaveLength(2);
  const poly = buildBrush(ents[0].brushes[0])!;
  expect(poly.faces).toHaveLength(6);
  for (const f of poly.faces) {
    expect(f.w).toHaveLength(4);
    expect(f.plane.n[0] * 32 + f.plane.n[1] * 32 + f.plane.n[2] * 32 - f.plane.d).toBeLessThan(0); // centre inside
  }
});

describe.each([['quake-e1m1', 'e1m1.map'], ['quake-dm3', 'dm3.map']])('%s', (id, file) => {
  provideMapSource(id, read(file));
  const t0 = performance.now();
  const map = MAPS[id]();
  const buildMs = performance.now() - t0;
  const world = new PrimitiveWorld(map);
  const brushes = map.prims.filter((p): p is BrushPrim => p.kind === 'brush');
  const sp = map.spawn.pos, gz = spawnGroundZ(map);

  test('builds brushes, faces, lights and textures quickly', () => {
    expect(brushes.length).toBeGreaterThan(500);
    expect(map.quake!.faces.length).toBeGreaterThan(2000);
    expect(map.quake!.lights.length).toBeGreaterThan(10);
    expect(buildMs).toBeLessThan(3000);
    for (const f of map.quake!.faces) expect(TEXTURES[f.tex], f.tex).toBeDefined();
    // every brush is a closed convex volume whose centre lies inside all its planes
    for (const b of brushes) {
      const c = { x: 0, y: 0, z: 0 }, E = b.edges, n = E.length / 3;
      for (let i = 0; i < E.length; i += 3) { c.x += E[i] / n; c.y += E[i + 1] / n; c.z += E[i + 2] / n; }
      expect(brushContains(b, c.x, c.y, c.z)).toBe(true);
    }
  });

  test('spawns standing on a floor brush', () => {
    const hit: ContactHit = { depth: 0, nx: 0, ny: 0, nz: 0, material: MATERIALS.grass };
    expect(world.sphere({ x: sp.x, y: sp.y, z: gz + 0.03 }, 0.05, hit)).toBe(true);
    expect(hit.nz).toBeGreaterThan(0.99);
    expect(hit.depth).toBeCloseTo(0.02, 4);
    expect(world.sphere({ x: sp.x, y: sp.y, z: gz + 0.5 }, 0.05, hit)).toBe(false);
    expect(world.raycast({ x: sp.x, y: sp.y, z: gz + 1 }, { x: 0, y: 0, z: -1 }, 5)).toBeCloseTo(1, 4);
  });

  test('video link is obstructed by walls but not in the open', () => {
    const eye = { x: sp.x, y: sp.y, z: gz + 1.6 };
    expect(world.obstructionDb(eye, { x: sp.x, y: sp.y, z: gz + 0.5 })).toBe(0);
    // a point well beyond the first wall in each horizontal direction
    let blocked = 0;
    for (let a = 0; a < 8; a++) {
      const d = { x: Math.cos(a * Math.PI / 4), y: Math.sin(a * Math.PI / 4), z: 0 };
      const t = world.raycast(eye, d, 200);
      if (t < 150) { blocked++; expect(world.obstructionDb(eye, { x: eye.x + d.x * (t + 3), y: eye.y + d.y * (t + 3), z: eye.z })).toBeGreaterThan(8); }
    }
    expect(blocked).toBeGreaterThan(4);
  });

  test.each([0, 1, 2, 3])('no tunnelling at 30 m/s (heading %i)', (h) => {
    const q = new QuadSim(buildDrone(DEFAULT_SPEC).params, 8000);
    const env = { world, wind: new Wind({ ...DEFAULT_WIND, speed20ft: 0 }), wake: new WakeField(), ambientC: 20, altitudeOffset: 0, damageEnabled: false };
    const yaw = map.spawn.yaw + h * Math.PI / 2;
    q.reset({ x: sp.x, y: sp.y, z: gz + 1.2 }, yaw);
    q.s.vel = { x: 30 * Math.cos(yaw), y: 30 * Math.sin(yaw), z: 0 };
    const wall = world.raycast(q.s.pos, { x: Math.cos(yaw), y: Math.sin(yaw), z: 0 }, 60);
    let prev = { ...q.s.pos }, minSpeed = 30;
    for (let i = 0; i < 8000 * 1.5; i++) {
      q.command([1000, 1000, 1000, 1000], false); q.step(1 / 8000, env);
      // the centre's swept path never enters solid: neither inside a brush nor through one between steps
      expect(brushes.some((b) => brushContains(b, q.s.pos.x, q.s.pos.y, q.s.pos.z))).toBe(false);
      expect(world.brushes.blocked(prev, q.s.pos)).toBe(false);
      prev = { ...q.s.pos };
      minSpeed = Math.min(minSpeed, Math.hypot(q.s.vel.x, q.s.vel.y));
    }
    if (wall < 40) expect(minSpeed).toBeLessThan(15); // it really hit the wall
  });
});
