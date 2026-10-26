// Scenario files: the JSON Schema and the parser agree, the shipped examples are valid and run,
// episodes resolve deterministically from their seed, and the randomization distributions draw
// what they say.
import Ajv from 'ajv';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { buildDrone, DEFAULT_SPEC } from '../src/builder/derive';
import { createNodeEnv } from '../src/headless/node';
import { MAPS } from '../src/maps/maps';
import { checkDist, Dist, sample, sampleBuild } from '../src/scenario/randomize';
import { parseScenario, resolveEpisode, Scenario } from '../src/scenario/scenario';
import { Rng } from '../src/sim/math';

const ROOT = new URL('../', import.meta.url);
const schema = JSON.parse(readFileSync(new URL('schemas/scenario.v1.schema.json', ROOT), 'utf8'));
const schemaCheck = new Ajv({ allErrors: true, strict: false }).compile(schema);
const hasMap = (id: string) => id in MAPS;
const examples = readdirSync(new URL('scenarios/', ROOT)).filter((f) => f.endsWith('.json')).map((f) => [f, JSON.parse(readFileSync(new URL(`scenarios/${f}`, ROOT), 'utf8'))] as const);

describe('scenario format', () => {
  test.each(examples)('%s is valid for the schema and the simulator', (_f, doc) => {
    expect(schemaCheck(doc), JSON.stringify(schemaCheck.errors)).toBe(true);
    const { scenario, errors } = parseScenario(doc, hasMap);
    expect(errors).toEqual([]);
    const ep = resolveEpisode(scenario!);
    expect(() => buildDrone(ep.spec)).not.toThrow();
  });

  // [what, document, an error the parser reports, whether the schema can tell]
  const bad: [string, unknown, RegExp, boolean][] = [
    ['wrong format', { format: 'x', version: 1 }, /^format/, true],
    ['newer version', { format: 'fpvsim-scenario', version: 2 }, /^version/, true],
    ['typo in a key', { format: 'fpvsim-scenario', version: 1, episode: { maxSecond: 3 } }, /episode\.maxSecond: unknown key/, true],
    ['unknown map', { format: 'fpvsim-scenario', version: 1, map: { id: 'atlantis' } }, /map\.id/, false],
    ['unknown preset', { format: 'fpvsim-scenario', version: 1, drone: { preset: 'X' } }, /drone\.preset/, false],
    ['unknown part', { format: 'fpvsim-scenario', version: 1, drone: { spec: { motor: 'm9999' } } }, /drone\.spec\.motor/, false],
    ['bad physics rate', { format: 'fpvsim-scenario', version: 1, sim: { physicsHz: 1000 } }, /physicsHz/, true],
    ['hover key on a gates task', { format: 'fpvsim-scenario', version: 1, task: { type: 'gates', radiusM: 2 } }, /task\.radiusM/, true],
    ['waypoints without points', { format: 'fpvsim-scenario', version: 1, task: { type: 'waypoints' } }, /task\.points/, true],
    ['empty choice', { format: 'fpvsim-scenario', version: 1, randomize: { sim: { windSpeed: { choice: [] } } } }, /windSpeed\.choice/, true],
    ['reversed range', { format: 'fpvsim-scenario', version: 1, randomize: { sim: { windSpeed: { uniform: [5, 1] } } } }, /windSpeed\.uniform/, false],
    ['unknown distribution', { format: 'fpvsim-scenario', version: 1, randomize: { start: { dx: { gauss: [0, 1] } } } }, /start\.dx: unknown distribution/, true],
    ['unknown randomized part id', { format: 'fpvsim-scenario', version: 1, randomize: { drone: { parts: { prop: { choice: ['p-hq5043', 'p-none'] } } } } }, /p-none/, false],
    ['too many probes', { format: 'fpvsim-scenario', version: 1, observations: { probes: 1000 } }, /probes/, true],
  ];
  test.each(bad)('rejects: %s', (_what, doc, re, schemaToo) => {
    const { scenario, errors } = parseScenario(doc, hasMap);
    expect(scenario).toBeNull();
    expect(errors.join('\n')).toMatch(re);
    if (schemaToo) expect(schemaCheck(doc)).toBe(false);
  });

  test('episodes: the same seed resolves to the same episode; each randomized group has its own stream', () => {
    const base = examples.find(([f]) => f === 'hover-randomized.json')![1] as Scenario;
    expect(resolveEpisode(base, 5)).toEqual(resolveEpisode(base, 5));
    expect(resolveEpisode(base, 5)).not.toEqual(resolveEpisode(base, 6));
    // dropping the drone ranges must not change the wind drawn for the same seed
    const noDrone: Scenario = { ...base, randomize: { ...base.randomize, drone: undefined } };
    expect(resolveEpisode(noDrone, 5).settings.wind).toEqual(resolveEpisode(base, 5).settings.wind);
    // without randomization the scenario's own build flies, with the build's own unit
    expect(resolveEpisode({ format: 'fpvsim-scenario', version: 1 }).spec).toEqual({ ...DEFAULT_SPEC, overrides: {} });
  });
});

