// The real simulation worker (src/worker/sim.worker.ts), run in Node on a fake clock: the firmware
// is loaded from public/bf, the worker's own message handler and loop run unchanged, and the test
// advances performance.now() itself, so every physics step happens at a sim time the test controls.
// Two runs with the same inputs must produce bit-identical state rings (everything in the plant and
// the FC hardware models is seeded), a scripted flight must arm, climb and roll, and a reproducible
// run recorded by the worker must re-simulate headless to the same states, step for step.
// Skipped when the firmware hasn't been built (npm run firmware).
import { existsSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { describe, expect, test, vi } from 'vitest';
import { DEFAULT_SPEC } from '../src/builder/derive';
import { nodeFirmware, installNodeHost } from '../src/headless/node';
import { replayRun } from '../src/headless/replay';
import { decodeRun } from '../src/worker/runLog';
import { createShared, DEFAULT_SETTINGS, FromWorker, R, REC, RING_N, SimSettings, ToWorker } from '../src/worker/shared';

const FW = new URL('../public/bf/betaflight.mjs', import.meta.url);
const have = existsSync(FW);

/**
 * One scripted session through the worker; returns every ring record written, in order. The script
 * sets the sticks and may return a message for the worker; runStart / runStop are waited for (the
 * clock stands still meanwhile), and marks[] holds the record index where each one took effect.
 */
async function session(script: (t: number, rc: Float32Array) => ToWorker | void, seconds: number) {
  vi.resetModules();
  const msgs: FromWorker[] = [];
  let now = 1000;
  const g = globalThis as Record<string, unknown>;
  g.self = globalThis;
  g.postMessage = (m: FromWorker) => { msgs.push(m); };
  let calls = 0;
  const perf = vi.spyOn(performance, 'now').mockImplementation(() => { calls++; return now; });
  const date = vi.spyOn(Date, 'now').mockImplementation(() => 1.7e12 + now);
  const mod = await import(/* @vite-ignore */ pathToFileURL(FW.pathname.replace(/^\/([A-Za-z]:)/, '$1')).href);
  // (a fresh module graph per session: spy on the copy the worker will import)
  const { Betaflight } = await import('../src/bf/bfModule');
  const prefetch = vi.spyOn(Betaflight, 'prefetch').mockImplementation(() => ({ glue: Promise.resolve(''), wasm: new Promise(() => {}) }));
  const load = vi.spyOn(Betaflight, 'load').mockImplementation(() => Betaflight.fromFactory(mod.default));
  try {
    await import('../src/worker/sim.worker');
    const onmessage = g.onmessage as (ev: { data: ToWorker }) => void;
    const sh = createShared();
    const settings: SimSettings = { ...DEFAULT_SETTINGS, mapId: 'field', autoRate: false, wind: { speed: 3, direction: 200, turbulence: 1, gusts: 1 } };
    sh.rc.fill(1500); sh.rc[2] = 1000; sh.rc[4] = 1000; sh.rc[5] = 1000; sh.rc[6] = 1000; sh.rc[7] = 1000;
    onmessage({ data: { type: 'init', sab: sh.sab, spec: DEFAULT_SPEC, settings } });
    let spins = 0;
    await (async () => { while (!msgs.some((m) => m.type === 'ready' || m.type === 'fwMissing')) { if (++spins > 600000) throw new Error('no boot'); await new Promise((r) => setTimeout(r, 0)); } })();
    expect(msgs.find((m) => m.type === 'fwMissing')).toBeUndefined();
    const recs: number[][] = [];
    let read = Atomics.load(sh.ctrl, 1);
    const drain = () => {
      const head = Atomics.load(sh.ctrl, 1);
      for (; read < head; read++) { const o = (read % RING_N) * REC; recs.push(Array.from(sh.ring.subarray(o, o + REC))); }
    };
    drain(); const t0 = recs.length ? recs[recs.length - 1][R.t] : 0;
    // 2 ms of wall time per round: the loop steps exactly that much sim time (timeScale 1)
    const marks: number[] = [];
    for (let k = 0; k < seconds * 500; k++) {
      const tSim = recs.length ? recs[recs.length - 1][R.t] - t0 : 0;
      const msg = script(tSim, sh.rc);
      if (msg) {
        const n0 = msgs.length;
        onmessage({ data: msg });
        const want = msg.type === 'runStart' ? 'runState' : msg.type === 'runStop' ? 'run' : null;
        let w = 0;
        if (want) while (!msgs.slice(n0).some((m) => m.type === want)) { if (++w > 200000) throw new Error(`no ${want}`); await new Promise((r) => setTimeout(r, 0)); }
        drain(); marks.push(recs.length);
      }
      // the loop reads the clock a few times per iteration and steps synchronously within one: two
      // iterations after the clock moved, everything that time allows has been stepped
      now += 2;
      const c0 = calls;
      let w = 0;
      while (calls < c0 + 8) { if (++w > 100000) throw new Error('loop stalled'); await new Promise((r) => setTimeout(r, 0)); }
      drain();
    }
    return { recs, msgs, marks };
  } finally {
    perf.mockRestore(); date.mockRestore(); prefetch.mockRestore(); load.mockRestore();
    (g.self as { onmessage?: unknown }).onmessage = null;
  }
}

/** Wait out Betaflight's boot grace and gyro calibration, arm at 4 s, climb, then a roll input. */
function flight(t: number, rc: Float32Array) {
  rc[4] = t > 4 ? 1900 : 1000;
  rc[2] = t < 4.5 ? 1000 : t < 6 ? 1550 : 1450;
  rc[0] = t > 6 && t < 6.3 ? 1700 : 1500;
}

/** A reproducible run: started at 1 s, armed at 4.5 s (boot grace after the run's FC reboot), a climb and turns, a respawn, stopped at 8 s. */
let phase = 0;
function runFlight(t: number, rc: Float32Array): ToWorker | void {
  if (phase === 0 && t > 1) { phase = 1; return { type: 'runStart', seed: 4242 }; }
  if (phase === 0) return;
  rc[4] = t > 5.5 && t < 7.5 ? 1900 : 1000;
  rc[2] = t < 5.8 ? 1000 : t < 6.8 ? 1600 : 1420;
  rc[0] = 1500 + 200 * Math.sin(t * 7);
  rc[3] = 1500 + 100 * Math.sin(t * 3);
  if (phase === 1 && t > 7.6) { phase = 2; return { type: 'reset', repair: true, fullBattery: true }; }
  if (phase === 2 && t > 8.2) { phase = 3; return { type: 'runStop', id: 1 }; }
}

describe.skipIf(!have)('simulation worker in Node (fake clock)', () => {
  test('a reproducible run recorded live re-simulates headless to the same state, millisecond by millisecond', async () => {
    phase = 0;
    const live = await session(runFlight, 8.4);
    const runMsg = live.msgs.find((m) => m.type === 'run') as Extract<FromWorker, { type: 'run' }>;
    expect(runMsg.reason).toBe('stopped');
    const run = await decodeRun(new Uint8Array(runMsg.data));
    expect(run.seed).toBe(4242);
    expect(run.events).toHaveLength(1);
    expect(run.packetSteps.length).toBeGreaterThan(1000);
    // the worker's state ring between runStart and runStop
    const from = live.marks[0], to = live.marks[live.marks.length - 1]; // (runStart, reset, runStop)
    const liveRecs = live.recs.slice(from, to);
    installNodeHost();
    const rec: number[][] = [];
    const res = await replayRun(run, await nodeFirmware(), {
      record: (c) => {
        const s = c.quad.s;
        rec.push([s.pos.x, s.pos.y, s.pos.z, s.q.w, s.q.x, s.q.y, s.q.z, s.w.x, s.w.y, s.w.z, s.vel.x, s.vel.y, s.vel.z, ...c.quad.motors.map((m) => m.rpm()), ...c.motorCmd, s.vbus, c.armed ? 1 : 0]);
      },
    });
    expect(res.diverged).toBeNull();
    expect(res.packets).toBe(run.packetSteps.length);
    expect(rec.length).toBe(liveRecs.length);
    const pick = (r: number[]) => [r[R.px], r[R.py], r[R.pz], r[R.qw], r[R.qx], r[R.qy], r[R.qz], r[R.wx], r[R.wy], r[R.wz], r[R.vx], r[R.vy], r[R.vz], r[R.rpm0], r[R.rpm1], r[R.rpm2], r[R.rpm3], r[R.m0], r[R.m1], r[R.m2], r[R.m3], r[R.vbus], r[R.armed]];
    let firstDiff = -1;
    for (let i = 0; i < rec.length && firstDiff < 0; i++) { const a = pick(liveRecs[i]); if (a.some((x, k) => !Object.is(x, rec[i][k]))) firstDiff = i; }
    expect(firstDiff).toBe(-1);
    // it really flew: armed, climbed, and the respawn put it back on the pad
    expect(liveRecs.some((r) => r[R.armed] > 0.5)).toBe(true);
    expect(Math.max(...liveRecs.map((r) => r[R.pz]))).toBeGreaterThan(0.5);
  }, 300000);

  test('a scripted flight arms, climbs and rolls; the same inputs give bit-identical states', async () => {
    const a = await session(flight, 7);
    const b = await session(flight, 7);
    expect(a.recs.length).toBeGreaterThan(3000);
    expect(b.recs.length).toBe(a.recs.length);
    let diff = 0;
    for (let i = 0; i < a.recs.length; i++) for (let k = 0; k < REC; k++) if (k !== R.simRate && !Object.is(a.recs[i][k], b.recs[i][k])) diff++;
    expect(diff).toBe(0);
    const armed = a.recs.filter((r) => r[R.armed] > 0.5);
    expect(armed.length).toBeGreaterThan(1000);
    const zMax = Math.max(...a.recs.map((r) => r[R.pz]));
    expect(zMax).toBeGreaterThan(0.5);
    // the roll input turned the quad: body roll rate well away from zero for a moment
    expect(Math.max(...a.recs.map((r) => Math.abs(r[R.wx])))).toBeGreaterThan(3);
    if (process.env.WORKER_TRACE) writeFileSync(process.env.WORKER_TRACE, JSON.stringify(a.recs.map((r) => r.map((x, k) => (k === R.simRate ? 0 : x)))));
  }, 300000);
});
