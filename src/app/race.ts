// Lap timing through the map's gates (mirrors the worker's gate counter), the hover-box drill, and
// the HUD summaries of both.
import { droneClass, droneSummary } from '../builder/droneClass';
import { spawnGroundZ } from '../maps/world';
import type { DrillInfo, RaceInfo } from '../ui/hud/hud';
import { loadPilot, PilotPrefs } from '../ui/multiplayerPanel';
import { R } from '../worker/shared';
import type { AppCtx } from './context';
import { courseOf } from './leaderboard';

/**
 * lapStart: sim time (s) gate 0 was passed, -1 between laps. splits: sim time since lapStart at each
 * later gate, in order. lapWall: performance.now() at the start, to tell a lap flown in real time
 * from one with a pause or a slow simulation in it. lapScale: the time scale (one other than 1, if
 * seen at any gate). lapCls: the drone class it was started with.
 */
export interface RaceState { lapStart: number; bestLap: number; lastLap: number; lapCount: number; nextGate: number; splits: number[]; lapWall: number; lapScale: number; lapCls: string }
export const newRace = (): RaceState => ({ lapStart: -1, bestLap: Infinity, lastLap: 0, lapCount: 0, nextGate: 0, splits: [], lapWall: 0, lapScale: 1, lapCls: '' });

/** Real time may run this much (fraction + seconds) beyond the sim's own lap time (message timing). */
const REALTIME_SLACK = 0.02, REALTIME_SLACK_S = 0.25;

/** Why a lap doesn't count for personal bests and the leaderboard, or null. */
export function lapInvalid(o: { timeScale: number; simLap: number; wallLap: number; clsAtStart: string; cls: string }): string | null {
  if (o.timeScale !== 1) return `Slow motion is on (time scale ${o.timeScale.toFixed(2)}×): personal bests need time scale 1.`;
  if (o.cls !== o.clsAtStart) return 'The drone was changed during the lap.';
  if (o.wallLap > o.simLap * (1 + REALTIME_SLACK) + REALTIME_SLACK_S) return 'The simulation was paused or ran slower than real time during the lap.';
  return null;
}

/** Hover-box drill: stay inside a 1.5 m sphere centred 3 m above the pad; score = time inside / elapsed. */
export interface DrillState { on: boolean; t0: number; inside: number; last: number; best: number }
export const newDrill = (): DrillState => ({ on: false, t0: 0, inside: 0, last: 0, best: 0 });

/**
 * The worker saw the quad pass a gate (sim time t). The worker only ever checks the next gate in
 * order, but a message sent before a respawn or map change can still arrive after it: a lap counts
 * only once every gate was passed in order since gate 0.
 */
export function onGate(ctx: AppCtx, gate: number, t: number, wall = performance.now()) {
  const r = ctx.race, gates = ctx.map.gates;
  const i = gates.findIndex((g) => g.id === gate);
  if (i < 0) return; // not a gate of this map (sent before a map change)
  const inOrder = i === r.nextGate;
  r.nextGate = (i + 1) % gates.length;
  const scale = ctx.sim.timeScale;
  if (i !== 0) {
    if (r.lapStart < 0) return;
    if (inOrder) { r.splits.push(t - r.lapStart); if (scale !== 1) r.lapScale = scale; }
    else r.lapStart = -1; // a gate was skipped: this lap can't complete
    return;
  }
  if (r.lapStart >= 0 && inOrder && r.splits.length === gates.length - 1) {
    r.lastLap = t - r.lapStart; r.lapCount++; r.bestLap = Math.min(r.bestLap, r.lastLap);
    ctx.mp.sendLap(r.lapCount, r.lastLap, r.bestLap);
    const cls = droneClass(ctx.spec);
    ctx.lb.onLap({
      map: ctx.map.id, course: courseOf(ctx.map), cls, summary: droneSummary(ctx.build),
      lapMs: r.lastLap * 1000, splitsMs: [...r.splits, r.lastLap].map((s) => s * 1000),
      invalid: lapInvalid({ timeScale: scale !== 1 ? scale : r.lapScale, simLap: r.lastLap, wallLap: (wall - r.lapWall) / 1000, clsAtStart: r.lapCls, cls }),
    });
  }
  // gate 0 also starts the next lap
  r.lapStart = t; r.splits = []; r.lapWall = wall; r.lapScale = scale; r.lapCls = droneClass(ctx.spec);
}

