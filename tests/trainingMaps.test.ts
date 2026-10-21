// The training maps (whoop gym, practice field, park, mountains, night course): each is registered
// and builds deterministically, spawns on a supported floor clear of geometry, has valid gates whose
// lap counts in order along a clean line, sane collision and lights, and a physics step cost
// comparable to the stadium's.
import { describe, expect, test } from 'vitest';
import { buildDrone, DEFAULT_SPEC, DroneSpec, PRESETS } from '../src/builder/derive';
import { gateIdOf, openingCentre } from '../src/maps/gates';
import { GYM, GYM_LINE } from '../src/maps/gym';
import { hasMap, MAP_LIST, MAPS } from '../src/maps/maps';
import { NIGHT_LINE } from '../src/maps/night';
import { PRACTICE_LINES, SPEC } from '../src/maps/practice';
import { GateDef, MapDef, MAX_MAP_LIGHTS, Prim, PrimitiveWorld, spawnGroundZ, withCourse } from '../src/maps/world';
import { WORLD_CUP_LINE } from '../src/maps/worldCup';
import { ContactHit, MATERIALS } from '../src/sim/contact';
import { qFromAxisAngle, rotate, V3 } from '../src/sim/math';
import { QuadEnv, QuadSim } from '../src/sim/quad';
import { WakeField } from '../src/sim/wake';
import { Wind } from '../src/sim/wind';
import { flyLine, lineLength, splineLine } from './helpers/course';

const IDS = ['gym', 'practice', 'park', 'mountains', 'night'] as const;
const maps = Object.fromEntries(IDS.map((id) => [id, MAPS[id]()])) as Record<(typeof IDS)[number], MapDef>;
const worlds = Object.fromEntries(IDS.map((id) => [id, new PrimitiveWorld(maps[id])])) as Record<(typeof IDS)[number], PrimitiveWorld>;
const WHOOP = PRESETS.find((p) => p.frame === 'f65-whoop')!;
const hit: ContactHit = { depth: 0, nx: 0, ny: 0, nz: 0, material: MATERIALS.grass };
const tagged = (m: MapDef, id: number) => m.prims.filter((p) => gateIdOf(p.tag) === id);

/** Out-and-back over the mountains: start arch -> saddle arch -> round and back through the start. */
function mountainLine(m: MapDef): [number, number, number][] {
  const [g0, g1] = m.gates;
  const clear = (x: number, y: number, above: number) => {
    let h = -Infinity;
    for (let dx = -40; dx <= 40; dx += 10) for (let dy = -40; dy <= 40; dy += 10) h = Math.max(h, m.terrain(x + dx, y + dy));
    return h + above;
  };
  const s = { x: g1.c.x, y: g1.c.y, z: m.terrain(g1.c.x, g1.c.y) };
  const P: [number, number, number][] = [[g0.c.x, g0.c.y, g0.c.z + 2.0], [g0.c.x, g0.c.y + 30, Math.max(g0.c.z + 5, clear(g0.c.x, g0.c.y + 30, 6))]];
  for (let k = 1; k < 12; k++) { // cruise to the ridge
    const t = k / 12, x = g0.c.x + (s.x - g0.c.x) * t, y = g0.c.y + 60 + (s.y - 160 - g0.c.y - 60) * t;
    P.push([x, y, clear(x, y, 40)]);
  }
  P.push([s.x, s.y - 90, Math.max(clear(s.x, s.y - 90, 25), s.z + 8)], [s.x, s.y - 35, Math.max(clear(s.x, s.y - 35, 6), s.z + 4.5)], [s.x, s.y, s.z + 4]);
  P.push([s.x, s.y + 40, Math.max(clear(s.x, s.y + 40, 8), s.z + 4)], [s.x - 120, s.y + 140, clear(s.x - 120, s.y + 140, 45)], [s.x - 260, s.y, clear(s.x - 260, s.y, 45)]);
  for (let k = 1; k < 10; k++) { // back south
    const t = k / 10, x = s.x - 260 + (g0.c.x - 150 - s.x + 260) * t, y = s.y - 150 + (g0.c.y - 60 - s.y + 150) * t;
    P.push([x, y, clear(x, y, 40)]);
  }
  P.push([g0.c.x - 70, g0.c.y - 110, clear(g0.c.x - 70, g0.c.y - 110, 25)], [g0.c.x, g0.c.y - 70, Math.max(clear(g0.c.x, g0.c.y - 70, 4), g0.c.z + 4.5)]);
  P.push([g0.c.x, g0.c.y - 40, g0.c.z + 3.4], [g0.c.x, g0.c.y - 20, g0.c.z + 2.6]); // over the hilltop (pad, cairn, bench) into the arch
  return P;
}

