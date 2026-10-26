// Full multirotor plant: 6-DoF rigid body with rotor gyroscopics, BLDC/ESC motors, BEMT rotors,
// battery bus, airframe drag, wind + wake, vibration excitation, IMU, and compliant contacts.
// World frame ENU (z up); body frame FLU. Units SI.
import { Battery, BatteryParams } from './battery';
import { BemtTable } from './bemt';
import { ColliderSphere, CollisionWorld, ContactHit, MATERIALS, restitutionAt, SurfaceMaterial } from './contact';
import { FlexMode, GyroChip, Imu } from './imu';
import { V3, Quat, v3, quat, rotate, rotateInv, cross, qintegrate, Rng, subSeed } from './math';
import { Motor, MotorParams } from './motor';
import { CommonNoise, RotorAero, RotorAeroOut, emptyRotorOut, pristineDamage } from './rotor';
import { WakeField } from './wake';
import { Wind } from './wind';
import { G0, isa } from './atmosphere';

export interface RotorConfig {
  pos: V3;        // hub position relative to CG, body frame (m)
  axis: V3;       // unit thrust axis, body frame (usually 0,0,1; motor tilt allowed)
  dir: 1 | -1;    // spin sense about +axis: +1 = CCW seen from above
  motor: MotorParams;
  table: BemtTable;
  propInertia: number; // kg m^2
  propMass: number;
  bladeCount: number;
  /** Ducted prop: static thrust augmentation fraction (0 = open prop). */
  ductGain?: number;
  /** Residual static imbalance of a pristine prop (kg·m). */
  imbalance?: number;
  /** Crash strength: impact energy (J) at which the prop / motor shaft+bell / arm fails half the time. */
  strength?: { prop: number; shaft: number; arm: number };
  /** Blade Lock number and non-rotating first flap-bending frequency (Hz): set the flapping lag. */
  lock?: number;
  flapHz?: number;
}

/** Crash strength scale (J): prop per g^(2/3) (x (0.5 + blade stiffness)), motor per g^(2/3), 5" arm (15 x 5 mm). */
export const STRENGTH = { prop: 9, shaft: 1.5, arm: 30 };

/** Broadband vibration torque per rotor into the arm modes, and straight to the board, × imbalance force × hub height. */
const VIB_BROADBAND = 0.3, VIB_FLOOR = 6;

/** Crash damage to a motor position beyond the prop (which lives in RotorAero.damage). */
export interface MotorDamage {
  shaftBend: number; // 0 = straight; ~1 = badly bent shaft / dented bell (adds 1x-rpm imbalance)
  armBendDeg: number; // arm bent: thrust axis tilted by this much
}

export interface QuadParams {
  mass: number;
  inertia: { xx: number; yy: number; zz: number; xy: number; xz: number; yz: number };
  rotors: RotorConfig[];
  cdA: V3;              // body-axis drag areas Cd*A (m^2)
  dragCenter: V3;       // centre of pressure relative to CG (body)
  angularDrag: V3;      // N m s^2/rad^2 quadratic rotational damping
  battery: BatteryParams;
  auxPowerW: number;    // FC + VTX + camera + receiver
  colliders: ColliderSphere[];
  imuChip: GyroChip;
  flex: { roll: FlexMode; pitch: FlexMode; yaw: FlexMode };
  mountIsolation: number;
  /** Per-build seed: sensor calibration errors, cell spread, arm detuning, ESC randomness. */
  seed?: number;
}

export interface QuadEnv {
  world: CollisionWorld;
  wind: Wind;
  wake: WakeField;
  ambientC: number;
  altitudeOffset: number; // map elevation above sea level
  damageEnabled: boolean;
}

export interface QuadState {
  pos: V3; vel: V3; q: Quat; w: V3;
  time: number;
  specForce: V3;     // body specific force (true)
  accWorld: V3;
  vbus: number; ibus: number;
  maxImpact: number; // last significant impact speed (for crash detection / UI)
  crashed: boolean;
  touching: boolean;
}

export class QuadSim {
  p: QuadParams;
  s: QuadState;
  motors: Motor[];
  aero: RotorAero[];
  battery: Battery;
  imu: Imu;
  rotorOut: RotorAeroOut[];
  phase: number[];
  rotorExtraTorque: number[]; // braking torque from prop strikes (applied next step)
  private Iinv: number[] = [];
  private iMin = 1e-3;
  private rng: Rng;
  private air = { rho: 1.225, pressure: 101325, tempK: 288, mu: 1.8e-5 };
  private groundCache: number[] = [];
  private ceilCache: number[] = [];
  private groundTimer = 0;
  private wakeTimer = 0;
  private wakeVel: V3[] = [];
  private wakeTurb: number[] = [];
  private hubW: V3[] = []; // hub positions (world) for the 1 kHz wake sampling
  private hubLift: number[] = []; // per rotor: height of the prop's imbalance above the hub (≈ R/4)
  private misImb: number[] = []; private misV: number[] = []; // per rotor: blade mismatch for the imbalance it was computed at
  private th = { vth: 0, rth: 0 }; private bus = { a: 0, b: 0, driven: false }; // bus solve scratch
  private hit: ContactHit = { depth: 0, nx: 0, ny: 0, nz: 1, material: MATERIALS.grass };
  // temporaries (no allocation in the hot loop)
  private t1 = v3(); private t2 = v3(); private t3 = v3(); private t4 = v3(); private t5 = v3();
  private F = v3(); private Tq = v3(); private Fb = v3();
  private vibF = v3(); private vibT = v3(); private hTot = v3();
  private airTmp = v3(); private fTmp = v3(); private hubTmp = v3(); private posTmp = v3(); private dirTmp = v3();
  readonly physicsHz: number;
  /** Impact events that loaded a rotor position: energy (J) seen by its prop, motor shaft and arm. */
  impactLog: { rotor: number; prop: number; shaft: number; arm: number; time: number }[] = [];
  /** Every damage roll that did something: part, rotor, impact energy (J). */
  damageLog: { part: 'chip' | 'break' | 'shaft' | 'arm'; rotor: number; energy: number; time: number }[] = [];
  motorDamage: MotorDamage[];
  /** Wind at each rotor hub (world): CG wind + rotor-scale gust gradients. Read by the rotor aero. */
  rotorWind: V3[];
  /** Vibration torque each rotor puts into its arm this step (body, N·m): drives the IMU's arm modes. */
  rotorVib: V3[];
  /** External force on the CG (world, N): a fibre's payout tension, a tether, a host's own effects. */
  extForce: V3 = v3();
  private windTimer = 0;
  private windAgl = 0;
  private axis0: V3[];
  // contacts: per collider state (0 free, 1 touching, 2 centre inside the obstacle: normal frozen)
  private cState: Uint8Array; private cN: Float64Array; private cD: Float64Array; private cVin: Float64Array;
  private hD: Float64Array; private hN: Float64Array; private hMat: SurfaceMaterial[];
  private boundR = 0;
  private cC: Float64Array; private cK: Float64Array; private cJall: Float64Array;
  private cW = new Float64Array(36); private cJ = new Float64Array(6);
  private cEig = new Float64Array([1, 0, 0, 0, 0, 0]); private cEigK = new Float64Array([0, 0, 1, 0, 0, 0]);
  // per-rotor impact event: compression work at prop / motor / arm spheres, rotor energy lost to strikes
  private evAge: Float64Array; private evProp: Float64Array; private evStrike: Float64Array;
  private evMotor: Float64Array; private evArm: Float64Array; private evMat: SurfaceMaterial[]; private evTouch: Uint8Array;
  private foliageDrag = 0;

