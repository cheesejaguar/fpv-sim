// The operational layer (src/worker/ops.ts) on the real Betaflight: an empty configuration changes
// nothing; faults, jamming, spoofing, the fibre link and the payload do what they model, and the
// firmware reacts as it would (failsafe on a lost link). Skipped without the firmware build.
import { existsSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { createNodeEnv } from '../src/headless/node';
import { obsVector, Observation, StepResult } from '../src/headless/env';
import type { Scenario } from '../src/scenario/scenario';
import { bandJamming, BANDS, effectiveCn0, gnssState, horizonLossDb, radioHorizonM } from '../src/sim/ew';
import { checkFaults } from '../src/sim/faults';
import { checkOps } from '../src/worker/ops';

const have = existsSync(new URL('../public/bf/betaflight.mjs', import.meta.url));

const base = (over: Partial<Scenario> = {}): Scenario => ({
  format: 'fpvsim-scenario', version: 1, seed: 5,
  map: { id: 'field' }, drone: { preset: '5" Freestyle 6S' },
  sim: { wind: { speed: 0, direction: 0, turbulence: 0, gusts: 0 } },
  start: { armed: true, mode: 'angle' },
  task: { type: 'hover', heightM: 3, radiusM: 2 },
  episode: { maxSeconds: 6, controlHz: 50, endOnCrash: false },
  ...over,
});

/** Altitude hold on throttle around 3 m. */
const hold = (o: Observation, h = 3) => ({ throttle: Math.max(0, Math.min(1, 0.3 + 0.12 * (h - o.agl) - 0.1 * o.vel[2])), roll: 0, pitch: 0 });

async function fly(env: Awaited<ReturnType<typeof createNodeEnv>>, sc: Scenario, steps = Infinity, act = hold) {
  const r = await env.reset({ scenario: sc });
  let o = r.obs, res: StepResult | null = null;
  const obs: Observation[] = [o];
  const events: StepResult['info']['events'] = [];
  for (let i = 0; i < steps; i++) {
    res = env.step(act(o)); o = res.obs; obs.push(o); events.push(...res.info.events);
    if (res.terminated || res.truncated) break;
  }
  return { r, obs, res: res!, events };
}

describe('radio and GNSS models', () => {
  test('radio horizon and diffraction', () => {
    expect(radioHorizonM(1.5, 100) / 1000).toBeCloseTo(46.3, 0);
    expect(horizonLossDb(1000, 1.5, 100)).toBe(0);
    expect(horizonLossDb(60000, 1.5, 100)).toBeGreaterThan(15);
  });
  test('effective C/N0 falls with J/S; a GNSS jammer near the drone takes the fix away', () => {
    expect(effectiveCn0(46, -Infinity)).toBe(46);
    expect(effectiveCn0(46, 30)).toBeGreaterThan(26);
    expect(effectiveCn0(46, 50)).toBeLessThan(15);
    const rx = { x: 0, y: 0, z: 30 };
    const far = gnssState([{ kind: 'jammer', pos: { x: 50000, y: 0, z: 2 }, freqMHz: 1575.42, bandwidthMHz: 20, erpW: 0.01 }], rx, null, 0);
    expect(far.numSV).toBe(12);
    const near = gnssState([{ kind: 'jammer', pos: { x: 500, y: 0, z: 2 }, freqMHz: 1575.42, bandwidthMHz: 20, erpW: 10 }], rx, null, 0);
    expect(near.numSV).toBe(0);
    // a spoofer only captures when it beats the real signals
    const sp = gnssState([{ kind: 'spoofer', pos: { x: 300, y: 0, z: 2 }, freqMHz: 1575.42, bandwidthMHz: 2, erpW: 1e-6 }], rx, null, 0);
    expect(sp.spoofed).toBe(true);
    const weak = gnssState([{ kind: 'spoofer', pos: { x: 300, y: 0, z: 2 }, freqMHz: 1575.42, bandwidthMHz: 2, erpW: 1e-13 }], rx, null, 0);
    expect(weak.spoofed).toBe(false);
  });
  test('a jammer hits only the hops in its band', () => {
    const j = bandJamming([{ kind: 'jammer', pos: { x: 0, y: 0, z: 0 }, freqMHz: 2410, bandwidthMHz: 20, erpW: 1 }], BANDS.rc24, { x: 100, y: 0, z: 0 }, null, 0);
    expect(j.hitFrac).toBeCloseTo(0.25, 6);
    const other = bandJamming([{ kind: 'jammer', pos: { x: 0, y: 0, z: 0 }, freqMHz: 5800, bandwidthMHz: 300, erpW: 1 }], BANDS.rc24, { x: 100, y: 0, z: 0 }, null, 0);
    expect(other.hitFrac).toBe(0);
  });
  test('configuration checks name the problem', () => {
    expect(checkFaults([{ at: 1, kind: 'motor_failure' }])).toEqual(['faults[0].motor: expected a motor number 1..8']);
    expect(checkFaults([{ at: 1, kind: 'nope' }])[0]).toMatch(/kind/);
    expect(checkOps({ emitters: [{ pos: [0, 0, 0], erpW: 1 }] })[0]).toMatch(/band/);
    expect(checkOps({ link: { type: 'fibre' } })[0]).toMatch(/link.type/);
    expect(checkOps({ link: { type: 'fiber', fiber: { lengthM: 500 } }, payload: { massG: 200, releaseAux: 6 } })).toEqual([]);
  });
});

describe.skipIf(!have)('operations on the real Betaflight', () => {
  test('an empty ops block (or nav sensors) leaves the flight bit-identical', async () => {
    const env = await createNodeEnv();
    const a = await fly(env, base(), 100);
    const b = await fly(env, base({ ops: {}, observations: { nav: true } }), 100);
    expect(b.obs.map(obsVector)).toEqual(a.obs.map(obsVector));
    const nav = b.obs[100].nav!;
    // level, heading north-ish: the field points mostly down and north
    expect(nav.mag[2]).toBeLessThan(-0.3);
    expect(nav.rangeM).toBeGreaterThan(2);
    expect(nav.rangeM).toBeLessThan(4);
    expect(b.obs[100].ops!.faults).toEqual([]);
  }, 120000);

  test('a motor failure brings the quad down; a degraded motor is survivable in angle mode', async () => {
    const env = await createNodeEnv();
    const dead = await fly(env, base({ ops: { faults: [{ at: 2, kind: 'motor_failure', motor: 2 }] } }));
    expect(dead.events.some((e) => e.type === 'fault' && e.kind === 'motor_failure' && e.on)).toBe(true);
    expect(dead.obs[dead.obs.length - 1].agl).toBeLessThan(0.5);
    expect(dead.obs[dead.obs.length - 1].ops!.faults).toEqual(['motor_failure (motor 2)']);
    const weak = await fly(env, base({ ops: { faults: [{ at: 2, kind: 'motor_degraded', motor: 2, value: 0.85 }] } }));
    expect(weak.obs[weak.obs.length - 1].agl).toBeGreaterThan(1.5);
  }, 120000);

  test('a gyro bias reaches the firmware: angle mode drifts away from level', async () => {
    const env = await createNodeEnv();
    const run = await fly(env, base({ ops: { faults: [{ at: 1, kind: 'gyro_bias', axis: 'x', value: 20 }] } }), 150);
    const o = run.obs[run.obs.length - 1];
    expect(o.gyro[0] - o.rates[0]).toBeCloseTo((20 * Math.PI) / 180, 1);
    // the attitude estimate integrates the bias: the real roll walks off level
    expect(Math.abs(o.euler[0])).toBeGreaterThan(0.15);
  }, 120000);

  test('RC loss: Betaflight fails safe and disarms; it ends when the link is back', async () => {
    const env = await createNodeEnv();
    const run = await fly(env, base({ ops: { faults: [{ at: 1, kind: 'rc_loss', duration: 3 }] } }));
    const at = (t: number) => run.obs.find((o) => o.t >= t)!;
    expect(at(0.9).armed).toBe(true);
    expect(at(3.5).ops!.link.lq).toBe(0);
    expect(at(3.9).armed).toBe(false);
    expect(at(5.5).ops!.link.lq).toBeGreaterThan(90);
  }, 120000);

  test('a 2.4 GHz jammer next to the drone kills the radio link; a fibre link flies through it', async () => {
    const env = await createNodeEnv();
    const jam = { emitters: [{ id: 'j1', band: '2.4', pos: [-44, -16, 3] as [number, number, number], erpW: 20, fromS: 1 }] };
    const radio = await fly(env, base({ ops: jam }));
    const late = radio.obs[radio.obs.length - 1];
    expect(late.ops!.link.jamHitFrac).toBe(1);
    expect(late.ops!.link.lq).toBeLessThan(20);
    // Betaflight sees the link fail (a stray packet now and then keeps it from the final stage)
    expect(late.armingFlags).toContain('RX_FAILSAFE');
    const fiber = await fly(env, base({ ops: { ...jam, link: { type: 'fiber' } } }));
    const f = fiber.obs[fiber.obs.length - 1];
    expect(f.armed).toBe(true);
    expect(f.armingFlags).not.toContain('RX_FAILSAFE');
    expect(f.ops!.link).toMatchObject({ type: 'fiber', lq: 100 });
    expect(f.ops!.fiber!.paidOutM).toBeGreaterThan(2);
  }, 120000);

  test('the fibre snaps when the spool runs out', async () => {
    const env = await createNodeEnv();
    const run = await fly(env, base({ ops: { link: { type: 'fiber', fiber: { lengthM: 2 } } } }));
    const br = run.events.find((e) => e.type === 'fiber_break');
    expect(br && br.type === 'fiber_break' && br.reason).toMatch(/spool ran out/);
    expect(run.obs[run.obs.length - 1].ops!.link.cut).toBe(true);
  }, 120000);

  test('GNSS jamming and spoofing reach the receiver', async () => {
    const env = await createNodeEnv();
    const jam = await fly(env, base({ ops: { emitters: [{ band: 'gnss', pos: [-44, 100, 5], erpW: 5 }] } }), 60);
    expect(jam.obs[60].ops!.gnss).toMatchObject({ numSV: 0, state: 'lost' });
    expect(jam.events.some((e) => e.type === 'gnss' && e.state === 'lost')).toBe(true);
    const spoof = await fly(env, base({ ops: { emitters: [{ kind: 'spoofer', band: 'gnss', pos: [-44, -6, 10], erpW: 1e-6, driftMps: [2, 0, 0] }] } }), 60);
    expect(spoof.obs[60].ops!.gnss).toMatchObject({ spoofed: true, state: 'spoofed' });
  }, 120000);

  test('payload: the quad carries its mass, a drop lands near the target, the drop task scores the miss', async () => {
    const env = await createNodeEnv();
    const sc = base({
      ops: { payload: { name: 'parcel', massG: 300, cdA: 0.004 }, faults: [{ at: 2.5, kind: 'payload_release' }] },
      task: { type: 'drop', target: [0, 0, 0], radiusM: 3 },
    });
    const r = await env.reset({ scenario: sc });
    const spawn = r.obs.pos;
    // aim at the spawn pad: the drone climbs straight up from it and drops
    sc.task = { type: 'drop', target: [spawn[0], spawn[1], 0], radiusM: 3 };
    const run = await fly(env, sc);
    const rel = run.events.find((e) => e.type === 'payload_release');
    const imp = run.events.find((e) => e.type === 'payload_impact');
    expect(rel).toBeTruthy();
    expect(imp && imp.type === 'payload_impact' && imp.flightS).toBeGreaterThan(0.5);
    expect(run.res.info.reason).toBe('success');
    expect(run.res.info.metrics.missM).toBeLessThan(3);
    // lighter after the release: the same throttle climbs (altitude-hold transient)
    expect(run.obs[run.obs.length - 1].ops!.payload).toMatchObject({ attached: false, released: true });
  }, 120000);

  test('faults injected over the API join the schedule', async () => {
    const env = await createNodeEnv();
    await env.reset({ scenario: base() });
    for (let i = 0; i < 50; i++) env.step({ throttle: 0.35 });
    env.injectFaults([{ at: 0.2, kind: 'gps_loss', duration: 1 }]);
    const seen: string[] = [];
    for (let i = 0; i < 100; i++) for (const e of env.step({ throttle: 0.35 }).info.events) if (e.type === 'gnss') seen.push(e.state);
    expect(seen).toEqual(['lost', 'ok']);
  }, 120000);
});
