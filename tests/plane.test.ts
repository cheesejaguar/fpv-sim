// Fixed-wing flight model: the five plane presets balance, trim hands off at their design cruise,
// glide, and answer each control the way ArduPlane's servo outputs expect.
import { describe, expect, test } from 'vitest';
import { buildDrone, DroneBuild, PRESETS } from '../src/builder/derive';
import { GroundPlane } from '../src/sim/contact';
import { QuadEnv, QuadSim } from '../src/sim/quad';
import { WakeField } from '../src/sim/wake';
import { Wind } from '../src/sim/wind';

const calmEnv = (): QuadEnv => ({
  world: new GroundPlane(), wind: new Wind({ speed20ft: 0, directionDeg: 0, z0: 0.03, turbulence: 0, gustiness: 0, gustMax: 0 }),
  wake: new WakeField(), ambientC: 20, altitudeOffset: 0, damageEnabled: false,
});
const HZ = 4000, DT = 1 / HZ;
const PLANES = PRESETS.filter((p) => p.name.startsWith('Plane:'));

/**
 * ArduPlane's output mixing (servos.cpp): aileron, elevator, rudder (-1..1, + = roll right, nose up,
 * yaw right) and throttle (0..1) to PWM by SERVOn_FUNCTION.
 */
function pwmFor(b: DroneBuild, a: number, e: number, r: number, thr: number): number[] {
  const out = new Array(16).fill(0);
  for (const [o, fn] of Object.entries(b.info.plane!.servoFunctions)) {
    const v = ({ 4: a, 19: e, 21: r, 77: e - a, 78: e + a, 79: e + r, 80: e - r } as Record<number, number>)[fn];
    out[Number(o) - 1] = v === undefined ? 1000 + 1000 * thr : 1500 + 500 * Math.max(-1, Math.min(1, v));
  }
  return out;
}

/** A plane in level flight at its design cruise, trimmed angle of attack, the cruise throttle set. */
function cruising(b: DroneBuild) {
  const q = new QuadSim(b.params, HZ), env = calmEnv(), pl = b.info.plane!;
  q.reset({ x: 0, y: 0, z: 150 });
  const V = pl.cruiseKmh / 3.6;
  // fly at the angle of attack that carries the weight: pitch the body up by it
  const al = trimAlpha(q, V);
  q.s.q = { w: Math.cos(al / 2), x: 0, y: -Math.sin(al / 2), z: 0 };
  q.s.vel = { x: V, y: 0, z: 0 };
  const rpm = pl.cruiseThrottle;
  for (const m of q.motors) m.s.omega = 0;
  const step = (a: number, e: number, r: number, thr: number) => {
    const pwm = pwmFor(b, a, e, r, thr);
    q.servos(pwm);
    q.command(pl.motorChannels.map((ch) => (pwm[ch] > 1000 ? 48 + ((pwm[ch] - 1000) / 1000) * 1999 : 0)), false);
    q.step(DT, env);
  };
  // spin the props up at the cruise throttle with the plane held in place
  for (let i = 0; i < HZ * 0.6; i++) { step(0, 0, 0, rpm); q.s.pos = { x: 0, y: 0, z: 150 }; q.s.vel = { x: V, y: 0, z: 0 }; q.s.w = { x: 0, y: 0, z: 0 }; q.s.q = { w: Math.cos(al / 2), x: 0, y: -Math.sin(al / 2), z: 0 }; }
  return { q, env, step, V };
}

/** Angle of attack at which the surfaces carry the weight at V (body level flight). */
function trimAlpha(q: QuadSim, V: number): number {
  // a coarse search through the plant itself: one step at each angle, the vertical force against the weight
  let lo = -0.1, hi = 0.3;
  const W = q.p.mass * 9.80665;
  for (let i = 0; i < 30; i++) {
    const al = (lo + hi) / 2;
    let fz = 0;
    for (const sc of q.p.surfaces!) {
      const u = { x: V * Math.cos(al), y: 0, z: -V * Math.sin(al) };
      // the surfaces in the wing's downwash see less angle: ignore here (the tail carries little)
      const n = sc.normal, c = sc.chord, uc = u.x * c.x + u.z * c.z, un = u.x * n.x + u.y * n.y + u.z * n.z;
      const a = Math.atan2(-un, uc), cl = sc.cl0 + 2 * Math.PI * sc.aspect / (2 + Math.sqrt(sc.aspect ** 2 + 4)) * a;
      fz += 0.5 * 1.225 * V * V * sc.area * cl * n.z;
    }
    if (fz > W) hi = al; else lo = al;
  }
  return (lo + hi) / 2;
}

