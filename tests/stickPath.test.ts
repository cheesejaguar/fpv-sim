// Stick path, closed-loop against the real Betaflight WASM: how cleanly does a stick movement reach
// Betaflight's setpoint and feedforward? A 1.3 Hz ±350 µs roll wave goes through a model of the
// browser timeline (gamepad reports, main-thread polls, the worker processing physics in chunks)
// into 250 Hz ELRS packets; debug_mode FEEDFORWARD reads back the setpoint (debug[0]) and the final
// feedforward (debug[3]) at every PID loop. Reference for each case: packets carrying the exact stick
// value with the same mean latency, so the errors are the staircase / jitter alone.
//   old:   setInterval(4) poll writes the newest value; a packet reads whatever is there when the
//          worker processes its chunk (the code before the stick ring).
//   plain: ~1.25 ms poll writes timestamped samples (Gamepad.timestamp) to the stick ring; each
//          packet takes the newest sample at least STICK_LATENCY_MS older than its slot.
//   new:   plain + StickSampler's mixer-sync offset (what the worker does).
// Slow inputs (a radio in BLE joystick mode, 40-90 Hz reports, the browser stamping each report on
// arrival and showing it at its next 4 ms gamepad poll, a few missed connection events):
//   stair: the newest sample per packet (StickSampler without interpolation, the code before)
//   interp: StickSampler's reconstruction between reports (what the worker does)
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { describe, expect, test } from 'vitest';
import { Betaflight } from '../src/bf/bfModule';
import { defaultCli } from '../src/bf/defaults';
import { buildDrone, DEFAULT_SPEC } from '../src/builder/derive';
import { createShared, stickAt, StickSampler, writeStick } from '../src/worker/shared';

const FW = new URL('../public/bf/betaflight.mjs', import.meta.url);
const have = existsSync(FW);
const DT = 125e-6, PKT = 1 / 250, L_MS = 2.5; // the worker's STICK_LATENCY_MS
const WAVE = (t: number) => 1500 + 350 * Math.sin(2 * Math.PI * 1.3 * t);
const T_RUN = 4, T_SKIP = 0.6;

function rng(seed: number) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; }; }

type Path = 'old' | 'plain' | 'new';

/** Stick value and sample age (ms) of each packet, from a model of the browser's event timeline. */
function packets(path: Path, padHz: number, seed: number, phaseS?: number): { v: number[]; age: number[] } {
  const r = rng(seed);
  const nPk = Math.ceil(T_RUN / PKT);
  // gamepad reports: the browser reads the pad every 1/padHz (Chrome polls gamepads at 250 Hz) with
  // ±0.25 ms OS timer jitter and timestamps each report; its clock is not locked to the packets
  const reports: number[] = [];
  for (let t = phaseS ?? r() / padHz; t < T_RUN + 0.2; t += 1 / padHz) reports.push(t + (r() - 0.5) * 0.0005);
  let ri = 0;
  const reportAt = (t: number) => { while (ri + 1 < reports.length && reports[ri + 1] <= t) ri++; while (ri > 0 && reports[ri] > t) ri--; return reports[ri]; };
  // the worker wakes every ~4 ms (nested setTimeout(1) clamp, ±1 ms) and simulates up to "now": a
  // packet slot is processed at the first wake-up at or after it
  const wakes: number[] = [];
  for (let w = r() * 0.004; w < T_RUN + 0.1; w += 0.004 + (r() - 0.5) * 0.002) wakes.push(w);
  let wi = 0;
  const processedAt = (tp: number) => { while (wakes[wi] < tp) wi++; return wakes[wi]; };
  const v: number[] = [], age: number[] = [];
  if (path === 'old') {
    const polls: number[] = [];
    for (let p = r() * 0.004; p < T_RUN + 0.1; p += 0.004 + (r() - 0.5) * 0.0012) polls.push(p); // setInterval(4) ±0.6 ms
    let pi = 0;
    for (let k = 0; k < nPk; k++) {
      const w = processedAt(k * PKT);
      while (pi + 1 < polls.length && polls[pi + 1] <= w) pi++;
      const rt = reportAt(polls[pi]);
      v.push(WAVE(rt)); age.push((k * PKT - rt) * 1000);
    }
    return { v, age };
  }
  // polls every ~1.25 ms (±0.3 ms) write {t: report timestamp, value} into the real stick ring;
  // channel 15 carries the report time so the age of what a packet got can be measured
  const sh = createShared(), ch = new Float32Array(16).fill(1500), got = new Float32Array(16);
  const toMs = (t: number) => 1.7e12 + t * 1000; // absolute ms, as performance.timeOrigin + now
  const sampler = new StickSampler(L_MS);
  let p = r() * 0.00125;
  for (let k = 0; k < nPk; k++) {
    const tp = k * PKT, w = processedAt(tp);
    // everything polled before the worker processes this packet is in the ring
    for (; p <= w; p += 0.00125 + (r() - 0.5) * 0.0006) { const rt = reportAt(p); ch[0] = WAVE(rt); ch[15] = rt * 1000; writeStick(sh, toMs(rt), ch); }
    if (path === 'plain') stickAt(sh, toMs(tp) - L_MS, got); else sampler.sample(sh, toMs(tp), got);
    v.push(got[0]); age.push(tp * 1000 - got[15]);
  }
  return { v, age };
}

