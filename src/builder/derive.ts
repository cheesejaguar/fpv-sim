// Procedural generation of the physical model from a component-level drone specification:
// mass budget, CG, full inertia tensor (parallel-axis over component boxes), rotor layout and spin
// directions, collider set, drag areas, structural modes, electrical parameters, and BEMT tables.
import { BATTERIES, ESCS, FCS, FRAMES, MOTORS, PROPS, VIDEO, byId, FrameSpec, MotorSpec, PropSpec, BatterySpec, EscSpec, FcSpec, VideoSpec } from '../data/catalog';
import { batteryFromSpec } from '../sim/battery';
import { buildBemtTable, BemtTable, DEFAULT_AIRFOIL, PropGeometry } from '../sim/bemt';
import { ColliderSphere } from '../sim/contact';
import { GYRO_CHIPS } from '../sim/imu';
import { V3 } from '../sim/math';
import { MotorParams } from '../sim/motor';
import { QuadParams, RotorConfig } from '../sim/quad';

export interface DroneSpec {
  name: string;
  frame: string; motor: string; prop: string; battery: string; esc: string; fc: string; video: string;
  batteryMount: 'top' | 'bottom';
  cameraUptiltDeg: number;
  propDirection: 'props-out' | 'props-in';
  extraMassG: number;            // GoPro, TPU, GPS, ...
  extraMassZmm: number;          // position of extra mass above arm plane
  batterySoc: number;            // initial state of charge
  batteryAge: number;            // 1 = new
  motorTiltDeg: number;
  overrides: Partial<Overrides>;
}

/** Everything a slider can override (per-component raw specs and derived values). */
export interface Overrides {
  massScale: number; inertiaScale: number;
  kv: number; rmMohm: number; i0A: number;
  propPitchIn: number; propThrustScale: number; propTorqueScale: number;
  cdAScale: number; irPerCellMohm: number; capacityMah: number; cells: number;
  escCurrentLimitA: number; auxPowerW: number;
  frameFreqHz: number; vibrationScale: number; propImbalance: number;
}

export const DEFAULT_SPEC: DroneSpec = {
  name: '5" Freestyle 6S',
  frame: 'f5-freestyle', motor: 'm2207-1950', prop: 'p-gf51466', battery: 'b6s1300', esc: 'e45', fc: 'fc-42688', video: 'v-analog',
  batteryMount: 'top', cameraUptiltDeg: 30, propDirection: 'props-out', extraMassG: 25, extraMassZmm: 10,
  batterySoc: 1, batteryAge: 1, motorTiltDeg: 0, overrides: {},
};

export const PRESETS: DroneSpec[] = [
  DEFAULT_SPEC,
  { ...DEFAULT_SPEC, name: '5" Race 4S', frame: 'f5-race', motor: 'm2306-2450', prop: 'p-hq515', battery: 'b4s1500', esc: 'e45', fc: 'fc-bmi270', video: 'v-analog', extraMassG: 10, cameraUptiltDeg: 40 },
  { ...DEFAULT_SPEC, name: '5" Freestyle DJI O4 + GoPro', video: 'v-dji-o4', extraMassG: 25 + 60, extraMassZmm: 45, cameraUptiltDeg: 28 },
  { ...DEFAULT_SPEC, name: '5" HDZero 6S', video: 'v-hdzero', prop: 'p-hq5043' },
  { ...DEFAULT_SPEC, name: '7" Long Range Li-ion', frame: 'f7-lr', motor: 'm2806-1300', prop: 'p-hq7040', battery: 'b6s1p-p45b', esc: 'e45', video: 'v-dji-o3', batteryMount: 'bottom', extraMassG: 30, cameraUptiltDeg: 20 },
  { ...DEFAULT_SPEC, name: '3" Toothpick 4S', frame: 'f3-toothpick', motor: 'm1404-3800', prop: 'p-gf3018', battery: 'b4s650', esc: 'e20aio', fc: 'fc-bmi270', video: 'v-analog', extraMassG: 5, extraMassZmm: 5, cameraUptiltDeg: 25 },
];

interface MassItem { name: string; m: number; pos: V3; box: V3 } // box = full dimensions