  /**
   * noiseSeed: seeds the plant's own random streams (rotor-wash and contact noise); without it they
   * start from fixed seeds, as they always have. The build's unit-to-unit scatter is p.seed.
   */
  constructor(p: QuadParams, physicsHz = 8000, soc = 1, ambientC = 20, noiseSeed?: number) {
    const ns = (k: number) => (noiseSeed === undefined ? k : subSeed(noiseSeed, k));
    this.rng = new Rng(ns(7));
    // own copy of the rotor axes: a bent arm tilts them (repair() restores)
    p = { ...p, rotors: p.rotors.map((r) => ({ ...r, axis: { ...r.axis } })) };
    this.p = p;
    this.axis0 = p.rotors.map((r) => ({ ...r.axis }));
    this.motorDamage = p.rotors.map(() => ({ shaftBend: 0, armBendDeg: 0 }));
    this.rotorWind = p.rotors.map(() => v3());
    const nc = p.colliders.length, nr = p.rotors.length;
    this.cState = new Uint8Array(nc); this.cN = new Float64Array(nc * 3); this.cD = new Float64Array(nc); this.cVin = new Float64Array(nc); this.cC = new Float64Array(nc);
    this.cK = new Float64Array(nc); this.cJall = new Float64Array(nc * 6);
    this.hD = new Float64Array(nc); this.hN = new Float64Array(nc * 3); this.hMat = p.colliders.map(() => MATERIALS.grass);
    for (const c of p.colliders) this.boundR = Math.max(this.boundR, Math.hypot(c.pos.x, c.pos.y, c.pos.z) + c.radius);
    this.evAge = new Float64Array(nr); this.evProp = new Float64Array(nr); this.evStrike = new Float64Array(nr);
    this.evMotor = new Float64Array(nr); this.evArm = new Float64Array(nr); this.evMat = p.rotors.map(() => MATERIALS.grass); this.evTouch = new Uint8Array(nr);
    // canopy drag: N per (m depth · (m/s)²), ∝ the airframe's mean drag area
    this.foliageDrag = 70 * (p.cdA.x + p.cdA.y + p.cdA.z) / 3;
    this.physicsHz = physicsHz;
    this.motors = p.rotors.map((r, i) => new Motor(r.motor, ambientC, ((p.seed ?? 0) + 0x9e37 * (i + 1)) >>> 0));
    const washCommon = new CommonNoise(ns(99));
    this.aero = p.rotors.map((r, i) => {
      const a = new RotorAero(r.table, ns(100 + i));
      a.common = washCommon;
      a.ductGain = r.ductGain ?? 0;
      a.damage.imbalance = r.imbalance ?? a.damage.imbalance;
      if (r.lock) a.lock = r.lock;
      if (r.flapHz) a.flapHz = r.flapHz;
      return a;
    });
    this.rotorOut = p.rotors.map(() => emptyRotorOut());
    this.phase = p.rotors.map((_, i) => i * 1.3);
    this.rotorExtraTorque = p.rotors.map(() => 0);
    this.groundCache = p.rotors.map(() => Infinity);
    this.ceilCache = p.rotors.map(() => Infinity);
    this.wakeVel = p.rotors.map(() => v3());
    this.wakeTurb = p.rotors.map(() => 0);
    this.hubW = p.rotors.map(() => v3());
    this.hubLift = p.rotors.map((rc) => 0.25 * Math.sqrt((3 * rc.propInertia) / Math.max(1e-4, rc.propMass)));
    this.misImb = p.rotors.map(() => NaN); this.misV = p.rotors.map(() => 0);
    this.battery = new Battery(p.battery, soc, ambientC);
    this.imu = new Imu(p.imuChip, physicsHz, p.flex, p.seed ?? 42, p.rotors.map((r) => r.pos));
    this.rotorVib = p.rotors.map(() => v3());
    this.imu.mountIsolation = p.mountIsolation;
    this.s = {
      pos: v3(), vel: v3(), q: quat(), w: v3(), time: 0, specForce: v3(0, 0, G0), accWorld: v3(),
      vbus: this.battery.s.voltage, ibus: 0, maxImpact: 0, crashed: false, touching: false,
    };
    this.computeInertiaInverse();
  }

  /**
   * Change the mass properties in flight (a payload released, a fibre spool emptying): mass (kg)
   * and inertia about the CG. The CG itself stays put (the change is assumed near it).
   */
  setMassProperties(mass: number, inertia: QuadParams['inertia']): void {
    this.p.mass = mass;
    this.p.inertia = { ...inertia };
    this.computeInertiaInverse();
  }

  computeInertiaInverse(): void {
    const I = this.p.inertia;
    const a = I.xx, b = -I.xy, c = -I.xz, d = I.yy, e = -I.yz, f = I.zz;
    // symmetric [[a,b,c],[b,d,e],[c,e,f]]
    const A = d * f - e * e, B = -(b * f - c * e), C = b * e - c * d;
    const det = a * A + b * B + c * C;
    const D = a * f - c * c, E = -(a * e - b * c), Fm = a * d - b * b;
    this.iMin = Math.min(I.xx, I.yy, I.zz);
    this.Iinv = [A / det, B / det, C / det, B / det, D / det, E / det, C / det, E / det, Fm / det];
  }