async function runBf(values: number[]) {
  const mod = await import(/* @vite-ignore */ pathToFileURL(FW.pathname.replace(/^\/([A-Za-z]:)/, '$1')).href);
  const bf = await Betaflight.fromFactory(mod.default);
  const rc = new Float32Array(16).fill(1500); rc[2] = 1000; rc[4] = 1000;
  const enc = new TextEncoder();
  let acc = 0;
  const idle = (s: number) => { for (let i = 0; i < s / DT; i++) { bf.setImu(0, 0, 0, 0, 0, 9.80665); bf.setBattery(16.4, 0.3, 0); acc += DT; if (acc >= PKT - 1e-9) { acc -= PKT; bf.setRc(rc); } bf.step(125); } };
  bf.setImu(0, 0, 0, 0, 0, 9.80665); bf.setBattery(16.4, 0, 0); bf.init();
  idle(0.5);
  bf.serialWrite(0, enc.encode('#\n')); idle(0.2);
  for (const l of [...defaultCli(buildDrone(DEFAULT_SPEC)).filter((x) => x !== 'save'), 'set debug_mode = FEEDFORWARD', 'save']) { if (!l.startsWith('#')) { bf.serialWrite(0, enc.encode(l + '\n')); idle(l === 'save' ? 2 : 0.02); } }
  idle(1);
  // the wave: one packet per 4 ms slot, debug read at every 8 kHz PID loop
  const sp: number[] = [], ff: number[] = [], dbg = new Int16Array(8);
  const perPkt = Math.round(PKT / DT);
  for (let k = 0; k < values.length; k++) {
    rc[0] = values[k]; bf.setRc(rc);
    for (let i = 0; i < perPkt; i++) { bf.setImu(0, 0, 0, 0, 0, 9.80665); bf.step(125); bf.debugInto(dbg); sp.push(dbg[0] / 10); ff.push(dbg[3] * 10); }
  }
  return { sp, ff };
}

const i0 = Math.round(T_SKIP / DT);
const rmsDiff = (a: number[], b: number[]) => { let s = 0; for (let i = i0; i < a.length; i++) s += (a[i] - b[i]) ** 2; return Math.sqrt(s / (a.length - i0)); };
const rms = (a: number[]) => { let s = 0; for (let i = i0; i < a.length; i++) s += a[i] * a[i]; return Math.sqrt(s / (a.length - i0)); };
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a: number[]) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };

