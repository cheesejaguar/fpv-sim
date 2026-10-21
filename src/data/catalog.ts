// Component catalogue. Values are taken from manufacturer specs where available; anything not
// published (winding R, rotor inertia, thermal constants, prop static thrust/torque calibration)
// is an engineering estimate consistent with public thrust-stand data, and is marked `est`.
// Every number can be overridden from the builder UI.
import type { Chemistry } from '../sim/battery';

export interface FrameSpec {
  id: string; name: string; sizeClass: string;
  wheelbaseMm: number;          // motor-to-motor diagonal
  geometry: 'trueX' | 'stretchX' | 'squashedX' | 'deadcat';
  stretch: number;              // front/rear spacing vs side spacing ratio (1 = true X)
  armThicknessMm: number; armWidthMm: number;
  massG: number;                // frame only (plates, arms, standoffs, hardware)
  plateLengthMm: number; plateWidthMm: number; stackHeightMm: number;
  maxProp: number;              // inches
  /** Ducted (whoop / cinewhoop): props spin inside guards that add static thrust and drag. */
  ducted?: boolean;
  ductHeightMm?: number;
  ductGain?: number;            // static thrust augmentation fraction (~0.1-0.2)
  notes?: string;
}

export interface MotorSpec {
  id: string; name: string; stator: string;
  kv: number; rmMohm: number; i0A: number; poles: number;
  massG: number; rotorInertia: number; bellDiaMm: number; bellHeightMm: number;
  thermalCap: number; thermalRes: number; maxCurrentA: number;
  est?: string[];
}

export interface PropSpec {
  id: string; name: string;
  diameterIn: number; pitchIn: number; blades: number; massG: number;
  chordFracs: number[]; hubFrac: number; washoutDeg: number;
  calib: { rpm: number; thrustN: number; torqueNm: number }; // static, sea level
  stiffness: number; // 0..1 (affects damage resistance)
  est?: string[];
}

export interface BatterySpec {
  id: string; name: string; chemistry: Chemistry; cells: number; parallel: number;
  capacityMah: number; cRating: number; irPerCellMohm: number; massG: number;
  dims: [number, number, number]; // mm L x W x H
  wiringMohm?: number;              // connector + leads (small packs: BT2.0 / PH2.0 add ~10 mΩ)
}

export interface EscSpec { id: string; name: string; continuousA: number; burstA: number; efficiency: number; equivOhm: number; massG: number; firmware: string }

export interface FcSpec { id: string; name: string; gyro: 'ICM42688P' | 'BMI270' | 'MPU6000'; massG: number; softMount: number }

export interface VideoSpec {
  id: string; name: string; kind: 'analog' | 'digital';
  system: 'analog' | 'dji-o3' | 'dji-o4' | 'hdzero' | 'walksnail';
  latencyMs: number; latencyJitterMs: number; fps: number; interlaced: boolean;
  fovDeg: number;            // diagonal FOV
  fisheyeK: [number, number, number, number]; // Kannala–Brandt k1..k4
  resolution: [number, number]; rollingShutterMs: number;
  massG: number; powerW: number; vtxPowerMw: number; osd: 'sd' | 'hd';
}

const C5 = [0.17, 0.21, 0.22, 0.20, 0.17, 0.13, 0.07];

