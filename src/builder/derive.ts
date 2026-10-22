// Procedural generation of the physical model from a component-level drone specification:
// mass budget, CG, full inertia tensor (parallel-axis over component boxes), rotor layout and spin
// directions, collider set, drag areas, structural modes, electrical parameters, and BEMT tables.
import { BATTERIES, ESCS, FCS, FRAMES, MOTORS, PROPS, VIDEO, byId, FrameSpec, MotorSpec, PropSpec, BatterySpec, EscSpec, FcSpec, VideoSpec } from '../data/catalog';
import { batteryFromSpec } from '../sim/battery';
import { airfoilAtRe, buildBemtTable, BemtTable, PropGeometry } from '../sim/bemt';
import { bemtManifest, decodeTable } from './bemtTables';
import { ColliderSphere } from '../sim/contact';
import { GYRO_CHIPS } from '../sim/imu';
import { V3 } from '../sim/math';
import { MotorParams } from '../sim/motor';
import { QuadParams, RotorConfig, STRENGTH } from '../sim/quad';
import { RotorAero, RotorAeroOut, emptyRotorOut } from '../sim/rotor';

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

// Camera uptilt follows how each class is flown (typical real setups): racers lean far forward at
// speed (45°), freestyle 5" ~30°, long range cruises ~25°, whoops indoors ~18-20°, cinewhoops are
// flown slow and level for footage (~10°).
export const PRESETS: DroneSpec[] = [
  DEFAULT_SPEC,
  { ...DEFAULT_SPEC, name: '5" Race 4S', frame: 'f5-race', motor: 'm2306-2450', prop: 'p-hq515', battery: 'b4s1500', esc: 'e45', fc: 'fc-bmi270', video: 'v-analog', extraMassG: 10, cameraUptiltDeg: 45 },
  { ...DEFAULT_SPEC, name: '5" Freestyle DJI O4 + GoPro', video: 'v-dji-o4', extraMassG: 25 + 60, extraMassZmm: 45, cameraUptiltDeg: 30 },
  { ...DEFAULT_SPEC, name: '5" HDZero 6S', video: 'v-hdzero', prop: 'p-hq5043' },
  { ...DEFAULT_SPEC, name: '7" Long Range Li-ion', frame: 'f7-lr', motor: 'm2806-1300', prop: 'p-hq7040', battery: 'b6s1p-p45b', esc: 'e45', video: 'v-dji-o3', batteryMount: 'bottom', extraMassG: 30, cameraUptiltDeg: 25 },
  // Beginner-friendly: fully guarded props, light enough to fly indoors and shrug off crashes
  { ...DEFAULT_SPEC, name: 'Beginner: 65 mm Tiny Whoop 1S', frame: 'f65-whoop', motor: 'm0702-26000', prop: 'p-31mm4', battery: 'b1s300hv', esc: 'e5aio', fc: 'fc-whoop-aio', video: 'v-analog-whoop', batteryMount: 'bottom', extraMassG: 0, extraMassZmm: 0, cameraUptiltDeg: 18, propDirection: 'props-out' },
  { ...DEFAULT_SPEC, name: 'Beginner: 75 mm Whoop 1S', frame: 'f75-whoop', motor: 'm0802-19000', prop: 'p-40mm3', battery: 'b1s450hv', esc: 'e5aio', fc: 'fc-whoop-aio', video: 'v-analog-whoop', batteryMount: 'bottom', extraMassG: 0, extraMassZmm: 0, cameraUptiltDeg: 20, propDirection: 'props-out' },
  { ...DEFAULT_SPEC, name: 'Beginner: 3" Cinewhoop 4S HD', frame: 'f3-cinewhoop', motor: 'm1404-3800', prop: 'p-hq3030', battery: 'b4s650', esc: 'e20aio', fc: 'fc-bmi270', video: 'v-dji-o4', batteryMount: 'top', extraMassG: 0, extraMassZmm: 0, cameraUptiltDeg: 10 },
  { ...DEFAULT_SPEC, name: '3" Toothpick 4S', frame: 'f3-toothpick', motor: 'm1404-3800', prop: 'p-gf3018', battery: 'b4s650', esc: 'e20aio', fc: 'fc-bmi270', video: 'v-analog', extraMassG: 5, extraMassZmm: 5, cameraUptiltDeg: 30 },
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
  /** Ducted frames: bottom of the duct guards (frame z, mm, arm plane = 0), what the quad stands on. */
  ductBottomMm?: number;
}