export interface DerivedInfo {
  components: { frame: FrameSpec; motor: MotorSpec; prop: PropSpec; battery: BatterySpec; esc: EscSpec; fc: FcSpec; video: VideoSpec };
  massItems: MassItem[];
  auwG: number;
  cgMm: V3;
  inertia: QuadParams['inertia'];
  staticThrustN: number;        // per motor at full throttle, resting battery
  thrustToWeight: number;
  hoverThrottle: number;        // BF throttle fraction (0..1, ignoring idle offset)
  hoverCurrentA: number;
  wotCurrentA: number;
  hoverRpm: number;
  wotRpm: number;
  flightTimeHoverMin: number;
  flightTimeMixedMin: number;
  estTopSpeedKmh: number;
  frameFreqHz: number;
}

export interface DroneBuild { spec: DroneSpec; params: QuadParams; info: DerivedInfo; tables: BemtTable }

const tableCache = new Map<string, BemtTable>();

export function propGeometry(p: PropSpec, pitchOverride?: number): PropGeometry {
  return {
    diameterM: p.diameterIn * 0.0254, pitchM: (pitchOverride ?? p.pitchIn) * 0.0254, blades: p.blades,
    hubRadiusFrac: p.hubFrac, chordFracs: p.chordFracs, washoutDeg: p.washoutDeg, airfoil: DEFAULT_AIRFOIL,
  };
}

export function propTable(p: PropSpec, pitchOverride?: number): BemtTable {
  const key = `${p.id}:${pitchOverride ?? p.pitchIn}`;
  let t = tableCache.get(key);
  if (!t) {
    // calibrate at the catalogue pitch; a pitch override then changes the result physically
    const base = buildBemtTable(propGeometry(p), p.calib);
    t = pitchOverride != null && pitchOverride !== p.pitchIn ? { ...buildBemtTable(propGeometry(p, pitchOverride)), ctScale: base.ctScale, cqScale: base.cqScale } : base;
    if (t !== base) {
      const j0 = (t.ng - 1) >> 1, R = t.R, A = t.A;
      t.kT = t.ct[j0] * t.ctScale * 1.225 * A * R * R;
      t.kQ = t.cq[j0] * t.cqScale * 1.225 * A * R * R * R;
    }
    tableCache.set(key, t);
  }
  return t;
}

