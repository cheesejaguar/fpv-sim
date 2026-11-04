// Fixed-wing builds: an airframe (src/data/airframes.ts) with its motors, props, battery, ESC, FC
// and video system becomes the same DroneBuild a quad is, with lifting surfaces in params.surfaces.
// The build is set up the way a pilot sets up the real plane:
//   - the CG goes where the static margin puts it ahead of the neutral point (from the wing's and
//     tail's lift slopes, the tail volume and the downwash), and the battery slides to put it there;
//   - the tail's incidence (a flying wing's reflex) is solved so the plane trims hands off, elevator
//     centred, at the cruise speed it was designed for;
//   - ArduPlane gets the servo map of the layout (SERVOn_FUNCTION) and the airframe's parameters.
// Axes while building: x forward from the wing root's leading edge, z up; everything is moved to be
// relative to the CG at the end (body FLU, as the plant expects).
import { airframeById, AirframeSpec, PLANE_PARAMS_COMMON } from '../data/airframes';
import { BATTERIES, ESCS, FCS, MOTORS, PROPS, VIDEO, byId } from '../data/catalog';
import { batteryFromSpec } from '../sim/battery';
import { ColliderSphere } from '../sim/contact';
import { GYRO_CHIPS } from '../sim/imu';
import { V3 } from '../sim/math';
import { MotorParams } from '../sim/motor';
import { QuadParams, RotorConfig, STRENGTH } from '../sim/quad';
import { emptyRotorOut, RotorAero } from '../sim/rotor';
import { emptySurfaceOut, evaluateSurface, liftSlope, SurfaceConfig } from '../sim/wing';
import type { DerivedInfo, DroneBuild, DroneSpec } from './derive';
import { propTable, specSeed, staticOperatingPoint } from './derive';

const DEG = Math.PI / 180, G = 9.80665, RHO = 1.225;

/** What a plane build adds to its DerivedInfo. */
export interface PlaneInfo {
  airframe: AirframeSpec;
  spanM: number; areaM2: number; aspect: number; macM: number;
  wingLoadingGdm2: number;
  stallKmh: number; cruiseKmh: number; topKmh: number;
  /** throttle and battery current that hold the design cruise level; endurance and range there (80 % of the pack) */
  cruiseThrottle: number; cruiseCurrentA: number; enduranceMin: number; rangeKm: number;
  /** best glide ratio (motor off) */
  glideRatio: number;
  staticMarginPct: number;
  /** where the CG ended up behind the wing root's leading edge (mm); whether the battery could reach it */
  cgAftOfLeMm: number;
  balanced: boolean;
  /** ArduPlane: SERVOn_FUNCTION by output (1-based) and the full starting parameter set */
  servoFunctions: Record<number, number>;
  params: Record<string, number>;
  /** servo output (0-based) that drives each rotor's ESC */
  motorChannels: number[];
}

interface MassItem { name: string; m: number; pos: V3; box: V3 }

/** Servo outputs (0-based) and ArduPlane functions for a layout and motor count. */
function servoMap(a: AirframeSpec): { functions: Record<number, number>; motors: number[] } {
  const twin = a.motors.count === 2;
  if (a.layout === 'flyingwing') {
    // SERVO1 left elevon, SERVO2 right elevon, SERVO3 throttle (left), SERVO4 throttle right
    return twin ? { functions: { 1: 77, 2: 78, 3: 73, 4: 74 }, motors: [2, 3] } : { functions: { 1: 77, 2: 78, 3: 70 }, motors: [2] };
  }
  if (a.layout === 'vtail') {
    // SERVO1 aileron, SERVO2 V-tail left, SERVO3 throttle (left), SERVO4 V-tail right, SERVO5 throttle right
    return twin ? { functions: { 1: 4, 2: 79, 3: 73, 4: 80, 5: 74 }, motors: [2, 4] } : { functions: { 1: 4, 2: 79, 3: 70, 4: 80 }, motors: [2] };
  }
  // SERVO1 aileron, SERVO2 elevator, SERVO3 throttle, SERVO4 rudder (AETR)
  return twin ? { functions: { 1: 4, 2: 19, 3: 73, 4: 21, 5: 74 }, motors: [2, 4] } : { functions: { 1: 4, 2: 19, 3: 70, 4: 21 }, motors: [2] };
}

