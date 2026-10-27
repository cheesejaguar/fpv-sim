// Scenario files (format "fpvsim-scenario", version 1): one JSON document that pins down an
// experiment or a training drill — map and course, drone build, conditions, firmware configuration,
// start, task, episode limits, observations and domain randomization — so a run can be handed to
// someone else and repeated exactly. The format is documented in docs/SCENARIO_FORMAT.md and has a
// JSON Schema (schemas/scenario.v1.schema.json); parseScenario() checks the same rules and says what
// is wrong, resolveEpisode() turns a scenario and a seed into everything one episode needs.
import { parseSpec, validSim } from '../app/persist';
import { DEFAULT_SPEC, DroneSpec, PRESETS } from '../builder/derive';
import { BATTERIES, ESCS, FCS, FRAMES, MOTORS, PROPS, VIDEO } from '../data/catalog';
import { Rng, subSeed } from '../sim/math';
import { DEFAULT_SETTINGS, SimSettings } from '../worker/shared';
import type { MapDef } from '../maps/world';
import { checkDist, Randomization, sample, sampleBuild, sampleSim, sampleSpawn, sampleStart } from './randomize';
import type { TaskDef, Vec3 } from './tasks';

export const SCENARIO_FORMAT = 'fpvsim-scenario';
export const SCENARIO_VERSION = 1;

export type FlightMode = 'acro' | 'horizon' | 'angle';

export interface Scenario {
  format: typeof SCENARIO_FORMAT;
  version: 1;
  meta?: { id?: string; name?: string; description?: string; author?: string; license?: string };
  /** master seed: episode k of a run is seeded with subSeed(seed, k) unless reset() is given one */
  seed?: number;
  map?: { id: string; course?: string };
  /** a preset (by name) and / or fields of a DroneSpec over it (or over the default 5" build) */
  drone?: { preset?: string; spec?: Partial<DroneSpec> };
  /** simulation settings (SimSettings fields; map, pause and time scale come from elsewhere) */
  sim?: Partial<Omit<SimSettings, 'mapId' | 'courseId' | 'spawnId' | 'paused' | 'timeScale' | 'wind'>> & { wind?: Partial<SimSettings['wind']> };
  /** Betaflight CLI lines run after the simulator's defaults, then saved (a `diff all` works) */
  firmware?: { cli?: string[] };
  start?: {
    /** start position (ENU, m); default: the map's (or course's) spawn pad */
    pos?: Vec3;
    yawDeg?: number;
    /** start with the quad armed (after Betaflight's boot grace) */
    armed?: boolean;
    mode?: FlightMode;
    /** a named spawn of the map (its spawns) to start from, instead of the default spawn */
    spawn?: string;
  };
  task?: TaskDef;
  episode?: {
    /** episode length (s of sim time); default 30 */
    maxSeconds?: number;
    /** control (action) rate, Hz; default 100 */
    controlHz?: number;
    /** end the episode at an impact of at least crashSpeedMs (default true, 4 m/s) */
    endOnCrash?: boolean;
    crashSpeedMs?: number;
    /** end the episode when the quad leaves the map (default true) */
    endOutOfBounds?: boolean;
  };
  observations?: {
    /** proximity probes: rays from the quad on a Fibonacci sphere (0 = none) */
    probes?: number;
    probeRangeM?: number;
    /** add Observation.actors (targets, detections, RC link margin) and its numbers at the end of the vector */
    actors?: boolean;
  };
  randomize?: Randomization;
}

/**
 * What the scenario checks and the episode resolution need to know about its map (the map has to be
 * loaded to know them): spawn ids, actors, the map's suggested wind. mapFacts(MapDef) makes one.
 */
export interface MapFacts {
  spawns: string[];
  actors: { id: string; type: string }[];
  wind?: SimSettings['wind'];
}

export function mapFacts(m: MapDef): MapFacts {
  return { spawns: (m.spawns ?? []).map((s) => s.id), actors: (m.actors ?? []).map((a) => ({ id: a.id, type: a.type })), ...(m.wind && { wind: { ...m.wind } }) };
}

