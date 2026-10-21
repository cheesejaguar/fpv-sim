// Firmware realism features of the Betaflight WASM build: accelerometer calibration, yaw spin
// recovery, virtual gyro ODR (BMI270 3.2 kHz), beeper / DShot beacon, native serial blackbox,
// u-blox GPS, CPU load, eRPM telemetry errors. Skipped when the firmware hasn't been built.
// The UBX helpers at the bottom double as a reference receiver emulator.
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { describe, expect, test } from 'vitest';
import { Betaflight, BF_PORT } from '../src/bf/bfModule';
import { defaultCli } from '../src/bf/defaults';
import { buildDrone, DEFAULT_SPEC, PRESETS } from '../src/builder/derive';
import { GroundPlane } from '../src/sim/contact';
import { QuadEnv, QuadSim } from '../src/sim/quad';
import { WakeField } from '../src/sim/wake';
import { Wind } from '../src/sim/wind';

const FW = new URL('../public/bf/betaflight.mjs', import.meta.url);
const have = existsSync(FW);
const G = 9.80665, DEG = Math.PI / 180;
const DT_US = 125, DT = DT_US / 1e6;
const ACC_CALIBRATION_FLAG = 1 << 23; // ARMING_DISABLED_ACC_CALIBRATION
const enc = new TextEncoder(), dec = new TextDecoder();

async function loadBf() {
  const mod = await import(/* @vite-ignore */ pathToFileURL(FW.pathname.replace(/^\/([A-Za-z]:)/, '$1')).href);
  return Betaflight.fromFactory(mod.default);
}

/** Open loop: the firmware alone, with an IMU sample the test sets (FLU rad/s, m/s²). */
async function bench(opts: { gyroHz?: number } = {}) {
  const bf = await loadBf();
  const imu = { wx: 0, wy: 0, wz: 0, ax: 0, ay: 0, az: G };
  const rc = new Float32Array(16).fill(1500); rc[2] = 1000; rc[4] = 1000; rc[5] = 1000; rc[6] = 1000; rc[7] = 1000;
  let rcOn = true, rcAcc = 0, t = 0;
  const hooks: ((t: number) => void)[] = [];
  const step = () => {
    bf.setImu(imu.wx, imu.wy, imu.wz, imu.ax, imu.ay, imu.az);
    bf.setBattery(16.4, 0.5, 0);
    rcAcc += DT; if (rcAcc >= 0.004) { rcAcc = 0; if (rcOn) { bf.setRc(rc); bf.setLinkStats(100, -40, 2); } }
    bf.step(DT_US); t += DT;
    for (const h of hooks) h(t);
  };
  const run = (s: number) => { for (let i = 0; i < Math.round(s / DT); i++) step(); };
  const cli = (lines: string[]) => {
    let out = '';
    bf.serialWrite(0, enc.encode('#\n')); run(0.3); out += dec.decode(bf.serialRead(0));
    for (const l of lines) { if (l.startsWith('#')) continue; bf.serialWrite(0, enc.encode(l + '\n')); run(l === 'save' ? 2.5 : 0.12); out += dec.decode(bf.serialRead(0)); }
    if (!lines.includes('save')) { bf.serialWrite(0, enc.encode('exit\n')); run(2.5); out += dec.decode(bf.serialRead(0)); }
    return out;
  };
  if (opts.gyroHz) bf.setGyroRate(opts.gyroHz);
  bf.setBattery(16.4, 0, 0); bf.setImu(0, 0, 0, 0, 0, G);
  bf.init();
  return { bf, imu, rc, run, cli, hooks, setRcOn: (on: boolean) => { rcOn = on; }, time: () => t };
}