export function buildDrone(spec: DroneSpec): DroneBuild {
  const ov = spec.overrides;
  const frame = byId(FRAMES, spec.frame), motor = byId(MOTORS, spec.motor), prop = byId(PROPS, spec.prop);
  const battery = byId(BATTERIES, spec.battery), esc = byId(ESCS, spec.esc), fc = byId(FCS, spec.fc), video = byId(VIDEO, spec.video);

  // ---------- geometry ----------
  const wb = frame.wheelbaseMm / 1000;
  // motor positions: diagonal wheelbase; stretch spreads front/rear (x) vs sides (y)
  const half = wb / 2;
  const ang = Math.atan(frame.stretch); // angle from y axis
  let mx = half * Math.sin(ang), my = half * Math.cos(ang);
  let mxRear = mx, myRear = my;
  if (frame.geometry === 'deadcat') { mx = half * Math.sin(ang) * 0.9; my = half * Math.cos(ang) * 1.18; mxRear = half * 0.72; myRear = half * 0.69; }
  else if (frame.geometry === 'squashedX') { mx = half * 0.62; my = half * 0.78; mxRear = mx; myRear = my; }
  const motorZ = 0.006 + motor.bellHeightMm / 2000;
  const propZ = 0.006 + motor.bellHeightMm / 1000 + 0.004;
  // Betaflight QUADX order: 1 rear-right, 2 front-right, 3 rear-left, 4 front-left
  const hubs: V3[] = [
    { x: -mxRear, y: -myRear, z: propZ },
    { x: mx, y: -my, z: propZ },
    { x: -mxRear, y: myRear, z: propZ },
    { x: mx, y: my, z: propZ },
  ];
  // spin (seen from above). BF default "props in": 1 CW, 2 CCW, 3 CCW, 4 CW. Props out reverses.
  const propsIn: (1 | -1)[] = [-1, 1, 1, -1];
  const dirs = spec.propDirection === 'props-in' ? propsIn : (propsIn.map((d) => -d) as (1 | -1)[]);

  // ---------- mass budget ----------
  const items: MassItem[] = [];
  const plateM = frame.massG * 0.55 / 1000, armsM = frame.massG * 0.45 / 1000;
  items.push({ name: 'frame plates + standoffs', m: plateM, pos: { x: 0, y: 0, z: frame.stackHeightMm / 2000 }, box: { x: frame.plateLengthMm / 1000, y: frame.plateWidthMm / 1000, z: frame.stackHeightMm / 1000 } });
  for (let k = 0; k < 4; k++) {
    const h = hubs[k];
    const L = Math.hypot(h.x, h.y);
    items.push({ name: `arm ${k + 1}`, m: armsM / 4, pos: { x: h.x * 0.55, y: h.y * 0.55, z: 0 }, box: { x: L * Math.abs(h.x) / L + 0.012, y: L * Math.abs(h.y) / L + 0.012, z: frame.armThicknessMm / 1000 } });
    items.push({ name: `motor ${k + 1}`, m: motor.massG / 1000, pos: { x: h.x, y: h.y, z: motorZ }, box: { x: motor.bellDiaMm / 1000, y: motor.bellDiaMm / 1000, z: motor.bellHeightMm / 1000 } });
    items.push({ name: `prop ${k + 1}`, m: prop.massG / 1000, pos: { ...h }, box: { x: 0.03, y: 0.03, z: 0.008 } }); // prop spin inertia handled separately
  }
  items.push({ name: 'ESC', m: esc.massG / 1000, pos: { x: 0, y: 0, z: 0.006 }, box: { x: 0.04, y: 0.04, z: 0.006 } });
  items.push({ name: 'FC', m: fc.massG / 1000, pos: { x: 0, y: 0, z: 0.014 }, box: { x: 0.036, y: 0.036, z: 0.006 } });
  items.push({ name: 'video system', m: video.massG / 1000, pos: { x: frame.plateLengthMm / 2400, y: 0, z: frame.stackHeightMm / 2000 }, box: { x: 0.03, y: 0.03, z: 0.025 } });
  // receiver, antennas, wiring, XT60, capacitor, screws: scales roughly with frame size
  items.push({ name: 'receiver + wiring + hardware', m: 0.0025 + 0.65 * wb * wb, pos: { x: -0.02, y: 0, z: 0.012 }, box: { x: 0.05, y: 0.03, z: 0.015 } });
  if (spec.extraMassG > 0) items.push({ name: 'extra (TPU / GPS / action cam)', m: spec.extraMassG / 1000, pos: { x: 0.01, y: 0, z: spec.extraMassZmm / 1000 }, box: { x: 0.06, y: 0.04, z: 0.03 } });
  const bd = battery.dims;
  const batZ = spec.batteryMount === 'top' ? frame.stackHeightMm / 1000 + 0.004 + bd[2] / 2000 : -0.003 - bd[2] / 2000;
  const capScale = (ov.capacityMah ?? battery.capacityMah) / battery.capacityMah * ((ov.cells ?? battery.cells) / battery.cells);
  items.push({ name: 'battery', m: (battery.massG * capScale) / 1000, pos: { x: 0, y: 0, z: batZ }, box: { x: bd[0] / 1000, y: bd[1] / 1000, z: bd[2] / 1000 } });

  const mScale = ov.massScale ?? 1;
  for (const it of items) it.m *= mScale;
  const M = items.reduce((a, b) => a + b.m, 0);
  const cg = { x: 0, y: 0, z: 0 };
  for (const it of items) { cg.x += it.m * it.pos.x; cg.y += it.m * it.pos.y; cg.z += it.m * it.pos.z; }
  cg.x /= M; cg.y /= M; cg.z /= M;

  // ---------- inertia tensor about CG ----------
  let Ixx = 0, Iyy = 0, Izz = 0, Ixy = 0, Ixz = 0, Iyz = 0;
  for (const it of items) {
    const rx = it.pos.x - cg.x, ry = it.pos.y - cg.y, rz = it.pos.z - cg.z;
    const b = it.box;
    Ixx += it.m * (b.y * b.y + b.z * b.z) / 12 + it.m * (ry * ry + rz * rz);
    Iyy += it.m * (b.x * b.x + b.z * b.z) / 12 + it.m * (rx * rx + rz * rz);
    Izz += it.m * (b.x * b.x + b.y * b.y) / 12 + it.m * (rx * rx + ry * ry);
    Ixy += it.m * rx * ry; Ixz += it.m * rx * rz; Iyz += it.m * ry * rz;
  }
  const iS = ov.inertiaScale ?? 1;
  const inertia = { xx: Ixx * iS, yy: Iyy * iS, zz: Izz * iS, xy: Ixy * iS, xz: Ixz * iS, yz: Iyz * iS };

  // ---------- propulsion ----------
  const table = propTable(prop, ov.propPitchIn);
  const tbl: BemtTable = (ov.propThrustScale || ov.propTorqueScale)
    ? { ...table, ctScale: table.ctScale * (ov.propThrustScale ?? 1), cqScale: table.cqScale * (ov.propTorqueScale ?? 1), kT: table.kT * (ov.propThrustScale ?? 1), kQ: table.kQ * (ov.propTorqueScale ?? 1) }
    : table;
  const R = tbl.R;
  const propInertia = 0.22 * (prop.massG / 1000) * R * R;
  const mp: MotorParams = {
    kv: ov.kv ?? motor.kv, rmOhm: (ov.rmMohm ?? motor.rmMohm) / 1000, escOhm: esc.equivOhm, i0A: ov.i0A ?? motor.i0A,
    poles: motor.poles, rotorInertia: motor.rotorInertia, massKg: motor.massG / 1000,
    thermalCapJPerK: motor.thermalCap, thermalResKPerW: motor.thermalRes, kvLoadFactor: 0.94,
    escCurrentLimitA: ov.escCurrentLimitA ?? Math.min(esc.burstA, motor.maxCurrentA * 1.25), escEfficiency: esc.efficiency,
  };
  const tilt = ((spec.motorTiltDeg || 0) * Math.PI) / 180;
  const rotors: RotorConfig[] = hubs.map((h, k) => {
    // inward motor tilt (positive tilts thrust toward the centre)
    const r = Math.hypot(h.x, h.y) || 1;
    const ax = { x: (-h.x / r) * Math.sin(tilt), y: (-h.y / r) * Math.sin(tilt), z: Math.cos(tilt) };
    return { pos: { x: h.x - cg.x, y: h.y - cg.y, z: h.z - cg.z }, axis: ax, dir: dirs[k], motor: { ...mp }, table: tbl, propInertia, propMass: prop.massG / 1000, bladeCount: prop.blades };
  });

  // ---------- drag ----------
  const cdS = ov.cdAScale ?? 1;
  const frontal = (bd[1] * bd[2]) / 1e6 + (frame.plateWidthMm * frame.stackHeightMm) / 1e6 + 4 * (motor.bellDiaMm * motor.bellHeightMm) / 1e6 * 0.6 + 4 * (frame.armWidthMm * frame.armThicknessMm) / 1e6 + 0.0008 + (spec.extraMassG > 40 ? 0.0018 : 0);
  const side = (bd[0] * bd[2]) / 1e6 + (frame.plateLengthMm * frame.stackHeightMm) / 1e6 + 4 * (motor.bellDiaMm * motor.bellHeightMm) / 1e6 * 0.6 + 0.0006;
  const top = (bd[0] * bd[1]) / 1e6 + (frame.plateLengthMm * frame.plateWidthMm) / 1e6 + 4 * (Math.hypot(mx, my) * 0.8 * frame.armWidthMm) / 1000;
  const cdA = { x: 1.05 * frontal * cdS, y: 1.1 * side * cdS, z: 1.2 * top * cdS };
  const dragCenter = { x: 0.004, y: 0, z: (batZ * 0.5 + 0.015 * 0.5) - cg.z };

  // ---------- colliders ----------
  const colliders: ColliderSphere[] = [];
  const add = (x: number, y: number, z: number, r: number, kind: ColliderSphere['kind'], rotor = -1) => colliders.push({ pos: { x: x - cg.x, y: y - cg.y, z: z - cg.z }, radius: r, kind, rotor });
  add(0, 0, frame.stackHeightMm / 2000, Math.min(frame.plateWidthMm, frame.stackHeightMm * 1.4) / 2000, 'frame');
  add(frame.plateLengthMm / 2200, 0, frame.stackHeightMm / 2000, 0.016, 'camera');
  add(-frame.plateLengthMm / 2400, 0, frame.stackHeightMm / 2000, 0.014, 'frame');
  add(bd[0] / 3000, 0, batZ, bd[2] / 2000, 'battery');
  add(-bd[0] / 3000, 0, batZ, bd[2] / 2000, 'battery');
  for (let k = 0; k < 4; k++) {
    const h = hubs[k];
    add(h.x, h.y, 0.0, motor.bellDiaMm / 2000, 'motor', k);       // motor bottom / arm tip
    add(h.x * 0.5, h.y * 0.5, -0.002, frame.armThicknessMm / 1000 + 0.002, 'frame'); // arm mid
    for (let j = 0; j < 6; j++) {
      const a = (j / 6) * 2 * Math.PI;
      add(h.x + Math.cos(a) * R * 0.92, h.y + Math.sin(a) * R * 0.92, h.z, 0.008, 'prop', k);
    }
  }

  // ---------- structure / IMU ----------
  const fRP = ov.frameFreqHz ?? 160 * Math.pow(frame.armThicknessMm / 5, 1.5) * Math.pow(0.225 / wb, 1.5);
  const vib = ov.vibrationScale ?? 1;
  const gainBase = 3e-4 / Math.max(1e-5, (Ixx + Iyy) / 2) * 40 * vib;
  const chip = GYRO_CHIPS[fc.gyro];

  // ---------- battery ----------
  const bp = batteryFromSpec({
    chemistry: battery.chemistry, cells: ov.cells ?? battery.cells, parallel: battery.parallel,
    capacityMah: ov.capacityMah ?? battery.capacityMah, cRating: battery.cRating,
    irPerCellMohm: ov.irPerCellMohm ?? battery.irPerCellMohm, massG: battery.massG * capScale, ageFactor: spec.batteryAge,
  });

  const params: QuadParams = {
    mass: M, inertia, rotors, cdA, dragCenter,
    angularDrag: { x: 2e-6, y: 2e-6, z: 3e-6 },
    battery: bp, auxPowerW: ov.auxPowerW ?? video.powerW + 1.5,
    colliders, imuChip: chip,
    flex: {
      roll: { freqHz: fRP, zeta: 0.03, gain: gainBase },
      pitch: { freqHz: fRP * 1.08, zeta: 0.03, gain: gainBase },
      yaw: { freqHz: fRP * 1.6, zeta: 0.04, gain: gainBase * 0.4 },
    },
    mountIsolation: fc.softMount,
  };
  if (ov.propImbalance != null) { /* applied to rotor damage state at sim creation */ }

  const info = deriveInfo(spec, params, { frame, motor, prop, battery, esc, fc, video }, items, cg, fRP);
  return { spec, params, info, tables: tbl };
}

