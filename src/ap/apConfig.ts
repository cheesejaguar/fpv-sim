// How a build flies on ArduPilot: which firmware (ArduPlane for a plane, ArduCopter for a quad set
// to ArduPilot), the parameters it boots with and its command line.
//
// The parameters, lowest priority first:
//   1. what every vehicle here shares: MAVLink on SERIAL0 (the simulator's own ground station) and
//      SERIAL1 (the API's pass-through, docs/ARDUPILOT.md), the telemetry streams the HUD reads, no
//      on-board logging or terrain download (they would fill the in-memory file system), the
//      battery monitor fed by the plant, and the app's switch layout: AUX1 (CH5) arms, AUX2 (CH6, a
//      3-position switch) picks the flight mode, AUX3 (CH7) is RTL and AUX4 (CH8) AUTO;
//   2. the vehicle's own: a plane's servo map, trim throttle and cruise speed (src/builder/plane.ts);
//      a quad's frame (Betaflight motor order, so the outputs are the same as Betaflight's), motor
//      range, hover throttle and a starting rate-loop tune from its inertia and thrust;
//   3. the pilot's (DroneSpec.apParams), from the builder's ArduPilot page.
// Scripts (DroneSpec.apScripts) go to scripts/ next to ArduPilot's working directory and run when
// SCR_ENABLE is 1 (set whenever there is one).
//
// The RC channels reach ArduPilot in ArduPilot's convention: pitch stick forward = low PWM (the
// opposite of Betaflight's), so the link flips CH2 (src/ap/apLink.ts).
import type { DroneBuild, DroneSpec } from '../builder/derive';
import { isAirframe } from '../data/airframes';
import type { GpsOrigin } from '../worker/ubxGps';

export type ApVehicle = 'plane' | 'copter';

/** The ArduPilot vehicle a build flies, or null for Betaflight. */
export function apVehicle(spec: Pick<DroneSpec, 'frame' | 'autopilot'>): ApVehicle | null {
  if (isAirframe(spec.frame)) return 'plane';
  return spec.autopilot === 'ardupilot' ? 'copter' : null;
}

/** Flight mode names by custom_mode (HEARTBEAT), per vehicle. */
export const PLANE_MODES: Record<number, string> = {
  0: 'MANUAL', 1: 'CIRCLE', 2: 'STABILIZE', 3: 'TRAINING', 4: 'ACRO', 5: 'FBWA', 6: 'FBWB', 7: 'CRUISE', 8: 'AUTOTUNE',
  10: 'AUTO', 11: 'RTL', 12: 'LOITER', 13: 'TAKEOFF', 14: 'AVOID_ADSB', 15: 'GUIDED', 17: 'QSTABILIZE', 18: 'QHOVER', 19: 'QLOITER',
  20: 'QLAND', 21: 'QRTL', 22: 'QAUTOTUNE', 23: 'QACRO', 24: 'THERMAL', 25: 'LOITER2QLAND',
};
export const COPTER_MODES: Record<number, string> = {
  0: 'STABILIZE', 1: 'ACRO', 2: 'ALT_HOLD', 3: 'AUTO', 4: 'GUIDED', 5: 'LOITER', 6: 'RTL', 7: 'CIRCLE', 9: 'LAND', 11: 'DRIFT',
  13: 'SPORT', 14: 'FLIP', 15: 'AUTOTUNE', 16: 'POSHOLD', 17: 'BRAKE', 18: 'THROW', 19: 'AVOID_ADSB', 20: 'GUIDED_NOGPS',
  21: 'SMART_RTL', 22: 'FLOWHOLD', 23: 'FOLLOW', 24: 'ZIGZAG', 25: 'SYSTEMID', 26: 'AUTOROTATE', 27: 'AUTO_RTL', 28: 'TURTLE',
};
export const modeName = (v: ApVehicle, m: number) => (v === 'plane' ? PLANE_MODES : COPTER_MODES)[m] ?? `MODE ${m}`;

/** What every ArduPilot vehicle here starts from. */
export const AP_PARAMS_COMMON: Record<string, number> = {
  SERIAL0_PROTOCOL: 2, SERIAL1_PROTOCOL: 2,
  // streams on SERIAL0 for the HUD (Hz): attitude, VFR_HUD, position, status / GPS / mission (4.7
  // renamed SRn_*: MAV1_* is the first MAVLink port's)
  MAV1_EXTRA1: 20, MAV1_EXTRA2: 10, MAV1_POSITION: 5, MAV1_EXT_STAT: 2, MAV1_EXTRA3: 1, MAV1_RAW_SENS: 0, MAV1_RC_CHAN: 0, MAV1_RAW_CTRL: 0, MAV1_PARAMS: 50,
  LOG_BACKEND_TYPE: 0, TERRAIN_ENABLE: 0,
  BATT_MONITOR: 4,
  // (4.7 renamed ARMING_CHECK: ARMING_SKIPCHK is a mask of checks to skip, -1 all but the mandatory ones)
  ARMING_SKIPCHK: -1,
  // the app's switches: AUX1 arm, AUX2 mode (3 positions: slots 1, 4, 6), AUX3 RTL, AUX4 AUTO
  RC5_OPTION: 153, FLTMODE_CH: 6, RC7_OPTION: 4, RC8_OPTION: 16,
  SCR_HEAP_SIZE: 300000,
};

