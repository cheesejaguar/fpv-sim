// Node servers that connect an external autopilot to the simulator's plant (plant.ts):
//   - PX4 SITL: the simulator listens on TCP 4560; PX4 (`make px4_sitl none_iris`, or any PX4
//     started with `simulator_mavlink -c 4560`) connects. Lock-step: each HIL_ACTUATOR_CONTROLS
//     from PX4 advances the plant one PX4 step and answers with the next HIL_SENSOR (plus HIL_GPS,
//     DISTANCE_SENSOR, HIL_OPTICAL_FLOW, HIL_STATE_QUATERNION at their rates). Until PX4's first
//     outputs arrive the plant runs on the wall clock so PX4 can boot.
//   - ArduPilot SITL: the simulator listens on UDP 9002; ArduPilot started with
//     `--model JSON:127.0.0.1` sends servo packets and gets one JSON state line per new frame
//     (lock-step on frame_count).
// Protocol details and sources: mavlink.ts and ardupilotJson.ts. Node only (net, dgram).
import { createSocket, RemoteInfo } from 'node:dgram';
import { createServer, Server, Socket } from 'node:net';
import { AP_JSON_PORT, parseServoPacket, quatEnuFluToNedFrd, stateJson } from './ardupilotJson';
import { encode, HIL_ACTUATOR_CONTROLS_FLAGS_LOCKSTEP, HIL_SENSOR_UPDATED, MAV_AUTOPILOT_PX4, MAV_SENSOR_ROTATION_PITCH_270, MavlinkParser, OutMessage, PX4_SIM_TCP_PORT } from './mavlink';
import { SitlPlant } from './plant';

export interface SitlOptions {
  host?: string;
  port?: number;
  /** PX4: sensor (lock-step) rate, Hz; default 250 (PX4's IMU_INTEG_RATE) */
  sensorHz?: number;
  gpsHz?: number;
  log?: (text: string) => void;
}

const FIELDS_ALL = (HIL_SENSOR_UPDATED.XACC | HIL_SENSOR_UPDATED.YACC | HIL_SENSOR_UPDATED.ZACC | HIL_SENSOR_UPDATED.XGYRO | HIL_SENSOR_UPDATED.YGYRO | HIL_SENSOR_UPDATED.ZGYRO
  | HIL_SENSOR_UPDATED.XMAG | HIL_SENSOR_UPDATED.YMAG | HIL_SENSOR_UPDATED.ZMAG | HIL_SENSOR_UPDATED.ABS_PRESSURE | HIL_SENSOR_UPDATED.PRESSURE_ALT | HIL_SENSOR_UPDATED.TEMPERATURE) >>> 0;
const FIELDS_IMU_BARO = (FIELDS_ALL & ~(HIL_SENSOR_UPDATED.XMAG | HIL_SENSOR_UPDATED.YMAG | HIL_SENSOR_UPDATED.ZMAG)) >>> 0;

/** One PX4 connection driving the plant. */
export class Px4Link {
  private parser = new MavlinkParser();
  private seq = 0;
  private cycles = 0;
  private gotControls = false;
  private pacer: ReturnType<typeof setInterval> | null = null;
  private hb: ReturnType<typeof setInterval> | null = null;
  private flowAcc = { x: 0, y: 0, gx: 0, gy: 0, gz: 0, dt: 0 };
  /** PX4's armed flag from its last outputs */
  armed = false;
  readonly dt: number;
  private readonly gpsEvery: number;

  constructor(private plant: SitlPlant, private send: (b: Uint8Array) => void, private opts: SitlOptions = {}) {
    this.dt = 1 / (opts.sensorHz ?? 250);
    this.gpsEvery = Math.max(1, Math.round((opts.sensorHz ?? 250) / (opts.gpsHz ?? 10)));
  }

  /** Start: sensors on the wall clock until PX4's mixer answers, a heartbeat every second. */
  start() {
    this.pacer = setInterval(() => { if (!this.gotControls) this.cycle(); }, this.dt * 1000);
    this.hb = setInterval(() => this.msg({ name: 'HEARTBEAT', fields: { type: 2, autopilot: 8, base_mode: 0, system_status: 4 } }), 1000);
    this.cycle();
  }

  stop() { if (this.pacer) clearInterval(this.pacer); if (this.hb) clearInterval(this.hb); this.pacer = this.hb = null; }

  private msg(m: OutMessage) { this.send(encode(m, { sysid: 1, compid: 51, seq: this.seq++ & 0xff })); }

