// MAVLink 2 codec (with MAVLink 1 receive/send) for PX4's simulator interface: the handful of
// messages PX4 SITL's `simulator_mavlink` exchanges with an external physics plant. Pure
// Uint8Array / DataView, no I/O; the TCP server and the plant live elsewhere.
//
// Framing (mavlink.io "Serialization"): v2 = FD len incompat compat seq sysid compid msgid(24 LE)
// payload crc16 [13-byte signature if incompat & 0x01]; v1 = FE len seq sysid compid msgid(8)
// payload crc16. The CRC is X.25 (CRC-16/MCRF4XX) over everything after the magic byte, then the
// message's CRC_EXTRA. Payload fields are little-endian, sorted by element size descending
// (stable, arrays by element size) with extension fields appended in declaration order; v2 drops
// trailing zero bytes on send (keeping at least one) and the receiver zero-extends. CRC_EXTRA is
// computed here from the field lists the way pymavlink's mavparse.message_checksum does, so the
// specs below are the only source of truth (copied from common.xml / minimal.xml, version 3).
//
// PX4 lock-step handshake (PX4-Autopilot src/modules/simulation/simulator_mavlink/
// SimulatorMavlink.cpp + .hpp, ROMFS/px4fmu_common/init.d-posix/px4-rc.mavlinksim, read 2026-10):
// - The simulator LISTENS on TCP 4560 + instance; PX4 runs `simulator_mavlink start -c 4560` and
//   retries connect() until it succeeds (UDP mode exists but is not the default).
// - On connect PX4 sends COMMAND_LONG MAV_CMD_SET_MESSAGE_INTERVAL (511), param1 = 115
//   (HIL_STATE_QUATERNION), param2 = 5000 us: a request for 200 Hz ground truth (optional; PX4
//   does not wait for a COMMAND_ACK and never parses one). Its sender thread then sends ONE
//   HEARTBEAT (autopilot 12 = PX4, base_mode 128 when armed) to get the simulator going. PX4
//   ignores HEARTBEATs from the simulator, so sending one at 1 Hz is harmless but not required
//   (Gazebo classic only sends them in HITL mode).
// - Simulator -> PX4, every physics step: HIL_SENSOR with `id` 0 and a strictly increasing
//   `time_usec` (simulated time, us). For id 0 PX4 sets its clock to time_usec and advances its
//   lock-step scheduler, so this message IS PX4's clock. PX4 consumes a sensor group only when
//   all its bits are set in fields_updated: (fields & G) == G with G = PX4_SENSOR_GROUP below
//   (note BARO needs abs_pressure + pressure_alt + temperature). Body frame FRD, accel = specific
//   force m/s^2 (z = -9.81 at rest level), gyro rad/s, mag gauss, pressures hPa, temperature
//   degC. PX4's defaults assume 250 Hz (IMU_INTEG_RATE 250, i.e. 4000 us steps).
// - Simulator -> PX4 at a GPS rate (Gazebo classic defaults to 5 Hz, 10 Hz is typical): HIL_GPS,
//   lat/lon degE7, alt mm (used as both MSL and ellipsoid), eph/epv cm, vn/ve/vd cm/s NED, vel
//   cm/s (UINT16_MAX = derive from vn/ve), cog cdeg (UINT16_MAX = unknown), fix_type (3 = 3D),
//   satellites_visible, `id` (selects the GNSS instance); time_usec is copied as UTC time. PX4's
//   handler ignores `yaw`.
// - Optional: HIL_STATE_QUATERNION (ground truth only, never fed to the estimator),
//   HIL_OPTICAL_FLOW, DISTANCE_SENSOR (current_distance cm; orientation 25 = PITCH_270 =
//   downward), RC_CHANNELS (65; PX4's handler reads RC_CHANNELS, NOT HIL_RC_INPUTS_RAW even though
//   the docs list the latter), ODOMETRY / VISION_POSITION_ESTIMATE / LANDING_TARGET.
// - PX4 -> simulator: HIL_ACTUATOR_CONTROLS once per lock-step cycle, after its control loop has
//   run on the sensor data (it waits for its lock-step components first). The simulator steps,
//   sends the next HIL_SENSOR, and waits for the next HIL_ACTUATOR_CONTROLS. PX4 only publishes
//   outputs once its mixer has run, so the plant must keep stepping without controls until the
//   first HIL_ACTUATOR_CONTROLS arrives (Gazebo classic additionally only blocks while armed).
//   controls[i] = actuator_outputs_sim.output[i] when armed, all 0 when disarmed: non-reversible
//   motors are normalised to [0, 1] (pwm_out_sim maps its 1000..2000 virtual PWM), every other
//   function to [-1, 1]. mode = MAV_MODE_FLAG_CUSTOM_MODE_ENABLED (1) | SAFETY_ARMED (128) when
//   armed; flags bit 0 = HIL_ACTUATOR_CONTROLS_FLAGS_LOCKSTEP. time_usec = PX4's clock.
// - Quad X (airframe 10016_none_iris / gazebo-classic iris: PWM_MAIN_FUNC1..4 = Motor1..4 with
//   CA_ROTOR geometry): controls[0] front-right CCW, [1] rear-left CCW, [2] front-left CW,
//   [3] rear-right CW (seen from above; CA_ROTORn_KM > 0 = CCW).

