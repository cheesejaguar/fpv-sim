// Contact realism regressions (each reproduces a measured failure of the old contact model):
// tunnelling through thin gate tubes and posts, superball wall rebounds, grass behaving like concrete
// (no tumbling), tree canopies acting as solid walls; plus resting-contact quietness and turtle mode.
import { describe, expect, test } from 'vitest';
import { Prim } from '../src/maps/world';
import { qFromEuler } from '../src/sim/math';
import { CALM, DT, flatInto, rig, run, touchdown } from './helpers/scenarios';
import { tunnelWatch } from './helpers/tunnel';

describe('thin obstacles stop or deflect the quad (no tunnelling)', () => {
  // old model: per-contact 600 N clamp + least-penetration normal flipping at the mid-plane
  const bar: Prim = { kind: 'box', c: { x: 1, y: 0, z: 2 }, half: { x: 0.06, y: 2, z: 0.06 }, yaw: 0, mat: 'gate' };      // 12 cm gate top bar
  const post4: Prim = { kind: 'cyl', c: { x: 1, y: 0, z: 0 }, r: 0.04, h: 4, mat: 'metal' };                              // dive-gate leg
  const post12: Prim = { kind: 'box', c: { x: 1, y: 0, z: 2 }, half: { x: 0.06, y: 0.06, z: 2 }, yaw: 0, mat: 'gate' };  // 12 cm gate post
  const cases: [string, Prim, number, 'y' | 'z', number, number][] = [
    ['12 cm gate bar', bar, 20, 'z', 0.06, 0.06], ['12 cm gate bar', bar, 35, 'z', 0.06, 0.06], ['12 cm gate bar', bar, 50, 'z', 0.06, 0.06],
    ['8 cm metal post', post4, 35, 'y', 0.04, 0.04], ['8 cm metal post', post4, 50, 'y', 0.04, 0.04],
    ['12 cm gate post', post12, 50, 'y', 0.06, 0.06],
  ];
  test.each(cases)('%s at %s m/s', (_, prim, v, lat, hx, h) => {
    let tw: ReturnType<typeof tunnelWatch> | undefined;
    const r = flatInto([prim], v, 2, 0, 0.25, (q) => { tw ??= tunnelWatch(q, 1, hx, lat, lat === 'z' ? 2 : 0, h); tw.check(); });
    expect(tw!.through).toBe(0);              // no collider sphere passed through the solid
    expect(r.q.s.pos.x).toBeLessThan(1);      // a dead-centre hit stops the quad in front of it
    expect(r.q.s.vel.x).toBeLessThan(0.5);
  });
  test.each([0.03, 0.1, 0.16])('off-centre post (%s m) deflects instead of passing through', (dy) => {
    const post: Prim = { kind: 'cyl', c: { x: 1, y: dy, z: 0 }, r: 0.04, h: 4, mat: 'metal' };
    let tw: ReturnType<typeof tunnelWatch> | undefined;
    const r = flatInto([post], 50, 2, 0, 0.25, (q) => { tw ??= tunnelWatch(q, 1, 0.04, 'y', dy, 0.04); tw.check(); });
    expect(tw!.through).toBe(0);
    expect(Number.isFinite(r.q.s.pos.x)).toBe(true);
  });
});

describe('walls absorb most of a hard hit', () => {
  // old model: unpowered concrete hits rebounded at 0.55-0.68 of the impact speed (50 -> -34 m/s)
  const wall: Prim = { kind: 'box', c: { x: 1.3, y: 0, z: 2 }, half: { x: 0.3, y: 5, z: 3 }, yaw: 0, mat: 'concrete' };
  const rebound = (v: number) => -flatInto([wall], v, 2, 0, 0.1).q.s.vel.x / v;
  test('effective restitution 0.05-0.3, falling with impact speed', () => {
    const e10 = rebound(10), e30 = rebound(30), e50 = rebound(50);
    for (const e of [e10, e30, e50]) { expect(e).toBeGreaterThan(0.03); expect(e).toBeLessThan(0.3); }
    expect(e50).toBeLessThan(e10);
  });
  test('flat drop on concrete: restitution independent of how many spheres touch', () => {
    for (const [v, lo, hi] of [[10, 0.15, 0.4], [30, 0.08, 0.25]]) {
      const r = rig([], 'concrete', undefined, false);
      r.q.reset({ x: 0, y: 0, z: 0.2 }); r.q.s.vel = { x: 0, y: 0, z: -v };
      let up = 0;
      run(r.q, r.env, 0.03, 0, () => { up = Math.max(up, r.q.s.vel.z); });
      expect(up / v).toBeGreaterThan(lo); expect(up / v).toBeLessThan(hi);
    }
  });
});

