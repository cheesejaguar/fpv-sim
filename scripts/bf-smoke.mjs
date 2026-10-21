#!/usr/bin/env node
// Smoke test for the Betaflight 4.5.5 WebAssembly build (public/bf/betaflight.{mjs,wasm}).
//
//   node scripts/bf-smoke.mjs
//
// Plain Node 22 ESM, no dependencies. Boots the firmware, talks CLI over the
// in-memory UART1, configures + saves (surviving the firmware reboot), checks
// the accelerometer/attitude sign convention, arms with bidirectional DShot
// telemetry, checks the PID reacts against injected body rates (validates the
// axis conventions end to end), prints the OSD, and measures bf_step speed.

import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const modUrl = new URL('../public/bf/betaflight.mjs', import.meta.url);
const { default: createBetaflight } = await import(modUrl.href);

const G = 9.80665;
const DEG = Math.PI / 180;
const DT_US = 125; // 8 kHz lock-step

let failures = 0;
function check(cond, what) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${what}`);
  if (!cond) failures++;
  return cond;
}
function section(t) { console.log(`\n=== ${t}`); }

const bf = await createBetaflight({
  print: (s) => console.log(`[fw] ${s}`),
  printErr: (s) => console.log(`[fw!] ${s}`),
});

// ---- scratch buffers (allocated before bf_init) -----------------------------
const rcPtr = bf._malloc(16 * 2);
const motorPtr = bf._malloc(4 * 2);
const erpmPtr = bf._malloc(4 * 4);
const attPtr = bf._malloc(3 * 4);
const dbgPtr = bf._malloc(8 * 2);
const ioPtr = bf._malloc(4096);

// ---- simulated world (deliberately trivial; this is not a physics test) -----
const sim = {
  rc: new Uint16Array(16).fill(1500),
  gyro: [0, 0, 0],                 // FRD p,q,r  rad/s
  acc: [0, 0, -G],                 // FRD specific force m/s^2 (level, at rest)
  volts: 16.8, amps: 0.4, mah: 0,
  erpm: [0, 0, 0, 0],
};
sim.rc[2] = 1000;                  // throttle low
sim.rc[4] = 1000;                  // AUX1 low (disarmed)

function motors() {
  bf._bf_get_motors(motorPtr);
  return Array.from(bf.HEAPU16.subarray(motorPtr >> 1, (motorPtr >> 1) + 4));
}

// crude ESC model: DShot 48..2047 -> 0..32000 mechanical rpm, 14 pole motor
function updateErpm() {
  const m = motors();
  for (let i = 0; i < 4; i++) {
    const t = m[i] >= 48 ? (m[i] - 48) / 1999 : 0;
    sim.erpm[i] = t * 32000 * 7;
  }
  bf.HEAPF32.set(sim.erpm, erpmPtr >> 2);
  bf._bf_set_erpm(erpmPtr);
}

let stepCount = 0;
function step(n = 1) {
  for (let i = 0; i < n; i++) {
    if (stepCount % 40 === 0) {          // 200 Hz RC frames
      bf.HEAPU16.set(sim.rc, rcPtr >> 1);
      bf._bf_set_rc(rcPtr);
    }
    if (stepCount % 80 === 0) {          // 100 Hz battery
      bf._bf_set_battery(sim.volts, sim.amps, sim.mah);
    }
    bf._bf_set_gyro_acc(sim.gyro[0], sim.gyro[1], sim.gyro[2], sim.acc[0], sim.acc[1], sim.acc[2]);
    updateErpm();
    bf._bf_step(DT_US);
    stepCount++;
  }
}
const stepMs = (ms) => step(Math.round(ms * 1000 / DT_US));

function serialRead() {
  let s = '';
  for (;;) {
    const n = bf._bf_serial_read(0, ioPtr, 4096);
    if (!n) break;
    s += Buffer.from(bf.HEAPU8.subarray(ioPtr, ioPtr + n)).toString('latin1');
  }
  return s;
}
function serialWrite(s) {
  const b = Buffer.from(s, 'latin1');
  bf.HEAPU8.set(b, ioPtr);
  return bf._bf_serial_write(0, ioPtr, b.length);
}
// send a CLI line, run the firmware until the reply goes quiet
function cli(cmd, { maxMs = 2000, quietMs = 60 } = {}) {
  serialWrite(cmd + '\n');
  let out = '';
  let quiet = 0;
  for (let t = 0; t < maxMs; t += 10) {
    stepMs(10);
    const s = serialRead();
    out += s;
    quiet = s.length ? 0 : quiet + 10;
    if (out.length && quiet >= quietMs) break;
  }
  return out;
}
function show(out) {
  console.log(out.replace(/\r/g, '').split('\n').map((l) => '    | ' + l).join('\n'));
}

function attitude() {
  bf._bf_get_attitude(attPtr);
  return Array.from(bf.HEAPF32.subarray(attPtr >> 2, (attPtr >> 2) + 3));
}

const ARMING_FLAG_NAMES = ['NOGYRO', 'FAILSAFE', 'RXLOSS', 'NOT_DISARMED', 'BOXFAILSAFE', 'RUNAWAY',
  'CRASH', 'THROTTLE', 'ANGLE', 'BOOTGRACE', 'NOPREARM', 'LOAD', 'CALIB', 'CLI', 'CMS', 'BST', 'MSP',
  'PARALYZE', 'GPS', 'RESC', 'DSHOT_TELEM', 'REBOOT_REQD', 'DSHOT_BBANG', 'NO_ACC_CAL', 'MOTOR_PROTO', 'ARMSWITCH'];
function armingFlags() {
  const f = bf._bf_arming_disable_flags() >>> 0;
  const names = ARMING_FLAG_NAMES.filter((_, i) => f & (1 << i));
  return { f, names: names.join(' ') || '(none)' };
}

// ============================================================================
section('boot');
bf.HEAPU16.set(sim.rc, rcPtr >> 1);
bf._bf_set_rc(rcPtr);
bf._bf_set_battery(sim.volts, sim.amps, sim.mah);
bf._bf_set_gyro_acc(0, 0, 0, 0, 0, -G);
bf._bf_set_baro(101325);
const initRc = bf._bf_init();
check(initRc === 0, `bf_init() returned ${initRc}`);
console.log(`      eeprom ${bf._bf_eeprom_size()} bytes, gyro period ${bf._bf_gyro_period_us()} us, boot #${bf._bf_boot_count()}`);
stepMs(2000);