describe.skipIf(!have)('stick path: setpoint and feedforward through the real Betaflight', () => {
  test('timestamped stick ring vs the old 4 ms poll (1.3 Hz ±350 µs roll wave)', async () => {
    const rows: string[] = [];
    const res: Record<string, { ff: number; ffWorst: number; sp: number }> = {};
    // 8 random timelines + 2 where the input updates land right at the plain sampling instant
    // (tp - L): the clock beat that makes packets pick old / new reports at random
    const edge = ((PKT * 1000 - L_MS) % (PKT * 1000)) / 1000;
    const cases: [number, number | undefined][] = [[11, undefined], [22, undefined], [33, undefined], [44, undefined], [55, undefined], [66, undefined], [77, undefined], [88, undefined], [99, edge + 0.00005], [111, edge - 0.00005]];
    const seeds = cases;
    const nPk = Math.ceil(T_RUN / PKT);
    for (const padHz of [250, 1000]) for (const path of ['old', 'plain', 'new'] as const) {
      const ffE: number[] = [], spE: number[] = [], lat: number[] = [], jit: number[] = [];
      for (const [seed, phase] of seeds) {
        const pk = packets(path, padHz, seed, padHz === 250 ? phase : undefined);
        const ages = pk.age.slice(Math.round(T_SKIP / PKT));
        const latMs = mean(ages);
        // reference: exact stick values at the same mean latency
        const ideal = await runBf(Array.from({ length: nPk }, (_, k) => WAVE(k * PKT - latMs / 1000)));
        const got = await runBf(pk.v);
        ffE.push(rmsDiff(got.ff, ideal.ff) / rms(ideal.ff)); spE.push(rmsDiff(got.sp, ideal.sp));
        lat.push(latMs); jit.push(sd(ages));
      }
      res[`${path}${padHz}`] = { ff: mean(ffE), ffWorst: Math.max(...ffE), sp: mean(spE) };
      rows.push(`${path.padEnd(5)} pad ${String(padHz).padStart(4)} Hz: feedforward error ${(100 * mean(ffE)).toFixed(0).padStart(3)} % (worst ${(100 * Math.max(...ffE)).toFixed(0).padStart(3)} %), setpoint stair-step ${mean(spE).toFixed(1).padStart(4)} deg/s RMS, stick->packet latency ${mean(lat).toFixed(1)} ms, sample-age jitter ${mean(jit).toFixed(2)} ms`);
    }
    console.log(`${seeds.length} timelines each\n${rows.join('\n')}`);
    // Chrome-like 250 Hz input: mixer sync removes the duplicate/skip packets the clock beat causes
    expect(res.new250.ff).toBeLessThan(res.old250.ff * 0.5);
    expect(res.new250.ffWorst).toBeLessThan(0.6);
    expect(res.new250.sp).toBeLessThan(res.old250.sp * 0.6);
    // fast 1 kHz input
    expect(res.new1000.ff).toBeLessThan(res.old1000.ff * 0.8);
    expect(res.new1000.sp).toBeLessThan(res.old1000.sp * 0.6);
  }, 300000);

  test('radio in BLE joystick mode (40-90 Hz reports): no staircase, no feedforward spikes', async () => {
    const nPk = Math.ceil(T_RUN / PKT), k0 = Math.round(T_SKIP / PKT);
    const rows: string[] = [];
    for (const padHz of [90, 60, 40]) {
      const res: Record<string, { dups: number; ff: number; spikes: number; sp: number; lat: number }> = {};
      let inputMs = 0;
      for (const mode of ['stair', 'interp'] as const) {
        const acc = { dups: 0, ff: 0, spikes: 0, sp: 0, lat: 0 }, seeds = [11, 22, 33];
        for (const seed of seeds) {
          const pk = blePackets(padHz, seed, mode === 'interp');
          if (mode === 'interp') inputMs = pk.inputMs;
          const latMs = fitLatency(pk.v);
          const ideal = await runBf(Array.from({ length: nPk }, (_, k) => WAVE(k * PKT - latMs / 1000)));
          const got = await runBf(pk.v);
          // packets that repeat the previous value while the stick is moving (Betaflight: duplicates)
          let dups = 0; for (let k = k0; k < nPk; k++) if (pk.v[k] === pk.v[k - 1]) dups++;
          // feedforward spikes: PID loops whose feedforward is off by more than half its peak
          const ffPeak = Math.max(...ideal.ff.slice(i0).map(Math.abs));
          let spikes = 0; for (let i = i0; i < got.ff.length; i++) if (Math.abs(got.ff[i] - ideal.ff[i]) > 0.5 * ffPeak) spikes++;
          acc.dups += dups / (nPk - k0); acc.ff += rmsDiff(got.ff, ideal.ff) / rms(ideal.ff);
          acc.spikes += spikes / (got.ff.length - i0);
          acc.sp += rmsDiff(got.sp, ideal.sp); acc.lat += latMs;
        }
        for (const k of Object.keys(acc) as (keyof typeof acc)[]) acc[k] /= seeds.length;
        res[mode] = acc;
        rows.push(`${mode.padEnd(6)} pad ${padHz} Hz: duplicate packets ${(100 * acc.dups).toFixed(0).padStart(2)} %, feedforward error ${(100 * acc.ff).toFixed(0).padStart(3)} % (spikes > half its peak in ${(100 * acc.spikes).toFixed(1).padStart(4)} % of PID loops), setpoint error ${acc.sp.toFixed(1).padStart(4)} deg/s RMS, stick->packet latency ${acc.lat.toFixed(1)} ms`);
      }
      const { stair, interp } = res;
      // the staircase: most packets duplicates, feedforward spikes at the input rate
      expect(stair.dups).toBeGreaterThan(0.5);
      expect(stair.spikes).toBeGreaterThan(0.1);
      // reconstructed: duplicates and spikes only around missed reports
      expect(interp.dups).toBeLessThan(0.05);
      expect(interp.spikes).toBeLessThan(0.25 * stair.spikes);
      expect(interp.ff).toBeLessThan(0.7 * stair.ff);
      expect(interp.sp).toBeLessThan(0.5 * stair.sp);
      // the price: well under one input interval of extra latency (the staircase averaged half an
      // interval plus the mixer-sync offset)
      expect(interp.lat - stair.lat).toBeLessThan(0.5 * inputMs + 2);
      expect(inputMs).toBeGreaterThan(0.85 * 1000 / padHz); expect(inputMs).toBeLessThan(1.25 * 1000 / padHz);
    }
    console.log(rows.join('\n'));
  }, 600000);
});

