// The simulator's end of ArduPilot (src/ap/apHost.mjs runs the firmware in its own thread):
//   - ArduPilotLink: lock-step through shared memory. Once per ArduPilot physics frame (1 ms) the
//     flight core writes the plant's state line and waits for the servo packet ArduPilot computes
//     from it (tens of microseconds of ArduPilot's time), so the firmware runs exactly as fast as
//     the simulation: slowed down, paused or faster than real time alike.
//   - ApHub: the simulator's own ground station on SERIAL0: reads what the HUD shows (HEARTBEAT,
//     ATTITUDE, VFR_HUD, GPS, battery, mission progress, STATUSTEXT), and sends what the app asks
//     for: parameters, a mission (the MAVLink mission protocol), modes, arming.
// SERIAL1 is a raw pass-through: the API relays it to any MAVLink ground station or script.
import { AP, AP_BYTES, ApHostMessage, ApInit, ByteRing, ringOffset } from './apHost.mjs';
import { ApVehicle, modeName } from './apConfig';
import { encode, MavlinkParser, mavChars, mavString, MavMessage, OutMessage } from '../sitl/mavlink';

/** Starts the firmware thread (a Web Worker, a Node worker thread); terminate() stops it. */
export type ApSpawn = (init: ApInit, onMessage: (m: ApHostMessage) => void) => { terminate(): void };

export type ApStatus = 'loading' | 'running' | 'exited' | 'failed';

/** One ArduPilot physics frame (s): the plant answers every frame. */
export const AP_FRAME_DT = 0.001;

export class ArduPilotLink {
  readonly sab = new SharedArrayBuffer(AP_BYTES);
  readonly ctrl = new Int32Array(this.sab, 0, AP.CTRL_INTS);
  /** the latest servo outputs (PWM us; 0 = output not driven) */
  readonly pwm = new Uint16Array(AP.SERVO_MAX);
  private readonly servoShared = new Uint16Array(this.sab, AP.SERVO_OFF, AP.SERVO_MAX);
  private readonly stateBuf = new Uint8Array(this.sab, AP.STATE_OFF, AP.STATE_MAX);
  /** MAVLink: [port][0] to ArduPilot, [port][1] from ArduPilot */
  readonly rings: [ByteRing, ByteRing][] = [];
  readonly hub: ApHub;
  private readonly enc = new TextEncoder();
  private seenFrame = -1;
  private synced = false;
  private thread: { terminate(): void } | null = null;
  private failReason = '';
  /** ArduPilot's physics clock (s): one frame per state line */
  apTime = 0;
  /** frames ArduPilot did not answer in time (the plant went on with the last outputs) */
  stalls = 0;
  frames = 0;

  constructor(readonly vehicle: ApVehicle, init: Omit<ApInit, 'sab'>, spawn: ApSpawn, private onLog: (text: string) => void = () => {}) {
    for (let p = 0; p < AP.PORTS; p++) this.rings.push([new ByteRing(this.sab, ringOffset(p, 0)), new ByteRing(this.sab, ringOffset(p, 1))]);
    this.hub = new ApHub(vehicle, this.rings[0], onLog);
    this.thread = spawn({ ...init, sab: this.sab }, (m) => {
      if (m.type === 'log') this.onLog(m.text);
      else if (m.type === 'error') { this.failReason = m.reason; this.onLog(m.reason); }
      else if (m.type === 'exit') this.onLog(`ArduPilot exited (code ${m.code})`);
    });
  }

  get status(): ApStatus {
    const s = Atomics.load(this.ctrl, AP.STATUS);
    return s === AP.RUNNING ? 'running' : s === AP.EXITED ? 'exited' : s === AP.FAILED ? 'failed' : 'loading';
  }

  /** why it failed to load, if it did */
  get failure(): string { return this.failReason; }

  /** ArduPilot has sent its first servo packet: the plant answers every frame from now on. */
  get live(): boolean { return this.synced; }

  private takeServos() {
    this.seenFrame = Atomics.load(this.ctrl, AP.SERVO_FRAME);
    const n = Math.min(AP.SERVO_MAX, Atomics.load(this.ctrl, AP.SERVO_N) || 16);
    for (let k = 0; k < AP.SERVO_MAX; k++) this.pwm[k] = k < n ? this.servoShared[k] : 0;
  }