  reset(pos: V3, yaw = 0): void {
    const s = this.s;
    s.pos = { ...pos }; s.vel = v3(); s.w = v3();
    s.q = { w: Math.cos(yaw / 2), x: 0, y: 0, z: Math.sin(yaw / 2) };
    s.crashed = false; s.maxImpact = 0; s.touching = false;
    s.accWorld = v3(); s.specForce = v3(0, 0, G0);
    for (const m of this.motors) m.resetDynamics();
    this.rotorExtraTorque.fill(0);
    this.cState.fill(0); this.hD.fill(0); this.windTimer = 0;
    this.evAge.fill(0); this.evProp.fill(0); this.evStrike.fill(0); this.evMotor.fill(0); this.evArm.fill(0); this.evTouch.fill(0);
    for (const v of this.wakeVel) { v.x = v.y = v.z = 0; }
    this.wakeTurb.fill(0);
    for (const o of this.rotorOut) { o.thrust = o.torque = o.hForce = o.vi = o.vrs = o.mAdv = o.mFront = o.flapLag = o.flapTan = 0; }
    // IMU filter / flex states restart (a crash can saturate them); keep the chip's bias
    this.imu.resetState();
    if (!Number.isFinite(this.battery.s.voltage) || !Number.isFinite(this.battery.s.soc)) {
      this.battery = new Battery(this.p.battery, 1, this.battery.s.tempC || 20);
    }
    s.vbus = this.battery.s.voltage; s.ibus = 0;
  }

  /** True if the state has gone non-finite (should never happen; guarded anyway). */
  private corrupt(): boolean {
    const s = this.s;
    if (!Number.isFinite(s.pos.x + s.pos.y + s.pos.z + s.vel.x + s.vel.y + s.vel.z + s.w.x + s.w.y + s.w.z + s.q.w)) return true;
    for (let k = 0; k < this.motors.length; k++) if (!Number.isFinite(this.motors[k].s.omega)) return true;
    return false;
  }

  /** Set the motors' commanded DShot values (called whenever the FC outputs). */
  command(dshot: ArrayLike<number>, reversed: boolean): void {
    for (let k = 0; k < this.motors.length; k++) this.motors[k].command(dshot[k] ?? 0, reversed);
  }

