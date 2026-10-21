// Doom-format (Freedoom) level loader: sector polygons with holes, door opening, and the built map's
// collision: spawn on the floor, no tunnelling through walls at 30 m/s, video obstruction behind walls.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { buildDrone, DEFAULT_SPEC } from '../src/builder/derive';
import { DoomLevelData, openDoors, parseDoomLevel, sectorPolygons, triangulate } from '../src/maps/doomMap';
import { MAPS, provideMapSource } from '../src/maps/maps';
import { brushContains, BrushPrim, PrimitiveWorld, spawnGroundZ } from '../src/maps/world';
import { ContactHit, MATERIALS } from '../src/sim/contact';
import { QuadSim } from '../src/sim/quad';
import { WakeField } from '../src/sim/wake';
import { DEFAULT_WIND, Wind } from '../src/sim/wind';

const read = (f: string) => readFileSync(new URL(`../public/maps/freedoom/${f}`, import.meta.url), 'utf8');
const absArea = (l: number[][]) => { let a = 0; for (let i = 0; i < l.length; i++) { const p = l[i], q = l[(i + 1) % l.length]; a += p[0] * q[1] - q[0] * p[1]; } return Math.abs(a / 2); };

/** A 256 x 256 room (sector 0) around a 64 x 64 pillar room (sector 1) behind a door line (special 1). */
function roomWithInner(): DoomLevelData {
  const verts: [number, number][] = [[0, 0], [256, 0], [256, 256], [0, 256], [96, 96], [160, 96], [160, 160], [96, 160]];
  const sides = [
    { xoff: 0, yoff: 0, upper: '-', lower: '-', mid: 'W', sector: 0 },
    { xoff: 0, yoff: 0, upper: '-', lower: '-', mid: '-', sector: 0 },
    { xoff: 0, yoff: 0, upper: '-', lower: '-', mid: '-', sector: 1 },
  ];
  const line = (v1: number, v2: number, front: number, back = -1, special = 0) => ({ v1, v2, flags: 0, special, tag: 0, front, back });
  return {
    things: [], verts, sides,
    sectors: [
      { floor: 0, ceil: 128, floorTex: 'F', ceilTex: 'C', light: 160, special: 0, tag: 0 },
      { floor: 0, ceil: 0, floorTex: 'F', ceilTex: 'C', light: 160, special: 0, tag: 0 }, // closed door
    ],
    // outer walls clockwise (sector on the right); the inner square's lines face out into sector 0
    lines: [line(0, 3, 0), line(3, 2, 0), line(2, 1, 0), line(1, 0, 0),
      line(4, 5, 1, 2, 1), line(5, 6, 1, 2), line(6, 7, 1, 2), line(7, 4, 1, 2)],
  };
}

test('traces sector loops with holes and triangulates them exactly', () => {
  const d = roomWithInner();
  const outer = sectorPolygons(d, 0);
  expect(outer).toHaveLength(1);
  expect(outer[0].holes).toHaveLength(1);
  expect(absArea(outer[0].outer)).toBe(256 * 256);
  expect(triangulate(outer[0]).reduce((s, t) => s + absArea(t), 0)).toBeCloseTo(256 * 256 - 64 * 64, 6);
  const inner = sectorPolygons(d, 1);
  expect(inner).toHaveLength(1);
  expect(inner[0].holes).toHaveLength(0);
  expect(absArea(inner[0].outer)).toBe(64 * 64);
});

test('opens doors to their lowest neighbouring ceiling', () => {
  const d = roomWithInner();
  expect(openDoors(d)).toBe(1);
  expect(d.sectors[1].ceil).toBe(124);
});

describe('freedoom-map01', () => {
  const src = read('map01.json');
  provideMapSource('freedoom-map01', src);
  const t0 = performance.now();
  const map = MAPS['freedoom-map01']();
  const buildMs = performance.now() - t0;
  const world = new PrimitiveWorld(map);
  const brushes = map.prims.filter((p): p is BrushPrim => p.kind === 'brush');
  const sp = map.spawn.pos, gz = spawnGroundZ(map);
  const textures = map.quake!.textures!;

  test('every sector becomes polygons that triangulate to their full area', () => {
    const d = parseDoomLevel(src);
    for (let i = 0; i < d.sectors.length; i++) {
      const polys = sectorPolygons(d, i);
      expect(polys.length, `sector ${i}`).toBeGreaterThan(0);
      for (const p of polys) {
        const a = absArea(p.outer) - p.holes.reduce((s, h) => s + absArea(h), 0);
        expect(triangulate(p).reduce((s, t) => s + absArea(t), 0), `sector ${i}`).toBeCloseTo(a, 3);
      }
    }
  });

  test('builds brushes and textured faces quickly', () => {
    expect(brushes.length).toBeGreaterThan(1000);
    expect(map.quake!.faces.length).toBeGreaterThan(2000);
    expect(buildMs).toBeLessThan(3000);
    for (const f of map.quake!.faces) expect(textures[f.tex], f.tex).toBeDefined();
    for (const b of brushes) {
      const c = { x: 0, y: 0, z: 0 }, E = b.edges, n = E.length / 3;
      for (let i = 0; i < E.length; i += 3) { c.x += E[i] / n; c.y += E[i + 1] / n; c.z += E[i + 2] / n; }
      expect(brushContains(b, c.x, c.y, c.z)).toBe(true);
    }
    // Doom scale: 56 units ≈ 1.75 m
    expect(map.quake!.scale * 56).toBeCloseTo(1.75, 6);
  });

  test('spawns standing on the floor at player 1 start', () => {
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
      expect(brushes.some((b) => brushContains(b, q.s.pos.x, q.s.pos.y, q.s.pos.z))).toBe(false);
      expect(world.brushes.blocked(prev, q.s.pos)).toBe(false);
      prev = { ...q.s.pos };
      minSpeed = Math.min(minSpeed, Math.hypot(q.s.vel.x, q.s.vel.y));
    }
    if (wall < 40) expect(minSpeed).toBeLessThan(15);
  });
});