/**
 * A radio in BLE joystick mode: a report every connection event (1/padHz, ±0.5 ms), 3 % of the
 * events missed, stamped by the browser on arrival and visible at its next 4 ms gamepad poll; the
 * main thread polls every ~1.25 ms into the stick ring, the worker wakes every ~4 ms.
 */
function blePackets(padHz: number, seed: number, interp: boolean, miss = 0.03): { v: number[]; inputMs: number } {
  const r = rng(seed);
  const reports: { t: number; vis: number }[] = [];
  const phase = r() * 0.004;
  for (let t = r() / padHz; t < T_RUN + 0.2; t += 1 / padHz) {
    if (r() < miss) continue;
    const rt = t + (r() - 0.5) * 0.001;
    reports.push({ t: rt, vis: Math.ceil((rt - phase) / 0.004) * 0.004 + phase });
  }
  const sh = createShared(), ch = new Float32Array(16).fill(1500), got = new Float32Array(16);
  const toMs = (t: number) => 1.7e12 + t * 1000;
  const sampler = new StickSampler(L_MS);
  if (!interp) sampler.maxInterpMs = 0;
  const wakes: number[] = [];
  for (let w = r() * 0.004; w < T_RUN + 0.1; w += 0.004 + (r() - 0.5) * 0.002) wakes.push(w);
  let wi = 0, ri = -1, p = r() * 0.00125;
  const v: number[] = [];
  for (let k = 0; k < Math.ceil(T_RUN / PKT); k++) {
    const tp = k * PKT; while (wakes[wi] < tp) wi++;
    for (; p <= wakes[wi]; p += 0.00125 + (r() - 0.5) * 0.0006) {
      while (ri + 1 < reports.length && reports[ri + 1].vis <= p) ri++;
      const rt = ri >= 0 ? reports[ri].t : 0; ch[0] = WAVE(rt); writeStick(sh, toMs(rt), ch);
    }
    sampler.sample(sh, toMs(tp), got);
    v.push(got[0]);
  }
  return { v, inputMs: sampler.inputMs };
}

/** Latency (ms) that best explains the packet values as the stick wave delayed. */
function fitLatency(v: number[]): number {
  let best = 0, bestE = Infinity;
  for (let d = 0; d <= 60; d += 0.1) {
    let e = 0; for (let k = Math.round(T_SKIP / PKT); k < v.length; k++) e += (v[k] - WAVE(k * PKT - d / 1000)) ** 2;
    if (e < bestE) { bestE = e; best = d; }
  }
  return best;
}