/** [map, course id (undefined: default), line, probe radius, lap length range] */
const COURSES: [(typeof IDS)[number], string | undefined, [number, number, number][], number, [number, number]][] = [
  ['gym', undefined, GYM_LINE, 0.1, [40, 90]],
  ['practice', undefined, PRACTICE_LINES.spec, 0.18, [250, 350]],
  ['practice', 'slalom', PRACTICE_LINES.slalom, 0.18, [150, 300]],
  ['practice', 'figure8', PRACTICE_LINES.figure8, 0.18, [120, 250]],
  ['practice', 'powerloop', PRACTICE_LINES.powerloop, 0.18, [15, 40]],
  ['night', undefined, NIGHT_LINE, 0.18, [250, 350]],
  ['mountains', undefined, mountainLine(maps.mountains), 0.18, [4000, 7000]],
];

describe('registry', () => {
  test.each(IDS)('%s is registered, credited and builds the same map every time', (id) => {
    expect(hasMap(id)).toBe(true);
    expect(id).toMatch(/^[a-z][a-z0-9-]*$/);
    const e = MAP_LIST[id], m = maps[id];
    expect(m.id).toBe(id);
    expect(e.name).toBe(m.name);
    expect(e.name).toMatch(/^\S.* — \S/); // "Title — subtitle" for the map tiles
    expect(e.credit).toMatch(/^Original \(this project, GPL-3\.0-or-later\)/);
    expect(e.source).toBeUndefined(); // procedural: nothing to fetch
    const again = MAPS[id]();
    expect(JSON.stringify(again.prims)).toBe(JSON.stringify(m.prims));
    expect(JSON.stringify(again.gates)).toBe(JSON.stringify(m.gates));
    expect(JSON.stringify(again.trees)).toBe(JSON.stringify(m.trees));
    for (const [x, y] of [[0, 0], [37.3, -12.9], [-150, 88]]) expect(again.terrain(x, y)).toBe(m.terrain(x, y));
  });

  test('the whoop gym is listed right after the stadium, ahead of the other training maps', () => {
    const ids = Object.keys(MAP_LIST);
    expect(ids.slice(0, 6)).toEqual(['field', 'gym', 'practice', 'park', 'mountains', 'night']);
  });
});

describe('spawn', () => {
  const spawns = IDS.flatMap((id) => [{ id, name: id, m: maps[id] }, ...(maps[id].courses ?? []).filter((c) => c.spawn).map((c) => ({ id, name: `${id}/${c.id}`, m: withCourse(maps[id], c.id) }))]);
  test.each(spawns.flatMap((s) => [{ ...s, spec: WHOOP, quad: 'whoop' }, { ...s, spec: DEFAULT_SPEC, quad: '5"' }]))('$name: a $quad spawns on a supported floor, clear of everything', ({ id, m, spec }) => {
    const w = worlds[id], sp = m.spawn.pos, gz = spawnGroundZ(m);
    // the floor is there (pad / terrain): a sphere resting on it touches, one just above does not
    expect(w.sphere({ x: sp.x, y: sp.y, z: gz + 0.05 - 0.005 }, 0.05, hit)).toBe(true);
    expect(hit.nz).toBeGreaterThan(0.95);
    expect(w.sphere({ x: sp.x, y: sp.y, z: gz + 0.05 + 0.005 }, 0.05, hit)).toBe(false);
    // the worker's respawn pose: every collider sphere is free (6 cm above the floor)
    const b = buildDrone(spec), cs = b.params.colliders;
    const z = gz + 0.06 - Math.min(...cs.map((c) => c.pos.z - c.radius));
    const q = qFromAxisAngle(0, 0, 1, m.spawn.yaw), o: V3 = { x: 0, y: 0, z: 0 };
    for (const c of cs) {
      rotate(o, q, c.pos);
      expect(w.sphere({ x: sp.x + o.x, y: sp.y + o.y, z: z + o.z }, c.radius, hit), `${c.kind} collider`).toBe(false);
    }
    // a clear column to climb out: 2.5 m (the gym: to 2 m, a whoop's bound)
    const r = spec === WHOOP ? 0.08 : 0.2;
    for (let h = gz + r + 0.1; h < gz + (id === 'gym' ? 2 : 2.5); h += 0.1) expect(w.sphere({ x: sp.x, y: sp.y, z: h }, r, hit), `column at ${h.toFixed(1)} m`).toBe(false);
    // inside the map
    expect(Math.max(Math.abs(sp.x), Math.abs(sp.y))).toBeLessThan(m.size);
  });
});