  /**
   * One frame: hand ArduPilot the state line (stateJson's "\n{...}\n") and wait up to waitMs for the
   * servo packet it computes from it. True when fresh outputs arrived (they are in pwm). Before
   * ArduPilot's first packet (it is still loading or booting) nothing is sent and nothing waited for.
   */
  exchange(stateLine: string, waitMs: number): boolean {
    if (Atomics.load(this.ctrl, AP.STATUS) !== AP.RUNNING) return false;
    if (!this.synced) {
      if (Atomics.load(this.ctrl, AP.SERVO_SEQ) === 0) return false;
      this.synced = true;
      this.takeServos();
    }
    const r = this.enc.encodeInto(stateLine, this.stateBuf);
    Atomics.store(this.ctrl, AP.STATE_LEN, r.written);
    Atomics.add(this.ctrl, AP.STATE_SEQ, 1);
    Atomics.notify(this.ctrl, AP.STATE_SEQ);
    this.apTime += AP_FRAME_DT;
    this.frames++;
    const deadline = performance.now() + waitMs;
    for (;;) {
      const seq = Atomics.load(this.ctrl, AP.SERVO_SEQ);
      // a new frame number (a resend after a long pause repeats the last one)
      if (Atomics.load(this.ctrl, AP.SERVO_FRAME) !== this.seenFrame) { this.takeServos(); return true; }
      if (Atomics.load(this.ctrl, AP.STATUS) !== AP.RUNNING) return false;
      const left = deadline - performance.now();
      if (left <= 0) { this.stalls++; return false; }
      Atomics.wait(this.ctrl, AP.SERVO_SEQ, seq, left);
    }
  }

  /** Raw MAVLink bytes to ArduPilot on a port (1: the API's pass-through); returns how many fit. */
  write(port: number, bytes: Uint8Array): number { return this.rings[port]?.[0].write(bytes) ?? 0; }

  /** Raw MAVLink bytes from ArduPilot on a port (everything waiting). */
  read(port: number): Uint8Array {
    const r = this.rings[port]?.[1];
    if (!r || !r.size) return new Uint8Array(0);
    const out = new Uint8Array(r.size);
    return out.subarray(0, r.read(out, 0, out.length));
  }

  terminate() { this.thread?.terminate(); this.thread = null; }
}

// ---------------------------------------------------------------------------------------------

/** What the simulator's ground station knows about the vehicle (the HUD shows it). */
export interface ApTelemetry {
  /** a HEARTBEAT came in */
  connected: boolean;
  armed: boolean;
  mode: number; modeName: string;
  /** rad (NED Euler) */
  roll: number; pitch: number; yaw: number;
  airspeed: number; groundspeed: number; climb: number; throttle: number; headingDeg: number;
  /** altitude above home (m) and AMSL (m) */
  relAlt: number; altMsl: number;
  lat: number; lon: number;
  gpsFix: number; sats: number;
  voltage: number; current: number; remaining: number;
  wpSeq: number; wpTotal: number; wpDist: number;
  /** the last STATUSTEXT lines (newest last) */
  texts: { t: number; severity: number; text: string }[];
}

export const emptyApTelemetry = (): ApTelemetry => ({
  connected: false, armed: false, mode: -1, modeName: '—', roll: 0, pitch: 0, yaw: 0, airspeed: 0, groundspeed: 0, climb: 0, throttle: 0, headingDeg: 0,
  relAlt: 0, altMsl: 0, lat: 0, lon: 0, gpsFix: 0, sats: 0, voltage: 0, current: 0, remaining: -1, wpSeq: 0, wpTotal: 0, wpDist: 0, texts: [],
});

/** A mission item in the simulator's terms (MAVLink MISSION_ITEM_INT, frame GLOBAL_RELATIVE_ALT_INT unless set). */
export interface ApMissionItem {
  command: number;
  lat: number; lon: number; alt: number;
  params?: [number, number, number, number];
  frame?: number;
}

/** MAV_CMD numbers the map builder's missions use. */
export const MAV_CMD = { NAV_WAYPOINT: 16, NAV_LOITER_UNLIM: 17, NAV_LOITER_TURNS: 18, NAV_RETURN_TO_LAUNCH: 20, NAV_LAND: 21, NAV_TAKEOFF: 22, DO_CHANGE_SPEED: 178, DO_JUMP: 177, COMPONENT_ARM_DISARM: 400, DO_SET_MODE: 176 } as const;
const MAV_FRAME_GLOBAL_RELATIVE_ALT_INT = 6;
const MAV_PARAM_TYPE_REAL32 = 9;
const GCS = { sysid: 255, compid: 190 };

