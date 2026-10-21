// Wind field realism: per-rotor gust gradients (turbulence rocks the attitude, not just the CG),
// Dryden driven by airspeed and height above the surface below, no gusts in calm air, directional
// obstacle wakes and indoor volumes.
import { describe, expect, test } from 'vitest';
import { bandoMap } from '../src/maps/maps';
import { Prim } from '../src/maps/world';
import { V3 } from '../src/sim/math';
import { Wind, WindParams } from '../src/sim/wind';
import { DT, rig } from './helpers/scenarios';

const windy = (turbulence: number, speed = 8): WindParams => ({ speed20ft: speed, directionDeg: 270, z0: 0.03, turbulence, gustiness: 0, gustMax: 0 });

/** Quad pinned level at 5 m with motors spinning; returns attitude-disturbance and rotor-wind stats. */
function pinned(turb: number) {
  const r = rig([], 'grass', undefined, false, windy(turb));
  r.q.reset({ x: 0, y: 0, z: 5 });
  let ax = 0, ay = 0, n = 0, s = 0, s2 = 0, nb = 0, dw = 0;
  for (let i = 0; i < 8000 * 5; i++) {
    r.q.command([600, 600, 600, 600], false); r.q.step(DT, r.env);
    ax += r.q.s.w.x / DT; ay += r.q.s.w.y / DT; n++;
    const d = r.q.rotorWind[0].z - r.q.rotorWind[3].z; dw += d * d;
    r.q.s.pos = { x: 0, y: 0, z: 5 }; r.q.s.vel = { x: 0, y: 0, z: 0 }; r.q.s.w = { x: 0, y: 0, z: 0 }; r.q.s.q = { w: 1, x: 0, y: 0, z: 0 };
    if (n === 80) { if (i > 8000) { const a = Math.hypot(ax, ay) / n; s += a; s2 += a * a; nb++; } ax = ay = 0; n = 0; }
  }
  return { accSd: Math.sqrt(s2 / nb - (s / nb) ** 2), rotorDw: Math.sqrt(dw / (8000 * 5)) };
}

describe('per-rotor wind', () => {
  test('turbulence differs between rotor hubs and rocks a pinned quad', () => {
    // old model: wind sampled at the CG only, so rotors saw the same gust
    const calm = pinned(0), turb = pinned(1);
    expect(calm.rotorDw).toBeLessThan(1e-9);
    expect(turb.rotorDw).toBeGreaterThan(0.1);   // ~0.2 m/s across 0.16 m in 8 m/s wind at 5 m
    expect(turb.rotorDw).toBeLessThan(0.6);
    // the response is limited by the rotor tables' small axial-inflow sensitivity (see rotor.ts)
    expect(turb.accSd).toBeGreaterThan(1.3 * calm.accSd);
  });

  test('Dryden gets airspeed (not ground speed) and the height above the roof below', () => {
    const roof: Prim = { kind: 'box', c: { x: 0, y: 0, z: 5 }, half: { x: 10, y: 10, z: 5 }, yaw: 0, mat: 'concrete' }; // roof at 10 m
    const r = rig([roof], 'grass', undefined, false, windy(1, 6));
    const seen: { alt: number; as: number }[] = [];
    const step = r.env.wind.step.bind(r.env.wind);
    r.env.wind.step = (dt: number, alt: number, as: number, dir?: V3) => { seen.push({ alt, as }); step(dt, alt, as, dir); };
    // hovering 1 m over the roof, still air relative to the ground -> airspeed = the wind
    r.q.reset({ x: 0, y: 0, z: 11 });
    r.q.command([0, 0, 0, 0], false); r.q.step(DT, r.env);
    const mean1 = r.env.wind.meanAt(1, { x: 0, y: 0, z: 0 }).x;
    expect(seen[0].alt).toBeCloseTo(1, 1);
    expect(seen[0].as).toBeCloseTo(mean1, 1);
    // flying downwind exactly at the wind speed: zero airspeed although the ground speed is high
    seen.length = 0;
    const r2 = rig([], 'grass', undefined, false, windy(1, 6));
    const step2 = r2.env.wind.step.bind(r2.env.wind);
    r2.env.wind.step = (dt: number, alt: number, as: number, dir?: V3) => { seen.push({ alt, as }); step2(dt, alt, as, dir); };
    r2.q.reset({ x: 0, y: 0, z: 20 });
    const m20 = r2.env.wind.meanAt(20, { x: 0, y: 0, z: 0 });
    r2.q.s.vel = { ...m20 };
    r2.q.command([0, 0, 0, 0], false); r2.q.step(DT, r2.env);
    expect(seen[0].as).toBeLessThan(0.1);
    expect(seen[0].alt).toBeCloseTo(20, 1);
  });

  test('no gusts in calm air', () => {
    const w = new Wind({ speed20ft: 0, directionDeg: 0, z0: 0.03, turbulence: 1, gustiness: 6, gustMax: 1 });
    const o = { x: 0, y: 0, z: 0 };
    let peak = 0;
    for (let i = 0; i < 1000 * 120; i++) { w.step(1e-3, 5, 0); w.at({ x: 0, y: 0, z: 5 }, o); peak = Math.max(peak, Math.hypot(o.x, o.y, o.z)); }
    expect(peak).toBe(0);
  });
});

