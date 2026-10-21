// Crash damage is energy based and rolled once per impact event. Reproduces the measured failures of
// the old model: a 30 m/s concrete hit at throttle cost <= 2 % thrust and never broke a prop, a 5 m/s
// hit did more damage than a 30 m/s one, and a disarmed 50 m/s wall hit did no damage at all.
import { describe, expect, test } from 'vitest';
import { PRESETS } from '../src/builder/derive';
import { Prim } from '../src/maps/world';
import { qFromEuler, Rng } from '../src/sim/math';
import { QuadSim } from '../src/sim/quad';
import { damageOf, DT, rig, run } from './helpers/scenarios';

const wall: Prim = { kind: 'box', c: { x: 1.3, y: 0, z: 2 }, half: { x: 0.3, y: 5, z: 3 }, yaw: 0, mat: 'concrete' };
const FIVE = PRESETS[0], WHOOP = PRESETS.find((p) => p.name.includes('65 mm'))!;

/** N wall hits at speed v with randomised attitude; motors spun up at `thr` (0 = disarmed). */
function wallHits(v: number, thr: number, N = 12, spec = FIVE) {
  const g = new Rng(5), out: QuadSim[] = [];
  for (let n = 0; n < N; n++) {
    const r = rig([wall], 'concrete', spec);
    (r.q as unknown as { rng: Rng }).rng = new Rng(100 + n);
    r.q.reset({ x: 0, y: 0, z: 2 });
    r.q.s.q = qFromEuler((g.next() - 0.5) * 0.6, (g.next() - 0.3) * 0.8, (g.next() - 0.5) * 1.2);
    r.q.s.vel = { x: v, y: 0, z: 0 };
    for (const m of r.q.motors) m.s.omega = thr ? 2500 : 0;
    run(r.q, r.env, 0.3, thr);
    out.push(r.q);
  }
  const frac = (f: (q: QuadSim) => boolean) => out.filter(f).length / N;
  return {
    broken: frac((q) => damageOf(q).broken > 0),
    bent: frac((q) => q.motorDamage.some((m) => m.shaftBend > 0)),
    thrustLoss: out.reduce((a, q) => a + 1 - damageOf(q).thrust, 0) / N,
    quads: out,
  };
}

describe('energy-based crash damage', () => {
  test('30 m/s concrete hit at throttle breaks props and often bends a motor', () => {
    const d = wallHits(30, 900);
    expect(d.broken).toBeGreaterThan(0.8);
    expect(d.thrustLoss).toBeGreaterThan(0.5);
    expect(d.bent).toBeGreaterThan(0.4);
  });
  test('damage grows with impact speed (5 m/s < 15 m/s < 30 m/s)', () => {
    const a = wallHits(5, 900), b = wallHits(15, 900), c = wallHits(30, 900);
    expect(a.broken).toBeLessThan(0.5);   // a 5" survives a gentle bump most of the time
    expect(b.broken).toBeGreaterThan(0.6); // props usually break on concrete above ~15 m/s
    expect(a.broken).toBeLessThanOrEqual(b.broken);
    expect(a.bent).toBeLessThan(c.bent);
    expect(b.bent).toBeLessThan(c.bent);
  });
  test('a disarmed 50 m/s wall hit still wrecks props (frame and prop spheres take the energy)', () => {
    const d = wallHits(50, 0, 6);
    expect(d.broken).toBe(1);
    expect(d.bent).toBeGreaterThan(0.5);
  });
  test('tiny whoops (ducted, no prop colliders) are near-immune', () => {
    const d = wallHits(10, 900, 8, WHOOP);
    expect(d.broken).toBe(0);
    expect(d.bent).toBe(0);
  });
  test('5" touchdowns on grass at 10 m/s mostly survive', () => {
    let ok = 0;
    const g = new Rng(9);
    for (let n = 0; n < 10; n++) {
      const r = rig([], 'grass');
      (r.q as unknown as { rng: Rng }).rng = new Rng(200 + n);
      r.q.reset({ x: 0, y: 0, z: 0.3 }); r.q.s.q = qFromEuler(0, 0.2 + g.next() * 0.5, 0);
      r.q.s.vel = { x: 9, y: 0, z: -4 };
      for (const m of r.q.motors) m.s.omega = 2000;
      run(r.q, r.env, 1, 600);
      if (!damageOf(r.q).broken && !r.q.motorDamage.some((m) => m.shaftBend > 0)) ok++;
    }
    expect(ok).toBeGreaterThanOrEqual(7);
  });
  test('a bent shaft adds 1x-rpm imbalance that reaches the IMU; repair() restores everything', () => {
    const d = wallHits(40, 900, 6);
    const q = d.quads.find((x) => x.motorDamage.some((m) => m.shaftBend > 0))!;
    expect(q).toBeDefined();
    const k = q.motorDamage.findIndex((m) => m.shaftBend > 0);
    expect(q.aero[k].damage.imbalance).toBeGreaterThan(5 * (q.p.rotors[k].imbalance ?? 2e-7));
    expect(q.damageLog.some((e) => e.part === 'shaft' && e.rotor === k)).toBe(true);
    // vibration: compare accelerometer noise of the damaged vs a repaired quad, spun up and held
    const accNoise = (x: QuadSim) => {
      const env = rig([]).env;
      x.reset({ x: 0, y: 0, z: 5 });
      let s1 = 0, s2 = 0, n = 0;
      for (let i = 0; i < 4000; i++) {
        x.command([700, 700, 700, 700], false); x.step(DT, env);
        x.s.pos = { x: 0, y: 0, z: 5 }; x.s.vel = { x: 0, y: 0, z: 0 }; x.s.w = { x: 0, y: 0, z: 0 }; x.s.q = { w: 1, x: 0, y: 0, z: 0 };
        if (i > 2000) { const a = x.imu.accOut.y; s1 += a; s2 += a * a; n++; }
      }
      return Math.sqrt(s2 / n - (s1 / n) ** 2);
    };
    for (const a of q.aero) a.damage.broken = false; // isolate the shaft / imbalance effect
    const noisy = accNoise(q);
    q.repair();
    expect(q.motorDamage.every((m) => m.shaftBend === 0 && m.armBendDeg === 0)).toBe(true);
    expect(q.p.rotors.every((r) => Math.abs(r.axis.z) > 0.99)).toBe(true);
    const clean = accNoise(q);
    expect(noisy).toBeGreaterThan(2 * clean);
  });
});
