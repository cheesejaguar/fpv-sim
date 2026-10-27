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
import { MapFacts, parseScenario, resolveEpisode, Scenario } from '../src/scenario/scenario';
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

describe('scenario format: spawns, actor tasks, actor observations and randomization', () => {
  const S = { format: 'fpvsim-scenario', version: 1 } as const;
  const facts = (id: string): MapFacts | null => (id === 'range' ? { spawns: ['north', 'east'], actors: [{ id: 'truck', type: 'target' }, { id: 'radar-1', type: 'detector' }], wind: { speed: 4, direction: 250, turbulence: 1, gusts: 2 } } : null);
  const anyMap = (id: string) => id === 'range' || id in MAPS;
  const good: [string, unknown][] = [
    ['start.spawn', { ...S, map: { id: 'range' }, start: { spawn: 'north' } }],
    ['reach-target', { ...S, map: { id: 'range' }, task: { type: 'reach-target', target: 'truck', radiusM: 3, holdS: 1 } }],
    ['track-target', { ...S, map: { id: 'range' }, task: { type: 'track-target', target: 'truck', rangeM: 20, fovDeg: 50, holdS: 4 } }],
    ['detect-avoid route', { ...S, map: { id: 'range' }, task: { type: 'detect-avoid', points: [[0, 10, 3], [0, 50, 3]], maxDetectedS: 1.5 } }],
    ['detect-avoid to a target', { ...S, map: { id: 'range' }, task: { type: 'detect-avoid', target: 'truck', radiusM: 2 } }],
    ['observations.actors', { ...S, observations: { actors: true, probes: 4 } }],
    ['randomize.spawn any, actors', { ...S, map: { id: 'range' }, randomize: { spawn: 'any', actors: { jitterM: 5, speedScale: { uniform: [0.5, 1.5] } } } }],
    ['randomize.spawn list', { ...S, map: { id: 'range' }, randomize: { spawn: ['north', 'east'] } }],
  ];
  test.each(good)('accepts: %s (schema and parser)', (_what, doc) => {
    expect(schemaCheck(doc), JSON.stringify(schemaCheck.errors)).toBe(true);
    expect(parseScenario(doc, anyMap, facts).errors).toEqual([]);
  });

  const bad: [string, unknown, RegExp, boolean][] = [
    ['unknown task type', { ...S, task: { type: 'chase' } }, /task\.type: .*reach-target/, true],
    ['reach-target without a target', { ...S, task: { type: 'reach-target' } }, /task\.target/, true],
    ['track-target with a hover key', { ...S, task: { type: 'track-target', target: 'truck', heightM: 2 } }, /task\.heightM: unknown key/, true],
    ['detect-avoid without a route', { ...S, task: { type: 'detect-avoid', maxDetectedS: 1 } }, /needs points, a target or both/, true],
    ['negative maxDetectedS', { ...S, task: { type: 'detect-avoid', points: [[0, 0, 1]], maxDetectedS: -1 } }, /maxDetectedS/, true],
    ['fovDeg too wide', { ...S, task: { type: 'track-target', target: 'truck', fovDeg: 400 } }, /fovDeg/, true],
    ['empty start.spawn', { ...S, start: { spawn: '' } }, /start\.spawn/, true],
    ['observations.actors not a flag', { ...S, observations: { actors: 1 } }, /observations\.actors/, true],
    ['randomize.spawn neither any nor a list', { ...S, randomize: { spawn: 'all' } }, /randomize\.spawn/, true],
    ['randomize.actors typo', { ...S, randomize: { actors: { jitter: 2 } } }, /randomize\.actors\.jitter: unknown key/, true],
    ['randomize.actors bad speedScale', { ...S, randomize: { actors: { speedScale: { uniform: [1] } } } }, /speedScale\.uniform/, true],
    // ids on the map: the parser checks them when the map is known (the schema can't)
    ['unknown spawn', { ...S, map: { id: 'range' }, start: { spawn: 'south' } }, /start\.spawn: map "range" has no spawn "south" \(north, east\)/, false],
    ['unknown randomized spawn', { ...S, map: { id: 'range' }, randomize: { spawn: ['north', 'west'] } }, /randomize\.spawn: .* no spawn "west"/, false],
    ['a target that is a detector', { ...S, map: { id: 'range' }, task: { type: 'reach-target', target: 'radar-1' } }, /task\.target: map "range" has no target actor "radar-1"/, false],
  ];
  test.each(bad)('rejects: %s', (_what, doc, re, schemaToo) => {
    const { scenario, errors } = parseScenario(doc, anyMap, facts);
    expect(scenario).toBeNull();
    expect(errors.join('\n')).toMatch(re);
    if (schemaToo) expect(schemaCheck(doc)).toBe(false);
  });

  test('without the map loaded, map ids are not checked', () => {
    expect(parseScenario({ ...S, map: { id: 'range' }, start: { spawn: 'south' } }, anyMap).errors).toEqual([]);
  });

  test('the spawn and the actors draw from new streams; the old ones draw as before; the map wind fills in', () => {
    const base = examples.find(([f]) => f === 'hover-randomized.json')![1] as Scenario;
    const more: Scenario = { ...base, randomize: { ...base.randomize, spawn: 'any', actors: { jitterM: 3, speedScale: { uniform: [0.5, 2] } } } };
    const a = resolveEpisode(base, 9), b = resolveEpisode(more, 9, facts('range'));
    expect(b.spec).toEqual(a.spec);
    expect(b.settings.wind).toEqual(a.settings.wind);
    expect(b.start).toEqual(a.start);
    expect(a.actors).toBeNull();
    expect(b.actors!.jitterM).toBe(3);
    expect(b.actors!.speedScale.every((k) => k >= 0.5 && k < 2)).toBe(true);
    expect(resolveEpisode(more, 9, facts('range'))).toEqual(b);
    // "any": the default spawn or a named one, spread over seeds
    const drawn = new Set(Array.from({ length: 40 }, (_, k) => resolveEpisode(more, k, facts('range')).settings.spawnId ?? ''));
    expect(drawn).toEqual(new Set(['', 'north', 'east']));
    // start.spawn without randomization; no spawn: settings untouched
    expect(resolveEpisode({ ...S, map: { id: 'range' }, start: { spawn: 'east' } }).settings.spawnId).toBe('east');
    expect('spawnId' in resolveEpisode({ ...S }).settings && resolveEpisode({ ...S }).settings.spawnId).toBeFalsy();
    // a scenario without sim.wind flies the map's wind; with one, its own
    expect(resolveEpisode({ ...S, map: { id: 'range' } }, 0, facts('range')).settings.wind).toEqual({ speed: 4, direction: 250, turbulence: 1, gusts: 2 });
    expect(resolveEpisode({ ...S, map: { id: 'range' }, sim: { wind: { speed: 1 } } }, 0, facts('range')).settings.wind.speed).toBe(1);
    // observations.actors: the map's targets, in map order
    expect(resolveEpisode({ ...S, map: { id: 'range' }, observations: { actors: true } }, 0, facts('range')).observeActors).toEqual(['truck']);
    expect(resolveEpisode({ ...S }).observeActors).toBeNull();
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