/** ArduCopter on a quad from the builder. */
export function copterParams(b: DroneBuild): Record<string, number> {
  const s = b.spec, info = b.info, p = b.params;
  const cells = p.battery.cellsSeries, thrust = info.staticThrustN;
  // arm lever about x and y (the rotors' mean distance from the CG)
  const ay = p.rotors.reduce((a, r) => a + Math.abs(r.pos.y), 0) / p.rotors.length;
  const ax = p.rotors.reduce((a, r) => a + Math.abs(r.pos.x), 0) / p.rotors.length;
  // rate-loop P for ~60 rad/s of loop gain: one unit of roll output moves each motor's thrust by
  // about half its range, a torque of 2 T arm (src/ap/apConfig.ts header)
  const kLoop = 60;
  const pR = (kLoop * p.inertia.xx) / (2 * thrust * ay), pP = (kLoop * p.inertia.yy) / (2 * thrust * ax);
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
  const rollP = clamp(pR, 0.01, 0.3), pitchP = clamp(pP, 0.01, 0.3);
  return {
    FRAME_CLASS: 1, FRAME_TYPE: s.propDirection === 'props-out' ? 18 : 12, // BetaFlightX(Reversed): Betaflight's motor order
    MOT_PWM_TYPE: 0, MOT_PWM_MIN: 1000, MOT_PWM_MAX: 2000, MOT_SPIN_ARM: 0.05, MOT_SPIN_MIN: 0.07, MOT_SPIN_MAX: 0.98,
    MOT_THST_HOVER: Math.round(clamp(info.hoverThrottle, 0.1, 0.7) * 1000) / 1000, MOT_THST_EXPO: 0.6,
    MOT_BAT_VOLT_MAX: Math.round(cells * 4.2 * 10) / 10, MOT_BAT_VOLT_MIN: Math.round(cells * 3.3 * 10) / 10,
    BATT_CAPACITY: Math.round(p.battery.capacityAh * 1000),
    // a small, stiff airframe: the gyro filter and the rate loop well above a 10" default
    INS_GYRO_FILTER: 90, INS_ACCEL_FILTER: 20,
    ATC_RAT_RLL_P: r4(rollP), ATC_RAT_RLL_I: r4(rollP), ATC_RAT_RLL_D: r4(rollP * 0.025), ATC_RAT_RLL_FLTD: 40, ATC_RAT_RLL_FLTT: 40,
    ATC_RAT_PIT_P: r4(pitchP), ATC_RAT_PIT_I: r4(pitchP), ATC_RAT_PIT_D: r4(pitchP * 0.025), ATC_RAT_PIT_FLTD: 40, ATC_RAT_PIT_FLTT: 40,
    ATC_RAT_YAW_P: 0.3, ATC_RAT_YAW_I: 0.03, ATC_RAT_YAW_FLTE: 5,
    // (4.7 names and units: degrees, deg/s^2, metres, m/s)
    ATC_ACC_R_MAX: 3600, ATC_ACC_P_MAX: 3600, ATC_ACC_Y_MAX: 1200,
    ACRO_RP_RATE: 670, ACRO_Y_RATE: 400, ATC_ANGLE_MAX: 55,
    // modes: AUX2 low ACRO, mid STABILIZE, high ALT_HOLD
    FLTMODE1: 1, FLTMODE2: 1, FLTMODE3: 0, FLTMODE4: 0, FLTMODE5: 2, FLTMODE6: 2,
    RTL_ALT_M: 30, WP_SPD: 12, FS_THR_ENABLE: 1,
  };
}

/** The parameters a build boots with (see the header for the order). */
export function apParams(b: DroneBuild): Record<string, number> {
  const v = apVehicle(b.spec);
  const own = v === 'plane' ? b.info.plane!.params : v === 'copter' ? copterParams(b) : {};
  const out: Record<string, number> = { ...AP_PARAMS_COMMON, ...own, ...(b.spec.apParams ?? {}) };
  if (b.spec.apScripts && Object.keys(b.spec.apScripts).length) out.SCR_ENABLE ??= 1;
  return out;
}

/** A parameter file (NAME value per line). */
export const paramFile = (ps: Record<string, number>) => Object.entries(ps).map(([k, v]) => `${k} ${v}`).join('\n') + '\n';

export interface ApLaunch {
  vehicle: ApVehicle;
  files: Record<string, string>;
  args: string[];
  cwd: string;
  params: Record<string, number>;
}

/** Working directory of ArduPilot in its in-memory file system. */
export const AP_CWD = '/sitl';

/**
 * Files and command line for a build. home: the map's GPS origin (the simulator's x / y / z = 0)
 * and the heading ArduPilot starts with (deg, clockwise from north).
 */
export function apLaunch(b: DroneBuild, home: GpsOrigin, headingDeg: number): ApLaunch {
  const vehicle = apVehicle(b.spec);
  if (!vehicle) throw new Error('apLaunch: this build flies Betaflight');
  const params = apParams(b);
  const files: Record<string, string> = { [`${AP_CWD}/fpv-sim.parm`]: paramFile(params) };
  for (const [name, text] of Object.entries(b.spec.apScripts ?? {})) files[`${AP_CWD}/scripts/${name}`] = text;
  const hdg = ((Math.round(headingDeg) % 360) + 360) % 360;
  const args = [
    '--model', 'JSON', '--speedup', '1000', '-w',
    '--home', `${home.lat.toFixed(7)},${home.lon.toFixed(7)},${home.altM.toFixed(1)},${hdg}`,
    '--defaults', `${vehicle === 'plane' ? '@ROMFS/models/plane.parm,' : ''}${AP_CWD}/fpv-sim.parm`,
    // (SERIAL3 / 4 keep SITL's simulated GPS receivers)
    '--serial0', 'sim:js:0', '--serial1', 'sim:js:1', '--serial2', 'none',
    '--serial5', 'none', '--serial6', 'none', '--serial7', 'none', '--serial8', 'none',
  ];
  return { vehicle, files, args, cwd: AP_CWD, params };
}
