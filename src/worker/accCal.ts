// Accelerometer level calibration of the simulated flight controller ("Calibrate Accelerometer" in
// the Configurator, done by the worker since the simulator has no such button).
//
// Betaflight averages ~400 accelerometer samples and stores the mean minus 1 g as its trims; it does
// not check that the quad is level, so the pilot must put it on a level surface first. The worker
// used to calibrate wherever the quad lay on the spawn pad. A whoop rested on its two battery
// spheres and fell over onto one duct (-13.4° roll), so Betaflight learnt that tilt as "level": Angle
// mode then held 13° of left roll and the quad slid sideways at ~2 m/s, exactly like a stuck stick.
// Now the plant is frozen and Betaflight is handed the IMU of the quad sitting level and still (the
// chip's own offsets, board misalignment and noise included, which is what the trims are for).
import type { Betaflight } from '../bf/bfModule';
import { G0 } from '../sim/atmosphere';
import type { Imu } from '../sim/imu';
import type { V3 } from '../sim/math';
import { seedOf } from './fcHardware';

/** Bump to have every stored calibration redone once (2: level and held, not as the quad lay). */
export const ACC_CAL_REV = 2;
/** KV key under which the worker remembers which board the stored trims belong to. */
export const ACC_CAL_KEY = 'bf-acc-cal';

const ZERO: V3 = { x: 0, y: 0, z: 0 };
const LEVEL_REST: V3 = { x: 0, y: 0, z: G0 }; // specific force of a level quad at rest, body FLU

/**
 * The accelerometer errors stored trims were made for: the simulated board's offsets and
 * misalignment (seeded per build). Another value = another board, or a calibration from before
 * ACC_CAL_REV: the trims are stale and must be redone.
 */
export function accBoardKey(imu: Imu): string {
  return `${ACC_CAL_REV}:${seedOf([...imu.accBias, ...imu.align].map((v) => v.toFixed(6)).join(','))}`;
}

/** One IMU sample of the quad sitting level and still (gravity only, plus the chip's own errors). */
export function sampleLevelRest(imu: Imu, mass: number, dt: number): void {
  imu.sample(ZERO, LEVEL_REST, ZERO, ZERO, mass, dt);
}

/**
 * Run Betaflight's accelerometer calibration on a level pad. heldStep(dt) must advance the firmware
 * by one physics step with the plant frozen and the IMU fed by sampleLevelRest(). True once the
 * calibration finished (Betaflight saves it itself: the EEPROM goes dirty).
 */
export function calibrateAccLevel(bf: Betaflight, physicsHz: number, heldStep: (dt: number) => void): boolean {
  if (!bf.calibrateAcc()) return false;
  const dt = 1 / physicsHz;
  for (let i = 0; i < 3 / dt && bf.accCalibrating(); i++) heldStep(dt);
  return !bf.accCalibrating();
}
