// LiPo pack behaviour: pulse response (fast charge-transfer branch), cell-to-cell scatter, cold
// capacity derating, irreversible damage from overheating.
import { describe, expect, test } from 'vitest';
import { buildDrone, DEFAULT_SPEC, PRESETS } from '../src/builder/derive';
import { Battery, batteryFromSpec, coldUnavailable } from '../src/sim/battery';

const DT = 1 / 8000;
const pack = (seed = 1) => batteryFromSpec({ chemistry: 'LiPo', cells: 6, capacityMah: 1300, cRating: 120, irPerCellMohm: 3.0, massG: 215, seed });
const hold = (b: Battery, I: number, s: number, tempC?: number) => { for (let i = 0; i < s / DT; i++) { b.step(I, DT, 20, 15); if (tempC != null) b.s.tempC = tempC; } };

describe('LiPo pack dynamics', () => {
  test('a punch drops by the ohmic part at once, sags a little more over ~0.1 s, and mostly recovers within 0.3 s', () => {
    const b = new Battery(pack(), 0.8, 20);
    hold(b, 0.5, 2);
    const ocv = b.s.voltage;
    hold(b, 150, 0.001); const v1 = b.s.voltage;
    hold(b, 150, 0.15); const v2 = b.s.voltage;
    hold(b, 150, 0.35); const vEnd = b.s.voltage;
    const fast = (v1 - v2) / (ocv - v1);
    expect(fast).toBeGreaterThan(0.25); expect(fast).toBeLessThan(0.7);
    hold(b, 0.5, 0.3);
    const rec = (b.s.voltage - vEnd) / (b.s.ocvPack - vEnd);
    expect(rec).toBeGreaterThan(0.85);
    expect(rec).toBeLessThan(0.99); // the slow (polarisation / diffusion) part takes seconds
  });

  test('cells are not identical: seeded per build, ±5 %, the weakest cell sags and empties first', () => {
    const a = new Battery(pack(7)), a2 = new Battery(pack(7)), c = new Battery(pack(8));
    hold(a, 40, 0.2); hold(a2, 40, 0.2); hold(c, 40, 0.2);
    expect(a.s.cellV).toEqual(a2.s.cellV);
    expect(a.s.cellV).not.toEqual(c.s.cellV);
    const spread = (b: Battery) => Math.max(...b.s.cellV) - Math.min(...b.s.cellV);
    expect(spread(a)).toBeGreaterThan(0.002); expect(spread(a)).toBeLessThan(0.05);
    // run it down: near empty one cell dives well below the others
    while (a.s.soc > 0.02) hold(a, 30, 0.5);
    expect(a.minCellVoltage()).toBeLessThan(a.cellVoltage() - 0.04);
    expect(a.minCellVoltage()).toBeGreaterThan(2.5);
    // per-build seeds differ
    const s1 = buildDrone(DEFAULT_SPEC).params.battery.seed, s2 = buildDrone(PRESETS[3]).params.battery.seed;
    expect(s1).toBe(buildDrone(DEFAULT_SPEC).params.battery.seed);
    expect(s1).not.toBe(s2);
  });

  test('a cold pack delivers ~15 % less before its voltage collapses (0 °C vs 20 °C)', () => {
    expect(coldUnavailable(0)).toBeCloseTo(0.15, 3); expect(coldUnavailable(25)).toBe(0);
    const delivered = (tempC: number) => {
      const b = new Battery(pack(), 1, tempC);
      while (b.cellVoltage() > 3.3) hold(b, 10, 1, tempC);
      return b.s.mAhDrawn;
    };
    const warm = delivered(20), cold = delivered(0);
    expect(cold / warm).toBeGreaterThan(0.78); expect(cold / warm).toBeLessThan(0.9);
  }, 30000);

  test('overheating above ~70 °C raises the resistance for good', () => {
    const b = new Battery(pack(), 0.7, 20);
    const r0 = b.thevenin().rth;
    hold(b, 2, 60, 85); // a minute at 85 °C
    b.s.tempC = 20;
    const r1 = b.thevenin().rth;
    expect(b.s.heatDamage).toBeGreaterThan(0.3);
    expect(r1 / r0).toBeGreaterThan(1.25);
    const ok = new Battery(pack(), 0.7, 20);
    hold(ok, 2, 60, 60); // hot but below the threshold: no lasting harm
    expect(ok.s.heatDamage).toBe(0);
  });
});