section('CLI');
let out = cli('#');
show(out);
check(out.includes('Entering CLI Mode'), 'CLI entered via "#"');
out = cli('status');
show(out);
check(out.includes('GYRO=VIRTUAL'), 'status reports the virtual gyro');
out = cli('get pid_process_denom');
show(out);
check(/pid_process_denom = \d+/.test(out), 'get pid_process_denom answers');

section('configure + save');
const vbatPos = 2048 | (12 << 5) | 1;   // OSD_PROFILE_1_FLAG | y=12 | x=1
const cmds = [
  'mixer QUADX',
  'set motor_pwm_protocol = DSHOT600',
  'set dshot_bidir = ON',
  'set motor_poles = 14',
  'aux 0 0 0 1700 2100 0 0',          // ARM on AUX1 (1700..2100)
  'aux 1 35 1 1700 2100 0 0',         // FLIP OVER AFTER CRASH (turtle) on AUX2
  'feature OSD',
  'set vcd_video_system = PAL',
  `set osd_vbat_pos = ${vbatPos}`,
  `set osd_warnings_pos = ${2048 | (10 << 5) | 9}`,
  `set osd_flymode_pos = ${2048 | (13 << 5) | 1}`,
  `set osd_mah_drawn_pos = ${2048 | (12 << 5) | 23}`,
  `set osd_craft_name_pos = ${2048 | (1 << 5) | 11}`,
  'set craft_name = WASMQUAD',
];
for (const c of cmds) {
  out = cli(c);
  const ok = !/Invalid|ERROR|error|Parse/i.test(out);
  check(ok, `cli: ${c}`);
  if (!ok) show(out);
}
const bootsBefore = bf._bf_boot_count();
out = cli('save', { maxMs: 3000 });
show(out);
stepMs(1500);
check(bf._bf_boot_count() === bootsBefore + 1, `firmware rebooted after save (boot #${bf._bf_boot_count()})`);
check(bf._bf_eeprom_dirty() === 1, 'bf_eeprom_dirty() reports the saved config');
check(bf._bf_eeprom_dirty() === 0, 'bf_eeprom_dirty() clears after reading');
serialRead();
stepMs(500);
out = cli('#');
out = cli('get motor_pwm_protocol');
check(/motor_pwm_protocol = DSHOT600/.test(out), 'motor_pwm_protocol = DSHOT600 survived the reboot');
out = cli('get dshot_bidir');
check(/dshot_bidir = ON/.test(out), 'dshot_bidir = ON survived the reboot');
out = cli('aux');
check(/aux 0 0 0 1700 2100/.test(out), 'aux ARM range survived the reboot');
out = cli('exit', { maxMs: 3000 });   // 'exit' reboots as well
stepMs(2500);
check(bf._bf_boot_count() === bootsBefore + 2, `"exit" rebooted the firmware (boot #${bf._bf_boot_count()})`);
serialRead();