describe('distributions', () => {
  const draw = (d: Dist, n = 4000, seed = 1) => { const r = new Rng(seed); return Array.from({ length: n }, () => sample(d, r) as number); };
  test('uniform, loguniform, normal (clipped), weighted choice', () => {
    const u = draw({ uniform: [2, 4] });
    expect(Math.min(...u)).toBeGreaterThanOrEqual(2); expect(Math.max(...u)).toBeLessThan(4);
    expect(u.reduce((a, x) => a + x, 0) / u.length).toBeCloseTo(3, 1);
    const l = draw({ loguniform: [1, 100] });
    expect(l.filter((x) => x < 10).length / l.length).toBeCloseTo(0.5, 1);
    const n = draw({ normal: [0, 1], min: -1, max: 1 });
    expect(Math.min(...n)).toBe(-1); expect(Math.max(...n)).toBe(1);
    const c = draw({ choice: [1, 2], weights: [3, 1] });
    expect(c.filter((x) => x === 1).length / c.length).toBeCloseTo(0.75, 1);
    expect(draw(7, 3)).toEqual([7, 7, 7]);
  });
  test('checkDist names the problem', () => {
    expect(checkDist({ uniform: [1] }, 'x')).toEqual(['x.uniform: expected [min, max]']);
    expect(checkDist({ choice: [1, 2], weights: [1] }, 'x')[0]).toMatch(/weights/);
    expect(checkDist('a', 'x')).toHaveLength(1);
    expect(checkDist('a', 'x', false)).toEqual([]);
  });
  test('sampled builds are physically consistent: a heavier draw has more inertia and a lower T/W', () => {
    const r = new Rng(3);
    const specs = Array.from({ length: 20 }, () => sampleBuild(DEFAULT_SPEC, { overrides: { massScale: { uniform: [0.8, 1.2] } }, parts: { battery: { choice: ['b6s1300', 'b6s1100'] } } }, r));
    const builds = specs.map(buildDrone).sort((a, b) => a.info.auwG - b.info.auwG);
    const light = builds[0], heavy = builds[builds.length - 1];
    expect(heavy.info.inertia.xx).toBeGreaterThan(light.info.inertia.xx);
    expect(heavy.info.thrustToWeight).toBeLessThan(light.info.thrustToWeight);
    expect(new Set(specs.map((s) => s.unitSeed)).size).toBe(20);
  });
});

describe.skipIf(!existsSync(new URL('public/bf/betaflight.mjs', ROOT)))('example scenarios run headless', () => {
  test.each(examples)('%s', async (_f, doc) => {
    const env = await createNodeEnv();
    const r = await env.reset({ scenario: doc });
    expect(r.info.cliErrors).toEqual([]);
    for (let i = 0; i < 50; i++) env.step({ throttle: 0.3 });
    if ((doc as Scenario).start?.armed) expect(env.observe().armed).toBe(true);
    // a diff all in firmware.cli reached the flight controller
    if ((doc as Scenario).firmware?.cli?.some((l) => /roll_srate = 72/.test(l))) {
      expect(() => env.cli(['get roll_srate'])).toThrow(/disarm/);
      for (let i = 0; i < 20 && env.observe().armed; i++) env.step({ arm: false, throttle: 0 });
      expect(env.cli(['rateprofile 0', 'get roll_srate'])).toMatch(/roll_srate = 72\b/);
    }
  }, 60000);
});