/** Element types of MAVLink fields (char arrays are not needed by these messages). */
type Base = 'uint8_t' | 'int8_t' | 'uint16_t' | 'int16_t' | 'uint32_t' | 'int32_t' | 'uint64_t' | 'int64_t' | 'float' | 'double';
type FieldSpec = readonly [Base | `${Base}[${number}]`, string];
interface MessageSpec { readonly id: number; readonly fields: readonly FieldSpec[]; readonly ext: readonly FieldSpec[] }

// Fields in XML declaration order; `ext` = after <extensions/>. HEARTBEAT's mavlink_version is
// `uint8_t_mavlink_version` in the XML, which mavgen treats as uint8_t (encode defaults it to 3).
const SPECS = {
  HEARTBEAT: { id: 0, ext: [], fields: [['uint8_t', 'type'], ['uint8_t', 'autopilot'], ['uint8_t', 'base_mode'], ['uint32_t', 'custom_mode'], ['uint8_t', 'system_status'], ['uint8_t', 'mavlink_version']] },
  SYSTEM_TIME: { id: 2, ext: [], fields: [['uint64_t', 'time_unix_usec'], ['uint32_t', 'time_boot_ms']] },
  RC_CHANNELS: {
    id: 65, ext: [],
    fields: [['uint32_t', 'time_boot_ms'], ['uint8_t', 'chancount'], ['uint16_t', 'chan1_raw'], ['uint16_t', 'chan2_raw'], ['uint16_t', 'chan3_raw'], ['uint16_t', 'chan4_raw'],
      ['uint16_t', 'chan5_raw'], ['uint16_t', 'chan6_raw'], ['uint16_t', 'chan7_raw'], ['uint16_t', 'chan8_raw'], ['uint16_t', 'chan9_raw'], ['uint16_t', 'chan10_raw'],
      ['uint16_t', 'chan11_raw'], ['uint16_t', 'chan12_raw'], ['uint16_t', 'chan13_raw'], ['uint16_t', 'chan14_raw'], ['uint16_t', 'chan15_raw'], ['uint16_t', 'chan16_raw'],
      ['uint16_t', 'chan17_raw'], ['uint16_t', 'chan18_raw'], ['uint8_t', 'rssi']],
  },
  COMMAND_LONG: {
    id: 76, ext: [],
    fields: [['uint8_t', 'target_system'], ['uint8_t', 'target_component'], ['uint16_t', 'command'], ['uint8_t', 'confirmation'], ['float', 'param1'], ['float', 'param2'],
      ['float', 'param3'], ['float', 'param4'], ['float', 'param5'], ['float', 'param6'], ['float', 'param7']],
  },
  COMMAND_ACK: {
    id: 77, fields: [['uint16_t', 'command'], ['uint8_t', 'result']],
    ext: [['uint8_t', 'progress'], ['int32_t', 'result_param2'], ['uint8_t', 'target_system'], ['uint8_t', 'target_component']],
  },
  HIL_RC_INPUTS_RAW: {
    id: 92, ext: [],
    fields: [['uint64_t', 'time_usec'], ['uint16_t', 'chan1_raw'], ['uint16_t', 'chan2_raw'], ['uint16_t', 'chan3_raw'], ['uint16_t', 'chan4_raw'], ['uint16_t', 'chan5_raw'],
      ['uint16_t', 'chan6_raw'], ['uint16_t', 'chan7_raw'], ['uint16_t', 'chan8_raw'], ['uint16_t', 'chan9_raw'], ['uint16_t', 'chan10_raw'], ['uint16_t', 'chan11_raw'],
      ['uint16_t', 'chan12_raw'], ['uint8_t', 'rssi']],
  },
  HIL_ACTUATOR_CONTROLS: { id: 93, ext: [], fields: [['uint64_t', 'time_usec'], ['float[16]', 'controls'], ['uint8_t', 'mode'], ['uint64_t', 'flags']] },
  HIL_SENSOR: {
    id: 107, ext: [['uint8_t', 'id']],
    fields: [['uint64_t', 'time_usec'], ['float', 'xacc'], ['float', 'yacc'], ['float', 'zacc'], ['float', 'xgyro'], ['float', 'ygyro'], ['float', 'zgyro'],
      ['float', 'xmag'], ['float', 'ymag'], ['float', 'zmag'], ['float', 'abs_pressure'], ['float', 'diff_pressure'], ['float', 'pressure_alt'],
      ['float', 'temperature'], ['uint32_t', 'fields_updated']],
  },
  HIL_GPS: {
    id: 113, ext: [['uint8_t', 'id'], ['uint16_t', 'yaw']],
    fields: [['uint64_t', 'time_usec'], ['uint8_t', 'fix_type'], ['int32_t', 'lat'], ['int32_t', 'lon'], ['int32_t', 'alt'], ['uint16_t', 'eph'], ['uint16_t', 'epv'],
      ['uint16_t', 'vel'], ['int16_t', 'vn'], ['int16_t', 've'], ['int16_t', 'vd'], ['uint16_t', 'cog'], ['uint8_t', 'satellites_visible']],
  },
  HIL_OPTICAL_FLOW: {
    id: 114, ext: [],
    fields: [['uint64_t', 'time_usec'], ['uint8_t', 'sensor_id'], ['uint32_t', 'integration_time_us'], ['float', 'integrated_x'], ['float', 'integrated_y'],
      ['float', 'integrated_xgyro'], ['float', 'integrated_ygyro'], ['float', 'integrated_zgyro'], ['int16_t', 'temperature'], ['uint8_t', 'quality'],
      ['uint32_t', 'time_delta_distance_us'], ['float', 'distance']],
  },
  HIL_STATE_QUATERNION: {
    id: 115, ext: [],
    fields: [['uint64_t', 'time_usec'], ['float[4]', 'attitude_quaternion'], ['float', 'rollspeed'], ['float', 'pitchspeed'], ['float', 'yawspeed'], ['int32_t', 'lat'],
      ['int32_t', 'lon'], ['int32_t', 'alt'], ['int16_t', 'vx'], ['int16_t', 'vy'], ['int16_t', 'vz'], ['uint16_t', 'ind_airspeed'], ['uint16_t', 'true_airspeed'],
      ['int16_t', 'xacc'], ['int16_t', 'yacc'], ['int16_t', 'zacc']],
  },
  DISTANCE_SENSOR: {
    id: 132,
    fields: [['uint32_t', 'time_boot_ms'], ['uint16_t', 'min_distance'], ['uint16_t', 'max_distance'], ['uint16_t', 'current_distance'], ['uint8_t', 'type'],
      ['uint8_t', 'id'], ['uint8_t', 'orientation'], ['uint8_t', 'covariance']],
    ext: [['float', 'horizontal_fov'], ['float', 'vertical_fov'], ['float[4]', 'quaternion'], ['uint8_t', 'signal_quality']],
  },
} as const satisfies Record<string, MessageSpec>;

