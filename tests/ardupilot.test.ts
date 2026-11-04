// ArduPilot in the loop: the real ArduPlane / ArduCopter (WebAssembly, firmware/apwasm) flying the
// simulated vehicles through the flight core, lock-stepped over shared memory, in a Node worker
// thread. Skipped when the firmware has not been built (bash firmware/apwasm/build.sh).
import { describe, expect, test } from 'vitest';
import { apModuleFile, nodeSpawn } from '../src/ap/apNode';
import { DEFAULT_SPEC, DroneSpec, PRESETS } from '../src/builder/derive';
import { MAPS } from '../src/maps/maps';
import { FlightCore } from '../src/worker/flightCore';
import { DEFAULT_SETTINGS } from '../src/worker/shared';

const HAVE = !!apModuleFile('plane') && !!apModuleFile('copter');
const PLANE = PRESETS.find((p) => p.name.includes('Talon'))!;

/** A flight core on the field map with ArduPilot and calm air; rc: the sticks every packet sends (us). */
function rig(spec: DroneSpec, physicsHz = 2000) {
  const rc = new Float32Array(16).fill(1500);
  rc[2] = 1000; rc[4] = 1000; rc[5] = 1500; // throttle low, disarmed, AUX2 mid
  const logs: string[] = [];
  const core = new FlightCore({ sticks: (out) => out.set(rc), log: (t) => logs.push(t) }, {
    seed: 7, ardupilot: { spawn: nodeSpawn, moduleUrl: (v) => apModuleFile(v), waitMs: 2000 },
  });
  core.settings = { ...DEFAULT_SETTINGS, mapId: 'field', physicsHz, wind: { speed: 0, direction: 0, turbulence: 0, gusts: 0 }, damage: false };
  core.spec = spec;
  // (the field's spawn heading: open air for the first ~100 m, a tree line after)
  const m = MAPS.field();
  core.setMap(m);
  core.buildQuad();
  const ap = core.startArduPilot()!;
  const dt = 1 / core.settings.physicsHz;
  const run = (s: number, each?: () => void) => { for (let i = 0, n = Math.round(s / dt); i < n; i++) { core.physicsStep(dt); each?.(); } };
  /** run until ArduPilot answers frames (its module and threads load first, outside sim time) */
  const boot = async () => {
    for (let i = 0; i < 400 && !ap.live; i++) { run(0.01); if (!ap.live) await new Promise((r) => setTimeout(r, 25)); }
    expect(ap.live, logs.slice(-5).join('\n')).toBe(true);
  };
  return { core, ap, rc, logs, run, boot };
}

describe.skipIf(!HAVE)('ArduPilot in the loop', () => {
  test('ArduPlane: boots, arms on AUX1, holds FBWA, and the hand launch climbs away', async () => {
    const { core, ap, rc, logs, run, boot } = rig(PLANE);
    try {
      await boot();
      // GPS lock and the EKF settle on the hand (sim time)
      run(12);
      expect(ap.hub.tel.connected, logs.slice(-8).join('\n')).toBe(true);
      expect(ap.hub.tel.modeName, logs.filter((l) => l.startsWith('ArduPilot')).join('\n')).toBe('FBWA');
      expect(core.hand && !core.hand.released).toBe(true);
      // the estimator sees the attitude the hand holds: wings level, nose 8 degrees up
      expect(Math.abs(ap.hub.tel.roll)).toBeLessThan(0.03);
      expect(Math.abs(ap.hub.tel.pitch - 0.14)).toBeLessThan(0.03);
      rc[4] = 2000; // arm
      run(1.5);
      expect(ap.hub.tel.armed, logs.slice(-8).join('\n')).toBe(true);
      rc[2] = 2000; // full throttle: the motor runs up, the pilot throws
      run(1);
      expect(core.hand!.released, logs.slice(-8).join('\n')).toBe(true);
      const z0 = core.quad.s.pos.z;
      let maxRoll = 0;
      run(3.5, () => {
        const q = core.quad.s.q; maxRoll = Math.max(maxRoll, Math.abs(Math.atan2(2 * (q.w * q.x + q.y * q.z), 1 - 2 * (q.x * q.x + q.y * q.y)))); });
      const s = core.quad.s;
      expect(s.pos.z - z0, 'climbed').toBeGreaterThan(1.5);
      expect(s.vel.z, 'climbing').toBeGreaterThan(1);
      expect(Math.hypot(s.vel.x, s.vel.y), 'flying speed').toBeGreaterThan(20);
      expect(maxRoll, 'FBWA holds the wings level').toBeLessThan(0.5);
      expect(s.crashed).toBe(false);
      expect(ap.stalls).toBe(0);
    } finally { core.stopArduPilot(); }
  }, 180_000);

  test('ArduCopter on the 5" quad: arms and climbs in STABILIZE', async () => {
    // a Lua script in the build: it runs on ArduPilot and reports the motors' spool state
    const lua = 'function u()\n  gcs:send_text(6, string.format("fpv lua spool %d", motors:get_spool_state()))\n  return u, 500\nend\nreturn u, 500\n';
    const { core, ap, rc, logs, run, boot } = rig({ ...DEFAULT_SPEC, autopilot: 'ardupilot', apScripts: { 'spool.lua': lua } }, 8000);
    try {
      await boot();
      run(8);
      expect(ap.hub.tel.connected, logs.slice(-8).join('\n')).toBe(true);
      expect(ap.hub.tel.modeName).toBe('STABILIZE');
      rc[4] = 2000;
      run(1.5);
      expect(ap.hub.tel.armed, logs.slice(-8).join('\n')).toBe(true);
      const z0 = core.quad.s.pos.z;
      // (ArduCopter holds the motors for 2 s after arming, then spools them up)
      ap.hub.requestParam('FRAME_TYPE');
      run(1.5);
      // the build's parameters reached the firmware (props out: Betaflight's reversed motor order)
      expect(ap.hub.paramValues.get('FRAME_TYPE')).toBe(18);
      expect(ap.hub.tel.voltage).toBeGreaterThan(24);
      rc[2] = 1650;
      run(3);
      expect(core.quad.s.pos.z - z0, logs.filter((l) => !l.startsWith('ArduPilot: EKF')).slice(-30).join('\n')).toBeGreaterThan(2);
      // the script ran and saw the motors spooled up (THROTTLE_UNLIMITED = 3)
      expect(logs.some((l) => l.includes('fpv lua spool 3'))).toBe(true);
      const q = core.quad.s.q;
      expect(Math.abs(Math.atan2(2 * (q.w * q.x + q.y * q.z), 1 - 2 * (q.x * q.x + q.y * q.y)))).toBeLessThan(0.3);
    } finally { core.stopArduPilot(); }
  }, 180_000);
});