  step(dt: number, env: QuadEnv): void {
    const p = this.p, s = this.s;
    const n = p.rotors.length;
    isa(Math.max(0, s.pos.z + env.altitudeOffset), env.ambientC + 273.15 - 288.15, this.air);
    const rho = this.air.rho;

    // ---------- electrical bus: Thevenin battery feeding all ESCs ----------
    // Each driven ESC draws I_k = a_k*V - b_k at its applied duty (an enabled current limiter acts
    // through that duty, with a lag, as the real PI does): V = vth - rth*sum(I) is linear in V.
    const th = this.battery.thevenin(this.th);
    const iAux = p.auxPowerW / Math.max(6, s.vbus);
    let A = 0, B = 0;
    for (const m of this.motors) {
      const c = m.busCoeffs(this.bus);
      if (!c.driven) continue;
      A += c.a; B += c.b;
    }
    let V = (th.vth + th.rth * (B - iAux)) / (1 + th.rth * A);
    if (V < 0) V = 0;
    s.vbus = V;

    // ---------- kinematics ----------
    const vb = rotateInv(this.t1, s.q, s.vel); // body velocity
    const F = this.F, Tq = this.Tq;
    F.x = 0; F.y = 0; F.z = 0; Tq.x = 0; Tq.y = 0; Tq.z = 0;
    const vibF = this.vibF, vibT = this.vibT;
    vibF.x = vibF.y = vibF.z = 0; vibT.x = vibT.y = vibT.z = 0;

    // ---------- wind (world) at the CG and at each rotor hub (this.rotorWind) ----------
    // Dryden runs on airspeed and the height above whatever is below (ground or a roof: 100 Hz ray);
    // rotor-scale gust gradients make turbulence rock the attitude, not just push the CG.
    this.windTimer -= dt;
    if (this.windTimer <= 0) {
      this.windTimer = 0.01;
      const gz = Math.max(0, s.pos.z - env.world.groundHeight(s.pos.x, s.pos.y));
      const dn = this.dirTmp; dn.x = 0; dn.y = 0; dn.z = -1;
      this.windAgl = Math.min(gz, env.world.raycast(s.pos, dn, Math.min(60, gz + 0.5)));
    }
    {
      const mw = env.wind.meanAt(this.windAgl, this.t2);
      const ax = mw.x - s.vel.x, ay = mw.y - s.vel.y, az = -s.vel.z, as = Math.sqrt(ax * ax + ay * ay + az * az);
      const ad = this.t3; if (as > 0.1) { ad.x = ax / as; ad.y = ay / as; ad.z = az / as; }
      env.wind.step(dt, this.windAgl, as, as > 0.1 ? ad : undefined);
    }
    const windW = env.wind.at(s.pos, this.t2, this.windAgl);
    const wcx = windW.x, wcy = windW.y, wcz = windW.z;
    for (let k = 0; k < n; k++) {
      const rw = this.rotorWind[k]; rw.x = wcx; rw.y = wcy; rw.z = wcz;
      env.wind.gradient(rotate(this.t3, s.q, p.rotors[k].pos), rw);
    }

    // ground distance per rotor at 100 Hz, wake sampling at 1 kHz
    this.groundTimer -= dt;
    const doGround = this.groundTimer <= 0;
    if (doGround) this.groundTimer = 0.01;
    this.wakeTimer -= dt;
    const doWake = this.wakeTimer <= 0;
    if (doWake) this.wakeTimer = 0.001;

    if (doWake) {
      // the wake at every hub, in one pass over the puffs
      for (let k = 0; k < n; k++) { const hw = rotate(this.hubW[k], s.q, p.rotors[k].pos); hw.x += s.pos.x; hw.y += s.pos.y; hw.z += s.pos.z; }
      env.wake.sampleAll(this.hubW, this.wakeVel, this.wakeTurb);
    }

    let busI = 0, floor2 = 0;
    const h = this.hTot; h.x = h.y = h.z = 0; // total rotor angular momentum (body); own storage: t5 is scratch for contacts()
    for (let k = 0; k < n; k++) {
      const rc = p.rotors[k], m = this.motors[k], ro = this.aero[k];
      // rotor hub velocity in body: v + w x r
      const wr = cross(this.t3, s.w, rc.pos);
      const vx = vb.x + wr.x, vy = vb.y + wr.y, vz = vb.z + wr.z;
      // hub world position
      const hubW = rotate(this.t4, s.q, rc.pos);
      hubW.x += s.pos.x; hubW.y += s.pos.y; hubW.z += s.pos.z;
      // air velocity at rotor (wind + wake), world -> body
      const aw = this.airTmp;
      const rw = this.rotorWind[k]; // per-rotor wind (see the wind block above)
      aw.x = rw.x + this.wakeVel[k].x; aw.y = rw.y + this.wakeVel[k].y; aw.z = rw.z + this.wakeVel[k].z;
      const airB = rotateInv(this.t3, s.q, aw);
      const rx = vx - airB.x, ry = vy - airB.y, rz = vz - airB.z;
      const vc = rx * rc.axis.x + ry * rc.axis.y + rz * rc.axis.z;
      const ipx = rx - vc * rc.axis.x, ipy = ry - vc * rc.axis.y, ipz = rz - vc * rc.axis.z;
      const vip = Math.sqrt(ipx * ipx + ipy * ipy + ipz * ipz);
      if (doGround) {
        const axW = rotate(this.dirTmp, s.q, rc.axis);
        axW.x = -axW.x; axW.y = -axW.y; axW.z = -axW.z;
        this.groundCache[k] = env.world.raycast(hubW, axW, 4 * rc.table.R + 0.05);
        axW.x = -axW.x; axW.y = -axW.y; axW.z = -axW.z;
        this.ceilCache[k] = env.world.raycast(hubW, axW, 3 * rc.table.R + 0.02);
      }
      const omega = m.s.omega;
      const o = this.rotorOut[k];
      // the blades meet the air at motor speed plus the frame's own rotation about the prop axis
      // (inertial spin = dir*omega + w.axis): a yawing frame slows one diagonal's blades through
      // the air and speeds up the other's. Motor EMF / electrical torque stay on the stator-relative
      // omega, so the ESCs partly make up for it by spinning the unloaded pair up.
      const omegaAir = omega + rc.dir * (s.w.x * rc.axis.x + s.w.y * rc.axis.y + s.w.z * rc.axis.z);
      ro.evaluate(omegaAir, vc, vip, rho, this.groundCache[k], this.wakeTurb[k], dt, o, this.ceilCache[k]);
      // aerodynamic forces on the body
      let fx = rc.axis.x * o.thrust, fy = rc.axis.y * o.thrust, fz = rc.axis.z * o.thrust;
      if (vip > 1e-4) {
        const k2 = o.hForce / vip; fx -= ipx * k2; fy -= ipy * k2; fz -= ipz * k2;
        // blade hub moments in edgewise flow, wind axes x' (rotor's in-plane motion through the air),
        // y' = axis × x': rigid blades roll the advancing side up (M = −dir·mAdv·x', cancels between
        // the CW and CCW pairs) and lift the leading edge (−mFront·y', blowback: the nose pitches
        // up with speed); flapping turns the pattern by the lag in the spin direction (the advancing-
        // side part becomes blowback too) and keeps cos(lag) of it at the hub.
        const ix = ipx / vip, iy = ipy / vip, iz = ipz / vip, a = rc.axis;
        const yx = a.y * iz - a.z * iy, yy = a.z * ix - a.x * iz, yz = a.x * iy - a.y * ix;
        // turned by the lag ψ and scaled by cos ψ: cos ψ·(cos ψ, dir·sin ψ) = (1, dir·tan ψ) / (1 + tan² ψ)
        const m0 = -rc.dir * o.mAdv, m1 = -o.mFront, ft = o.flapTan, c = 1 / (1 + ft * ft), sn = rc.dir * ft * c;
        const mx = m0 * c - m1 * sn, my = m0 * sn + m1 * c;
        Tq.x += mx * ix + my * yx; Tq.y += mx * iy + my * yy; Tq.z += mx * iz + my * yz;
      }
      // vibration (what Betaflight's RPM filter / dynamic notch exist to remove):
      //  - static imbalance: a force rotating in the rotor plane at 1x rpm, acting at the prop's
      //    height above the CG (hub + bell, ~R/4), so it rocks roll and pitch, not just yaw
      //  - blade mismatch: blades never produce identical lift, so thrust wobbles at 1x rpm
      //    (~1.5-2 % pristine, growing with damage), plus blade-pass ripple and a 2x bell term
      this.phase[k] += omega * rc.dir * dt;
      const ph = this.phase[k];
      const fImb = ro.damage.imbalance * omega * omega;
      if (ro.damage.imbalance !== this.misImb[k]) {
        const imbRatio = ro.damage.imbalance / Math.max(1e-9, rc.imbalance ?? ro.damage.imbalance);
        this.misImb[k] = ro.damage.imbalance; this.misV[k] = 0.017 * Math.sqrt(Math.max(1, imbRatio));
      }
      const mismatch = this.misV[k];
      const ripple = o.thrust * (mismatch * Math.sin(ph + 1.3 * k) + 0.012 * Math.sin(rc.bladeCount * ph) + 0.006 * Math.sin(2 * ph + 0.7 * k));
      const vfx = fImb * Math.cos(ph), vfy = fImb * Math.sin(ph), vfz = ripple;
      fx += vfx; fy += vfy; fz += vfz;
      vibF.x += vfx; vibF.y += vfy; vibF.z += vfz;
      const ft = this.fTmp; ft.x = vfx; ft.y = vfy; ft.z = vfz;
      const hubLift = this.hubLift[k];
      const hp = this.hubTmp; hp.x = rc.pos.x; hp.y = rc.pos.y; hp.z = rc.pos.z + hubLift;
      const vt = cross(this.t3, hp, ft);
      // + broadband bearing / commutation / blade-turbulence noise (∝ rpm²): part excites the
      // arm's own resonance (the hump a real gyro spectrum shows between the motor harmonics), part
      // reaches the board directly as a floor rising with throttle (Imu.sample)
      const bn = VIB_BROADBAND * fImb * hubLift;
      const rv = this.rotorVib[k];
      rv.x = vt.x + bn * this.rng.gauss(); rv.y = vt.y + bn * this.rng.gauss(); rv.z = vt.z + 0.3 * bn * this.rng.gauss();
      vibT.x += rv.x; vibT.y += rv.y; vibT.z += rv.z;
      const fl = VIB_FLOOR * fImb * hubLift; floor2 += fl * fl;
      F.x += fx; F.y += fy; F.z += fz;
      ft.x = fx; ft.y = fy; ft.z = fz;
      const rt = cross(this.t3, rc.pos, ft);
      Tq.x += rt.x; Tq.y += rt.y; Tq.z += rt.z;
      // motor dynamics
      const sgn = omega >= 0 ? 1 : -1;
      const propTorque = o.torque * (omegaAir >= 0 ? 1 : -1) + this.rotorExtraTorque[k] * sgn;
      this.rotorExtraTorque[k] = 0;
      m.step(V, propTorque, rc.propInertia, dt, env.ambientC, Math.sqrt(vc * vc + vip * vip));
      busI += m.s.busCurrent;
      // reaction torque on the stator (frame): -(J*omegaDot + tau_prop) about the spin vector
      const J = rc.motor.rotorInertia + rc.propInertia;
      const shaft = J * m.s.omegaDot + propTorque;
      Tq.x -= rc.axis.x * rc.dir * shaft; Tq.y -= rc.axis.y * rc.dir * shaft; Tq.z -= rc.axis.z * rc.dir * shaft;
      // angular momentum for gyroscopic coupling
      const hk = J * m.s.omega * rc.dir;
      h.x += rc.axis.x * hk; h.y += rc.axis.y * hk; h.z += rc.axis.z * hk;
      // wake shedding: far-wake velocity ~ 2*vi along -thrust axis (world)
      if (o.thrust > 0.05) {
        const axW = rotate(this.dirTmp, s.q, rc.axis);
        const wv = 2 * o.vi;
        axW.x *= -wv; axW.y *= -wv; axW.z *= -wv;
        env.wake.emit(k, hubW, axW, rc.table.R * 0.9, dt);
      }
    }
    s.ibus = busI + iAux;

    // ---------- airframe drag ----------
    const wc = this.airTmp; wc.x = wcx; wc.y = wcy; wc.z = wcz;
    const wb = rotateInv(this.t3, s.q, wc);
    const ux = vb.x - wb.x, uy = vb.y - wb.y, uz = vb.z - wb.z;
    const U = Math.sqrt(ux * ux + uy * uy + uz * uz);
    const qd = 0.5 * rho * U;
    const df = this.fTmp;
    df.x = -qd * p.cdA.x * ux; df.y = -qd * p.cdA.y * uy; df.z = -qd * p.cdA.z * uz;
    F.x += df.x; F.y += df.y; F.z += df.z;
    const dtq = cross(this.t4, p.dragCenter, df);
    Tq.x += dtq.x; Tq.y += dtq.y; Tq.z += dtq.z;
    Tq.x -= p.angularDrag.x * s.w.x * Math.abs(s.w.x);
    Tq.y -= p.angularDrag.y * s.w.y * Math.abs(s.w.y);
    Tq.z -= p.angularDrag.z * s.w.z * Math.abs(s.w.z);

    // ---------- contacts (forces in world, torques in body) ----------
    const Fw = rotate(this.Fb, s.q, F);
    const xf = this.extForce;
    if (xf.x !== 0 || xf.y !== 0 || xf.z !== 0) { Fw.x += xf.x; Fw.y += xf.y; Fw.z += xf.z; }
    this.contacts(env, dt, Fw, Tq);

    // ---------- integrate (semi-implicit Euler) ----------
    const m = p.mass;
    s.accWorld.x = Fw.x / m; s.accWorld.y = Fw.y / m; s.accWorld.z = Fw.z / m - G0;
    // specific force = non-gravitational acceleration, body frame
    const sfw = this.fTmp; sfw.x = Fw.x / m; sfw.y = Fw.y / m; sfw.z = Fw.z / m;
    rotateInv(s.specForce, s.q, sfw);
    s.vel.x += s.accWorld.x * dt; s.vel.y += s.accWorld.y * dt; s.vel.z += s.accWorld.z * dt;
    s.pos.x += s.vel.x * dt; s.pos.y += s.vel.y * dt; s.pos.z += s.vel.z * dt;
    // Euler: I*wdot = tau - w x (I*w + h)
    const I = p.inertia, w = s.w;
    const Iwx = I.xx * w.x - I.xy * w.y - I.xz * w.z + h.x;
    const Iwy = -I.xy * w.x + I.yy * w.y - I.yz * w.z + h.y;
    const Iwz = -I.xz * w.x - I.yz * w.y + I.zz * w.z + h.z;
    const gx = Tq.x - (w.y * Iwz - w.z * Iwy);
    const gy = Tq.y - (w.z * Iwx - w.x * Iwz);
    const gz = Tq.z - (w.x * Iwy - w.y * Iwx);
    const Ii = this.Iinv;
    w.x += (Ii[0] * gx + Ii[1] * gy + Ii[2] * gz) * dt;
    w.y += (Ii[3] * gx + Ii[4] * gy + Ii[5] * gz) * dt;
    w.z += (Ii[6] * gx + Ii[7] * gy + Ii[8] * gz) * dt;
    qintegrate(s.q, w, dt);

    // ---------- sensors & battery ----------
    this.imu.sample(w, s.specForce, vibT, vibF, m, dt, this.rotorVib, Math.sqrt(floor2));
    this.battery.step(s.ibus, dt, env.ambientC, U);
    s.time += dt;
    if (this.corrupt()) {
      // numerical failure: put the quad back where it last was finite-ish, at rest, and flag a crash
      const p0 = Number.isFinite(s.pos.x + s.pos.y + s.pos.z) ? { ...s.pos } : { x: 0, y: 0, z: 1 };
      this.reset(p0);
      s.crashed = true;
    }
  }

