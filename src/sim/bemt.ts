// Blade-element momentum theory for small fixed-pitch propellers in arbitrary (oblique) inflow.
//
// Each blade is split into radial stations; the disc is swept in azimuth so that edgewise flow
// (advancing / retreating blade asymmetry) is resolved. A uniform induced velocity is found by
// matching blade-element thrust with momentum theory: Glauert's formula in forward flight,
// classic momentum in climb / windmill-brake, and Leishman's empirical curve through the
// vortex-ring state where momentum theory has no solution. Prandtl tip loss is applied.
//
// The solver is too expensive for 8 kHz x 4 rotors, so it is evaluated once per propeller into a
// non-dimensional table over (beta, gamma):
//     q = sqrt((OmegaR)^2 + V^2),  beta = atan(|V| / OmegaR) in [0, pi/2],
//     gamma = elevation of the relative wind out of the disc plane (+ = rotor climbing)
// with coefficients C_F = F / (rho A q^2), C_Q = Q / (rho A q^2 R). beta = pi/2 is a stopped rotor.

export interface AirfoilParams {
  cl0: number;        // zero-alpha lift (camber)
  clAlpha: number;    // per rad (low-Re thin section ~ 5.2-5.7)
  clMax: number;      // positive stall CL (low-Re, Re ~ 5e4-1e5: ~1.1-1.3)
  clMin: number;      // negative stall CL
  stallDecay: number; // rad: e-fold of the post-stall lift drop from clMax toward flat-plate
  stallSmooth: number;// CL units: rounding of the lift-curve knee at stall
  cd0: number;
  cdK: number;        // quadratic drag-polar coefficient
  clMinDrag: number;
}

export interface PropGeometry {
  diameterM: number;
  pitchM: number;        // geometric pitch (helix) at 0.75R
  blades: number;
  hubRadiusFrac: number; // ~0.14
  chordFracs: number[];  // chord / R at evenly spaced stations from hub to tip
  washoutDeg: number;    // extra twist reduction toward the tip
  airfoil: AirfoilParams;
}

export const DEFAULT_AIRFOIL: AirfoilParams = { cl0: 0.1, clAlpha: 5.3, clMax: 1.3, clMin: -0.85, stallDecay: 0.4, stallSmooth: 0.06, cd0: 0.022, cdK: 0.028, clMinDrag: 0.35 };

/**
 * Section polar at chord Reynolds number re (DEFAULT_AIRFOIL is for Re ~ 1e5, a 5" prop at 0.75R).
 * Below that the laminar separation bubble thickens: profile drag rises ~ Re^-1/2 and CLmax falls
 * (Selig, Guglielmo et al. low-Re airfoil tests; Brandt & Selig 2011 / Deters, Ananda & Selig 2014
 * for 2.5-5" props: efficiency and the CT(J) slope degrade sharply below Re ~ 5e4). Matters for
 * whoop props (Re ~ 1.5-3e4), whose measured static torque is ~2x a Re-1e5 polar.
 */
export function airfoilAtRe(re: number, base: AirfoilParams = DEFAULT_AIRFOIL): AirfoilParams {
  const r = Math.max(0.15, Math.min(3, re / 1e5));
  return { ...base, cd0: base.cd0 * Math.min(2.4, Math.max(0.75, Math.pow(r, -0.5))), clMax: base.clMax + 0.15 * Math.log10(Math.min(1.5, r)) };
}

/** Smooth min / max (log-sum-exp) with rounding k, stable for widely separated arguments. */
const smin = (x: number, y: number, k: number) => { const m = Math.min(x, y); return m - k * Math.log(Math.exp((m - x) / k) + Math.exp((m - y) / k)); };
const smax = (x: number, y: number, k: number) => -smin(-x, -y, k);