describe('gates and courses', () => {
  test.each(IDS)('%s: gate ids are unique map-wide and every gate is drawn', (id) => {
    const m = maps[id];
    const all: GateDef[] = [...m.gates, ...(m.courses ?? []).flatMap((c) => c.gates)];
    const byId = new Map<number, GateDef>();
    for (const g of all) { const seen = byId.get(g.id); if (seen) expect(seen).toBe(g); else byId.set(g.id, g); } // the same gate may appear in two courses
    for (const g of byId.values()) {
      expect(tagged(m, g.id).length, `gate ${g.id} has no prims`).toBeGreaterThan(0);
      expect(Number.isFinite(g.c.x + g.c.y + g.c.z + g.yaw + g.width + g.height)).toBe(true);
    }
    for (const c of m.courses ?? []) expect(c.gates.length).toBeGreaterThanOrEqual(2);
  });

  test.each(IDS.filter((id) => maps[id].gates.length))('%s: every opening is clear of structure', (id) => {
    const m = maps[id], w = worlds[id];
    for (const g of [...m.gates, ...(m.courses ?? []).flatMap((c) => c.gates)]) {
      if (g.kind === 'flag') continue;
      const c = openingCentre(g), r = Math.min(0.4 * Math.min(g.width, g.height), c.z - m.terrain(c.x, c.y) - 0.05); // clear of the ground too
      expect(w.sphere(c, r, hit), `gate ${g.id} (${g.kind}) opening obstructed`).toBe(false);
    }
  });

  test.each(COURSES)('%s %s: a clean line clears every obstacle and counts every gate in order, lap after lap', (id, course, P, r, [lo, hi]) => {
    const m = withCourse(maps[id], course);
    const len = lineLength(splineLine(P, 1));
    expect(len).toBeGreaterThan(lo);
    expect(len).toBeLessThan(hi);
    const { touch, events } = flyLine(worlds[id], m.gates, splineLine(P, 2), r);
    expect(touch, `line touches ${touch?.what} at ${JSON.stringify(touch)}`).toBeNull();
    const ids = m.gates.map((g) => g.id);
    expect(events).toEqual([...ids, ...ids]);
  });

  test('withCourse swaps in a drill course and its start, and leaves other maps alone', () => {
    const p = maps.practice, s = withCourse(p, 'slalom');
    const slalom = p.courses!.find((c) => c.id === 'slalom')!;
    expect(s.gates).toBe(slalom.gates);
    expect(s.spawn).toBe(slalom.spawn);
    expect(s.prims).toBe(p.prims);
    expect(withCourse(p, 'spec').gates).toBe(p.gates);
    expect(withCourse(p, 'nope')).toBe(p);
    expect(withCourse(p)).toBe(p);
    expect(withCourse(maps.gym, 'slalom')).toBe(maps.gym);
  });

  test('practice field: spec-sized obstacles, a real figure-8 and a power loop', () => {
    const p = maps.practice;
    for (const g of p.gates) if (g.kind === 'square' || g.kind === 'ladder') expect([g.width, g.height]).toEqual([SPEC.gate, SPEC.gate]);
    expect(p.gates.find((g) => g.kind === 'hurdle')!.width).toBe(SPEC.hurdle);
    expect(p.gates.find((g) => g.kind === 'dive')!.c.z).toBe(SPEC.dive);
    // figure-8: both gates southbound, so a plain oval through them only counts one of the two
    const f8 = withCourse(p, 'figure8');
    const [a, b] = f8.gates;
    expect(a.yaw).toBeCloseTo(b.yaw);
    const oval: [number, number, number][] = Array.from({ length: 16 }, (_, k) => { const t = (k / 16) * 2 * Math.PI; return [(a.c.x + b.c.x) / 2 + Math.cos(t) * (a.c.x - b.c.x) / 2, a.c.y - Math.sin(t) * 14, 0.8]; });
    expect(flyLine(worlds.practice, f8.gates, splineLine(oval, 2), 0.1).events).toEqual([a.id]); // A, then B never comes
    // power loop: the low and high gates stand on the same posts, with an open window between them
    const [lo, hiG] = withCourse(p, 'powerloop').gates;
    expect([hiG.c.x, hiG.c.y]).toEqual([lo.c.x, lo.c.y]);
    expect(Math.abs(Math.abs(hiG.yaw - lo.yaw) - Math.PI)).toBeLessThan(1e-9);
    expect(worlds.practice.sphere({ x: lo.c.x, y: lo.c.y, z: (lo.c.z + lo.height + hiG.c.z) / 2 }, 0.5, hit)).toBe(false);
  });
});