/** The simulator's ground station on SERIAL0. pump() it every frame or so. */
export class ApHub {
  readonly tel = emptyApTelemetry();
  private parser = new MavlinkParser();
  private seq = 0;
  private hbAcc = 1;
  private t = 0;
  /** the vehicle's system id (from its HEARTBEAT) */
  private sys = 1;
  private upload: { items: ApMissionItem[]; t0: number; done: (ok: boolean, why: string) => void } | null = null;
  private pendingParams = new Map<string, { value: number; tries: number; t: number }>();
  /** every message from the vehicle (the app's MAVLink inspector, tests) */
  onMessage: ((m: MavMessage) => void) | null = null;
  /** a parameter's value as the vehicle reports it (PARAM_VALUE) */
  readonly paramValues = new Map<string, number>();

  constructor(readonly vehicle: ApVehicle, private ring: [ByteRing, ByteRing], private onLog: (text: string) => void) {}

  send(msg: OutMessage) {
    const bytes = encode(msg, { ...GCS, seq: this.seq++ & 0xff });
    this.ring[0].write(bytes);
  }

  /** Read and act on everything that came in; send the 1 Hz heartbeat. dt: time since the last pump (s). */
  pump(dt: number) {
    this.t += dt;
    this.hbAcc += dt;
    if (this.hbAcc >= 1) {
      this.hbAcc = 0;
      this.send({ name: 'HEARTBEAT', fields: { type: 6, autopilot: 8, base_mode: 0, custom_mode: 0, system_status: 4 } }); // GCS, invalid autopilot
      // parameters the vehicle has not confirmed yet: once a second, a few times
      for (const [id, p] of this.pendingParams) {
        if (p.tries >= 5) { this.pendingParams.delete(id); this.onLog(`ArduPilot did not confirm ${id}`); continue; }
        p.tries++; this.sendParam(id, p.value);
      }
    }
    const r = this.ring[1];
    if (!r.size) return;
    const buf = new Uint8Array(r.size);
    for (const m of this.parser.push(buf.subarray(0, r.read(buf, 0, buf.length)))) this.handle(m);
    if (this.upload && this.t - this.upload.t0 > 5) { const u = this.upload; this.upload = null; u.done(false, 'no answer from ArduPilot'); }
  }

  private handle(m: MavMessage) {
    this.onMessage?.(m);
    const tel = this.tel;
    switch (m.name) {
      case 'HEARTBEAT':
        if (m.compid !== 1 || m.fields.autopilot !== 3) break; // ArduPilot's own (MAV_AUTOPILOT_ARDUPILOTMEGA)
        this.sys = m.sysid;
        tel.connected = true;
        tel.armed = (m.fields.base_mode & 128) !== 0;
        if (tel.mode !== m.fields.custom_mode) { tel.mode = m.fields.custom_mode; tel.modeName = modeName(this.vehicle, tel.mode); }
        break;
      case 'ATTITUDE': tel.roll = m.fields.roll; tel.pitch = m.fields.pitch; tel.yaw = m.fields.yaw; break;
      case 'VFR_HUD':
        tel.airspeed = m.fields.airspeed; tel.groundspeed = m.fields.groundspeed; tel.climb = m.fields.climb;
        tel.throttle = m.fields.throttle; tel.headingDeg = m.fields.heading; tel.altMsl = m.fields.alt;
        break;
      case 'GLOBAL_POSITION_INT': tel.relAlt = m.fields.relative_alt / 1000; tel.lat = m.fields.lat / 1e7; tel.lon = m.fields.lon / 1e7; break;
      case 'GPS_RAW_INT': tel.gpsFix = m.fields.fix_type; tel.sats = m.fields.satellites_visible; break;
      case 'SYS_STATUS': tel.voltage = m.fields.voltage_battery / 1000; tel.current = m.fields.current_battery / 100; tel.remaining = m.fields.battery_remaining; break;
      case 'MISSION_CURRENT': tel.wpSeq = m.fields.seq; if (m.fields.total) tel.wpTotal = m.fields.total; break;
      case 'NAV_CONTROLLER_OUTPUT': tel.wpDist = m.fields.wp_dist; break;
      case 'STATUSTEXT': {
        const text = mavString(m.fields.text);
        tel.texts.push({ t: this.t, severity: m.fields.severity, text });
        if (tel.texts.length > 8) tel.texts.shift();
        this.onLog(`ArduPilot: ${text}`);
        break;
      }
      case 'PARAM_VALUE': {
        const id = mavString(m.fields.param_id);
        this.paramValues.set(id, m.fields.param_value);
        const p = this.pendingParams.get(id);
        if (p && Math.abs(p.value - m.fields.param_value) <= 1e-6 * Math.max(1, Math.abs(p.value))) this.pendingParams.delete(id);
        break;
      }
      case 'MISSION_REQUEST_INT': case 'MISSION_REQUEST': this.sendItem(m.fields.seq); break;
      case 'MISSION_ACK': {
        const u = this.upload;
        if (!u) break;
        this.upload = null;
        u.done(m.fields.type === 0, m.fields.type === 0 ? 'accepted' : `refused (MAV_MISSION_RESULT ${m.fields.type})`);
        if (m.fields.type === 0) this.tel.wpTotal = u.items.length;
        break;
      }
    }
  }

