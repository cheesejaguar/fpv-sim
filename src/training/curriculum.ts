// Training drills with an adaptive curriculum. Each drill turns a difficulty level d (0..1) into a
// scenario (the same files the headless simulator runs: src/scenario/scenario.ts) and judges an
// attempt from the task's metrics. The level follows HyperDrone's curriculum rule: it rises when the
// error is well inside the bound (below 25 % of it: a clean pass), by a step clipped to a small range
// so it never jumps; it holds for a pass that was only just made, and steps back after a failure. A
// pilot and a policy are measured by the same task evaluators (src/scenario/tasks.ts).
import { MAPS } from '../maps/maps';
import { GateDef, spawnGroundZ, withCourse } from '../maps/world';
import { openingCentre } from '../maps/gates';
import type { Scenario } from '../scenario/scenario';
import type { TaskMetrics } from '../scenario/tasks';

export type Outcome = 'pass' | 'hold' | 'fail';

export interface Drill {
  id: string;
  name: string;
  blurb: string;
  mapId: string;
  courseId?: string;
  preset: string;
  /** the scenario of one attempt at level d */
  scenario(d: number): Scenario;
  /** what level d asks, in words */
  describe(d: number): string;
  /** how an attempt went: pass / hold / fail, and its normalized error (pass below PASS_ERROR) */
  judge(m: TaskMetrics, reason: string, d: number): { outcome: Outcome; error: number };
}

/** HyperDrone's rule: a clean pass is an error below 25 % of the bound. */
export const PASS_ERROR = 0.25;
/** Level steps: a pass moves up between these (the cleaner, the larger), a failure moves down by STEP_DOWN. */
export const STEP_MIN = 0.025, STEP_MAX = 0.05, STEP_DOWN = 0.05;

/** The next level after an attempt at level d. */
export function adapt(d: number, outcome: Outcome, error: number): number {
  let n = d;
  if (outcome === 'pass') n = d + Math.min(STEP_MAX, Math.max(STEP_MIN, STEP_MAX * (1 - error / PASS_ERROR) + STEP_MIN));
  else if (outcome === 'fail') n = d - STEP_DOWN;
  return Math.round(Math.min(1, Math.max(0, n)) * 1000) / 1000;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const base = (id: string, name: string): Pick<Scenario, 'format' | 'version' | 'meta'> => ({ format: 'fpvsim-scenario', version: 1, meta: { id, name, author: 'fpv-sim', license: 'CC0-1.0' } });

/** Course length (m): spawn to gate 0, round the gates and back to gate 0. */
export function courseLength(mapId: string, courseId?: string): number {
  const m = withCourse(MAPS[mapId](), courseId);
  const pts = m.gates.map((g: GateDef) => openingCentre(g));
  if (!pts.length) return 0;
  let L = 0;
  for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; L += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z); }
  return L;
}

interface HoverOpts { id: string; name: string; blurb: string; mapId: string; preset: string; height: number; radius: [number, number]; hold: [number, number]; wind: [number, number] }
function hoverDrill(o: HoverOpts): Drill {
  const p = (d: number) => ({ radius: lerp(o.radius[0], o.radius[1], d), hold: lerp(o.hold[0], o.hold[1], d), wind: lerp(o.wind[0], o.wind[1], d) });
  return {
    id: o.id, name: o.name, blurb: o.blurb, mapId: o.mapId, preset: o.preset,
    scenario: (d) => {
      const q = p(d);
      return {
        ...base(o.id, o.name),
        map: { id: o.mapId }, drone: { preset: o.preset },
        sim: { wind: { speed: q.wind, direction: 240, turbulence: lerp(0.3, 1.5, d), gusts: lerp(0, 3, d) } },
        start: { mode: 'angle' },
        task: { type: 'hover', heightM: o.height, radiusM: +q.radius.toFixed(3), holdS: +q.hold.toFixed(1) },
        episode: { maxSeconds: Math.ceil(q.hold + 30), endOnCrash: true, crashSpeedMs: 3 },
      };
    },
    describe: (d) => { const q = p(d); return `Hold within ${q.radius.toFixed(2)} m of the marker ${o.height} m above the pad for ${q.hold.toFixed(0)} s${q.wind > 0.05 ? `, wind ${q.wind.toFixed(1)} m/s` : ''}.`; },
    judge: (m, reason) => {
      const error = m.normalizedError ?? 1;
      if (reason === 'success') return { outcome: 'pass', error };
      return { outcome: reason === 'timeout' && error < 1 ? 'hold' : 'fail', error };
    },
  };
}