export const FRAMES: FrameSpec[] = [
  { id: 'f5-freestyle', name: '5" Freestyle (225 mm, 5 mm arms)', sizeClass: '5in', wheelbaseMm: 225, geometry: 'trueX', stretch: 1, armThicknessMm: 5, armWidthMm: 15, massG: 115, plateLengthMm: 110, plateWidthMm: 40, stackHeightMm: 25, maxProp: 5.1 },
  { id: 'f5-race', name: '5" Race (220 mm, 4 mm arms)', sizeClass: '5in', wheelbaseMm: 220, geometry: 'stretchX', stretch: 1.12, armThicknessMm: 4, armWidthMm: 12, massG: 82, plateLengthMm: 100, plateWidthMm: 34, stackHeightMm: 20, maxProp: 5.1 },
  { id: 'f5-deadcat', name: '5" Deadcat cinematic (230 mm)', sizeClass: '5in', wheelbaseMm: 230, geometry: 'deadcat', stretch: 1.0, armThicknessMm: 5, armWidthMm: 14, massG: 120, plateLengthMm: 115, plateWidthMm: 42, stackHeightMm: 28, maxProp: 5.1 },
  { id: 'f7-lr', name: '7" Long Range (295 mm)', sizeClass: '7in', wheelbaseMm: 295, geometry: 'trueX', stretch: 1, armThicknessMm: 5, armWidthMm: 14, massG: 140, plateLengthMm: 125, plateWidthMm: 42, stackHeightMm: 28, maxProp: 7 },
  // Beginner-friendly ducted quads: props fully guarded, slow and light enough for indoors.
  { id: 'f65-whoop', name: '65 mm Tiny Whoop (ducted, 1S)', sizeClass: 'whoop', wheelbaseMm: 65, geometry: 'trueX', stretch: 1, armThicknessMm: 1.5, armWidthMm: 5, massG: 4.5, plateLengthMm: 28, plateWidthMm: 28, stackHeightMm: 8, maxProp: 1.25, ducted: true, ductHeightMm: 10, ductGain: 0.12, notes: 'Meteor65 / Mobula6 class: one-piece frame with integrated ducts' },
  { id: 'f75-whoop', name: '75 mm Whoop (ducted, 1S)', sizeClass: 'whoop', wheelbaseMm: 75, geometry: 'trueX', stretch: 1, armThicknessMm: 1.8, armWidthMm: 6, massG: 6.2, plateLengthMm: 32, plateWidthMm: 32, stackHeightMm: 9, maxProp: 1.6, ducted: true, ductHeightMm: 11, ductGain: 0.12, notes: 'Mobula7 / Meteor75 class' },
  { id: 'f3-cinewhoop', name: '3" Cinewhoop (ducted, 4S)', sizeClass: '3in', wheelbaseMm: 142, geometry: 'trueX', stretch: 1, armThicknessMm: 3, armWidthMm: 10, massG: 78, plateLengthMm: 72, plateWidthMm: 42, stackHeightMm: 22, maxProp: 3, ducted: true, ductHeightMm: 22, ductGain: 0.16, notes: 'Ducted 3" for smooth HD cruising; the prop guards make it forgiving' },
  { id: 'f3-toothpick', name: '3" Toothpick (135 mm)', sizeClass: '3in', wheelbaseMm: 135, geometry: 'trueX', stretch: 1, armThicknessMm: 2.5, armWidthMm: 8, massG: 28, plateLengthMm: 60, plateWidthMm: 30, stackHeightMm: 15, maxProp: 3 },
];

export const MOTORS: MotorSpec[] = [
  { id: 'm2207-1950', name: '2207 1950KV (6S freestyle)', stator: '2207', kv: 1950, rmMohm: 62, i0A: 1.3, poles: 14, massG: 33, rotorInertia: 1.3e-6, bellDiaMm: 27.5, bellHeightMm: 13, thermalCap: 18, thermalRes: 4.5, maxCurrentA: 50, est: ['rmMohm', 'rotorInertia', 'thermal'] },
  { id: 'm2207-1750', name: '2207 1750KV (6S smooth)', stator: '2207', kv: 1750, rmMohm: 78, i0A: 1.1, poles: 14, massG: 33, rotorInertia: 1.3e-6, bellDiaMm: 27.5, bellHeightMm: 13, thermalCap: 18, thermalRes: 4.5, maxCurrentA: 45, est: ['rmMohm', 'rotorInertia', 'thermal'] },
  { id: 'm2207-2750', name: '2207 2750KV (4S)', stator: '2207', kv: 2750, rmMohm: 38, i0A: 1.9, poles: 14, massG: 33, rotorInertia: 1.3e-6, bellDiaMm: 27.5, bellHeightMm: 13, thermalCap: 18, thermalRes: 4.5, maxCurrentA: 55, est: ['rmMohm', 'rotorInertia', 'thermal'] },
  { id: 'm2306-2450', name: '2306 2450KV (4S/5S race)', stator: '2306', kv: 2450, rmMohm: 52, i0A: 1.5, poles: 14, massG: 31, rotorInertia: 1.0e-6, bellDiaMm: 27, bellHeightMm: 12, thermalCap: 16, thermalRes: 5, maxCurrentA: 45, est: ['rmMohm', 'rotorInertia', 'thermal'] },
  { id: 'm2806-1300', name: '2806.5 1300KV (7" LR)', stator: '2806.5', kv: 1300, rmMohm: 80, i0A: 0.9, poles: 14, massG: 52, rotorInertia: 3.0e-6, bellDiaMm: 33, bellHeightMm: 14, thermalCap: 28, thermalRes: 4, maxCurrentA: 45, est: ['rmMohm', 'rotorInertia', 'thermal'] },
  { id: 'm0702-26000', name: '0702 26000KV (1S 65 mm whoop)', stator: '0702', kv: 26000, rmMohm: 320, i0A: 0.35, poles: 12, massG: 2.1, rotorInertia: 4e-9, bellDiaMm: 9, bellHeightMm: 6, thermalCap: 0.8, thermalRes: 45, maxCurrentA: 4.5, est: ['rmMohm', 'i0A', 'rotorInertia', 'thermal'] },
  { id: 'm0802-19000', name: '0802 19000KV (1S 75 mm whoop)', stator: '0802', kv: 19000, rmMohm: 300, i0A: 0.45, poles: 12, massG: 3.0, rotorInertia: 7e-9, bellDiaMm: 10, bellHeightMm: 7, thermalCap: 1.2, thermalRes: 35, maxCurrentA: 6, est: ['rmMohm', 'i0A', 'rotorInertia', 'thermal'] },
  { id: 'm1404-3800', name: '1404 3800KV (3")', stator: '1404', kv: 3800, rmMohm: 190, i0A: 0.6, poles: 12, massG: 9.5, rotorInertia: 1.2e-7, bellDiaMm: 18, bellHeightMm: 9, thermalCap: 5, thermalRes: 12, maxCurrentA: 18, est: ['rmMohm', 'rotorInertia', 'thermal'] },
];