describe('ground slides: grass digs in and tumbles, concrete skids', () => {
  // old model: 12 m/s touchdowns slid 7-9 m on both surfaces and never flipped; grass only ~20 % shorter
  test.each([0.3, 0.7])('12 m/s touchdown at pitch %s rad', (pitch) => {
    const g = touchdown('grass', 12, pitch), c = touchdown('concrete', 12, pitch);
    expect(g.slide).toBeLessThan(4.5);
    expect(c.slide).toBeGreaterThan(5);
    expect(g.slide).toBeLessThan(c.slide * 0.6);
    expect(g.flipped).toBe(true);
  });
});

describe('tree canopies are porous', () => {
  // old model: at 15 m/s into a canopy the quad stopped within 2 cm of its surface
  test('15 m/s into a canopy: ploughs in, loses most of its speed, the core stays solid', () => {
    const tree: Prim = { kind: 'sphere', c: { x: 6, y: 0, z: 2 }, r: 4, mat: 'foliage' }; // surface at x = 2, core r 1.2
    const r = rig([tree]);
    r.q.reset({ x: 0, y: 0, z: 2 }); r.q.s.vel = { x: 15, y: 0, z: 0 };
    let vAt1 = NaN, maxX = 0;
    run(r.q, r.env, 1.0, 0, () => { maxX = Math.max(maxX, r.q.s.pos.x); if (Number.isNaN(vAt1) && r.q.s.pos.x > 3) vAt1 = r.q.s.vel.x; });
    expect(vAt1).toBeLessThan(10);       // 1 m inside: well slowed down
    expect(maxX).toBeGreaterThan(2.6);   // but not a wall: > 0.5 m deep
    expect(maxX).toBeLessThan(4.8 - 0.1); // never through the solid core (x = 4.8)
  });
});

describe('stability', () => {
  test.each(['concrete', 'grass'] as const)('resting on %s is jitter-free', (mat) => {
    const r = rig([], mat, undefined, true, CALM);
    r.q.reset({ x: 0, y: 0, z: 0.1 });
    run(r.q, r.env, 1.0);
    let zMin = Infinity, zMax = -Infinity, wMax = 0;
    run(r.q, r.env, 1.0, 0, () => { const z = r.q.s.pos.z; zMin = Math.min(zMin, z); zMax = Math.max(zMax, z); wMax = Math.max(wMax, Math.hypot(r.q.s.w.x, r.q.s.w.y, r.q.s.w.z)); });
    expect(zMax - zMin).toBeLessThan(2e-5);
    expect(wMax).toBeLessThan(1e-3);
    expect(Math.hypot(r.q.s.vel.x, r.q.s.vel.y)).toBeLessThan(1e-3);
  });
  test.each(['concrete', 'grass'] as const)('turtle mode flips an upside-down quad on %s', (mat) => {
    const r = rig([], mat);
    r.q.reset({ x: 0, y: 0, z: 0.1 }); r.q.s.q = qFromEuler(Math.PI, 0, 0);
    run(r.q, r.env, 1.0); // settle on its back
    // Betaflight turtle: motors reversed, only one side driven (here the left pair, 3 + 4); the pilot
    // lets go of the stick once it is past its side
    const upZ = () => { const q = r.q.s.q; return 1 - 2 * (q.x * q.x + q.y * q.y); };
    let t = 0;
    while (upZ() < 0.6 && t < 2) { r.q.command([0, 0, 1000, 1000], true); r.q.step(DT, r.env); t += DT; }
    expect(t).toBeLessThan(2);
    run(r.q, r.env, 1.5);
    expect(upZ()).toBeGreaterThan(0.95);
  });
});
