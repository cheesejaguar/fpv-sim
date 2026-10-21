// ESC / motor behaviour beyond the DC-machine model: the optional bus-current limiter, low-rpm
// power protection, desyncs, and what overheating does to magnets and windings.
import { describe, expect, test } from 'vitest';
import { buildDrone, DEFAULT_SPEC } from '../src/builder/derive';
import { GroundPlane } from '../src/sim/contact';
import { Motor, MotorParams } from '../src/sim/motor';
import { QuadEnv, QuadSim } from '../src/sim/quad';
import { WakeField } from '../src/sim/wake';
import { Wind } from '../src/sim/wind';

const DT = 1 / 8000;
const calmEnv = (): QuadEnv => ({
  world: new GroundPlane(), wind: new Wind({ speed20ft: 0, directionDeg: 0, z0: 0.03, turbulence: 0, gustiness: 0, gustMax: 0 }),
  wake: new WakeField(), ambientC: 20, altitudeOffset: 0, damageEnabled: false,
});
const build = buildDrone(DEFAULT_SPEC);
const rc = build.params.rotors[0];
const IDLE = 48 + Math.round(0.055 * 1999);

/** One motor driving the 5" prop's static load on a stiff 24 V bus. */
function bench(over: Partial<MotorParams> = {}) {
  const m = new Motor({ ...rc.motor, ...over }, 20, 3);
  const kQ = rc.table.kQ;
  const step = (cmd: number, V = 24, extra = 0) => { m.command(cmd, false); m.step(V, kQ * m.s.omega * Math.abs(m.s.omega) + extra, rc.propInertia, DT, 20, 0); };
  const run = (cmd: number, s: number, V = 24) => { for (let i = 0; i < s / DT; i++) step(cmd, V); };
  return { m, step, run };
}

describe('ESC current limit', () => {
  test('ships off: no clamp on the phase current', () => {
    expect(build.params.rotors.every((r) => r.motor.escCurrentLimitA === 0)).toBe(true);
  });

  test('when enabled, a PI on the bus current pulls it back to the limit within ~20-60 ms (no instant clamp)', () => {
    const lim = 35;
    const b = buildDrone({ ...DEFAULT_SPEC, overrides: { escCurrentLimitA: lim } });
    const q = new QuadSim(b.params, 8000), env = calmEnv();
    q.reset({ x: 0, y: 0, z: 5 });
    const hold = () => { q.s.w = { x: 0, y: 0, z: 0 }; q.s.q = { w: 1, x: 0, y: 0, z: 0 }; q.s.vel = { x: 0, y: 0, z: 0 }; q.s.pos = { x: 0, y: 0, z: 5 }; };
    for (let i = 0; i < 4000; i++) { q.command([IDLE, IDLE, IDLE, IDLE], false); q.step(DT, env); hold(); }
    let peak = 0, tOver = -1, back = -1, lo = Infinity, hi = 0;
    for (let i = 0; i < 0.5 / DT; i++) {
      q.command([2047, 2047, 2047, 2047], false); q.step(DT, env); hold();
      const ib = q.motors[0].s.busCurrent;
      peak = Math.max(peak, ib);
      if (tOver < 0 && ib > 1.1 * lim) tOver = i * DT;
      if (tOver >= 0 && back < 0 && ib < 1.1 * lim) back = i * DT;
      if (i * DT > 0.15) { lo = Math.min(lo, ib); hi = Math.max(hi, ib); }
    }
    expect(peak).toBeGreaterThan(1.5 * lim);              // the inrush overshoots for a few ms ...
    expect(back - tOver).toBeGreaterThan(0.01); expect(back - tOver).toBeLessThan(0.06); // ... then the loop catches it
    expect(lo).toBeGreaterThan(0.85 * lim); expect(hi).toBeLessThan(1.1 * lim); // and holds it, no hunting
    expect(q.motors[0].s.dutyCeil).toBeLessThan(0.97);
  });

  test('low-rpm power protection: a stalled motor at full command cannot pull its stall current', () => {
    const { m, step } = bench();
    for (let i = 0; i < 200; i++) { step(2047); m.s.omega = 0; } // prop jammed
    const stall = 24 / m.rEff();
    expect(m.s.current).toBeGreaterThan(0.15 * stall); expect(m.s.current).toBeLessThan(0.3 * stall);
  });
});

