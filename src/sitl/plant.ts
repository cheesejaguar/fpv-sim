// The simulator as the physics plant of an external autopilot (PX4 or ArduPilot SITL): the same
// flight core, rotors, battery, wind, contacts and operational layer (jamming, spoofing, faults,
// payload) as the Betaflight simulator, with the autopilot's motor outputs in place of the
// firmware, and the sensors those autopilots read: IMU (averaged over each autopilot step, as a
// real driver's FIFO read would deliver it), barometer, magnetometer, GNSS (with the jamming /
// spoofing / fault model), downward rangefinder and optical flow.
// The servers that speak each autopilot's protocol are in src/sitl/server.ts.
import { buildDrone, DroneSpec, preloadPropTable } from '../builder/derive';
import { MAPS, preloadMap } from '../maps/maps';
import { spawnGroundZ, withCourse } from '../maps/world';
import { isa } from '../sim/atmosphere';
import type { V3 } from '../sim/math';
import { defaultScenario, Episode, parseScenario, resolveEpisode, Scenario } from '../scenario/scenario';
import { FlightCore } from '../worker/flightCore';
import { GPS_ORIGIN } from '../worker/ubxGps';

/** Autopilot motor order for a quad X (PX4 and ArduPilot agree): front-right, rear-left, front-left, rear-right. */
export const QUAD_X_TO_BF = [1, 2, 3, 0];

export interface ImuSample { gyro: V3; acc: V3 }
export interface GnssFix { lat: number; lon: number; altM: number; vel: V3; numSV: number; fix: 0 | 3; ephM: number; epvM: number }

export class SitlPlant {
  core!: FlightCore;
  episode!: Episode;
  /** home (the start position, ENU m) */
  home: V3 = { x: 0, y: 0, z: 0 };
  // IMU accumulation between autopilot reads
  private gSum: V3 = { x: 0, y: 0, z: 0 }; private aSum: V3 = { x: 0, y: 0, z: 0 }; private nSum = 0;
  private linkAcc = 0;
  /** every simulator message (ops events included) */
  onLog: ((text: string) => void) | null = null;

  /** Build the scenario's world and drone (no firmware), at its start, motors stopped. */
  async reset(raw?: unknown, seed?: number): Promise<{ episode: Episode }> {
    let sc: Scenario;
    if (raw !== undefined) {
      const { scenario, errors } = parseScenario(raw, (id) => id in MAPS);
      if (!scenario) throw new Error(`invalid scenario:\n  ${errors.join('\n  ')}`);
      sc = scenario;
    } else sc = defaultScenario({ map: { id: 'field' } });
    const ep = resolveEpisode(sc, seed);
    // PX4 / ArduPilot quad X spin directions are Betaflight's "props in"
    const spec: DroneSpec = { ...ep.spec, propDirection: 'props-in' };
    this.episode = { ...ep, spec };
    await Promise.all([preloadMap(ep.mapId), preloadPropTable(spec.prop)]);
    const core = this.core = new FlightCore({ sticks: () => {}, log: (t) => this.onLog?.(t) }, { seed: ep.seed });
    core.settings = { ...ep.settings, autoRate: false };
    core.spec = spec;
    core.setMap(withCourse(MAPS[ep.mapId](), ep.courseId));
    core.buildQuad();
    core.external = new Float32Array(core.quad.motors.length);
    const sp = core.map.spawn, st = ep.start, off = st.offset;
    const floor = (x: number, y: number) => core.map.terrain(x, y) + 0.06 - Math.min(...core.build.params.colliders.map((c) => c.pos.z - c.radius));
    const base = st.pos ? { x: st.pos[0], y: st.pos[1], z: st.pos[2] } : { x: sp.pos.x, y: sp.pos.y, z: spawnGroundZ(core.map) };
    const pos = { x: base.x + off[0], y: base.y + off[1], z: 0 };
    pos.z = Math.max(base.z + off[2], floor(pos.x, pos.y));
    const yaw = ((st.yawDeg ?? (sp.yaw * 180) / Math.PI) + st.yawOffsetDeg) * (Math.PI / 180);
    core.placeAt(pos, yaw);
    this.home = { ...core.quad.s.pos };
    core.setOps(ep.ops ?? {});
    core.ops!.onEvent = (e) => this.onLog?.(`ops: ${JSON.stringify(e)}`);
    this.clearImu();
    return { episode: this.episode };
  }

