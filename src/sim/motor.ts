// Brushless outrunner + ESC, modelled as an equivalent DC machine driven by a synchronous
// (complementary-PWM, "damped light") bridge. The electrical time constant (L/R ~ 0.1–0.5 ms)
// is shorter than a few physics steps, so the winding current is solved quasi-statically:
//     i = (D·Vbus − Ke·ω) / Reff        (negative i ⇒ active braking / regeneration)
// Mechanical:  J·dω/dt = Kt·i − τ_loss(ω) − τ_prop(ω)
// Thermal:     C·dT/dt = i²R + P_iron − (T − Tamb)/Rth ;  R(T), Kt(T) temperature dependent.

export interface MotorParams {
  kv: number;               // rpm / V (no-load rating)
  rmOhm: number;            // winding resistance, phase-to-phase, @20 °C
  escOhm: number;           // ESC MOSFET + commutation/timing losses as an equivalent series R
  i0A: number;              // no-load current at 10 V
  poles: number;            // magnet poles (e.g. 14 for 12N14P)
  rotorInertia: number;     // kg m² (bell + shaft)
  massKg: number;
  thermalCapJPerK: number;
  thermalResKPerW: number;  // with prop airflow at hover
  kvLoadFactor: number;     // effective Ke inflation under load (timing / armature reaction), ~0.92–0.97
  escCurrentLimitA: number; // per-motor ESC limit (burst)
  escEfficiency: number;    // switching/conduction efficiency seen at the DC bus
}

export interface MotorState {
  omega: number;     // rad/s, signed: + = commanded direction of spin
  current: number;   // winding current, A
  busCurrent: number;// DC bus current drawn by this ESC, A
  tempC: number;
  duty: number;      // effective signed duty applied
  dshotCmd: number;  // last DShot value applied by ESC (0, 48..2047)
  reversed: boolean; // spinning in reverse (turtle mode)
  torqueMotor: number;
  omegaDot: number;
}

const ALPHA_CU = 0.00393;
const KT_TEMPCO = -0.0011; // N52 magnet remanence / K

export class Motor {
  p: MotorParams;
  s: MotorState;
  private pending: number[] = [0, 0]; // DShot transport/processing delay (frames)
  readonly ke: number;  // V·s/rad at 20 °C
  constructor(p: MotorParams, ambientC = 20) {
    this.p = p;
    this.ke = 60 / (2 * Math.PI * p.kv) / p.kvLoadFactor;
    this.s = { omega: 0, current: 0, busCurrent: 0, tempC: ambientC, duty: 0, dshotCmd: 0, reversed: false, torqueMotor: 0, omegaDot: 0 };
  }

  rEff(): number {
    return this.p.rmOhm * (1 + ALPHA_CU * (this.s.tempC - 20)) + this.p.escOhm;
  }
  kt(): number { return this.ke * (1 + KT_TEMPCO * (this.s.tempC - 20)); }

  /** Queue a DShot command (called at the PID/motor update rate). */
  command(dshot: number, reversed: boolean): void {
    this.pending.push(dshot);
    const cmd = this.pending.shift()!;
    this.s.dshotCmd = cmd;
    this.s.reversed = reversed;
  }

  /** Signed duty from DShot value; 0 = motor stop (ESC coasts, no braking). */
  dutyFromCmd(): number {
    const c = this.s.dshotCmd;
    if (c < 48) return NaN; // coast
    const thr = Math.min(1, (c - 48) / 1999);
    return this.s.reversed ? -thr : thr;
  }

  /** Coefficients for the bus solve: bus current = a·V − b (for driven motors). */
  busCoeffs(): { a: number; b: number; driven: boolean } {
    const D = this.dutyFromCmd();
    if (Number.isNaN(D)) return { a: 0, b: 0, driven: false };
    const R = this.rEff(), e = this.kt() * this.s.omega; // back-EMF (signed), Ke≈Kt in SI
    // i = (D V − e)/R ;  I_bus = D·i (/η when motoring)
    const eta = this.p.escEfficiency;
    return { a: (D * D) / (R * eta), b: (D * e) / (R * eta), driven: true };
  }

  /**
   * Advance the motor by dt given bus voltage and the aerodynamic load torque (signed, opposing
   * rotation, along the spin axis) and the additional inertia of the attached propeller.
   */
  step(vbus: number, propTorque: number, propInertia: number, dt: number, ambientC: number, coolingAirspeed: number): void {
    const p = this.p, s = this.s;
    const D = this.dutyFromCmd();
    const R = this.rEff(), kt = this.kt();
    let i = 0;
    if (!Number.isNaN(D)) {
      i = (D * vbus - kt * s.omega) / R;
      const lim = p.escCurrentLimitA;
      if (i > lim) i = lim; else if (i < -lim) i = -lim;
      s.duty = D;
    } else {
      s.duty = 0;
    }
    s.current = i;
    const pMech = i * s.duty * vbus; // electrical power into the bridge output side
    s.busCurrent = !Number.isNaN(D) ? (pMech >= 0 ? (i * s.duty) / p.escEfficiency : i * s.duty * p.escEfficiency) : 0;
    // Losses: iron/friction torque, modelled from no-load current (partly constant, partly ∝ ω)
    const w = s.omega;
    const wRef = (p.kv * 10 * 2 * Math.PI) / 60;
    const i0 = p.i0A * (0.35 + 0.65 * Math.abs(w) / wRef);
    const tauLoss = Math.abs(w) > 0.5 ? Math.sign(w) * kt * i0 : w * kt * i0 * 2; // smooth through 0
    s.torqueMotor = kt * i;
    const J = p.rotorInertia + propInertia;
    s.omegaDot = (s.torqueMotor - tauLoss - propTorque) / J;
    s.omega += s.omegaDot * dt;
    // thermal
    const pLoss = i * i * p.rmOhm * (1 + ALPHA_CU * (s.tempC - 20)) + Math.abs(kt * i0 * w);
    const rth = p.thermalResKPerW / (0.4 + 0.6 * Math.min(1, (Math.abs(w) / wRef) * 0.8 + coolingAirspeed / 30));
    s.tempC += ((pLoss - (s.tempC - ambientC) / rth) / p.thermalCapJPerK) * dt;
  }

  rpm(): number { return (this.s.omega * 60) / (2 * Math.PI); }
  erpm(): number { return this.rpm() * (this.p.poles / 2); }
}
