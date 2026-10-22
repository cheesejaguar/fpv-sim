// WakeField: step() exact for any step length (the worker advances it once per ms), puffs emitted
// between steps move only from their emission on, sampleAll() = sample() per rotor.
import { describe, expect, test } from 'vitest';
import { Rng, V3 } from '../src/sim/math';
import { WakeField } from '../src/sim/wake';

const DT = 1 / 8000;
const wind = { x: 1.5, y: -0.7, z: 0.1 };

/** Four rotors around a point moving along +x, shedding downwash (as quad.step does every physics step). */
function fly(w: WakeField, steps: number, wakeEvery: number, z = 3) {
  const pos = { x: 0, y: 0, z }, vel = { x: 0.3, y: 0.1, z: -4 };
  let acc = 0;
  for (let i = 0; i < steps; i++) {
    pos.x += 6 * DT;
    for (let k = 0; k < 4; k++) w.emit(k, { x: pos.x + (k & 1 ? 0.11 : -0.11), y: pos.y + (k & 2 ? 0.11 : -0.11), z: pos.z }, vel, 0.057, DT);
    acc += DT;
    if ((i + 1) % wakeEvery === 0) { w.step(acc, wind, -100); acc = 0; }
  }
}

describe('WakeField', () => {
  test('stepping once per ms = stepping every physics step (incl. puffs emitted in between)', () => {
    const a = new WakeField(), b = new WakeField();
    fly(a, 8000, 1); fly(b, 8000, 8);
    let alive = 0;
    for (let i = 0; i < a.puffs.length; i++) {
      const p = a.puffs[i], q = b.puffs[i];
      expect(q.alive).toBe(p.alive);
      if (!p.alive) continue;
      alive++;
      for (const k of ['x', 'y', 'z', 'vx', 'vy', 'vz', 'r', 'age'] as const) expect(Math.abs(p[k] - q[k])).toBeLessThan(1e-9 * (1 + Math.abs(p[k])));
    }
    expect(alive).toBeGreaterThan(300);
  });

  test('puffs decay and drift with the wind; landing turns the jet radial', () => {
    const w = new WakeField();
    w.emit(0, { x: 0, y: 0, z: 0.3 }, { x: 0, y: 0, z: -6 }, 0.06, DT);
    w.step(DT, { x: 0, y: 0, z: 0 }, 0);
    const p = w.puffs[0];
    for (let i = 0; i < 200; i++) w.step(1e-3, { x: 0, y: 0, z: 0 }, 0);
    expect(p.alive).toBe(true);
    expect(p.z).toBeCloseTo(0.05, 12); // sitting on the ground
    expect(p.vz).toBe(0);
    expect(Math.hypot(p.vx, p.vy)).toBeGreaterThan(0.5); // wall jet
    expect(p.r).toBeGreaterThan(0.06);
    for (let i = 0; i < 1100; i++) w.step(1e-3, { x: 0, y: 0, z: 0 }, 0);
    expect(p.alive).toBe(false); // past its 1.2 s life
  });

  test('sampleAll() = sample() for each rotor', () => {
    const w = new WakeField(), rng = new Rng(4);
    fly(w, 6000, 8, 0.6);
    const out = [0, 1, 2, 3].map(() => ({ x: 0, y: 0, z: 0 })), turb = [0, 0, 0, 0], o = { x: 0, y: 0, z: 0 };
    let nonzero = 0;
    for (let i = 0; i < 400; i++) {
      const c = { x: 4 + rng.next() * 2, y: (rng.next() - 0.5) * 0.4, z: 0.3 + rng.next() * 0.6 };
      const hubs: V3[] = [0, 1, 2, 3].map((k) => ({ x: c.x + (k & 1 ? 0.11 : -0.11), y: c.y + (k & 2 ? 0.11 : -0.11), z: c.z + (rng.next() - 0.5) * 0.02 }));
      w.sampleAll(hubs, out, turb);
      for (let k = 0; k < 4; k++) {
        const t = w.sample(hubs[k], o, k);
        expect(turb[k]).toBe(t);
        expect([out[k].x, out[k].y, out[k].z]).toEqual([o.x, o.y, o.z]);
        if (t > 0) nonzero++;
      }
    }
    expect(nonzero).toBeGreaterThan(100);
  });
});