  private contacts(env: QuadEnv, dt: number, Fw: V3, Tq: V3): void {
    const p = this.p, s = this.s, cs = p.colliders, nc = cs.length, nr = p.rotors.length;
    let touching = false;
    let maxApproach = 0;
    const hit = this.hit;
    const pw = this.posTmp;
    const cN = this.cN, hN = this.hN;
    // pass 1: penetration queries (broadphase: one sphere around the whole airframe). A sphere whose
    // centre ends up inside an obstacle keeps the normal / plane it entered by: the least-penetration
    // axis of a thin bar or post flips at its mid-plane and used to spit the quad out the far side.
    const world = env.world, any = world.sphere(s.pos, this.boundR, hit);
    const near = any && world.near !== undefined && world.sphereNear !== undefined;
    if (near) world.near!(s.pos, this.boundR); // the colliders below test only what is within reach
    let nTouch = 0;
    for (let i = 0; i < nc; i++) {
      this.hD[i] = 0;
      if (!any) { this.cState[i] = 0; continue; }
      const c = cs[i];
      const cw = rotate(this.t2, s.q, c.pos);
      pw.x = s.pos.x + cw.x; pw.y = s.pos.y + cw.y; pw.z = s.pos.z + cw.z;
      if (!(near ? world.sphereNear!(pw, c.radius, hit) : world.sphere(pw, c.radius, hit))) { this.cState[i] = 0; continue; }
      const r = c.radius, i3 = i * 3, st = this.cState[i];
      const inside = hit.depth >= r;
      let depth = hit.depth, frozen = false;
      if (st !== 0 && (inside || st === 2)) {
        const ox = cN[i3], oy = cN[i3 + 1], oz = cN[i3 + 2];
        const dPl = r - (ox * pw.x + oy * pw.y + oz * pw.z - this.cD[i]);
        // stay frozen while still behind the entry plane, unless back outside with a consistent normal
        if (dPl > 0 && !(!inside && hit.nx * ox + hit.ny * oy + hit.nz * oz > 0.5)) { depth = dPl; frozen = true; }
      }
      if (frozen) this.cState[i] = 2;
      else {
        if (st === 0) this.cVin[i] = 0;
        this.cState[i] = 1;
        cN[i3] = hit.nx; cN[i3 + 1] = hit.ny; cN[i3 + 2] = hit.nz;
        this.cD[i] = hit.nx * pw.x + hit.ny * pw.y + hit.nz * pw.z - r + depth;
        this.hMat[i] = hit.material;
      }
      hN[i3] = cN[i3]; hN[i3 + 1] = cN[i3 + 1]; hN[i3 + 2] = cN[i3 + 2];
      this.hD[i] = depth;
      nTouch++;
    }
    this.evTouch.fill(0);
    // Springs: the explicit integrator needs dt²·λmax(M⁻¹·Σ kᵢ jᵢjᵢᵀ) well under 4 (jᵢ = [n, r×n] in
    // body axes). Surface stiffnesses are per sphere, so a tiny whoop (I ~ 1e-5 kg·m²) standing on
    // several spheres a few cm from its CG, or a 2 kHz physics rate, went past it and the contact
    // pumped energy in (bounces, spins of thousands of °/s). All springs of a step are scaled so that
    // ω·dt ≤ 1 for the stiffest mode; a 5" at 8 kHz is never limited.
    // Dampers: Hunt–Crossley / Flores per contact (e from the impact speed of that contact), floored at
    // ζ ≈ 0.3 so resting contact stays quiet. Together they must stay inside the explicit
    // integrator's limit, dt·λmax(M⁻¹·Σ cᵢ jᵢjᵢᵀ) < 2: λmax by power iteration on the 6x6, then all
    // scaled by 1/(1 + dt·λ). Symmetric multi-contact hits (flat landings) are not over-limited the
    // way a per-contact bound would be, a single sphere still gets all the damping it needs, and no
    // per-contact force clamp is needed (the old 600 N clamp let a single sphere tunnel through a
    // gate bar).
    let lam = 0;
    if (nTouch > 0) {
      const W = this.cW, jall = this.cJall, kk = this.cK;
      W.fill(0);
      for (let i = 0; i < nc; i++) {
        if (this.hD[i] <= 0) continue;
        const c = cs[i], mat = this.hMat[i];
        kk[i] = c.kind === 'prop' ? mat.stiffness * 0.15 : mat.stiffness;
        const nw = this.t2; nw.x = hN[i * 3]; nw.y = hN[i * 3 + 1]; nw.z = hN[i * 3 + 2];
        const nb = rotateInv(this.t3, s.q, nw), rn = cross(this.t4, c.pos, nb), o = i * 6;
        jall[o] = nb.x; jall[o + 1] = nb.y; jall[o + 2] = nb.z; jall[o + 3] = rn.x; jall[o + 4] = rn.y; jall[o + 5] = rn.z;
        for (let a = 0; a < 6; a++) { const ka = kk[i] * jall[o + a]; for (let b = 0; b < 6; b++) W[a * 6 + b] += ka * jall[o + b]; }
      }
      const lamK = this.lamMax(W, this.cEigK);
      const sk = lamK * dt * dt > 1 ? 1 / (lamK * dt * dt) : 1;
      W.fill(0);
      for (let i = 0; i < nc; i++) {
        const depth = this.hD[i];
        if (depth <= 0) continue;
        const c = cs[i], mat = this.hMat[i], o = i * 6;
        const k = (kk[i] *= sk);
        const r2 = c.pos.x * c.pos.x + c.pos.y * c.pos.y + c.pos.z * c.pos.z;
        const vin = Math.max(this.cVin[i], 0.5), e = restitutionAt(mat, vin);
        const cc = Math.max((8 * (1 - e)) / (5 * e * vin) * k * depth, 0.6 * Math.sqrt(k / (1 / p.mass + r2 / this.iMin)));
        this.cC[i] = cc;
        for (let a = 0; a < 6; a++) { const ca = cc * jall[o + a]; for (let b = 0; b < 6; b++) W[a * 6 + b] += ca * jall[o + b]; }
      }
      lam = this.lamMax(W, this.cEig);
    }
    const dScale = 1 / (1 + dt * lam);
    // pass 2: forces
    for (let i = 0; i < nc; i++) {
      const depth = this.hD[i];
      if (depth <= 0) continue;
      const c = cs[i];
      touching = true;
      // point velocity of the airframe (world): v + q(w x r)
      const wr = cross(this.t3, s.w, c.pos);
      const wrW = rotate(this.t4, s.q, wr);
      let vx = s.vel.x + wrW.x, vy = s.vel.y + wrW.y, vz = s.vel.z + wrW.z;
      const nx = hN[i * 3], ny = hN[i * 3 + 1], nz = hN[i * 3 + 2];
      // Normal response uses the airframe velocity only: blades are flimsy and cannot push the
      // frame off a surface at tip speed (including it made the damper explode on prop strikes).
      const vn = vx * nx + vy * ny + vz * nz;
      // reported impact speed: the craft's (CG) approach speed, not a spinning arm tip's
      const vcg = -(s.vel.x * nx + s.vel.y * ny + s.vel.z * nz);
      if (vcg > maxApproach) maxApproach = vcg;
      if (-vn > this.cVin[i]) this.cVin[i] = -vn;
      const isProp = c.kind === 'prop';
      let tipSpeed = 0;
      if (isProp) {
        // spinning blades sweep the contact point: blade velocity adds to the sliding velocity
        const rc = p.rotors[c.rotor];
        const om = this.motors[c.rotor].s.omega * rc.dir;
        const rel = this.dirTmp;
        rel.x = c.pos.x - rc.pos.x; rel.y = c.pos.y - rc.pos.y; rel.z = c.pos.z - rc.pos.z;
        const spin = this.fTmp; spin.x = rc.axis.x * om; spin.y = rc.axis.y * om; spin.z = rc.axis.z * om;
        const tv = cross(this.t5, spin, rel);
        tipSpeed = Math.abs(om) * Math.sqrt(rel.x * rel.x + rel.y * rel.y + rel.z * rel.z);
        const tvW = rotate(this.t5, s.q, tv);
        vx += tvW.x; vy += tvW.y; vz += tvW.z;
      }
      const mat = this.hMat[i];
      // prop blades flex: much softer than the frame against the same surface (pass 1, incl. the
      // integrator's stiffness limit)
      const k = this.cK[i];
      // effective inverse mass at this point incl. rotation (r²/I), shared by all touching spheres
      const r2 = c.pos.x * c.pos.x + c.pos.y * c.pos.y + c.pos.z * c.pos.z;
      const invM = 1 / p.mass + r2 / this.iMin;
      let fn = k * depth - this.cC[i] * dScale * vn;
      if (fn < 0) fn = 0;
      // friction (regularised Coulomb) on the sliding velocity, + snag / ploughing on soft ground
      const vnt = vx * nx + vy * ny + vz * nz;
      const tx = vx - vnt * nx, ty = vy - vnt * ny, tz = vz - vnt * nz;
      const vt = Math.sqrt(tx * tx + ty * ty + tz * tz);
      const digs = isProp || c.kind === 'motor';
      let mu = isProp ? Math.min(1, mat.friction + 0.3) : mat.friction;
      if (digs) mu += mat.snag * Math.min(1, depth / (0.3 * c.radius));
      // Regularised Coulomb acts as a viscous damper (mu*fn/vReg) below vReg. Keep it inside the
      // explicit integrator's stability limit for this contact's effective mass: c·dt·(1/m + r²/I) <= 0.5.
      const vReg = Math.max(0.08, 2 * mu * fn * dt * invM);
      const plough = digs ? mat.plough * Math.min(depth, c.radius) : 0; // N/(m/s): tips cutting turf
      const ftk = vt > 1e-6 ? (mu * fn) / Math.max(vt, vReg) + plough : 0;
      const f = this.fTmp;
      f.x = fn * nx - ftk * tx; f.y = fn * ny - ftk * ty; f.z = fn * nz - ftk * tz;
      Fw.x += f.x; Fw.y += f.y; Fw.z += f.z;
      const fB = rotateInv(this.t3, s.q, f);
      const tq = cross(this.t4, c.pos, fB);
      if (isProp) {
        // a blade strike's moment about the shaft brakes the rotor (rotorExtraTorque below); the free
        // bearing passes only the force and the off-axis moment on to the frame
        const rc = p.rotors[c.rotor], a = rc.axis;
        const rx = c.pos.x - rc.pos.x, ry = c.pos.y - rc.pos.y, rz = c.pos.z - rc.pos.z;
        const ma = a.x * (ry * fB.z - rz * fB.y) + a.y * (rz * fB.x - rx * fB.z) + a.z * (rx * fB.y - ry * fB.x);
        tq.x -= a.x * ma; tq.y -= a.y * ma; tq.z -= a.z * ma;
      }
      Tq.x += tq.x; Tq.y += tq.y; Tq.z += tq.z;
      // rolling resistance: a small torque against the body rate while pressed on a surface
      const wm = Math.sqrt(s.w.x * s.w.x + s.w.y * s.w.y + s.w.z * s.w.z);
      if (wm > 1e-6 && mat.rolling > 0) {
        const tr = (mat.rolling * c.radius * fn) / Math.max(wm, 1);
        Tq.x -= tr * s.w.x; Tq.y -= tr * s.w.y; Tq.z -= tr * s.w.z;
      }
      // impact energy for the damage model: compression work done on this sphere
      const work = vn < 0 ? -fn * vn * dt : 0;
      const kr = c.rotor;
      if (kr >= 0 && kr < nr) {
        this.evTouch[kr] = 1;
        if (isProp) this.evProp[kr] += work; else if (c.kind === 'motor') this.evMotor[kr] += work; else this.evArm[kr] += work;
        if (mat.propDamage > this.evMat[kr].propDamage || this.evAge[kr] === 0) this.evMat[kr] = mat;
      }
      if (isProp) {
        const rc = p.rotors[c.rotor];
        // braking torque on the rotor from blade friction against the obstacle (faded near zero
        // speed so it brakes the prop to a stop instead of chattering across zero)
        const omAbs = Math.abs(this.motors[c.rotor].s.omega);
        const tb = Math.min(mu * fn * rc.table.R, 2.0) * Math.min(1, omAbs / 50);
        this.rotorExtraTorque[c.rotor] += tb;
        if (tipSpeed > 15) this.evStrike[c.rotor] += tb * omAbs * dt; // rotor energy spent hitting it
      }
    }
    s.touching = touching;
    if (maxApproach > 0.5) s.maxImpact = maxApproach;
    this.foliage(env, dt, Fw);
    // impact events: one damage roll per rotor per impact (contact over, or every 30 ms while pinned)
    for (let k = 0; k < nr; k++) {
      if (this.evTouch[k]) this.evAge[k] += dt;
      if (this.evAge[k] > 0 && (!this.evTouch[k] || this.evAge[k] > 0.03)) {
        if (env.damageEnabled) this.rollDamage(k);
        if (this.evStrike[k] > 0) {
          // the strike yanked the rotor's speed down: a chance the ESC loses sync (severity = share
          // of the rotor's kinetic energy the blades spent on the obstacle)
          const m = this.motors[k], J = p.rotors[k].motor.rotorInertia + p.rotors[k].propInertia;
          m.strike(this.evStrike[k] / (0.5 * J * m.s.omega * m.s.omega + this.evStrike[k] + 1e-9));
        }
        this.evAge[k] = 0; this.evProp[k] = this.evStrike[k] = this.evMotor[k] = this.evArm[k] = 0;
      }
    }
  }