/** Closed loop with the generated plant. Below 8 kHz the IMU is handed over only on fresh ODR samples. */
async function rig(spec = DEFAULT_SPEC, opts: { gyroHz?: number } = {}) {
  const bf = await loadBf();
  const build = buildDrone(spec);
  const quad = new QuadSim(build.params, 8000);
  const env: QuadEnv = { world: new GroundPlane(), wind: new Wind({ speed20ft: 0, directionDeg: 0, z0: 0.03, turbulence: 0, gustiness: 0, gustMax: 0 }), wake: new WakeField(), ambientC: 20, altitudeOffset: 0, damageEnabled: false };
  quad.reset({ x: 0, y: 0, z: 0.04 });
  const rc = new Float32Array(16).fill(1500); rc[2] = 1000; rc[4] = 1000; rc[5] = 1000; rc[6] = 1000; rc[7] = 1000;
  const mot = new Uint16Array(4), erpm = new Float32Array(4);
  const odr = opts.gyroHz ?? 8000;
  let rcAcc = 0, hold = 0, t = 0;
  const hooks: ((t: number) => void)[] = [];
  const step = () => {
    // mirror of the IMU's sample-and-hold (src/sim/imu.ts): the chip latched a new sample this step
    hold += DT; const fresh = odr >= 8000 || hold >= 1 / odr - 1e-9;
    if (fresh && odr < 8000) { hold -= 1 / odr; if (hold > DT) hold = 0; }
    const g = quad.imu.gyroOut, a = quad.imu.accOut;
    if (fresh) bf.setImu(g.x, g.y, g.z, a.x, a.y, a.z);
    for (let k = 0; k < 4; k++) erpm[k] = Math.abs(quad.motors[k].erpm());
    bf.setErpm(erpm);
    bf.setBattery(quad.battery.s.voltage, quad.battery.s.current, quad.battery.s.mAhDrawn);
    rcAcc += DT; if (rcAcc >= 0.004) { rcAcc = 0; bf.setRc(rc); }
    bf.step(DT_US); t += DT;
    const armed = bf.getMotors(mot);
    quad.command(mot, bf.motorsReversed());
    quad.step(DT, env);
    for (const h of hooks) h(t);
    return armed;
  };
  const run = (s: number) => { let armed = false; for (let i = 0; i < Math.round(s / DT); i++) armed = step(); return armed; };
  const cli = (lines: string[]) => {
    let out = '';
    bf.serialWrite(0, enc.encode('#\n')); run(0.3); out += dec.decode(bf.serialRead(0));
    for (const l of lines) { if (l.startsWith('#')) continue; bf.serialWrite(0, enc.encode(l + '\n')); run(l === 'save' ? 2.5 : 0.12); out += dec.decode(bf.serialRead(0)); }
    if (!lines.includes('save')) { bf.serialWrite(0, enc.encode('exit\n')); run(2.5); out += dec.decode(bf.serialRead(0)); }
    return out;
  };
  if (opts.gyroHz) bf.setGyroRate(opts.gyroHz);
  bf.setBattery(quad.battery.s.voltage, 0, 0);
  bf.setImu(0, 0, 0, 0, 0, G);
  bf.init();
  /** first boot as the worker does it: defaults, then the level accelerometer calibration */
  const firstBoot = (extra: string[] = []) => {
    run(1);
    const lines = defaultCli(build).filter((l) => l !== 'save');
    const out = cli([...lines, ...extra, 'save']);
    run(1); bf.calibrateAcc(); run(1);
    return out;
  };
  return { bf, quad, rc, run, cli, build, hooks, firstBoot, time: () => t };
}

const tilt = (q: { x: number; y: number }) => Math.acos(Math.min(1, 1 - 2 * (q.x * q.x + q.y * q.y))) / DEG;

