// Atmospheric wind: log-law mean wind with direction, Dryden low-altitude turbulence
// (MIL-HDBK-1797) with spatial decorrelation across rotors, discrete 1-cos gusts, and
// localised obstacle-wake turbulence zones (behind buildings / tree lines).
import { Rng, V3 } from './math';

export interface WindParams {
  speed20ft: number;     // mean wind at 6.1 m, m/s
  directionDeg: number;  // meteorological: direction wind comes FROM, 0 = north
  z0: number;            // roughness length (0.03 grass, 0.5 suburban)
  turbulence: number;    // 0..2 multiplier on Dryden intensity
  gustiness: number;     // gusts per minute (mean)
  gustMax: number;       // m/s peak gust amplitude
}

export const DEFAULT_WIND: WindParams = { speed20ft: 2.5, directionDeg: 240, z0: 0.03, turbulence: 1, gustiness: 2, gustMax: 3 };

export interface WakeZone { x: number; y: number; radius: number; height: number; intensity: number }

const FT = 0.3048;

/** First-order Dryden filters driven by white noise (discretised with exact ZOH where possible). */
class DrydenAxis {
  x1 = 0; x2 = 0;
  constructor(private rng: Rng, private second: boolean) {}
  step(sigma: number, L: number, V: number, dt: number): number {
    const T = L / Math.max(V, 0.5);
    if (!this.second) {
      // H(s) = sigma sqrt(2L/(pi V)) / (1 + T s)  -> OU with variance sigma^2
      const a = Math.exp(-dt / T);
      this.x1 = a * this.x1 + sigma * Math.sqrt(1 - a * a) * this.rng.gauss();
      return this.x1;
    }
    // H(s) ∝ (1 + √3 T s)/(1 + T s)²  =  [√3 + (1 − √3)/(1 + T s)] · 1/(1 + T s)
    // x1: unit-variance OU (the 1/(1+Ts) stage), x2: x1 low-passed again with the same T.
    // y = √3·x1 + (1 − √3)·x2 has variance 2 (Var x2 = Cov(x1,x2) = ½), hence the /√2.
    const a = Math.exp(-dt / T);
    this.x1 = a * this.x1 + Math.sqrt(1 - a * a) * this.rng.gauss();
    this.x2 = a * this.x2 + (1 - a) * this.x1;
    return (sigma * (Math.sqrt(3) * this.x1 + (1 - Math.sqrt(3)) * this.x2)) / Math.SQRT2;
  }
}

export class Wind {
  p: WindParams;
  zones: WakeZone[] = [];
  private rng: Rng;
  private u: DrydenAxis; private v: DrydenAxis; private w: DrydenAxis;
  private turb = { x: 0, y: 0, z: 0 };
  private gust = { t: -1, dur: 0, amp: 0, dirx: 0, diry: 0 };
  private gustTimer = 5;
  private time = 0;
  constructor(p: WindParams = DEFAULT_WIND, seed = 1234) {
    this.p = { ...p };
    this.rng = new Rng(seed);
    this.u = new DrydenAxis(this.rng, false);
    this.v = new DrydenAxis(this.rng, true);
    this.w = new DrydenAxis(this.rng, true);
  }

  meanAt(z: number, o: V3): V3 {
    const p = this.p;
    const zz = Math.max(z, p.z0 * 2 + 0.05);
    const z20 = 20 * FT;
    const k = Math.log(zz / p.z0) / Math.log(z20 / p.z0);
    const s = Math.max(0, p.speed20ft * k);
    // wind blowing TO = from + 180; ENU: north = +y
    const th = ((p.directionDeg + 180) * Math.PI) / 180;
    o.x = s * Math.sin(th); o.y = s * Math.cos(th); o.z = 0;
    return o;
  }

  /** Advance the turbulence state; call once per physics step with vehicle altitude and airspeed. */
  step(dt: number, altitude: number, airspeed: number): void {
    this.time += dt;
    const p = this.p;
    const hft = Math.max(10, altitude / FT);
    const W20 = p.speed20ft / 0.5144; // knots
    const sigW = 0.1 * W20 * 0.5144 * p.turbulence;  // m/s
    const k = 1 / Math.pow(0.177 + 0.000823 * hft, 0.4);
    const sigU = sigW * k;
    const Lw = hft * FT, Lu = (hft / Math.pow(0.177 + 0.000823 * hft, 1.2)) * FT;
    const mean = Math.max(airspeed, p.speed20ft, 1);
    this.turb.x = this.u.step(sigU, Lu, mean, dt);
    this.turb.y = this.v.step(sigU, Lu, mean, dt);
    this.turb.z = this.w.step(sigW, Lw, mean, dt);
    // discrete gusts
    this.gustTimer -= dt;
    if (this.gustTimer <= 0 && p.gustiness > 0) {
      this.gustTimer = (-Math.log(1 - this.rng.next()) * 60) / p.gustiness;
      const th = ((p.directionDeg + 180 + (this.rng.next() - 0.5) * 60) * Math.PI) / 180;
      this.gust = { t: 0, dur: 1 + this.rng.next() * 3, amp: p.gustMax * (0.3 + 0.7 * this.rng.next()), dirx: Math.sin(th), diry: Math.cos(th) };
    }
    if (this.gust.t >= 0) { this.gust.t += dt; if (this.gust.t > this.gust.dur) this.gust.t = -1; }
  }

  /** Total wind velocity at a world point (ENU). Turbulence decorrelates spatially via phase offset. */
  at(pos: V3, o: V3): V3 {
    this.meanAt(pos.z, o);
    const g = this.gust;
    if (g.t >= 0) {
      const m = 0.5 * g.amp * (1 - Math.cos((2 * Math.PI * g.t) / g.dur));
      o.x += m * g.dirx; o.y += m * g.diry;
    }
    // small spatial variation between rotors (~0.1 m apart): adds coherent + local part
    const sp = Math.sin(pos.x * 3.1 + this.time * 7.3) * Math.cos(pos.y * 2.7 - this.time * 5.1);
    let zf = 1;
    for (const zn of this.zones) {
      const dx = pos.x - zn.x, dy = pos.y - zn.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < zn.radius * zn.radius && pos.z < zn.height) zf += zn.intensity * (1 - Math.sqrt(d2) / zn.radius);
    }
    o.x += this.turb.x * zf * (1 + 0.08 * sp);
    o.y += this.turb.y * zf * (1 - 0.08 * sp);
    o.z += this.turb.z * zf * (1 + 0.1 * sp);
    return o;
  }
}
