// The reported impact speed must track the real approach speed (it used to read the last step of the
// contact, ~6 m/s, regardless of how fast the quad hit).
import { expect, test } from 'vitest';
import { buildDrone, DEFAULT_SPEC } from '../src/builder/derive';
import { GroundPlane } from '../src/sim/contact';
import { QuadSim } from '../src/sim/quad';
import { WakeField } from '../src/sim/wake';
import { Wind } from '../src/sim/wind';

test.each([8, 15, 25])('impact at %s m/s reports ~%s m/s', (speed) => {
  const q = new QuadSim(buildDrone(DEFAULT_SPEC).params, 8000);
  const env = { world: new GroundPlane(), wind: new Wind({ speed20ft: 0, directionDeg: 0, z0: 0.03, turbulence: 0, gustiness: 0, gustMax: 0 }), wake: new WakeField(), ambientC: 20, altitudeOffset: 0, damageEnabled: false };
  q.reset({ x: 0, y: 0, z: 0.3 });
  q.s.vel = { x: 0, y: 0, z: -speed };
  let peak = 0;
  for (let i = 0; i < 800; i++) { q.command([0, 0, 0, 0], false); q.step(1 / 8000, env); if (q.s.maxImpact > peak) peak = q.s.maxImpact; q.s.maxImpact = 0; }
  expect(peak).toBeGreaterThan(speed * 0.85);
  expect(peak).toBeLessThan(speed * 1.1);
});
