// Brushless outrunner + ESC, modelled as an equivalent DC machine driven by a synchronous
// (complementary-PWM, "damped light") bridge. The electrical time constant (L/R ~ 0.1–0.5 ms)
// is shorter than a few physics steps, so the winding current is solved quasi-statically:
//     i = (D·Vbus − Ke·ω) / Reff        (negative i ⇒ active braking / regeneration)
// Mechanical:  J·dω/dt = Kt·i − τ_loss(ω) − τ_prop(ω)
// Thermal:     C·dT/dt = i²R + P_iron − (T − Tamb)/Rth ;  R(T), Kt(T) temperature dependent.
// ESC firmware behaviour on top: optional bus-current limiter (PI), desyncs on hard chops / prop
// strikes, and the irreversible end of overheating (magnet demagnetisation, burnt windings).
import { Rng } from './math';

export interface MotorParams {
  kv: number;               // rpm / V (no-load rating)
  rmOhm: number;            // winding resistance, phase-to-phase, @20 °C
  escOhm: number;           // ESC MOSFET + commutation/timing losses as an equivalent series R
  i0A: number;              // no-load current at 10 V
  poles: number;            // magnet poles (e.g. 14 for 12N14P)
  rotorInertia: number;     // kg m² (bell + shaft)
  massKg: number;
  thermalCapJPerK: number;
  thermalResKPerW: number;  // winding-to-air scale (K/W): 4x this in still air, ~0.4x at hover, ~0.15x at WOT
  kvLoadFactor: number;     // effective Ke inflation under load (timing / armature reaction), ~0.92–0.97
  /** ESC bus-current limit per motor (A); 0 = off, as BLHeli_32 / AM32 ship. */
  escCurrentLimitA: number;
  escEfficiency: number;    // switching/conduction efficiency seen at the DC bus
  /** Current-limiter integral time constant (s), BLHeli_32 / AM32 style PI on the measured bus current. */
  escLimitTauS?: number;
  /** Desync likelihood multiplier (1 = typical modern ESC + motor, 0 = never). */
  desyncRisk?: number;
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
  /** Current-limiter duty ceiling (1 = not limiting). */
  dutyCeil: number;
  /** Remaining time (s) of a desync stall; > 0 = the ESC lost commutation and is restarting. */
  desyncT: number;
  desyncs: number;   // desync events so far
  /** Hottest the windings / magnets have been (°C): sets the irreversible magnet loss. */
  peakC: number;
  /** Permanent Kt fraction left after overheating the magnets (1 = healthy). */
  ktHealth: number;
  /** Winding insulation failed (burnt motor): the ESC can no longer drive it. */
  burnt: boolean;
}

const ALPHA_CU = 0.00393;
const KT_TEMPCO = -0.0011; // N52 magnet remanence / K (reversible)
// Irreversible demagnetisation: NdFeB grade H rotor magnets (max working temperature 120 °C) lose
// remanence for good once the knee of their demagnetisation curve passes the operating point; thin
// arc magnets in an outrunner bell sit at a low permeance coefficient, so the loss grows fast past it
// (≈0.6 %/K of overshoot here, est.), set by the hottest the bell has been.
const DEMAG_C = 120, DEMAG_PER_K = 0.006, DEMAG_MAX = 0.45;
// Class-H magnet wire enamel (180 °C rating) breaks down within seconds above it: shorted turns.
const BURN_C = 180, BURN_S = 1.5;
// low-rpm power protection: duty cap at stall, and the fraction of no-load speed where it lifts
const LRPP_STALL = 0.25, LRPP_FULL = 0.3;

export class Motor {
  p: MotorParams;
  s: MotorState;
  private pend0 = 0; private pend1 = 0; // DShot transport/processing delay (two frames in flight)
  readonly ke: number;  // V·s/rad at 20 °C
  private rng: Rng;
  private iBusF = 0;      // limiter: filtered bus-current measurement
  private limInt = 1;     // limiter integrator
  private dRef = 0;       // slow follower of the commanded duty (abrupt-chop detector)
  private chopArmed = true;
  private burnT = 0;
  private lastVbus = 0;   // bus voltage the ESC last saw (for its rpm-based limits)
  constructor(p: MotorParams, ambientC = 20, seed = 1) {
    this.p = p;
    this.ke = 60 / (2 * Math.PI * p.kv) / p.kvLoadFactor;
    this.rng = new Rng((seed ^ 0x51ed2b) >>> 0);
    this.s = { omega: 0, current: 0, busCurrent: 0, tempC: ambientC, duty: 0, dshotCmd: 0, reversed: false, torqueMotor: 0, omegaDot: 0, dutyCeil: 1, desyncT: 0, desyncs: 0, peakC: ambientC, ktHealth: 1, burnt: false };
  }