describe('obstacle wakes and indoor air', () => {
  // building: footprint radius 10 m, 12 m tall at the origin; wind from the west (blows +x)
  const mk = (dir = 270) => {
    const w = new Wind({ speed20ft: 8, directionDeg: dir, z0: 0.03, turbulence: 0, gustiness: 0, gustMax: 0 }, 7);
    w.zones = [{ x: 0, y: 0, radius: 10, height: 12, intensity: 1.5 }];
    return w;
  };
  const stats = (w: Wind, p: V3) => {
    const o = { x: 0, y: 0, z: 0 };
    let s = 0, s2 = 0, sz = 0;
    const N = 60000;
    for (let i = 0; i < N; i++) { w.step(1e-3, p.z, 8); w.at(p, o); s += o.x; s2 += o.x * o.x; sz += o.z; }
    return { mean: s / N, sd: Math.sqrt(s2 / N - (s / N) ** 2), w: sz / N };
  };
  test('sheltered, gustier air downwind; untouched upwind; follows the wind direction', () => {
    const free = mk().meanAt(6, { x: 0, y: 0, z: 0 }).x;
    const lee = stats(mk(), { x: 25, y: 0, z: 6 }), up = stats(mk(), { x: -40, y: 0, z: 6 });
    expect(lee.mean / free).toBeGreaterThan(0.3); expect(lee.mean / free).toBeLessThan(0.65);
    expect(lee.sd).toBeGreaterThan(0.8);   // local turbulence, eddies ~ building height / 2
    expect(up.mean / free).toBeCloseTo(1, 2);
    expect(up.sd).toBeLessThan(1e-3);
    // wind from the east: the same point is now upwind and unaffected
    const flipped = stats(mk(90), { x: 25, y: 0, z: 6 });
    expect(Math.abs(flipped.mean) / free).toBeCloseTo(1, 2);
  });
  test('updraft at the windward roof edge, downdraft in the lee', () => {
    expect(stats(mk(), { x: -10, y: 0, z: 12.5 }).w).toBeGreaterThan(1);
    expect(stats(mk(), { x: 14, y: 0, z: 8 }).w).toBeLessThan(-0.5);
  });
  test('the Bando building interior is indoors (wind x 0.1)', () => {
    const m = bandoMap();
    const w = new Wind({ speed20ft: 8, directionDeg: 270, z0: 0.3, turbulence: 1, gustiness: 0, gustMax: 0 });
    w.zones = m.wakeZones; w.indoor = m.indoor ?? [];
    const o = { x: 0, y: 0, z: 0 };
    let inside = 0, outside = 0;
    for (let i = 0; i < 20000; i++) {
      w.step(1e-3, 2, 5);
      inside = Math.max(inside, Math.hypot(...Object.values(w.at({ x: 5, y: 20, z: 2 }, o)) as [number, number, number]));
      outside = Math.max(outside, Math.hypot(...Object.values(w.at({ x: -60, y: 20, z: 2 }, o)) as [number, number, number]));
    }
    expect(inside).toBeLessThan(0.15 * outside);
    expect(inside).toBeGreaterThan(0);
  });
});