section('accelerometer / attitude convention (disarmed)');
{
  const tilt = (rollDeg, pitchDeg) => {
    // FRD specific force for a static vehicle at roll/pitch (right wing down /
    // nose up positive): f = -g * (down vector in body frame)
    const r = rollDeg * DEG, p = pitchDeg * DEG;
    sim.acc = [G * Math.sin(p), -G * Math.sin(r) * Math.cos(p), -G * Math.cos(r) * Math.cos(p)];
  };
  tilt(20, 0); stepMs(4000);
  let a = attitude();
  console.log(`      acc says roll 20 deg right-wing-down -> attitude roll=${a[0].toFixed(1)} pitch=${a[1].toFixed(1)}`);
  check(Math.abs(a[0] - 20) < 3 && Math.abs(a[1]) < 3, 'roll attitude follows a right-wing-down tilt (+)');
  tilt(0, 15); stepMs(4000);
  a = attitude();
  console.log(`      acc says pitch 15 deg nose-up        -> attitude roll=${a[0].toFixed(1)} pitch=${a[1].toFixed(1)}`);
  check(Math.abs(a[1] - 15) < 3 && Math.abs(a[0]) < 3, 'pitch attitude follows a nose-up tilt (+)');
  tilt(0, 0); stepMs(5000);
  a = attitude();
  console.log(`      level                                 -> attitude roll=${a[0].toFixed(1)} pitch=${a[1].toFixed(1)}`);
  // gyro integration: +p (right wing down) for 0.5 s at 40 deg/s with a level acc
  // reading is a conflicting input, so look at the immediate direction only
  sim.gyro = [40 * DEG, 0, 0]; stepMs(250); sim.gyro = [0, 0, 0];
  const a2 = attitude();
  console.log(`      +p 40 deg/s for 0.25 s                -> attitude roll=${a2[0].toFixed(1)}`);
  check(a2[0] > a[0] + 5, 'gyro +p integrates to a right-wing-down roll');
  stepMs(5000);
  const h0 = attitude()[2];
  sim.gyro = [0, 0, 45 * DEG]; stepMs(1000); sim.gyro = [0, 0, 0];
  const h1 = attitude()[2];
  const dh = ((h1 - h0 + 540) % 360) - 180;
  console.log(`      +r 45 deg/s for 1 s (nose right)      -> heading ${h0.toFixed(1)} -> ${h1.toFixed(1)} (${dh.toFixed(1)})`);
  check(Math.abs(dh - 45) < 3, 'gyro +r turns the heading clockwise (+)');
}

