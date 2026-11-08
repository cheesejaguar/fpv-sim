// Plant regressions from the quality pass: a fast quad that clips a thin panel falls off it (it used
// to hang pinched in the panel), a landed quad stays put on a slope it can grip (it used to creep
// down at ~5 cm/s), rotor phases stay small (huge phases put Math.sin on its slow path), a 1S whoop's
// aux load is a constant-power load at its own bus voltage, and a plane's prop shakes its disc, not
// its thrust axis.
import { describe, expect, test } from 'vitest';
import { buildDrone, DEFAULT_SPEC, PRESETS } from '../src/builder/derive';
import { MAPS } from '../src/maps/maps';
import { MapDef, Prim, PrimitiveWorld } from '../src/maps/world';
import { qFromEuler } from '../src/sim/math';
import { QuadSim } from '../src/sim/quad';
import { WakeField } from '../src/sim/wake';
import { DEFAULT_WIND, Wind } from '../src/sim/wind';

const HZ = 8000;
const world = (m: Partial<MapDef>) => new PrimitiveWorld({ ...MAPS.field(), terrain: () => 0, prims: [], trees: [], gates: [], ...m });
const env = (w: PrimitiveWorld) => ({ world: w, wind: new Wind({ ...DEFAULT_WIND, speed20ft: 0 }), wake: new WakeField(), ambientC: 20, altitudeOffset: 0, damageEnabled: false });
const run = (q: QuadSim, e: ReturnType<typeof env>, s: number, dshot = 0) => { for (let i = 0; i < s * HZ; i++) { q.command([dshot, dshot, dshot, dshot], false); q.step(1 / HZ, e); e.wake.step(1 / HZ, { x: 0, y: 0, z: 0 }, 0); } };

describe('contacts', () => {
  test.each([[0.01, 45], [0.024, 20]])('a quad that hits a %s m panel at %s m/s falls off it, motors off', (thick, v) => {
    const panel: Prim = { kind: 'box', c: { x: 1, y: 0, z: 10 }, half: { x: thick / 2, y: 5, z: 10 }, yaw: 0, mat: 'concrete' };
    const q = new QuadSim(buildDrone(DEFAULT_SPEC).params, HZ), e = env(world({ prims: [panel] }));
    q.reset({ x: -1, y: 0, z: 15 }); q.s.vel = { x: v, y: 0, z: 0 };
    run(q, e, 2);
    // free fall from 15 m takes ~1.75 s: it must be near the ground, not stuck on the panel at ~15 m
    expect(q.s.pos.z).toBeLessThan(2);
  });
  test.each([2000, 8000])('a quad put inside a wall (%s Hz) is pushed out at a sane speed, not flung off at km/s', (hz) => {
    // a teleport into a building: the spheres start 0.5-1.5 m deep in the box
    const block: Prim = { kind: 'box', c: { x: 0, y: 0, z: 5 }, half: { x: 2, y: 2, z: 5 }, yaw: 0, mat: 'concrete' };
    const q = new QuadSim(buildDrone(DEFAULT_SPEC).params, hz), e = env(world({ prims: [block] }));
    q.reset({ x: 1, y: 0.5, z: 8 });
    let vmax = 0;
    for (let i = 0; i < hz * 2; i++) {
      q.command([0, 0, 0, 0], false); q.step(1 / hz, e);
      vmax = Math.max(vmax, Math.hypot(q.s.vel.x, q.s.vel.y, q.s.vel.z));
    }
    expect(Number.isFinite(q.s.pos.x + q.s.pos.y + q.s.pos.z)).toBe(true);
    expect(vmax).toBeLessThan(60);
  });
  test('a prop strike brakes the rotors as hard at 2 kHz (contact substeps) as at 8 kHz', () => {
    const strike = (hz: number) => {
      // the prop tips 3 mm into a wall ahead (the props reach further out than anything else)
      const params = buildDrone(DEFAULT_SPEC).params;
      const tip = Math.max(...params.colliders.filter((c) => c.kind === 'prop').map((c) => c.pos.x + c.radius));
      expect(Math.max(...params.colliders.filter((c) => c.kind !== 'prop').map((c) => c.pos.x + c.radius))).toBeLessThan(tip - 0.003);
      const wall: Prim = { kind: 'box', c: { x: tip - 0.003 + 1, y: 0, z: 10 }, half: { x: 1, y: 5, z: 10 }, yaw: 0, mat: 'concrete' };
      const q = new QuadSim(params, hz), e = env(world({ prims: [wall] }));
      q.reset({ x: 0, y: 0, z: 5 });
      for (const m of q.motors) m.s.omega = 1500;
      q.command([0, 0, 0, 0], false); q.step(1 / hz, e);
      return q.rotorExtraTorque.reduce((a, b) => a + Math.abs(b), 0);
    };
    const t8 = strike(8000), t2 = strike(2000);
    expect(t8).toBeGreaterThan(0);
    expect(t2 / t8).toBeLessThan(1.3); // (was the substeps' sum: ~1.8x)
  });
  test('a drop bounces about as high at the 2 kHz fallback rate as at 8 kHz', () => {
    const rebound = (hz: number) => {
      const q = new QuadSim(buildDrone(DEFAULT_SPEC).params, hz), e = env(world({ groundMat: 'concrete' }));
      q.reset({ x: 0, y: 0, z: 1 });
      let hit = false, top = 0;
      for (let i = 0; i < hz * 1.5; i++) {
        q.command([0, 0, 0, 0], false); q.step(1 / hz, e);
        if (q.s.touching) hit = true;
        else if (hit) top = Math.max(top, q.s.pos.z);
      }
      return top;
    };
    const r8 = rebound(8000), r2 = rebound(2000), r4 = rebound(4000);
    expect(r8).toBeGreaterThan(0.05);
    expect(Math.abs(r2 - r8) / r8).toBeLessThan(0.3); // (was +80 %: 24.7 cm against 13.7)
    expect(Math.abs(r4 - r8) / r8).toBeLessThan(0.3);
  });
  test('a landed quad does not creep down a 20° concrete slope (mu 0.6 > tan 20°)', () => {
    const t = Math.tan((20 * Math.PI) / 180);
    const q = new QuadSim(buildDrone(DEFAULT_SPEC).params, HZ), e = env(world({ terrain: (x) => x * t, groundMat: 'concrete' }));
    q.reset({ x: 0, y: 0, z: 0.05 });
    q.s.q = qFromEuler(0, -0.349, 0); // level with the slope
    run(q, e, 1.5);
    const x0 = q.s.pos.x;
    run(q, e, 4);
    expect(Math.abs(q.s.pos.x - x0) / 4).toBeLessThan(0.005); // m/s (was ~0.05)
  });
});

