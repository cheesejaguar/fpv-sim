// Protocol layer of the bring-your-own-autopilot mode: the MAVLink codec PX4 SITL's
// simulator_mavlink speaks (CRC_EXTRA derivation, wire order, v2 truncation, v1, signed frames,
// stream resync) and ArduPilot's JSON backend (servo packets, the state line and its frames).
import { describe, expect, test } from 'vitest';
import {
  AP_JSON_PORT, encodeServoPacket, parseServoPacket, parseStateJson, quatEnuFluToNedFrd, quatToEuler,
  SERVO_MAGIC_16, SERVO_MAGIC_32, stateJson, type ArduPilotState,
} from '../src/sitl/ardupilotJson';
import {
  crcCalculate, crcExtra, encode, HIL_SENSOR_UPDATED, MavlinkParser, MESSAGES, PX4_SENSOR_GROUP,
  type MavMessage, type MsgName, type OutMessage,
} from '../src/sitl/mavlink';
import type { Quat } from '../src/sim/math';

const H = { sysid: 1, compid: 1, seq: 0 };
const f32 = Math.fround;
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const parseAll = (b: Uint8Array) => new MavlinkParser().push(b);

// One fully populated example per message (floats exactly representable in float32).
const SAMPLES: OutMessage[] = [
  { name: 'HEARTBEAT', fields: { type: 2, autopilot: 12, base_mode: 0x81, custom_mode: 0x00040000, system_status: 4, mavlink_version: 3 } },
  { name: 'SYSTEM_TIME', fields: { time_unix_usec: 1_761_000_000_000_000, time_boot_ms: 123456 } },
  { name: 'RC_CHANNELS', fields: { time_boot_ms: 99, chancount: 18, ...Object.fromEntries(Array.from({ length: 18 }, (_, k) => [`chan${k + 1}_raw`, 1000 + 50 * k])), rssi: 200 } },
  { name: 'COMMAND_LONG', fields: { target_system: 1, target_component: 1, command: 511, confirmation: 0, param1: 115, param2: 5000, param3: -1.5, param4: 0, param5: 0.25, param6: 0, param7: NaN } },
  { name: 'COMMAND_ACK', fields: { command: 511, result: 0, progress: 255, result_param2: -7, target_system: 1, target_component: 200 } },
  { name: 'HIL_RC_INPUTS_RAW', fields: { time_usec: 4000, ...Object.fromEntries(Array.from({ length: 12 }, (_, k) => [`chan${k + 1}_raw`, 1100 + k])), rssi: 255 } },
  { name: 'HIL_ACTUATOR_CONTROLS', fields: { time_usec: 8_000_004_000, controls: [0.5, 0.25, 0.75, 1, ...Array(11).fill(0), -1], mode: 129, flags: 1 } },
  {
    name: 'HIL_SENSOR', fields: {
      time_usec: 4000, xacc: 0.5, yacc: -0.25, zacc: f32(-9.81), xgyro: 0.125, ygyro: -0.0625, zgyro: 1, xmag: 0.25, ymag: 0.0625, zmag: 0.5,
      abs_pressure: f32(1013.25), diff_pressure: 0, pressure_alt: 12.5, temperature: 20, fields_updated: 0x1fff, id: 1,
    },
  },
  { name: 'HIL_GPS', fields: { time_usec: 1e15, fix_type: 3, lat: 473977418, lon: 85455939, alt: 488000, eph: 30, epv: 40, vel: 120, vn: 100, ve: -60, vd: 5, cog: 32900, satellites_visible: 12, id: 1, yaw: 36000 } },
  { name: 'HIL_OPTICAL_FLOW', fields: { time_usec: 1, sensor_id: 2, integration_time_us: 20000, integrated_x: 0.125, integrated_y: -0.5, integrated_xgyro: 0.25, integrated_ygyro: 0, integrated_zgyro: -0.25, temperature: -1250, quality: 255, time_delta_distance_us: 3, distance: 1.5 } },
  { name: 'HIL_STATE_QUATERNION', fields: { time_usec: 77, attitude_quaternion: [0.5, -0.5, 0.5, 0.5], rollspeed: 1, pitchspeed: -2, yawspeed: 0.5, lat: -338688000, lon: 1512093000, alt: -5000, vx: 100, vy: -200, vz: 300, ind_airspeed: 1500, true_airspeed: 1600, xacc: -1000, yacc: 0, zacc: 32767 } },
  { name: 'DISTANCE_SENSOR', fields: { time_boot_ms: 5, min_distance: 10, max_distance: 4000, current_distance: 123, type: 0, id: 1, orientation: 25, covariance: 255, horizontal_fov: 0.25, vertical_fov: 0.5, quaternion: [1, 0, 0, 0], signal_quality: 100 } },
];