export type MsgName = keyof typeof SPECS;
type Value<T> = T extends `${string}]` ? number[] : number;
type FieldsOf<L extends readonly FieldSpec[]> = { [F in L[number] as F[1]]: Value<F[0]> };
type Flat<T> = { [K in keyof T]: T[K] };
/** Decoded payload of a message: XML field names; 64-bit integers as numbers (exact up to 2^53). */
export type MsgFields<N extends MsgName> = Flat<FieldsOf<(typeof SPECS)[N]['fields']> & FieldsOf<(typeof SPECS)[N]['ext']>>;

interface FrameInfo { sysid: number; compid: number; seq: number; version: 1 | 2; signed: boolean }
export type KnownMessage = { [N in MsgName]: FrameInfo & { name: N; msgid: (typeof SPECS)[N]['id']; fields: MsgFields<N> } }[MsgName];
/** A frame whose id has no spec here: passed through unvalidated (its CRC cannot be checked). */
export type UnknownMessage = FrameInfo & { name: null; msgid: number; payload: Uint8Array };
export type MavMessage = KnownMessage | UnknownMessage;
/** What encode() takes: missing fields encode as 0 (HEARTBEAT.mavlink_version as 3). */
export type OutMessage = { [N in MsgName]: { name: N; fields: Partial<MsgFields<N>> } }[MsgName];

