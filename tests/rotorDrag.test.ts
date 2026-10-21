// Rotor in edgewise flow: rotor drag (BEMT H + flapping), rigid-blade hub moments with the
// flapping lag, and what they do to the airframe (blowback, yaw damping).
import { describe, expect, test } from 'vitest';
import { buildDrone, DEFAULT_SPEC, PRESETS } from '../src/builder/derive';
import { GroundPlane } from '../src/sim/contact';
import { QuadEnv, QuadSim } from '../src/sim/quad';
import { RotorAero, emptyRotorOut } from '../src/sim/rotor';
import { WakeField } from '../src/sim/wake';
import { Wind } from '../src/sim/wind';

const DT = 1 / 8000;
const calmEnv = (): QuadEnv => ({
  world: new GroundPlane(), wind: new Wind({ speed20ft: 0, directionDeg: 0, z0: 0.03, turbulence: 0, gustiness: 0, gustMax: 0 }),
  wake: new WakeField(), ambientC: 20, altitudeOffset: 0, damageEnabled: false,
});
const D = (t: number) => 48 + Math.round(t * 1999);

function rotorAt(spec: typeof DEFAULT_SPEC, omega: number, vip: number) {
  const b = buildDrone(spec), rc = b.params.rotors[0], a = new RotorAero(rc.table, 1), o = emptyRotorOut();
  a.ductGain = rc.ductGain ?? 0; a.lock = rc.lock!; a.flapHz = rc.flapHz!;
  a.evaluate(omega, 0, vip, 1.225, Infinity, 0, DT, o);
  return { o, R: rc.table.R, b };
}

describe('rotor drag and hub moments', () => {
  const b5 = buildDrone(DEFAULT_SPEC), wh = (b5.info.hoverRpm * Math.PI) / 30, wot = (b5.info.wotRpm * Math.PI) / 30;
  test('rotor drag ≈ 0.04 N/(m/s) per 5" rotor at hover rpm, ∝ rpm, far less on a tiny whoop', () => {
    const h = rotorAt(DEFAULT_SPEC, wh, 2).o.hForce / 2;
    expect(h).toBeGreaterThan(0.033); expect(h).toBeLessThan(0.047);
    const h2 = rotorAt(DEFAULT_SPEC, 2 * wh, 2).o.hForce / 2;
    expect(h2 / h).toBeGreaterThan(1.7); expect(h2 / h).toBeLessThan(2.3);
    const w = PRESETS.find((p) => p.name.includes('65 mm'))!;
    expect(rotorAt(w, (buildDrone(w).info.hoverRpm * Math.PI) / 30, 2).o.hForce / 2).toBeLessThan(0.012);
  });

  test('rigid-blade hub moment ≈ T·R·μ; the skewed wake adds blowback; the flapping lag grows with rpm', () => {
    const lo = rotorAt(DEFAULT_SPEC, wh, 3), mid = rotorAt(DEFAULT_SPEC, wh, 10);
    const mu = 3 / (wh * lo.R);
    const k = lo.o.mAdv / (lo.o.thrust * lo.R * mu);
    expect(k).toBeGreaterThan(0.8); expect(k).toBeLessThan(1.4);
    expect(lo.o.mFront).toBeGreaterThan(0); expect(mid.o.mFront).toBeGreaterThan(lo.o.mFront);
    const lagH = lo.o.flapLag, lagW = rotorAt(DEFAULT_SPEC, wot, 3).o.flapLag;
    expect(lagH).toBeGreaterThan(0); expect(lagW).toBeGreaterThan(3 * lagH); expect(lagW).toBeLessThan((40 * Math.PI) / 180);
  });

  test('level forward flight pitches the nose up, more at high power; the CW / CCW roll moments cancel', () => {
    const torque = (thr: number, v: number) => {
      const q = new QuadSim(b5.params, 8000), env = calmEnv();
      q.reset({ x: 0, y: 0, z: 20 });
      let ty = 0, tx = 0, n = 0;
      for (let i = 0; i < 3000; i++) {
        q.command([D(thr), D(thr), D(thr), D(thr)], false);
        q.s.w = { x: 0, y: 0, z: 0 }; q.s.q = { w: 1, x: 0, y: 0, z: 0 }; q.s.vel = { x: v, y: 0, z: 0 }; q.s.pos = { x: 0, y: 0, z: 20 };
        q.step(DT, env);
        if (i > 1500) { ty += (q.s.w.y / DT) * b5.params.inertia.yy; tx += (q.s.w.x / DT) * b5.params.inertia.xx; n++; }
      }
      return { pitch: ty / n, roll: tx / n };
    };
    const t0 = torque(b5.info.hoverThrottle, 0), t10 = torque(b5.info.hoverThrottle, 10), p10 = torque(0.6, 10);
    expect(t10.pitch - t0.pitch).toBeLessThan(-0.005); // N·m, nose up (FLU: −y)
    expect(p10.pitch - t0.pitch).toBeLessThan(3 * (t10.pitch - t0.pitch));
    expect(Math.abs(t10.roll)).toBeLessThan(0.002);
  });

  test('open-loop full-differential yaw saturates within ~3 s (rotor drag, air-relative prop speed)', () => {
    const q = new QuadSim(b5.params, 8000), env = calmEnv();
    q.reset({ x: 0, y: 0, z: 10 });
    const cmd = q.p.rotors.map((r) => (r.dir === -1 ? 2047 : D(0.055)));
    const rate: number[] = [];
    for (let i = 1; i <= 8000 * 3; i++) {
      q.command(cmd, false); q.step(DT, env);
      q.s.w.x = q.s.w.y = 0; const yaw = 2 * Math.atan2(q.s.q.z, q.s.q.w); q.s.q = { w: Math.cos(yaw / 2), x: 0, y: 0, z: Math.sin(yaw / 2) };
      q.s.vel = { x: 0, y: 0, z: 0 }; q.s.pos = { x: 0, y: 0, z: 10 };
      if (i % 8000 === 0) rate.push((q.s.w.z * 180) / Math.PI);
    }
    expect(rate[2]).toBeGreaterThan(5000); expect(rate[2]).toBeLessThan(9500); // was ~11,600 °/s, still rising
    expect(Math.abs(rate[2] - rate[1]) / rate[2]).toBeLessThan(0.05);
  });
});