describe.skipIf(!have)('Betaflight WASM firmware realism', () => {
  test('accelerometer: arming needs a level calibration, which removes the offset and is saved', async () => {
    const b = await bench();
    b.imu.ax = 0.040 * G; b.imu.ay = -0.030 * G; // board offset: +40 mg x, -30 mg y
    b.run(1);
    expect(b.bf.accCalibrated()).toBe(false);
    b.cli(defaultCli(buildDrone(DEFAULT_SPEC))); // defaults configure ANGLE / HORIZON on AUX2
    b.run(4);
    expect(b.bf.armingDisableFlags() & ACC_CALIBRATION_FLAG).toBeTruthy();
    b.bf.eepromDirty(); // baseline
    expect(b.bf.calibrateAcc()).toBe(true);
    expect(b.bf.accCalibrating()).toBe(true);
    b.run(1); // 400 acc samples at 1 kHz
    expect(b.bf.accCalibrating()).toBe(false);
    expect(b.bf.accCalibrated()).toBe(true);
    expect(b.bf.eepromDirty()).toBe(true); // saveConfigAndNotify(): the host persists it
    b.run(0.5);
    expect(b.bf.armingDisableFlags() & ACC_CALIBRATION_FLAG).toBe(0);
    const out = b.cli(['get acc_calibration']);
    const m = /acc_calibration = (-?\d+),(-?\d+),(-?\d+),(\d)/.exec(out);
    console.log(`acc_calibration after calibrating a +40/-30 mg offset: ${m?.slice(1).join(',')}`);
    expect(m).toBeTruthy();
    expect(+m![1]).toBeCloseTo(0.040 * 256, -0.5); // acc_1G = 256 counts
    expect(+m![2]).toBeCloseTo(-0.030 * 256, -0.5);
    expect(Math.abs(+m![3])).toBeLessThanOrEqual(1);
    expect(+m![4]).toBe(1);
    // the calibrated attitude reads level although the raw acc says otherwise
    const att = b.bf.attitude();
    expect(Math.abs(att[0])).toBeLessThan(0.5); expect(Math.abs(att[1])).toBeLessThan(0.5);
  }, 120000);

  test('yaw spin recovery engages above the threshold and releases below it', async () => {
    const b = await bench();
    b.run(1); b.cli(defaultCli(buildDrone(DEFAULT_SPEC))); b.bf.calibrateAcc(); b.run(5);
    expect(b.bf.armingDisableFlags()).toBe(0);
    b.rc[4] = 1900; b.run(0.3);
    expect(b.bf.getMotors(new Uint16Array(4))).toBe(true);
    b.imu.wz = -1300 * DEG; // 1300 deg/s nose-right spin (auto threshold ~870 deg/s at default rates)
    b.run(0.1);
    expect(b.bf.yawSpinDetected()).toBe(true);
    b.imu.wz = 0; b.run(0.1);
    expect(b.bf.yawSpinDetected()).toBe(false);
    b.imu.wz = -600 * DEG; b.run(0.1); // a hard but normal yaw rate never triggers it
    expect(b.bf.yawSpinDetected()).toBe(false);
  }, 120000);

  test('BMI270: the virtual gyro runs at 3.2 kHz, locks to fresh samples and flies stably', async () => {
    const spec = PRESETS.find((p) => p.name === 'Beginner: 3" Cinewhoop 4S HD')!;
    const r = await rig(spec, { gyroHz: 3200 });
    const period = (r.bf as any).m._bf_gyro_period_us();
    expect(period).toBe(312);
    r.firstBoot();
    // `tasks` total/ms grows by the emulated 7 us per gyro run (cpu_load.c): exact run count over 2 s.
    // (Its rate/hz column is a short moving average of 250 / 375 us periods on the 125 us physics grid.)
    const gyroTotalMs = (o: string) => +(/GYRO\)\s+\d+\s+\d+\s+\d+\s+[\d.]+%\s+[\d.]+%\s+(\d+)/.exec(o)?.[1] ?? NaN);
    const say = (l: string, s: number) => { r.bf.serialWrite(0, enc.encode(l + '\n')); r.run(s); return dec.decode(r.bf.serialRead(0)); };
    say('#', 0.3);
    const t1 = say('tasks', 0.12); r.run(2); const t2 = say('tasks', 0.12); // stays in the CLI: no reboot in between
    const st = t1 + r.cli(['status', 'get pid_process_denom']);
    const runsPerS = ((gyroTotalMs(t2) - gyroTotalMs(t1)) / 0.007) / 2.12;
    const pid = +(/PID\)\s+(\d+)/.exec(st)?.[1] ?? 0), cpu = +(/CPU:(\d+)%/.exec(st)?.[1] ?? -1);
    console.log(`BMI270: gyro task ${runsPerS.toFixed(0)} runs/s (fresh samples 3200/s), PID ${pid} Hz (moving avg), CPU ${cpu} % (bf_cpu_load ${r.bf.cpuLoad()} %), ${/pid_process_denom = \d+/.exec(st)?.[0]}`);
    expect(runsPerS).toBeGreaterThan(3150); expect(runsPerS).toBeLessThan(3250);
    expect(pid).toBeGreaterThan(2900); expect(pid).toBeLessThan(3500);
    expect(cpu).toBeGreaterThan(5); expect(cpu).toBeLessThan(25);
    expect(st).toMatch(/pid_process_denom = 1/);
    r.run(4); // the CLI exit rebooted the FC: boot grace time
    expect(r.bf.armingDisableFlags()).toBe(0);
    r.rc[4] = 1900; expect(r.run(0.3)).toBe(true);
    const hover = 1000 + 1000 * (0.055 + r.build.info.hoverThrottle * 0.945);
    r.rc[2] = Math.min(2000, hover + 150); r.run(0.8);
    r.rc[2] = hover; r.run(1.0);
    const tilt0 = tilt(r.quad.s.q);
    let s2 = 0, n = 0;
    for (let i = 0; i < 16000; i++) { r.run(1 / 8000); const w = r.quad.s.w; s2 += w.x * w.x + w.y * w.y; n++; }
    const rmsDps = Math.sqrt(s2 / n) / DEG;
    console.log(`BMI270 3.2 kHz: roll/pitch rate RMS ${rmsDps.toFixed(1)} deg/s, attitude change ${Math.abs(tilt(r.quad.s.q) - tilt0).toFixed(2)} deg, alt ${r.quad.s.pos.z.toFixed(1)} m`);
    expect(rmsDps).toBeLessThan(25);
    expect(Math.abs(tilt(r.quad.s.q) - tilt0)).toBeLessThan(3);
    r.rc[0] = 2000; r.run(0.25);
    expect(r.quad.s.w.x / DEG).toBeGreaterThan(400);
  }, 180000);

  test('beeper: BEEPER switch and RX loss sound the buzzer; DShot beacon when enabled', async () => {
    const b = await bench();
    b.run(1);
    b.cli([...defaultCli(buildDrone(DEFAULT_SPEC)).filter((l) => l !== 'save'), 'beacon RX_SET', 'beacon RX_LOST', 'save']);
    b.bf.calibrateAcc(); b.run(4);
    let beep = 0, beacon = 0, n = 0;
    const sample = () => { n++; if (b.bf.beeper()) beep++; if (b.bf.beacon()) beacon++; };
    for (let i = 0; i < 4000; i++) { b.run(1 / 8000); sample(); }
    expect(beep).toBe(0); expect(beacon).toBe(0); // quiet while idle
    b.rc[7] = 2000; // AUX4: BEEPER box
    beep = beacon = n = 0;
    for (let i = 0; i < 16000; i++) { b.run(1 / 8000); sample(); }
    console.log(`BEEPER switch: buzzer on ${(100 * beep / n).toFixed(0)} %, DShot beacon on ${(100 * beacon / n).toFixed(0)} % of 2 s`);
    expect(beep).toBeGreaterThan(0); expect(beacon).toBeGreaterThan(0);
    b.rc[7] = 1000; b.run(1);
    beep = 0; for (let i = 0; i < 8000; i++) { b.run(1 / 8000); sample(); }
    expect(beep).toBe(0);
    b.rc[4] = 1900; b.run(0.5); b.rc[4] = 1000; b.run(0.5); // RX_LOST only beeps once the quad has been armed
    expect(b.bf.armingDisableFlags()).toBe(0);
    b.setRcOn(false); // transmitter off: RX loss -> failsafe -> RX_LOST beeps
    beep = beacon = n = 0;
    for (let i = 0; i < 24000; i++) { b.run(1 / 8000); sample(); }
    console.log(`RX loss: buzzer on ${(100 * beep / n).toFixed(0)} %, beacon on ${(100 * beacon / n).toFixed(0)} % of 3 s`);
    expect(beep).toBeGreaterThan(0);
  }, 120000);

  test('native blackbox: serial log on UART2 from arm to disarm, Blackbox Explorer framing', async () => {
    const r = await rig();
    r.firstBoot(['serial 1 128 115200 57600 0 2000000', 'set blackbox_device = SERIAL', 'set blackbox_sample_rate = 1/4', 'set blackbox_mode = NORMAL']);
    const chunks: Uint8Array[] = [];
    let last = 0;
    r.hooks.push((t) => { if (t - last >= 0.01) { last = t; const d = r.bf.serialRead(BF_PORT.blackbox); if (d.length) chunks.push(d); } });
    r.run(1);
    expect(chunks.length).toBe(0); // nothing logged while disarmed
    expect(r.bf.armingDisableFlags()).toBe(0);
    r.rc[4] = 1900; expect(r.run(0.3)).toBe(true);
    r.rc[2] = 1500; r.run(1.0); r.rc[2] = 1350; r.rc[0] = 1600; r.run(1.0); r.rc[0] = 1500;
    r.rc[4] = 1000; r.rc[2] = 1000; r.run(1.0);
    const total = chunks.reduce((a, c) => a + c.length, 0);
    const all = new Uint8Array(total); let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; }
    const text = dec.decode(all);
    const headerEnd = text.indexOf('\nI'); // first frame after the headers
    console.log(`blackbox: ${total} bytes for ~2.3 s armed (${(total / 2.3 / 1024).toFixed(0)} KiB/s), header ${headerEnd} bytes`);
    expect(text.startsWith('H Product:Blackbox flight data recorder by Nicholas Sherlock')).toBe(true);
    expect(text).toMatch(/H Firmware revision:Betaflight 4\.5\.5/);
    expect(text).toMatch(/H looptime:125/);
    expect(text).toMatch(/H P interval:4/);
    expect(text.includes('End of log')).toBe(true);
    expect(total).toBeGreaterThan(50_000);
  }, 120000);

  test('GPS: u-blox handshake on UART3, 3D fix from NAV-PVT, GPS rescue arming check, home point', async () => {
    const r = await rig();
    r.firstBoot(['feature GPS', 'serial 2 2 115200 115200 0 115200', 'set gps_provider = UBLOX', 'set failsafe_procedure = GPS-RESCUE']);
    const gps = new UbxReceiver({ lat: 47.3977, lon: 8.5456, altM: 488 });
    const t0 = r.time(); // the FC rebooted (save) and calibrated the accelerometer just before
    // cold start: no satellites for 4 s, a weak 6-satellite 3D fix until 8 s, then 12
    const sats = (t: number) => (t - t0 < 4 ? 0 : t - t0 < 8 ? 6 : 12);
    let last = 0, tRecv = -1, tFix = -1, blockedWeak = false;
    r.hooks.push((t) => {
      if (t - last < 0.001) return; last = t;
      gps.fromFc(r.bf.serialRead(BF_PORT.gps));
      const pos = r.quad.s.pos, vel = r.quad.s.vel;
      const out = gps.tick(t, { e: pos.x, n: pos.y, u: pos.z, ve: vel.x, vn: vel.y, vu: vel.z }, sats(t));
      if (out.length) r.bf.serialWrite(BF_PORT.gps, out);
    });
    for (let s = 0; s < 30 && (tFix < 0 || r.bf.gpsInfo()!.numSat < 12); s += 0.25) {
      r.run(0.25);
      const i = r.bf.gpsInfo()!;
      if (i.state === 5 && tRecv < 0) tRecv = r.time() - t0;
      if (i.state === 5 && i.fix && tFix < 0) tFix = r.time() - t0;
      // GPS rescue configured: no arming with fewer than gps_rescue_min_sats (8)
      if (i.numSat === 6 && i.fix) blockedWeak ||= (r.bf.armingDisableFlags() & (1 << 18)) !== 0;
    }
    r.run(0.5);
    const info = r.bf.gpsInfo()!;
    console.log(`GPS: ${gps.log.join(' ')} | receiving ${tRecv.toFixed(2)} s after the FC booted, 3D fix at ${tFix.toFixed(2)} s, ${info.numSat} sats, ${info.lat.toFixed(5)},${info.lon.toFixed(5)} alt ${info.altM.toFixed(1)} m`);
    expect(tRecv).toBeGreaterThan(0); expect(tFix).toBeGreaterThan(0);
    expect(info.numSat).toBe(12);
    expect(info.lat).toBeCloseTo(47.3977, 4); expect(info.lon).toBeCloseTo(8.5456, 4);
    expect(gps.monVerPolls).toBeGreaterThan(0);
    expect(blockedWeak).toBe(true);
    expect(r.bf.armingDisableFlags()).toBe(0);
    // arming sets the home point (needs >= gps_rescue_min_sats)
    r.rc[4] = 1900; expect(r.run(0.5)).toBe(true);
    r.rc[2] = 1500; r.run(1);
    expect(r.bf.gpsInfo()!.homeFix).toBe(true);
  }, 180000);

  test('CPU load reads like an F7 at 8 kHz; eRPM telemetry has rare corrupt frames', async () => {
    const r = await rig();
    r.firstBoot();
    r.rc[4] = 1900; r.run(0.3); r.rc[2] = 1400; r.run(2);
    const armedLoad = r.bf.cpuLoad();
    expect(r.bf.armingDisableFlags() & (1 << 11)).toBe(0); // never ARMING_DISABLED_LOAD
    r.rc[2] = 1000; r.rc[4] = 1000; r.run(1); // the CLI is only available disarmed
    const out = r.cli(['status', 'dshot_telemetry_info']);
    const cpu = +(/CPU:(\d+)%/.exec(out)?.[1] ?? -1);
    const reads = +(/Dshot reads: (\d+)/.exec(out)?.[1] ?? 0), bad = +(/Dshot invalid pkts: (\d+)/.exec(out)?.[1] ?? -1);
    console.log(`CPU ${cpu} % (armed bf_cpu_load ${armedLoad} %), DShot telemetry ${bad} invalid of ${reads} (${(1e2 * bad / reads).toFixed(3)} %)`);
    expect(cpu).toBeGreaterThan(20); expect(cpu).toBeLessThan(50);
    expect(reads).toBeGreaterThan(10000);
    expect(bad / reads).toBeGreaterThan(0.0003); expect(bad / reads).toBeLessThan(0.003);
  }, 120000);
});

