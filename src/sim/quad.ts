// Full multirotor plant: 6-DoF rigid body with rotor gyroscopics, BLDC/ESC motors, BEMT rotors,
// battery bus, airframe drag, wind + wake, vibration excitation, IMU, and compliant contacts.
// World frame ENU (z up); body frame FLU. Units SI.
import { Battery, BatteryParams } from './battery';
import { BemtTable } from './bemt';
import { ColliderSphere, CollisionWorld, ContactHit, MATERIALS, SurfaceMaterial, zetaFromRestitution } from './contact';
import { FlexMode, GyroChip, Imu } from './imu';
import { V3, Quat, v3, quat, rotate, rotateInv, cross, qintegrate, Rng } from './math';
import { Motor, MotorParams } from './motor';
import { RotorAero, RotorAeroOut, pristineDamage } from './rotor';
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
  private rng = new Rng(7);
  private air = { rho: 1.225, pressure: 101325, tempK: 288, mu: 1.8e-5 };
  private groundCache: number[] = [];
  private groundTimer = 0;
  private wakeTimer = 0;
  private wakeVel: V3[] = [];
  private wakeTurb: number[] = [];
  private hit: ContactHit = { depth: 0, nx: 0, ny: 0, nz: 1, material: MATERIALS.grass };
  // temporaries (no allocation in the hot loop)
  private t1 = v3(); private t2 = v3(); private t3 = v3(); private t4 = v3(); private t5 = v3();
  private F = v3(); private Tq = v3(); private Fb = v3();
  private vibF = v3(); private vibT = v3(); private hTot = v3();
  private airTmp = v3(); private fTmp = v3(); private posTmp = v3(); private dirTmp = v3();
  readonly physicsHz: number;
  propStrikeLog: { rotor: number; energy: number; time: number }[] = [];

  constructor(p: QuadParams, physicsHz = 8000, soc = 1, ambientC = 20) {
    this.p = p;
    this.physicsHz = physicsHz;
    this.motors = p.rotors.map((r) => new Motor(r.motor, ambientC));
    this.aero = p.rotors.map((r, i) => {
      const a = new RotorAero(r.table, 100 + i);
      a.ductGain = r.ductGain ?? 0;
      a.damage.imbalance = r.imbalance ?? a.damage.imbalance;
      return a;
    });
    this.rotorOut = p.rotors.map(() => ({ thrust: 0, torque: 0, hForce: 0, vi: 0, vrs: 0 }));
    this.phase = p.rotors.map((_, i) => i * 1.3);
    this.rotorExtraTorque = p.rotors.map(() => 0);
    this.groundCache = p.rotors.map(() => Infinity);
    this.wakeVel = p.rotors.map(() => v3());
    this.wakeTurb = p.rotors.map(() => 0);
    this.battery = new Battery(p.battery, soc, ambientC);
    this.imu = new Imu(p.imuChip, physicsHz, p.flex);
    this.imu.mountIsolation = p.mountIsolation;
    this.s = {
      pos: v3(), vel: v3(), q: quat(), w: v3(), time: 0, specForce: v3(0, 0, G0), accWorld: v3(),
      vbus: this.battery.s.voltage, ibus: 0, maxImpact: 0, crashed: false, touching: false,
    };
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
    for (const m of this.motors) { m.s.omega = 0; m.s.current = 0; m.s.omegaDot = 0; m.s.busCurrent = 0; m.s.torqueMotor = 0; m.s.duty = 0; }
    this.rotorExtraTorque.fill(0);
    for (const v of this.wakeVel) { v.x = v.y = v.z = 0; }
    this.wakeTurb.fill(0);
    for (const o of this.rotorOut) { o.thrust = o.torque = o.hForce = o.vi = o.vrs = 0; }
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
    return !(Number.isFinite(s.pos.x + s.pos.y + s.pos.z + s.vel.x + s.vel.y + s.vel.z + s.w.x + s.w.y + s.w.z + s.q.w) &&
      this.motors.every((m) => Number.isFinite(m.s.omega)));
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
    // Each driven ESC draws I_k = a_k*V - b_k unless it is current-limited, in which case it draws
    // a constant D*I_lim/eta. Solve V = vth - rth*sum(I), re-classifying limited ESCs (<= 3 passes).
    const th = this.battery.thevenin();
    const iAux = p.auxPowerW / Math.max(6, s.vbus);
    let V = s.vbus;
    for (let pass = 0; pass < 3; pass++) {
      let A = 0, B = 0, C = iAux;
      for (const m of this.motors) {
        const c = m.busCoeffs();
        if (!c.driven) continue;
        const D = m.dutyFromCmd();
        const i = (D * V - m.kt() * m.s.omega) / m.rEff();
        const lim = m.p.escCurrentLimitA;
        if (pass > 0 && Math.abs(i) > lim) C += (D * Math.sign(i) * lim) / m.p.escEfficiency;
        else { A += c.a; B += c.b; }
      }
      V = (th.vth + th.rth * (B - C)) / (1 + th.rth * A);
      if (V < 0) V = 0;
    }
    s.vbus = V;

    // ---------- kinematics ----------
    const vb = rotateInv(this.t1, s.q, s.vel); // body velocity
    const F = this.F, Tq = this.Tq;
    F.x = 0; F.y = 0; F.z = 0; Tq.x = 0; Tq.y = 0; Tq.z = 0;
    const vibF = this.vibF, vibT = this.vibT;
    vibF.x = vibF.y = vibF.z = 0; vibT.x = vibT.y = vibT.z = 0;

    // wind at CG (world)
    env.wind.step(dt, s.pos.z, Math.hypot(s.vel.x, s.vel.y, s.vel.z));
    const windW = env.wind.at(s.pos, this.t2);
    const wcx = windW.x, wcy = windW.y, wcz = windW.z;

    // ground distance per rotor at 100 Hz, wake sampling at 1 kHz
    this.groundTimer -= dt;
    const doGround = this.groundTimer <= 0;
    if (doGround) this.groundTimer = 0.01;
    this.wakeTimer -= dt;
    const doWake = this.wakeTimer <= 0;
    if (doWake) this.wakeTimer = 0.001;

    let busI = 0;
    const h = this.hTot; h.x = h.y = h.z = 0; // total rotor angular momentum (body); own storage: t5 is scratch for contacts()
    for (let k = 0; k < n; k++) {
      const rc = p.rotors[k], m = this.motors[k], ro = this.aero[k];
      // rotor hub velocity in body: v + w x r
      const wr = cross(this.t3, s.w, rc.pos);
      const vx = vb.x + wr.x, vy = vb.y + wr.y, vz = vb.z + wr.z;
      // hub world position
      const hubW = rotate(this.t4, s.q, rc.pos);
      hubW.x += s.pos.x; hubW.y += s.pos.y; hubW.z += s.pos.z;
      if (doWake) this.wakeTurb[k] = env.wake.sample(hubW, this.wakeVel[k]);
      // air velocity at rotor (wind + wake), world -> body
      const aw = this.airTmp;
      aw.x = wcx + this.wakeVel[k].x; aw.y = wcy + this.wakeVel[k].y; aw.z = wcz + this.wakeVel[k].z;
      const airB = rotateInv(this.t3, s.q, aw);
      const rx = vx - airB.x, ry = vy - airB.y, rz = vz - airB.z;
      const vc = rx * rc.axis.x + ry * rc.axis.y + rz * rc.axis.z;
      const ipx = rx - vc * rc.axis.x, ipy = ry - vc * rc.axis.y, ipz = rz - vc * rc.axis.z;
      const vip = Math.sqrt(ipx * ipx + ipy * ipy + ipz * ipz);
      if (doGround) {
        const axW = rotate(this.dirTmp, s.q, rc.axis);
        axW.x = -axW.x; axW.y = -axW.y; axW.z = -axW.z;
        this.groundCache[k] = env.world.raycast(hubW, axW, 4 * rc.table.R + 0.05);
      }
      const omega = m.s.omega;
      const o = this.rotorOut[k];
      ro.evaluate(omega, vc, vip, rho, this.groundCache[k], this.wakeTurb[k], dt, o);
      // aerodynamic forces on the body
      let fx = rc.axis.x * o.thrust, fy = rc.axis.y * o.thrust, fz = rc.axis.z * o.thrust;
      if (vip > 1e-4) { const k2 = o.hForce / vip; fx -= ipx * k2; fy -= ipy * k2; fz -= ipz * k2; }
      // vibration: static imbalance rotating in the rotor plane + blade-pass thrust ripple
      this.phase[k] += omega * rc.dir * dt;
      const ph = this.phase[k];
      const fImb = ro.damage.imbalance * omega * omega;
      const ripple = o.thrust * (0.012 * Math.sin(rc.bladeCount * ph) + 0.004 * Math.sin(2 * ph));
      const vfx = fImb * Math.cos(ph), vfy = fImb * Math.sin(ph), vfz = ripple;
      fx += vfx; fy += vfy; fz += vfz;
      vibF.x += vfx; vibF.y += vfy; vibF.z += vfz;
      const ft = this.fTmp; ft.x = vfx; ft.y = vfy; ft.z = vfz;
      const vt = cross(this.t3, rc.pos, ft);
      vibT.x += vt.x; vibT.y += vt.y; vibT.z += vt.z;
      F.x += fx; F.y += fy; F.z += fz;
      ft.x = fx; ft.y = fy; ft.z = fz;
      const rt = cross(this.t3, rc.pos, ft);
      Tq.x += rt.x; Tq.y += rt.y; Tq.z += rt.z;
      // motor dynamics
      const sgn = omega >= 0 ? 1 : -1;
      const propTorque = o.torque * sgn + this.rotorExtraTorque[k] * sgn;
      this.rotorExtraTorque[k] = 0;
      m.step(V, propTorque, rc.propInertia, dt, env.ambientC, Math.hypot(vc, vip));
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
    this.imu.sample(w, s.specForce, vibT, vibF, m, dt);
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
    const p = this.p, s = this.s;
    let touching = false;
    let maxApproach = 0;
    const hit = this.hit;
    const pw = this.posTmp;
    for (const c of p.colliders) {
      const cw = rotate(this.t2, s.q, c.pos);
      pw.x = s.pos.x + cw.x; pw.y = s.pos.y + cw.y; pw.z = s.pos.z + cw.z;
      if (!env.world.sphere(pw, c.radius, hit)) continue;
      touching = true;
      // point velocity of the airframe (world): v + q(w x r)
      const wr = cross(this.t3, s.w, c.pos);
      const wrW = rotate(this.t4, s.q, wr);
      let vx = s.vel.x + wrW.x, vy = s.vel.y + wrW.y, vz = s.vel.z + wrW.z;
      const nx = hit.nx, ny = hit.ny, nz = hit.nz;
      // Normal response uses the airframe velocity only: blades are flimsy and cannot push the
      // frame off a surface at tip speed (including it made the damper explode on prop strikes).
      const vn = vx * nx + vy * ny + vz * nz;
      if (-vn > maxApproach) maxApproach = -vn;
      let tipSpeed = 0;
      if (c.kind === 'prop') {
        // spinning blades sweep the contact point: blade velocity adds to the sliding velocity
        const rc = p.rotors[c.rotor];
        const om = this.motors[c.rotor].s.omega * rc.dir;
        const rel = this.dirTmp;
        rel.x = c.pos.x - rc.pos.x; rel.y = c.pos.y - rc.pos.y; rel.z = c.pos.z - rc.pos.z;
        const spin = this.fTmp; spin.x = rc.axis.x * om; spin.y = rc.axis.y * om; spin.z = rc.axis.z * om;
        const tv = cross(this.t5, spin, rel);
        tipSpeed = Math.abs(om) * Math.hypot(rel.x, rel.y, rel.z);
        const tvW = rotate(this.t5, s.q, tv);
        vx += tvW.x; vy += tvW.y; vz += tvW.z;
      }
      const mat = hit.material;
      // prop blades flex: much softer than the frame against the same surface
      const k = c.kind === 'prop' ? mat.stiffness * 0.15 : mat.stiffness;
      const zeta = zetaFromRestitution(mat.restitution);
      const cdamp = 2 * zeta * Math.sqrt(k * p.mass * 0.5);
      let fn = k * hit.depth - cdamp * vn;
      if (fn < 0) fn = 0;
      if (fn > 600) fn = 600; // per-contact force bound (~100 g on a 600 g quad) for integrator safety
      // friction (regularised Coulomb) on the sliding velocity
      const vnt = vx * nx + vy * ny + vz * nz;
      const tx = vx - vnt * nx, ty = vy - vnt * ny, tz = vz - vnt * nz;
      const vt = Math.sqrt(tx * tx + ty * ty + tz * tz);
      const mu = c.kind === 'prop' ? Math.min(1, mat.friction + 0.3) : mat.friction;
      // Regularised Coulomb acts as a viscous damper (mu*fn/vReg) below vReg. Keep it inside the
      // explicit integrator's stability limit for this contact's effective mass, including the
      // rotational term r²/I: c·dt·(1/m + r²/I) <= 0.5.
      const r2 = c.pos.x * c.pos.x + c.pos.y * c.pos.y + c.pos.z * c.pos.z;
      const invM = 1 / p.mass + r2 / this.iMin;
      const vReg = Math.max(0.08, 2 * mu * fn * dt * invM);
      const ftk = vt > 1e-6 ? (mu * fn) / Math.max(vt, vReg) : 0;
      const f = this.fTmp;
      f.x = fn * nx - ftk * tx; f.y = fn * ny - ftk * ty; f.z = fn * nz - ftk * tz;
      Fw.x += f.x; Fw.y += f.y; Fw.z += f.z;
      const fB = rotateInv(this.t3, s.q, f);
      const tq = cross(this.t4, c.pos, fB);
      Tq.x += tq.x; Tq.y += tq.y; Tq.z += tq.z;
      if (c.kind === 'prop') {
        const rc = p.rotors[c.rotor];
        // braking torque on the rotor from blade friction against the obstacle (faded near zero
        // speed so it brakes the prop to a stop instead of chattering across zero)
        const omAbs = Math.abs(this.motors[c.rotor].s.omega);
        this.rotorExtraTorque[c.rotor] += Math.min(mu * fn * rc.table.R, 2.0) * Math.min(1, omAbs / 50);
        if (env.damageEnabled && tipSpeed > 15) {
          const J = rc.motor.rotorInertia + rc.propInertia;
          const om = this.motors[c.rotor].s.omega;
          const energy = 0.5 * J * om * om * mat.propDamage * dt * 60;
          this.applyPropDamage(c.rotor, energy, mat);
        }
      }
    }
    s.touching = touching;
    if (maxApproach > 0.5) s.maxImpact = maxApproach;
  }

  private applyPropDamage(k: number, energy: number, mat: SurfaceMaterial): void {
    // energy-scaled stochastic damage: chips (C_T loss), bends (imbalance), breaks
    const d = this.aero[k].damage;
    const pChip = Math.min(1, energy / 8);
    if (this.rng.next() < pChip) {
      d.thrustFactor *= 1 - 0.04 * this.rng.next() * mat.propDamage;
      d.torqueFactor *= 1 + 0.02 * this.rng.next();
      d.imbalance *= 1 + 0.6 * this.rng.next();
      if (d.thrustFactor < 0.55 || energy > 25 * this.rng.next() + 18) d.broken = true;
      this.propStrikeLog.push({ rotor: k, energy, time: this.s.time });
    }
  }

  repair(): void {
    this.aero.forEach((a, k) => { a.damage = pristineDamage(); a.damage.imbalance = this.p.rotors[k].imbalance ?? a.damage.imbalance; });
    this.propStrikeLog = [];
  }
}
