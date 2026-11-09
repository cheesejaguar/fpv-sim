// Practice points (a skateboarding game's marker): the flight kept exactly as it was and flown again.
// The plant's save state restores everything in place (the same trajectory again, the same objects,
// shared constants untouched); with Betaflight in the loop its memory comes back too, so the
// firmware's attitude estimate, filters and PID state match the restored quad.
import { existsSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { buildDrone, DEFAULT_SPEC } from '../src/builder/derive';
import { BblRecorder } from '../src/worker/bbl';
import { MAPS } from '../src/maps/maps';
import { PrimitiveWorld } from '../src/maps/world';
import { MATERIALS } from '../src/sim/contact';
import { QuadSim } from '../src/sim/quad';
import { capture, restore } from '../src/sim/saveState';
import { WakeField } from '../src/sim/wake';
import { DEFAULT_WIND, Wind } from '../src/sim/wind';

const HZ = 8000;
const NONE = new Set<object>();
const rig = () => {
  const world = new PrimitiveWorld({ ...MAPS.field(), terrain: () => 0, prims: [], trees: [], gates: [] });
  const env = { world, wind: new Wind({ ...DEFAULT_WIND, speed20ft: 0 }), wake: new WakeField(), ambientC: 20, altitudeOffset: 0, damageEnabled: true };
  const q = new QuadSim(buildDrone(DEFAULT_SPEC).params, HZ, 1, 20, 7);
  return { q, env };
};

describe('plant save state', () => {
  test('restored in place, the same commands fly the same trajectory again, bit for bit', () => {
    const { q, env } = rig();
    q.reset({ x: 0, y: 0, z: 3 });
    const cmd = (i: number): [number, number, number, number] => {
      const t = i / HZ, b = 950 + 150 * Math.sin(t * 7);
      return [b + 60 * Math.sin(t * 13), b, b - 50 * Math.sin(t * 5), b + 30 * Math.cos(t * 3)];
    };
    const fly = (from: number, n: number, out?: number[]) => {
      for (let i = 0; i < n; i++) {
        q.command(cmd(from + i), false); q.step(1 / HZ, env); env.wake.step(1 / HZ, { x: 0, y: 0, z: 0 }, 0);
        out?.push(q.s.pos.x, q.s.pos.y, q.s.pos.z, q.s.w.x, q.s.w.y, q.motors[0].s.omega, q.battery.s.voltage, q.imu.gyroOut.x);
      }
    };
    fly(0, 2000);
    const motor0 = q.motors[0], battery = q.battery, state = q.s;
    const snap = q.saveState(), wake = capture(env.wake, NONE);
    const first: number[] = [];
    fly(2000, 6000, first);
    q.loadState(snap); restore(env.wake, wake, NONE);
    const again: number[] = [];
    fly(2000, 6000, again);
    expect(again).toEqual(first);
    // the same objects (the worker, ops and renderer hold references to them)
    expect(q.motors[0]).toBe(motor0); expect(q.battery).toBe(battery); expect(q.s).toBe(state);
    // and the snapshot is reusable: once more, the same flight
    q.loadState(snap); restore(env.wake, wake, NONE);
    const third: number[] = [];
    fly(2000, 6000, third);
    expect(third).toEqual(first);
  });

  test('a snapshot of picked fields writes back into its owner (another class), typed arrays in place', () => {
    class Owner { n = 1; buf = new Float32Array([1, 2]); hand: { x: number } | null = { x: 3 }; }
    const o = new Owner(), buf = o.buf;
    const snap = capture({ n: o.n, buf: o.buf, hand: o.hand }, NONE);
    o.n = 9; o.buf[0] = 7; o.hand = null;
    restore(o, snap, NONE);
    expect(o.n).toBe(1); expect(o.buf).toBe(buf); expect(Array.from(o.buf)).toEqual([1, 2]); expect(o.hand).toEqual({ x: 3 });
  });

  test('a crash\'s damage (bent arms, broken props) is undone; prop tables and materials are shared, untouched', () => {
    const { q, env } = rig();
    q.reset({ x: 0, y: 0, z: 0.5 });
    const snap = q.saveState();
    const axis0 = { ...q.p.rotors[0].axis }, mats = JSON.stringify(MATERIALS);
    // full speed into concrete, upside down
    env.world = new PrimitiveWorld({ ...MAPS.field(), terrain: () => 0, groundMat: 'concrete', prims: [], trees: [], gates: [] });
    q.reset({ x: 0, y: 0, z: 6 }); q.s.vel = { x: 18, y: 0, z: -25 };
    for (let i = 0; i < HZ * 0.6; i++) { q.command([1400, 1400, 1400, 1400], false); q.step(1 / HZ, env); }
    const hurt = q.damageLog.length + q.impactLog.length;
    expect(hurt).toBeGreaterThan(0);
    q.loadState(snap);
    expect(q.damageLog.length + q.impactLog.length).toBe(0);
    expect(q.p.rotors[0].axis).toEqual(axis0);
    expect(q.s.pos.z).toBeCloseTo(0.5, 9);
    expect(JSON.stringify(MATERIALS)).toBe(mats);
    // constants kept by reference, not copied into the snapshot
    expect((snap.p as typeof q.p).rotors[0].table).toBe(q.p.rotors[0].table);
  });
});

describe('blackbox log', () => {
  test('rewound with the flight: what was logged after the point goes, the log carries on from there', () => {
    const bbl = new BblRecorder();
    const b = (n: number, v: number) => new Uint8Array(n).fill(v);
    bbl.push(b(10, 1), true);            // a session starts on arming
    bbl.push(b(5, 2), true);
    const m = bbl.mark();
    bbl.push(b(7, 3), true);             // the attempt
    bbl.push(b(0, 0), false); bbl.push(b(4, 4), true); // disarmed after the crash, armed again: a new session
    expect(bbl.count).toBe(2);
    bbl.rewind(m);
    expect(bbl.count).toBe(1);
    expect(bbl.size).toBe(15);
    bbl.push(b(3, 9), true);             // (Betaflight's restored logger goes on in the same session)
    expect(Array.from(new Uint8Array(bbl.export()))).toEqual([...b(10, 1), ...b(5, 2), ...b(3, 9)]);
  });
});

const haveBf = existsSync(new URL('../public/bf/betaflight.mjs', import.meta.url));

describe.skipIf(!haveBf)('practice points with Betaflight in the loop', () => {
  test('back to the point: the same moment again (firmware included); a crash after it does not matter', async () => {
    const { createNodeEnv } = await import('../src/headless/node');
    const env = await createNodeEnv();
    await env.reset({ scenario: { format: 'fpvsim-scenario', version: 1, seed: 3, map: { id: 'field' }, drone: { spec: DEFAULT_SPEC }, sim: { wind: { speed: 0, direction: 0, turbulence: 0, gusts: 0 } }, start: { armed: true, mode: 'angle', pos: [0, 0, 12] }, episode: { maxSeconds: 60, controlHz: 1000, endOnCrash: false, endOutOfBounds: false } } });
    const core = env.core;
    // fly a little: hover, then a banked turn
    for (let i = 0; i < 1500; i++) env.step({ throttle: 0.45, roll: i > 800 ? 0.3 : 0, pitch: 0.1, yaw: 0 });
    expect(core.markPoint()).toBeNull();
    const att0 = core.bf!.attitude();
    const line = (out: number[]) => {
      for (let i = 0; i < 800; i++) {
        env.step({ throttle: 0.45 + 0.1 * Math.sin(i / 90), roll: -0.4 * Math.sin(i / 120), pitch: 0.2, yaw: 0.1 });
        const s = core.quad.s;
        out.push(s.pos.x, s.pos.y, s.pos.z, s.q.w, s.q.x, core.motorCmd[0], core.motorCmd[2]);
      }
    };
    const first: number[] = [];
    line(first);
    // the attempt goes wrong: flip it over and fly it into the ground
    for (let i = 0; i < 2500; i++) env.step({ throttle: i < 300 ? 0.9 : 0.2, roll: 1, pitch: -1, yaw: 0 });
    expect(core.recallPoint()).toBe(true);
    // the firmware is back at that moment too: its attitude estimate is the one it had there
    expect(core.bf!.attitude()).toEqual(att0);
    const again: number[] = [];
    line(again);
    expect(again).toEqual(first);
  }, 120000);

  test('flown back to while the pilot\'s arm switch still reads off: it stays armed until the switch agrees (a switch that stays off disarms it)', async () => {
    const { createNodeEnv } = await import('../src/headless/node');
    const env = await createNodeEnv();
    await env.reset({ scenario: { format: 'fpvsim-scenario', version: 1, seed: 5, map: { id: 'field' }, drone: { spec: DEFAULT_SPEC }, sim: { wind: { speed: 0, direction: 0, turbulence: 0, gusts: 0 } }, start: { armed: true, mode: 'acro', pos: [0, 0, 15] }, episode: { maxSeconds: 60, controlHz: 1000, endOnCrash: false, endOutOfBounds: false } } });
    const core = env.core;
    for (let i = 0; i < 300; i++) env.step({ throttle: 0.45 });
    expect(core.markPoint()).toBeNull();
    for (let i = 0; i < 400; i++) env.step({ arm: false, throttle: 0 }); // crashed and disarmed
    expect(core.armed).toBe(false);
    core.recallPoint();
    for (let i = 0; i < 150; i++) env.step({ arm: false, throttle: 0.45 }); // (the stale stream)
    expect(core.armed).toBe(true);
    for (let i = 0; i < 1500; i++) env.step({ arm: true, throttle: 0.45 }); // the toggle caught up
    expect(core.armed).toBe(true);
    // a switch that stays off: disarmed within the hold
    core.recallPoint();
    for (let i = 0; i < 1300; i++) env.step({ arm: false, throttle: 0.45 });
    expect(core.armed).toBe(false);
  }, 120000);

  test('ArduPilot builds have no practice points; a new quad clears the point', async () => {
    const { createNodeEnv } = await import('../src/headless/node');
    const env = await createNodeEnv();
    await env.reset({ scenario: { format: 'fpvsim-scenario', version: 1, seed: 3, map: { id: 'field' }, drone: { spec: DEFAULT_SPEC } } });
    const core = env.core;
    expect(core.recallPoint()).toBe(false);
    expect(core.markPoint()).toBeNull();
    expect(core.hasPoint).toBe(true);
    core.buildQuad();
    expect(core.hasPoint).toBe(false);
    core.spec = { ...DEFAULT_SPEC, autopilot: 'ardupilot' };
    expect(core.markPoint()).toMatch(/Betaflight/);
  }, 120000);
});
