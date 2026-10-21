// Worker reliability pieces: EEPROM persistence across a reload (real WASM), CLI batch pacing,
// the IndexedDB store's failure handling, the timestamped stick ring, the blackbox recorder, FC
// hardware error models, the overload governor and the worker bridge's restart.
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { describe, expect, test } from 'vitest';
import { WorkerBridge } from '../src/app/bridge';
import { Betaflight } from '../src/bf/bfModule';
import { defaultCli, simHardwareCli } from '../src/bf/defaults';
import { buildDrone, DEFAULT_SPEC, PRESETS } from '../src/builder/derive';
import { BblRecorder } from '../src/worker/bbl';
import { BaroModel, Brownout, CurrentSensor, OverloadGovernor, seedOf } from '../src/worker/fcHardware';
import { EepromStore, runCliBatch } from '../src/worker/fwCli';
import { IdbKv, MemoryKv } from '../src/worker/kv';
import { createShared, DEFAULT_SETTINGS, FromWorker, stickAt, STICK_N, ToWorker, writeStick } from '../src/worker/shared';

const FW = new URL('../public/bf/betaflight.mjs', import.meta.url);
const have = existsSync(FW);
const G = 9.80665;

async function bench() {
  const mod = await import(/* @vite-ignore */ pathToFileURL(FW.pathname.replace(/^\/([A-Za-z]:)/, '$1')).href);
  const bf = await Betaflight.fromFactory(mod.default);
  const rc = new Float32Array(16).fill(1500); rc[2] = 1000; rc[4] = 1000;
  let rcAcc = 0, ms = 0;
  // the plant held at rest: what the worker does during CLI batches after boot
  const step = () => {
    bf.setImu(0, 0, 0, 0, 0, G); bf.setBattery(16.4, 0.3, 0);
    rcAcc += 125e-6; if (rcAcc >= 0.004) { rcAcc = 0; bf.setRc(rc); }
    bf.step(125);
  };
  const advance = (t: number) => { ms += t; for (let i = 0; i < t * 8; i++) step(); };
  bf.setBattery(16.4, 0, 0); bf.setImu(0, 0, 0, 0, 0, G); bf.setRc(rc);
  return { bf, advance, step, elapsedMs: () => ms, resetMs: () => { ms = 0; } };
}