interface CourseOpts { id: string; name: string; blurb: string; mapId: string; courseId?: string; preset: string; speed: [number, number]; wind: [number, number] }
function courseDrill(o: CourseOpts): Drill {
  let L = -1;
  const len = () => (L >= 0 ? L : (L = courseLength(o.mapId, o.courseId)));
  // the target lap: the course at the level's average speed, plus a second for the start
  const target = (d: number) => len() / lerp(o.speed[0], o.speed[1], d) + 1;
  return {
    id: o.id, name: o.name, blurb: o.blurb, mapId: o.mapId, courseId: o.courseId, preset: o.preset,
    scenario: (d) => ({
      ...base(o.id, o.name),
      map: { id: o.mapId, course: o.courseId }, drone: { preset: o.preset },
      sim: { wind: { speed: lerp(o.wind[0], o.wind[1], d), direction: 240, turbulence: lerp(0.5, 1.5, d), gusts: lerp(0, 2, d) } },
      start: { mode: 'acro' },
      task: { type: 'gates', laps: 1 },
      episode: { maxSeconds: Math.ceil(target(d) * 4 + 20), endOnCrash: false },
    }),
    describe: (d) => `One clean lap in ${target(d).toFixed(1)} s or less${lerp(o.wind[0], o.wind[1], d) > 0.05 ? `, wind ${lerp(o.wind[0], o.wind[1], d).toFixed(1)} m/s` : ''}.`,
    judge: (m, reason, d) => {
      const lap = m.lapTimesS?.[0];
      if (reason !== 'success' || lap === undefined) return { outcome: 'fail', error: 1 };
      const error = (PASS_ERROR * lap) / target(d);
      return { outcome: lap <= target(d) ? 'pass' : 'hold', error };
    },
  };
}

export const DRILLS: Drill[] = [
  hoverDrill({ id: 'hover-whoop', name: 'Whoop hover box', blurb: 'The first skill: a tiny whoop held still in the Whoop Gym, in angle mode. The box shrinks and the hold grows as you improve.', mapId: 'gym', preset: 'Beginner: 65 mm Tiny Whoop 1S', height: 1.5, radius: [1.0, 0.25], hold: [5, 20], wind: [0, 0] }),
  hoverDrill({ id: 'hover-field', name: '5" hover in wind', blurb: 'A 5" quad held over the Practice Field in angle mode, with wind and gusts that grow with your level.', mapId: 'practice', preset: '5" Freestyle 6S', height: 3, radius: [1.5, 0.4], hold: [5, 20], wind: [0, 6] }),
  courseDrill({ id: 'gym-course', name: 'Whoop Gym course', blurb: 'The Whoop Gym\'s eight gates in order, in acro. The target lap time drops as you improve.', mapId: 'gym', preset: 'Beginner: 65 mm Tiny Whoop 1S', speed: [1.5, 4.5], wind: [0, 0] }),
  courseDrill({ id: 'slalom', name: 'Slalom', blurb: 'The Practice Field\'s slalom on a 3" toothpick: faster target times and more wind as you improve.', mapId: 'practice', courseId: 'slalom', preset: '3" Toothpick 4S', speed: [4, 12], wind: [0, 4] }),
  courseDrill({ id: 'figure8', name: 'Figure-8', blurb: 'The Practice Field\'s figure-8 on a 5" quad.', mapId: 'practice', courseId: 'figure8', preset: '5" Freestyle 6S', speed: [5, 15], wind: [0, 4] }),
  courseDrill({ id: 'powerloop', name: 'Power loop', blurb: 'The Practice Field\'s power-loop tower on a 5" quad.', mapId: 'practice', courseId: 'powerloop', preset: '5" Freestyle 6S', speed: [3, 9], wind: [0, 3] }),
  courseDrill({ id: 'stadium', name: 'Grand Prix Stadium lap', blurb: 'A full lap of the stadium race course on a 5" quad.', mapId: 'field', preset: '5" Freestyle 6S', speed: [6, 18], wind: [0, 4] }),
];