describe('ESC desync', () => {
  test('a hard chop at high rpm can desync: the motor stalls 50-300 ms, then restarts', () => {
    const { m, run, step } = bench({ desyncRisk: 1e6 });
    run(2047, 0.25);
    const wTop = m.s.omega;
    let stall = 0;
    for (let i = 0; i < 0.6 / DT; i++) { const out = m.s.desyncT > 0; step(IDLE); if (out) { stall += DT; expect(m.s.current).toBe(0); } }
    expect(m.s.desyncs).toBe(1);
    expect(stall).toBeGreaterThan(0.05); expect(stall).toBeLessThan(0.3);
    run(IDLE, 0.3); // re-synced and driven again: idle speed, not coasting to a stop
    expect(m.s.desyncT).toBe(0); expect(m.s.omega).toBeGreaterThan(150); expect(m.s.omega).toBeLessThan(0.3 * wTop);
  });

  test('gradual throttle cuts and low-rpm chops never desync; default risk keeps hard chops rarely affected', () => {
    const a = bench({ desyncRisk: 1e6 });
    for (let k = 0; k < 10; k++) { a.run(2047, 0.15); for (let i = 0; i < 0.25 / DT; i++) a.step(Math.round(2047 - (2047 - IDLE) * Math.min(1, (i * DT) / 0.2))); }
    a.run(48 + 600, 0.2); for (let i = 0; i < 0.2 / DT; i++) a.step(IDLE); // chop from 30 %: rpm too low
    expect(a.m.s.desyncs).toBe(0);
    const d = bench();
    for (let k = 0; k < 300; k++) { d.run(2047, 0.12); d.run(IDLE, 0.12); }
    expect(d.m.s.desyncs).toBeLessThan(15); // ~1 % of full chops on a typical modern ESC + motor
  });

  test('a prop strike that brakes the rotor can throw it out of sync', () => {
    const { m } = bench({ desyncRisk: 1e6 });
    m.strike(0.02); expect(m.s.desyncs).toBe(0); // a twig: no
    m.strike(0.6); expect(m.s.desyncs).toBe(1); expect(m.s.desyncT).toBeGreaterThan(0);
  });
});

describe('motor overheating', () => {
  test('magnets lose Kt for good above ~120 °C; windings burn out above ~180 °C', () => {
    // a fast-heating bench motor (small heat capacity) at WOT
    const { m, run } = bench({ thermalCapJPerK: 2 });
    const kt0 = m.kt();
    run(2047, 0.1);
    expect(m.s.ktHealth).toBe(1);
    while (m.s.tempC < 150) run(2047, 0.001);
    expect(m.s.ktHealth).toBeCloseTo(1 - 0.006 * (m.s.peakC - 120), 6);
    expect(m.s.ktHealth).toBeLessThan(0.86); expect(m.s.ktHealth).toBeGreaterThan(0.78);
    // cooled back to ambient the loss stays (irreversible, unlike the reversible tempco)
    const cool = bench();
    cool.m.s.ktHealth = m.s.ktHealth;
    expect(cool.m.kt()).toBeLessThan(0.87 * kt0);
    expect(m.s.burnt).toBe(false);
    while (m.s.tempC < 185) run(2047, 0.001);
    run(2047, 2);
    expect(m.s.burnt).toBe(true);
    run(2047, 1);
    expect(m.s.current).toBe(0); expect(m.s.omega).toBeLessThan(50); // stopped despite full throttle
    // a repair (new motors) restores them
    const q = new QuadSim(build.params, 8000);
    q.motors[0].s.burnt = true; q.motors[0].s.ktHealth = 0.7;
    q.repair();
    expect(q.motors[0].s.burnt).toBe(false); expect(q.motors[0].s.ktHealth).toBe(1);
  });

  test('a hard freestyle flight stays clear of the damage thresholds; a minute of WOT on the bench does not', () => {
    // flying: punches on a sagging pack with the airspeed they bring, ~30 % throttle in between
    const { m } = bench(), kQ = rc.table.kQ;
    const fly = (cmd: number, s: number, V: number, air: number) => { for (let i = 0; i < s / DT; i++) { m.command(cmd, false); m.step(V, kQ * m.s.omega * Math.abs(m.s.omega), rc.propInertia, DT, 20, air); } };
    for (let k = 0; k < 20; k++) { fly(2047, 1.5, 20.5, 20); fly(48 + 600, 3, 23.5, 12); } // 30 s of punches in 90 s
    expect(m.s.peakC).toBeLessThan(100); expect(m.s.ktHealth).toBe(1);
    // a static thrust-stand run at full power on a stiff supply cooks it
    const b = bench();
    b.run(2047, 30);
    expect(b.m.s.peakC).toBeGreaterThan(130); expect(b.m.s.ktHealth).toBeLessThan(1);
  });
});