describe('rotors and power', () => {
  test('rotor phases stay within a turn and restart on reset', () => {
    const q = new QuadSim(buildDrone(DEFAULT_SPEC).params, HZ), e = env(world({}));
    q.reset({ x: 0, y: 0, z: 50 });
    run(q, e, 1, 800);
    for (const ph of q.phase) expect(Math.abs(ph)).toBeLessThanOrEqual(2 * Math.PI);
    q.reset({ x: 0, y: 0, z: 50 });
    expect(q.phase).toEqual(q.p.rotors.map((_, i) => i * 1.3));
  });
  test('a 1S whoop draws its aux power at its own bus voltage', () => {
    const b = buildDrone(PRESETS.find((p) => p.name.startsWith('Beginner: 65 mm'))!);
    const q = new QuadSim(b.params, HZ), e = env(world({}));
    q.reset({ x: 0, y: 0, z: 20 });
    run(q, e, 0.2);
    // motors off: the bus current is the aux load alone, P / V at ~4 V (it was divided by 6 V)
    expect(q.s.ibus).toBeCloseTo(b.params.auxPowerW / q.s.vbus, 1);
  });
  test("a plane's prop imbalance turns in its disc: it shakes y / z, not along its thrust axis (x)", () => {
    const spec = PRESETS.find((p) => p.name === 'Plane: AtomRC Penguin')!;
    const params = buildDrone(spec).params;
    params.rotors.forEach((r) => { r.imbalance = 2e-6; }); // exaggerated, to stand out of the noise
    const q = new QuadSim(params, HZ), e = env(world({}));
    q.reset({ x: 0, y: 0, z: 50 });
    let ax = 0, ayz = 0;
    for (let i = 0; i < HZ * 0.5; i++) {
      q.command(params.rotors.map(() => 1200), false); q.step(1 / HZ, e);
      const v = (q as unknown as { vibF: { x: number; y: number; z: number } }).vibF;
      ax += Math.abs(v.x); ayz += Math.hypot(v.y, v.z);
    }
    expect(ayz).toBeGreaterThan(3 * ax);
  });
});