export interface DroneBuild { spec: DroneSpec; params: QuadParams; info: DerivedInfo; tables: BemtTable }

const tableCache = new Map<string, BemtTable>();

/** Blade chord at 0.75R (m). */
function chord75(p: PropSpec): number {
  const R = (p.diameterIn * 0.0254) / 2, cf = p.chordFracs;
  const u = ((0.75 - p.hubFrac) / (1 - p.hubFrac)) * (cf.length - 1), i0 = Math.min(cf.length - 2, Math.floor(u));
  return (cf[i0] + (cf[i0 + 1] - cf[i0]) * (u - i0)) * R;
}

export function propGeometry(p: PropSpec, pitchOverride?: number): PropGeometry {
  // section Reynolds number at 0.75R at the calibration (typical full-power) rpm
  const R = (p.diameterIn * 0.0254) / 2, c75 = chord75(p);
  const re75 = ((p.calib.rpm * 2 * Math.PI) / 60) * 0.75 * R * c75 / 1.5e-5;
  return {
    diameterM: p.diameterIn * 0.0254, pitchM: (pitchOverride ?? p.pitchIn) * 0.0254, blades: p.blades,
    hubRadiusFrac: p.hubFrac, chordFracs: p.chordFracs, washoutDeg: p.washoutDeg, airfoil: airfoilAtRe(re75),
  };
}

const tableKey = (p: PropSpec, pitch = p.pitchIn) => `${p.id}:${pitch}`;

/**
 * Where propTable() looks for a catalogue prop's table before building it: the test setup points it
 * at the precomputed tables on disk (tests/setup/propTables.ts), so test files don't each solve the
 * same tables again. The app doesn't use it: it fetches them ahead (preloadPropTable).
 */
let tableSource: ((propId: string) => BemtTable | null) | null = null;
export function setPropTableSource(f: ((propId: string) => BemtTable | null) | null) { tableSource = f; }

