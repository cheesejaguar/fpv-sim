// Firmware realism features of the Betaflight WASM build: accelerometer calibration, yaw spin
// recovery, virtual gyro ODR (BMI270 3.2 kHz), beeper / DShot beacon, native serial blackbox,
// u-blox GPS, CPU load, eRPM telemetry errors. Skipped when the firmware hasn't been built.
// GPS runs against the worker's own u-blox receiver emulator (src/worker/ubxGps.ts).
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
import { UbxReceiver } from '../src/worker/ubxGps';

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
    const gps = new UbxReceiver({ lat: 47.3977, lon: 8.5456, altM: 488 }); // the worker's receiver (1.5 m CEP)
    const t0 = r.time(); // the FC rebooted (save) and calibrated the accelerometer just before
    // cold start: no satellites for 4 s, a weak 6-satellite 3D fix until 8 s, then 12
    const sats = (t: number) => (t - t0 < 4 ? 0 : t - t0 < 8 ? 6 : 12);
    let last = 0, tRecv = -1, tFix = -1, blockedWeak = false;
    r.hooks.push((t) => {
      if (t - last < 0.001) return; last = t;
      gps.fromFc(r.bf.serialRead(BF_PORT.gps));
      const pos = r.quad.s.pos, vel = r.quad.s.vel;
      const out = gps.tick(t, { e: pos.x, n: pos.y, u: pos.z, ve: vel.x, vn: vel.y, vu: vel.z }, undefined, sats(t));
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