  /**
   * λmax(M⁻¹·A) for a symmetric 6x6 contact matrix A (body axes, [force; torque]) by power iteration,
   * warm-started from (and updating) x, last step's eigenvector; 10 % margin (it converges from below).
   */
  private lamMax(A: Float64Array, x: Float64Array): number {
    const y = this.cJ, Ii = this.Iinv, m = this.p.mass;
    // nudged so the start is never orthogonal to the new eigenvector
    let xn = 0, lam = 0;
    for (let a = 0; a < 6; a++) { x[a] += 0.05; xn += x[a] * x[a]; }
    xn = Math.sqrt(xn); for (let a = 0; a < 6; a++) x[a] /= xn;
    for (let it = 0; it < 6; it++) {
      for (let a = 0; a < 6; a++) { let sum = 0; for (let b = 0; b < 6; b++) sum += A[a * 6 + b] * x[b]; y[a] = sum; }
      const z0 = y[0] / m, z1 = y[1] / m, z2 = y[2] / m;
      const z3 = Ii[0] * y[3] + Ii[1] * y[4] + Ii[2] * y[5], z4 = Ii[3] * y[3] + Ii[4] * y[4] + Ii[5] * y[5], z5 = Ii[6] * y[3] + Ii[7] * y[4] + Ii[8] * y[5];
      const nz = Math.sqrt(z0 * z0 + z1 * z1 + z2 * z2 + z3 * z3 + z4 * z4 + z5 * z5);
      if (nz < 1e-12) break;
      lam = nz; // |x| = 1
      x[0] = z0 / nz; x[1] = z1 / nz; x[2] = z2 / nz; x[3] = z3 / nz; x[4] = z4 / nz; x[5] = z5 / nz;
    }
    return lam * 1.1;
  }