describe.skipIf(!have)('EEPROM persistence (real Betaflight WASM)', () => {
  test('a CLI save survives a reload: re-init from the stored image', async () => {
    const kv = new MemoryKv(), store = new EepromStore(kv);
    const a = await bench();
    a.bf.init(); a.advance(500);
    runCliBatch(a.bf, defaultCli(buildDrone(DEFAULT_SPEC)), a.advance);
    expect(store.check(a.bf)).toBe(true); // defaults saved
    // what the user does in the CLI console / OSD menu: change something, save
    const out = runCliBatch(a.bf, ['set craft_name = KEEPME', 'set roll_rc_rate = 123', 'save'], a.advance);
    expect(out).toMatch(/craft_name set to KEEPME/i);
    // the worker's check fires once; the old code read bf_eeprom_dirty() twice and stored nothing
    expect(store.check(a.bf)).toBe(true);
    expect(a.bf.eepromDirty()).toBe(false); // reading it reset it: a second reader would see false
    await store.flush();
    expect(store.writes).toBe(2);
    const saved = await store.load();
    expect(saved).toBeDefined();
    // "reload": a fresh firmware instance boots from the stored image
    const b = await bench();
    b.bf.eepromSet(saved!);
    b.bf.init(); b.advance(500);
    // a normal boot from a valid image doesn't rewrite it (the worker would re-apply defaults)
    expect(b.bf.eepromDirty()).toBe(false);
    const got = runCliBatch(b.bf, ['get craft_name', 'get roll_rc_rate'], b.advance);
    expect(got).toMatch(/craft_name = KEEPME/);
    expect(got).toMatch(/roll_rc_rate = 123/);
  }, 120000);

  test('every preset\'s defaults and post-import hardware lines are accepted by Betaflight 4.5.5', async () => {
    const seen = new Set<string>();
    for (const spec of PRESETS) {
      const b = buildDrone(spec), key = `${spec.fc}|${spec.frame}|${spec.video}`;
      if (seen.has(key)) continue; seen.add(key);
      const a = await bench();
      a.bf.init(); a.advance(300);
      const out = runCliBatch(a.bf, [...defaultCli(b).filter((l) => l !== 'save'), ...simHardwareCli(b, { keepOsdLayout: false, propsOut: null }), 'save'], a.advance);
      expect(out, spec.name).not.toMatch(/ERROR|INVALID|PARSING FAILED/i);
      const got = runCliBatch(a.bf, ['get failsafe_procedure', 'get pid_process_denom', 'get blackbox_sample_rate', 'get small_angle'], a.advance).replace(/\r/g, '');
      expect(got).toMatch(new RegExp(`failsafe_procedure = ${spec.frame === 'f7-lr' ? 'GPS-RESCUE' : 'DROP'}`));
      expect(got).toMatch(/small_angle = 25/);
      expect(got).toMatch(b.params.imuChip.sampleRateHz < 8000 ? /blackbox_sample_rate = 1\/2/ : /blackbox_sample_rate = 1\/4/);
    }
    expect(seen.size).toBeGreaterThan(3);
  }, 120000);

  test('a blank / foreign image is reset by the firmware at boot and shows as dirty', async () => {
    const b = await bench();
    b.bf.eepromSet(new Uint8Array(1024).fill(0x5a));
    b.bf.init(); b.advance(500);
    expect(b.bf.eepromDirty()).toBe(true);
  }, 60000);

  test('get batches answer on the prompt: 44 gets take well under a second of firmware time', async () => {
    const a = await bench();
    a.bf.init(); a.advance(500);
    const keys = ['roll_rc_rate', 'pitch_rc_rate', 'yaw_rc_rate', 'roll_expo', 'pitch_expo', 'yaw_expo', 'roll_srate', 'pitch_srate', 'yaw_srate', 'p_roll', 'i_roll', 'd_roll', 'f_roll', 'p_pitch', 'i_pitch', 'd_pitch', 'f_pitch', 'p_yaw', 'i_yaw', 'd_yaw', 'f_yaw', 'd_min_roll', 'd_min_pitch', 'gyro_lpf1_static_hz', 'gyro_lpf2_static_hz', 'dterm_lpf1_static_hz', 'dterm_lpf2_static_hz', 'dyn_notch_count', 'dyn_notch_q', 'dyn_notch_min_hz', 'dyn_notch_max_hz', 'rpm_filter_harmonics', 'rpm_filter_min_hz', 'tpa_rate', 'tpa_breakpoint', 'anti_gravity_gain', 'iterm_relax_cutoff', 'feedforward_transition', 'feedforward_smooth_factor', 'feedforward_jitter_factor', 'feedforward_boost', 'thrust_linear', 'motor_output_limit', 'dyn_idle_min_rpm'];
    expect(keys.length).toBe(44);
    a.resetMs();
    const out = runCliBatch(a.bf, keys.map((k) => `get ${k}`), a.advance);
    const answered = keys.filter((k) => new RegExp(`^${k} = `, 'm').test(out.replace(/\r/g, ''))).length;
    console.log(`44 gets: ${answered} answered in ${a.elapsedMs()} ms of firmware time (incl. the closing exit + reboot)`);
    expect(answered).toBe(44);
    // the old pump spent >= 170 ms per line (7.5 s); now each line returns with its prompt
    expect(a.elapsedMs()).toBeLessThan(1500 + 44 * 15);
  }, 60000);
});

describe('IndexedDB store', () => {
  test('a hung open times out: boot goes on without persistence and says why once', async () => {
    const why: string[] = [];
    const kv = new IdbKv({ open: () => ({}) as IDBOpenDBRequest }, (w) => why.push(w), 30);
    expect(await kv.get('x')).toBeUndefined();
    expect(await kv.set('x', 1)).toBe(false);
    expect(why.length).toBe(1);
    expect(kv.unavailable).toMatch(/no answer/);
  });
  test('blocked / failing / missing IndexedDB is unavailable, not an exception', async () => {
    const mk = (fire: 'onblocked' | 'onerror') => ({
      open: () => { const r: any = { error: { message: 'quota' } }; setTimeout(() => r[fire]?.(), 1); return r as IDBOpenDBRequest; },
    });
    const b = new IdbKv(mk('onblocked'), () => {}, 1000);
    expect(await b.get('k')).toBeUndefined(); expect(b.unavailable).toMatch(/blocked/);
    const e = new IdbKv(mk('onerror'), () => {}, 1000);
    expect(await e.set('k', 2)).toBe(false); expect(e.unavailable).toMatch(/quota/);
    const n = new IdbKv(undefined, () => {}, 1000);
    expect(await n.get('k')).toBeUndefined(); expect(n.unavailable).toMatch(/not available/);
  });
  test('EEPROM writes are queued in order; the newest image wins', async () => {
    let slow = true;
    const kv = new MemoryKv();
    const orig = kv.set.bind(kv);
    kv.set = async (k, v) => { if (slow) { slow = false; await new Promise((r) => setTimeout(r, 20)); } return orig(k, v); };
    const s = new EepromStore(kv);
    void s.save(new Uint8Array([1])); void s.save(new Uint8Array([2]));
    await s.flush();
    expect(Array.from((await s.load())!)).toEqual([2]);
  });
});

