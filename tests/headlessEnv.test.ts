// The headless environment (src/headless/env.ts): scenarios boot the real Betaflight build, episodes
// are reproducible from their seed, domain randomization draws different but repeatable builds,
// tasks score and end episodes, probes see the world. Skipped without the firmware build.
import { existsSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { createNodeEnv } from '../src/headless/node';
import { obsVector, obsVectorLabels, probeDirections, StepResult } from '../src/headless/env';
import { openingCentre } from '../src/maps/gates';
import type { Scenario } from '../src/scenario/scenario';

const have = existsSync(new URL('../public/bf/betaflight.mjs', import.meta.url));

const HOVER: Scenario = {
  format: 'fpvsim-scenario', version: 1, seed: 11,
  map: { id: 'field' }, drone: { preset: '5" Freestyle 6S' },
  sim: { wind: { speed: 3, direction: 90, turbulence: 1, gusts: 1 } },
  start: { armed: true, mode: 'angle' },
  task: { type: 'hover', heightM: 2, radiusM: 1 },
  episode: { maxSeconds: 4, controlHz: 50 },
  observations: { probes: 6, probeRangeM: 15 },
};

/** Altitude hold on throttle, small scripted stick inputs: the same every run. */
function pilot(o: { agl: number; vel: number[]; t: number }) {
  const thr = Math.max(0, Math.min(1, 0.32 + 0.1 * (2 - o.agl) - 0.08 * o.vel[2]));
  return { throttle: thr, roll: 0.2 * Math.sin(o.t * 3), pitch: 0.1 * Math.cos(o.t * 2) };
}

async function episode(env: Awaited<ReturnType<typeof createNodeEnv>>, sc: Scenario | undefined, seed?: number) {
  const r = await env.reset({ scenario: sc, seed });
  const trace: number[][] = [obsVector(r.obs)];
  let res: StepResult;
  let o = r.obs;
  do { res = env.step(pilot(o)); o = res.obs; trace.push(obsVector(o)); } while (!res.terminated && !res.truncated);
  return { r, res, trace };
}

describe.skipIf(!have)('headless environment (real Betaflight)', () => {
  test('a scenario boots, arms in angle mode and holds altitude; the episode times out with hover metrics', async () => {
    const env = await createNodeEnv();
    const { r, res, trace } = await episode(env, HOVER);
    expect(r.obs.armed).toBe(true);
    expect(r.obs.armingFlags).toEqual([]);
    expect(r.info.episode.spec.name).toBe('5" Freestyle 6S');
    expect(res.truncated).toBe(true);
    expect(res.info.reason).toBe('timeout');
    expect(trace.length).toBe(4 * 50 + 1);
    expect(res.obs.agl).toBeGreaterThan(1);
    expect(res.obs.agl).toBeLessThan(3.5);
    // angle mode: level within a few degrees despite the stick wobble
    expect(Math.abs(res.obs.euler[0])).toBeLessThan(0.5);
    const m = res.info.metrics;
    expect(m.type).toBe('hover');
    expect(m.elapsedS).toBeCloseTo(4, 1);
    expect(m.rmsErrorM).toBeGreaterThan(0);
    expect(m.normalizedError).toBeCloseTo(m.rmsErrorM! / 1, 6);
    expect(res.obs.probes).toHaveLength(6);
    expect(obsVectorLabels(6)).toHaveLength(trace[0].length);
  }, 120000);

  test('an episode is a pure function of scenario, seed and actions: bit-identical replays, different seeds differ', async () => {
    const env = await createNodeEnv();
    const a = await episode(env, HOVER, 1234);
    const b = await episode(env, undefined, 1234);
    expect(b.trace).toEqual(a.trace);
    const c = await episode(env, undefined, 99);
    expect(c.trace).not.toEqual(a.trace);
  }, 180000);

  test('domain randomization: builds and conditions differ by seed, and repeat for the same seed', async () => {
    const env = await createNodeEnv();
    const sc: Scenario = {
      ...HOVER,
      randomize: {
        drone: { parts: { battery: { choice: ['b6s1300', 'b6s1100', 'b6s1300hv'] } }, overrides: { massScale: { uniform: [0.9, 1.1] }, propThrustScale: { normal: [1, 0.05], min: 0.85, max: 1.15 } }, cameraUptiltDeg: { uniform: [20, 40] } },
        sim: { windSpeed: { uniform: [0, 6] }, windDirection: { uniform: [0, 360] } },
        start: { yawDeg: { uniform: [-30, 30] } },
      },
    };
    const eps = [];
    for (const seed of [1, 2, 3, 1]) eps.push((await env.reset({ scenario: sc, seed })).info.episode);
    expect(eps[3]).toEqual(eps[0]);
    expect(eps[1].spec).not.toEqual(eps[0].spec);
    expect(eps[1].settings.wind.speed).not.toBe(eps[0].settings.wind.speed);
    for (const e of eps) {
      expect(e.spec.overrides.massScale).toBeGreaterThanOrEqual(0.9);
      expect(e.spec.overrides.massScale).toBeLessThan(1.1);
      expect(e.spec.unitSeed).toBeTypeOf('number');
    }
  }, 120000);

  test('gates task: passing the course\'s first gate is rewarded and counted', async () => {
    const env = await createNodeEnv();
    const sc: Scenario = { format: 'fpvsim-scenario', version: 1, map: { id: 'field' }, drone: { preset: '5" Freestyle 6S' }, task: { type: 'gates', laps: 1 }, episode: { maxSeconds: 2, controlHz: 100 }, start: { armed: true, mode: 'angle' } };
    const r = await env.reset({ scenario: sc });
    const g = env.core.map.gates[0], c = openingCentre(g);
    // start 3 m in front of gate 0, facing it, level with the middle of its opening
    const nx = -Math.sin(g.yaw), ny = Math.cos(g.yaw);
    expect(r.obs.goal).toEqual([c.x, c.y, c.z]);
    env.core.placeAt({ x: c.x - 3 * nx, y: c.y - 3 * ny, z: c.z }, Math.atan2(ny, nx));
    env.core.quad.s.vel = { x: 8 * nx, y: 8 * ny, z: 0 };
    let res: StepResult;
    let gate = false;
    do { res = env.step({ throttle: 0.4 }); if (res.info.events.some((e) => e.type === 'gate')) gate = true; } while (!res.terminated && !res.truncated);
    expect(gate).toBe(true);
    expect(res.info.metrics.passed).toBe(1);
    expect(res.info.metrics.total).toBe(env.core.map.gates.length + 1);
    expect(res.info.metrics.return).toBeGreaterThan(10);
  }, 120000);

  test('crash ends the episode', async () => {
    const env = await createNodeEnv();
    await env.reset({ scenario: { format: 'fpvsim-scenario', version: 1, map: { id: 'field' }, start: { pos: [0, 0, 25] }, episode: { maxSeconds: 10 } } });
    let res: StepResult;
    do res = env.step({ throttle: 0 }); while (!res.terminated && !res.truncated);
    expect(res.info.reason).toBe('crash');
    expect(res.info.events.some((e) => e.type === 'impact')).toBe(true);
  }, 120000);

  test('invalid scenarios are refused with the reasons', async () => {
    const env = await createNodeEnv();
    await expect(env.reset({ scenario: { format: 'fpvsim-scenario', version: 1, map: { id: 'nowhere' }, task: { type: 'hover', radius: 2 } } })).rejects.toThrow(/map\.id.*\n.*task\.radius/s);
  });
});

test('probe directions: unit vectors spread over the sphere', () => {
  const d = probeDirections(64);
  expect(d).toHaveLength(64);
  for (const v of d) expect(Math.hypot(v.x, v.y, v.z)).toBeCloseTo(1, 9);
  const mean = d.reduce((a, v) => ({ x: a.x + v.x / 64, y: a.y + v.y / 64, z: a.z + v.z / 64 }), { x: 0, y: 0, z: 0 });
  expect(Math.hypot(mean.x, mean.y, mean.z)).toBeLessThan(0.05);
});
