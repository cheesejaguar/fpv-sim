// Validation of the generated flight model against published / measured FPV quad behaviour.
import { describe, expect, test } from 'vitest';
import { buildDrone, DEFAULT_SPEC, PRESETS } from '../src/builder/derive';
import { Battery, batteryFromSpec, ocvPerCell } from '../src/sim/battery';
import { bemtSolve, DEFAULT_AIRFOIL } from '../src/sim/bemt';
import { GroundPlane } from '../src/sim/contact';
import { QuadEnv, QuadSim } from '../src/sim/quad';
import { WakeField } from '../src/sim/wake';
import { Wind } from '../src/sim/wind';

const calmEnv = (): QuadEnv => ({
  world: new GroundPlane(), wind: new Wind({ speed20ft: 0, directionDeg: 0, z0: 0.03, turbulence: 0, gustiness: 0, gustMax: 0 }),
  wake: new WakeField(), ambientC: 20, altitudeOffset: 0, damageEnabled: false,
});
const DT = 1 / 8000;
const holdLevel = (q: QuadSim) => { q.s.w.x = q.s.w.y = q.s.w.z = 0; q.s.q = { w: 1, x: 0, y: 0, z: 0 }; };

describe('BEMT propeller', () => {
  const g = { diameterM: 0.127, pitchM: 4.3 * 0.0254, blades: 3, hubRadiusFrac: 0.14, chordFracs: [0.17, 0.21, 0.22, 0.2, 0.17, 0.13, 0.07], washoutDeg: 0, airfoil: DEFAULT_AIRFOIL };
  test('static thrust scales ~ omega^2', () => {
    const a = bemtSolve(g, 1.225, 1000, 0, 0).T, b = bemtSolve(g, 1.225, 2000, 0, 0).T;
    expect(b / a).toBeGreaterThan(3.6); expect(b / a).toBeLessThan(4.4);
  });
  test('axial climb reduces thrust; edgewise flow adds H-force', () => {
    const w = 2000;
    const t0 = bemtSolve(g, 1.225, w, 0, 0), tc = bemtSolve(g, 1.225, w, 15, 0), te = bemtSolve(g, 1.225, w, 0, 20);
    expect(tc.T).toBeLessThan(t0.T * 0.9);
    expect(te.H).toBeGreaterThan(0.2);
  });
  test('figure of merit physically plausible (0.35..0.8)', () => {
    const w = 2900, r = bemtSolve(g, 1.225, w, 0, 0);
    const A = Math.PI * 0.0635 ** 2, ideal = r.T ** 1.5 / Math.sqrt(2 * 1.225 * A);
    const fom = ideal / (r.Q * w);
    expect(fom).toBeGreaterThan(0.35); expect(fom).toBeLessThan(0.8);
  });
});

describe('LiPo battery', () => {
  test('OCV table endpoints', () => {
    expect(ocvPerCell('LiPo', 1)).toBeCloseTo(4.2, 2);
    expect(ocvPerCell('LiPo', 0.5)).toBeCloseTo(3.84, 2);
  });
  test('6S1300 sags ~1.5-3.5 V at 100 A', () => {
    const b = new Battery(batteryFromSpec({ chemistry: 'LiPo', cells: 6, capacityMah: 1300, cRating: 120, irPerCellMohm: 3.0, massG: 215 }));
    for (let i = 0; i < 8000; i++) b.step(100, DT, 20, 20); // 1 s
    expect(b.s.sagV).toBeGreaterThan(1.5); expect(b.s.sagV).toBeLessThan(3.5);
    expect(b.s.mAhDrawn).toBeCloseTo(27.8, 0);
  });
});