describe('timestamped stick ring', () => {
  test('newest sample at or before the asked time, no interpolation, monotonic times', () => {
    const sh = createShared();
    const out = new Float32Array(16);
    expect(stickAt(sh, 1e12, out)).toBe(false);
    const ch = new Float32Array(16).fill(1500);
    for (let i = 0; i < 10; i++) { ch[0] = 1000 + i; writeStick(sh, 1000 + i, ch); }
    stickAt(sh, 1004.5, out); expect(out[0]).toBe(1004);
    stickAt(sh, 1004, out); expect(out[0]).toBe(1004);
    stickAt(sh, 2000, out); expect(out[0]).toBe(1009);
    stickAt(sh, 0, out); expect(out[0]).toBe(1000); // nothing old enough: the oldest held
    ch[0] = 1999; writeStick(sh, 900, ch);          // a timestamp going backwards is clamped
    stickAt(sh, 1009, out); expect(out[0]).toBe(1999);
    // wrap-around: only the last STICK_N - 1 samples are trusted
    for (let i = 0; i < 3 * STICK_N; i++) { ch[0] = i; writeStick(sh, 5000 + i, ch); }
    stickAt(sh, 0, out); expect(out[0]).toBe(3 * STICK_N - (STICK_N - 1));
  });
});

describe('native blackbox recorder', () => {
  test('one log per armed session, trailer kept, oldest sessions dropped over the cap', () => {
    const r = new BblRecorder(100);
    const b = (n: number, v = 1) => new Uint8Array(n).fill(v);
    r.push(b(0), false);
    r.push(b(30, 1), true); r.push(b(10, 2), false); // disarm: "End of log" still arrives
    expect(r.count).toBe(1); expect(r.size).toBe(40);
    r.push(b(30, 3), true);
    expect(r.count).toBe(2);
    r.push(b(50, 4), true); // 110 > 100: the first session goes
    expect(r.count).toBe(1); expect(r.size).toBe(80);
    expect(new Uint8Array(r.export())[0]).toBe(3);
    r.push(b(30, 5), true); // a single session can't exceed the cap: it stops growing
    expect(r.full).toBe(true); expect(r.size).toBe(80);
  });
});

