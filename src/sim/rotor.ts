// Runtime rotor aerodynamics: BEMT table lookup in arbitrary relative wind, plus effects that the
// steady table cannot capture: ground/ceiling effect, duct augmentation and ram drag,
// vortex-ring-state / prop-wash unsteadiness, reversed rotation (turtle mode), and blade damage.
import { BemtTable, tableLookup } from './bemt';
import { Rng } from './math';

export interface RotorDamage {
  thrustFactor: number;   // 1 = pristine; chipped/bent blades reduce C_T
  torqueFactor: number;
  imbalance: number;      // static imbalance, kg·m (m_e · r_e); pristine ~ 2e-7
  broken: boolean;
}

export const pristineDamage = (): RotorDamage => ({ thrustFactor: 1, torqueFactor: 1, imbalance: 2e-7, broken: false });

export interface RotorAeroOut {
  thrust: number;  // N along +axis (negative when reversed)
  torque: number;  // N·m aerodynamic drag torque magnitude opposing rotation (signed if windmilling)
  hForce: number;  // N, in-plane drag opposing in-plane relative velocity
  vi: number;      // induced velocity m/s
  vrs: number;     // 0..1 VRS/prop-wash intensity indicator
  /** Hub moments of the blades in edgewise flow (N·m), rigid-blade values: advancing side up / leading edge up. */
  mAdv: number; mFront: number;
  /** Flapping phase lag (rad): the hub moment pattern turns this far in the spin direction. */
  flapLag: number;
}

export const emptyRotorOut = (): RotorAeroOut => ({ thrust: 0, torque: 0, hForce: 0, vi: 0, vrs: 0, mAdv: 0, mFront: 0, flapLag: 0 });

const out6 = new Float64Array(6);

/**
 * Unit-variance OU process shared by all rotors of one airframe: the part of the prop-wash
 * buffeting that is common to the whole frame. Advanced lazily by whichever rotor reaches a new
 * time first, so each rotor just asks for the value at its own clock.
 */
export class CommonNoise {
  private rng: Rng;
  private t = 0;
  private x = 0;
  constructor(seed: number) { this.rng = new Rng(seed); }
  at(t: number, dt: number, tau: number): number {
    if (t > this.t + 0.5 * dt) {
      const a = Math.exp(-(t - this.t) / tau);
      this.x = this.x * a + Math.sqrt(1 - a * a) * this.rng.gauss();
      this.t = t;
    }
    return this.x;
  }
}

export class RotorAero {
  table: BemtTable;
  damage: RotorDamage = pristineDamage();
  private rng: Rng;
  private ouT = 0; private ouQ = 0;
  private tNow = 0;
  private ouDt = NaN; private ouA = 0; private ouSd = 0; // OU decay / drive for the last dt
  /** Frame-wide correlated part of the prop-wash noise (optional). */
  common: CommonNoise | null = null;
  /** Reversed rotation efficiency (props run backwards are poor airfoils). */
  reverseEfficiency = 0.6;
  /** Strength multiplier for VRS / prop-wash unsteadiness (user setting). */
  propwashScale = 1;
  /**
   * Ducted prop (whoop / cinewhoop): the duct carries part of the thrust and cuts tip losses, so
   * static thrust rises by ~10-20 %. The benefit fades as edgewise / axial flow grows relative to the
   * induced velocity (the duct inlet no longer sees clean, axisymmetric inflow).
   */
  ductGain = 0;
  /** Blade Lock number γ = ρ a c R⁴ / I_β (aerodynamic vs inertial flap forces; ~0.6-0.9 for FPV props). */
  lock = 0.8;
  /** Blade first flap-bending frequency, non-rotating (Hz). */
  flapHz = 200;
  /**
   * Lumped rotor drag beyond the uniform-inflow BEMT H, as a gain on the classic flapping tilt
   * (see evaluate). Calibrated: ≈0.04 N/(m/s) total per 5" rotor at hover rpm (Faessler et al. 2018,
   * RA-L 3(2), identified rotor drag; Kai et al. 2017), ~2.5x the BEMT H alone.
   */
  flapDrag = 1.45;

  constructor(table: BemtTable, seed: number) {
    this.table = table;
    this.rng = new Rng(seed);
  }