  /** Bytes from PX4. */
  receive(bytes: Uint8Array) {
    for (const m of this.parser.push(bytes)) {
      if (m.name === 'HIL_ACTUATOR_CONTROLS') {
        const f = m.fields;
        this.armed = (f.mode & 128) !== 0;
        this.plant.setMotors(this.armed ? Array.from(f.controls).slice(0, 4) : [0, 0, 0, 0]);
        if (!this.gotControls) { this.gotControls = true; this.opts.log?.(`PX4 is flying the plant (lock-step: ${(f.flags & HIL_ACTUATOR_CONTROLS_FLAGS_LOCKSTEP) !== 0})`); }
        this.cycle();
      } else if (m.name === 'HEARTBEAT' && m.fields.autopilot === MAV_AUTOPILOT_PX4 && this.cycles < 2) this.opts.log?.('PX4 connected');
      else if (m.name === 'COMMAND_LONG') { /* SET_MESSAGE_INTERVAL for ground truth: it is sent anyway */ }
    }
  }

  /** One PX4 step: the plant advances dt, then the sensors go out. */
  cycle() {
    const p = this.plant, core = p.core;
    if (this.cycles > 0) p.step(this.dt);
    this.cycles++;
    const tUs = Math.round(core.simT * 1e6) + 1;
    const imu = p.readImu(), baro = p.baro(), nav = p.nav();
    this.msg({
      name: 'HIL_SENSOR', fields: {
        time_usec: tUs,
        xacc: imu.acc.x, yacc: -imu.acc.y, zacc: -imu.acc.z,
        xgyro: imu.gyro.x, ygyro: -imu.gyro.y, zgyro: -imu.gyro.z,
        xmag: nav.mag[0], ymag: -nav.mag[1], zmag: -nav.mag[2],
        abs_pressure: baro.pa / 100, pressure_alt: baro.altM, temperature: baro.tempC,
        fields_updated: this.cycles % 2 ? FIELDS_ALL : FIELDS_IMU_BARO, id: 0,
      },
    });
    // optical flow: integrated over the flow sensor's period (every 4th step), with the gyro
    if (nav.flow) {
      const a = this.flowAcc;
      a.x += nav.flow.x * this.dt; a.y += nav.flow.y * this.dt;
      a.gx += imu.gyro.x * this.dt; a.gy += -imu.gyro.y * this.dt; a.gz += -imu.gyro.z * this.dt; a.dt += this.dt;
    }
    if (this.cycles % 4 === 0) {
      if (nav.rangeM !== null) this.msg({ name: 'DISTANCE_SENSOR', fields: { time_boot_ms: Math.round(core.simT * 1000), min_distance: 5, max_distance: 1200, current_distance: Math.round(nav.rangeM * 100), type: 0, id: 0, orientation: MAV_SENSOR_ROTATION_PITCH_270, covariance: 0 } });
      const a = this.flowAcc;
      if (a.dt > 0 && nav.flow) {
        // FRD: flow about x / y with PX4's sign (rotation the camera sees)
        this.msg({ name: 'HIL_OPTICAL_FLOW', fields: { time_usec: tUs, sensor_id: 0, integration_time_us: Math.round(a.dt * 1e6), integrated_x: a.x, integrated_y: -a.y, integrated_xgyro: a.gx, integrated_ygyro: a.gy, integrated_zgyro: a.gz, temperature: Math.round(baro.tempC * 100), quality: nav.flow.quality, time_delta_distance_us: 0, distance: nav.rangeM ?? -1 } });
      }
      this.flowAcc = { x: 0, y: 0, gx: 0, gy: 0, gz: 0, dt: 0 };
      // ground truth for PX4's logs (never fed to its estimator)
      const s = core.quad.s, qn = quatEnuFluToNedFrd(s.q), g = p.geo(s.pos);
      this.msg({ name: 'HIL_STATE_QUATERNION', fields: { time_usec: tUs, attitude_quaternion: [qn.w, qn.x, qn.y, qn.z], rollspeed: s.w.x, pitchspeed: -s.w.y, yawspeed: -s.w.z, lat: Math.round(g.lat * 1e7), lon: Math.round(g.lon * 1e7), alt: Math.round(g.altM * 1000), vx: Math.round(s.vel.y * 100), vy: Math.round(s.vel.x * 100), vz: Math.round(-s.vel.z * 100), ind_airspeed: 0, true_airspeed: 0, xacc: 0, yacc: 0, zacc: 0 } });
    }
    if (this.cycles % this.gpsEvery === 1 || this.gpsEvery === 1) {
      const fx = p.gnss();
      const vh = Math.hypot(fx.vel.x, fx.vel.y);
      let cog = Math.round(((Math.atan2(fx.vel.x, fx.vel.y) * 180) / Math.PI + 360) % 360 * 100);
      if (vh < 0.2) cog = 65535;
      this.msg({
        name: 'HIL_GPS', fields: {
          time_usec: tUs, fix_type: fx.fix, lat: Math.round(fx.lat * 1e7), lon: Math.round(fx.lon * 1e7), alt: Math.round(fx.altM * 1000),
          eph: Math.round(fx.ephM * 100), epv: Math.round(fx.epvM * 100), vel: Math.round(vh * 100),
          vn: Math.round(fx.vel.y * 100), ve: Math.round(fx.vel.x * 100), vd: Math.round(-fx.vel.z * 100), cog, satellites_visible: fx.numSV, id: 0, yaw: 0,
        },
      });
    }
  }
}

