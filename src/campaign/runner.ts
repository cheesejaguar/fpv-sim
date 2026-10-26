// One campaign run: an episode of a scenario variant with a seed, flown by the campaign's pilot,
// reduced to the metrics requirements are written against. Deterministic: the same variant, seed,
// pilot and firmware build give the same run (the case files rely on it).
import type { Action, Observation } from '../api/types';
import type { FpvEnv } from '../headless/env';
import type { Scenario } from '../scenario/scenario';
import type { PilotSpec, RunOutcome } from './campaign';
import { ReferencePilot } from './pilot';

/** A controller the developer brings (pilot type "module"). */
export interface PilotModule {
  createPilot(info: { scenario: Scenario; seed: number; hoverThrottle: number; options?: unknown }): { act(obs: Observation): Action | { action: Action; release?: boolean } };
}

/**
 * Every run's metrics (beyond the task's own: elapsedS, distanceM, maxSpeedMs, rmsErrorM, missM...):
 *   crashed, flightS, energyWh, mAh, minCellV (sustained: 0.5 s filter), maxImpactMs, maxTiltDeg, minLq, gnssLostS,
 *   gnssSpoofedS, maxPosErrM (GNSS navigation error), payloadReleased, faults (count), fiberBroken
 */
export interface RunResult {
  outcome: RunOutcome;
  seed: number;
  wallMs: number;
  /** notable events in order (faults, GNSS, fibre, payload) */
  events: string[];
  /** 20 Hz trace (when asked): TRACE_LABELS columns */
  trace?: number[][];
}

export const TRACE_LABELS = ['t', 'x', 'y', 'z', 'vx', 'vy', 'vz', 'roll', 'pitch', 'yaw', 'agl', 'throttle', 'armed', 'cellV', 'lq', 'gnssSats'];

