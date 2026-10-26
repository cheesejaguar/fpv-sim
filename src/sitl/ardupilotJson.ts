// ArduPilot "JSON" SITL backend protocol (ArduPilot libraries/SITL/SIM_JSON.cpp/.h and
// libraries/SITL/examples/JSON/readme.md, read 2026-10). Pure encode/decode, no sockets.
//
// ArduPilot, started with `--model JSON:<plant ip>`, sends a binary servo packet over UDP to port
// 9002 of the plant once per ArduPilot physics frame and then blocks until a state reply arrives;
// the plant answers each packet with one JSON state datagram to the packet's source address.
// Servo packet, little-endian, no padding: u16 magic, u16 frame_rate (SIM_RATE_HZ: the step the
// plant should take is 1/frame_rate s), u32 frame_count, u16 pwm[16] (magic 18458, 40 bytes) or
// u16 pwm[32] (magic 29569, 72 bytes, SERVO_32_ENABLE = 1). frame_count increments once per state
// reply ArduPilot accepted; a packet repeating the last frame_count is a resend (ArduPilot heard
// nothing for ~1 s) and a smaller one means SITL restarted. Lock-step: step the plant once per new
// frame_count and reply; answer a resend with the current state without stepping.
// Quad X (AP_MotorsMatrix MOTOR_FRAME_TYPE_X): pwm[0] front-right CCW, [1] rear-left CCW,
// [2] front-left CW, [3] rear-right CW; PWM typically 1000..2000 us.
//
// State JSON: `timestamp` s (absolute physics time; ArduPilot advances its clock by the delta and
// only when 0 < delta < 0.1 s; a decrease is treated as a physics reset), `imu.gyro` rad/s and
// `imu.accel_body` m/s^2 specific force (z = -9.81 at rest level) in body FRD, `position` m NED
// relative to home (or `latitude` / `longitude` deg + `altitude` m AMSL), `velocity` m/s NED, and
// `quaternion` [w, x, y, z] (body FRD -> NED; preferred over `attitude` [roll, pitch, yaw] rad,
// 3-2-1 Euler). Optional: rng_1..rng_6 (m), velocity_wind (m/s NED), windvane {direction (rad,
// clockwise from the nose, 0 = head to wind), speed (m/s)}, airspeed (m/s), battery {voltage V,
// current A}, rc {rc_1..rc_12} (PWM us), no_time_sync, no_lockstep (booleans).
//
// ArduPilot's parser is not a JSON parser: per key it strstr()s the section name, then the key
// after it, then skips `key":` (so no whitespace may follow the colon) and reads numbers with
// strtod; for arrays it skips to the next digit or '-'. Hence: compact output, keys emitted so
// the first occurrence of each is the right one ("velocity" before "velocity_wind", windvane's
// "speed" before "airspeed"), and no NaN / Infinity (JSON would print null, which the parser
// would skip over into the next number) - stateJson throws on non-finite values instead. It parses
// the text between the last two newlines it has received, so the line is sent as "\n{...}\n"
// (the readme: "preceded by and terminated with" a newline; without the leading one the first
// datagram after start-up is dropped).
//
// Frames: the input here is the simulator's own convention (src/sim/math.ts): world ENU (x east,
// y north, z up) metres from home, body FLU (x forward, y left, z up), attitude as the body-to-
// world quaternion, yaw = heading counter-clockwise from east. Conversions: NED = (n, e, -u),
// FRD = (x, -y, -z), q_ned_frd = q_ned_enu * q_enu_flu * q_flu_frd with q_ned_enu = 180 deg about
// (1, 1, 0)/sqrt2 and q_flu_frd = 180 deg about x; so NED yaw = 90 deg - sim yaw (sim facing
// north -> NED yaw 0, sim facing east (identity) -> NED yaw 90 deg).

import type { Quat, V3 } from '../sim/math';

export const AP_JSON_PORT = 9002;
export const SERVO_MAGIC_16 = 18458;
export const SERVO_MAGIC_32 = 29569;

export interface ServoPacket { magic: number; frameRate: number; frameCount: number; pwm: number[] }

const servoChannels = (magic: number) => (magic === SERVO_MAGIC_16 ? 16 : magic === SERVO_MAGIC_32 ? 32 : 0);

/** Decode a servo datagram; null unless the magic and the exact size match. */
export function parseServoPacket(bytes: Uint8Array): ServoPacket | null {
  if (bytes.length < 8) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = dv.getUint16(0, true), n = servoChannels(magic);
  if (!n || bytes.length !== 8 + 2 * n) return null;
  const pwm: number[] = [];
  for (let k = 0; k < n; k++) pwm.push(dv.getUint16(8 + 2 * k, true));
  return { magic, frameRate: dv.getUint16(2, true), frameCount: dv.getUint32(4, true), pwm };
}

