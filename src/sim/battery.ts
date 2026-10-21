// Lithium pack: per series cell a Thevenin equivalent circuit (R0 + three RC branches: charge
// transfer ~50 ms, polarisation ~2.5 s, diffusion ~60 s), OCV(SoC) monotone-cubic tables, Arrhenius
// temperature dependence of resistance, SoC-dependent resistance rise, cold-capacity derating,
// irreversible damage when overheated, lumped thermal model. Cells are balanced at full charge but
// not identical: capacity and resistance scatter (seeded per build), so the weakest cell sags and
// empties first, as on a real pack.
import { monotoneCubic, Rng } from './math';

export type Chemistry = 'LiPo' | 'LiHV' | 'LiIon';

const SOC = [0, 5, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
// Resting open-circuit voltage per cell (discharge branch), V.
const OCV_TABLES: Record<Chemistry, number[]> = {
  LiPo: [3.27, 3.61, 3.69, 3.73, 3.77, 3.80, 3.84, 3.87, 3.95, 4.02, 4.11, 4.20],
  LiHV: [3.30, 3.60, 3.69, 3.75, 3.79, 3.83, 3.88, 3.95, 4.03, 4.13, 4.24, 4.35],
  LiIon: [2.70, 3.20, 3.35, 3.48, 3.55, 3.62, 3.70, 3.79, 3.88, 3.98, 4.08, 4.20],
};
const OCV_FN: Record<Chemistry, (soc: number) => number> = {
  LiPo: monotoneCubic(SOC, OCV_TABLES.LiPo),
  LiHV: monotoneCubic(SOC, OCV_TABLES.LiHV),
  LiIon: monotoneCubic(SOC, OCV_TABLES.LiIon),
};
/** Past "0 %" a pack still delivers a little charge while its voltage collapses toward the cut-off. */
export const OVERDISCHARGE = 0.1;
const DEAD_CELL_V: Record<Chemistry, number> = { LiPo: 2.6, LiHV: 2.6, LiIon: 2.2 };
export const ocvPerCell = (chem: Chemistry, socFrac: number) => {
  if (socFrac >= 0) return OCV_FN[chem](Math.min(1, socFrac) * 100);
  const v0 = OCV_FN[chem](0), x = Math.min(1, -socFrac / OVERDISCHARGE);
  return v0 - (v0 - DEAD_CELL_V[chem]) * Math.pow(x, 1.5);
};
export const FULL_CELL_V: Record<Chemistry, number> = { LiPo: 4.2, LiHV: 4.35, LiIon: 4.2 };
export const OCV_TABLE = { soc: SOC, ...OCV_TABLES };

/**
 * Charge a cold cell cannot deliver before its voltage collapses (fraction of capacity): ≈ −15 % at
 * 0 °C, −30 % at −20 °C for LiPo / Li-ion (slow solid-state diffusion; e.g. Jaguemont et al. 2016,
 * "A comprehensive review of lithium-ion batteries used in hybrid and electric vehicles at cold
 * temperatures"). The charge is not lost: it comes back as the pack warms up.
 */
export const coldUnavailable = (tempC: number) => Math.min(0.45, Math.max(0, 0.0075 * (20 - tempC)));

export interface BatteryParams {
  chemistry: Chemistry;
  cellsSeries: number;
  cellsParallel: number;
  capacityAh: number;        // per parallel group total (pack capacity)
  r0CellOhm: number;         // DCIR per cell @25 °C, mid SoC (what a charger reports)
  r1CellOhm: number; tau1S: number; // polarisation
  r2CellOhm: number; tau2S: number; // slow (diffusion) polarisation
  /** Ohmic share of r0 (the rest is the fast charge-transfer branch). Default 0.7. */
  ohmicFrac?: number;
  /** Fast charge-transfer / double-layer branch time constant (s). Default 0.05. */
  tauFastS?: number;
  massKg: number;
  heatCapJPerKgK: number;    // ~1050
  hAWPerK: number;           // convective conductance, rises with airflow
  activationEnergyJmol: number; // Arrhenius for resistance, ~28 kJ/mol
  wiringOhm: number;         // XT60 + leads + pigtail
  ageFactor: number;         // 1 = new; resistance multiplier & capacity divisor
  /** Cell-to-cell scatter of capacity and resistance (fraction, uniform ±). Default 0.05. */
  cellSpread?: number;
  /** Seed for the cell scatter (per build). */
  seed?: number;
}

export interface BatteryState {
  soc: number;        // 0..1, mean of the cells (down to -OVERDISCHARGE: an over-discharged, collapsing pack)
  cellSoc: number[];  // per series cell
  cellV: number[];    // per series cell terminal voltage (V)
  vf: number[]; v1: number[]; v2: number[]; // RC branch voltages per series cell
  tempC: number;
  mAhDrawn: number;
  whDrawn: number;
  current: number;    // last pack current (A, + = discharge)
  voltage: number;    // last terminal voltage at the ESC (V)
  ocvPack: number;
  sagV: number;
  /** Irreversible resistance rise from overheating (0 = undamaged; 0.3 = +30 % IR). */
  heatDamage: number;
}

const RG = 8.314;
// LiPo pouch cells degrade quickly above ~60-70 °C (SEI growth, electrolyte decomposition, gassing:
// the pack puffs and its IR rises for good): here +0.05 %/s of IR per K above 70 °C (+30 % after a
// minute at 80 °C; est.).
const DAMAGE_C = 70, DAMAGE_PER_KS = 0.0005;

export class Battery {
  p: BatteryParams;
  s: BatteryState;
  private capF: number[] = []; // per-cell capacity factor
  private resF: number[] = []; // per-cell resistance factor
  constructor(p: BatteryParams, soc = 1, ambientC = 20) {
    this.p = p;
    const n = p.cellsSeries, sp = p.cellSpread ?? 0.05, rng = new Rng(((p.seed ?? 0) ^ 0xba77e2) >>> 0);
    for (let k = 0; k < n; k++) { this.capF.push(1 + sp * (2 * rng.next() - 1)); this.resF.push(1 + sp * (2 * rng.next() - 1)); }
    const z = () => new Array<number>(n).fill(0);
    this.s = { soc, cellSoc: new Array<number>(n).fill(soc), cellV: z(), vf: z(), v1: z(), v2: z(), tempC: ambientC, mAhDrawn: 0, whDrawn: 0, current: 0, voltage: 0, ocvPack: 0, sagV: 0, heatDamage: 0 };
    this.s.ocvPack = this.ocv();
    this.s.voltage = this.s.ocvPack;
    for (let k = 0; k < n; k++) this.s.cellV[k] = this.cellOcv(k);
  }

  /** State of charge cell k behaves at: a cold cell runs out early (coldUnavailable). */
  private usableSoc(soc: number): number { const u = coldUnavailable(this.s.tempC); return (soc - u) / (1 - u); }
  /** OCV of series cell k at the state of charge it can reach at the present temperature. */
  private cellOcv(k: number): number { return ocvPerCell(this.p.chemistry, this.usableSoc(this.s.cellSoc[k])); }
  ocv(): number { let v = 0; for (let k = 0; k < this.p.cellsSeries; k++) v += this.cellOcv(k); return v; }

  /** Resistance multiplier from temperature (Arrhenius), age and heat damage (common to all cells). */
  private packFactor(): number {
    const T = this.s.tempC + 273.15;
    return Math.exp((this.p.activationEnergyJmol / RG) * (1 / T - 1 / 298.15)) * this.p.ageFactor * (1 + this.s.heatDamage);
  }
  /** Resistance multiplier of cell k (k < 0: the pack mean) incl. its scatter and low-SoC rise. */
  rFactor(k = -1, pack = this.packFactor()): number {
    // DCIR rises gradually below ~30 % and steeply once the cell is over-discharged: the voltage
    // collapses under load, which is what forces a landing (or ends in a cut-out)
    const soc = this.usableSoc(k < 0 ? this.s.soc : this.s.cellSoc[k]);
    const low = Math.min(1, Math.max(0, 0.3 - soc) / 0.3);
    const over = Math.min(1, Math.max(0, -soc) / OVERDISCHARGE);
    return pack * (1 + 1.2 * low * low + 6 * over * over) * (k < 0 ? 1 : this.resF[k]);
  }

  /** Thevenin source seen by the load: V = vth - rth * I. */
  thevenin(): { vth: number; rth: number } {
    const n = this.p.cellsSeries, m = this.p.cellsParallel, s = this.s, r0 = this.p.r0CellOhm * (this.p.ohmicFrac ?? 0.7), pf = this.packFactor();
    let vth = 0, rth = this.p.wiringOhm;
    for (let k = 0; k < n; k++) { vth += this.cellOcv(k) - s.vf[k] - s.v1[k] - s.v2[k]; rth += (r0 * this.rFactor(k, pf)) / m; }
    return { vth, rth };
  }

  /** Advance with pack current I (A, + discharge) over dt seconds. */
  step(I: number, dt: number, ambientC: number, airspeed: number): void {
    const p = this.p, s = this.s, m = p.cellsParallel, n = p.cellsSeries;
    const iCell = I / m;
    const fo = p.ohmicFrac ?? 0.7;
    // exact discretisation of the RC branches
    const af = Math.exp(-dt / (p.tauFastS ?? 0.05)), a1 = Math.exp(-dt / p.tau1S), a2 = Math.exp(-dt / p.tau2S);
    const capAh = p.capacityAh / p.ageFactor;
    let qGen = I * I * p.wiringOhm * 0.5, socSum = 0, ocvSum = 0, vSum = 0;
    const pf = this.packFactor();
    for (let k = 0; k < n; k++) {
      const rf = this.rFactor(k, pf);
      const r0 = p.r0CellOhm * fo * rf, rfst = p.r0CellOhm * (1 - fo) * rf, r1 = p.r1CellOhm * rf, r2 = p.r2CellOhm * rf;
      s.vf[k] = s.vf[k] * af + rfst * iCell * (1 - af);
      s.v1[k] = s.v1[k] * a1 + r1 * iCell * (1 - a1);
      s.v2[k] = s.v2[k] * a2 + r2 * iCell * (1 - a2);
      s.cellSoc[k] -= (I * dt) / 3600 / (capAh * this.capF[k]);
      if (s.cellSoc[k] < -OVERDISCHARGE) s.cellSoc[k] = -OVERDISCHARGE;
      const ocv = this.cellOcv(k);
      s.cellV[k] = ocv - s.vf[k] - s.v1[k] - s.v2[k] - r0 * iCell;
      // heat: ohmic + polarisation losses in all cells of this series group
      qGen += m * (iCell * iCell * r0 + (s.vf[k] + s.v1[k] + s.v2[k]) * iCell);
      socSum += s.cellSoc[k]; ocvSum += ocv; vSum += s.cellV[k];
    }
    s.soc = socSum / n;
    s.mAhDrawn += (I * dt) / 3.6;
    s.voltage = vSum - I * p.wiringOhm;
    s.whDrawn += (s.voltage * I * dt) / 3600;
    s.current = I;
    s.ocvPack = ocvSum;
    s.sagV = s.ocvPack - s.voltage;
    const hA = p.hAWPerK * (1 + 0.12 * Math.min(airspeed, 40));
    s.tempC += ((qGen - hA * (s.tempC - ambientC)) / (p.massKg * p.heatCapJPerKgK)) * dt;
    if (s.tempC > DAMAGE_C) s.heatDamage += (s.tempC - DAMAGE_C) * DAMAGE_PER_KS * dt;
  }

  cellVoltage(): number { return this.s.voltage / this.p.cellsSeries; }
  /** Lowest cell's terminal voltage (what a per-cell checker / smart BMS would warn on). */
  minCellVoltage(): number { return Math.min(...this.s.cellV); }
}

/** Build battery params from catalogue-style specs. */
export function batteryFromSpec(spec: {
  chemistry: Chemistry; cells: number; parallel?: number; capacityMah: number; cRating: number;
  irPerCellMohm?: number; massG: number; ageFactor?: number; wiringMohm?: number; seed?: number;
}): BatteryParams {
  // If the IR isn't given, estimate from capacity and (heavily marketing-inflated) C rating:
  // real sustained rating ~ 0.4 * label; DCIR ~ (0.18 V allowed drop) / (sustained current per cell)
  const sustainedA = (spec.capacityMah / 1000) * spec.cRating * 0.4;
  const r0 = spec.irPerCellMohm != null ? spec.irPerCellMohm / 1000 : Math.max(0.0015, 0.16 / sustainedA);
  return {
    chemistry: spec.chemistry,
    cellsSeries: spec.cells,
    cellsParallel: spec.parallel ?? 1,
    capacityAh: spec.capacityMah / 1000,
    // a charger's DCIR = ohmic (~70 %) + charge-transfer (~30 %, τ ≈ 50 ms): a pulse first drops by
    // the ohmic part, sags a little more within ~0.1 s and recovers just as fast when released
    r0CellOhm: r0, ohmicFrac: 0.7, tauFastS: 0.05,
    r1CellOhm: r0 * 0.4, tau1S: 2.5,
    r2CellOhm: r0 * 1.1, tau2S: 60,
    massKg: spec.massG / 1000,
    heatCapJPerKgK: spec.chemistry === 'LiIon' ? 900 : 1050,
    hAWPerK: 0.35,
    activationEnergyJmol: 28000,
    wiringOhm: (spec.wiringMohm ?? 2.5) / 1000,
    ageFactor: spec.ageFactor ?? 1,
    cellSpread: 0.05, seed: spec.seed,
  };
}
