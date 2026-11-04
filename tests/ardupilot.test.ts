// ArduPilot in the loop: the real ArduPlane / ArduCopter (WebAssembly, firmware/apwasm) flying the
// simulated vehicles through the flight core, lock-stepped over shared memory, in a Node worker
// thread. Skipped when the firmware has not been built (bash firmware/apwasm/build.sh).
import { describe, expect, test } from 'vitest';
import { apModuleFile, nodeSpawn } from '../src/ap/apNode';
import { DEFAULT_SPEC, DroneSpec, PRESETS } from '../src/builder/derive';
import { MAPS } from '../src/maps/maps';
import type { MapDef } from '../src/maps/world';
import { enuToLatLon, missionItems } from '../src/ap/apMission';
import { GPS_ORIGIN } from '../src/worker/ubxGps';
import { FlightCore } from '../src/worker/flightCore';
import { DEFAULT_SETTINGS } from '../src/worker/shared';

const HAVE = !!apModuleFile('plane') && !!apModuleFile('copter');
/** The field with nothing on it (no trees, buildings, gates; flat): room to climb out anywhere. */
const OPEN = (): MapDef => ({ ...MAPS.field(), prims: [], trees: [], wakeZones: [], gates: [], terrain: () => 0, spawn: { pos: { x: 0, y: 0, z: 0 }, yaw: 0 } });
const PLANE = PRESETS.find((p) => p.name.includes('Talon'))!;

/** A flight core on the field map with ArduPilot and calm air; rc: the sticks every packet sends (us). */
function rig(spec: DroneSpec, physicsHz = 2000, map?: MapDef) {
  const rc = new Float32Array(16).fill(1500);
  rc[2] = 1000; rc[4] = 1000; rc[5] = 1500; // throttle low, disarmed, AUX2 mid
  const logs: string[] = [];
  const core = new FlightCore({ sticks: (out) => out.set(rc), log: (t) => logs.push(t) }, {
    seed: 7, ardupilot: { spawn: nodeSpawn, moduleUrl: (v) => apModuleFile(v), waitMs: 2000 },
  });
  core.settings = { ...DEFAULT_SETTINGS, mapId: 'field', physicsHz, wind: { speed: 0, direction: 0, turbulence: 0, gusts: 0 }, damage: false };
  core.spec = spec;
  const m = map ?? MAPS.field();
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

test('a map mission becomes ArduPilot mission items (takeoff, waypoints above the spawn, the end)', () => {
  const m = { points: [{ x: 100, y: 0, z: 45 }, { x: 0, y: 100, z: 5 }], end: 'loop' as const, takeoffAltM: 30, speedMs: 18 };
  const it = missionItems(m, 'plane', GPS_ORIGIN, 5);
  expect(it.map((i) => i.command)).toEqual([22, 178, 16, 16, 177]);
  expect(it[2].alt).toBe(40); // 45 m above the origin, the spawn's ground at 5 m
  expect(it[3].alt).toBe(8); // planes fly at least 8 m above it
  expect(it[4].params![0]).toBe(3); // the jump goes back to the first waypoint (home 0, takeoff 1, speed 2)
  const ll = enuToLatLon(GPS_ORIGIN, 0, 1000);
  expect((ll.lat - GPS_ORIGIN.lat) * 111_319).toBeCloseTo(1000, -1); // ~1 km north
  expect(missionItems({ ...m, end: 'rtl' }, 'copter', GPS_ORIGIN, 0).map((i) => i.command)).toEqual([22, 178, 16, 16, 20]);
});

describe.skipIf(!HAVE)('ArduPilot in the loop', () => {
  test('ArduPlane: boots, arms on AUX1, holds FBWA, and the hand launch climbs away', async () => {
    const { core, ap, rc, logs, run, boot } = rig(PLANE, 2000, OPEN());
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
      rc[1] = 1350; // pitch stick back: FBWA's climb
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

  test('ArduPlane AUTO: the map\'s mission uploads, the hand launch takes off and flies the waypoints', async () => {
    // an open field (no trees or buildings) with a square mission at 40 m, flown round and round
    const open: MapDef = { ...OPEN(), mission: { points: [{ x: 160, y: 0, z: 40 }, { x: 160, y: 160, z: 40 }, { x: 0, y: 160, z: 40 }], end: 'loop', takeoffAltM: 30 } };
    const { core, ap, rc, logs, run, boot } = rig(PLANE, 2000, open);
    try {
      await boot();
      run(14);
      expect(logs.some((l) => l.startsWith('Mission loaded: 3 waypoints')), logs.slice(-10).join('\n')).toBe(true);
      expect(ap.hub.tel.wpTotal).toBe(5); // takeoff, 3 waypoints, the jump (home not counted)
      // an AUTO takeoff waits for the EKF to fly on GPS (as a pilot waits for ArduPilot's ready to fly)
      for (let i = 0; i < 40 && !logs.some((l) => /EKF3 IMU0 is using GPS/.test(l)); i++) run(1);
      expect(logs.some((l) => /EKF3 IMU0 is using GPS/.test(l))).toBe(true);
      rc[7] = 2000; // AUX4: AUTO
      run(1);
      expect(ap.hub.tel.modeName).toBe('AUTO');
      rc[4] = 2000; run(1.5); // arm
      rc[2] = 2000; run(1); // stick up: the pilot throws, ArduPilot feels it and starts the motor
      expect(core.hand!.released).toBe(true);
      let maxSeq = 0, maxZ = 0;
      run(60, () => { maxSeq = Math.max(maxSeq, ap.hub.tel.wpSeq); maxZ = Math.max(maxZ, core.quad.s.pos.z); });
      expect(maxZ, logs.slice(-10).join('\n')).toBeGreaterThan(25);
      // past the takeoff (1) and the first two waypoints (2, 3)
      expect(maxSeq, logs.slice(-10).join('\n')).toBeGreaterThanOrEqual(4);
      expect(core.quad.s.crashed).toBe(false);
    } finally { core.stopArduPilot(); }
  }, 240_000);

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