  /** Autopilot outputs in its own quad-X order (0..1; 0 = motor stopped). */
  setMotors(out: ArrayLike<number>, order: number[] = QUAD_X_TO_BF) {
    const ext = this.core.external!;
    for (let i = 0; i < Math.min(out.length, order.length); i++) ext[order[i]] = Math.max(0, Math.min(1, out[i] || 0));
  }

  /** Advance the plant by dt seconds (whole physics steps), averaging the IMU for the next read. */
  step(dt: number) {
    const core = this.core, h = 1 / core.settings.physicsHz;
    const n = Math.max(1, Math.round(dt / h));
    for (let i = 0; i < n; i++) {
      core.physicsStep(h);
      const ops = core.ops!;
      let g = core.quad.imu.gyroOut, a = core.quad.imu.accOut;
      if (ops.imuTouched) { g = ops.gyro(g); a = ops.acc(a); }
      this.gSum.x += g.x; this.gSum.y += g.y; this.gSum.z += g.z;
      this.aSum.x += a.x; this.aSum.y += a.y; this.aSum.z += a.z;
      this.nSum++;
      this.linkAcc += h;
      if (this.linkAcc >= 0.05) { this.linkAcc = 0; ops.updateLinks(core); }
    }
  }

  private clearImu() { this.gSum = { x: 0, y: 0, z: 0 }; this.aSum = { x: 0, y: 0, z: 0 }; this.nSum = 0; }

  /** The IMU averaged since the last read (body FLU: rad/s, specific force m/s²). */
  readImu(): ImuSample {
    const n = Math.max(1, this.nSum), q = this.core.quad.imu;
    const out = this.nSum
      ? { gyro: { x: this.gSum.x / n, y: this.gSum.y / n, z: this.gSum.z / n }, acc: { x: this.aSum.x / n, y: this.aSum.y / n, z: this.aSum.z / n } }
      : { gyro: { ...q.gyroOut }, acc: { ...q.accOut } };
    this.clearImu();
    return out;
  }

  /** Static pressure the barometer reads (Pa), with its noise, prop-wash and faults; air temperature (°C). */
  baro(): { pa: number; tempC: number; altM: number } {
    const core = this.core, s = core.quad.s, map = core.map;
    const air = isa(s.pos.z + map.elevationM, core.settings.ambientC - 15);
    const thrust = core.quad.rotorOut.reduce((a, o) => a + o.thrust, 0);
    let pa = core.baro.read(air.pressure, air.rho, s.pos.z - map.terrain(s.pos.x, s.pos.y), thrust, core.diskArea, core.rotorR);
    pa = core.ops!.baro(pa, air.rho);
    // pressure altitude (ISA) of that reading
    const altM = 44330.77 * (1 - Math.pow(pa / 101325, 0.190263));
    return { pa, tempC: core.settings.ambientC - 0.0065 * (s.pos.z + map.elevationM), altM };
  }

  /** Magnetometer (gauss, body FLU), rangefinder (m or null), optical flow. */
  nav() { return this.core.ops!.navSensors(this.core); }

  /** The GNSS receiver's solution now (jamming, spoofing and GNSS faults applied; 10 Hz). */
  gnss(): GnssFix {
    const core = this.core, fx = core.ops!.fix, s = core.quad.s;
    const sats = fx?.numSV ?? 0;
    const p = fx ? { x: fx.pos[0], y: fx.pos[1], z: fx.pos[2] } : s.pos;
    const g = this.geo(p);
    return {
      lat: g.lat, lon: g.lon, altM: g.altM, vel: fx ? { x: fx.vel[0], y: fx.vel[1], z: fx.vel[2] } : { x: 0, y: 0, z: 0 },
      numSV: sats, fix: fx ? 3 : 0, ephM: fx?.ephM ?? 99, epvM: (fx?.ephM ?? 99) * 1.6,
    };
  }