section('arming');
stepMs(1000);
let af = armingFlags();
console.log(`      disarmed, AUX1 low: arming disable flags = 0x${af.f.toString(16)} ${af.names}`);
sim.rc[4] = 1800;  // AUX1 high -> ARM
stepMs(300);
af = armingFlags();
const armed = bf._bf_get_motors(motorPtr) === 1;
console.log(`      AUX1 high: armed=${armed} flags=0x${af.f.toString(16)} ${af.names}`);
check(armed, 'armed with throttle low + AUX1 high');
check(af.f === 0, 'arming_disable_flags == 0 while armed');
stepMs(500);
const idle = motors();
console.log(`      idle motor outputs (DShot): ${idle.join(' ')}  (motor reversed=${bf._bf_get_motor_reversed()})`);
check(idle.every((v) => v >= 48 && v < 400), 'motors at idle (48 <= DShot < 400)');

section('PID direction (validates the gyro sign convention)');
{
  sim.rc[2] = 1400;              // some throttle so the mixer has room
  stepMs(500);
  const base = motors();
  const probe = (label, gyro, expectUp, expectDown) => {
    sim.gyro = gyro;
    stepMs(30);
    const m = motors();
    sim.gyro = [0, 0, 0];
    stepMs(400);
    const d = m.map((v, i) => v - base[i]);
    const up = [0, 1, 2, 3].filter((i) => d[i] > 0).map((i) => `M${i + 1}`);
    console.log(`      ${label}: motors ${m.join(' ')}  delta ${d.map((x) => (x > 0 ? '+' : '') + x).join(' ')}  -> up: ${up.join(',')}`);
    const ok = expectUp.every((i) => d[i - 1] > 0) && expectDown.every((i) => d[i - 1] < 0);
    check(ok, `${label}: expected M${expectUp.join('+M')} up, M${expectDown.join('+M')} down`);
  };
  console.log(`      baseline motors ${base.join(' ')}   (QuadX: M1 rear-right, M2 front-right, M3 rear-left, M4 front-left)`);
  // +p = rolling right (right wing down): PID must roll left -> right motors up
  probe('+roll rate  (right wing down)', [100 * DEG, 0, 0], [1, 2], [3, 4]);
  // +q = nose up: PID must pitch nose down -> rear motors up
  probe('+pitch rate (nose up)        ', [0, 100 * DEG, 0], [1, 3], [2, 4]);
  // +r = nose right: PID must yaw left -> the CW props (M1, M4, props-in default) speed up
  probe('+yaw rate   (nose right)     ', [0, 0, 100 * DEG], [1, 4], [2, 3]);
  sim.rc[2] = 1000;
  stepMs(300);
}

section('throughput');
{
  const N = 80000;   // 10 s of firmware time at 8 kHz
  const t0 = performance.now();
  for (let i = 0; i < N; i++) {
    if (i % 40 === 0) { bf.HEAPU16.set(sim.rc, rcPtr >> 1); bf._bf_set_rc(rcPtr); }
    bf._bf_set_gyro_acc(0.01, -0.02, 0.005, 0.1, 0.05, -G);
    bf._bf_set_erpm(erpmPtr);
    bf._bf_step(DT_US);
  }
  const dt = (performance.now() - t0) / 1000;
  const sps = N / dt;
  console.log(`      armed: ${N} x bf_step(125us) in ${dt.toFixed(2)} s = ${Math.round(sps).toLocaleString()} steps/s (${(sps / 8000).toFixed(1)}x real time)`);
  check(sps > 8000, 'faster than real time at 8 kHz');
}