/** Build a servo datagram (the magic picks the layout; missing channels are 0). */
export function encodeServoPacket(p: ServoPacket): Uint8Array {
  const n = servoChannels(p.magic);
  if (!n) throw new Error(`ardupilotJson: bad servo magic ${p.magic}`);
  const out = new Uint8Array(8 + 2 * n);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, p.magic, true); dv.setUint16(2, p.frameRate, true); dv.setUint32(4, p.frameCount, true);
  for (let k = 0; k < Math.min(n, p.pwm.length); k++) dv.setUint16(8 + 2 * k, p.pwm[k], true);
  return out;
}

/** Plant state in the simulator's frames (see the header). */
export interface ArduPilotState {
  time: number; // s, physics time
  pos: V3; // m, world ENU relative to home
  vel: V3; // m/s, world ENU
  q: Quat; // body FLU -> world ENU
  gyro: V3; // rad/s, body FLU
  accel: V3; // m/s^2 specific force, body FLU (z = +9.81 at rest level)
  rng?: number[]; // rangefinders 1..6, m (finite: report max range for no return)
  windVel?: V3; // m/s, world ENU (sent as velocity_wind NED)
  windvane?: { direction: number; speed: number }; // ArduPilot's own convention, passed through
  airspeed?: number; // m/s
  battery?: { voltage: number; current: number };
  rc?: number[]; // channels 1..12, PWM us
  geo?: { lat: number; lon: number; alt: number }; // deg, deg, m AMSL: replaces `position` in ArduPilot
  noTimeSync?: boolean;
  noLockstep?: boolean;
}

// ---- frame conversions ----

type Arr3 = [number, number, number];

/** ENU -> NED (self-inverse). */
export const enuToNed = (v: V3): Arr3 => [v.y, v.x, -v.z];
/** FLU -> FRD (self-inverse). */
export const fluToFrd = (v: V3): Arr3 => [v.x, -v.y, -v.z];

function qMul(a: Quat, b: Quat): Quat {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  };
}

const S = Math.SQRT1_2;
const Q_NED_ENU: Quat = { w: 0, x: S, y: S, z: 0 };
const Q_FLU_FRD: Quat = { w: 0, x: 1, y: 0, z: 0 };

/** Body FLU -> ENU quaternion to body FRD -> NED (self-inverse as a rotation); result has w >= 0. */
export function quatEnuFluToNedFrd(q: Quat): Quat {
  const r = qMul(qMul(Q_NED_ENU, q), Q_FLU_FRD);
  const s = r.w < 0 ? -1 : 1;
  return { w: s * r.w, x: s * r.x, y: s * r.y, z: s * r.z };
}

/** 3-2-1 Euler [roll, pitch, yaw] of a body -> world quaternion (ArduPilot's from_euler order). */
export function quatToEuler(q: Quat): Arr3 {
  const { w, x, y, z } = q;
  return [
    Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y)),
    Math.asin(Math.max(-1, Math.min(1, 2 * (w * y - z * x)))),
    Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)),
  ];
}

function eulerToQuat(roll: number, pitch: number, yaw: number): Quat {
  const cr = Math.cos(roll / 2), sr = Math.sin(roll / 2), cp = Math.cos(pitch / 2), sp = Math.sin(pitch / 2);
  const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2);
  return {
    w: cr * cp * cy + sr * sp * sy, x: sr * cp * cy - cr * sp * sy,
    y: cr * sp * cy + sr * cp * sy, z: cr * cp * sy - sr * sp * cy,
  };
}

// ---- state line ----

/**
 * The JSON state datagram for one step, "\n{...}\n". `attitude: 'euler'` sends `attitude`
 * [roll, pitch, yaw] instead of `quaternion`. Throws on a non-finite number.
 */