// ---------------------------------------------------------------------------------------------
// Minimal u-blox M8 receiver (UBX protocol) for the GPS test. Answers MON-VER polls (hwVersion
// 00080000 = M8, so Betaflight takes the CFG-MSG / NAV-PVT path), ACKs every CFG message, honours
// CFG-RATE and sends NAV-PVT (+ NAV-SAT at 1:5 when enabled by CFG-MSG).

/** UBX frame: B5 62 class id len16 payload ckA ckB (Fletcher-8 over class..payload). */
export function ubx(cls: number, id: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  const f = new Uint8Array(8 + payload.length);
  f[0] = 0xb5; f[1] = 0x62; f[2] = cls; f[3] = id; f[4] = payload.length & 0xff; f[5] = payload.length >> 8;
  f.set(payload, 6);
  let a = 0, b = 0;
  for (let i = 2; i < 6 + payload.length; i++) { a = (a + f[i]) & 0xff; b = (b + a) & 0xff; }
  f[6 + payload.length] = a; f[7 + payload.length] = b;
  return f;
}

export function ubxMonVer(hw = '00080000', sw = 'ROM CORE 3.01 (107888)'): Uint8Array {
  const p = new Uint8Array(40);
  p.set(new TextEncoder().encode(sw).subarray(0, 29), 0);
  p.set(new TextEncoder().encode(hw).subarray(0, 9), 30);
  return ubx(0x0a, 0x04, p);
}