/** Steady-state static rotor speed and current for duty D at bus voltage V (no forward speed). */
export function staticOperatingPoint(mp: MotorParams, kT: number, kQ0: number, D: number, V: number, tipRef = 0, R = 0): { omega: number; current: number; thrust: number } {
  const ke = 60 / (2 * Math.PI * mp.kv) / mp.kvLoadFactor;
  const Rw = mp.rmOhm + mp.escOhm;
  let kQ = kQ0;
  // one fixed-point pass for the Reynolds torque correction (matches RotorAero)
  for (let it = 0; it < 3; it++) {
    const op = solve(kQ);
    if (!tipRef) return op;
    const rr = (op.omega * R) / tipRef;
    kQ = rr < 1 ? kQ0 * Math.min(1.45, Math.pow(Math.max(rr, 0.05), -0.18)) : kQ0;
    if (it === 2) return solve(kQ);
  }
  return solve(kQ);
  function solve(kQ: number) {
  const R = Rw;
  const wRef = (mp.kv * 10 * 2 * Math.PI) / 60;
  // ke (D V − ke ω)/R = kQ ω² + ke i0 (0.35 + 0.65 ω/wRef)   -> quadratic in ω
  const a = kQ, b = (ke * ke) / R + (ke * mp.i0A * 0.65) / wRef, c = ke * mp.i0A * 0.35 - (ke * D * V) / R;
  let w = (-b + Math.sqrt(Math.max(0, b * b - 4 * a * c))) / (2 * a);
  let i = (D * V - ke * w) / R;
  if (i > mp.escCurrentLimitA) {
    i = mp.escCurrentLimitA;
    // torque-limited: ke i = kQ w² + loss
    w = Math.sqrt(Math.max(0, (ke * i - ke * mp.i0A * 0.6) / kQ));
  }
  return { omega: w, current: i * D / mp.escEfficiency, thrust: kT * w * w };
  }
}