// Low-Reynolds thin cambered section (Re ~ 3e4-1.5e5; cf. Selig/UIUC low-Re airfoil data, and the
// small-prop measurements of Brandt & Selig 2011): linear lift to a modest CLmax ~ 1.2-1.3, then a
// gradual (not abrupt) loss toward flat-plate lift 2 sin a cos a as the separation bubble bursts.
// The lift curve is min(linear, post-stall) with a rounded knee, so the inboard (high-alpha) part
// of a static prop sits just past the knee and progressively unstalls as advance ratio rises, while
// the outboard blade keeps a live lift slope: CT(J) is flat-ish at J = 0 and falls off ~ J^2.
function airfoil(a: AirfoilParams, alpha: number, out: { cl: number; cd: number }): void {
  let al = alpha;
  while (al > Math.PI) al -= 2 * Math.PI;
  while (al < -Math.PI) al += 2 * Math.PI;
  const clLin = a.cl0 + a.clAlpha * al;
  const cdLin = a.cd0 + a.cdK * (clLin - a.clMinDrag) ** 2;
  const s = Math.sin(al), c = Math.cos(al);
  const aS = (a.clMax - a.cl0) / a.clAlpha, aSN = (a.clMin - a.cl0) / a.clAlpha;
  const clFp = 2 * s * c * 0.95, k = a.stallSmooth;
  // (branches skipped where the knee rounding / stall sigmoid is < 1e-4: table build cost)
  let cl = clLin;
  if (clLin > a.clMax - 8 * k) cl = smin(clLin, clFp + (a.clMax - 1.9 * Math.sin(aS) * Math.cos(aS)) * Math.exp(Math.min(30, -(al - aS) / a.stallDecay)), k);
  if (clLin < a.clMin + 8 * k) cl = smax(cl, clFp + (a.clMin - 1.9 * Math.sin(aSN) * Math.cos(aSN)) * Math.exp(Math.min(30, (al - aSN) / a.stallDecay)), k);
  out.cl = cl;
  // drag: attached polar, rising into flat-plate drag through stall
  const w = Math.min(1, (al > aS - 0.5 ? 1 / (1 + Math.exp(-(al - aS) / 0.05)) : 0) + (al < aSN + 0.5 ? 1 / (1 + Math.exp((al - aSN) / 0.05)) : 0));
  out.cd = w > 0 ? (1 - w) * cdLin + w * Math.max(0.03 + 1.9 * s * s, cdLin) : cdLin;
}

/**
 * T thrust, Q torque, H in-plane drag; Ms / Mc first-harmonic hub moments of the rigid blades:
 * Ms = Σ m·sinψ (advancing side lifts more: rolls the disc toward the retreating side) and
 * Mc = −Σ m·cosψ (front of the disc lifts more under the skewed wake: tilts the disc's leading edge
 * up, i.e. blowback), m = blade root flap moment, ψ = 0 downwind.
 */
export interface BemtResult { T: number; Q: number; H: number; vi: number; Ms: number; Mc: number }

const RADIAL = 14, AZIM = 16;

/**
 * Solve one operating point. omega rad/s (>0); vc = axial velocity of the rotor relative to the
 * air along the thrust axis (+ = climbing into clean air); vip = in-plane speed (>= 0).
 */