export function propTable(p: PropSpec, pitchOverride?: number): BemtTable {
  const key = tableKey(p, pitchOverride);
  let t = tableCache.get(key);
  if (!t) {
    // calibrate at the catalogue pitch; a pitch override then changes the result physically
    const base = pitchOverride != null && pitchOverride !== p.pitchIn ? propTable(p) : tableSource?.(p.id) ?? buildBemtTable(propGeometry(p), p.calib);
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

/** The headline numbers of a drone card (New Game screen): all-up weight, thrust-to-weight, flight time. */
export function droneCardStats(i: DerivedInfo): { auwG: number; tw: number; minutes: number } {
  return { auwG: i.auwG, tw: i.thrustToWeight, minutes: i.flightTimeMixedMin };
}

/** The prop's (catalogue-pitch) table is ready: buildDrone() won't spend ~1.2 s building it. */
export function hasPropTable(propId: string): boolean {
  const p = PROPS.find((x) => x.id === propId);
  return !!p && tableCache.has(tableKey(p));
}

const loading = new Map<string, Promise<boolean>>();
/**
 * Fetch the prop's precomputed table (see bemtTables.ts) so the next buildDrone() with it is quick.
 * Resolves true once the table is in place, false when there is none to fetch or the download
 * failed (buildDrone then computes it, as before). Never rejects.
 */
export function preloadPropTable(propId: string, opts: { url?: string; timeoutMs?: number } = {}): Promise<boolean> {
  const p = PROPS.find((x) => x.id === propId);
  if (!p) return Promise.resolve(false);
  if (tableCache.has(tableKey(p))) return Promise.resolve(true);
  const m = bemtManifest(), file = m?.tables[p.id];
  const url = opts.url ?? (m && file ? `${(import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/'}${m.base}${file}` : null);
  if (!url || typeof fetch !== 'function') return Promise.resolve(false);
  let pending = loading.get(url);
  if (!pending) {
    pending = (async () => {
      const ac = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = setTimeout(() => ac?.abort(), opts.timeoutMs ?? 8000);
      try {
        const res = await fetch(url, ac ? { signal: ac.signal } : {});
        if (!res.ok) return false;
        const t = decodeTable(await res.arrayBuffer());
        if (!tableCache.has(tableKey(p))) tableCache.set(tableKey(p), t); // (a table computed meanwhile stays)
        return true;
      } catch { return false; } finally { clearTimeout(timer); loading.delete(url); }
    })();
    loading.set(url, pending);
  }
  return pending;
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
  // electronics / hardware dimensions scale with the airframe (whoop AIO boards are ~25 mm, not 40)
  const sz = Math.max(0.55, Math.min(1, wb / 0.225));
  const ducted = !!frame.ducted;
  const ductH = (frame.ductHeightMm ?? 0) / 1000;
  const R0 = (prop.diameterIn * 0.0254) / 2;
  // ducted frames carry much of their mass in the duct rings around the props
  const plateM = frame.massG * (ducted ? 0.35 : 0.55) / 1000, armsM = frame.massG * (ducted ? 0.15 : 0.45) / 1000;
  const ductM = ducted ? frame.massG * 0.5 / 1000 : 0;
  items.push({ name: 'frame plates + standoffs', m: plateM, pos: { x: 0, y: 0, z: frame.stackHeightMm / 2000 }, box: { x: frame.plateLengthMm / 1000, y: frame.plateWidthMm / 1000, z: frame.stackHeightMm / 1000 } });
  for (let k = 0; k < 4; k++) {
    const h = hubs[k];
    const L = Math.hypot(h.x, h.y);
    items.push({ name: `arm ${k + 1}`, m: armsM / 4, pos: { x: h.x * 0.55, y: h.y * 0.55, z: 0 }, box: { x: L * Math.abs(h.x) / L + 0.012, y: L * Math.abs(h.y) / L + 0.012, z: frame.armThicknessMm / 1000 } });
    items.push({ name: `motor ${k + 1}`, m: motor.massG / 1000, pos: { x: h.x, y: h.y, z: motorZ }, box: { x: motor.bellDiaMm / 1000, y: motor.bellDiaMm / 1000, z: motor.bellHeightMm / 1000 } });
    items.push({ name: `prop ${k + 1}`, m: prop.massG / 1000, pos: { ...h }, box: { x: 0.03 * sz, y: 0.03 * sz, z: 0.008 * sz } }); // prop spin inertia handled separately
    // duct ring: a thin hoop of radius ~R has twice the inertia of a solid box that size; use a 1.4x box
    if (ducted) items.push({ name: `duct ${k + 1}`, m: ductM / 4, pos: { x: h.x, y: h.y, z: h.z }, box: { x: 2.8 * R0, y: 2.8 * R0, z: ductH } });
  }
  items.push({ name: 'ESC', m: esc.massG / 1000, pos: { x: 0, y: 0, z: 0.006 * sz }, box: { x: 0.04 * sz, y: 0.04 * sz, z: 0.006 * sz } });
  if (fc.massG > 0) items.push({ name: 'FC', m: fc.massG / 1000, pos: { x: 0, y: 0, z: 0.014 * sz }, box: { x: 0.036 * sz, y: 0.036 * sz, z: 0.006 * sz } });
  items.push({ name: 'video system', m: video.massG / 1000, pos: { x: frame.plateLengthMm / 2400, y: 0, z: frame.stackHeightMm / 2000 }, box: { x: 0.03 * sz, y: 0.03 * sz, z: 0.025 * sz } });
  // receiver, antennas, wiring, connector, capacitor, screws: scales with frame size (whoops ~1 g)
  items.push({ name: 'receiver + wiring + hardware', m: wb < 0.1 ? 0.0006 + 0.1 * wb * wb : 0.0025 + 0.65 * wb * wb, pos: { x: -0.02 * sz, y: 0, z: 0.012 * sz }, box: { x: 0.05 * sz, y: 0.03 * sz, z: 0.015 * sz } });
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
    // BLHeli_32 / AM32 / Bluejay ship with current protection off; an override turns the PI limiter on
    escCurrentLimitA: ov.escCurrentLimitA ?? 0, escEfficiency: esc.efficiency,
  };
  // blade flapping: Lock number γ = ρ a c R⁴ / I_β with I_β = m_b R²/3 (blades ~85 % of the prop mass);
  // first flap-bending frequency of the non-rotating blade ~200 Hz for a 5" polycarbonate blade,
  // ∝ thickness / length² (so ∝ 1/R for similar props), stiffer for glass-filled blades (est.)
  const lock = (3 * 1.225 * 5.3 * chord75(prop) * R * R * prop.blades) / (0.85 * (prop.massG / 1000));
  const flapHz = 200 * (0.0635 / R) * (0.6 + 0.8 * prop.stiffness);
  const tilt = ((spec.motorTiltDeg || 0) * Math.PI) / 180;
  const rotors: RotorConfig[] = hubs.map((h, k) => {
    // inward motor tilt (positive tilts thrust toward the centre)
    const r = Math.hypot(h.x, h.y) || 1;
    const ax = { x: (-h.x / r) * Math.sin(tilt), y: (-h.y / r) * Math.sin(tilt), z: Math.cos(tilt) };
    return {
      pos: { x: h.x - cg.x, y: h.y - cg.y, z: h.z - cg.z }, axis: ax, dir: dirs[k], motor: { ...mp }, table: tbl, propInertia, propMass: prop.massG / 1000, bladeCount: prop.blades,
      ductGain: ducted ? frame.ductGain ?? 0.12 : 0, lock, flapHz,
      // residual static imbalance scales with prop mass (2e-7 kg·m for a ~4.3 g 5" prop)
      imbalance: ov.propImbalance ?? 2e-7 * (prop.massG / 4.3),
      // impact energy (J) at which a part fails half the time; strength ~ section ~ mass^(2/3), so small
      // quads (energy ~ mass) shrug off crashes that wreck a 5"
      strength: {
        prop: STRENGTH.prop * Math.pow(prop.massG, 2 / 3) * (0.5 + prop.stiffness),
        shaft: STRENGTH.shaft * Math.pow(motor.massG, 2 / 3),
        arm: STRENGTH.arm * (frame.armWidthMm * frame.armThicknessMm ** 2) / 375,
      },
    };
  });

  // ---------- drag ----------
  const cdS = ov.cdAScale ?? 1;
  // ducts: four rings seen edge-on (front pair fully, rear pair partly shadowed)
  const ductSide = ducted ? 4 * (2 * R0 + 0.003) * ductH * 0.6 : 0;
  const frontal = (bd[1] * bd[2]) / 1e6 + (frame.plateWidthMm * frame.stackHeightMm) / 1e6 + 4 * (motor.bellDiaMm * motor.bellHeightMm) / 1e6 * 0.6 + 4 * (frame.armWidthMm * frame.armThicknessMm) / 1e6 + 0.0008 * sz * sz + ductSide + (spec.extraMassG > 40 ? 0.0018 : 0);
  const side = (bd[0] * bd[2]) / 1e6 + (frame.plateLengthMm * frame.stackHeightMm) / 1e6 + 4 * (motor.bellDiaMm * motor.bellHeightMm) / 1e6 * 0.6 + 0.0006 * sz * sz + ductSide;
  // top view: battery, plates, arms, motor bells; ducted frames add the duct rims (wall + lip
  // flange around the guard ring) and the motor-mount spokes across the duct exit, which sit in
  // the through-flow once the craft is tilted far over at speed
  const rimOut = 1.08 * R0 + Math.max(0.0015, 0.2 * ductH);
  const ductTop = ducted ? 4 * (Math.PI * (rimOut * rimOut - R0 * R0) + 3 * R0 * (frame.armWidthMm / 1000) * 0.5) : 0;
  const top = (bd[0] * bd[1]) / 1e6 + (frame.plateLengthMm * frame.plateWidthMm) / 1e6 + 4 * (Math.hypot(mx, my) * 0.8 * frame.armWidthMm) / 1000 + 4 * (Math.PI / 4) * (motor.bellDiaMm / 1000) ** 2 + ductTop;
  const cdA = { x: 1.05 * frontal * cdS, y: 1.1 * side * cdS, z: 1.2 * top * cdS };
  const dragCenter = { x: 0.004 * (wb / 0.225), y: 0, z: (batZ * 0.5 + 0.015 * sz * 0.5) - cg.z };

  // ---------- colliders ----------
  const colliders: ColliderSphere[] = [];
  const add = (x: number, y: number, z: number, r: number, kind: ColliderSphere['kind'], rotor = -1) => colliders.push({ pos: { x: x - cg.x, y: y - cg.y, z: z - cg.z }, radius: r, kind, rotor });
  add(0, 0, frame.stackHeightMm / 2000, Math.min(frame.plateWidthMm, frame.stackHeightMm * 1.4) / 2000, 'frame');
  add(frame.plateLengthMm / 2200, 0, frame.stackHeightMm / 2000, 0.016 * sz, 'camera');
  add(-frame.plateLengthMm / 2400, 0, frame.stackHeightMm / 2000, 0.014 * sz, 'frame');
  // the pack as a box: four spheres of its half-thickness along its long edges, so a pack under the
  // frame is a flat face to stand on (two on the centre line were a knife edge the quad fell off)
  const batR = Math.min(bd[1], bd[2]) / 2000, batY = Math.max(0, bd[1] / 2000 - batR);
  for (const sx of [1, -1]) for (const sy of [1, -1]) add(sx * bd[0] / 3000, sy * batY, batZ, batR, 'battery');
  // Gaps between spheres must stay well under the thinnest obstacle (8 cm posts, 12 cm gate tubes):
  // arm 3 spheres (≤ 1.5 cm gaps), prop disc an outer ring of 9 + inner ring of 4 (≤ 2.5 cm gaps).
  const armR = frame.armThicknessMm / 1000 + 0.002;
  for (let k = 0; k < 4; k++) {
    const h = hubs[k];
    add(h.x, h.y, 0.0, motor.bellDiaMm / 2000, 'motor', k);       // motor bottom / arm tip
    for (const f of [0.3, 0.5, 0.72]) add(h.x * f, h.y * f, -0.002, armR, 'arm', k);
    const nRing = ducted ? 8 : 9;
    for (let j = 0; j < nRing; j++) {
      const a = (j / nRing) * 2 * Math.PI;
      // ducted: the guard ring takes the hit (frame contact, no prop strike); open props can strike
      if (ducted) add(h.x + Math.cos(a) * R * 1.08, h.y + Math.sin(a) * R * 1.08, h.z, Math.max(0.003, ductH / 2), 'frame');
      else add(h.x + Math.cos(a) * R * 0.9, h.y + Math.sin(a) * R * 0.9, h.z, 0.008 * sz, 'prop', k);
    }
    if (!ducted) for (let j = 0; j < 4; j++) { const a = ((j + 0.5) / 4) * 2 * Math.PI; add(h.x + Math.cos(a) * R * 0.52, h.y + Math.sin(a) * R * 0.52, h.z, 0.008 * sz, 'prop', k); }
  }
  // Whoops stand on their duct rims: the moulded guards run down past the battery cradle, so the pack
  // sits between the ducts, 1 mm off the floor. (A pack hanging below on its two centre-line spheres
  // made the quad fall over onto one duct: 13° of roll on the pad, and Angle mode learnt it as level.)
  let ductBottom: number | undefined;
  if (ducted) {
    ductBottom = Math.min(...colliders.map((c) => c.pos.z - c.radius)) + cg.z - 0.001; // lowest body point, frame z
    const rr = Math.max(0.002, ductH / 4);
    for (let k = 0; k < 4; k++) {
      const h = hubs[k];
      for (let j = 0; j < 6; j++) { const a = ((j + 0.5) / 6) * 2 * Math.PI; add(h.x + Math.cos(a) * R * 1.08, h.y + Math.sin(a) * R * 1.08, ductBottom + rr, rr, 'frame'); }
    }
  }

  // ---------- structure / IMU ----------
  const fRP = ov.frameFreqHz ?? 160 * Math.pow(frame.armThicknessMm / 5, 1.5) * Math.pow(0.225 / wb, 1.5);
  const vib = ov.vibrationScale ?? 1;
  // gyro-board flex response to vibration torque; calibrated so the raw (unfiltered) gyro shows
  // blackbox-typical levels: ~1-3 °/s RMS at hover and ~5-15 °/s at full throttle on a clean 5"
  // (∝ I^-0.75: tiny frames respond more, but their vibration torques are also far smaller)
  const gainBase = 11.5 / Math.pow(Math.max(1e-6, (Ixx + Iyy) / 2), 0.75) * vib;
  const chip = GYRO_CHIPS[fc.gyro];

  // ---------- battery ----------
  const bp = batteryFromSpec({
    chemistry: battery.chemistry, cells: ov.cells ?? battery.cells, parallel: battery.parallel,
    capacityMah: ov.capacityMah ?? battery.capacityMah, cRating: battery.cRating,
    irPerCellMohm: ov.irPerCellMohm ?? battery.irPerCellMohm, massG: battery.massG * capScale, ageFactor: spec.batteryAge, wiringMohm: battery.wiringMohm,
    seed: specSeed(spec),
  });

  const params: QuadParams = {
    mass: M, inertia, rotors, cdA, dragCenter,
    angularDrag: { x: 2e-6, y: 2e-6, z: 3e-6 },
    battery: bp, auxPowerW: ov.auxPowerW ?? video.powerW + 1.5,
    colliders, imuChip: chip,
    // per-arm modes (Imu: each arm detuned ±8 %): out-of-plane bending, torsion, in-plane bending.
    // Carbon laminate alone rings at ζ ~ 0.01-0.02, but bolted joints, the battery strap and the
    // stack's rubber grommets bring a frame mode as seen by the gyro to ζ ≈ 0.1; the in-plane arm is
    // ~3x stiffer (15 x 5 mm section: (w/t)² = 9 in stiffness) and barely shakes the board: yaw is
    // the quietest axis.
    flex: {
      roll: { freqHz: fRP, zeta: 0.1, gain: gainBase },
      pitch: { freqHz: fRP * 1.08, zeta: 0.11, gain: gainBase },
      yaw: { freqHz: fRP * 2.7, zeta: 0.1, gain: gainBase * 0.12 },
    },
    mountIsolation: fc.softMount,
    seed: specSeed(spec),
  };
  if (ov.propImbalance != null) { /* applied to rotor damage state at sim creation */ }

  const info = deriveInfo(spec, params, { frame, motor, prop, battery, esc, fc, video }, items, cg, fRP);
  if (ductBottom !== undefined) info.ductBottomMm = ductBottom * 1000;
  return { spec, params, info, tables: tbl };
}

/**
 * Per-build seed (FNV-1a over the name and parts list): the "unit-to-unit" scatter of a real build
 * (IMU offsets / board alignment, cell spread, arm detuning) stays put while sliders are tuned.
 */
export function specSeed(spec: DroneSpec): number {
  const key = [spec.name, spec.frame, spec.motor, spec.prop, spec.battery, spec.esc, spec.fc, spec.video].join('|');
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

/** Steady-state phase current an enabled ESC current limiter (bus-current PI) settles at for duty D. */
const phaseLimit = (mp: MotorParams, D: number) => (mp.escCurrentLimitA > 0 ? (mp.escCurrentLimitA * mp.escEfficiency) / Math.max(0.05, D) : Infinity);

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
  const iLim = phaseLimit(mp, D);
  if (i > iLim) {
    i = iLim;
    // the ESC's current limiter settles at its bus-current limit: ke i = kQ w² + loss
    w = Math.sqrt(Math.max(0, (ke * i - ke * mp.i0A * 0.6) / kQ));
  }
  return { omega: w, current: i * D / mp.escEfficiency, thrust: kT * w * w };
  }
}