  private sendParam(id: string, value: number) {
    this.send({ name: 'PARAM_SET', fields: { target_system: this.sys, target_component: 1, param_id: mavChars(id, 16), param_value: value, param_type: MAV_PARAM_TYPE_REAL32 } });
  }

  /** Set parameters (resent until the vehicle confirms each). */
  setParams(ps: Record<string, number>) {
    for (const [id, value] of Object.entries(ps)) { this.pendingParams.set(id, { value, tries: 1, t: this.t }); this.sendParam(id, value); }
  }

  /** Ask for one parameter's value (it arrives in paramValues). */
  requestParam(id: string) {
    this.send({ name: 'PARAM_REQUEST_READ', fields: { target_system: this.sys, target_component: 1, param_id: mavChars(id, 16), param_index: -1 } });
  }

  /**
   * Upload a mission. ArduPilot's item 0 is home (it overwrites it): the items given become 1..n.
   * done(ok, why) when ArduPilot accepts or refuses it, or after 5 s without an answer.
   */
  uploadMission(items: ApMissionItem[], done: (ok: boolean, why: string) => void = () => {}) {
    if (this.upload) this.upload.done(false, 'replaced by a newer upload');
    const home: ApMissionItem = { command: MAV_CMD.NAV_WAYPOINT, lat: this.tel.lat, lon: this.tel.lon, alt: 0, frame: 0 };
    this.upload = { items: [home, ...items], t0: this.t, done };
    this.send({ name: 'MISSION_COUNT', fields: { target_system: this.sys, target_component: 1, count: items.length + 1, mission_type: 0 } });
  }

  private sendItem(seq: number) {
    const u = this.upload;
    const it = u?.items[seq];
    if (!u || !it) return;
    u.t0 = this.t;
    const pr = it.params ?? [0, 0, 0, 0];
    this.send({ name: 'MISSION_ITEM_INT', fields: {
      target_system: this.sys, target_component: 1, seq, frame: it.frame ?? MAV_FRAME_GLOBAL_RELATIVE_ALT_INT, command: it.command,
      current: 0, autocontinue: 1, param1: pr[0], param2: pr[1], param3: pr[2], param4: pr[3],
      x: Math.round(it.lat * 1e7), y: Math.round(it.lon * 1e7), z: it.alt, mission_type: 0,
    } });
  }

  /** COMMAND_LONG to the autopilot. */
  command(command: number, params: number[] = []) {
    const p = (i: number) => params[i] ?? 0;
    this.send({ name: 'COMMAND_LONG', fields: { target_system: this.sys, target_component: 1, command, confirmation: 0, param1: p(0), param2: p(1), param3: p(2), param4: p(3), param5: p(4), param6: p(5), param7: p(6) } });
  }

  /** Switch flight mode by its custom_mode number. */
  setMode(mode: number) { this.command(MAV_CMD.DO_SET_MODE, [1, mode]); }

  /** Arm or disarm (force: skip the pre-arm checks / disarm in flight). */
  arm(on: boolean, force = false) { this.command(MAV_CMD.COMPONENT_ARM_DISARM, [on ? 1 : 0, force ? 21196 : 0]); }
}