  /** Tree canopies / hedges: porous drag growing with depth, leaves dragging on (and nicking) the props. */
  private foliage(env: QuadEnv, dt: number, Fw: V3): void {
    if (!env.world.foliage) return;
    const d = env.world.foliage(this.s.pos);
    if (d <= 0) return;
    const v = this.s.vel, V = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
    const kf = this.foliageDrag * Math.min(d, 1.5) * V;
    Fw.x -= kf * v.x; Fw.y -= kf * v.y; Fw.z -= kf * v.z;
    const dd = Math.min(d, 1);
    for (let k = 0; k < this.p.rotors.length; k++) {
      const rc = this.p.rotors[k], om = Math.abs(this.motors[k].s.omega), R = rc.table.R / 0.0635;
      this.rotorExtraTorque[k] += 4e-6 * dd * om * R * R * R * R;
      // twigs: random small strikes, ~8/s per prop deep in the canopy at full rpm
      if (om > 300 && this.rng.next() < 8 * dd * (om / 3000) * dt) {
        const J = rc.motor.rotorInertia + rc.propInertia;
        this.evStrike[k] += 0.01 * J * om * om; this.evAge[k] = Math.max(this.evAge[k], dt);
        if (this.evMat[k].propDamage < MATERIALS.foliage.propDamage) this.evMat[k] = MATERIALS.foliage;
      }
    }
  }