describe('lights and sky', () => {
  test.each(IDS)('%s: at most %#s lights, each in free air', (id) => {
    const m = maps[id];
    expect((m.lights ?? []).length).toBeLessThanOrEqual(MAX_MAP_LIGHTS);
    for (const l of m.lights ?? []) {
      expect(Number.isFinite(l.pos.x + l.pos.y + l.pos.z) && l.intensity > 0 && l.range > 0 && l.color >= 0 && l.color <= 0xffffff).toBe(true);
      expect(worlds[id].sphere(l.pos, 0.03, hit), `light at ${JSON.stringify(l.pos)} is inside something`).toBe(false);
      expect(l.pos.z).toBeGreaterThan(m.terrain(l.pos.x, l.pos.y));
    }
  });

  test('the gym is lit by its ceiling fixtures; the night course by eight floodlights under a night sky', () => {
    const g = maps.gym.lights!;
    expect(g.length).toBe(8);
    for (const l of g) { expect(Math.abs(l.pos.x)).toBeLessThan(GYM.x); expect(Math.abs(l.pos.y)).toBeLessThan(GYM.y); expect(l.pos.z).toBeLessThan(GYM.h); expect(l.pos.z).toBeGreaterThan(5); }
    const n = maps.night;
    expect(n.sky).toBe('night');
    expect(n.lights!.length).toBe(MAX_MAP_LIGHTS);
    for (const l of n.lights!) expect(l.pos.z).toBeGreaterThan(10);
    // the floodlights surround the course: every gate within 70 m of a light
    for (const gt of n.gates) expect(Math.min(...n.lights!.map((l) => Math.hypot(l.pos.x - gt.c.x, l.pos.y - gt.c.y)))).toBeLessThan(70);
  });
});