export interface NavPvt { iTOW: number; lat: number; lon: number; hMSLmm: number; velN: number; velE: number; velD: number; numSV: number; fix3d: boolean; hAccMm: number; vAccMm: number; sAccMms: number; pDOP: number }

export function ubxNavPvt(s: NavPvt): Uint8Array {
  const p = new DataView(new ArrayBuffer(92));
  p.setUint32(0, s.iTOW >>> 0, true);
  p.setUint16(4, 2026, true); p.setUint8(6, 10); p.setUint8(7, 21); p.setUint8(8, 12); p.setUint8(9, 0); p.setUint8(10, 0);
  p.setUint8(11, s.fix3d ? 0x07 : 0x00);            // valid: date, time, fully resolved
  p.setUint32(12, 50, true); p.setInt32(16, 0, true); // tAcc ns, nano
  p.setUint8(20, s.fix3d ? 3 : 0);                  // fixType 3 = 3D
  p.setUint8(21, s.fix3d ? 0x01 : 0x00);            // flags: gnssFixOK
  p.setUint8(22, 0); p.setUint8(23, s.numSV);
  p.setInt32(24, Math.round(s.lon * 1e7), true); p.setInt32(28, Math.round(s.lat * 1e7), true);
  p.setInt32(32, s.hMSLmm + 48000, true); p.setInt32(36, s.hMSLmm, true); // height (ellipsoid), hMSL
  p.setUint32(40, s.hAccMm, true); p.setUint32(44, s.vAccMm, true);
  p.setInt32(48, s.velN, true); p.setInt32(52, s.velE, true); p.setInt32(56, s.velD, true);
  const gSpeed = Math.round(Math.hypot(s.velN, s.velE));
  p.setInt32(60, gSpeed, true);
  p.setInt32(64, Math.round((((Math.atan2(s.velE, s.velN) * 180) / Math.PI + 360) % 360) * 1e5), true); // headMot 1e-5 deg
  p.setUint32(68, s.sAccMms, true); p.setUint32(72, 5e6, true); p.setUint16(76, s.pDOP, true);
  return ubx(0x01, 0x07, new Uint8Array(p.buffer));
}