const SIZE: Record<Base, number> = { uint8_t: 1, int8_t: 1, uint16_t: 2, int16_t: 2, uint32_t: 4, int32_t: 4, uint64_t: 8, int64_t: 8, float: 4, double: 8 };

interface Field { name: string; base: Base; size: number; len: number; offset: number } // len 0 = scalar
export interface MessageInfo {
  id: number; name: MsgName; crcExtra: number;
  minLength: number; // base fields only (MAVLink 1 payload length)
  maxLength: number; // with extensions
  fields: readonly Field[]; // wire order, with byte offsets
}

function parseSpec([type, name]: FieldSpec): Omit<Field, 'offset'> {
  const m = /^(\w+)(?:\[(\d+)\])?$/.exec(type)!;
  const base = m[1] as Base;
  return { name, base, size: SIZE[base], len: m[2] ? Number(m[2]) : 0 };
}

// ---- CRC ----

/** X.25 / CRC-16/MCRF4XX step (mavlink's crc_accumulate). */
export function crcAccumulate(byte: number, crc: number): number {
  let t = (byte ^ crc) & 0xff;
  t = (t ^ (t << 4)) & 0xff;
  return ((crc >> 8) ^ (t << 8) ^ (t << 3) ^ (t >> 4)) & 0xffff;
}

export function crcCalculate(bytes: ArrayLike<number>, crc = 0xffff): number {
  for (let i = 0; i < bytes.length; i++) crc = crcAccumulate(bytes[i], crc);
  return crc;
}

const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));

/** CRC_EXTRA as mavgen computes it, from the base (non-extension) fields in XML order. */
export function crcExtra(name: string, baseFields: readonly FieldSpec[]): number {
  let crc = crcCalculate(ascii(name + ' '));
  for (const f of wireOrder(baseFields.map(parseSpec))) {
    crc = crcCalculate(ascii(`${f.base} ${f.name} `), crc);
    if (f.len) crc = crcAccumulate(f.len, crc);
  }
  return (crc & 0xff) ^ (crc >> 8);
}

