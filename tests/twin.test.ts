// Digital twin from a flight log (src/sysid/twin.ts). The "real" log is the simulator's own
// Betaflight blackbox from a drone whose build differs from the one on file (heavier-feeling frame:
// inertia x1.3, props with less torque: x0.8). The twin rebuilds the tune from the log's headers,
// replays the sticks, tells the two builds apart, and the fit moves the build toward the truth.
import { existsSync } from 'node:fs';
import { beforeAll, describe, expect, test } from 'vitest';
import { PRESETS } from '../src/builder/derive';
import { createNodeEnv } from '../src/headless/node';
import { BblLog, decodeBbl } from '../src/sysid/bblDecode';
import { compareLogs, fitTwin, nelderMead, replayLog, tuneFromLog } from '../src/sysid/twin';
import { twinHtml, twinMarkdown } from '../src/sysid/twinReport';

const have = existsSync(new URL('../public/bf/betaflight.mjs', import.meta.url));

test('Nelder-Mead finds a quadratic bowl', async () => {
  const r = await nelderMead(async ([x, y]) => (x - 0.3) ** 2 + 2 * (y + 0.2) ** 2, [0, 0], 0.2, 120);
  expect(r.x[0]).toBeCloseTo(0.3, 2);
  expect(r.x[1]).toBeCloseTo(-0.2, 2);
});

test('the tune is rebuilt from the log headers', () => {
  const lines = tuneFromLog({ rollPID: '45,80,40', rates: '67,67,67', rates_type: '3', dterm_lpf1_dyn_hz: '75,150', feedforward_averaging: '1', gyro_lpf1_static_hz: '250', 'Firmware revision': 'x' });
  expect(lines).toContain('set p_roll = 45');
  expect(lines).toContain('set d_roll = 40');
  expect(lines).toContain('set roll_srate = 67');
  expect(lines).toContain('set rates_type = ACTUAL');
  expect(lines).toContain('set dterm_lpf1_dyn_max_hz = 150');
  expect(lines).toContain('set feedforward_averaging = 2_POINT');
  expect(lines).toContain('set gyro_lpf1_static_hz = 250');
  expect(lines.some((l) => /Firmware/.test(l))).toBe(false);
});

describe.skipIf(!have)('twin (real Betaflight)', () => {
  const spec = PRESETS[0];
  const truth = { ...spec, overrides: { inertiaScale: 1.3, propTorqueScale: 0.8 } };
  let real: BblLog;
  let env: Awaited<ReturnType<typeof createNodeEnv>>;
  beforeAll(async () => {
    env = await createNodeEnv();
    await env.reset({ scenario: { format: 'fpvsim-scenario', version: 1, seed: 9, map: { id: 'field' }, drone: { spec: truth }, sim: { wind: { speed: 0, direction: 0, turbulence: 0, gusts: 0 }, damage: false }, start: { armed: true, mode: 'acro', pos: [0, 0, 150] }, episode: { maxSeconds: 30, controlHz: 1000, endOnCrash: false, endOutOfBounds: false } } });
    const chunks: Uint8Array[] = [];
    env.core.hooks.blackbox = (b) => { if (b.length) chunks.push(b.slice()); };
    for (let k = 0; k < 7000; k++) {
      const t = k / 1000;
      env.step({ throttle: 0.42 + 0.12 * Math.sin(t * 1.3), roll: 0.35 * Math.sin(t * 5.1) * Math.sin(t * 0.7), pitch: 0.3 * Math.sin(t * 3.7 + 1), yaw: 0.25 * Math.sin(t * 2.3) });
    }
    for (let k = 0; k < 60; k++) env.step({ arm: false, throttle: 0 });
    const bytes = new Uint8Array(chunks.reduce((a, c) => a + c.length, 0));
    let o = 0; for (const c of chunks) { bytes.set(c, o); o += c.length; }
    real = decodeBbl(bytes)[0];
  }, 120000);

  test('a replay of the same build matches; the build on file shows the gap; the report renders', async () => {
    const same = await replayLog(env, real, { spec: truth, matchAltitude: false });
    expect(same.cliErrors).toEqual([]);
    const g0 = compareLogs(real, same.sim, same.segment);
    expect(g0.axes.yaw.corr).toBeGreaterThan(0.99);
    expect(g0.axes.roll.corr).toBeGreaterThan(0.99);
    expect(g0.axes.roll.gyroErrRms).toBeLessThan(3);
    const nominal = await replayLog(env, real, { spec, matchAltitude: false });
    const g1 = compareLogs(real, nominal.sim, nominal.segment);
    expect(g1.cost).toBeGreaterThan(g0.cost * 1.1);
    const md = twinMarkdown({ log: 'synthetic', spec: spec.name, gap: g1, cliErrors: [] });
    expect(md).toMatch(/\| roll \|/);
    expect(twinHtml({ log: 'x', spec: 'y', gap: g1, cliErrors: [] })).toMatch(/^<!doctype html>/);
  }, 180000);

  test('the fit moves inertia and prop torque toward the truth and closes most of the gap', async () => {
    const fit = await fitTwin(env, real, { spec, params: ['inertiaScale', 'propTorqueScale'], maxEvals: 24, matchAltitude: false });
    expect(fit.after.cost).toBeLessThan(fit.before.cost * 0.9);
    expect(fit.overrides.inertiaScale!).toBeGreaterThan(1.1);
    expect(fit.overrides.inertiaScale!).toBeLessThan(1.8);
    expect(fit.overrides.propTorqueScale!).toBeLessThan(0.95);
    expect(fit.overrides.propTorqueScale!).toBeGreaterThan(0.55);
  }, 400000);
});