export class UbxReceiver {
  private buf: number[] = [];
  private measMs = 1000;    // until CFG-RATE says otherwise
  private nextT = 0;
  private navSatDiv = 0;
  private navCount = 0;
  monVerPolls = 0;
  log: string[] = [];
  constructor(private origin: { lat: number; lon: number; altM: number }) {}

  /** Bytes the FC transmitted: answer polls, ACK configuration. */
  fromFc(data: Uint8Array): Uint8Array[] {
    const replies: Uint8Array[] = [];
    for (const b of data) this.buf.push(b);
    for (;;) {
      const i = this.buf.indexOf(0xb5);
      if (i < 0) { this.buf.length = 0; break; }
      if (i > 0) this.buf.splice(0, i);     // NMEA / $PUBX text and noise
      if (this.buf.length < 8) break;
      if (this.buf[1] !== 0x62) { this.buf.shift(); continue; }
      const len = this.buf[4] | (this.buf[5] << 8);
      if (this.buf.length < 8 + len) break;
      const cls = this.buf[2], id = this.buf[3], payload = this.buf.slice(6, 6 + len);
      this.buf.splice(0, 8 + len);
      if (cls === 0x0a && id === 0x04 && len === 0) { this.monVerPolls++; this.pending.push(ubxMonVer()); this.note('MON-VER?'); continue; }
      if (cls === 0x06) {
        if (id === 0x08 && len >= 2) { this.measMs = payload[0] | (payload[1] << 8); this.note(`CFG-RATE ${this.measMs}ms`); }
        if (id === 0x01 && len >= 3 && payload[0] === 0x01 && payload[1] === 0x35) this.navSatDiv = payload[2];
        if (id === 0x01) this.note(`CFG-MSG ${payload[0].toString(16)}-${payload[1].toString(16)}:${payload[2]}`); else if (id !== 0x08) this.note(`CFG-${id.toString(16)}`);
        this.pending.push(ubx(0x05, 0x01, new Uint8Array([cls, id]))); // ACK-ACK
      }
    }
    return replies;
  }
  private pending: Uint8Array[] = [];
  private note(s: string) { if (this.log.length < 40 && this.log[this.log.length - 1] !== s) this.log.push(s); }