// Array.prototype.sort is stable (ES2019), matching Python's sorted(reverse=True) on ties.
const wireOrder = <T extends { size: number }>(f: T[]) => f.slice().sort((a, b) => b.size - a.size);

function compile(name: MsgName, spec: MessageSpec): MessageInfo {
  const ordered = [...wireOrder(spec.fields.map(parseSpec)), ...spec.ext.map(parseSpec)];
  let offset = 0, minLength = 0;
  const fields = ordered.map((f, i) => {
    const out = { ...f, offset };
    offset += f.size * (f.len || 1);
    if (i === spec.fields.length - 1) minLength = offset;
    return out;
  });
  return { id: spec.id, name, crcExtra: crcExtra(name, spec.fields), minLength, maxLength: offset, fields };
}

export const MESSAGES = Object.fromEntries(
  (Object.keys(SPECS) as MsgName[]).map((n) => [n, compile(n, SPECS[n])]),
) as { readonly [N in MsgName]: MessageInfo };
const BY_ID = new Map<number, MessageInfo>(Object.values(MESSAGES).map((m) => [m.id, m]));

export const MSG_ID = Object.fromEntries((Object.keys(SPECS) as MsgName[]).map((n) => [n, SPECS[n].id])) as { readonly [N in MsgName]: (typeof SPECS)[N]['id'] };

// ---- field access ----

function put(dv: DataView, o: number, base: Base, v: number): void {
  switch (base) {
    case 'uint8_t': dv.setUint8(o, v); break;
    case 'int8_t': dv.setInt8(o, v); break;
    case 'uint16_t': dv.setUint16(o, v, true); break;
    case 'int16_t': dv.setInt16(o, v, true); break;
    case 'uint32_t': dv.setUint32(o, v, true); break;
    case 'int32_t': dv.setInt32(o, v, true); break;
    case 'uint64_t': dv.setBigUint64(o, Number.isFinite(v) ? BigInt(Math.trunc(v)) : 0n, true); break;
    case 'int64_t': dv.setBigInt64(o, Number.isFinite(v) ? BigInt(Math.trunc(v)) : 0n, true); break;
    case 'float': dv.setFloat32(o, v, true); break;
    case 'double': dv.setFloat64(o, v, true); break;
  }
}

function get(dv: DataView, o: number, base: Base): number {
  switch (base) {
    case 'uint8_t': return dv.getUint8(o);
    case 'int8_t': return dv.getInt8(o);
    case 'uint16_t': return dv.getUint16(o, true);
    case 'int16_t': return dv.getInt16(o, true);
    case 'uint32_t': return dv.getUint32(o, true);
    case 'int32_t': return dv.getInt32(o, true);
    case 'uint64_t': return Number(dv.getBigUint64(o, true));
    case 'int64_t': return Number(dv.getBigInt64(o, true));
    case 'float': return dv.getFloat32(o, true);
    case 'double': return dv.getFloat64(o, true);
  }
}

/** Decode a payload (any length up to maxLength; shorter = zero-extended). */
export function decodeFields<N extends MsgName>(name: N, payload: Uint8Array): MsgFields<N> {
  const info = MESSAGES[name];
  const buf = new Uint8Array(info.maxLength);
  buf.set(payload.subarray(0, info.maxLength));
  const dv = new DataView(buf.buffer);
  const out: Record<string, number | number[]> = {};
  for (const f of info.fields) {
    out[f.name] = f.len ? Array.from({ length: f.len }, (_, k) => get(dv, f.offset + k * f.size, f.base)) : get(dv, f.offset, f.base);
  }
  return out as MsgFields<N>;
}