export function buildPlane(spec: DroneSpec): DroneBuild {
  const a = airframeById(spec.frame);
  if (!a) throw new Error(`unknown airframe ${spec.frame}`);
  const ov = spec.overrides;
  const motor = byId(MOTORS, spec.motor), prop = byId(PROPS, spec.prop), battery = byId(BATTERIES, spec.battery);
  const esc = byId(ESCS, spec.esc), fc = byId(FCS, spec.fc), video = byId(VIDEO, spec.video);
  const map = servoMap(a);

  // ---------- planform ----------
  const b = a.spanMm / 1000, S = a.wingAreaDm2 / 100, lam = a.taper, AR = (b * b) / S;
  const cr = (2 * S) / (b * (1 + lam));
  const mac = (2 / 3) * cr * (1 + lam + lam * lam) / (1 + lam);
  const yMac = (b / 6) * (1 + 2 * lam) / (1 + lam);
  const xLeMac = -yMac * Math.tan(a.sweepDeg * DEG);
  const xAcW = xLeMac - 0.25 * mac;
  const zAcW = yMac * Math.tan(a.dihedralDeg * DEG);
  const aw = liftSlope(AR);

  // ---------- neutral point and the CG the battery has to reach ----------
  let xNp = xAcW;
  const xAcT = xAcW - a.tail.armMm / 1000;
  const vAng = (a.tail.vAngleDeg ?? 0) * DEG;
  const hEff = a.layout === 'vtail' ? (a.tail.hAreaDm2 / 100) * Math.cos(vAng) ** 2 : a.tail.hAreaDm2 / 100;
  if (a.layout !== 'flyingwing' && hEff > 0) {
    const at = liftSlope(a.layout === 'vtail' ? 3.2 : 4.2), deps = (2 * aw) / (Math.PI * AR);
    const VH = (hEff * (a.tail.armMm / 1000)) / (S * mac);
    xNp = xAcW - 0.9 * VH * (at / aw) * (1 - deps) * mac;
  }
  const xCgTarget = xNp + a.staticMargin * mac;

  // ---------- mass budget ----------
  const items: MassItem[] = [];
  const fus = a.fuselage, fL = fus.lengthMm / 1000, fW = fus.widthMm / 1000, fH = fus.heightMm / 1000, xNose = fus.noseMm / 1000;
  const am = a.airframeMassG / 1000 * (ov.massScale ?? 1);
  // foam wings carry most of it; the tail feathers are light (on a boom, the boom is with the fuselage,
  // whose pod holds the servos, linkages and hatch: its mass sits well forward of the boom's middle)
  const wingShare = a.layout === 'flyingwing' ? 0.75 : 0.5, tailShare = a.layout === 'flyingwing' ? 0.1 : 0.1;
  for (const sy of [1, -1]) items.push({ name: sy > 0 ? 'left wing' : 'right wing', m: am * wingShare / 2, pos: { x: xLeMac - 0.4 * mac, y: sy * yMac, z: zAcW * 0.5 }, box: { x: mac, y: b / 2, z: 0.02 } });
  items.push({ name: 'fuselage', m: am * (1 - wingShare - tailShare), pos: { x: xNose - fL * 0.4, y: 0, z: -fH * 0.2 }, box: { x: fL, y: fW, z: fH } });
  if (a.layout === 'flyingwing') {
    const w = a.winglets!;
    for (const sy of [1, -1]) items.push({ name: 'winglet', m: am * tailShare / 2, pos: { x: -(b / 2) * Math.tan(a.sweepDeg * DEG) - 0.5 * cr * lam - w.aftMm / 1000 * 0.3, y: sy * b / 2, z: w.heightMm / 2000 }, box: { x: 0.08, y: 0.005, z: w.heightMm / 1000 } });
  } else items.push({ name: 'tail', m: am * tailShare, pos: { x: xAcT, y: 0, z: 0.03 }, box: { x: 0.12, y: Math.sqrt(a.tail.hAreaDm2 / 100 * 4.2), z: 0.08 } });
  const mot = a.motors, n = mot.count;
  const hubs: V3[] = n === 2 ? [{ x: mot.xMm / 1000, y: mot.yMm / 1000, z: mot.zMm / 1000 }, { x: mot.xMm / 1000, y: -mot.yMm / 1000, z: mot.zMm / 1000 }] : [{ x: mot.xMm / 1000, y: 0, z: mot.zMm / 1000 }];
  for (const h of hubs) {
    items.push({ name: 'motor', m: motor.massG / 1000, pos: { ...h }, box: { x: motor.bellHeightMm / 1000, y: motor.bellDiaMm / 1000, z: motor.bellDiaMm / 1000 } });
    items.push({ name: 'prop', m: prop.massG / 1000, pos: { x: h.x + (mot.mount === 'tractor' ? 0.012 : -0.012), y: h.y, z: h.z }, box: { x: 0.01, y: 0.03, z: 0.03 } });
    items.push({ name: 'ESC', m: esc.massG / 1000, pos: { x: h.x * 0.6, y: h.y * 0.8, z: 0 }, box: { x: 0.04, y: 0.02, z: 0.008 } });
  }
  items.push({ name: 'FC + GPS', m: fc.massG / 1000, pos: { x: xNose * 0.25, y: 0, z: fH * 0.3 }, box: { x: 0.04, y: 0.04, z: 0.015 } });
  items.push({ name: 'video system', m: video.massG / 1000, pos: { x: xNose - 0.03, y: 0, z: fH * 0.1 }, box: { x: 0.03, y: 0.03, z: 0.025 } });
  items.push({ name: 'receiver + wiring', m: 0.012 + 0.012 * b, pos: { x: 0, y: 0, z: 0 }, box: { x: 0.05, y: 0.03, z: 0.01 } });
  if (spec.extraMassG > 0) items.push({ name: 'extra (action cam, GPS, payload)', m: spec.extraMassG / 1000, pos: { x: xNose * 0.5, y: 0, z: fH * 0.4 }, box: { x: 0.06, y: 0.04, z: 0.03 } });
  const bd = battery.dims, capScale = (ov.capacityMah ?? battery.capacityMah) / battery.capacityMah * ((ov.cells ?? battery.cells) / battery.cells);
  const mBat = (battery.massG * capScale) / 1000;
  // the battery slides along the fuselage bay to balance the plane (as on the real one)
  const others = items.reduce((s, it) => s + it.m, 0), mxOthers = items.reduce((s, it) => s + it.m * it.pos.x, 0);
  const bayFwd = xNose - 0.015 - bd[0] / 2000, bayAft = xNose - fL * 0.85 + bd[0] / 2000;
  const xBatWant = (xCgTarget * (others + mBat) - mxOthers) / mBat;
  const xBat = Math.max(bayAft, Math.min(bayFwd, xBatWant));
  items.push({ name: 'battery', m: mBat, pos: { x: xBat, y: 0, z: -fH * 0.15 }, box: { x: bd[0] / 1000, y: bd[1] / 1000, z: bd[2] / 1000 } });
  const M = items.reduce((s, it) => s + it.m, 0);
  const cg = { x: 0, y: 0, z: 0 };
  for (const it of items) { cg.x += it.m * it.pos.x; cg.y += it.m * it.pos.y; cg.z += it.m * it.pos.z; }
  cg.x /= M; cg.y /= M; cg.z /= M;
  const rel = (p: V3): V3 => ({ x: p.x - cg.x, y: p.y - cg.y, z: p.z - cg.z });

  // ---------- inertia about the CG ----------
  let Ixx = 0, Iyy = 0, Izz = 0, Ixy = 0, Ixz = 0, Iyz = 0;
  for (const it of items) {
    const r = rel(it.pos), bx = it.box;
    Ixx += it.m * (bx.y * bx.y + bx.z * bx.z) / 12 + it.m * (r.y * r.y + r.z * r.z);
    Iyy += it.m * (bx.x * bx.x + bx.z * bx.z) / 12 + it.m * (r.x * r.x + r.z * r.z);
    Izz += it.m * (bx.x * bx.x + bx.y * bx.y) / 12 + it.m * (r.x * r.x + r.y * r.y);
    Ixy += it.m * r.x * r.y; Ixz += it.m * r.x * r.z; Iyz += it.m * r.y * r.z;
  }
  const iS = ov.inertiaScale ?? 1;
  const inertia = { xx: Ixx * iS, yy: Iyy * iS, zz: Izz * iS, xy: Ixy * iS, xz: Ixz * iS, yz: Iyz * iS };

  // ---------- lifting surfaces ----------
  const af = a.airfoil, surfaces: SurfaceConfig[] = [];
  const dih = a.dihedralDeg * DEG, X = { x: 1, y: 0, z: 0 };
  const ailTau = a.layout === 'flyingwing' ? 0.38 : 0.26;
  for (const [sy, name] of [[1, 'left wing'], [-1, 'right wing']] as const) {
    const ch = a.layout === 'flyingwing' ? (sy > 0 ? 0 : 1) : 0;
    surfaces.push({
      name, pos: rel({ x: xAcW, y: sy * yMac, z: zAcW }), normal: { x: 0, y: -sy * Math.sin(dih), z: Math.cos(dih) }, chord: X,
      area: S / 2, mac, aspect: AR, cl0: af.cl0, cd0: af.cd0, cm0: af.cm0, stallDeg: af.stallDeg, oswald: 0.8,
      // ailerons (one output, the halves move opposite) or elevons (one output each, trailing edge up for +)
      control: a.layout === 'flyingwing'
        ? { channel: ch, tau: ailTau, maxDeg: a.throwsDeg.elevon ?? 16, sign: -1 }
        : { channel: 0, tau: ailTau, maxDeg: a.throwsDeg.aileron ?? 20, sign: sy > 0 ? 1 : -1 },
    });
  }
  // a tractor's slipstream over the wing behind it
  if (mot.mount === 'tractor' && n === 2) {
    const D = prop.diameterIn * 0.0254, frac = Math.min(0.6, (0.85 * D) / (b / 2));
    surfaces[0].slipstream = { rotor: 0, frac }; surfaces[1].slipstream = { rotor: 1, frac };
  }
  const deps = 2 / (Math.PI * AR); // downwash angle per unit wing CL
  if (a.layout === 'conventional') {
    const Sh = a.tail.hAreaDm2 / 100, Sv = a.tail.vAreaDm2 / 100, hSpan = Math.sqrt(Sh * 4.2);
    surfaces.push({ name: 'tailplane', pos: rel({ x: xAcT, y: 0, z: 0.03 }), normal: { x: 0, y: 0, z: 1 }, chord: X, area: Sh, mac: Sh / hSpan, aspect: 4.2, cl0: 0, cd0: 0.012, cm0: 0, stallDeg: 14, oswald: 0.8,
      control: { channel: 1, tau: 0.5, maxDeg: a.throwsDeg.elevator ?? 18, sign: -1 }, downwash: { from: 0, perCl: deps } });
    const vH = Math.sqrt(Sv * 1.6);
    surfaces.push({ name: 'fin', pos: rel({ x: xAcT - 0.02, y: 0, z: 0.03 + vH * 0.45 }), normal: { x: 0, y: 1, z: 0 }, chord: X, area: Sv, mac: Sv / vH, aspect: 1.6, cl0: 0, cd0: 0.012, cm0: 0, stallDeg: 18, oswald: 0.75,
      control: { channel: 3, tau: 0.5, maxDeg: a.throwsDeg.rudder ?? 25, sign: 1 } });
  } else if (a.layout === 'vtail') {
    const Sp = a.tail.hAreaDm2 / 200, pSpan = Math.sqrt(Sp * 3.2 / 2) * 2 * 0.5;
    for (const [sy, name, ch] of [[1, 'V-tail left', 1], [-1, 'V-tail right', 3]] as const) {
      surfaces.push({
        name, pos: rel({ x: xAcT, y: sy * pSpan * 0.5 * Math.cos(vAng), z: 0.03 + pSpan * 0.5 * Math.sin(vAng) }),
        normal: { x: 0, y: -sy * Math.sin(vAng), z: Math.cos(vAng) }, chord: X, area: Sp, mac: Sp / pSpan, aspect: 3.2, cl0: 0, cd0: 0.012, cm0: 0, stallDeg: 14, oswald: 0.8,
        control: { channel: ch, tau: 0.45, maxDeg: a.throwsDeg.ruddervator ?? 18, sign: -1 }, downwash: { from: 0, perCl: deps },
        ...(mot.mount === 'pusher' && mot.xMm / 1000 > xAcT ? { slipstream: { rotor: 0, frac: 0.35 } } : {}),
      });
    }
  } else {
    const w = a.winglets!, Sw = w.areaDm2 / 100, hW = w.heightMm / 1000, xTip = -(b / 2) * Math.tan(a.sweepDeg * DEG) - 0.25 * cr * lam;
    for (const [sy, name] of [[1, 'left winglet'], [-1, 'right winglet']] as const) {
      surfaces.push({ name, pos: rel({ x: xTip - w.aftMm / 1000 * 0.3, y: sy * b / 2, z: hW / 2 }), normal: { x: 0, y: 1, z: 0 }, chord: X, area: Sw, mac: Sw / hW, aspect: 1.5, cl0: 0, cd0: 0.012, cm0: 0, stallDeg: 18, oswald: 0.75 });
    }
  }

  // ---------- propulsion ----------
  const table = propTable(prop, ov.propPitchIn);
  const tbl = (ov.propThrustScale || ov.propTorqueScale)
    ? { ...table, ctScale: table.ctScale * (ov.propThrustScale ?? 1), cqScale: table.cqScale * (ov.propTorqueScale ?? 1), kT: table.kT * (ov.propThrustScale ?? 1), kQ: table.kQ * (ov.propTorqueScale ?? 1) }
    : table;
  const R = tbl.R, propInertia = 0.22 * (prop.massG / 1000) * R * R;
  const mp: MotorParams = {
    kv: ov.kv ?? motor.kv, rmOhm: (ov.rmMohm ?? motor.rmMohm) / 1000, escOhm: esc.equivOhm, i0A: ov.i0A ?? motor.i0A,
    poles: motor.poles, rotorInertia: motor.rotorInertia, massKg: motor.massG / 1000,
    thermalCapJPerK: motor.thermalCap, thermalResKPerW: motor.thermalRes, kvLoadFactor: 0.94,
    escCurrentLimitA: ov.escCurrentLimitA ?? 0, escEfficiency: esc.efficiency,
  };
  const rotors: RotorConfig[] = hubs.map((h, k) => ({
    pos: rel(h), axis: { x: 1, y: 0, z: 0 },
    // twins counter-rotate (their torques cancel); a single prop spins the usual way, seen from behind
    dir: n === 2 ? (k === 0 ? 1 : -1) : 1,
    motor: { ...mp }, table: tbl, propInertia, propMass: prop.massG / 1000, bladeCount: prop.blades, folding: prop.folding,
    imbalance: ov.propImbalance ?? 2e-7 * (prop.massG / 4.3),
    strength: { prop: STRENGTH.prop * Math.pow(prop.massG, 2 / 3) * (0.5 + prop.stiffness), shaft: STRENGTH.shaft * Math.pow(motor.massG, 2 / 3), arm: 1e6 },
  }));

  // ---------- fuselage drag, colliders ----------
  const cdS = ov.cdAScale ?? 1;
  // the plant's airframe drag is 0.5 rho U cdA u per axis: across the fuselage that is a normal force
  // linear in the flow angle, which for a slender body is 2 x its cross-section per radian (Munk)
  const cdA = { x: 0.12 * fW * fH * cdS + 0.0004 * n, y: 2 * fW * fH * cdS, z: 2 * fW * fH * cdS };
  const colliders: ColliderSphere[] = [];
  const add = (p: V3, r: number, kind: ColliderSphere['kind'], rotor = -1) => colliders.push({ pos: rel(p), radius: r, kind, rotor });
  const belly = -fH * 0.45, rb = Math.min(fW, fH) * 0.4;
  for (const f of [0.05, 0.3, 0.55, 0.8, 1]) add({ x: xNose - f * fL, y: 0, z: belly + rb }, rb, f < 0.1 ? 'camera' : 'frame');
  for (const f of [0.25, 0.55, 0.85, 1]) for (const sy of [1, -1]) {
    const y = sy * f * b / 2, x = -f * (b / 2) * Math.tan(a.sweepDeg * DEG) - 0.4 * cr * (1 - (1 - lam) * f);
    add({ x, y, z: f * (b / 2) * Math.tan(dih) }, 0.012 + 0.01 * (1 - f), 'frame');
  }
  if (a.layout !== 'flyingwing') for (const sy of [1, -1, 0]) add({ x: xAcT, y: sy * 0.08, z: 0.03 }, 0.015, 'frame');
  hubs.forEach((h, k) => {
    add(h, motor.bellDiaMm / 2000, 'motor', k);
    for (let j = 0; j < 8; j++) { const t = (j / 8) * 2 * Math.PI; add({ x: h.x + (mot.mount === 'tractor' ? 0.012 : -0.012), y: h.y + Math.cos(t) * R * 0.9, z: h.z + Math.sin(t) * R * 0.9 }, 0.006, 'prop', k); }
  });

  // ---------- battery, IMU ----------
  const bp = batteryFromSpec({
    chemistry: battery.chemistry, cells: ov.cells ?? battery.cells, parallel: battery.parallel,
    capacityMah: ov.capacityMah ?? battery.capacityMah, cRating: battery.cRating,
    irPerCellMohm: ov.irPerCellMohm ?? battery.irPerCellMohm, massG: battery.massG * capScale, ageFactor: spec.batteryAge, wiringMohm: battery.wiringMohm,
    seed: specSeed(spec),
  });
  const params: QuadParams = {
    mass: M, inertia, rotors, cdA, dragCenter: rel({ x: xNose - fL / 2, y: 0, z: 0 }),
    angularDrag: { x: 1e-5, y: 1e-5, z: 1e-5 },
    battery: bp, auxPowerW: ov.auxPowerW ?? video.powerW + 2.5,
    colliders, imuChip: GYRO_CHIPS[fc.gyro],
    // a foam airframe: low, well damped structural modes, little vibration reaches the board
    flex: { roll: { freqHz: 45, zeta: 0.2, gain: 0.3 }, pitch: { freqHz: 55, zeta: 0.2, gain: 0.3 }, yaw: { freqHz: 70, zeta: 0.2, gain: 0.05 } },
    mountIsolation: fc.softMount, seed: specSeed(spec),
    surfaces, servoSlewDegPerS: 400,
  };

  // ---------- trim at the design cruise ----------
  const W = M * G, Vc = a.cruiseKmh / 3.6;
  trimSurfaces(a, params, W, Vc);

  const plane = performance(a, params, W, Vc, S, AR, mac, map, spec);
  plane.cgAftOfLeMm = -cg.x * 1000;
  plane.balanced = Math.abs(xBat - xBatWant) < 1e-6;
  plane.staticMarginPct = ((cg.x - xNp) / mac) * 100;
  const info = planeDerivedInfo(spec, params, { motor, prop, battery, esc, fc, video }, items, cg, plane);
  return { spec, params, info, tables: tbl };
}