export const PROPS: PropSpec[] = [
  { id: 'p-hq5043', name: 'HQProp 5x4.3x3', diameterIn: 5, pitchIn: 4.3, blades: 3, massG: 4.3, chordFracs: C5, hubFrac: 0.14, washoutDeg: 0, calib: { rpm: 28000, thrustN: 13.5, torqueNm: 0.19 }, stiffness: 0.6, est: ['calib'] },
  { id: 'p-gf51466', name: 'Gemfan 51466 (5.1x4.66x3)', diameterIn: 5.1, pitchIn: 4.66, blades: 3, massG: 4.4, chordFracs: C5, hubFrac: 0.14, washoutDeg: 0, calib: { rpm: 28000, thrustN: 14.8, torqueNm: 0.215 }, stiffness: 0.5, est: ['calib'] },
  { id: 'p-hq515', name: 'HQProp 5.1x5x3 (race)', diameterIn: 5.1, pitchIn: 5.0, blades: 3, massG: 4.2, chordFracs: [0.15, 0.19, 0.20, 0.19, 0.16, 0.12, 0.06], hubFrac: 0.14, washoutDeg: 0, calib: { rpm: 28000, thrustN: 15.3, torqueNm: 0.24 }, stiffness: 0.55, est: ['calib'] },
  { id: 'p-hq7040', name: 'HQProp 7x4x3 (LR)', diameterIn: 7, pitchIn: 4.0, blades: 3, massG: 8.2, chordFracs: [0.13, 0.16, 0.17, 0.15, 0.13, 0.10, 0.05], hubFrac: 0.12, washoutDeg: 2, calib: { rpm: 20000, thrustN: 19, torqueNm: 0.29 }, stiffness: 0.5, est: ['calib'] },
  { id: 'p-31mm4', name: '31 mm 4-blade whoop prop (Gemfan 1210 class)', diameterIn: 1.22, pitchIn: 0.9, blades: 4, massG: 0.2, chordFracs: [0.30, 0.36, 0.37, 0.35, 0.30, 0.22, 0.12], hubFrac: 0.2, washoutDeg: 0, calib: { rpm: 45000, thrustN: 0.24, torqueNm: 0.0012 }, stiffness: 0.3, est: ['calib', 'chord'] },
  { id: 'p-40mm3', name: '40 mm 3-blade whoop prop (Gemfan 1636 class)', diameterIn: 1.57, pitchIn: 1.1, blades: 3, massG: 0.33, chordFracs: [0.24, 0.29, 0.30, 0.28, 0.24, 0.18, 0.10], hubFrac: 0.18, washoutDeg: 0, calib: { rpm: 36000, thrustN: 0.30, torqueNm: 0.00143 }, stiffness: 0.3, est: ['calib', 'chord'] },
  { id: 'p-gf3018', name: 'Gemfan 3018 (2-blade)', diameterIn: 3, pitchIn: 1.8, blades: 2, massG: 1.4, chordFracs: [0.14, 0.18, 0.19, 0.17, 0.14, 0.10, 0.05], hubFrac: 0.16, washoutDeg: 0, calib: { rpm: 38000, thrustN: 3.7, torqueNm: 0.0377 }, stiffness: 0.4, est: ['calib'] },
  { id: 'p-hq3030', name: 'HQProp 3x3x3', diameterIn: 3, pitchIn: 3.0, blades: 3, massG: 1.6, chordFracs: C5, hubFrac: 0.16, washoutDeg: 0, calib: { rpm: 38000, thrustN: 4.4, torqueNm: 0.048 }, stiffness: 0.4, est: ['calib'] },
];