/** Full payload (maxLength bytes, untruncated). Integer fields take DataView's wrap/truncate semantics. */
export function encodeFields<N extends MsgName>(name: N, fields: Partial<MsgFields<N>>): Uint8Array {
  const info = MESSAGES[name];
  if (!info) throw new Error(`mavlink: no spec for message ${String(name)}`);
  const buf = new Uint8Array(info.maxLength);
  const dv = new DataView(buf.buffer);
  const vals = fields as Record<string, number | number[] | undefined>;
  for (const f of info.fields) {
    let v = vals[f.name];
    if (v === undefined && info.id === 0 && f.name === 'mavlink_version') v = MAVLINK_VERSION;
    if (v === undefined) continue;
    if (f.len) {
      const a = v as number[];
      for (let k = 0; k < Math.min(f.len, a.length); k++) put(dv, f.offset + k * f.size, f.base, a[k]);
    } else put(dv, f.offset, f.base, v as number);
  }
  return buf;
}

// ---- framing ----

export const STX_V1 = 0xfe;
export const STX_V2 = 0xfd;
export const MAVLINK_VERSION = 3; // <version> of common.xml / minimal.xml
const IFLAG_SIGNED = 0x01;
const SIGNATURE_LEN = 13;

export interface FrameHeader { sysid: number; compid: number; seq: number; mavlink1?: boolean }

/** One complete frame. v2 truncates trailing zero payload bytes; v1 (`mavlink1`) sends base fields only. */
export function encode(msg: OutMessage, h: FrameHeader): Uint8Array {
  const info = MESSAGES[msg.name];
  const full = encodeFields(msg.name, msg.fields);
  let len: number;
  if (h.mavlink1) {
    if (info.id > 0xff) throw new Error(`mavlink: ${info.name} (id ${info.id}) has no MAVLink 1 form`);
    len = info.minLength;
  } else {
    len = full.length;
    while (len > 1 && full[len - 1] === 0) len--;
  }
  const hl = h.mavlink1 ? 6 : 10;
  const out = new Uint8Array(hl + len + 2);
  if (h.mavlink1) out.set([STX_V1, len, h.seq & 0xff, h.sysid & 0xff, h.compid & 0xff, info.id]);
  else out.set([STX_V2, len, 0, 0, h.seq & 0xff, h.sysid & 0xff, h.compid & 0xff, info.id & 0xff, (info.id >> 8) & 0xff, info.id >> 16]);
  out.set(full.subarray(0, len), hl);
  const crc = crcAccumulate(info.crcExtra, crcCalculate(out.subarray(1, hl + len)));
  out[hl + len] = crc & 0xff;
  out[hl + len + 1] = crc >> 8;
  return out;
}

/**
 * Streaming frame parser: push() any chunking of the byte stream, get the complete frames back.
 * Bytes before a magic byte are dropped; a frame that fails its CRC (or has an impossible length
 * or unknown incompat flags) costs one byte and the scan resumes after its magic byte, so a real
 * frame hidden inside a false start is still found. Signed frames: the 13-byte signature is
 * skipped, not verified. Unknown ids cannot be CRC-checked and are returned as-is
 * ({ name: null, msgid, payload }) when the byte after them is a magic byte, so the last one of
 * a burst comes out with the next push. Like any MAVLink parser, a false magic byte whose header
 * claims more bytes than have arrived holds back what follows until they do (no noise on PX4's
 * TCP link).
 */
export class MavlinkParser {
  crcErrors = 0;
  droppedBytes = 0; // garbage + bytes of rejected frames
  private buf = new Uint8Array(0);

