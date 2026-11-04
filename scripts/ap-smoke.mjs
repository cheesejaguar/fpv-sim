#!/usr/bin/env node
// Smoke test of the ArduPilot WebAssembly build (bash firmware/apwasm/build.sh): boots ArduPlane or
// ArduCopter in this Node process against a vehicle standing still on the ground, and listens to
// its MAVLink on SERIAL0 (sim:js:0) until it reports a heartbeat and a few seconds of sim time pass.
//
//   node scripts/ap-smoke.mjs [plane|copter] [seconds]
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const vehicle = process.argv[2] ?? 'plane', simSeconds = Number(process.argv[3] ?? 20);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { default: createArduPilot } = await import(pathToFileURL(path.join(root, `public/ap/ardu${vehicle}.mjs`)).href);

const RATE = 1000;               // physics frames per second answered to ArduPilot
let t = 0, frames = 0, lastFrame = -1, servos = [];
const toAp = [], heard = { heartbeat: 0, statustext: [], bytes: 0 };
const t0 = performance.now();

/** One MAVLink v2 message parser, just enough for HEARTBEAT (0) and STATUSTEXT (253). */
let rx = [];
function feed(bytes) {
  for (const b of bytes) rx.push(b);
  while (rx.length >= 12) {
    const i = rx.findIndex((b) => b === 0xfd || b === 0xfe);
    if (i < 0) { rx = []; return; }
    if (i > 0) rx.splice(0, i);
    const v2 = rx[0] === 0xfd, len = rx[1], head = v2 ? 10 : 6, total = head + len + 2 + (v2 && rx[2] & 1 ? 13 : 0);
    if (rx.length < total) return;
    const id = v2 ? rx[7] | (rx[8] << 8) | (rx[9] << 16) : rx[5], payload = rx.slice(head, head + len);
    if (id === 0) heard.heartbeat++;
    if (id === 253) heard.statustext.push(String.fromCharCode(...payload.slice(1, 51)).replace(/\0.*$/s, ''));
    rx.splice(0, total);
  }
}

const state = () => JSON.stringify({
  timestamp: t,
  imu: { gyro: [0, 0, 0], accel_body: [0, 0, -9.80665] },
  position: [0, 0, 0], quaternion: [1, 0, 0, 0], velocity: [0, 0, 0],
  rc: { rc_1: 1500, rc_2: 1500, rc_3: 1000, rc_4: 1500, rc_5: 1000, rc_6: 1000, rc_7: 1000, rc_8: 1000 },
});

const Module = await createArduPilot({
  print: (s) => { if (process.env.AP_VERBOSE || /error|fail|panic/i.test(s)) console.log(`[ap] ${s}`); },
  printErr: (s) => console.log(`[ap!] ${s}`),
  fpvsim: {
    servoOut(heap, p, n) {
      const dv = new DataView(heap.buffer, p, n);
      const frame = dv.getUint32(4, true);
      if (frame !== lastFrame) { lastFrame = frame; t += 1 / RATE; frames++; }
      servos = []; for (let k = 0; k < (n - 8) / 2; k++) servos.push(dv.getUint16(8 + 2 * k, true));
      return n;
    },
    stateIn(heap, p, max) {
      const line = new TextEncoder().encode(`\n${state()}\n`);
      if (line.length > max) return 0;
      heap.set(line, p);
      if (t >= simSeconds) finish();
      return line.length;
    },
    portRead(ch, heap, p, max) { if (ch !== 0 || !toAp.length) return 0; const b = toAp.splice(0, max); heap.set(b, p); return b.length; },
    portWrite(ch, heap, p, n) { if (ch === 0) { heard.bytes += n; feed(heap.slice(p, p + n)); } return n; },
  },
});

function finish() {
  const wall = (performance.now() - t0) / 1000;
  console.log(`Ardu${vehicle}: ${t.toFixed(1)} s simulated in ${wall.toFixed(1)} s (${(t / wall).toFixed(1)}x), ${frames} frames`);
  console.log(`MAVLink: ${heard.bytes} bytes, ${heard.heartbeat} heartbeats`);
  for (const s of heard.statustext.slice(0, 25)) console.log(`  STATUSTEXT ${s}`);
  console.log(`servos: ${servos.slice(0, 8).join(' ')}`);
  process.exit(heard.heartbeat > 0 ? 0 : 1);
}

Module.FS.mkdirTree('/sitl/scripts');
Module.FS.chdir('/sitl');
// a Lua script (ArduPilot runs it in its own thread): proves scripting and the file system work
const lua = process.env.AP_LUA !== '0';
if (lua) {
  Module.FS.writeFile('/sitl/fpv.parm', 'SCR_ENABLE 1\nSCR_HEAP_SIZE 200000\n');
  Module.FS.writeFile('/sitl/scripts/hello.lua', 'local n = 0\nfunction update()\n  n = n + 1\n  gcs:send_text(6, string.format("fpv-sim lua %d", n))\n  return update, 2000\nend\nreturn update, 2000\n');
}
Module.callMain([
  '--model', 'JSON', '--speedup', process.env.AP_SPEEDUP ?? '100', '-w',
  '--home', '-35.363261,149.165230,584,353',
  '--defaults', [...(vehicle === 'plane' ? ['@ROMFS/models/plane.parm'] : []), ...(lua ? ['/sitl/fpv.parm'] : [])].join(',') || '/dev/null',
  '--serial0', 'sim:js:0', '--serial1', 'none', '--serial2', 'none',
  '--serial5', 'none', '--serial6', 'none', '--serial7', 'none', '--serial8', 'none',
]);