export async function runEpisode(env: FpvEnv, scenario: Scenario, seed: number, pilot: PilotSpec, opts: { trace?: boolean; module?: PilotModule } = {}): Promise<RunResult> {
  const wall0 = performance.now();
  // the reference pilot flies angle mode from an armed start
  const sc: Scenario = pilot.type === 'none' ? scenario : { ...scenario, start: { ...scenario.start, armed: true, mode: 'angle' } };
  const r = await env.reset({ scenario: sc, seed });
  const hover = r.info.drone.hoverThrottle;
  const task = r.info.episode.task;
  const ref = pilot.type === 'reference' ? new ReferencePilot({ ...pilot, hoverThrottle: hover }, { type: task.type, target: task.type === 'drop' ? task.target : undefined }) : null;
  const mod = pilot.type === 'module' ? opts.module!.createPilot({ scenario: sc, seed, hoverThrottle: hover, options: pilot.options }) : null;
  let o = r.obs;
  const m = { maxTilt: 0, minCellV: Infinity, maxImpact: 0, minLq: 100, gnssLost: 0, gnssSpoof: 0, maxPosErr: 0, released: false, faults: 0, fiberBroken: false };
  const events: string[] = [];
  const trace: number[][] = [];
  let lastTrace = -1, lastThr = 0, cellF = NaN;
  let res = null as ReturnType<FpvEnv['step']> | null;
  for (;;) {
    let action: Action;
    let release = false;
    if (ref) ({ action, release } = ref.act(o));
    else if (mod) { const a = mod.act(o); if ('action' in a && typeof a.action === 'object') { action = a.action; release = !!a.release; } else action = a as Action; }
    else action = { throttle: hover, roll: 0, pitch: 0, yaw: 0 };
    if (release) env.release();
    lastThr = action.throttle ?? lastThr;
    res = env.step(action);
    o = res.obs;
    const dt = 1 / r.info.episode.controlHz;
    m.maxTilt = Math.max(m.maxTilt, Math.acos(Math.max(-1, Math.min(1, Math.cos(o.euler[0]) * Math.cos(o.euler[1])))) * 180 / Math.PI);
    // sustained cell voltage (0.5 s filter): what a low-voltage warning acts on, not a spin-up transient
    cellF = Number.isNaN(cellF) ? o.battery.cellV : cellF + (o.battery.cellV - cellF) * Math.min(1, dt / 0.5);
    if (o.armed) m.minCellV = Math.min(m.minCellV, cellF);
    m.maxImpact = Math.max(m.maxImpact, o.impact);
    if (o.ops) {
      m.minLq = Math.min(m.minLq, o.ops.link.lq);
      if (!o.ops.fix) m.gnssLost += dt;
      if (o.ops.gnss.spoofed) m.gnssSpoof += dt;
      if (o.ops.fix) m.maxPosErr = Math.max(m.maxPosErr, Math.hypot(o.ops.fix.pos[0] - o.pos[0], o.ops.fix.pos[1] - o.pos[1]));
    }
    for (const e of res.info.events) {
      if (e.type === 'fault' && e.on) m.faults++;
      if (e.type === 'payload_release') m.released = true;
      if (e.type === 'fiber_break') m.fiberBroken = true;
      if (e.type === 'fault' || e.type === 'gnss' || e.type === 'fiber_break' || e.type === 'payload_release' || e.type === 'payload_impact')
        events.push(`${e.t.toFixed(2)} s ${e.type === 'fault' ? `${e.kind}${e.motor ? ` m${e.motor}` : ''} ${e.on ? 'on' : 'off'}` : e.type === 'gnss' ? `gnss ${e.state}` : e.type === 'fiber_break' ? `fibre broke (${e.reason})` : e.type === 'payload_release' ? 'payload released' : `payload landed ${e.speed.toFixed(1)} m/s`}`);
      if (e.type === 'impact' && e.speed >= 2) events.push(`${e.t.toFixed(2)} s impact ${e.speed.toFixed(1)} m/s`);
    }
    if (opts.trace && o.t - lastTrace >= 0.05 - 1e-9) {
      lastTrace = o.t;
      trace.push([o.t, ...o.pos, ...o.vel, ...o.euler, o.agl, lastThr, o.armed ? 1 : 0, o.battery.cellV, o.ops?.link.lq ?? 100, o.ops?.gnss.numSV ?? 12].map((x) => Math.round(x * 1e4) / 1e4));
    }
    if (res.terminated || res.truncated) break;
  }
  const mt = res!.info.metrics;
  const b = env.core.quad.battery.s;
  const reason = res!.info.reason ?? 'end';
  const metrics: RunOutcome['metrics'] = {
    crashed: reason === 'crash' || reason === 'out_of_bounds',
    flightS: o.t, energyWh: b.whDrawn, mAh: b.mAhDrawn,
    minCellV: Number.isFinite(m.minCellV) ? m.minCellV : null, maxImpactMs: m.maxImpact, maxTiltDeg: m.maxTilt,
    minLq: m.minLq, gnssLostS: m.gnssLost, gnssSpoofedS: m.gnssSpoof, maxPosErrM: m.maxPosErr,
    payloadReleased: m.released, faults: m.faults, fiberBroken: m.fiberBroken,
    elapsedS: mt.elapsedS, distanceM: mt.distanceM, maxSpeedMs: mt.maxSpeedMs, progress: mt.progress,
  };
  for (const k of ['rmsErrorM', 'maxErrorM', 'insideFraction', 'normalizedError', 'missM', 'impactSpeedMs', 'passed'] as const) if (mt[k] !== undefined) metrics[k] = mt[k] as number;
  if (mt.lapTimesS?.length) metrics.bestLapS = Math.min(...mt.lapTimesS);
  if (mt.impactPos) { metrics.impactX = mt.impactPos[0]; metrics.impactY = mt.impactPos[1]; }
  return { outcome: { reason, success: reason === 'success', metrics }, seed, wallMs: performance.now() - wall0, events, ...(opts.trace ? { trace } : {}) };
}