export const drillById = (id: string) => DRILLS.find((d) => d.id === id);

export interface Attempt {
  /** when (ms since the epoch) */
  at: number;
  drill: string;
  /** the level the attempt was flown at, and the level after it */
  level: number; next: number;
  outcome: Outcome; error: number;
  /** why the episode ended (success, timeout, crash, out_of_bounds, respawn) */
  reason: string;
  metrics: TaskMetrics;
}

export interface TrainingState {
  drill: string;
  adaptive: boolean;
  /** start the next attempt by itself a few seconds after one ends */
  auto: boolean;
  levels: Record<string, number>;
  attempts: Attempt[];
}

export const MAX_ATTEMPTS = 1000;

export function newTrainingState(): TrainingState {
  return { drill: DRILLS[0].id, adaptive: true, auto: true, levels: {}, attempts: [] };
}

/** Record an attempt; returns it (with the next level, already applied when adaptive). */
export function recordAttempt(st: TrainingState, drill: Drill, m: TaskMetrics, reason: string, at = Date.now()): Attempt {
  const level = st.levels[drill.id] ?? 0;
  const { outcome, error } = drill.judge(m, reason, level);
  const next = st.adaptive ? adapt(level, outcome, error) : level;
  const a: Attempt = { at, drill: drill.id, level, next, outcome, error, reason, metrics: m };
  st.levels[drill.id] = next;
  st.attempts.push(a);
  if (st.attempts.length > MAX_ATTEMPTS) st.attempts.splice(0, st.attempts.length - MAX_ATTEMPTS);
  return a;
}

/** The attempts as CSV (one row each; the task's main metrics as columns). */
export function attemptsCsv(list: Attempt[]): string {
  const cols = ['time', 'drill', 'level', 'next_level', 'outcome', 'error', 'reason', 'elapsed_s', 'success', 'inside_fraction', 'rms_error_m', 'max_error_m', 'passed', 'total', 'lap_s', 'distance_m', 'max_speed_ms', 'return'];
  const q = (v: unknown) => (v === undefined || v === null ? '' : typeof v === 'string' ? `"${v.replace(/"/g, '""')}"` : String(typeof v === 'number' ? +v.toFixed(4) : v));
  const rows = list.map((a) => [new Date(a.at).toISOString(), a.drill, a.level, a.next, a.outcome, a.error, a.reason, a.metrics.elapsedS, a.metrics.success, a.metrics.insideFraction, a.metrics.rmsErrorM, a.metrics.maxErrorM, a.metrics.passed, a.metrics.total, a.metrics.lapTimesS?.[0], a.metrics.distanceM, a.metrics.maxSpeedMs, a.metrics.return].map(q).join(','));
  return [cols.join(','), ...rows].join('\n') + '\n';
}

/** Where the hover marker is drawn for a hover drill (ENU), or null. */
export function hoverMarker(drill: Drill, d: number): { x: number; y: number; z: number; radius: number } | null {
  const sc = drill.scenario(d), t = sc.task;
  if (!t || t.type !== 'hover') return null;
  const m = MAPS[drill.mapId]();
  return { x: m.spawn.pos.x, y: m.spawn.pos.y, z: spawnGroundZ(m) + (t.heightM ?? 3), radius: t.radiusM ?? 1.5 };
}
