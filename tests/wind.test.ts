import { expect, test } from 'vitest';
import { Wind } from '../src/sim/wind';

test('Dryden turbulence has the specified intensity and no white-noise leakage at 8 kHz', () => {
  const w = new Wind({ speed20ft: 5, directionDeg: 0, z0: 0.03, turbulence: 1, gustiness: 0, gustMax: 0 }, 99);
  const dt = 1 / 8000, o = { x: 0, y: 0, z: 0 };
  let s2 = 0, n = 0, dmax = 0, prev = 0;
  const mean = w.meanAt(10, { x: 0, y: 0, z: 0 });
  for (let i = 0; i < 8000 * 120; i++) {
    w.step(dt, 10, 5);
    w.at({ x: 0, y: 0, z: 10 }, o);
    const vz = o.z - mean.z;
    s2 += vz * vz; n++;
    if (i > 0) dmax = Math.max(dmax, Math.abs(vz - prev));
    prev = vz;
  }
  const sigma = Math.sqrt(s2 / n);
  const W20kt = 5 / 0.5144, expected = 0.1 * W20kt * 0.5144; // MIL-HDBK-1797 sigma_w
  expect(sigma).toBeGreaterThan(expected * 0.6);
  expect(sigma).toBeLessThan(expected * 1.5);
  expect(dmax).toBeLessThan(0.05); // smooth at the physics rate: no per-sample jumps
});