export function stateJson(s: ArduPilotState, opts: { attitude?: 'quaternion' | 'euler' } = {}): string {
  const qn = quatEnuFluToNedFrd(s.q);
  // Insertion order is emission order; see the header for why it matters.
  const o: Record<string, unknown> = {
    timestamp: s.time,
    imu: { gyro: fluToFrd(s.gyro), accel_body: fluToFrd(s.accel) },
    position: enuToNed(s.pos),
  };
  if (opts.attitude === 'euler') o.attitude = quatToEuler(qn);
  else o.quaternion = [qn.w, qn.x, qn.y, qn.z];
  o.velocity = enuToNed(s.vel);
  s.rng?.slice(0, 6).forEach((d, k) => { o[`rng_${k + 1}`] = d; });
  if (s.windVel) o.velocity_wind = enuToNed(s.windVel);
  if (s.windvane) o.windvane = { direction: s.windvane.direction, speed: s.windvane.speed };
  if (s.airspeed !== undefined) o.airspeed = s.airspeed;
  if (s.battery) o.battery = { voltage: s.battery.voltage, current: s.battery.current };
  if (s.rc?.length) o.rc = Object.fromEntries(s.rc.slice(0, 12).map((v, k) => [`rc_${k + 1}`, v]));
  if (s.geo) { o.latitude = s.geo.lat; o.longitude = s.geo.lon; o.altitude = s.geo.alt; }
  if (s.noTimeSync !== undefined) o.no_time_sync = s.noTimeSync;
  if (s.noLockstep !== undefined) o.no_lockstep = s.noLockstep;
  checkFinite(o, '');
  return '\n' + JSON.stringify(o) + '\n';
}

function checkFinite(v: unknown, path: string): void {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new RangeError(`ardupilotJson: ${path} is ${v}`);
  } else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) checkFinite(x, path ? `${path}.${k}` : k);
  }
}

const isNum = (v: unknown): v is number => typeof v === 'number';
const vec3 = (v: unknown): Arr3 | null => (Array.isArray(v) && v.length === 3 && v.every(isNum) ? (v as Arr3) : null);
const toV3 = ([x, y, z]: Arr3): V3 => ({ x, y, z });

/**
 * Inverse of stateJson (for tests and fake plants/autopilots): back to ENU / FLU. Null when a
 * field ArduPilot requires is missing (timestamp, imu.gyro, imu.accel_body, velocity, and
 * quaternion or attitude); `position` falls back to the origin when only latitude etc. are given.
 */
export function parseStateJson(line: string): ArduPilotState | null {
  let j: Record<string, unknown>;
  try { j = JSON.parse(line); } catch { return null; }
  if (!j || typeof j !== 'object') return null;
  const imu = (j.imu ?? {}) as Record<string, unknown>;
  const gyro = vec3(imu.gyro), accel = vec3(imu.accel_body), vel = vec3(j.velocity);
  const quat = Array.isArray(j.quaternion) && j.quaternion.length === 4 && j.quaternion.every(isNum) ? (j.quaternion as number[]) : null;
  const att = vec3(j.attitude);
  if (!isNum(j.timestamp) || !gyro || !accel || !vel || (!quat && !att)) return null;
  const qn = quat ? { w: quat[0], x: quat[1], y: quat[2], z: quat[3] } : eulerToQuat(...att!);
  const s: ArduPilotState = {
    time: j.timestamp,
    pos: toV3(enuToNed(toV3(vec3(j.position) ?? [0, 0, 0]))),
    vel: toV3(enuToNed(toV3(vel))),
    q: quatEnuFluToNedFrd(qn), // all three conversions are their own inverses
    gyro: toV3(fluToFrd(toV3(gyro))),
    accel: toV3(fluToFrd(toV3(accel))),
  };
  const rng: number[] = [];
  for (let k = 1; k <= 6; k++) if (isNum(j[`rng_${k}`])) rng[k - 1] = j[`rng_${k}`] as number;
  if (rng.length) s.rng = Array.from(rng, (v) => v ?? NaN);
  const wind = vec3(j.velocity_wind);
  if (wind) s.windVel = toV3(enuToNed(toV3(wind)));
  const wv = j.windvane as Record<string, unknown> | undefined;
  if (wv && isNum(wv.direction) && isNum(wv.speed)) s.windvane = { direction: wv.direction, speed: wv.speed };
  if (isNum(j.airspeed)) s.airspeed = j.airspeed;
  const bat = j.battery as Record<string, unknown> | undefined;
  if (bat && isNum(bat.voltage) && isNum(bat.current)) s.battery = { voltage: bat.voltage, current: bat.current };
  const rc = j.rc as Record<string, unknown> | undefined;
  if (rc) {
    const ch: number[] = [];
    for (let k = 1; k <= 12; k++) if (isNum(rc[`rc_${k}`])) ch[k - 1] = rc[`rc_${k}`] as number;
    if (ch.length) s.rc = Array.from(ch, (v) => v ?? NaN);
  }
  if (isNum(j.latitude) && isNum(j.longitude) && isNum(j.altitude)) s.geo = { lat: j.latitude, lon: j.longitude, alt: j.altitude };
  if (typeof j.no_time_sync === 'boolean') s.noTimeSync = j.no_time_sync;
  if (typeof j.no_lockstep === 'boolean') s.noLockstep = j.no_lockstep;
  return s;
}
