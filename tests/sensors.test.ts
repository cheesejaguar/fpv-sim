// IMU: per-build accelerometer offsets / board misalignment, and the raw gyro vibration spectrum
// (per-arm detuned frame modes, broadband floor rising with rpm²).
import { describe, expect, test } from 'vitest';
import { buildDrone, DEFAULT_SPEC, PRESETS } from '../src/builder/derive';
import { GroundPlane } from '../src/sim/contact';
import { G0 } from '../src/sim/atmosphere';
import { GYRO_CHIPS, Imu } from '../src/sim/imu';
import { QuadEnv, QuadSim } from '../src/sim/quad';
import { WakeField } from '../src/sim/wake';
import { Wind } from '../src/sim/wind';

const DT = 1 / 8000;
const calmEnv = (): QuadEnv => ({
  world: new GroundPlane(), wind: new Wind({ speed20ft: 0, directionDeg: 0, z0: 0.03, turbulence: 0, gustiness: 0, gustMax: 0 }),
  wake: new WakeField(), ambientC: 20, altitudeOffset: 0, damageEnabled: false,
});

describe('accelerometer calibration errors', () => {
  test('each build has its own 20-60 mg offsets and a 0.5-2° board misalignment', () => {
    const flex = buildDrone(DEFAULT_SPEC).params.flex;
    const seeds = [buildDrone(DEFAULT_SPEC).params.seed!, buildDrone(PRESETS[3]).params.seed!, 5, 6, 7];
    const tilts: number[] = [];
    for (const seed of seeds) {
      const imu = new Imu(GYRO_CHIPS.ICM42688P, 8000, flex, seed);
      for (const b of imu.accBias) { expect(Math.abs(b) / G0 * 1000).toBeGreaterThanOrEqual(20); expect(Math.abs(b) / G0 * 1000).toBeLessThanOrEqual(60); }
      expect(imu.misalignRad * 180 / Math.PI).toBeGreaterThanOrEqual(0.5); expect(imu.misalignRad * 180 / Math.PI).toBeLessThanOrEqual(2);
      // sitting level and still, the accelerometer reports a small false tilt (what BF's acc calibration zeroes)
      const z = { x: 0, y: 0, z: 0 };
      for (let i = 0; i < 4000; i++) imu.sample(z, { x: 0, y: 0, z: G0 }, z, z, 0.6, DT);
      const a = imu.accOut, tilt = Math.atan2(Math.hypot(a.x, a.y), a.z) * 180 / Math.PI;
      expect(tilt).toBeGreaterThan(0.3); expect(tilt).toBeLessThan(6);
      tilts.push(tilt);
    }
    expect(new Set(tilts.map((t) => t.toFixed(3))).size).toBe(tilts.length);
    // same build, same errors
    const s = seeds[0], i1 = new Imu(GYRO_CHIPS.ICM42688P, 8000, flex, s), i2 = new Imu(GYRO_CHIPS.ICM42688P, 8000, flex, s);
    expect(i1.accBias).toEqual(i2.accBias); expect(i1.align).toEqual(i2.align);
  });

  test('the misaligned board leaks yaw rate into the roll / pitch gyro', () => {
    const imu = new Imu(GYRO_CHIPS.ICM42688P, 8000, buildDrone(DEFAULT_SPEC).params.flex, 11);
    const z = { x: 0, y: 0, z: 0 }, w = { x: 0, y: 0, z: 10 };
    for (let i = 0; i < 2000; i++) imu.sample(w, { x: 0, y: 0, z: G0 }, z, z, 0.6, DT);
    const leak = Math.hypot(imu.gyroOut.x, imu.gyroOut.y) / 10;
    expect(leak).toBeGreaterThan(Math.sin(0.4 * imu.misalignRad)); expect(leak).toBeLessThan(Math.sin(imu.misalignRad) + 0.02);
  });
});

/** Raw gyro RMS (°/s) per axis with the frame held level at fixed motor commands (rigid-body rate 0). */
function vibration(spec: typeof DEFAULT_SPEC, thr: number) {
  const b = buildDrone(spec), q = new QuadSim(b.params, 8000), env = calmEnv();
  q.reset({ x: 0, y: 0, z: 20 });
  const d = 48 + Math.round(thr * 1999);
  const acc = [0, 0, 0], sum = [0, 0, 0]; let n = 0;
  for (let i = 0; i < 2500 + 6000; i++) {
    q.command([d, d, d, d], false); q.step(DT, env);
    q.s.w = { x: 0, y: 0, z: 0 }; q.s.q = { w: 1, x: 0, y: 0, z: 0 }; q.s.vel = { x: 0, y: 0, z: 0 }; q.s.pos = { x: 0, y: 0, z: 20 };
    if (i >= 2500) { const g = q.imu.gyroOut; [g.x, g.y, g.z].forEach((v, k) => { acc[k] += v * v; sum[k] += v; }); n++; }
  }
  return acc.map((s2, k) => Math.sqrt(s2 / n - (sum[k] / n) ** 2) * 180 / Math.PI);
}

describe('raw gyro vibration', () => {
  test('5": rises with throttle (~1-2 °/s hover, ~5-12 °/s full), no resonance spike at hover, yaw quietest', () => {
    const hover = buildDrone(DEFAULT_SPEC).info.hoverThrottle;
    const thr = [0.2, hover, 0.3, 0.4, 0.55, 0.7, 0.85, 1];
    const r = thr.map((t) => vibration(DEFAULT_SPEC, t));
    const rp = r.map((v) => (v[0] + v[1]) / 2);
    expect(rp[1]).toBeGreaterThan(0.8); expect(rp[1]).toBeLessThan(2.2);
    expect(rp[7]).toBeGreaterThan(4.5); expect(rp[7]).toBeLessThan(12);
    for (let k = 3; k < thr.length; k++) expect(rp[k], `${thr[k]}`).toBeGreaterThan(rp[k - 1]);
    // the hover point (1x rpm on the frame modes) is a bump at most, not a spike
    expect(rp[1]).toBeLessThan(1.5 * Math.max(rp[0], rp[2]));
    for (const v of r) expect(v[2]).toBeLessThan(Math.min(v[0], v[1]));
  }, 60000);

  test('a tiny whoop is noisier than the 5" at hover, but sane', () => {
    const w = PRESETS.find((p) => p.name.includes('65 mm'))!;
    const h5 = vibration(DEFAULT_SPEC, buildDrone(DEFAULT_SPEC).info.hoverThrottle), hw = vibration(w, buildDrone(w).info.hoverThrottle), fw = vibration(w, 1);
    expect((hw[0] + hw[1]) / 2).toBeGreaterThan((h5[0] + h5[1]) / 2);
    expect(Math.max(...fw)).toBeLessThan(15);
  }, 60000);
});
