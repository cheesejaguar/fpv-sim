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
  alphaStall: number; // rad
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

export const DEFAULT_AIRFOIL: AirfoilParams = { cl0: 0.38, clAlpha: 5.3, alphaStall: 0.30, cd0: 0.022, cdK: 0.028, clMinDrag: 0.35 };

function airfoil(a: AirfoilParams, alpha: number, out: { cl: number; cd: number }): void {
  let al = alpha;
  while (al > Math.PI) al -= 2 * Math.PI;
  while (al < -Math.PI) al += 2 * Math.PI;
  const clLin = a.cl0 + a.clAlpha * al;
  const cdLin = a.cd0 + a.cdK * (clLin - a.clMinDrag) ** 2;
  const s = Math.sin(al), c = Math.cos(al);
  const clFp = 2 * s * c * 0.95;
  const cdFp = 0.03 + 1.9 * s * s;
  // smooth blend into post-stall flat-plate behaviour (positive and negative stall)
  const aStallNeg = -a.alphaStall - (2 * a.cl0) / a.clAlpha;
  const wPos = 1 / (1 + Math.exp(-(al - a.alphaStall) / 0.06));
  const wNeg = 1 / (1 + Math.exp((al - aStallNeg) / 0.06));
  const w = Math.min(1, wPos + wNeg);
  out.cl = (1 - w) * Math.min(clLin, a.cl0 + a.clAlpha * (a.alphaStall + 0.1)) + w * clFp;
  out.cd = (1 - w) * cdLin + w * Math.max(cdFp, cdLin);
}

export interface BemtResult { T: number; Q: number; H: number; vi: number }

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
    let T = 0, Q = 0, H = 0;
    const up = vc + vi;
    for (let j = 0; j < AZIM; j++) {
      const psi = ((j + 0.5) / AZIM) * 2 * Math.PI;
      const sp = Math.sin(psi);
      for (let k = 0; k < RADIAL; k++) {
        const r = rs[k];
        const ut = omega * r + vip * sp;
        const phi = Math.atan2(up, ut);
        const U2 = ut * ut + up * up;
        airfoil(g.airfoil, th[k] - phi, af);
        // Prandtl tip loss
        const lam = Math.max(0.02, Math.abs(up) / Math.max(1e-3, Math.abs(omega * R)));
        const f = ((B / 2) * (1 - r / R)) / ((r / R) * lam);
        const F = Math.min(1, (2 / Math.PI) * Math.acos(Math.min(1, Math.exp(-f))));
        const qd = 0.5 * rho * U2 * cs[k] * dr;
        const cphi = Math.cos(phi), sphi = Math.sin(phi);
        T += qd * (af.cl * cphi - af.cd * sphi) * F;
        const dFt = qd * (af.cl * sphi + af.cd * cphi);
        Q += dFt * r;
        H += dFt * sp;
      }
    }
    const kb = B / AZIM;
    return { T: T * kb, Q: Q * kb, H: H * kb };
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
  return { T: res.T, Q: res.Q, H: res.H, vi };
}

export interface BemtTable {
  nb: number; ng: number;
  ct: Float32Array; cq: Float32Array; ch: Float32Array; cvi: Float32Array; // cvi = vi / q
  R: number; A: number;
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
    nb: NB, ng: NG, ct, cq, ch, cvi, R, A, ctScale, cqScale,
    tipRef: calib ? ((calib.rpm * 2 * Math.PI) / 60) * R : tipRef,
    kT: ct0 * ctScale * rho * A * R * R,
    kQ: cq0 * cqScale * rho * A * R * R * R,
  };
}

/** Bilinear lookup of (CT, CQ, CH, Cvi) at (beta, gamma); writes out[0..3] (unscaled). */
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
}
