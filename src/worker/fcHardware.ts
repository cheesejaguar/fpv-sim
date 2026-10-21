// Imperfections of the simulated flight-controller hardware, applied only to what Betaflight reads:
// barometer noise and prop-wash pressure error, current-sensor offset / scale error, and the brownout
// of a 1S board whose regulator drops out when the pack sags.

/** Small deterministic PRNG (xorshift32) + Gaussian. */
export class Rand {
  private s: number;
  constructor(seed: number) { this.s = (seed >>> 0) || 0x9e3779b9; }
  next(): number { let x = this.s; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; this.s = x >>> 0; return (this.s + 0.5) / 4294967296; }
  gauss(): number { return Math.sqrt(-2 * Math.log(this.next())) * Math.cos(2 * Math.PI * this.next()); }
  /** uniform in [-1, 1) */
  sym(): number { return this.next() * 2 - 1; }
}

/** FNV-1a of a string: per-build seeds (the same drone keeps the same sensor errors). */
export function seedOf(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * Barometer as the FC sees it: white noise (~0.3 m sigma at sea-level density) plus prop wash.
 * The downwash raises the static pressure around the frame by a fraction of the disk loading T/A;
 * near the ground the wash spreads under the quad and the overpressure grows, so the baro reads the
 * quad lower than it is during take-off and landing (ArduPilot's "ground effect" compensation
 * exists for exactly this).
 */
export class BaroModel {
  private rng: Rand;
  noiseM = 0.3;
  /** share of the disk loading seen as static overpressure in free air / right at the ground */
  washFree = 0.01; washGround = 0.06;
  constructor(seed = 0xba50) { this.rng = new Rand(seed); }
  /** truePa: static pressure at the quad; aglM: height above ground; thrustN: total rotor thrust;
   *  diskM2: total rotor disk area; rotorR: rotor radius (sets how far the ground effect reaches) */
  read(truePa: number, rho: number, aglM: number, thrustN: number, diskM2: number, rotorR: number): number {
    const loading = diskM2 > 0 ? Math.max(0, thrustN) / diskM2 : 0;
    const reach = Math.max(0.15, 6 * rotorR);
    const wash = loading * (this.washFree + this.washGround * Math.exp(-Math.max(0, aglM) / reach));
    return truePa + wash + this.noiseM * rho * 9.80665 * this.rng.gauss();
  }
}

/**
 * Current sensor with a per-build zero offset (±1 A) and scale error (±10 %), like an uncalibrated
 * ESC current sensor. mAh is integrated from the erroneous reading (as Betaflight would).
 */
export class CurrentSensor {
  readonly offsetA: number; readonly scale: number;
  mah = 0;
  constructor(seed: number) {
    const r = new Rand(seed);
    r.next();
    this.offsetA = r.sym() * 1.0;
    this.scale = 1 + r.sym() * 0.1;
  }
  read(trueA: number): number { return Math.max(0, trueA * this.scale + this.offsetA); }
  /** advance the mAh counter by dt seconds at the given true current; returns the reading */
  step(trueA: number, dt: number): number { const i = this.read(trueA); this.mah += (i * dt) / 3.6; return i; }
  reset(): void { this.mah = 0; }
}

/**
 * A 1S AIO board runs its MCU from the pack: below ~2.8 V per cell for more than ~30 ms its
 * regulator drops out and the FC resets. It boots again once the (now unloaded) pack recovers.
 */
export class Brownout {
  private lowS = 0; private okS = 0;
  off = false;
  constructor(public downV = 2.8, public holdS = 0.03, public upV = 3.0, public upHoldS = 0.05) {}
  /** 'down' when the FC loses power, 'up' when it powers back on, else null */
  update(cellV: number, dt: number): 'down' | 'up' | null {
    if (!this.off) {
      this.lowS = cellV < this.downV ? this.lowS + dt : 0;
      if (this.lowS > this.holdS) { this.off = true; this.lowS = 0; this.okS = 0; return 'down'; }
      return null;
    }
    this.okS = cellV >= this.upV ? this.okS + dt : 0;
    if (this.okS >= this.upHoldS) { this.off = false; this.okS = 0; return 'up'; }
    return null;
  }
  reset(): void { this.off = false; this.lowS = 0; this.okS = 0; }
}

/**
 * Lowers the physics rate when the machine can't keep real time: achieved capacity below 0.85 x
 * the wanted time scale for 3 s steps 8000 -> 4000 -> 2000 Hz.
 */
export class OverloadGovernor {
  private lowS = 0;
  constructor(public threshold = 0.85, public holdS = 3, public floorHz = 2000) {}
  /** capacity: real-time factor the sim could sustain; returns the new rate, or null to keep it */
  update(capacity: number, timeScale: number, wallDtS: number, hz: number, enabled: boolean): number | null {
    if (!enabled || hz <= this.floorHz) { this.lowS = 0; return null; }
    this.lowS = capacity < this.threshold * timeScale ? this.lowS + wallDtS : 0;
    if (this.lowS < this.holdS) return null;
    this.lowS = 0;
    return Math.max(this.floorHz, hz > 4000 ? 4000 : 2000);
  }
  reset(): void { this.lowS = 0; }
}