  /**
   * omega: rad/s, prop spin relative to the AIR (motor speed + body rate about the axis), sign =
   * rotation sense relative to the configured direction; negative = reversed
   * vc: axial velocity of rotor relative to air along the thrust axis (+ climbing)
   * vip: in-plane relative speed (>= 0)
   * rho: air density; hGround / hCeil: distance to a surface along -axis / +axis (Infinity if none)
   * turb: additional local turbulence intensity m/s (e.g. from wake encounter)
   */
  evaluate(omega: number, vc: number, vip: number, rho: number, hGround: number, turb: number, dt: number, o: RotorAeroOut, hCeil = Infinity): void {
    const t = this.table;
    const R = t.R, A = t.A;
    const rev = omega < 0;
    const W = Math.abs(omega);
    const vcEff = rev ? -vc : vc;
    const OR = W * R;
    const V = Math.sqrt(vcEff * vcEff + vip * vip);
    const q2 = OR * OR + V * V;
    if (q2 < 1e-6) { o.thrust = 0; o.torque = 0; o.hForce = 0; o.vi = 0; o.vrs = 0; o.mAdv = 0; o.mFront = 0; o.flapLag = 0; return; }
    const beta = Math.atan2(V, OR);
    const gamma = V > 1e-6 ? Math.atan2(vcEff, vip) : 0;
    tableLookup(t, beta, gamma, out6);
    const den = rho * A * q2;
    let T = out6[0] * t.ctScale * den;
    const T0 = T, mS = out6[4] * t.ctScale * den * R, mC = out6[5] * t.ctScale * den * R;
    let Q = out6[1] * t.cqScale * den * R;
    // Low-Reynolds-number correction: blade profile drag (and so torque) rises, and lift falls
    // slightly, as the section Reynolds number drops below the calibration point (Re ~ q).
    const reRatio = Math.sqrt(q2) / t.tipRef;
    if (reRatio < 1) { Q *= Math.min(1.45, Math.pow(Math.max(reRatio, 0.05), -0.18)); T *= Math.max(0.9, Math.pow(Math.max(reRatio, 0.05), 0.03)); }
    let H = out6[2] * t.ctScale * den;
    // the table's vi belongs to the uncalibrated BEMT thrust; momentum theory has vi ~ sqrt(T)
    const vi = out6[3] * Math.sqrt(q2) * Math.sqrt(t.ctScale);

    if (this.ductGain > 0 && T > 0) {
      const vh = Math.sqrt(T / (2 * rho * A)) + 1e-6;
      // Augmentation needs clean axisymmetric inflow over the lip; crossflow separates the windward
      // lip and the gain is largely gone by mu = vip/vh ~ 1, while in fast axial flow a duct shaped
      // for static thrust turns into net drag (lip suction collapses, wetted area remains)
      // (shrouded-rotor tunnel data: Graf, Fleming & Gelhausen 2008; Pereira 2008).
      const mu = vip / vh, lc = Math.max(0, vcEff) / (1.5 * vh);
      T *= 1 + (this.ductGain * (1 - 0.5 * lc * lc)) / (1 + 3 * mu * mu + lc * lc);
      // Ram (momentum) drag: the duct swallows mdot = rho A (vi + vc) and turns its in-plane
      // momentum axial, F = mdot * v_ip against the crossflow (the dominant drag of ducted fans in
      // edgewise flight), plus pressure drag of the separated windward lip (~2R x 0.25R, Cd ~ 1).
      const mdot = rho * A * (Math.max(0, vi) + Math.max(0, vcEff));
      H += mdot * vip + 0.25 * rho * vip * vip * R * R;
    }

    // Ground effect (Cheeseman–Bennett), only meaningful in near-hover; fades with forward speed.
    // At fixed rpm the extra thrust comes with less induced power: Q scales ~ GE^-1/2.
    if (hGround < 4 * R && T > 0) {
      const z = Math.max(hGround, 0.5 * R);
      const vh = Math.sqrt(T / (2 * rho * A)) + 1e-6;
      const fade = 1 / (1 + (vip / vh) ** 2);
      const ge = 1 + (Math.min(1.3, 1 / (1 - (R / (4 * z)) ** 2)) - 1) * fade;
      T *= ge; Q /= Math.sqrt(ge);
    }
    // Ceiling effect (Sanchez-Cuevas, Heredia & Ollero 2017): a surface just above the disc blocks
    // the inflow and the low-pressure upper side sucks the rotor up,
    // T_c/T = 1 / (1 - (1/K1) (R/(z + K2))^2), K1 ~ 6.9, K2 ~ R/4; clamped at +40 %.
    if (hCeil < 3 * R && T > 0) {
      const vh = Math.sqrt(T / (2 * rho * A)) + 1e-6;
      const fade = 1 / (1 + (vip / vh) ** 2);
      const zr = R / (Math.max(hCeil, 0.2 * R) + 0.25 * R);
      const ce = 1 / Math.max(1 / 1.4, 1 - (zr * zr) / 6.924);
      T *= 1 + (ce - 1) * fade;
    }

    // VRS / prop-wash: unsteady thrust when descending through own wake (vc/vh in [-0.3,-1.8])
    let vrs = 0;
    if (T > 0) {
      const vh = Math.sqrt(T / (2 * rho * A)) + 1e-6;
      const x = -vcEff / vh;           // descent ratio
      const mu = vip / vh;
      const bump = x > 0.25 && x < 2.2 ? Math.sin(Math.PI * Math.min(1, (x - 0.25) / 1.95)) ** 1.2 : 0;
      vrs = bump * Math.exp(-mu * mu / 1.2);
      vrs = Math.min(1, vrs + Math.min(1, turb / (2.5 * vh)) * 0.6);
    }
    // Ornstein–Uhlenbeck noise, tau ~ 6 ms (corner ~ 25 Hz: blackbox prop-wash energy sits at
    // ~15-50 Hz), scaled by VRS intensity. Part is common to the whole frame (it sits in one
    // turbulent wake, rho ~ 0.36), the rest per rotor (eddies ~ R across are uncorrelated).
    const tau = 0.006;
    if (dt !== this.ouDt) { this.ouDt = dt; this.ouA = Math.exp(-dt / tau); this.ouSd = Math.sqrt(1 - this.ouA * this.ouA); }
    const a = this.ouA, sd = this.ouSd;
    this.ouT = this.ouT * a + sd * this.rng.gauss();
    this.ouQ = this.ouQ * a + sd * this.rng.gauss();
    this.tNow += dt;
    const nT = this.common ? 0.6 * this.common.at(this.tNow, dt, tau) + 0.8 * this.ouT : this.ouT;
    if (vrs > 0) {
      const k = vrs * this.propwashScale;
      T *= 1 - 0.18 * k + 0.28 * k * nT;
      Q *= 1 + 0.12 * k * this.ouQ;
    }

    // Damage
    const d = this.damage;
    T *= d.thrustFactor; Q *= d.torqueFactor;
    if (d.broken) { T *= 0.45; }

    // Rotor drag: blade flapping tilts the tip-path plane back from the relative wind by
    // a1 = 2μ(4θ.75/3 − λ)/(1 − μ²/2) (Prouty; Leishman, blade flapping) and the thrust with it, ∝ T·μ (∝ rpm at
    // a given speed, lumped with the induced drag as in Mahony, Kumar & Corke 2012, IEEE RAM 19(3)).
    // A duct turns the inflow axial and shields the blades from most of it.
    if (OR > 1 && T !== 0) {
      const mu = Math.min(0.5, vip / OR), lam = (vcEff + vi) / OR;
      const a1 = Math.min(0.25, Math.max(0, (2 * mu * ((4 / 3) * t.theta75 - lam)) / (1 - 0.5 * mu * mu)));
      H += this.flapDrag * (this.ductGain > 0 ? 0.4 : 1) * Math.abs(T) * a1;
    }
    // Hub moments ride on the blade lift: scale the rigid-blade table values by everything applied
    // to the thrust since (Reynolds, duct, ground / ceiling, wash, damage). Flapping lag
    // ψ = atan((γ/8)(Ω/ω_β0)²): stiff (hingeless) blade, centre-spring equivalent, the aerodynamic
    // flap damping γ/8·Ω² against the bending stiffness I_β·ω_β0² (Bramwell, hingeless rotors).
    const kM = T0 !== 0 ? T / T0 : 0;
    const wf = 2 * Math.PI * this.flapHz;
    o.mAdv = mS * kM; o.mFront = mC * kM; o.flapLag = Math.atan((this.lock / 8) * (W / wf) * (W / wf));
    if (rev) { T = -T * this.reverseEfficiency; o.mAdv = -o.mAdv * this.reverseEfficiency; o.mFront = -o.mFront * this.reverseEfficiency; }
    o.thrust = T; o.torque = Q; o.hForce = H; o.vi = vi; o.vrs = vrs;
  }
}