export const BATTERIES: BatterySpec[] = [
  { id: 'b6s1300', name: '6S 1300 mAh 120C LiPo', chemistry: 'LiPo', cells: 6, parallel: 1, capacityMah: 1300, cRating: 120, irPerCellMohm: 3.0, massG: 215, dims: [75, 35, 38] },
  { id: 'b6s1100', name: '6S 1100 mAh 100C LiPo', chemistry: 'LiPo', cells: 6, parallel: 1, capacityMah: 1100, cRating: 100, irPerCellMohm: 3.6, massG: 180, dims: [72, 33, 36] },
  { id: 'b6s1300hv', name: '6S 1300 mAh LiHV', chemistry: 'LiHV', cells: 6, parallel: 1, capacityMah: 1300, cRating: 100, irPerCellMohm: 3.3, massG: 220, dims: [75, 35, 38] },
  { id: 'b4s1500', name: '4S 1500 mAh 120C LiPo', chemistry: 'LiPo', cells: 4, parallel: 1, capacityMah: 1500, cRating: 120, irPerCellMohm: 2.6, massG: 180, dims: [75, 35, 30] },
  { id: 'b6s1p-p45b', name: '6S1P 21700 Li-ion (Molicel P45B 4500 mAh)', chemistry: 'LiIon', cells: 6, parallel: 1, capacityMah: 4500, cRating: 10, irPerCellMohm: 16, massG: 430, dims: [130, 44, 22] },
  { id: 'b1s300hv', name: '1S 300 mAh LiHV (BT2.0)', chemistry: 'LiHV', cells: 1, parallel: 1, capacityMah: 300, cRating: 30, irPerCellMohm: 45, massG: 7.8, dims: [55, 12, 7], wiringMohm: 10 },
  { id: 'b1s450hv', name: '1S 450 mAh LiHV (BT2.0)', chemistry: 'LiHV', cells: 1, parallel: 1, capacityMah: 450, cRating: 30, irPerCellMohm: 35, massG: 11.5, dims: [60, 17, 8], wiringMohm: 10 },
  { id: 'b4s650', name: '4S 650 mAh 95C LiPo', chemistry: 'LiPo', cells: 4, parallel: 1, capacityMah: 650, cRating: 95, irPerCellMohm: 6.5, massG: 78, dims: [58, 30, 22] },
];

export const ESCS: EscSpec[] = [
  { id: 'e45', name: '45 A 4-in-1 (BLHeli_32/AM32)', continuousA: 45, burstA: 55, efficiency: 0.965, equivOhm: 0.055, massG: 14, firmware: 'BLHeli_32' },
  { id: 'e60', name: '60 A 4-in-1 (AM32)', continuousA: 60, burstA: 70, efficiency: 0.97, equivOhm: 0.045, massG: 18, firmware: 'AM32' },
  { id: 'e5aio', name: '5 A whoop AIO (FC + ESC + ELRS RX, Bluejay)', continuousA: 5, burstA: 6, efficiency: 0.93, equivOhm: 0.12, massG: 2.6, firmware: 'Bluejay' },
  { id: 'e20aio', name: '20 A AIO (Bluejay)', continuousA: 20, burstA: 25, efficiency: 0.95, equivOhm: 0.09, massG: 6, firmware: 'Bluejay' },
];