describe('MAVLink codec', () => {
  test('CRC_EXTRA computed from the field lists equals the generated C library constants', () => {
    // mavlink/c_library_v2 MAVLINK_MSG_ID_<id>_CRC, also re-derived from common.xml by an independent script
    const known: Record<MsgName, number> = {
      HEARTBEAT: 50, SYSTEM_TIME: 137, RC_CHANNELS: 118, COMMAND_LONG: 152, COMMAND_ACK: 143, HIL_RC_INPUTS_RAW: 54,
      HIL_ACTUATOR_CONTROLS: 47, HIL_SENSOR: 108, HIL_GPS: 124, HIL_OPTICAL_FLOW: 237, HIL_STATE_QUATERNION: 4, DISTANCE_SENSOR: 85,
    };
    for (const n of Object.keys(known) as MsgName[]) expect([n, MESSAGES[n].crcExtra]).toEqual([n, known[n]]);
    // the CRC itself: CRC-16/MCRF4XX check value
    expect(crcCalculate(Array.from('123456789', (c) => c.charCodeAt(0)))).toBe(0x6f91);
    // order of declaration must not matter, only sizes (stable within a size)
    expect(crcExtra('SYSTEM_TIME', [['uint32_t', 'time_boot_ms'], ['uint64_t', 'time_unix_usec']])).toBe(137);
  });

  test('payload lengths and wire order match the generated C library', () => {
    // MAVLINK_MSG_ID_<id>_MIN_LEN / _LEN
    const lens: Record<MsgName, [number, number]> = {
      HEARTBEAT: [9, 9], SYSTEM_TIME: [12, 12], RC_CHANNELS: [42, 42], COMMAND_LONG: [33, 33], COMMAND_ACK: [3, 10], HIL_RC_INPUTS_RAW: [33, 33],
      HIL_ACTUATOR_CONTROLS: [81, 81], HIL_SENSOR: [64, 65], HIL_GPS: [36, 39], HIL_OPTICAL_FLOW: [44, 44], HIL_STATE_QUATERNION: [64, 64], DISTANCE_SENSOR: [14, 39],
    };
    for (const n of Object.keys(lens) as MsgName[]) expect([n, MESSAGES[n].minLength, MESSAGES[n].maxLength]).toEqual([n, ...lens[n]]);
    const order = (n: MsgName) => MESSAGES[n].fields.map((f) => `${f.name}@${f.offset}`);
    expect(order('HEARTBEAT')).toEqual(['custom_mode@0', 'type@4', 'autopilot@5', 'base_mode@6', 'system_status@7', 'mavlink_version@8']);
    expect(order('HIL_ACTUATOR_CONTROLS')).toEqual(['time_usec@0', 'flags@8', 'controls@16', 'mode@80']);
    expect(order('HIL_GPS').slice(-4)).toEqual(['fix_type@34', 'satellites_visible@35', 'id@36', 'yaw@37']);
  });

  test('hand-derived HEARTBEAT frame', () => {
    // payload in wire order: custom_mode u32 LE, type, autopilot, base_mode, system_status, mavlink_version
    const payload = [0x00, 0x00, 0x04, 0x00, 2, 12, 0x81, 4, 3];
    const header = [0xfd, 9, 0, 0, 7, 1, 1, 0, 0, 0]; // magic len incompat compat seq sys comp msgid(3)
    let crc = 0xffff;
    for (const b of [...header.slice(1), ...payload, 50]) { // X.25 over len..payload, then CRC_EXTRA
      let t = (b ^ crc) & 0xff; t = (t ^ (t << 4)) & 0xff;
      crc = ((crc >> 8) ^ (t << 8) ^ (t << 3) ^ (t >> 4)) & 0xffff;
    }
    const expected = [...header, ...payload, crc & 0xff, crc >> 8];
    expect(hex(new Uint8Array(expected))).toBe('fd09000007010100000000000400020c810403fe28'); // same bytes from a separate Python derivation
    const frame = encode(SAMPLES[0], { sysid: 1, compid: 1, seq: 7 });
    expect(Array.from(frame)).toEqual(expected);
    const [m] = parseAll(frame);
    expect(m).toMatchObject({ name: 'HEARTBEAT', msgid: 0, sysid: 1, compid: 1, seq: 7, version: 2, signed: false });
    // mavlink_version defaults to 3 when omitted
    expect(encode({ name: 'HEARTBEAT', fields: { type: 2 } }, H)[10 + 8]).toBe(3);
  });

  test('every message round-trips (v2)', () => {
    let seq = 0;
    for (const s of SAMPLES) {
      const msgs = parseAll(encode(s, { sysid: 42, compid: 200, seq: seq++ }));
      expect(msgs).toHaveLength(1);
      const m = msgs[0];
      expect(m.name).toBe(s.name);
      expect(m.msgid).toBe(MESSAGES[s.name].id);
      expect(m).toMatchObject({ sysid: 42, compid: 200, seq: seq - 1 });
      if (m.name === null) throw new Error('decoded as unknown');
      expect(m.fields).toEqual(s.fields);
    }
  });

  test('typed access after narrowing on name', () => {
    const [m] = parseAll(encode(SAMPLES[6], H));
    if (m.name !== 'HIL_ACTUATOR_CONTROLS') throw new Error(String(m.name));
    expect(m.fields.controls.slice(0, 4)).toEqual([0.5, 0.25, 0.75, 1]);
    expect(m.fields.mode & 128).toBe(128);
  });

  test('v2 truncation: trailing zeros dropped on send, zero-extended on receive', () => {
    const f = encode({ name: 'HIL_SENSOR', fields: { time_usec: 4000, zacc: -9.5 } }, H);
    // wire order time_usec, xacc, yacc, zacc...: zacc (-9.5f = 0xC1180000, LE 00 00 18 C1) ends at byte 20
    expect(f[1]).toBe(20);
    const [m] = parseAll(f);
    if (m.name !== 'HIL_SENSOR') throw new Error();
    expect(m.fields).toMatchObject({ time_usec: 4000, xacc: 0, zacc: -9.5, fields_updated: 0, id: 0 });
    // all-zero payload keeps one byte
    const z = encode({ name: 'COMMAND_ACK', fields: {} }, H);
    expect(z[1]).toBe(1);
    expect(parseAll(z)[0]).toMatchObject({ name: 'COMMAND_ACK', fields: { command: 0, result: 0, progress: 0, result_param2: 0 } });
    // an extension that is zero is not sent; non-zero is
    expect(encode({ name: 'HIL_GPS', fields: { time_usec: 1, satellites_visible: 9 } }, H)[1]).toBe(36);
    expect(encode({ name: 'HIL_GPS', fields: { time_usec: 1, yaw: 1 } }, H)[1]).toBe(38);
  });

  test('MAVLink 1 frames (0xFE) parse, extensions zero-filled', () => {
    for (const s of SAMPLES) {
      const f = encode(s, { ...H, mavlink1: true });
      expect(f[0]).toBe(0xfe);
      expect(f[1]).toBe(MESSAGES[s.name].minLength);
      const [m] = parseAll(f);
      expect(m).toMatchObject({ name: s.name, version: 1 });
      if (m.name === null) throw new Error();
      // extension fields sit after the base fields on the wire (offset >= minLength)
      for (const fd of MESSAGES[s.name].fields) {
        const v = (m.fields as Record<string, number | number[]>)[fd.name];
        const want = fd.offset >= MESSAGES[s.name].minLength ? (fd.len ? Array(fd.len).fill(0) : 0) : (s.fields as Record<string, unknown>)[fd.name];
        expect([fd.name, v]).toEqual([fd.name, want]);
      }
    }
    // a hand-built v1 HEARTBEAT: FE len seq sys comp id payload crc
    const p = [0, 0, 0, 0, 6, 8, 0, 3, 3];
    const body = [9, 5, 255, 190, 0, ...p];
    const crc = crcCalculate([50], crcCalculate(body));
    const [m] = parseAll(new Uint8Array([0xfe, ...body, crc & 0xff, crc >> 8]));
    expect(m).toMatchObject({ name: 'HEARTBEAT', version: 1, seq: 5, sysid: 255, compid: 190, fields: { type: 6, autopilot: 8, system_status: 3 } });
  });

  test('signed frames: signature skipped', () => {
    const f = encode(SAMPLES[7], H);
    f[2] = 0x01; // incompat flags: signed; the CRC covers the header, so recompute it
    const crc = crcCalculate([MESSAGES.HIL_SENSOR.crcExtra], crcCalculate(f.subarray(1, f.length - 2)));
    f[f.length - 2] = crc & 0xff; f[f.length - 1] = crc >> 8;
    const signed = new Uint8Array([...f, ...Array(13).fill(0xfd)]); // signature full of magic bytes
    const p = new MavlinkParser();
    const out = p.push(new Uint8Array([...signed, ...encode(SAMPLES[0], H)]));
    expect(out.map((m) => [m.name, m.signed])).toEqual([['HIL_SENSOR', true], ['HEARTBEAT', false]]);
    expect(p.crcErrors).toBe(0);
  });

  const stream = () => {
    const parts = SAMPLES.map((s, k) => encode(s, { ...H, seq: k }));
    const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) { all.set(p, o); o += p.length; }
    return all;
  };
  const names = (ms: MavMessage[]) => ms.map((m) => m.name);

  test('split at every byte boundary, and byte by byte', () => {
    const all = stream();
    for (let cut = 0; cut <= all.length; cut++) {
      const p = new MavlinkParser();
      const got = [...p.push(all.subarray(0, cut)), ...p.push(all.subarray(cut))];
      expect(names(got)).toEqual(SAMPLES.map((s) => s.name));
    }
    const p = new MavlinkParser();
    const got: MavMessage[] = [];
    for (const b of all) got.push(...p.push(new Uint8Array([b])));
    expect(names(got)).toEqual(SAMPLES.map((s) => s.name));
    expect(p.crcErrors + p.droppedBytes).toBe(0);
  });

  test('garbage between frames, a corrupted frame, then good ones', () => {
    const hb = encode(SAMPLES[0], H), act = encode(SAMPLES[6], H), sens = encode(SAMPLES[7], H);
    const bad = act.slice(); bad[20] ^= 0x10; // payload bit flip
    const junk = [0x00, 0x13, 0x37, 0xfe, 0x02, 0xfd, 0x05]; // includes false magic bytes
    const p = new MavlinkParser();
    const out = p.push(new Uint8Array([...junk, ...hb, 0xaa, 0x55, ...bad, ...sens, 0xfd, 0xfd, ...act]));
    expect(names(out)).toEqual(['HEARTBEAT', 'HIL_SENSOR', 'HIL_ACTUATOR_CONTROLS']);
    expect(p.crcErrors).toBeGreaterThanOrEqual(1);
    // the corrupted frame cost one CRC error, not the frames after it
    const q = new MavlinkParser();
    expect(names(q.push(new Uint8Array([...bad, ...hb])))).toEqual(['HEARTBEAT']);
    expect(q.crcErrors).toBe(1);
    // a header claiming a known id with an impossible length is rejected without waiting
    const r = new MavlinkParser();
    expect(names(r.push(new Uint8Array([0xfd, 200, 0, 0, 0, 1, 1, 93, 0, 0, ...hb])))).toEqual(['HEARTBEAT']);
  });

  test('unknown ids pass through unvalidated', () => {
    const payload = [1, 2, 3, 4];
    const frame = new Uint8Array([0xfd, 4, 0, 0, 9, 3, 4, 0x39, 0x30, 0x00, ...payload, 0xde, 0xad]); // msgid 12345
    const out = parseAll(new Uint8Array([...frame, ...encode(SAMPLES[0], H)]));
    expect(out[0]).toMatchObject({ name: null, msgid: 12345, sysid: 3, compid: 4, seq: 9 });
    if (out[0].name !== null) throw new Error();
    expect(Array.from(out[0].payload)).toEqual(payload);
    expect(out[1].name).toBe('HEARTBEAT');
    // at the end of a push it waits for the next frame's magic byte
    const p = new MavlinkParser();
    expect(p.push(frame)).toEqual([]);
    expect(names(p.push(encode(SAMPLES[0], H)))).toEqual([null, 'HEARTBEAT']);
  });

  test('PX4 sensor flags', () => {
    expect(HIL_SENSOR_UPDATED.RESET).toBe(2 ** 31);
    const all = (PX4_SENSOR_GROUP.ACCEL | PX4_SENSOR_GROUP.GYRO | PX4_SENSOR_GROUP.MAG | PX4_SENSOR_GROUP.BARO | PX4_SENSOR_GROUP.DIFF_PRESS);
    expect(all).toBe(0x1fff);
    expect(PX4_SENSOR_GROUP.BARO).toBe(HIL_SENSOR_UPDATED.ABS_PRESSURE | HIL_SENSOR_UPDATED.PRESSURE_ALT | HIL_SENSOR_UPDATED.TEMPERATURE);
    const withReset = (all | HIL_SENSOR_UPDATED.RESET) >>> 0;
    const [m] = parseAll(encode({ name: 'HIL_SENSOR', fields: { fields_updated: withReset } }, H));
    if (m.name !== 'HIL_SENSOR') throw new Error();
    expect(m.fields.fields_updated).toBe(0x80001fff);
  });
});