/**
 * Sum of the surfaces' forces and pitching moment at airspeed V and angle of attack alpha, controls
 * centred; vi: each rotor's induced velocity (its slipstream over the surfaces behind it, as the plant has it).
 */
function surfaceTotals(p: QuadParams, V: number, alpha: number, vi?: number[]) {
  const outs = p.surfaces!.map(() => emptySurfaceOut());
  let fx = 0, fz = 0, my = 0;
  p.surfaces!.forEach((sc, i) => {
    const u = { x: V * Math.cos(alpha), y: 0, z: -V * Math.sin(alpha) };
    if (sc.slipstream && vi) { const ax = p.rotors[sc.slipstream.rotor].axis, sl = 2 * vi[sc.slipstream.rotor] * sc.slipstream.frac; u.x += ax.x * sl; u.y += ax.y * sl; u.z += ax.z * sl; }
    if (sc.downwash) u.z += sc.downwash.perCl * outs[sc.downwash.from].cl * Math.abs(u.x);
    const o = evaluateSurface(sc, u, RHO, 0, outs[i]);
    fx += o.fx; fz += o.fz; my += o.my;
  });
  // the fuselage, as the plant has it: 0.5 rho U cdA u per axis, acting at the drag centre
  const ux = V * Math.cos(alpha), uz = -V * Math.sin(alpha), qd = 0.5 * RHO * V;
  const dx = -qd * p.cdA.x * ux, dz = -qd * p.cdA.z * uz;
  fx += dx; fz += dz; my += p.dragCenter.z * dx - p.dragCenter.x * dz;
  return { fx, fz, my, lift: fz * Math.cos(alpha) + fx * Math.sin(alpha), drag: -(fx * Math.cos(alpha) - fz * Math.sin(alpha)) };
}