export const FCS: FcSpec[] = [
  { id: 'fc-42688', name: 'F7 FC, ICM-42688-P', gyro: 'ICM42688P', massG: 8, softMount: 0.8 },
  { id: 'fc-bmi270', name: 'F4 FC, BMI270', gyro: 'BMI270', massG: 7, softMount: 0.8 },
  { id: 'fc-whoop-aio', name: 'Whoop AIO F4, BMI270 (mass counted in the AIO ESC)', gyro: 'BMI270', massG: 0, softMount: 1.0 },
  { id: 'fc-mpu6000', name: 'F4 FC, MPU-6000 (legacy)', gyro: 'MPU6000', massG: 8, softMount: 1.0 },
];

export const VIDEO: VideoSpec[] = [
  { id: 'v-analog', name: 'Analog (Caddx Ratel 2 + 600 mW VTX), NTSC', kind: 'analog', system: 'analog', latencyMs: 22, latencyJitterMs: 8, fps: 59.94, interlaced: true, fovDeg: 160, fisheyeK: [-0.02, 0.004, -0.001, 0], resolution: [720, 480], rollingShutterMs: 16, massG: 15, powerW: 4.5, vtxPowerMw: 600, osd: 'sd' },
  { id: 'v-analog-pal', name: 'Analog (Caddx Ratel 2 + 600 mW VTX), PAL', kind: 'analog', system: 'analog', latencyMs: 25, latencyJitterMs: 10, fps: 50, interlaced: true, fovDeg: 160, fisheyeK: [-0.02, 0.004, -0.001, 0], resolution: [720, 576], rollingShutterMs: 19, massG: 15, powerW: 4.5, vtxPowerMw: 600, osd: 'sd' },
  { id: 'v-analog-whoop', name: 'Analog whoop camera + 25 mW VTX (Caddx Ant class)', kind: 'analog', system: 'analog', latencyMs: 22, latencyJitterMs: 8, fps: 59.94, interlaced: true, fovDeg: 165, fisheyeK: [-0.02, 0.004, -0.001, 0], resolution: [720, 480], rollingShutterMs: 16, massG: 2.5, powerW: 1.0, vtxPowerMw: 25, osd: 'sd' },
  { id: 'v-hdzero', name: 'HDZero (Nano 90, 90 fps)', kind: 'digital', system: 'hdzero', latencyMs: 15, latencyJitterMs: 3, fps: 90, interlaced: false, fovDeg: 150, fisheyeK: [-0.015, 0.003, 0, 0], resolution: [1280, 720], rollingShutterMs: 9, massG: 18, powerW: 6, vtxPowerMw: 500, osd: 'hd' },
  { id: 'v-dji-o3', name: 'DJI O3 Air Unit (100 fps)', kind: 'digital', system: 'dji-o3', latencyMs: 30, latencyJitterMs: 6, fps: 100, interlaced: false, fovDeg: 155, fisheyeK: [-0.01, 0.002, 0, 0], resolution: [1920, 1080], rollingShutterMs: 8, massG: 36, powerW: 8, vtxPowerMw: 700, osd: 'hd' },
  { id: 'v-dji-o4', name: 'DJI O4 Pro (120 fps)', kind: 'digital', system: 'dji-o4', latencyMs: 24, latencyJitterMs: 5, fps: 120, interlaced: false, fovDeg: 155, fisheyeK: [-0.01, 0.002, 0, 0], resolution: [1920, 1080], rollingShutterMs: 7, massG: 32, powerW: 8, vtxPowerMw: 700, osd: 'hd' },
  { id: 'v-walksnail', name: 'Walksnail Avatar HD (100 fps)', kind: 'digital', system: 'walksnail', latencyMs: 25, latencyJitterMs: 6, fps: 100, interlaced: false, fovDeg: 160, fisheyeK: [-0.012, 0.002, 0, 0], resolution: [1920, 1080], rollingShutterMs: 9, massG: 28, powerW: 7, vtxPowerMw: 500, osd: 'hd' },
];

export const byId = <T extends { id: string }>(list: T[], id: string): T => {
  const x = list.find((e) => e.id === id);
  if (!x) throw new Error(`unknown component ${id}`);
  return x;
};