// ---- ArduPilot JSON ----

const qAxis = (x: number, y: number, z: number, a: number): Quat => {
  const n = Math.hypot(x, y, z), s = Math.sin(a / 2) / n;
  return { w: Math.cos(a / 2), x: x * s, y: y * s, z: z * s };
};
const deg = Math.PI / 180;
const at = (q: Quat): ArduPilotState => ({ time: 1, pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, q, gyro: { x: 0, y: 0, z: 0 }, accel: { x: 0, y: 0, z: 9.81 } });
const json = (s: ArduPilotState, o?: { attitude?: 'quaternion' | 'euler' }) => JSON.parse(stateJson(s, o));
const close = (a: number[], b: number[]) => a.forEach((v, k) => expect(v).toBeCloseTo(b[k], 9));

describe('ArduPilot JSON backend', () => {
  test('servo packets: both layouts, exact sizes', () => {
    expect(AP_JSON_PORT).toBe(9002);
    const p16 = { magic: SERVO_MAGIC_16, frameRate: 1200, frameCount: 0xfffffffe, pwm: Array.from({ length: 16 }, (_, k) => 1000 + k * 61) };
    const b16 = encodeServoPacket(p16);
    expect(b16.length).toBe(40);
    expect(Array.from(b16.subarray(0, 10))).toEqual([0x1a, 0x48, 0xb0, 0x04, 0xfe, 0xff, 0xff, 0xff, 0xe8, 0x03]); // 18458, 1200, count, pwm[0]=1000
    expect(parseServoPacket(b16)).toEqual(p16);
    const p32 = { magic: SERVO_MAGIC_32, frameRate: 400, frameCount: 7, pwm: Array.from({ length: 32 }, (_, k) => (k < 4 ? 1500 + k : 0)) };
    const b32 = encodeServoPacket(p32);
    expect(b32.length).toBe(72);
    expect(b32[0] | (b32[1] << 8)).toBe(29569);
    expect(parseServoPacket(b32)).toEqual(p32);
    // a view into a larger buffer at an odd offset
    const big = new Uint8Array(41); big.set(b16, 1);
    expect(parseServoPacket(big.subarray(1))).toEqual(p16);
    // wrong size / magic
    expect(parseServoPacket(b16.subarray(0, 39))).toBeNull();
    expect(parseServoPacket(new Uint8Array([...b16, 0]))).toBeNull();
    expect(parseServoPacket(b32.subarray(0, 40))).toBeNull(); // 32-ch magic with 16-ch size
    const wrong = b16.slice(); wrong[0] ^= 1;
    expect(parseServoPacket(wrong)).toBeNull();
    expect(parseServoPacket(new Uint8Array(0))).toBeNull();
  });

  test('line shape: compact, newline-delimited, required keys in a parser-safe order', () => {
    const s: ArduPilotState = {
      ...at(qAxis(0, 0, 1, 0)), rng: [1.5], windVel: { x: 1, y: 2, z: 0 }, windvane: { direction: 0.1, speed: 3 }, airspeed: 4,
      battery: { voltage: 16.8, current: 12 }, rc: Array.from({ length: 12 }, (_, k) => 1000 + k), noLockstep: false,
    };
    const line = stateJson(s);
    expect(line.startsWith('\n{') && line.endsWith('}\n')).toBe(true);
    expect(line.slice(1, -1)).not.toMatch(/\s/);
    const body = line.trim();
    // each key's first occurrence is followed by `":` (ArduPilot's strstr-based parser)
    for (const k of ['timestamp', 'imu', 'gyro', 'accel_body', 'position', 'quaternion', 'velocity', 'rng_1', 'velocity_wind', 'windvane', 'airspeed', 'battery', 'voltage', 'current', 'rc', 'rc_1', 'rc_10', 'rc_12', 'no_lockstep']) {
      expect([k, body.slice(body.indexOf(k) + k.length, body.indexOf(k) + k.length + 2)]).toEqual([k, '":']);
    }
    // windvane's "speed" is found before "airspeed" (searched after "windvane")
    const wv = body.indexOf('windvane');
    expect(body.indexOf('speed', wv)).toBeLessThan(body.indexOf('airspeed'));
    expect(json(s)).toMatchObject({ rng_1: 1.5, velocity_wind: [2, 1, 0], battery: { voltage: 16.8, current: 12 }, rc: { rc_1: 1000, rc_12: 1011 }, no_lockstep: false });
    expect(() => stateJson({ ...s, gyro: { x: NaN, y: 0, z: 0 } })).toThrow(/imu\.gyro\.0/);
  });

  test('vectors: ENU -> NED, FLU -> FRD', () => {
    const j = json({
      time: 12.5, pos: { x: 1, y: 2, z: 3 }, vel: { x: -4, y: 5, z: -6 }, q: qAxis(0, 0, 1, 0),
      gyro: { x: 0.1, y: 0.2, z: 0.3 }, accel: { x: 0, y: 0, z: 9.81 },
    });
    expect(j.timestamp).toBe(12.5);
    expect(j.position).toEqual([2, 1, -3]); // north, east, down
    expect(j.velocity).toEqual([5, -4, 6]);
    expect(j.imu.gyro).toEqual([0.1, -0.2, -0.3]); // CCW yaw rate in FLU = negative FRD yaw rate
    expect(j.imu.accel_body).toEqual([0, 0, -9.81]); // level at rest: -g on FRD z (JSON has no -0)
  });

  test('attitude: sim yaw (CCW from east) -> NED yaw (CW from north)', () => {
    const yawOf = (simYawDeg: number) => quatToEuler(quatEnuFluToNedFrd(qAxis(0, 0, 1, simYawDeg * deg)))[2] / deg;
    expect(yawOf(90)).toBeCloseTo(0, 9); // facing north
    expect(yawOf(0)).toBeCloseTo(90, 9); // facing east (sim identity)
    expect(yawOf(180)).toBeCloseTo(-90, 9); // facing west
    expect(yawOf(-90)).toBeCloseTo(180, 9); // facing south (atan2 -> +-180)
    expect(yawOf(30)).toBeCloseTo(60, 9);
    // identity in the sim: NED quaternion is 90 deg about down
    const q = json(at({ w: 1, x: 0, y: 0, z: 0 })).quaternion;
    close(q, [Math.SQRT1_2, 0, 0, Math.SQRT1_2]);
    // facing north: identity in NED
    close(json(at(qAxis(0, 0, 1, 90 * deg))).quaternion, [1, 0, 0, 0]);
  });

  test('attitude: nose up and right wing down keep their NED signs', () => {
    // facing north, nose up 20 deg: body x = (0, cos, sin) in ENU, i.e. rotate about the left wing by -20 deg
    const noseUp = qMulT(qAxis(0, 0, 1, 90 * deg), qAxis(0, 1, 0, -20 * deg));
    close(json(at(noseUp), { attitude: 'euler' }).attitude, [0, 20 * deg, 0]);
    // facing north, right wing down 30 deg: rotate about the FLU x axis by +30 deg (left wing goes up)
    const rollRight = qMulT(qAxis(0, 0, 1, 90 * deg), qAxis(1, 0, 0, 30 * deg));
    close(json(at(rollRight), { attitude: 'euler' }).attitude, [30 * deg, 0, 0]);
    // the quaternion and euler forms describe the same rotation: check a body vector (FRD forward) in NED
    const mixed = qMulT(qAxis(0, 0, 1, 37 * deg), qMulT(qAxis(0, 1, 0, 11 * deg), qAxis(1, 0, 0, -23 * deg)));
    const j = json(at(mixed)), e = json(at(mixed), { attitude: 'euler' }).attitude as number[];
    const [w, x, y, z] = j.quaternion as number[];
    const fwdQ = [1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y)];
    const fwdE = [Math.cos(e[1]) * Math.cos(e[2]), Math.cos(e[1]) * Math.sin(e[2]), -Math.sin(e[1])];
    close(fwdQ, fwdE);
    // and the sim's own forward vector maps through ENU -> NED to the same thing
    const fwdSim = rot(mixed, [1, 0, 0]);
    close(fwdQ, [fwdSim[1], fwdSim[0], -fwdSim[2]]);
  });

  test('parseStateJson inverts stateJson', () => {
    const s: ArduPilotState = {
      time: 3.25, pos: { x: 1, y: -2, z: 3 }, vel: { x: 0.5, y: 0.25, z: -1 }, q: qMulT(qAxis(0, 0, 1, 1), qAxis(1, 1, 0, 0.3)),
      gyro: { x: 1, y: 2, z: 3 }, accel: { x: -1, y: 0.5, z: 9 }, rng: [1, 2, 3, 4, 5, 6], windVel: { x: 3, y: 0, z: 1 },
      windvane: { direction: 1, speed: 2 }, airspeed: 7, battery: { voltage: 12.6, current: 3 }, rc: [1500, 1500, 1000, 1500],
      geo: { lat: -35.363261, lon: 149.165230, alt: 584 }, noTimeSync: true, noLockstep: false,
    };
    for (const attitude of ['quaternion', 'euler'] as const) {
      const back = parseStateJson(stateJson(s, { attitude }))!;
      expect(back).not.toBeNull();
      const { q, ...rest } = back;
      const { q: q0, ...rest0 } = s;
      expect(rest).toEqual(rest0);
      const sgn = Math.sign(q.w * q0.w + q.x * q0.x + q.y * q0.y + q.z * q0.z);
      close([q.w, q.x, q.y, q.z], [q0.w * sgn, q0.x * sgn, q0.y * sgn, q0.z * sgn]);
    }
    expect(parseStateJson('{"timestamp":1}')).toBeNull();
    expect(parseStateJson('not json')).toBeNull();
  });
});

function qMulT(a: Quat, b: Quat): Quat {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z, x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x, z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  };
}
function rot(q: Quat, v: number[]): number[] {
  const p = qMulT(qMulT(q, { w: 0, x: v[0], y: v[1], z: v[2] }), { w: q.w, x: -q.x, y: -q.y, z: -q.z });
  return [p.x, p.y, p.z];
}
