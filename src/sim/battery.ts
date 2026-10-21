// Lithium pack: second-order Thevenin equivalent circuit per cell (R0 + R1||C1 + R2||C2),
// OCV(SoC) monotone-cubic tables, Arrhenius temperature dependence of resistance,
// SoC-dependent resistance rise, lumped thermal model. Cells are assumed balanced.
import { monotoneCubic } from './math';

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
export const ocvPerCell = (chem: Chemistry, socFrac: number) => OCV_FN[chem](Math.max(0, Math.min(1, socFrac)) * 100);
export const FULL_CELL_V: Record<Chemistry, number> = { LiPo: 4.2, LiHV: 4.35, LiIon: 4.2 };
export const OCV_TABLE = { soc: SOC, ...OCV_TABLES };

export interface BatteryParams {
  chemistry: Chemistry;
  cellsSeries: number;
  cellsParallel: number;
  capacityAh: number;        // per parallel group total (pack capacity)
  r0CellOhm: number;         // ohmic DCIR per cell @25 °C, mid SoC
  r1CellOhm: number; tau1S: number; // fast polarisation
  r2CellOhm: number; tau2S: number; // slow (diffusion) polarisation
  massKg: number;
  heatCapJPerKgK: number;    // ~1050
  hAWPerK: number;           // convective conductance, rises with airflow
  activationEnergyJmol: number; // Arrhenius for resistance, ~28 kJ/mol
  wiringOhm: number;         // XT60 + leads + pigtail
  ageFactor: number;         // 1 = new; resistance multiplier & capacity divisor
}

export interface BatteryState {
  soc: number;        // 0..1
  v1: number; v2: number; // polarisation voltages per cell
  tempC: number;
  mAhDrawn: number;
  whDrawn: number;
  current: number;    // last pack current (A, + = discharge)
  voltage: number;    // last terminal voltage at the ESC (V)
  ocvPack: number;
  sagV: number;
}

const RG = 8.314;

export class Battery {
  p: BatteryParams;
  s: BatteryState;
  constructor(p: BatteryParams, soc = 1, ambientC = 20) {
    this.p = p;
    this.s = { soc, v1: 0, v2: 0, tempC: ambientC, mAhDrawn: 0, whDrawn: 0, current: 0, voltage: 0, ocvPack: 0, sagV: 0 };
    this.s.ocvPack = this.ocv();
    this.s.voltage = this.s.ocvPack;
  }
  ocv(): number { return ocvPerCell(this.p.chemistry, this.s.soc) * this.p.cellsSeries; }

  /** Resistance multiplier from temperature (Arrhenius) and low state of charge. */
  rFactor(): number {
    const T = this.s.tempC + 273.15;
    const arr = Math.exp((this.p.activationEnergyJmol / RG) * (1 / T - 1 / 298.15));
    const socRise = this.s.soc < 0.2 ? 1 + 1.0 * (0.2 - this.s.soc) / 0.2 : 1; // up to 2x at empty
    return arr * socRise * this.p.ageFactor;
  }

  /** Thevenin source seen by the load: V = vth - rth * I. */
  thevenin(): { vth: number; rth: number } {
    const n = this.p.cellsSeries, m = this.p.cellsParallel;
    const vth = n * (ocvPerCell(this.p.chemistry, this.s.soc) - this.s.v1 - this.s.v2);
    const rth = (n / m) * this.p.r0CellOhm * this.rFactor() + this.p.wiringOhm;
    return { vth, rth };
  }

  /** Advance with pack current I (A, + discharge) over dt seconds. */
  step(I: number, dt: number, ambientC: number, airspeed: number): void {
    const p = this.p, s = this.s, m = p.cellsParallel, n = p.cellsSeries;
    const rf = this.rFactor();
    const iCell = I / m;
    const r1 = p.r1CellOhm * rf, r2 = p.r2CellOhm * rf;
    // exact discretisation of RC branches
    const a1 = Math.exp(-dt / p.tau1S), a2 = Math.exp(-dt / p.tau2S);
    s.v1 = s.v1 * a1 + r1 * iCell * (1 - a1);
    s.v2 = s.v2 * a2 + r2 * iCell * (1 - a2);
    const capAh = p.capacityAh / p.ageFactor;
    s.soc -= (I * dt) / 3600 / capAh;
    if (s.soc < 0) s.soc = 0;
    s.mAhDrawn += (I * dt) / 3.6;
    const { vth, rth } = this.thevenin();
    s.voltage = vth - rth * I;
    s.whDrawn += (s.voltage * I * dt) / 3600;
    s.current = I;
    s.ocvPack = this.ocv();
    s.sagV = s.ocvPack - s.voltage;
    // heat: ohmic + polarisation losses in all cells
    const r0 = p.r0CellOhm * rf;
    const qGen = n * m * (iCell * iCell * r0 + s.v1 * iCell + s.v2 * iCell) + I * I * p.wiringOhm * 0.5;
    const hA = p.hAWPerK * (1 + 0.12 * Math.min(airspeed, 40));
    s.tempC += ((qGen - hA * (s.tempC - ambientC)) / (p.massKg * p.heatCapJPerKgK)) * dt;
  }

  cellVoltage(): number { return this.s.voltage / this.p.cellsSeries; }
}

/** Build battery params from catalogue-style specs. */
export function batteryFromSpec(spec: {
  chemistry: Chemistry; cells: number; parallel?: number; capacityMah: number; cRating: number;
  irPerCellMohm?: number; massG: number; ageFactor?: number;
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
    r0CellOhm: r0,
    r1CellOhm: r0 * 0.6, tau1S: 2.5,
    r2CellOhm: r0 * 1.1, tau2S: 60,
    massKg: spec.massG / 1000,
    heatCapJPerKgK: spec.chemistry === 'LiIon' ? 900 : 1050,
    hAWPerK: 0.35,
    activationEnergyJmol: 28000,
    wiringOhm: 0.0025,
    ageFactor: spec.ageFactor ?? 1,
  };
}