describe('FC hardware error models', () => {
  test('baro: ~0.3 m noise, reads low (higher pressure) in prop wash near the ground', () => {
    const m = new BaroModel(7), rho = 1.225, P = 101325;
    const n = 20000; let s = 0, s2 = 0;
    for (let i = 0; i < n; i++) { const e = (m.read(P, rho, 20, 0, 0.05, 0.0635) - P) / (rho * G); s += e; s2 += e * e; }
    const sd = Math.sqrt(s2 / n - (s / n) ** 2);
    expect(sd).toBeGreaterThan(0.27); expect(sd).toBeLessThan(0.33);
    m.noiseM = 0;
    const hover = 6.4, disk = 0.0507; // 5" quad at hover
    const ground = (m.read(P, rho, 0.05, hover, disk, 0.0635) - P) / (rho * G);
    const high = (m.read(P, rho, 10, hover, disk, 0.0635) - P) / (rho * G);
    console.log(`baro prop-wash error: ${ground.toFixed(2)} m of altitude at 5 cm, ${high.toFixed(2)} m at 10 m`);
    expect(ground).toBeGreaterThan(0.3); expect(ground).toBeLessThan(1.5); // reads ~0.6 m low on the pad
    expect(high).toBeLessThan(ground / 4);
  });
  test('current sensor: seeded per build, offset within ±1 A and scale within ±10 %', () => {
    const offs: number[] = [];
    for (let i = 0; i < 200; i++) {
      const c = new CurrentSensor(seedOf(`build${i}`));
      expect(Math.abs(c.offsetA)).toBeLessThanOrEqual(1); expect(Math.abs(c.scale - 1)).toBeLessThanOrEqual(0.1);
      offs.push(c.offsetA);
    }
    expect(Math.max(...offs) - Math.min(...offs)).toBeGreaterThan(1.5); // builds differ
    const a = new CurrentSensor(42), b = new CurrentSensor(42);
    expect(a.read(20)).toBe(b.read(20));
    expect(a.read(0)).toBeGreaterThanOrEqual(0);
    a.step(36, 1); expect(a.mah).toBeCloseTo((36 * a.scale + a.offsetA) / 3.6, 6);
  });
  test('brownout: below 2.8 V for > 30 ms resets the FC, back after the pack recovers', () => {
    const b = new Brownout(2.8, 0.03, 3.0, 0.8);
    const run = (v: number, s: number) => { const ev: string[] = []; for (let t = 0; t < s; t += 0.001) { const e = b.update(v, 0.001); if (e) ev.push(e); } return ev; };
    expect(run(2.7, 0.02)).toEqual([]);         // a 20 ms dip is ridden out
    expect(run(3.5, 0.01)).toEqual([]);
    expect(run(2.7, 0.05)).toEqual(['down']);
    expect(run(2.95, 1)).toEqual([]);            // not recovered yet
    expect(run(3.3, 0.5)).toEqual([]);           // booting
    expect(run(3.3, 0.5)).toEqual(['up']);
  });
  test('overload governor: 3 s below 0.85x steps 8000 -> 4000 -> 2000, never below', () => {
    const g = new OverloadGovernor();
    const feed = (cap: number, s: number, hz: number, on = true) => { for (let t = 0; t < s; t += 0.004) { const r = g.update(cap, 1, 0.004, hz, on); if (r) return r; } return null; };
    expect(feed(0.9, 10, 8000)).toBeNull();
    expect(feed(0.5, 2.5, 8000)).toBeNull();
    expect(feed(1.2, 0.1, 8000)).toBeNull(); // recovered: the timer starts over
    expect(feed(0.5, 3.1, 8000)).toBe(4000);
    expect(feed(0.5, 3.1, 4000)).toBe(2000);
    expect(feed(0.5, 10, 2000)).toBeNull();
    expect(feed(0.5, 10, 8000, false)).toBeNull(); // autoRate off
    expect(g.update(0.45, 0.5, 3.5, 8000, true)).toBeNull(); // slow motion (0.5x) needs only 0.43x
  });
});

describe('worker bridge', () => {
  class FakeWorker {
    sent: ToWorker[] = []; terminated = false;
    onmessage: ((e: MessageEvent<FromWorker>) => void) | null = null;
    onerror: ((e: ErrorEvent) => void) | null = null;
    onmessageerror: (() => void) | null = null;
    postMessage(m: ToWorker) { this.sent.push(m); }
    terminate() { this.terminated = true; }
    say(m: FromWorker) { this.onmessage?.({ data: m } as MessageEvent<FromWorker>); }
  }
  test('restarts a dead worker once with the latest spec / settings / maps, then reports fatal', async () => {
    const made: FakeWorker[] = [];
    const bridge = new WorkerBridge(1, () => { const w = new FakeWorker(); made.push(w); return w as unknown as Worker; });
    const seen: FromWorker[] = [];
    bridge.onMessage = (m) => seen.push(m);
    const sh = createShared();
    bridge.send({ type: 'init', sab: sh.sab, spec: { a: 1 }, settings: DEFAULT_SETTINGS });
    bridge.send({ type: 'spec', spec: { a: 2 } });
    bridge.send({ type: 'settings', settings: { ...DEFAULT_SETTINGS, mapId: 'bando' } });
    bridge.send({ type: 'registerMap', id: 'local-x', info: { name: 'x', author: '', license: '' }, urls: {} });
    const pending = bridge.cliBatch(['get p_roll']);
    made[0].say({ type: 'fatal', reason: 'boom' });
    expect(made[0].terminated).toBe(true);
    expect(await pending).toBe(''); // never left hanging
    expect(made.length).toBe(2);
    const init = made[1].sent[0] as Extract<ToWorker, { type: 'init' }>;
    expect(init.type).toBe('init');
    expect(init.spec).toEqual({ a: 2 });
    expect(init.settings.mapId).toBe('bando');
    expect(made[1].sent[1].type).toBe('registerMap');
    expect(seen.some((m) => m.type === 'log' && /restarting/.test(m.text))).toBe(true);
    made[0].say({ type: 'log', text: 'late words of the old worker' });
    expect(seen.some((m) => m.type === 'log' && m.text.startsWith('late'))).toBe(false);
    made[1].onerror?.({ message: 'again', preventDefault() {} } as unknown as ErrorEvent);
    expect(seen.at(-1)).toEqual({ type: 'fatal', reason: 'again' });
    expect(made.length).toBe(2);
    expect(await bridge.cliBatch(['x'])).toBe('');
  });
});