  /** Called often; returns bytes to send to the FC (replies + navigation solutions due by now). */
  tick(t: number, enu: { e: number; n: number; u: number; ve: number; vn: number; vu: number }, numSV: number): Uint8Array {
    const out = this.pending.splice(0);
    if (t >= this.nextT) {
      this.nextT = t + this.measMs / 1000;
      const mPerDegLat = 111320, mPerDegLon = 111320 * Math.cos((this.origin.lat * Math.PI) / 180);
      const fix = numSV >= 4;
      out.push(ubxNavPvt({
        iTOW: Math.round(t * 1000) % 604800000, lat: this.origin.lat + enu.n / mPerDegLat, lon: this.origin.lon + enu.e / mPerDegLon,
        hMSLmm: Math.round((this.origin.altM + enu.u) * 1000), velN: Math.round(enu.vn * 1000), velE: Math.round(enu.ve * 1000), velD: Math.round(-enu.vu * 1000),
        numSV, fix3d: fix, hAccMm: fix ? 1500 : 99999, vAccMm: fix ? 2500 : 99999, sAccMms: fix ? 300 : 9999, pDOP: fix ? 140 : 9999,
      }));
      if (this.navSatDiv && ++this.navCount % this.navSatDiv === 0) {
        const p = new Uint8Array(8 + 12 * numSV); p[5] = numSV; p[4] = 1;
        for (let k = 0; k < numSV; k++) { p[8 + 12 * k] = 0; p[9 + 12 * k] = k + 1; p[10 + 12 * k] = 40; p[16 + 12 * k] = 0x0f; }
        out.push(ubx(0x01, 0x35, p));
      }
    }
    if (!out.length) return new Uint8Array(0);
    const n = out.reduce((a, c) => a + c.length, 0), all = new Uint8Array(n);
    let o = 0; for (const c of out) { all.set(c, o); o += c.length; }
    return all;
  }
}
