// Lap timing through the map's gates (mirrors the worker's gate counter), the hover-box drill, and
// the HUD summaries of both.
import { spawnGroundZ } from '../maps/world';
import type { DrillInfo, RaceInfo } from '../ui/hud/hud';
import { loadPilot, PilotPrefs } from '../ui/multiplayerPanel';
import { R } from '../worker/shared';
import type { AppCtx } from './context';

export interface RaceState { lapStart: number; bestLap: number; lastLap: number; lapCount: number; nextGate: number }
export const newRace = (): RaceState => ({ lapStart: -1, bestLap: Infinity, lastLap: 0, lapCount: 0, nextGate: 0 });

/** Hover-box drill: stay inside a 1.5 m sphere centred 3 m above the pad; score = time inside / elapsed. */
export interface DrillState { on: boolean; t0: number; inside: number; last: number; best: number }
export const newDrill = (): DrillState => ({ on: false, t0: 0, inside: 0, last: 0, best: 0 });

/** The worker saw the quad pass a gate (sim time t). */
export function onGate(ctx: AppCtx, gate: number, t: number) {
  const r = ctx.race, gates = ctx.map.gates;
  const i = gates.findIndex((g) => g.id === gate);
  r.nextGate = (i + 1) % gates.length;
  if (i === 0) {
    if (r.lapStart >= 0) { r.lastLap = t - r.lapStart; r.lapCount++; r.bestLap = Math.min(r.bestLap, r.lastLap); ctx.mp.sendLap(r.lapCount, r.lastLap, r.bestLap); }
    r.lapStart = t;
  }
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
  return { lap: r.lapCount, last: r.lastLap, best: r.bestLap, gate: r.nextGate + 1, gates, room: mp.connected ? mp.room ?? undefined : undefined, board };
}