/** The worker respawned the quad (reset key / map change): its gate counter restarts at gate 0. */
export function onRespawn(ctx: AppCtx) { ctx.race.nextGate = 0; ctx.race.lapStart = -1; ctx.link.reset(); }

/** A new map or session: lap history starts over. */
export function resetLaps(ctx: AppCtx) { Object.assign(ctx.race, newRace()); }

export function toggleDrill(ctx: AppCtx, on = !ctx.drill.on) { Object.assign(ctx.drill, { on, t0: -1, inside: 0 }); }

/** Advance the drill with the newest sample (sim time `head`); null when the drill is off. */
export function updateDrill(ctx: AppCtx, head: number, armed: boolean): DrillInfo | null {
  const drill = ctx.drill, rec = ctx.rec, map = ctx.map;
  if (!drill.on) return null;
  const sp = map.spawn.pos, gz = spawnGroundZ(map);
  const d = Math.hypot(rec[R.px] - sp.x, rec[R.py] - sp.y, rec[R.pz] - (gz + 3));
  if (armed && drill.t0 < 0) { drill.t0 = head; drill.inside = 0; drill.last = head; }
  if (armed && drill.t0 >= 0) { if (d < 1.5) drill.inside += head - drill.last; drill.last = head; }
  const elapsed = drill.t0 >= 0 ? head - drill.t0 : 0;
  const score = elapsed > 0 ? (100 * drill.inside) / elapsed : 0;
  if (elapsed >= 30 && armed) { drill.best = Math.max(drill.best, score); drill.t0 = -1; ctx.log(`Hover drill: ${score.toFixed(0)} % inside the box`); }
  return { inBox: d < 1.5, offBy: Math.max(0, d - 1.5), elapsed, score, best: drill.best };
}

// The pilot's name / color for the leaderboard: read from storage at most every 2 s, not every frame
// (it only changes in the menu, while the HUD is hidden).
let pilotCache: { at: number; p: PilotPrefs } | null = null;
export function cachedPilot(now = performance.now()): PilotPrefs {
  if (!pilotCache || now - pilotCache.at > 2000) pilotCache = { at: now, p: loadPilot() };
  return pilotCache.p;
}

/**
 * Lap panel data with the live room leaderboard (best lap first). On maps without gates there are
 * no laps: in a room it is just the roster (gates = 0), solo it is null.
 */
export function raceInfo(ctx: AppCtx): RaceInfo | null {
  const r = ctx.race, mp = ctx.mp, gates = ctx.map.gates.length;
  if (!gates && !mp.connected) return null;
  let board: RaceInfo['board'];
  if (mp.connected) {
    const me = cachedPilot();
    board = [{ name: me.name, color: me.color, lap: r.lapCount, best: r.bestLap, me: true }, ...[...mp.peers.values()].map((p) => ({ name: p.info.name, color: p.info.color, lap: p.lap?.lap ?? 0, best: p.lap?.best || Infinity, me: false }))];
    if (gates) board.sort((a, b) => a.best - b.best);
  }
  // personal best and the global board's record for this track and drone class
  let pb: number | undefined, record: RaceInfo['record'];
  if (gates) {
    const map = ctx.map.id, course = courseOf(ctx.map), cls = droneClass(ctx.spec);
    const mine = ctx.lb.pb(map, course, cls), top = ctx.lb.record(map, course, cls);
    pb = mine ? mine.lapMs / 1000 : undefined;
    if (top) record = { initials: top.initials, lap: top.lapMs / 1000, mine: ctx.lb.isMine(top.id) };
  }
  return { lap: r.lapCount, last: r.lastLap, best: r.bestLap, gate: r.nextGate + 1, gates, room: mp.connected ? mp.room ?? undefined : undefined, board, pb, record };
}