describe('generated 5" 6S freestyle quad', () => {
  const build = buildDrone(DEFAULT_SPEC);
  test('mass and inertia in realistic ranges', () => {
    expect(build.info.auwG).toBeGreaterThan(520); expect(build.info.auwG).toBeLessThan(720);
    expect(build.params.inertia.xx).toBeGreaterThan(8e-4); expect(build.params.inertia.xx).toBeLessThan(2e-3);
    expect(build.params.inertia.zz).toBeGreaterThan(build.params.inertia.xx);
  });
  test('thrust-to-weight 7..13 and static thrust 1.2..1.8 kgf/motor', () => {
    expect(build.info.thrustToWeight).toBeGreaterThan(7); expect(build.info.thrustToWeight).toBeLessThan(13);
    expect(build.info.staticThrustN / 9.81).toBeGreaterThan(1.2); expect(build.info.staticThrustN / 9.81).toBeLessThan(1.8);
  });
  test('closed-loop hover: 17..35 % throttle, 140..320 W/kg', () => {
    const q = new QuadSim(build.params, 8000); const env = calmEnv();
    q.reset({ x: 0, y: 0, z: 0.05 });
    let integ = 0, thr = 0.2;
    for (let i = 0; i < 8000 * 6; i++) {
      const zErr = 2 - q.s.pos.z; integ += zErr * DT * 0.05;
      thr = Math.max(0.05, Math.min(1, 0.2 + integ + 0.08 * zErr - 0.08 * q.s.vel.z));
      const d = Math.round(48 + thr * 1999); q.command([d, d, d, d], false); q.step(DT, env); holdLevel(q);
    }
    expect(thr).toBeGreaterThan(0.17); expect(thr).toBeLessThan(0.35);
    const wPerKg = (q.s.vbus * q.s.ibus) / build.params.mass;
    expect(wPerKg).toBeGreaterThan(140); expect(wPerKg).toBeLessThan(320);
  });
  test('punch-out: 120..220 A, voltage sags but stays above 3.2 V/cell, motor tau 15..60 ms', () => {
    const q = new QuadSim(build.params, 8000); const env = calmEnv();
    q.reset({ x: 0, y: 0, z: 2 });
    const idle = 48 + Math.round(0.055 * 1999);
    for (let i = 0; i < 4000; i++) { q.command([idle, idle, idle, idle], false); q.step(DT, env); holdLevel(q); }
    const w0 = q.motors[0].s.omega;
    let t63 = -1, peakI = 0, minV = 99, wEnd = 0;
    const steps = 8000 * 0.5;
    const trace: number[] = [];
    for (let i = 0; i < steps; i++) { q.command([2047, 2047, 2047, 2047], false); q.step(DT, env); holdLevel(q); trace.push(q.motors[0].s.omega); peakI = Math.max(peakI, q.s.ibus); minV = Math.min(minV, q.s.vbus); }
    wEnd = trace[trace.length - 1];
    t63 = trace.findIndex((w) => w > w0 + 0.63 * (wEnd - w0)) * DT;
    expect(peakI).toBeGreaterThan(120); expect(peakI).toBeLessThan(230);
    expect(minV / 6).toBeGreaterThan(3.2);
    expect(t63).toBeGreaterThan(0.015); expect(t63).toBeLessThan(0.06);
  });
  test('yaw reaction: CW props spinning up yaw the frame CCW', () => {
    const q = new QuadSim(build.params, 8000); const env = calmEnv();
    q.reset({ x: 0, y: 0, z: 10 });
    const cw = q.p.rotors.map((r) => r.dir === -1);
    const cmd = cw.map((isCw) => (isCw ? 1400 : 48 + 110));
    for (let i = 0; i < 400; i++) { q.command(cmd, false); q.step(DT, env); q.s.w.x = q.s.w.y = 0; }
    expect(q.s.w.z).toBeGreaterThan(0); // +z yaw = CCW from above (nose left)
  });
});

test('all presets build and give sane hover throttle', () => {
  for (const p of PRESETS) {
    const b = buildDrone(p);
    expect(b.info.hoverThrottle, p.name).toBeGreaterThan(0.12);
    expect(b.info.hoverThrottle, p.name).toBeLessThan(0.5);
  }
});