  /**
   * Energy-based crash damage, rolled once per impact event. Part failure follows a Weibull curve
   * (shape 2) around the part's strength E50 (energy at which it fails half the time):
   * props from the compression work at their spheres + ~15 % of the rotor energy spent hitting the
   * obstacle (most goes into blade friction), × the surface's prop damage factor; motor shaft / bell from
   * motor-sphere hits and part of the prop-strike load through the shaft; arms from arm-sphere and
   * motor-sphere hits. Hard surfaces bend metal more than turf does.
   */
  private rollDamage(k: number): void {
    const rc = this.p.rotors[k], d = this.aero[k].damage, md = this.motorDamage[k], rng = this.rng;
    const mat = this.evMat[k];
    const st = rc.strength ?? { prop: STRENGTH.prop * 1.1 * Math.pow(rc.propMass * 1000, 2 / 3), shaft: STRENGTH.shaft * Math.pow(rc.motor.massKg * 1000, 2 / 3), arm: STRENGTH.arm };
    const wb = (E: number, E50: number) => 1 - Math.exp(-Math.LN2 * (E / E50) * (E / E50));
    const Ep = (this.evProp[k] + 0.15 * this.evStrike[k]) * mat.propDamage;
    const hard = 0.15 + 0.85 * Math.min(1, mat.propDamage) ** 2;
    const Es = (this.evMotor[k] + 0.15 * this.evProp[k] + 0.05 * this.evStrike[k] + 0.3 * this.evArm[k]) * hard;
    const Ea = (this.evArm[k] + 0.5 * this.evMotor[k]) * hard;
    const t = this.s.time;
    if (Ep > 0.02 * st.prop || Es > 0.02 * st.shaft || Ea > 0.02 * st.arm) this.impactLog.push({ rotor: k, prop: Ep, shaft: Es, arm: Ea, time: t });
    if (!d.broken && Ep > 0.05 * st.prop) {
      if (rng.next() < wb(Ep, st.prop)) {
        d.broken = true; d.imbalance += 8e-6 * (rc.propMass / 0.0043); // a blade (tip) gone
        this.damageLog.push({ part: 'break', rotor: k, energy: Ep, time: t });
      } else if (rng.next() < wb(Ep, 0.3 * st.prop)) {
        const sev = Math.min(1.5, Ep / (0.3 * st.prop));
        d.thrustFactor *= 1 - (0.02 + 0.06 * rng.next()) * sev * Math.min(1.5, mat.propDamage);
        d.torqueFactor *= 1 + 0.02 * rng.next() * sev;
        d.imbalance += rc.propMass * 1e-4 * (0.5 + rng.next()) * sev; // chipped / bent blade tip
        if (d.thrustFactor < 0.55) d.broken = true;
        this.damageLog.push({ part: 'chip', rotor: k, energy: Ep, time: t });
      }
    }
    if (Es > 0.05 * st.shaft && rng.next() < wb(Es, st.shaft)) {
      // bent shaft / dented bell: the rotor runs eccentric -> 1x-rpm imbalance (vibration path)
      const sev = (0.3 + 0.7 * rng.next()) * Math.min(2, Es / st.shaft);
      md.shaftBend += sev;
      d.imbalance += (rc.propMass + 0.4 * rc.motor.massKg) * 1.5e-4 * sev;
      this.damageLog.push({ part: 'shaft', rotor: k, energy: Es, time: t });
    }
    if (Ea > 0.05 * st.arm && rng.next() < wb(Ea, st.arm)) {
      md.armBendDeg = Math.min(25, md.armBendDeg + (2 + 6 * rng.next()) * Math.min(2, Ea / st.arm));
      // the arm bends up / down: tilt the thrust axis about the in-plane normal to the arm
      const a0 = this.axis0[k], h = rc.pos, L = Math.hypot(h.x, h.y) || 1;
      const ux = -h.y / L, uy = h.x / L, th = (md.armBendDeg * Math.PI) / 180 * (k % 2 ? 1 : -1);
      const c = Math.cos(th), sn = Math.sin(th), dt = ux * a0.x + uy * a0.y;
      // Rodrigues about u = (ux, uy, 0)
      const ax = a0.x * c + (uy * a0.z) * sn + ux * dt * (1 - c);
      const ay = a0.y * c - (ux * a0.z) * sn + uy * dt * (1 - c);
      const az = a0.z * c + (ux * a0.y - uy * a0.x) * sn;
      const l = Math.hypot(ax, ay, az);
      rc.axis.x = ax / l; rc.axis.y = ay / l; rc.axis.z = az / l;
      this.damageLog.push({ part: 'arm', rotor: k, energy: Ea, time: t });
    }
    if (this.impactLog.length > 256) this.impactLog.splice(0, 64);
    if (this.damageLog.length > 256) this.damageLog.splice(0, 64);
  }

  repair(): void {
    this.aero.forEach((a, k) => { a.damage = pristineDamage(); a.damage.imbalance = this.p.rotors[k].imbalance ?? a.damage.imbalance; });
    this.p.rotors.forEach((r, k) => { r.axis.x = this.axis0[k].x; r.axis.y = this.axis0[k].y; r.axis.z = this.axis0[k].z; });
    for (const m of this.motorDamage) { m.shaftBend = 0; m.armBendDeg = 0; }
    // replaced motors: healthy magnets and windings
    for (const m of this.motors) { m.s.burnt = false; m.s.ktHealth = 1; m.s.peakC = m.s.tempC; }
    this.impactLog = [];
    this.damageLog = [];
  }
}
