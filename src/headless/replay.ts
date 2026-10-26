// Re-simulate a reproducible run (.fpvrun, src/worker/runLog.ts) headless: the same flight core,
// started exactly as the browser's worker started the run (FlightCore.beginRun), handed the recorded
// sticks of every RC packet in the physics step it arrived. The result is the flight as it was flown,
// with the full simulator state at every step, not just what a lap replay keeps. If the replay ever
// asks for a packet in another step than the recording has it, it has diverged (another firmware
// build, another simulator version): that is reported, not hidden.
import type { Betaflight } from '../bf/bfModule';
import { preloadPropTable } from '../builder/derive';
import { MAPS, preloadMap } from '../maps/maps';
import { withCourse } from '../maps/world';
import { FlightCore } from '../worker/flightCore';
import { RUN_GPS_EPOCH_MS, RunLog } from '../worker/runLog';

export interface ReplayOptions {
  /** called once per millisecond of sim time (the 1 kHz record the worker's state ring gets) */
  record?: (core: FlightCore) => void;
  /** called after every physics step */
  step?: (core: FlightCore, k: number) => void;
  /** gate passes (sim time since the run began) */
  gate?: (gate: number, t: number) => void;
}

export interface ReplayResult {
  steps: number;
  seconds: number;
  packets: number;
  /** the first step where the replay asked for a packet the recording doesn't have there (null: none) */
  diverged: null | { step: number; packet: number; recordedStep: number | null };
  core: FlightCore;
}

export async function replayRun(run: RunLog, firmware: () => Promise<Betaflight>, o: ReplayOptions = {}): Promise<ReplayResult> {
  await Promise.all([preloadMap(run.mapId), preloadPropTable(run.spec.prop)]);
  let i = 0, diverged: ReplayResult['diverged'] = null;
  const n = run.packetSteps.length;
  let t0 = 0;
  const core: FlightCore = new FlightCore({
    sticks: (out) => {
      if (diverged) return;
      if (i >= n || run.packetSteps[i] !== core.steps) { diverged = { step: core.steps, packet: i, recordedStep: i < n ? run.packetSteps[i] : null }; return; }
      out.set(run.packetChannels.subarray(i * 16, i * 16 + 16));
      i++;
    },
    record: o.record ? () => o.record!(core) : undefined,
    gate: o.gate ? (g, t) => o.gate!(g, t - t0) : undefined,
  }, { seed: run.seed });
  core.settings = run.settings;
  core.spec = run.spec;
  core.setMap(withCourse(MAPS[run.mapId](), run.courseId));
  core.beginRun(await firmware(), run.eeprom, run.seed, RUN_GPS_EPOCH_MS);
  t0 = core.simT;
  const dt = 1 / run.settings.physicsHz;
  let e = 0;
  for (let k = 0; k < run.steps && !diverged; k++) {
    while (e < run.events.length && run.events[e].k === k) core.applyReset(run.events[e++]);
    core.physicsStep(dt);
    o.step?.(core, k);
  }
  return { steps: core.steps, seconds: core.steps * dt, packets: i, diverged, core };
}