/**
 * Trim at the design cruise: the angle of attack that carries the weight and the tail incidence (a
 * flying wing: the wing's reflex, cm0) that zeroes the pitching moment with the controls centred,
 * the thrust line's moment included. Newton's method on both.
 */
function trimSurfaces(a: AirframeSpec, p: QuadParams, W: number, V: number) {
  const sf = p.surfaces!, wing = sf.filter((s) => s.name.endsWith('wing')), tail = sf.filter((s) => s.name.startsWith('tailplane') || s.name.startsWith('V-tail'));
  const knob = (k: number) => { if (a.layout === 'flyingwing') for (const s of wing) s.cm0 = k; else for (const s of tail) s.cl0 = k; };
  let k = a.layout === 'flyingwing' ? a.airfoil.cm0 : 0, alpha = 3 * DEG;
  const thrustArm = p.rotors.reduce((s, r) => s + r.pos.z, 0) / p.rotors.length;
  // momentum theory: each prop's induced velocity when the props together hold the speed (thrust = drag)
  const A = Math.PI * p.rotors[0].table.R ** 2, n = p.rotors.length;
  const resid = (al: number, kk: number) => {
    knob(kk);
    const T = Math.max(0, surfaceTotals(p, V, al).drag) / n, v = (-V + Math.sqrt(V * V + (2 * T) / (RHO * A))) / 2;
    const t = surfaceTotals(p, V, al, p.rotors.map(() => v));
    // the thrust that holds the speed acts along x at the motors' height: a moment about y
    const myThrust = thrustArm * Math.max(0, t.drag);
    return [t.lift - W, t.my + myThrust];
  };
  for (let it = 0; it < 30; it++) {
    const r = resid(alpha, k), h1 = 1e-4, h2 = 1e-4;
    const ra = resid(alpha + h1, k), rk = resid(alpha, k + h2);
    const J = [[(ra[0] - r[0]) / h1, (rk[0] - r[0]) / h2], [(ra[1] - r[1]) / h1, (rk[1] - r[1]) / h2]];
    const det = J[0][0] * J[1][1] - J[0][1] * J[1][0];
    if (Math.abs(det) < 1e-12) break;
    const da = (r[0] * J[1][1] - r[1] * J[0][1]) / det, dk = (J[0][0] * r[1] - J[1][0] * r[0]) / det;
    alpha -= Math.max(-0.05, Math.min(0.05, da)); k -= Math.max(-0.2, Math.min(0.2, dk));
    if (Math.abs(da) < 1e-7 && Math.abs(dk) < 1e-7) break;
  }
  knob(Math.max(-1.2, Math.min(1.2, k)));
}

