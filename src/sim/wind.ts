// Atmospheric wind: log-law mean wind with direction, Dryden low-altitude turbulence
// (MIL-HDBK-1797) driven by airspeed and height above the surface below, rotor-scale gust gradients
// (frozen-field / Taylor derivatives + the MIL-HDBK-1797 spanwise roll gust) so turbulence rocks the
// attitude and not just the CG, discrete 1-cos gusts, directional obstacle wakes (shelter, lee
// downdraft, roof-edge updraft, local turbulence at the obstacle's scale) and indoor volumes.
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

/**
 * An obstacle that sheds a wake: footprint centre (x, y), footprint radius and height (m), turbulence
 * intensity (1 ≈ a typical building). The wake is laid out downwind of it for the current wind direction.
 */
export interface WakeZone { x: number; y: number; radius: number; height: number; intensity: number }
/** Enclosed space (axis-aligned box): wind inside is scaled by `scale` (0.1 = a building with open windows). */
export interface WindVolume { min: V3; max: V3; scale: number }

const FT = 0.3048;
const sstep = (a: number, b: number, x: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** First-order Dryden filters driven by white noise (discretised with exact ZOH where possible). */
class DrydenAxis {
  x1 = 0; x2 = 0;
  private kDt = NaN; private kT = NaN; private a = 0; private sq = 0; // exp(-dt/T), sqrt(1 - a²) for the last (dt, T)
  constructor(private rng: Rng, private second: boolean) {}
  step(sigma: number, L: number, V: number, dt: number): number {
    const T = L / Math.max(V, 0.5);
    if (dt !== this.kDt || T !== this.kT) { this.kDt = dt; this.kT = T; this.a = Math.exp(-dt / T); this.sq = Math.sqrt(1 - this.a * this.a); }
    const a = this.a;
    if (!this.second) {
      // H(s) = sigma sqrt(2L/(pi V)) / (1 + T s)  -> OU with variance sigma^2
      this.x1 = a * this.x1 + sigma * this.sq * this.rng.gauss();
      return this.x1;
    }
    // H(s) ∝ (1 + √3 T s)/(1 + T s)²  =  [√3 + (1 − √3)/(1 + T s)] · 1/(1 + T s)
    // x1: unit-variance OU (the 1/(1+Ts) stage), x2: x1 low-passed again with the same T.
    // y = √3·x1 + (1 − √3)·x2 has variance 2 (Var x2 = Cov(x1,x2) = ½), hence the /√2.
    this.x1 = a * this.x1 + this.sq * this.rng.gauss();
    this.x2 = a * this.x2 + (1 - a) * this.x1;
    return (sigma * (Math.sqrt(3) * this.x1 + (1 - Math.sqrt(3)) * this.x2)) / Math.SQRT2;
  }
}

export class Wind {
  p: WindParams;
  zones: WakeZone[] = [];
  indoor: WindVolume[] = [];
  /** Vehicle span b (m) for the rotor-scale gust filters. */
  span = 0.25;
  private rng: Rng;
  private rng2: Rng; // rotor-scale + wake turbulence (keeps the Dryden sequence of a seed unchanged)
  private u: DrydenAxis; private v: DrydenAxis; private w: DrydenAxis;
  private turb = { x: 0, y: 0, z: 0 };
  private gust = { t: -1, dur: 0, amp: 0, dirx: 0, diry: 0 };
  private gustTimer = 5;
  private time = 0;
  // rotor-scale gradients: low-passed Dryden components (τ = 4b/πV), spanwise roll gust p_g, air direction
  private lp = { x: 0, y: 0, z: 0 }; private pg = 0;
  private grad = { u: 0, v: 0, w: 0, V: 1, ex: 1, ey: 0, ez: 0, cx: 0, cy: 1 };
  private localScale = 1;
  // wake-zone turbulence: unit-variance OU per zone and axis, stepped at 1 kHz
  private zt: Float64Array = new Float64Array(0);
  private zTimer = 0;
  private zMean = { x: 0, y: 0, z: 0 };
  // exact memos of what only changes with the parameters or the height (asked for every step)
  private mZ0 = NaN; private mLnRef = 0; private mDir = NaN; private mSin = 0; private mCos = 0; // meanAt: ln(z20/z0), direction
  private hHft = NaN; private hK = 0; private hLu = 0; private hLw = 0; private hLw3 = 0; // Dryden scales per height
  private bSpan = NaN; private bPow = 0; // (π/4b)^(1/6)
  private gDt = NaN; private gTau = NaN; private gA = 0; private gSq = 0; private gSqP = 0; // gradient filter per (dt, tau)
  constructor(p: WindParams = DEFAULT_WIND, seed = 1234) {
    this.p = { ...p };
    this.rng = new Rng(seed);
    this.rng2 = new Rng(seed ^ 0x5bd1e995);
    this.u = new DrydenAxis(this.rng, false);
    this.v = new DrydenAxis(this.rng, true);
    this.w = new DrydenAxis(this.rng, true);
  }

  /** Mean (log-law) wind at height z above the surface below (ground or roof). */
  meanAt(z: number, o: V3): V3 {
    const p = this.p;
    const zz = Math.max(z, p.z0 * 2 + 0.05);
    if (p.z0 !== this.mZ0) { this.mZ0 = p.z0; this.mLnRef = Math.log((20 * FT) / p.z0); } // (z20 = 20 ft)
    this.direction();
    const k = Math.log(zz / p.z0) / this.mLnRef;
    const s = Math.max(0, p.speed20ft * k);
    o.x = s * this.mSin; o.y = s * this.mCos; o.z = 0;
    return o;
  }
  /** sin / cos of the direction the wind blows TO (from + 180°; ENU: north = +y), for the current p.directionDeg */
  private direction() {
    const d = this.p.directionDeg;
    if (d === this.mDir) return;
    const th = ((d + 180) * Math.PI) / 180;
    this.mDir = d; this.mSin = Math.sin(th); this.mCos = Math.cos(th);
  }

  /**
   * Advance the turbulence state; call once per physics step with the height above the surface below
   * and the airspeed (air relative to the vehicle). airDir: unit direction the air flows past the
   * vehicle (world), which orients the frozen-field gradients; defaults to the mean wind direction.
   */
  step(dt: number, altitude: number, airspeed: number, airDir?: V3): void {
    this.time += dt;
    const p = this.p;
    const hft = Math.max(10, altitude / FT);
    const W20 = p.speed20ft / 0.5144; // knots
    const sigW = 0.1 * W20 * 0.5144 * p.turbulence;  // m/s
    if (hft !== this.hHft) {
      this.hHft = hft;
      this.hK = 1 / Math.pow(0.177 + 0.000823 * hft, 0.4);
      this.hLw = hft * FT; this.hLu = (hft / Math.pow(0.177 + 0.000823 * hft, 1.2)) * FT;
      this.hLw3 = Math.pow(this.hLw, 1 / 3);
    }
    const k = this.hK;
    const sigU = sigW * k;
    const Lw = this.hLw, Lu = this.hLu;
    const mean = Math.max(airspeed, 1);
    this.turb.x = this.u.step(sigU, Lu, mean, dt);
    this.turb.y = this.v.step(sigU, Lu, mean, dt);
    this.turb.z = this.w.step(sigW, Lw, mean, dt);
    // rotor-scale gradients. Frozen field swept past at V: a point dl downstream sees the CG's past,
    // Δf ≈ −ḟ·dl/V; ḟ is taken through MIL-HDBK-1797's 1/(1 + 4b s/πV) (q_g, r_g) so the 1st-order u
    // channel does not leak white noise. Spanwise: p_g (roll gust) as a vertical-gust gradient.
    const V = mean, b = this.span, tau = (4 * b) / (Math.PI * V);
    if (dt !== this.gDt || tau !== this.gTau) { this.gDt = dt; this.gTau = tau; this.gA = Math.exp(-dt / tau); this.gSq = Math.sqrt(1 - this.gA * this.gA); this.gSqP = Math.sqrt(Math.PI / (2 * tau)); }
    if (b !== this.bSpan) { this.bSpan = b; this.bPow = Math.pow(Math.PI / (4 * b), 1 / 6); }
    const a = this.gA, g = this.grad, lp = this.lp;
    lp.x = a * lp.x + (1 - a) * this.turb.x; lp.y = a * lp.y + (1 - a) * this.turb.y; lp.z = a * lp.z + (1 - a) * this.turb.z;
    g.u = (this.turb.x - lp.x) / (tau * V); g.v = (this.turb.y - lp.y) / (tau * V); g.w = (this.turb.z - lp.z) / (tau * V);
    // p_g: H = σw·√(0.8/V)·(π/4b)^(1/6) / (Lw^(1/3)·(1 + τs)) → OU with variance K²·π/(2τ)
    const Kp = (sigW * Math.sqrt(0.8 / V) * this.bPow) / this.hLw3;
    const sigP = Kp * this.gSqP;
    this.pg = a * this.pg + sigP * this.gSq * this.rng2.gauss();
    g.V = V;
    let ex: number, ey: number, ez: number;
    if (airDir) { ex = airDir.x; ey = airDir.y; ez = airDir.z; }
    else { this.direction(); ex = this.mSin; ey = this.mCos; ez = 0; }
    g.ex = ex; g.ey = ey; g.ez = ez;
    const hl = Math.hypot(ex, ey);
    if (hl > 1e-3) { g.cx = -ey / hl; g.cy = ex / hl; } else { g.cx = 1; g.cy = 0; }
    // discrete gusts (none in calm air)
    this.gustTimer -= dt;
    if (this.gustTimer <= 0 && p.gustiness > 0 && p.speed20ft > 0) {
      this.gustTimer = (-Math.log(1 - this.rng.next()) * 60) / p.gustiness;
      const th = ((p.directionDeg + 180 + (this.rng.next() - 0.5) * 60) * Math.PI) / 180;
      this.gust = { t: 0, dur: 1 + this.rng.next() * 3, amp: p.gustMax * (0.3 + 0.7 * this.rng.next()), dirx: Math.sin(th), diry: Math.cos(th) };
    }
    if (this.gust.t >= 0) { this.gust.t += dt; if (this.gust.t > this.gust.dur) this.gust.t = -1; }
    // wake-zone turbulence (length scale ~ obstacle height / 2), 1 kHz is plenty for L/U >= 0.1 s
    this.zTimer += dt;
    if (this.zones.length && this.zTimer >= 1e-3) {
      if (this.zt.length !== this.zones.length * 3) this.zt = new Float64Array(this.zones.length * 3);
      const zm = this.zMean;
      for (let i = 0; i < this.zones.length; i++) {
        const zn = this.zones[i];
        const UH = Math.hypot(this.meanAt(zn.height, zm).x, zm.y);
        const T = (0.5 * zn.height) / Math.max(airspeed, 0.5 * UH, 0.5);
        const c = Math.exp(-this.zTimer / T), s = Math.sqrt(1 - c * c);
        for (let j = 0; j < 3; j++) this.zt[i * 3 + j] = c * this.zt[i * 3 + j] + s * this.rng2.gauss();
      }
      this.zTimer = 0;
    }
  }

  /**
   * Total wind velocity at a world point (ENU). hAgl: height above the surface below (ground or roof)
   * for the log law; defaults to pos.z (flat ground at 0). Sets the scale used by gradient().
   */
  at(pos: V3, o: V3, hAgl = pos.z): V3 {
    this.meanAt(hAgl, o);
    const g = this.gust;
    if (g.t >= 0) {
      const m = 0.5 * g.amp * (1 - Math.cos((2 * Math.PI * g.t) / g.dur));
      o.x += m * g.dirx; o.y += m * g.diry;
    }
    o.x += this.turb.x; o.y += this.turb.y; o.z += this.turb.z;
    if (this.zones.length) this.wakes(pos, o);
    let sc = 1;
    for (const v of this.indoor) {
      if (pos.x > v.min.x && pos.x < v.max.x && pos.y > v.min.y && pos.y < v.max.y && pos.z > v.min.z && pos.z < v.max.z) sc = Math.min(sc, v.scale);
    }
    this.localScale = sc;
    if (sc < 1) { o.x *= sc; o.y *= sc; o.z *= sc; }
    return o;
  }

  /** Rotor-scale wind difference at world offset `off` from the point last passed to at() (adds to o). */
  gradient(off: V3, o: V3): V3 {
    const g = this.grad, sc = this.localScale;
    const dl = off.x * g.ex + off.y * g.ey + off.z * g.ez, dc = off.x * g.cx + off.y * g.cy;
    // frozen field: each component lags by dl/V downstream; p_g tilts the vertical gust across the flow
    o.x -= sc * g.u * dl; o.y -= sc * g.v * dl;
    o.z += sc * (this.pg * dc - g.w * dl);
    return o;
  }

  /** Directional obstacle wakes: shelter + local turbulence downwind, lee downdraft, roof-edge updraft. */
  private wakes(pos: V3, o: V3): void {
    this.direction();
    const ex = this.mSin, ey = this.mCos;
    let shelter = 0, wz = 0, tx = 0, ty = 0, tz = 0;
    const zm = this.zMean;
    for (let i = 0; i < this.zones.length; i++) {
      const zn = this.zones[i], R = zn.radius, H = zn.height;
      const rx = pos.x - zn.x, ry = pos.y - zn.y;
      const along = rx * ex + ry * ey, cross = Math.abs(-rx * ey + ry * ex), h = pos.z;
      const lee = along - R;                            // distance behind the lee face
      if (lee > 9 * H || along < -R - H || cross > R + 2 * H || h > 1.8 * H) continue;
      this.meanAt(H, zm);
      const UH = Math.hypot(zm.x, zm.y);
      if (UH < 0.05) continue;
      const W = R + 0.2 * Math.max(0, lee);             // wake widens slowly downstream
      const fc = 1 - sstep(W, W + 0.5 * H, cross);
      const fh = 1 - sstep(H, 1.6 * H, h);
      // near wake (cavity) from the lee face to ~2H, recovering by ~8H
      const s = sstep(-R, 0, lee) * (1 - sstep(2 * H, 8 * H, lee)) * fc * fh;
      shelter = Math.max(shelter, s);
      // lee downdraft (recirculation over the cavity) and roof-edge separation updraft (windward edge)
      wz -= 0.25 * UH * sstep(-R, 0, lee) * (1 - sstep(0, 2.5 * H, lee)) * fc * (1 - sstep(0.9 * H, 1.4 * H, h));
      const de = Math.hypot(along + R, h - H) / (0.35 * H);
      if (de < 3) wz += 0.5 * UH * Math.exp(-de * de) * (1 - sstep(R, R + 0.3 * H, cross));
      // local turbulence: σ ≈ 0.3·U_H·intensity in the wake, also in the roof shear layer
      const st = 0.3 * UH * zn.intensity * Math.max(s, 0.6 * Math.exp(-de * de));
      if (st > 0 && this.zt.length === this.zones.length * 3) { tx += st * this.zt[i * 3]; ty += st * this.zt[i * 3 + 1]; tz += 0.6 * st * this.zt[i * 3 + 2]; }
    }
    if (shelter > 0) { const k = 1 - 0.6 * shelter; o.x *= k; o.y *= k; }
    o.x += tx; o.y += ty; o.z += wz + tz;
  }
}