section('crash flip (turtle)');
{
  sim.rc[4] = 1000; stepMs(500);              // disarm
  check(bf._bf_get_motors(motorPtr) === 0, 'disarmed');
  sim.rc[5] = 1800; stepMs(300);              // AUX2 high: flip over after crash
  sim.rc[4] = 1800; stepMs(800);              // arm in turtle mode
  const rev = bf._bf_get_motor_reversed();
  af = armingFlags();
  console.log(`      armed=${bf._bf_get_motors(motorPtr)} reversed=${rev} flags=${af.names}`);
  check(rev === 1, 'bf_get_motor_reversed() == 1 in crash flip mode');
  sim.rc[4] = 1000; stepMs(300);
  sim.rc[5] = 1000; stepMs(1500);
  console.log(`      after disarm: reversed=${bf._bf_get_motor_reversed()}`);
  check(bf._bf_get_motor_reversed() === 0, 'spin direction back to normal after disarm');
}

section('OSD');
{
  stepMs(1000);
  const cols = bf._bf_osd_cols(), rows = bf._bf_osd_rows();
  const chars = bf.HEAPU8.subarray(bf._bf_osd_chars(), bf._bf_osd_chars() + cols * rows);
  console.log(`      ${cols}x${rows}, frame #${bf._bf_osd_frame()}`);
  const lines = [];
  for (let y = 0; y < rows; y++) {
    let l = '';
    for (let x = 0; x < cols; x++) {
      const c = chars[y * cols + x];
      l += c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : (c === 0 ? ' ' : '·');
    }
    lines.push(l);
  }
  console.log('      +' + '-'.repeat(cols) + '+');
  for (const l of lines) console.log('      |' + l + '|');
  console.log('      +' + '-'.repeat(cols) + '+');
  const text = lines.join('\n');
  check(bf._bf_osd_frame() > 0, 'OSD frames are being drawn');
  check(text.includes('WASMQUAD'), 'craft name visible on the OSD');
  check(/\d+\.\d+/.test(text), 'battery voltage visible on the OSD');
}

section('EEPROM persistence across module instances');
{
  // what the host does: keep the 32 KB image, hand it to a fresh instance
  const image = bf.HEAPU8.slice(bf._bf_eeprom_ptr(), bf._bf_eeprom_ptr() + bf._bf_eeprom_size());
  const bf2 = await createBetaflight({ print: () => {}, printErr: () => {} });
  bf2.HEAPU8.set(image, bf2._bf_eeprom_ptr());
  bf2._bf_eeprom_loaded(1);
  bf2._bf_set_gyro_acc(0, 0, 0, 0, 0, -G);
  check(bf2._bf_init() === 0, 'second instance boots from the saved image');
  check(bf2._bf_eeprom_dirty() === 0, 'loaded image is not dirty');
  const io2 = bf2._malloc(4096);
  const cli2 = (cmd) => {
    const b = Buffer.from(cmd + '\n', 'latin1');
    bf2.HEAPU8.set(b, io2);
    bf2._bf_serial_write(0, io2, b.length);
    for (let i = 0; i < 2400; i++) bf2._bf_step(DT_US);
    let s = '';
    for (let n; (n = bf2._bf_serial_read(0, io2, 4096));) s += Buffer.from(bf2.HEAPU8.subarray(io2, io2 + n)).toString('latin1');
    return s;
  };
  cli2('#');
  check(/craft_name = WASMQUAD/.test(cli2('get craft_name')), 'craft_name restored from the image');
  check(/dshot_bidir = ON/.test(cli2('get dshot_bidir')), 'dshot_bidir restored from the image');
  // power cycle the same instance: bf_init() again keeps a loaded image
  const boots = bf2._bf_boot_count();
  check(bf2._bf_init() === 0 && bf2._bf_boot_count() === boots + 1, 'bf_init() again = power cycle');
  cli2('#');
  check(/craft_name = WASMQUAD/.test(cli2('get craft_name')), 'config kept across the power cycle');
}

console.log(`\n${failures ? `FAILED: ${failures} check(s)` : 'ALL CHECKS PASSED'}`);
process.exitCode = failures ? 1 : 0;
