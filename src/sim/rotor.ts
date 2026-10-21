// Runtime rotor aerodynamics: BEMT table lookup in arbitrary relative wind, plus effects that the
// steady table cannot capture: ground/ceiling effect, vortex-ring-state / prop-wash unsteadiness,
// reversed rotation (turtle mode), and blade damage.
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
}

const out4 = new Float64Array(4);

export class RotorAero {
  table: BemtTable;
  damage: RotorDamage = pristineDamage();
  private rng: Rng;
  private ouT = 0; private ouQ = 0;
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

  constructor(table: BemtTable, seed: number) {
    this.table = table;
    this.rng = new Rng(seed);
  }

  /**
   * omega: rad/s (sign = rotation sense relative to the configured direction; negative = reversed)
   * vc: axial velocity of rotor relative to air along the thrust axis (+ climbing)
   * vip: in-plane relative speed (>= 0)
   * rho: air density; hGround: distance to ground along -axis (Infinity if none)
   * turb: additional local turbulence intensity m/s (e.g. from wake encounter)
   */
  evaluate(omega: number, vc: number, vip: number, rho: number, hGround: number, turb: number, dt: number, o: RotorAeroOut): void {
    const t = this.table;
    const R = t.R, A = t.A;
    const rev = omega < 0;
    const W = Math.abs(omega);
    const vcEff = rev ? -vc : vc;
    const OR = W * R;
    const V = Math.sqrt(vcEff * vcEff + vip * vip);
    const q2 = OR * OR + V * V;
    if (q2 < 1e-6) { o.thrust = 0; o.torque = 0; o.hForce = 0; o.vi = 0; o.vrs = 0; return; }
    const beta = Math.atan2(V, OR);
    const gamma = V > 1e-6 ? Math.atan2(vcEff, vip) : 0;
    tableLookup(t, beta, gamma, out4);
    const den = rho * A * q2;
    let T = out4[0] * t.ctScale * den;
    let Q = out4[1] * t.cqScale * den * R;
    // Low-Reynolds-number correction: blade profile drag (and so torque) rises, and lift falls
    // slightly, as the section Reynolds number drops below the calibration point (Re ~ q).
    const reRatio = Math.sqrt(q2) / t.tipRef;
    if (reRatio < 1) { Q *= Math.min(1.45, Math.pow(Math.max(reRatio, 0.05), -0.18)); T *= Math.max(0.9, Math.pow(Math.max(reRatio, 0.05), 0.03)); }
    const H = out4[2] * t.ctScale * den;
    const vi = out4[3] * Math.sqrt(q2);

    if (this.ductGain > 0 && T > 0) {
      const vh = Math.sqrt(T / (2 * rho * A)) + 1e-6;
      const flow2 = (vip * vip + Math.max(0, vcEff) * Math.max(0, vcEff)) / (2.25 * vh * vh);
      T *= 1 + this.ductGain / (1 + flow2);
    }

    // Ground effect (Cheeseman–Bennett), only meaningful in near-hover; fades with forward speed
    if (hGround < 4 * R && T > 0) {
      const z = Math.max(hGround, 0.5 * R);
      const vh = Math.sqrt(T / (2 * rho * A)) + 1e-6;
      const fade = 1 / (1 + (vip / vh) ** 2);
      const ge = Math.min(1.3, 1 / (1 - (R / (4 * z)) ** 2));
      T *= 1 + (ge - 1) * fade;
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
    // Ornstein–Uhlenbeck noise, tau ~ 35 ms, scaled by VRS intensity
    const tau = 0.035;
    const a = Math.exp(-dt / tau), sd = Math.sqrt(1 - a * a);
    this.ouT = this.ouT * a + sd * this.rng.gauss();
    this.ouQ = this.ouQ * a + sd * this.rng.gauss();
    if (vrs > 0) {
      const k = vrs * this.propwashScale;
      T *= 1 - 0.18 * k + 0.28 * k * this.ouT;
      Q *= 1 + 0.12 * k * this.ouQ;
    }

    // Damage
    const d = this.damage;
    T *= d.thrustFactor; Q *= d.torqueFactor;
    if (d.broken) { T *= 0.45; }

    if (rev) { T = -T * this.reverseEfficiency; }
    o.thrust = T; o.torque = Q; o.hForce = H; o.vi = vi; o.vrs = vrs;
  }
}