export function bemtSolve(g: PropGeometry, rho: number, omega: number, vc: number, vip: number): BemtResult {
  const R = g.diameterM / 2;
  const A = Math.PI * R * R;
  const B = g.blades;
  const rh = g.hubRadiusFrac;
  const dr = ((1 - rh) * R) / RADIAL;
  const rs: number[] = [], cs: number[] = [], th: number[] = [];
  const cf = g.chordFracs;
  for (let k = 0; k < RADIAL; k++) {
    const rf = rh + ((1 - rh) * (k + 0.5)) / RADIAL;
    const r = rf * R;
    rs.push(r);
    const u = ((rf - rh) / (1 - rh)) * (cf.length - 1);
    const i0 = Math.min(cf.length - 2, Math.floor(u));
    cs.push((cf[i0] + (cf[i0 + 1] - cf[i0]) * (u - i0)) * R);
    th.push(Math.atan(g.pitchM / (2 * Math.PI * r)) - ((g.washoutDeg * Math.PI) / 180) * (rf - 0.75));
  }
  const af = { cl: 0, cd: 0 };
  const elements = (vi: number) => {
    let T = 0, Q = 0, H = 0, Ms = 0, Mc = 0;
    // Skewed wake in edgewise flow: the induced inflow grows toward the rear of the disc, Glauert /
    // Coleman linear inflow λ(r,ψ) = λ0 (1 + kx (r/R) cosψ), kx = tan(χ/2), χ = wake skew angle
    // (Coleman, Feingold & Stempin 1945, NACA ARR L5E10; Leishman, Principles of Helicopter Aerodynamics)
    const ax = vc + vi, vw = Math.sqrt(vip * vip + ax * ax);
    const kx = vip > 1e-9 ? Math.min(1, vip / Math.max(1e-9, vw + ax)) : 0;
    for (let j = 0; j < AZIM; j++) {
      const psi = ((j + 0.5) / AZIM) * 2 * Math.PI;
      const sp = Math.sin(psi), cp = Math.cos(psi);
      for (let k = 0; k < RADIAL; k++) {
        const r = rs[k];
        const ut = omega * r + vip * sp;
        const up = vc + vi * (1 + kx * (r / R) * cp);
        const phi = Math.atan2(up, ut);
        const U2 = ut * ut + up * up;
        airfoil(g.airfoil, th[k] - phi, af);
        // Prandtl tip loss
        const lam = Math.max(0.02, Math.abs(up) / Math.max(1e-3, Math.abs(omega * R)));
        const f = ((B / 2) * (1 - r / R)) / ((r / R) * lam);
        const F = Math.min(1, (2 / Math.PI) * Math.acos(Math.min(1, Math.exp(-f))));
        const qd = 0.5 * rho * U2 * cs[k] * dr;
        const cphi = Math.cos(phi), sphi = Math.sin(phi);
        const dT = qd * (af.cl * cphi - af.cd * sphi) * F;
        T += dT;
        Ms += dT * r * sp; Mc -= dT * r * cp;
        const dFt = qd * (af.cl * sphi + af.cd * cphi);
        Q += dFt * r;
        H += dFt * sp;
      }
    }
    const kb = B / AZIM;
    return { T: T * kb, Q: Q * kb, H: H * kb, Ms: Ms * kb, Mc: Mc * kb };
  };
  let vi = omega > 1 ? Math.sqrt(Math.max(0.01, elements(0).T) / (2 * rho * A)) : 0;
  let res = elements(vi);
  for (let it = 0; it < 60 && omega > 1; it++) {
    const T = res.T;
    const vh = Math.sign(T || 1) * Math.sqrt(Math.abs(T) / (2 * rho * A));
    let target = 0;
    if (Math.abs(vh) > 1e-4) {
      const x = vc / vh;
      const mu = vip / Math.abs(vh);
      let vAx: number;
      if (x >= 0) vAx = -vc / 2 + Math.sign(vh) * Math.sqrt((vc / 2) ** 2 + vh * vh);
      else if (x > -2) vAx = vh * (1 - 1.125 * x - 1.372 * x * x - 1.718 * x ** 3 - 0.655 * x ** 4);
      else vAx = -vc / 2 - Math.sign(vh) * Math.sqrt(Math.max(0, (vc / 2) ** 2 - vh * vh));
      let vg = vAx;
      for (let n = 0; n < 16; n++) {
        const den = Math.sqrt(vip * vip + (vc + vg) ** 2);
        const nv = (vh * Math.abs(vh)) / Math.max(den, 0.35 * Math.abs(vh));
        vg = 0.5 * vg + 0.5 * nv;
      }
      const w = Math.min(1, mu / 1.5);
      target = (1 - w) * vAx + w * vg;
    }
    const nvi = vi + 0.3 * (target - vi);
    const done = Math.abs(nvi - vi) < 1e-5 * (1 + Math.abs(vi));
    vi = nvi;
    res = elements(vi);
    if (done) break;
  }
  return { T: res.T, Q: res.Q, H: res.H, vi, Ms: res.Ms, Mc: res.Mc };
}

export interface BemtTable {
  nb: number; ng: number;
  ct: Float32Array; cq: Float32Array; ch: Float32Array; cvi: Float32Array; // cvi = vi / q
  /** Rigid-blade hub moment coefficients M / (rho A q² R): advancing-side (cms) and fore-aft (cmc). */
  cms: Float32Array; cmc: Float32Array;
  R: number; A: number;
  /** Blade pitch angle at 0.75R (rad), for the flapping-drag inflow term. */
  theta75: number;
  ctScale: number; cqScale: number;
  /** Reference tip speed (m/s) at which the table was calibrated; used for Reynolds corrections. */
  tipRef: number;
  /** Static constants at rho = 1.225: T = kT w^2, Q = kQ w^2. */
  kT: number; kQ: number;
}

