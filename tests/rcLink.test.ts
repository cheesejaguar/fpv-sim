import { expect, test } from 'vitest';
import { RcLink } from '../src/sim/rcLink';

const run = (l: RcLink, world: { obstructionDb(): number } | null, dist: number, n = 2000) => {
  for (let i = 0; i < n; i++) { if (i % 12 === 0) l.updateBudget(world as any, { x: 0, y: 0, z: 1.6 }, { x: dist, y: 0, z: 5 }, 0.05); l.packet(); }
  return l.lq;
};

test('LQ is 100 at close range in the open', () => {
  expect(run(new RcLink(), null, 50)).toBe(100);
});

test('heavy obstruction at range degrades LQ, and more power helps', () => {
  const walls = { obstructionDb: () => 60 }; // several concrete walls
  const lo = new RcLink(1); lo.txPowerMw = 10;
  const hi = new RcLink(1); hi.txPowerMw = 1000;
  const lqLo = run(lo, walls, 2000), lqHi = run(hi, walls, 2000);
  expect(lqLo).toBeLessThan(60);
  expect(lqHi).toBeGreaterThan(lqLo);
});

test('faster packet rates need more signal (lower sensitivity)', () => {
  const walls = { obstructionDb: () => 45 };
  const fast = new RcLink(3); fast.rateHz = 500; fast.txPowerMw = 25;
  const slow = new RcLink(3); slow.rateHz = 50; slow.txPowerMw = 25;
  expect(run(slow, walls, 1500)).toBeGreaterThanOrEqual(run(fast, walls, 1500));
});
