// Regression: hard crashes (frame + prop strikes into terrain) must stay numerically stable,
// and reset() must fully restore a flyable state.
import { expect, test } from 'vitest';
import { buildDrone, DEFAULT_SPEC } from '../src/builder/derive';
import { MAPS } from '../src/maps/maps';
import { PrimitiveWorld } from '../src/maps/world';
import { qFromEuler } from '../src/sim/math';
import { QuadSim } from '../src/sim/quad';
import { WakeField } from '../src/sim/wake';
import { DEFAULT_WIND, Wind } from '../src/sim/wind';

const finite = (q: QuadSim) => [q.s.pos.x, q.s.pos.z, q.s.vel.x, q.s.w.x, q.s.w.y, q.s.w.z, q.s.q.w, q.s.vbus, q.imu.gyroOut.x, ...q.motors.map((m) => m.s.omega)].every(Number.isFinite);

test.each([
  [0.6, 15, 1500], [1.2, 25, 2047], [2.5, 30, 800], [0, -20, 300], [3.1, 10, 2047],
])('crash pitch %s rad at %s m/s, throttle %s stays finite and bounded', (pitch, speed, thr) => {
  const q = new QuadSim(buildDrone(DEFAULT_SPEC).params, 8000);
  const env = { world: new PrimitiveWorld(MAPS.field()), wind: new Wind(DEFAULT_WIND), wake: new WakeField(), ambientC: 20, altitudeOffset: 120, damageEnabled: true };
  q.reset({ x: 20, y: 20, z: 3 });
  q.s.q = qFromEuler(0, pitch, 0); q.s.vel = { x: speed * 0.7, y: 0, z: -Math.abs(speed) * 0.7 };
  let maxW = 0;
  for (let i = 0; i < 8000 * 3; i++) {
    q.command([thr, thr, thr, thr], false); q.step(1 / 8000, env);
    expect(finite(q)).toBe(true);
    expect(q.s.crashed).toBe(false); // the NaN guard must never have to fire
    maxW = Math.max(maxW, Math.hypot(q.s.w.x, q.s.w.y, q.s.w.z));
  }
  expect(maxW).toBeLessThan(500); // rad/s: violent tumble at worst, never a numerical blow-up (was ~1e37)
  // reset restores a clean, stationary quad
  q.reset({ x: 0, y: 0, z: 0.2 });
  expect(finite(q)).toBe(true);
  expect(q.motors.every((m) => m.s.omega === 0)).toBe(true);
  expect(Math.hypot(q.s.w.x, q.s.w.y, q.s.w.z)).toBe(0);
});