const NB = 34, NG = 31;
const BETA_EXP = 1.7;
const betaOf = (i: number) => Math.pow(i / (NB - 1), BETA_EXP) * (Math.PI / 2);
const gammaOf = (j: number) => -Math.PI / 2 + (j / (NG - 1)) * Math.PI;

export interface PropCalibration { rpm: number; thrustN: number; torqueNm: number }

export function buildBemtTable(g: PropGeometry, calib?: PropCalibration): BemtTable {
  const rho = 1.225;
  const R = g.diameterM / 2, A = Math.PI * R * R;
  const tipRef = 2600 * R; // reference tip speed for Reynolds number (~25k rpm)
  const n = NB * NG;
  const ct = new Float32Array(n), cq = new Float32Array(n), ch = new Float32Array(n), cvi = new Float32Array(n);
  const cms = new Float32Array(n), cmc = new Float32Array(n);
  for (let i = 0; i < NB; i++) {
    const beta = betaOf(i);
    for (let j = 0; j < NG; j++) {
      const gamma = gammaOf(j);
      // choose q so that whichever of (OmegaR, V) dominates sits near the reference speed
      const q = tipRef;
      const omegaR = q * Math.cos(beta);
      const V = q * Math.sin(beta);
      const res = bemtSolve(g, rho, omegaR / R, V * Math.sin(gamma), V * Math.cos(gamma));
      const den = rho * A * q * q;
      const idx = i * NG + j;
      ct[idx] = res.T / den; cq[idx] = res.Q / (den * R); ch[idx] = res.H / den; cvi[idx] = res.vi / q;
      cms[idx] = res.Ms / (den * R); cmc[idx] = res.Mc / (den * R);
    }
  }
  const j0 = (NG - 1) >> 1;
  const ct0 = ct[j0], cq0 = cq[j0];
  let ctScale = 1, cqScale = 1;
  if (calib) {
    const w = (calib.rpm * 2 * Math.PI) / 60;
    ctScale = calib.thrustN / (ct0 * rho * A * (w * R) ** 2);
    cqScale = calib.torqueNm / (cq0 * rho * A * (w * R) ** 2 * R);
  }
  return {
    nb: NB, ng: NG, ct, cq, ch, cvi, cms, cmc, R, A, ctScale, cqScale,
    theta75: Math.atan(g.pitchM / (2 * Math.PI * 0.75 * R)),
    tipRef: calib ? ((calib.rpm * 2 * Math.PI) / 60) * R : tipRef,
    kT: ct0 * ctScale * rho * A * R * R,
    kQ: cq0 * cqScale * rho * A * R * R * R,
  };
}

/** Bilinear lookup of (CT, CQ, CH, Cvi, CMs, CMc) at (beta, gamma); writes out[0..5] (unscaled). */
export function tableLookup(t: BemtTable, beta: number, gamma: number, out: Float64Array): void {
  const bn = Math.max(0, Math.min(1, beta / (Math.PI / 2)));
  const fi = Math.pow(bn, 1 / BETA_EXP) * (t.nb - 1);
  const fj = Math.max(0, Math.min(t.ng - 1, ((gamma + Math.PI / 2) / Math.PI) * (t.ng - 1)));
  const i0 = Math.min(t.nb - 2, Math.floor(fi)), j0 = Math.min(t.ng - 2, Math.floor(fj));
  const u = fi - i0, v = fj - j0;
  const a = i0 * t.ng + j0, b = a + 1, c = a + t.ng, d = c + 1;
  const w00 = (1 - u) * (1 - v), w01 = (1 - u) * v, w10 = u * (1 - v), w11 = u * v;
  out[0] = t.ct[a] * w00 + t.ct[b] * w01 + t.ct[c] * w10 + t.ct[d] * w11;
  out[1] = t.cq[a] * w00 + t.cq[b] * w01 + t.cq[c] * w10 + t.cq[d] * w11;
  out[2] = t.ch[a] * w00 + t.ch[b] * w01 + t.ch[c] * w10 + t.ch[d] * w11;
  out[3] = t.cvi[a] * w00 + t.cvi[b] * w01 + t.cvi[c] * w10 + t.cvi[d] * w11;
  out[4] = t.cms[a] * w00 + t.cms[b] * w01 + t.cms[c] * w10 + t.cms[d] * w11;
  out[5] = t.cmc[a] * w00 + t.cmc[b] * w01 + t.cmc[c] * w10 + t.cmc[d] * w11;
}
