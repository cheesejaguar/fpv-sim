// Lap timing through the map's gates (mirrors the worker's gate counter), the hover-box drill, and
// the HUD summaries of both.
import { spawnGroundZ } from '../maps/world';
import type { DrillInfo, RaceInfo } from '../ui/hud/hud';
import { loadPilot } from '../ui/multiplayerPanel';
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

/** Lap panel data with the live room leaderboard (best lap first); null on maps without gates. */
export function raceInfo(ctx: AppCtx): RaceInfo | null {
  const r = ctx.race, mp = ctx.mp, gates = ctx.map.gates.length;
  if (!gates) return null;
  const me = loadPilot();
  const board = mp.connected
    ? [{ name: me.name, color: me.color, lap: r.lapCount, best: r.bestLap, me: true }, ...[...mp.peers.values()].map((p) => ({ name: p.info.name, color: p.info.color, lap: p.lap?.lap ?? 0, best: p.lap?.best || Infinity, me: false }))].sort((a, b) => a.best - b.best)
    : undefined;
  return { lap: r.lapCount, last: r.lastLap, best: r.bestLap, gate: r.nextGate + 1, gates, board };
}