  /** Geodetic position of a local ENU point (the origin is the map's GPS origin). */
  geo(p: V3): { lat: number; lon: number; altM: number } {
    const mLat = 111320, mLon = 111320 * Math.cos((GPS_ORIGIN.lat * Math.PI) / 180);
    return { lat: GPS_ORIGIN.lat + p.y / mLat, lon: GPS_ORIGIN.lon + p.x / mLon, altM: this.core.map.elevationM + p.z };
  }

  /**
   * A starting parameter set for the autopilot flying this build: geometry, hover throttle, battery
   * (PX4: a .params file for `param load`; ArduPilot: a .parm file for --add-param-file). Gains are
   * not tuned here: a 5" racer needs far lower rate gains than the iris defaults.
   */
  autopilotParams(kind: 'px4' | 'ardupilot'): string {
    const b = buildDrone(this.episode.spec), f = this.facts();
    const order = [1, 2, 3, 0].map((k) => b.params.rotors[k]); // FR, RL, FL, RR
    const cells = f.cells;
    if (kind === 'px4') {
      const lines = [
        `# FPV Sim build: ${this.episode.spec.name} (${(f.massKg * 1000).toFixed(0)} g, ${cells}S, T/W ${f.thrustToWeight.toFixed(1)})`,
        `MPC_THR_HOVER ${f.hoverThrottle.toFixed(3)}`, 'CA_AIRFRAME 0', 'CA_ROTOR_COUNT 4',
        ...order.flatMap((r, i) => [`CA_ROTOR${i}_PX ${r.pos.x.toFixed(4)}`, `CA_ROTOR${i}_PY ${(-r.pos.y).toFixed(4)}`, `CA_ROTOR${i}_KM ${(r.dir > 0 ? 0.05 : -0.05).toFixed(2)}`]),
        `BAT1_N_CELLS ${cells}`, `BAT1_V_CHARGED ${(b.params.battery.chemistry === 'LiHV' ? 4.35 : 4.2).toFixed(2)}`, 'BAT1_V_EMPTY 3.5',
      ];
      // QGroundControl .params lines: vehicle-id component-id name value type (9 = float)
      return lines.map((l) => (l.startsWith('#') ? l : `1	1	${l.split(' ')[0]}	${l.split(' ')[1]}	${/^(CA_AIRFRAME|CA_ROTOR_COUNT|BAT1_N_CELLS)$/.test(l.split(' ')[0]) ? 6 : 9}`)).join('\n') + '\n';
    }
    return [
      `# FPV Sim build: ${this.episode.spec.name} (${(f.massKg * 1000).toFixed(0)} g, ${cells}S, T/W ${f.thrustToWeight.toFixed(1)})`,
      'FRAME_CLASS 1', 'FRAME_TYPE 1', `MOT_THST_HOVER ${f.hoverThrottle.toFixed(3)}`, 'MOT_PWM_MIN 1000', 'MOT_PWM_MAX 2000', 'MOT_SPIN_ARM 0.05', 'MOT_SPIN_MIN 0.08',
      `BATT_MONITOR 4`, `MOT_BAT_VOLT_MAX ${(cells * 4.2).toFixed(1)}`, `MOT_BAT_VOLT_MIN ${(cells * 3.5).toFixed(1)}`,
      'AHRS_EKF_TYPE 3', 'SIM_RATE_HZ 1000',
    ].join('\n') + '\n';
  }

  /** Facts about the drone (mass, hover thrust share) for the autopilot's parameter file. */
  facts() {
    const b = buildDrone(this.episode.spec);
    return { massKg: b.params.mass, thrustToWeight: b.info.thrustToWeight, hoverThrottle: b.info.hoverThrottle, cells: b.params.battery.cellsSeries };
  }
}