  /** Stop the rotor and clear the ESC's control state (respawn); temperatures and damage stay. */
  resetDynamics(): void {
    const s = this.s;
    s.omega = 0; s.current = 0; s.omegaDot = 0; s.busCurrent = 0; s.torqueMotor = 0; s.duty = 0; s.desyncT = 0; s.dutyCeil = 1;
    this.iBusF = 0; this.limInt = 1; this.dRef = 0; this.chopArmed = true; this.burnT = 0;
  }

  rEff(): number {
    return this.p.rmOhm * (1 + ALPHA_CU * (this.s.tempC - 20)) + this.p.escOhm;
  }
  kt(): number { return this.ke * (1 + KT_TEMPCO * (this.s.tempC - 20)) * this.s.ktHealth; }

  /** Queue a DShot command (called at the PID/motor update rate). */
  command(dshot: number, reversed: boolean): void {
    const cmd = this.pend0;
    this.pend0 = this.pend1; this.pend1 = dshot;
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

  /**
   * Duty the bridge actually applies: the command under the current limiter and the low-rpm power
   * protection; NaN = not driving.
   */
  appliedDuty(): number {
    if (this.s.burnt || this.s.desyncT > 0) return NaN;
    const D = this.dutyFromCmd() * this.s.dutyCeil;
    // Low-rpm power protection (BLHeli_32 "Low RPM Power Protect" / AM32 "low rpm throttle limit",
    // both on by default): the duty is capped near standstill and the cap lifts with rpm (here 25 %
    // at stall, full from 30 % of the no-load speed), so a stalled or just-starting motor cannot pull
    // its stall current (~200 A on a 6S 5") through the MOSFETs and windings.
    if (this.lastVbus > 0) {
      // (speed in the commanded direction: driving against the spin is as hard as starting)
      const x = Math.max(0, Math.sign(D) * this.s.omega) * this.kt() / this.lastVbus;
      const cap = LRPP_STALL + (1 - LRPP_STALL) * Math.min(1, x / LRPP_FULL);
      if (cap < 1) return Math.max(-cap, Math.min(cap, D));
    }
    return D;
  }

  /** Coefficients for the bus solve: bus current = a·V − b (for driven motors); written to `out` when given. */
  busCoeffs(out: { a: number; b: number; driven: boolean } = { a: 0, b: 0, driven: false }): { a: number; b: number; driven: boolean } {
    const D = this.appliedDuty();
    if (Number.isNaN(D)) { out.a = 0; out.b = 0; out.driven = false; return out; }
    const R = this.rEff(), e = this.kt() * this.s.omega; // back-EMF (signed), Ke≈Kt in SI
    // i = (D V − e)/R ;  I_bus = D·i (/η when motoring)
    const eta = this.p.escEfficiency;
    out.a = (D * D) / (R * eta); out.b = (D * e) / (R * eta); out.driven = true;
    return out;
  }

  /** No-load speed at bus voltage V (rad/s). */
  omegaNoLoad(V: number): number { return V / Math.max(1e-6, this.kt()); }

  /**
   * A prop strike just braked the rotor (severity ~ 0..1+: fraction of its kinetic energy lost):
   * the sudden deceleration can throw the ESC's zero-cross timing out (desync).
   */
  strike(severity: number): void {
    if (severity > 0.05) this.maybeDesync(0.04 * Math.min(1, severity));
  }

  private maybeDesync(p: number): void {
    if (this.s.desyncT > 0 || this.s.burnt) return;
    if (this.rng.next() < p * (this.p.desyncRisk ?? 1)) {
      // stall while the ESC detects the lost sync and restarts the motor (BLHeli_32 / AM32 ~50-300 ms)
      this.s.desyncT = 0.05 + 0.25 * this.rng.next();
      this.s.desyncs++;
    }
  }

  /**
   * Advance the motor by dt given bus voltage and the aerodynamic load torque (signed, opposing
   * rotation, along the spin axis) and the additional inertia of the attached propeller.
   */
  step(vbus: number, propTorque: number, propInertia: number, dt: number, ambientC: number, coolingAirspeed: number): void {
    const p = this.p, s = this.s;
    const Dcmd = this.dutyFromCmd();
    const D = this.appliedDuty();
    this.lastVbus = vbus;
    const R = this.rEff(), kt = this.kt();
    let i = 0;
    if (!Number.isNaN(D)) {
      i = (D * vbus - kt * s.omega) / R;
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
    let tauLoss = Math.abs(w) > 0.5 ? Math.sign(w) * kt * i0 : w * kt * i0 * 2; // smooth through 0
    // burnt windings: the shorted turns brake the magnets like a short-circuited generator
    if (s.burnt) tauLoss += (0.3 * kt * kt * w) / p.rmOhm;
    s.torqueMotor = kt * i;
    const J = p.rotorInertia + propInertia;
    s.omegaDot = (s.torqueMotor - tauLoss - propTorque) / J;
    s.omega += s.omegaDot * dt;
    // thermal
    const pLoss = i * i * p.rmOhm * (1 + ALPHA_CU * (s.tempC - 20)) + Math.abs(kt * i0 * w);
    // cooling: natural convection when still, forced by the spinning bell / its own prop wash
    // (h ∝ U^0.8, U ∝ rpm; a 5" 2207 runs ~30 °C at hover and ~100-120 °C after a minute at full
    // throttle on a thrust stand) and by the flight airspeed
    const xs = Math.min(1, (Math.abs(w) * kt) / Math.max(1, vbus));
    const rth = p.thermalResKPerW / (0.25 + 8 * Math.exp(0.8 * Math.log(xs)) + coolingAirspeed / 12); // (xs^0.8)
    s.tempC += ((pLoss - (s.tempC - ambientC) / rth) / p.thermalCapJPerK) * dt;
    if (s.tempC > s.peakC) {
      s.peakC = s.tempC;
      s.ktHealth = 1 - Math.min(DEMAG_MAX, Math.max(0, s.peakC - DEMAG_C) * DEMAG_PER_K);
    }
    if (s.tempC > BURN_C) { this.burnT += dt; if (this.burnT > BURN_S) s.burnt = true; } else this.burnT = 0;

    // ESC current limiter (BLHeli_32 "current protection" / AM32 current limit, both off by default):
    // a PI on the shunt-measured bus current trims a duty ceiling; it lets the inrush overshoot for
    // a few ms and then pulls the current back to the limit within ~20-50 ms (no instant clamp).
    const lim = p.escCurrentLimitA;
    if (lim > 0) {
      this.iBusF += (s.busCurrent - this.iBusF) * Math.min(1, dt / 0.003); // shunt amplifier / ADC filter
      const e = (lim - this.iBusF) / lim, ti = p.escLimitTauS ?? 0.06;
      this.limInt = Math.min(1, Math.max(0.03, this.limInt + (e * dt) / ti));
      s.dutyCeil = Math.min(1, Math.max(0.03, this.limInt + 0.25 * e));
    } else s.dutyCeil = 1;

    // Desync: an abrupt throttle chop at high rpm demands hard active braking; the long demag
    // after each commutation can hide the zero crossing and the ESC loses sync (BLHeli_32 demag
    // compensation exists for exactly this). One roll per chop, likelier the faster the motor.
    if (s.desyncT > 0) s.desyncT = Math.max(0, s.desyncT - dt);
    const dc = Number.isNaN(Dcmd) ? 0 : Math.abs(Dcmd);
    this.dRef += (dc - this.dRef) * Math.min(1, dt / 0.02);
    const drop = this.dRef - dc;
    if (drop < 0.1) this.chopArmed = true;
    else if (this.chopArmed && drop > 0.35) {
      this.chopArmed = false;
      const x = Math.abs(s.omega) / this.omegaNoLoad(Math.max(1, vbus));
      if (x > 0.45) this.maybeDesync(0.012 * Math.min(1, (x - 0.45) / 0.35) * Math.min(1, drop / 0.7));
    }
  }

  rpm(): number { return (this.s.omega * 60) / (2 * Math.PI); }
  erpm(): number { return this.rpm() * (this.p.poles / 2); }
}