describe('collision sanity', () => {
  test('gym: closed shell (walls, roof, floor) with open clerestory windows; no wind', () => {
    const w = worlds.gym, { x: X, y: Y, h: H } = GYM;
    for (const z of [0.5, 2.5, 3.9, 5.7]) {
      for (const [x, y] of [[X + 0.05, 0], [-X - 0.05, 3], [5, Y + 0.05]]) expect(w.sphere({ x, y, z }, 0.02, hit), `wall ${x},${y},${z}`).toBe(true);
    }
    expect(w.sphere({ x: 0, y: -Y - 0.1, z: 2 }, 0.02, hit)).toBe(true);           // south wall below the windows
    expect(w.sphere({ x: X / 8, y: -Y - 0.1, z: 4.7 }, 0.3, hit)).toBe(false);     // a window opening
    for (const [x, y] of [[0, 0], [-10, 5], [11, -6]]) expect(w.sphere({ x, y, z: H + 0.1 }, 0.02, hit)).toBe(true); // roof
    expect(w.sphere({ x: -2, y: -2, z: 0.03 }, 0.05, hit)).toBe(true);
    expect(hit.material.name).toBe('wood');
    expect(hit.nz).toBeCloseTo(1, 6);
    expect(maps.gym.windScale).toBe(0);
    // the basketball rim is a real (whoop-sized) hoop: open in the middle, solid at the ring
    const rim = maps.gym.prims.filter((p) => p.tag === 'rim') as Extract<Prim, { kind: 'box' }>[];
    const cx = rim.reduce((s, p) => s + p.c.x, 0) / rim.length, cy = rim.reduce((s, p) => s + p.c.y, 0) / rim.length;
    expect(w.sphere({ x: cx, y: cy, z: 3.05 }, 0.15, hit)).toBe(false);
    expect(w.sphere({ x: cx + 0.2386, y: cy, z: 3.05 }, 0.02, hit)).toBe(true);
  });

  test('park: flat car park and pitch, solid trunks in porous canopies', () => {
    const m = maps.park, w = worlds.park;
    for (const [x, y] of [[-125, -115], [12, -50], [-80, -105]]) expect(m.terrain(x, y)).toBe(0);
    expect(w.sphere({ x: -125, y: -112, z: 0.08 }, 0.05, hit)).toBe(true);
    expect(hit.material.name).toBe('concrete');
    const lone = m.trees.filter((t) => t.r >= 5)[0];
    const gz = m.terrain(lone.x, lone.y);
    expect(w.sphere({ x: lone.x, y: lone.y, z: gz + 1 }, 0.05, hit)).toBe(true);                     // trunk
    const inCanopy = { x: lone.x + lone.r * 0.7, y: lone.y, z: gz + lone.h * 0.62 };
    expect(w.sphere(inCanopy, 0.05, hit)).toBe(false);                                               // porous canopy...
    expect(w.foliage(inCanopy)).toBeGreaterThan(0);                                                  // ...that drags
    // rolling meadow in the north: real relief, but gentle enough to skim
    let lo = Infinity, hi = -Infinity, steep = 0;
    for (let x = -180; x <= 180; x += 6) for (let y = 30; y <= 140; y += 6) {
      const z = m.terrain(x, y); lo = Math.min(lo, z); hi = Math.max(hi, z);
      steep = Math.max(steep, Math.hypot(m.terrain(x + 1, y) - m.terrain(x - 1, y), m.terrain(x, y + 1) - m.terrain(x, y - 1)) / 2);
    }
    expect(hi - lo).toBeGreaterThan(4);
    expect(steep).toBeLessThan(0.6);
  });

  test('mountains: kilometres of relief, a far ridge above the launch hill, arches rooted in the slope', () => {
    const m = maps.mountains, w = worlds.mountains, [g0, g1] = m.gates;
    expect(m.size).toBeGreaterThanOrEqual(2000);
    const launch = spawnGroundZ(m);
    expect(Math.hypot(g1.c.x - g0.c.x, g1.c.y - g0.c.y)).toBeGreaterThan(2000);           // a far ridge
    expect(m.terrain(g1.c.x, g1.c.y)).toBeGreaterThan(launch + 100);                        // its saddle towers over the hilltop
    let lo = Infinity;
    for (let y = g0.c.y; y < g1.c.y; y += 20) lo = Math.min(lo, m.terrain(0, y));
    expect(launch - lo).toBeGreaterThan(300);                                                // a deep valley between
    // the hilltop: flat where the pilot stands, falling away round it
    for (const [dx, dy] of [[10, 0], [0, -10], [-12, 8]]) expect(Math.abs(m.terrain(m.spawn.pos.x + dx, m.spawn.pos.y + dy) - launch)).toBeLessThan(0.1);
    // both arch posts reach into the ground (none floats on the slope)
    for (const g of [g0, g1]) for (const p of tagged(m, g.id)) {
      if (p.kind !== 'box' || p.pitch) continue;
      const bottom = p.c.z - p.half.z;
      if (bottom < g.c.z + 0.5) expect(bottom).toBeLessThanOrEqual(m.terrain(p.c.x, p.c.y) + 0.02);
    }
    // the terrain is continuous and collides with a sane normal on a slope
    for (const [x, y] of [[300, 400], [-800, 1100], [1200, -300]]) {
      expect(Math.abs(m.terrain(x + 0.01, y) - m.terrain(x, y))).toBeLessThan(0.05);
      expect(w.sphere({ x, y, z: m.terrain(x, y) + 0.1 }, 0.15, hit)).toBe(true);
      expect(hit.nz).toBeGreaterThan(0.3);
      expect(w.groundHeight(x, y)).toBe(m.terrain(x, y));
    }
    expect(m.fog!.density).toBeLessThan(0.0006); // the far ridge is not lost in the haze
  });
});