/** Level-flight performance with the same rotor and surface models the plant flies. */
function performance(a: AirframeSpec, p: QuadParams, W: number, Vc: number, S: number, AR: number, mac: number, map: ReturnType<typeof servoMap>, spec: DroneSpec): PlaneInfo {
  const rc = p.rotors[0], mp = rc.motor, n = p.rotors.length, cells = p.battery.cellsSeries;
  const sagR = (cells / p.battery.cellsParallel) * p.battery.r0CellOhm * 1.6 + p.battery.wiringOhm;
  const ro = new RotorAero(rc.table, 1), o = emptyRotorOut();
  const ke = 60 / (2 * Math.PI * mp.kv) / mp.kvLoadFactor, Rw = mp.rmOhm + mp.escOhm, wRef = (mp.kv * 10 * 2 * Math.PI) / 60;
  /** thrust (all motors) and battery current at airspeed V and duty D */
  const thrustAt = (V: number, D: number) => {
    let Vbus = cells * 3.8, T = 0, I = 0, Q = 0;
    for (let pass = 0; pass < 3; pass++) {
      const tq = (w: number) => ke * Math.max(0, (D * Vbus - ke * w) / Rw) - ke * mp.i0A * (0.35 + 0.65 * w / wRef);
      let lo = 0, hi = (D * Vbus) / ke;
      for (let i = 0; i < 30; i++) { const w = (lo + hi) / 2; ro.evaluate(w, V, 0, RHO, Infinity, 0, 1e-4, o); if (tq(w) > o.torque) lo = w; else hi = w; }
      ro.evaluate(lo, V, 0, RHO, Infinity, 0, 1e-4, o);
      T = n * o.thrust; Q = o.torque;
      I = n * Math.max(0, (D * Vbus - ke * lo) / Rw) * D / mp.escEfficiency + p.auxPowerW / Vbus;
      Vbus = Math.max(cells * 3.0, cells * 3.85 - I * sagR);
    }
    return { T, I, Q };
  };
  /** drag in level flight at V: the angle of attack that carries the weight */
  const dragAt = (V: number) => {
    let lo = -0.2, hi = 0.5;
    for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (surfaceTotals(p, V, m).lift > W) hi = m; else lo = m; }
    return surfaceTotals(p, V, lo).drag;
  };
  const wing = p.surfaces![0], clMax = wing.cl0 + liftSlope(AR) * wing.stallDeg * DEG;
  const vStall = Math.sqrt((2 * W) / (RHO * S * clMax));
  let vTop = Vc;
  { let lo = vStall, hi = 80; for (let i = 0; i < 30; i++) { const m = (lo + hi) / 2; if (thrustAt(m, 1).T > dragAt(m)) lo = m; else hi = m; } vTop = lo; }
  const Dc = dragAt(Vc);
  let dLo = 0, dHi = 1;
  for (let i = 0; i < 30; i++) { const m = (dLo + dHi) / 2; if (thrustAt(Vc, m).T > Dc) dHi = m; else dLo = m; }
  const cruise = thrustAt(Vc, dHi), capAh = p.battery.capacityAh * 0.8;
  // the props' torque at cruise rolls the plane (twins cancel theirs): a builder warps the wing a
  // touch against it (one half's incidence up, the other's down) so it still flies hands off
  const torqueRoll = -p.rotors.reduce((s2, r) => s2 + r.dir * r.axis.x, 0) * cruise.Q;
  const wl = p.surfaces!.find((x) => x.name === 'left wing')!, wr = p.surfaces!.find((x) => x.name === 'right wing')!;
  // left half +warp/2, right -warp/2: a roll moment of q S y_mac warp / 2
  const warp = (-2 * torqueRoll) / (0.5 * RHO * Vc * Vc * S * ((wl.pos.y - wr.pos.y) / 2));
  wl.cl0 += warp / 2; wr.cl0 -= warp / 2;
  let ld = 0;
  for (let V = vStall * 1.05; V < vTop; V += 0.5) ld = Math.max(ld, W / dragAt(V));
  const functions = map.functions, params: Record<string, number> = { ...PLANE_PARAMS_COMMON, ...a.params };
  for (const [out, fn] of Object.entries(functions)) params[`SERVO${out}_FUNCTION`] = fn;
  // the motors' outputs are throttles (1000-2000 us), the rest servos centred at 1500
  for (const ch of map.motors) { params[`SERVO${ch + 1}_MIN`] = 1000; params[`SERVO${ch + 1}_MAX`] = 2000; params[`SERVO${ch + 1}_TRIM`] = 1000; }
  params.AIRSPEED_CRUISE = Math.round(Vc);
  params.TRIM_THROTTLE = Math.round(Math.min(90, Math.max(20, dHi * 100)));
  params.BATT_CAPACITY = Math.round(p.battery.capacityAh * 1000);
  params.BATT_MONITOR = 4;
  void spec;
  return {
    airframe: a, spanM: a.spanMm / 1000, areaM2: S, aspect: AR, macM: mac,
    wingLoadingGdm2: (W / G) * 1000 / (S * 100),
    stallKmh: vStall * 3.6, cruiseKmh: Vc * 3.6, topKmh: vTop * 3.6,
    cruiseThrottle: dHi, cruiseCurrentA: cruise.I, enduranceMin: (capAh / cruise.I) * 60, rangeKm: (capAh / cruise.I) * Vc * 3.6,
    glideRatio: ld, staticMarginPct: 0, cgAftOfLeMm: 0, balanced: true,
    servoFunctions: functions, params, motorChannels: map.motors,
  };
}