/** Listen for PX4 on TCP (one autopilot at a time). */
export function servePx4(plant: SitlPlant, opts: SitlOptions = {}): Promise<Server> {
  const log = opts.log ?? (() => {});
  let current: { sock: Socket; link: Px4Link } | null = null;
  const srv = createServer((sock) => {
    if (current) { log('a second PX4 connected: the first one is dropped'); current.link.stop(); current.sock.destroy(); }
    sock.setNoDelay(true);
    const link = new Px4Link(plant, (b) => { if (!sock.destroyed) sock.write(b); }, opts);
    current = { sock, link };
    log(`PX4 connection from ${sock.remoteAddress}:${sock.remotePort}`);
    sock.on('data', (d: Buffer) => link.receive(new Uint8Array(d.buffer, d.byteOffset, d.byteLength)));
    sock.on('close', () => { link.stop(); if (current?.sock === sock) current = null; log('PX4 disconnected'); });
    sock.on('error', () => {});
    link.start();
  });
  return new Promise((res, rej) => { srv.once('error', rej); srv.listen(opts.port ?? PX4_SIM_TCP_PORT, opts.host ?? '127.0.0.1', () => res(srv)); });
}

/** One ArduPilot: answers each servo packet (lock-step on frame_count). Returns the reply, or null. */
export class ArduPilotLink {
  private lastFrame = -1;
  private warned = false;
  frames = 0;
  constructor(private plant: SitlPlant, private opts: SitlOptions = {}) {}

  /** A datagram from ArduPilot: its state reply (to send back to the sender), or null to ignore it. */
  receive(bytes: Uint8Array): string | null {
    const pkt = parseServoPacket(bytes);
    if (!pkt) { if (!this.warned) { this.warned = true; this.opts.log?.(`ArduPilot: ignored a ${bytes.length}-byte packet (not a servo packet)`); } return null; }
    const p = this.plant, core = p.core;
    if (pkt.frameCount < this.lastFrame) this.opts.log?.('ArduPilot restarted');
    if (pkt.frameCount !== this.lastFrame) {
      this.lastFrame = pkt.frameCount;
      p.setMotors(pkt.pwm.slice(0, 4).map((us) => (us >= 1000 ? (us - 1000) / 1000 : 0)));
      if (this.frames > 0) p.step(1 / Math.max(50, pkt.frameRate || 1000));
      this.frames++;
    }
    const s = core.quad.s, imu = p.readImu(), nav = p.nav();
    // ArduPilot simulates its own GPS receiver from `position`, so a spoofer's counterfeit offset is
    // applied there (GNSS jamming / loss: ArduPilot's SIM_GPS1_ENABLE; see docs/AUTOPILOTS.md)
    const off = core.ops!.gnssReport().offset ?? { x: 0, y: 0, z: 0 };
    const pos = { x: s.pos.x - p.home.x + off.x, y: s.pos.y - p.home.y + off.y, z: s.pos.z - p.home.z + off.z };
    return stateJson({
      time: core.simT, pos, vel: { ...s.vel }, q: { ...s.q }, gyro: imu.gyro, accel: imu.acc,
      rng: nav.rangeM !== null ? [nav.rangeM] : undefined,
      battery: { voltage: s.vbus, current: s.ibus },
    });
  }
}

/** Listen for ArduPilot on UDP 9002. */
export function serveArduPilot(plant: SitlPlant, opts: SitlOptions = {}): Promise<ReturnType<typeof createSocket>> {
  const sock = createSocket('udp4');
  const link = new ArduPilotLink(plant, opts);
  let peer = '';
  sock.on('message', (msg: Buffer, rinfo: RemoteInfo) => {
    const who = `${rinfo.address}:${rinfo.port}`;
    if (who !== peer) { peer = who; opts.log?.(`ArduPilot at ${who}`); }
    const reply = link.receive(new Uint8Array(msg.buffer, msg.byteOffset, msg.byteLength));
    if (reply) sock.send(reply, rinfo.port, rinfo.address);
  });
  return new Promise((res, rej) => { sock.once('error', rej); sock.bind(opts.port ?? AP_JSON_PORT, opts.host ?? '127.0.0.1', () => res(sock)); });
}