describe('fixed-wing builds', () => {
  const builds = PLANES.map((s) => buildDrone(s));
  test('five plane presets, each balanced at its static margin with ArduPlane servo maps', () => {
    expect(builds.length).toBe(5);
    for (const b of builds) {
      const p = b.info.plane!;
      expect(p.balanced, b.spec.name).toBe(true);
      expect(Math.abs(p.staticMarginPct - p.airframe.staticMargin * 100)).toBeLessThan(0.5);
      expect(p.stallKmh).toBeGreaterThan(15); expect(p.stallKmh).toBeLessThan(p.cruiseKmh * 0.75);
      expect(p.topKmh).toBeGreaterThan(p.cruiseKmh);
      expect(p.glideRatio).toBeGreaterThan(6); expect(p.glideRatio).toBeLessThan(25);
      expect(p.enduranceMin).toBeGreaterThan(10);
      expect(p.params.SERVO1_FUNCTION).toBeGreaterThan(0);
      expect(p.motorChannels.length).toBe(b.params.rotors.length);
    }
  });

  test.each(PLANES.map((s) => [s.name]))('%s holds its cruise hands off', (name) => {
    const b = builds[PLANES.findIndex((s) => s.name === name)];
    const { q, step, V } = cruising(b);
    let minZ = Infinity, maxZ = -Infinity, maxRoll = 0;
    for (let i = 0; i < HZ * 4; i++) {
      step(0, 0, 0, b.info.plane!.cruiseThrottle);
      minZ = Math.min(minZ, q.s.pos.z); maxZ = Math.max(maxZ, q.s.pos.z);
      const qq = q.s.q; maxRoll = Math.max(maxRoll, Math.abs(Math.atan2(2 * (qq.w * qq.x + qq.y * qq.z), 1 - 2 * (qq.x * qq.x + qq.y * qq.y))));
    }
    const sp = Math.hypot(q.s.vel.x, q.s.vel.y, q.s.vel.z);
    // a phugoid starts from the imperfect initial trim; it must stay small over 4 s
    expect(maxZ - minZ, `${name} altitude band`).toBeLessThan(12);
    expect(Math.abs(sp - V) / V, `${name} speed`).toBeLessThan(0.25);
    // (a flying wing's spiral mode diverges slowly: ArduPlane's FBWA holds the wings level)
    expect(maxRoll, `${name} roll`).toBeLessThan(0.3);
    expect(q.s.crashed).toBe(false);
  });

  test.each(PLANES.map((s) => [s.name]))('%s rolls, pitches and yaws the way ArduPlane commands', (name) => {
    const b = builds[PLANES.findIndex((s) => s.name === name)];
    const thr = b.info.plane!.cruiseThrottle;
    const rate = (a: number, e: number, r: number) => {
      // the mean body rate over the first 0.2 s (before the Dutch roll or the short period swings back)
      const { q, step } = cruising(b), m = { x: 0, y: 0, z: 0 }, N = HZ * 0.2;
      for (let i = 0; i < N; i++) { step(a, e, r, thr); m.x += q.s.w.x / N; m.y += q.s.w.y / N; m.z += q.s.w.z / N; }
      return m;
    };
    const base = rate(0, 0, 0);
    // body FLU: roll right is +x, nose up is -y, yaw right is -z
    const ar = rate(0.6, 0, 0), ee = rate(0, 0.6, 0), rr = rate(0, 0, 0.8);
    expect(ar.x - base.x, `${name} aileron`).toBeGreaterThan(0.3);
    expect(-(ee.y - base.y), `${name} elevator`).toBeGreaterThan(0.1);
    // a flying wing has no rudder (winglets only): nothing to test there
    if (b.info.plane!.airframe.layout !== 'flyingwing') expect(-(rr.z - base.z), `${name} rudder`).toBeGreaterThan(0.05);
  });

  test('glides motor off at about its best glide ratio, without stalling', () => {
    const b = builds[PLANES.findIndex((s) => s.name.includes('Ranger 2000'))];
    const { q, step } = cruising(b);
    // settle into the glide, then average over 12 s (about two phugoid periods at this speed)
    for (let i = 0; i < HZ * 6; i++) step(0, 0, 0, 0);
    const z0 = q.s.pos.z;
    let dist = 0;
    for (let i = 0; i < HZ * 12; i++) { step(0, 0, 0, 0); dist += Math.hypot(q.s.vel.x, q.s.vel.y) * DT; }
    const drop = z0 - q.s.pos.z;
    expect(drop).toBeGreaterThan(0);
    const ld = dist / drop;
    expect(ld).toBeGreaterThan(b.info.plane!.glideRatio * 0.5);
    expect(ld).toBeLessThan(b.info.plane!.glideRatio * 1.2);
  });
});