function deriveInfo(spec: DroneSpec, p: QuadParams, components: DerivedInfo['components'], items: MassItem[], cg: V3, fRP: number): DerivedInfo {
  const mp = p.rotors[0].motor, t = p.rotors[0].table;
  const cells = p.battery.cellsSeries;
  const nominal = cells * 3.85;
  const sagR = (cells / p.battery.cellsParallel) * p.battery.r0CellOhm * 1.6 + p.battery.wiringOhm;
  const W = p.mass * 9.80665;
  // WOT with sag (fixed-point on bus voltage)
  let V = cells * 4.1;
  let wot = staticOperatingPoint(mp, t.kT, t.kQ, 1, V, t.tipRef, t.R);
  for (let i = 0; i < 30; i++) { V = 0.6 * V + 0.4 * Math.max(cells * 2.5, cells * 4.1 - 4 * wot.current * sagR); wot = staticOperatingPoint(mp, t.kT, t.kQ, 1, V, t.tipRef, t.R); }
  // hover: bisection on duty, with the bus-voltage sag solved at each trial duty
  const atDuty = (D: number) => {
    let op = staticOperatingPoint(mp, t.kT, t.kQ, D, nominal, t.tipRef, t.R);
    for (let i = 0; i < 8; i++) op = staticOperatingPoint(mp, t.kT, t.kQ, D, nominal - (4 * op.current + p.auxPowerW / nominal) * sagR, t.tipRef, t.R);
    return op;
  };
  let lo = 0, hi = 1, hov = wot;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    hov = atDuty(mid);
    if (hov.thrust * 4 > W) hi = mid; else lo = mid;
  }
  const hoverD = (lo + hi) / 2;
  const hoverI = hov.current * 4 + p.auxPowerW / nominal;
  const capAh = p.battery.capacityAh * 0.8; // 80% usable
  // top speed: balance of forward-tilted thrust vs drag (rough: use 90% of WOT thrust, body CdA at ~60° pitch)
  const Tmax = wot.thrust * 4 * 0.75; // thrust loss with advance ratio at speed
  let vTop = 0;
  for (let v = 1; v < 120; v += 0.5) {
    const thetaT = Math.acos(Math.min(1, W / Tmax));
    const cdA = p.cdA.x * Math.cos(thetaT) ** 2 + p.cdA.z * Math.sin(thetaT) ** 2 + 0.006; // + rotor H drag
    const drag = 0.5 * 1.225 * v * v * cdA;
    if (drag > Tmax * Math.sin(thetaT)) { vTop = v; break; }
  }
  return {
    components, massItems: items, auwG: p.mass * 1000,
    cgMm: { x: cg.x * 1000, y: cg.y * 1000, z: cg.z * 1000 }, inertia: p.inertia,
    staticThrustN: wot.thrust, thrustToWeight: (wot.thrust * 4) / W,
    hoverThrottle: hoverD, hoverCurrentA: hoverI, wotCurrentA: wot.current * 4,
    hoverRpm: (hov.omega * 60) / (2 * Math.PI), wotRpm: (wot.omega * 60) / (2 * Math.PI),
    flightTimeHoverMin: (capAh / hoverI) * 60,
    flightTimeMixedMin: (capAh / (hoverI * 2.2)) * 60,
    estTopSpeedKmh: vTop * 3.6,
    frameFreqHz: fRP,
  };
  void spec;
}