  push(bytes: Uint8Array): MavMessage[] {
    let b = bytes;
    if (this.buf.length) { b = new Uint8Array(this.buf.length + bytes.length); b.set(this.buf); b.set(bytes, this.buf.length); }
    const out: MavMessage[] = [];
    let i = 0;
    while (i < b.length) {
      if (b[i] !== STX_V2 && b[i] !== STX_V1) { i++; this.droppedBytes++; continue; }
      const v2 = b[i] === STX_V2, hl = v2 ? 10 : 6;
      if (b.length - i < hl) break;
      const len = b[i + 1], iflags = v2 ? b[i + 2] : 0;
      const msgid = v2 ? b[i + 7] | (b[i + 8] << 8) | (b[i + 9] << 16) : b[i + 5];
      const info = BY_ID.get(msgid);
      if ((iflags & ~IFLAG_SIGNED) || (info && (len > info.maxLength || (!v2 && len < info.minLength)))) { i++; this.droppedBytes++; continue; }
      const total = hl + len + 2 + (iflags & IFLAG_SIGNED ? SIGNATURE_LEN : 0);
      // an unknown id has no CRC to check, so it must at least be followed by a magic byte
      if (b.length - i < total + (info ? 0 : 1)) break;
      if (!info && b[i + total] !== STX_V2 && b[i + total] !== STX_V1) { i++; this.droppedBytes++; continue; }
      const frame = { sysid: b[i + (v2 ? 5 : 3)], compid: b[i + (v2 ? 6 : 4)], seq: b[i + (v2 ? 4 : 2)], version: v2 ? 2 as const : 1 as const, signed: (iflags & IFLAG_SIGNED) !== 0 };
      const payload = b.slice(i + hl, i + hl + len);
      if (info) {
        const crc = crcAccumulate(info.crcExtra, crcCalculate(b.subarray(i + 1, i + hl + len)));
        if (crc !== (b[i + hl + len] | (b[i + hl + len + 1] << 8))) { this.crcErrors++; i++; this.droppedBytes++; continue; }
        out.push({ ...frame, name: info.name, msgid: info.id, fields: decodeFields(info.name, payload) } as KnownMessage);
      } else {
        out.push({ ...frame, name: null, msgid, payload });
      }
      i += total;
    }
    this.buf = b.slice(i);
    return out;
  }
}

// ---- PX4 simulator interface constants ----

/** PX4 SITL connects to TCP 4560 + instance (px4-rc.mavlinksim). */
export const PX4_SIM_TCP_PORT = 4560;

/** HIL_SENSOR_UPDATED_FLAGS (common.xml). RESET is bit 31: combine with `>>> 0` to keep it unsigned. */
export const HIL_SENSOR_UPDATED = {
  XACC: 0x1, YACC: 0x2, ZACC: 0x4, XGYRO: 0x8, YGYRO: 0x10, ZGYRO: 0x20, XMAG: 0x40, YMAG: 0x80, ZMAG: 0x100,
  ABS_PRESSURE: 0x200, DIFF_PRESSURE: 0x400, PRESSURE_ALT: 0x800, TEMPERATURE: 0x1000, RESET: 0x80000000,
} as const;

/** The groups SimulatorMavlink.hpp's SensorSource tests with (fields_updated & G) == G. */
export const PX4_SENSOR_GROUP = {
  ACCEL: 0b111, GYRO: 0b111000, MAG: 0b111000000,
  BARO: 0b1101000000000, // abs_pressure | pressure_alt | temperature
  DIFF_PRESS: 0b10000000000,
} as const;

export const MAV_MODE_FLAG_CUSTOM_MODE_ENABLED = 1;
export const MAV_MODE_FLAG_SAFETY_ARMED = 128;
export const HIL_ACTUATOR_CONTROLS_FLAGS_LOCKSTEP = 1;
export const MAV_CMD_SET_MESSAGE_INTERVAL = 511;
export const MAV_AUTOPILOT_PX4 = 12;
export const MAV_RESULT_ACCEPTED = 0;
export const MAV_SENSOR_ROTATION_PITCH_270 = 25; // downward-facing DISTANCE_SENSOR

/** HIL_ACTUATOR_CONTROLS.controls index of each quad-X motor for PX4's iris airframes (0..1 throttle). */
export const PX4_QUAD_X = { FRONT_RIGHT_CCW: 0, REAR_LEFT_CCW: 1, FRONT_LEFT_CW: 2, REAR_RIGHT_CW: 3 } as const;