/** Everything one episode needs, with every random choice made. */
export interface Episode {
  seed: number;
  mapId: string;
  courseId: string;
  spec: DroneSpec;
  settings: SimSettings;
  cli: string[];
  start: { pos: Vec3 | null; yawDeg: number | null; offset: Vec3; yawOffsetDeg: number; armed: boolean; mode: FlightMode };
  task: TaskDef;
  maxSeconds: number;
  controlHz: number;
  endOnCrash: boolean;
  crashSpeedMs: number;
  endOutOfBounds: boolean;
  probes: number;
  probeRangeM: number;
  /** observations.actors: the target ids observed (map order), null when not observed */
  observeActors: string[] | null;
  /** randomize.actors drawn for this episode: apply with randomizeActors(map, ...), null when none */
  actors: { jitterM: number; speedScale: number[]; seed: number } | null;
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const vec3 = (x: unknown): x is Vec3 => Array.isArray(x) && x.length === 3 && x.every(num);
const COMPONENTS: Record<string, readonly { id: string }[]> = { frame: FRAMES, motor: MOTORS, prop: PROPS, battery: BATTERIES, esc: ESCS, fc: FCS, video: VIDEO };
const SIM_KEYS = ['physicsHz', 'damage', 'wind', 'propwash', 'rcLinkHz', 'rcTxPowerMw', 'ambientC', 'autoRate'] as const;

/**
 * Check a scenario. Returns it typed when it is valid, and every problem found (unknown keys
 * included: a typo must not silently fall back to a default). `hasMap` checks map ids (the app's
 * registry); leave it out to accept any id.
 */
export function parseScenario(raw: unknown, hasMap?: (id: string) => boolean, facts?: (id: string) => MapFacts | null): { scenario: Scenario | null; errors: string[] } {
  const errors: string[] = [];
  const err = (e: string) => errors.push(e);
  if (!isObj(raw)) return { scenario: null, errors: ['a scenario is a JSON object'] };
  const allow = (o: Record<string, unknown>, path: string, keys: readonly string[]) => { for (const k of Object.keys(o)) if (!keys.includes(k)) err(`${path}${k}: unknown key`); };
  allow(raw, '', ['$schema', 'format', 'version', 'meta', 'seed', 'map', 'drone', 'sim', 'firmware', 'start', 'task', 'episode', 'observations', 'randomize']);
  if (raw.format !== SCENARIO_FORMAT) err(`format: expected "${SCENARIO_FORMAT}"`);
  if (raw.version !== SCENARIO_VERSION) err(`version: this simulator reads version ${SCENARIO_VERSION}`);
  if (raw.meta !== undefined) {
    if (!isObj(raw.meta)) err('meta: expected an object');
    else { allow(raw.meta, 'meta.', ['id', 'name', 'description', 'author', 'license']); for (const [k, x] of Object.entries(raw.meta)) if (typeof x !== 'string') err(`meta.${k}: expected text`); }
  }
  if (raw.seed !== undefined && !(Number.isInteger(raw.seed) && (raw.seed as number) >= 0 && (raw.seed as number) < 2 ** 32)) err('seed: expected an integer 0 .. 2^32-1');
  if (raw.map !== undefined) {
    const m = raw.map;
    if (!isObj(m) || typeof m.id !== 'string') err('map: expected { "id": "<map id>", "course"?: "<course id>" }');
    else {
      allow(m, 'map.', ['id', 'course']);
      if (hasMap && !hasMap(m.id)) err(`map.id: no map "${m.id}"`);
      if (m.course !== undefined && typeof m.course !== 'string') err('map.course: expected text');
    }
  }
  if (raw.drone !== undefined) {
    const d = raw.drone;
    if (!isObj(d)) err('drone: expected an object');
    else {
      allow(d, 'drone.', ['preset', 'spec']);
      if (d.preset !== undefined && !PRESETS.some((p) => p.name === d.preset)) err(`drone.preset: no preset "${String(d.preset)}" (${PRESETS.map((p) => p.name).join(', ')})`);
      if (d.spec !== undefined) {
        if (!isObj(d.spec)) err('drone.spec: expected an object');
        else {
          allow(d.spec, 'drone.spec.', [...Object.keys(DEFAULT_SPEC), 'unitSeed']);
          for (const [k, list] of Object.entries(COMPONENTS)) {
            const id = d.spec[k];
            if (id !== undefined && !(typeof id === 'string' && list.some((c) => c.id === id))) err(`drone.spec.${k}: unknown id "${String(id)}"`);
          }
        }
      }
    }
  }
  if (raw.sim !== undefined) {
    if (!isObj(raw.sim)) err('sim: expected an object');
    else {
      allow(raw.sim, 'sim.', SIM_KEYS);
      if (raw.sim.physicsHz !== undefined && ![2000, 4000, 8000].includes(raw.sim.physicsHz as number)) err('sim.physicsHz: 2000, 4000 or 8000');
      if (raw.sim.wind !== undefined) { if (!isObj(raw.sim.wind)) err('sim.wind: expected an object'); else allow(raw.sim.wind, 'sim.wind.', ['speed', 'direction', 'turbulence', 'gusts']); }
      for (const k of ['propwash', 'rcLinkHz', 'rcTxPowerMw', 'ambientC'] as const) if (raw.sim[k] !== undefined && !num(raw.sim[k])) err(`sim.${k}: expected a number`);
      if (isObj(raw.sim.wind)) for (const [k, x] of Object.entries(raw.sim.wind)) if (!num(x)) err(`sim.wind.${k}: expected a number`);
    }
  }
  if (raw.firmware !== undefined) {
    const f = raw.firmware;
    if (!isObj(f)) err('firmware: expected an object');
    else {
      allow(f, 'firmware.', ['cli']);
      if (f.cli !== undefined && !(Array.isArray(f.cli) && f.cli.every((l) => typeof l === 'string' && l.length < 400))) err('firmware.cli: expected a list of CLI lines');
    }
  }
  if (raw.start !== undefined) {
    const s = raw.start;
    if (!isObj(s)) err('start: expected an object');
    else {
      allow(s, 'start.', ['pos', 'yawDeg', 'armed', 'mode', 'spawn']);
      if (s.spawn !== undefined && !(typeof s.spawn === 'string' && s.spawn.length > 0)) err('start.spawn: expected a spawn id');
      if (s.pos !== undefined && !vec3(s.pos)) err('start.pos: expected [x, y, z]');
      if (s.yawDeg !== undefined && !num(s.yawDeg)) err('start.yawDeg: expected a number');
      if (s.armed !== undefined && typeof s.armed !== 'boolean') err('start.armed: expected true or false');
      if (s.mode !== undefined && !['acro', 'horizon', 'angle'].includes(s.mode as string)) err('start.mode: acro, horizon or angle');
    }
  }
  if (raw.task !== undefined) errors.push(...checkTask(raw.task));
  if (raw.episode !== undefined) {
    const e = raw.episode;
    if (!isObj(e)) err('episode: expected an object');
    else {
      allow(e, 'episode.', ['maxSeconds', 'controlHz', 'endOnCrash', 'crashSpeedMs', 'endOutOfBounds']);
      if (e.maxSeconds !== undefined && !(num(e.maxSeconds) && e.maxSeconds > 0 && e.maxSeconds <= 3600)) err('episode.maxSeconds: 0 .. 3600');
      if (e.controlHz !== undefined && !(num(e.controlHz) && e.controlHz >= 1 && e.controlHz <= 1000)) err('episode.controlHz: 1 .. 1000');
      if (e.crashSpeedMs !== undefined && !(num(e.crashSpeedMs) && e.crashSpeedMs > 0)) err('episode.crashSpeedMs: a positive number');
      for (const k of ['endOnCrash', 'endOutOfBounds'] as const) if (e[k] !== undefined && typeof e[k] !== 'boolean') err(`episode.${k}: expected true or false`);
    }
  }
  if (raw.observations !== undefined) {
    const o = raw.observations;
    if (!isObj(o)) err('observations: expected an object');
    else {
      allow(o, 'observations.', ['probes', 'probeRangeM', 'actors']);
      if (o.actors !== undefined && typeof o.actors !== 'boolean') err('observations.actors: expected true or false');
      if (o.probes !== undefined && !(Number.isInteger(o.probes) && (o.probes as number) >= 0 && (o.probes as number) <= 256)) err('observations.probes: 0 .. 256');
      if (o.probeRangeM !== undefined && !(num(o.probeRangeM) && o.probeRangeM > 0 && o.probeRangeM <= 500)) err('observations.probeRangeM: 0 .. 500');
    }
  }
  if (raw.randomize !== undefined) errors.push(...checkRandomize(raw.randomize));
  // ids that name things on the map: checked when the map is known (loaded)
  const mapId = isObj(raw.map) && typeof raw.map.id === 'string' ? raw.map.id : DEFAULT_SETTINGS.mapId;
  const f = facts && (!hasMap || hasMap(mapId)) ? facts(mapId) : null;
  if (f) {
    const spawn = isObj(raw.start) ? raw.start.spawn : undefined;
    if (typeof spawn === 'string' && !f.spawns.includes(spawn)) err(`start.spawn: map "${mapId}" has no spawn "${spawn}"${f.spawns.length ? ` (${f.spawns.join(', ')})` : ''}`);
    const rs = isObj(raw.randomize) ? raw.randomize.spawn : undefined;
    if (Array.isArray(rs)) for (const id of rs) if (typeof id === 'string' && !f.spawns.includes(id)) err(`randomize.spawn: map "${mapId}" has no spawn "${id}"`);
    const tgt = isObj(raw.task) ? raw.task.target : undefined;
    if (typeof tgt === 'string' && !f.actors.some((a) => a.id === tgt && a.type === 'target')) err(`task.target: map "${mapId}" has no target actor "${tgt}"`);
  }
  return { scenario: errors.length ? null : (raw as unknown as Scenario), errors };
}

function checkTask(t: unknown): string[] {
  const out: string[] = [];
  if (!isObj(t)) return ['task: expected an object with a "type"'];
  const keys: Record<string, string[]> = {
    free: [], hover: ['target', 'heightM', 'radiusM', 'holdS'], gates: ['laps'], waypoints: ['points', 'radiusM'],
    'reach-target': ['target', 'radiusM', 'holdS'], 'track-target': ['target', 'rangeM', 'fovDeg', 'holdS'], 'detect-avoid': ['points', 'target', 'radiusM', 'maxDetectedS'],
  };
  const type = t.type as string;
  if (!Object.hasOwn(keys, type)) return [`task.type: ${Object.keys(keys).join(', ')}`];
  for (const k of Object.keys(t)) if (k !== 'type' && !keys[type].includes(k)) out.push(`task.${k}: unknown key for a ${type} task`);
  // hover: a point; the actor tasks: a target actor's id
  if (type === 'hover' && t.target !== undefined && !vec3(t.target)) out.push('task.target: expected [x, y, z]');
  if ((type === 'reach-target' || type === 'track-target') && !(typeof t.target === 'string' && t.target)) out.push('task.target: the id of a target actor of the map');
  if (type === 'detect-avoid' && t.target !== undefined && !(typeof t.target === 'string' && t.target)) out.push('task.target: the id of a target actor of the map');
  for (const k of ['heightM', 'radiusM', 'holdS', 'rangeM'] as const) if (t[k] !== undefined && !(num(t[k]) && (t[k] as number) > 0)) out.push(`task.${k}: a positive number`);
  if (t.fovDeg !== undefined && !(num(t.fovDeg) && t.fovDeg > 0 && t.fovDeg <= 360)) out.push('task.fovDeg: 0 .. 360');
  if (t.maxDetectedS !== undefined && !(num(t.maxDetectedS) && t.maxDetectedS >= 0)) out.push('task.maxDetectedS: a number >= 0');
  if (type === 'detect-avoid') {
    if (t.points !== undefined && !(Array.isArray(t.points) && t.points.length > 0 && t.points.every(vec3))) out.push('task.points: a list of [x, y, z]');
    if (t.points === undefined && t.target === undefined) out.push('task: a detect-avoid task needs points, a target or both');
  }
  if (t.laps !== undefined && !(Number.isInteger(t.laps) && (t.laps as number) >= 1 && (t.laps as number) <= 100)) out.push('task.laps: 1 .. 100');
  if (type === 'waypoints' && !(Array.isArray(t.points) && t.points.length > 0 && t.points.every(vec3))) out.push('task.points: a list of [x, y, z]');
  return out;
}

function checkRandomize(r: unknown): string[] {
  const out: string[] = [];
  if (!isObj(r)) return ['randomize: expected an object'];
  for (const k of Object.keys(r)) if (!['drone', 'sim', 'start', 'spawn', 'actors'].includes(k)) out.push(`randomize.${k}: unknown key`);
  if (r.spawn !== undefined && r.spawn !== 'any' && !(Array.isArray(r.spawn) && r.spawn.length > 0 && r.spawn.every((x) => typeof x === 'string' && x.length > 0))) out.push('randomize.spawn: "any" or a list of spawn ids');
  if (r.actors !== undefined) {
    const a = r.actors;
    if (!isObj(a)) out.push('randomize.actors: expected an object');
    else {
      for (const k of Object.keys(a)) if (k !== 'jitterM' && k !== 'speedScale') out.push(`randomize.actors.${k}: unknown key`);
      if (a.jitterM !== undefined && !(num(a.jitterM) && a.jitterM >= 0 && a.jitterM <= 1000)) out.push('randomize.actors.jitterM: 0 .. 1000');
      if (a.speedScale !== undefined) out.push(...checkDist(a.speedScale, 'randomize.actors.speedScale'));
    }
  }
  const group = (g: unknown, path: string, keys: readonly string[], numeric = true) => {
    if (g === undefined) return;
    if (!isObj(g)) { out.push(`${path}: expected an object`); return; }
    for (const [k, d] of Object.entries(g)) {
      if (!keys.includes(k)) { out.push(`${path}.${k}: unknown key`); continue; }
      out.push(...checkDist(d, `${path}.${k}`, numeric));
    }
  };
  const d = r.drone;
  if (d !== undefined) {
    if (!isObj(d)) out.push('randomize.drone: expected an object');
    else {
      const scalar = ['cameraUptiltDeg', 'batterySoc', 'batteryAge', 'extraMassG', 'extraMassZmm', 'motorTiltDeg'];
      for (const k of Object.keys(d)) if (![...scalar, 'preset', 'parts', 'overrides', 'unit'].includes(k)) out.push(`randomize.drone.${k}: unknown key`);
      for (const k of scalar) if (d[k] !== undefined) out.push(...checkDist(d[k], `randomize.drone.${k}`));
      if (d.unit !== undefined && typeof d.unit !== 'boolean') out.push('randomize.drone.unit: expected true or false');
      if (d.preset !== undefined) {
        out.push(...checkDist(d.preset, 'randomize.drone.preset', false));
        const names = isObj(d.preset) && Array.isArray(d.preset.choice) ? d.preset.choice : [d.preset];
        for (const n of names) if (typeof n === 'string' && !PRESETS.some((p) => p.name === n)) out.push(`randomize.drone.preset: no preset "${n}"`);
      }
      if (d.parts !== undefined) {
        if (!isObj(d.parts)) out.push('randomize.drone.parts: expected an object');
        else for (const [k, pd] of Object.entries(d.parts)) {
          const list = COMPONENTS[k];
          if (!list) { out.push(`randomize.drone.parts.${k}: unknown component`); continue; }
          out.push(...checkDist(pd, `randomize.drone.parts.${k}`, false));
          const ids = isObj(pd) && Array.isArray(pd.choice) ? pd.choice : [pd];
          for (const id of ids) if (!(typeof id === 'string' && list.some((c) => c.id === id))) out.push(`randomize.drone.parts.${k}: unknown id "${String(id)}"`);
        }
      }
      if (d.overrides !== undefined) {
        if (!isObj(d.overrides)) out.push('randomize.drone.overrides: expected an object');
        else for (const [k, od] of Object.entries(d.overrides)) {
          if (!/^[a-z][A-Za-z0-9]{0,40}$/.test(k)) out.push(`randomize.drone.overrides.${k}: not an override name`);
          out.push(...checkDist(od, `randomize.drone.overrides.${k}`));
        }
      }
    }
  }
  group(r.sim, 'randomize.sim', ['windSpeed', 'windDirection', 'windTurbulence', 'windGusts', 'ambientC', 'propwash', 'rcLinkHz', 'rcTxPowerMw']);
  group(r.start, 'randomize.start', ['dx', 'dy', 'dz', 'yawDeg']);
  return out;
}

/** The scenario's own drone (before randomization). */
export function scenarioSpec(sc: Scenario): DroneSpec {
  const base = sc.drone?.preset ? PRESETS.find((p) => p.name === sc.drone!.preset) ?? DEFAULT_SPEC : DEFAULT_SPEC;
  const merged = { ...structuredClone(base), ...(sc.drone?.spec ?? {}) };
  if (sc.drone?.spec?.overrides) merged.overrides = { ...base.overrides, ...sc.drone.spec.overrides };
  const spec = parseSpec(merged);
  if (!spec) throw new Error('drone: the build has an unknown component');
  if (sc.drone?.spec?.unitSeed !== undefined) spec.unitSeed = sc.drone.spec.unitSeed;
  return spec;
}

/** The scenario's own settings (before randomization). */
export function scenarioSettings(sc: Scenario, mapWind?: SimSettings['wind']): SimSettings {
  const s = sc.sim ?? {};
  return validSim({
    ...DEFAULT_SETTINGS, ...s,
    // no wind of its own: the map's suggested wind (MapDef.wind), if it has one
    wind: s.wind || !mapWind ? { ...DEFAULT_SETTINGS.wind, ...(s.wind ?? {}) } : { ...mapWind },
    mapId: sc.map?.id ?? DEFAULT_SETTINGS.mapId, courseId: sc.map?.course ?? '',
    timeScale: 1, paused: false,
    // a scenario never lets the physics rate change under it
    autoRate: false,
  });
}

/**
 * One episode of the scenario. `seed`: the episode's own seed (reproduces exactly that episode);
 * default: the scenario's seed (episode 0). Every random choice comes from this seed. `map`: what
 * the scenario's map has (mapFacts), when it is loaded: its wind, its spawns for randomize.spawn,
 * its targets for observations.actors.
 */
export function resolveEpisode(sc: Scenario, seed?: number, map?: MapFacts | null): Episode {
  const s = (seed ?? sc.seed ?? 0) >>> 0;
  const rnd = sc.randomize;
  // each group draws from its own stream: adding a drone range doesn't change the sampled wind
  const spec = sampleBuild(scenarioSpec(sc), rnd?.drone, new Rng(subSeed(s, 1)));
  const settings = sampleSim(scenarioSettings(sc, map?.wind), rnd?.sim, new Rng(subSeed(s, 2)));
  const off = sampleStart(rnd?.start, new Rng(subSeed(s, 3)));
  // the spawn variant (stream 4), the actors (stream 5): new streams, the others draw as before
  const spawn = rnd?.spawn !== undefined ? sampleSpawn(rnd.spawn, map?.spawns ?? null, new Rng(subSeed(s, 4))) ?? sc.start?.spawn : sc.start?.spawn;
  if (spawn) settings.spawnId = spawn;
  const ra = rnd?.actors;
  let actors: Episode['actors'] = null;
  if (ra) {
    const r = new Rng(subSeed(s, 5));
    actors = { jitterM: ra.jitterM ?? 0, speedScale: [], seed: Math.floor(r.next() * 4294967296) };
    // one speed scale per path of the map (in map order), drawn up front
    const nPaths = 32;
    for (let k = 0; k < nPaths; k++) actors.speedScale.push(ra.speedScale === undefined ? 1 : Math.max(0, sample(ra.speedScale, r)));
  }
  const e = sc.episode ?? {};
  return {
    seed: s,
    mapId: settings.mapId, courseId: settings.courseId ?? '',
    spec, settings,
    cli: sc.firmware?.cli ?? [],
    start: {
      pos: sc.start?.pos ?? null, yawDeg: sc.start?.yawDeg ?? null,
      offset: [off.dx, off.dy, off.dz], yawOffsetDeg: off.yawDeg,
      armed: sc.start?.armed ?? false, mode: sc.start?.mode ?? 'acro',
    },
    task: sc.task ?? { type: 'free' },
    maxSeconds: e.maxSeconds ?? 30,
    controlHz: e.controlHz ?? 100,
    endOnCrash: e.endOnCrash ?? true,
    crashSpeedMs: e.crashSpeedMs ?? 4,
    endOutOfBounds: e.endOutOfBounds ?? true,
    probes: sc.observations?.probes ?? 0,
    probeRangeM: sc.observations?.probeRangeM ?? 20,
    observeActors: sc.observations?.actors ? (map?.actors ?? []).filter((a) => a.type === 'target').map((a) => a.id) : null,
    actors,
  };
}

/** A minimal valid scenario: free flight on a map with a drone. */
export function defaultScenario(over: Partial<Scenario> = {}): Scenario {
  return { format: SCENARIO_FORMAT, version: SCENARIO_VERSION, ...over };
}