/**
 * Level-flight top speed at full throttle (m/s), quasi-steady with the same rotor model the sim
 * flies: at each airspeed the pitch angle that holds altitude is found, and at that attitude each
 * motor settles where its torque meets the prop's in-flight torque (props unload with advance
 * ratio), with the ducts' ram drag / ring lift and the body-axis drag. Top speed is where the
 * forward force runs out (bisection; assumes the excess falls monotonically with speed).
 */
function levelTopSpeed(p: QuadParams, busV: (iBus: number) => number, Vstatic: number): number {
  // the props unload at speed, so the pack sags less than at static WOT: refine the bus voltage
  let Vbus = Vstatic, v = 0;
  for (let pass = 0; pass < 3; pass++) {
    const r = levelTopSpeedAt(p, Vbus);
    v = r.v; Vbus = 0.5 * Vbus + 0.5 * busV(r.iBus);
  }
  return v;
}

function levelTopSpeedAt(p: QuadParams, Vbus: number): { v: number; iBus: number } {
  const rc = p.rotors[0], mp = rc.motor, rho = 1.225, W = p.mass * 9.80665, n = p.rotors.length;
  let iBus = 0;
  const ro = new RotorAero(rc.table, 1); ro.ductGain = rc.ductGain ?? 0;
  const o: RotorAeroOut = emptyRotorOut();
  const ke = 60 / (2 * Math.PI * mp.kv) / mp.kvLoadFactor, Rw = mp.rmOhm + mp.escOhm, wRef = (mp.kv * 10 * 2 * Math.PI) / 60;
  const iLim = phaseLimit(mp, 1);
  const motorTq = (w: number) => ke * Math.min(iLim, (Vbus - ke * w) / Rw) - ke * mp.i0A * (0.35 + 0.65 * w / wRef);
  // net world force (horizontal, vertical) at airspeed v and pitch th
  const force = (v: number, th: number): [number, number] => {
    const ux = v * Math.cos(th), uz = v * Math.sin(th); // body-frame airflow components (x fwd, z thrust axis)
    let lo = 0, hi = Vbus / ke;
    for (let i = 0; i < 30; i++) { const w = (lo + hi) / 2; ro.evaluate(w, uz, ux, rho, Infinity, 0, 1e-4, o); if (motorTq(w) > o.torque) lo = w; else hi = w; }
    ro.evaluate(lo, uz, ux, rho, Infinity, 0, 1e-4, o);
    iBus = (n * Math.min(iLim, Math.max(0, (Vbus - ke * lo) / Rw))) / mp.escEfficiency;
    const fz = n * o.thrust - 0.5 * rho * v * p.cdA.z * uz, fx = -n * o.hForce - 0.5 * rho * v * p.cdA.x * ux;
    // body x = (cos th, -sin th), body z = (sin th, cos th) in world (forward, up)
    return [fx * Math.cos(th) + fz * Math.sin(th), -fx * Math.sin(th) + fz * Math.cos(th) - W];
  };
  const excess = (v: number) => {
    let lo = 0, hi = 1.55;
    if (force(v, lo)[1] < 0) return -1; // cannot even hold altitude level at this speed
    for (let i = 0; i < 26; i++) { const th = (lo + hi) / 2; if (force(v, th)[1] > 0) lo = th; else hi = th; }
    return force(v, lo)[0];
  };
  let a = 0.5, b = 120;
  if (excess(a) <= 0) return { v: 0, iBus: 0 };
  for (let i = 0; i < 22; i++) { const m = (a + b) / 2; if (excess(m) > 0) a = m; else b = m; }
  excess(a);
  return { v: a, iBus };
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
  const vTop = levelTopSpeed(p, (I) => Math.max(cells * 2.5, cells * 4.1 - I * sagR), V);
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