describe('physics step cost', () => {
  const DT = 1 / 8000;
  /** µs per QuadSim step: resting on the spawn pad (every collider in contact), in the air above it, and along a line. */
  function cost(m: MapDef, spec: DroneSpec, line?: [number, number, number][]) {
    const b = buildDrone(spec), q = new QuadSim(b.params, 8000), world = new PrimitiveWorld(m), ws = m.windScale ?? 1;
    const wind = new Wind({ speed20ft: 3 * ws, directionDeg: 240, z0: 0.03, turbulence: 1, gustiness: 2, gustMax: 2 * ws });
    wind.zones = m.wakeZones; wind.indoor = m.indoor ?? [];
    const env: QuadEnv = { world, wind, wake: new WakeField(), ambientC: 20, altitudeOffset: m.elevationM, damageEnabled: false };
    const sp = m.spawn.pos, gz = spawnGroundZ(m), z0 = gz + 0.06 - Math.min(...b.params.colliders.map((c) => c.pos.z - c.radius));
    const run = (n: number) => { const t = performance.now(); for (let i = 0; i < n; i++) { q.command([0, 0, 0, 0], false); q.step(DT, env); } return ((performance.now() - t) * 1000) / n; };
    const best = (f: () => number) => Math.min(f(), f(), f());
    const ground = best(() => { q.reset({ x: sp.x, y: sp.y, z: z0 }, m.spawn.yaw); run(300); return run(1500); });
    const air = best(() => { let s = 0; for (let k = 0; k < 5; k++) { q.reset({ x: sp.x, y: sp.y, z: gz + 1.5 }, 0); s += run(300); } return s / 5; });
    const pts = line ? splineLine(line, 1, 3) : [];
    const course = pts.length ? best(() => { let s = 0; for (const p of pts) { q.reset(p, 0); q.s.vel = { x: 8, y: 0, z: 0 }; s += run(40); } return s / pts.length; }) : NaN;
    return { ground, air, course };
  }

  test('every training map steps about as fast as the stadium', () => {
    const field = MAPS.field();
    const ref5 = cost(field, DEFAULT_SPEC, WORLD_CUP_LINE), refW = cost(field, WHOOP, WORLD_CUP_LINE);
    const rows: [string, MapDef, DroneSpec, [number, number, number][] | undefined][] = [
      ['gym', maps.gym, WHOOP, GYM_LINE], ['practice', maps.practice, DEFAULT_SPEC, PRACTICE_LINES.spec], ['park', maps.park, DEFAULT_SPEC, undefined],
      ['mountains', maps.mountains, DEFAULT_SPEC, undefined], ['night', maps.night, DEFAULT_SPEC, NIGHT_LINE],
    ];
    for (const [name, m, spec, line] of rows) {
      const c = cost(m, spec, line), ref = spec === WHOOP ? refW : ref5;
      // generous bounds (timing noise): the same order of cost as the stadium, never several times it
      expect(c.ground, `${name} on the pad: ${c.ground.toFixed(1)} µs vs ${ref.ground.toFixed(1)}`).toBeLessThan(2 * ref.ground);
      expect(c.air, `${name} in the air: ${c.air.toFixed(1)} µs vs ${ref.air.toFixed(1)}`).toBeLessThan(2 * ref.air + 2);
      if (line) expect(c.course, `${name} along the course: ${c.course.toFixed(1)} µs vs ${ref.course.toFixed(1)}`).toBeLessThan(2 * ref.course + 2);
    }
  }, 60000);
});

/** Spawn yaw sanity helper for the reader: every spawn faces its first gate (if any) within 60°. */
test('spawns face their first gate', () => {
  for (const id of IDS) for (const m of [maps[id], ...(maps[id].courses ?? []).map((c) => withCourse(maps[id], c.id))]) {
    if (!m.gates.length) continue;
    const g = m.gates[0], sp = m.spawn.pos, f: V3 = { x: Math.cos(m.spawn.yaw), y: Math.sin(m.spawn.yaw), z: 0 };
    const dx = g.c.x - sp.x, dy = g.c.y - sp.y, L = Math.hypot(dx, dy);
    expect((f.x * dx + f.y * dy) / L, `${m.id} start`).toBeGreaterThan(0.5);
  }
});
