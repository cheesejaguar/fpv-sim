#!/usr/bin/env node
// Re-simulate a reproducible run (.fpvrun, recorded in Settings → Research) headless, exactly as it
// was flown, and write the full state as CSV.
//
//   npm run resim -- flight.fpvrun [--csv out.csv] [--hz 1000]
//
// The CSV has one row per 1/hz s of sim time (default 1000, the most): time, position, velocity,
// attitude quaternion, body rates, the gyro as Betaflight read it, specific force, motor speeds and
// commands, battery, the sticks Betaflight received, armed. A replay on another firmware build or
// simulator version can diverge: the script says where, and exits with status 3.
import { readFileSync, writeFileSync } from 'node:fs';
import { loadTs } from './lib/load-ts.mjs';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--') && !/^\d+$/.test(a));
if (!file || args.includes('--help')) { console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 11).map((l) => l.replace(/^\/\/ ?/, '')).join('\n')); process.exit(file ? 0 : 1); }
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const csvPath = opt('--csv', file.replace(/\.fpvrun$/, '') + '.csv');
const hz = Math.max(1, Math.min(1000, Number(opt('--hz', 1000))));

const { mods, close } = await loadTs('src/headless/node.ts', 'src/headless/replay.ts', 'src/worker/runLog.ts');
const [{ installNodeHost, nodeFirmware }, { replayRun }, { decodeRun }] = mods;
installNodeHost();
const run = await decodeRun(new Uint8Array(readFileSync(file)));
console.error(`${file}: ${run.app}, ${run.firmware}, seed ${run.seed}, ${run.mapId}${run.courseId ? '/' + run.courseId : ''}, ${run.spec.name}, ${(run.steps / run.settings.physicsHz).toFixed(1)} s, ${run.packetSteps.length} RC packets, ended: ${run.end}`);
const cols = ['t', 'px', 'py', 'pz', 'vx', 'vy', 'vz', 'qw', 'qx', 'qy', 'qz', 'wx', 'wy', 'wz', 'gyro_x', 'gyro_y', 'gyro_z', 'acc_x', 'acc_y', 'acc_z',
  'rpm0', 'rpm1', 'rpm2', 'rpm3', 'motor0', 'motor1', 'motor2', 'motor3', 'vbus', 'ibus', 'soc', 'rc_roll', 'rc_pitch', 'rc_throttle', 'rc_yaw', 'armed'];
const rows = [cols.join(',')];
let n = 0, t0 = NaN;
const every = Math.round(1000 / hz);
const t = performance.now();
const res = await replayRun(run, await nodeFirmware(), {
  record: (c) => {
    if (Number.isNaN(t0)) t0 = c.simT;
    if (n++ % every) return;
    const s = c.quad.s, g = c.quad.imu.gyroOut, a = c.quad.imu.accOut, b = c.quad.battery.s;
    rows.push([c.simT - t0, s.pos.x, s.pos.y, s.pos.z, s.vel.x, s.vel.y, s.vel.z, s.q.w, s.q.x, s.q.y, s.q.z, s.w.x, s.w.y, s.w.z, g.x, g.y, g.z, a.x, a.y, a.z,
      ...c.quad.motors.map((m) => m.rpm()), ...c.motorCmd, s.vbus, s.ibus, b.soc, c.rcBuf[0], c.rcBuf[1], c.rcBuf[2], c.rcBuf[3], c.armed ? 1 : 0].map((x) => +x.toPrecision(9)).join(','));
  },
});
writeFileSync(csvPath, rows.join('\n') + '\n');
console.error(`re-simulated ${res.seconds.toFixed(2)} s in ${((performance.now() - t) / 1000).toFixed(1)} s -> ${csvPath} (${rows.length - 1} rows)`);
await close();
if (res.diverged) {
  console.error(`DIVERGED at physics step ${res.diverged.step} (RC packet ${res.diverged.packet} was recorded in step ${res.diverged.recordedStep}): another firmware build or simulator version than the recording's`);
  process.exit(3);
}