function planeDerivedInfo(spec: DroneSpec, p: QuadParams, c: Omit<DerivedInfo['components'], 'frame'>, items: MassItem[], cg: V3, plane: PlaneInfo): DerivedInfo {
  const mp = p.rotors[0].motor, t = p.rotors[0].table, cells = p.battery.cellsSeries, n = p.rotors.length;
  const wot = staticOperatingPoint(mp, t.kT, t.kQ, 1, cells * 3.9, t.tipRef, t.R);
  const a = plane.airframe;
  return {
    // the airframe stands in for a quad frame where the UI shows one
    components: { frame: { id: a.id, name: a.name, sizeClass: `${a.spanMm} mm wing`, wheelbaseMm: a.spanMm, geometry: 'trueX', stretch: 1, armThicknessMm: 0, armWidthMm: 0, massG: a.airframeMassG, plateLengthMm: a.fuselage.lengthMm, plateWidthMm: a.fuselage.widthMm, stackHeightMm: a.fuselage.heightMm, maxProp: 0 }, ...c },
    massItems: items, auwG: p.mass * 1000,
    cgMm: { x: cg.x * 1000, y: cg.y * 1000, z: cg.z * 1000 }, inertia: p.inertia,
    staticThrustN: wot.thrust, thrustToWeight: (wot.thrust * n) / (p.mass * G),
    // for a plane: the cruise throttle and current stand where a quad's hover ones do
    hoverThrottle: plane.cruiseThrottle, hoverCurrentA: plane.cruiseCurrentA, wotCurrentA: wot.current * n,
    hoverRpm: 0, wotRpm: (wot.omega * 60) / (2 * Math.PI),
    flightTimeHoverMin: plane.enduranceMin, flightTimeMixedMin: plane.enduranceMin * 0.8,
    estTopSpeedKmh: plane.topKmh, frameFreqHz: 45,
    plane,
  };
  void spec;
}
