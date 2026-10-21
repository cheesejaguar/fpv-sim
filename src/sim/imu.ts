// MEMS IMU model: frame flex response to vibration, chip anti-alias filter, white noise from the
// datasheet noise density, bias instability (random walk), turn-on bias, scale-factor and
// cross-axis errors, full-scale saturation and LSB quantisation. Output is in the units the
// Betaflight SITL bridge expects (rad/s and m/s² specific force, body FLU), quantised to the
// chip's LSB so the firmware sees realistic integer-step data.
import { Rng, V3 } from './math';
import { G0 } from './atmosphere';

export interface GyroChip {
  name: string;
  gyroNoiseDps: number;    // noise density, °/s/√Hz
  accNoiseUg: number;      // µg/√Hz
  sampleRateHz: number;    // native ODR used by Betaflight
  aafHz: number;           // on-chip anti-alias / DLPF cutoff at BF default config
  gyroBiasWalk: number;    // rad/s/√s
  turnOnBiasDps: number;
}

export const GYRO_CHIPS: Record<string, GyroChip> = {
  ICM42688P: { name: 'TDK ICM-42688-P', gyroNoiseDps: 0.0028, accNoiseUg: 70, sampleRateHz: 8000, aafHz: 258, gyroBiasWalk: 2e-4, turnOnBiasDps: 0.5 },
  // Betaflight's default gyro_hardware_lpf = NORMAL puts the BMI270 in OSR4 mode (accgyro_spi_bmi270.c
  // getBmiOsrMode), whose -3 dB point is ~189 Hz at 3.2 kHz ODR (751 Hz is the chip's "normal" mode)
  BMI270: { name: 'Bosch BMI270', gyroNoiseDps: 0.007, accNoiseUg: 160, sampleRateHz: 3200, aafHz: 189, gyroBiasWalk: 3e-4, turnOnBiasDps: 1.0 },
  MPU6000: { name: 'InvenSense MPU-6000', gyroNoiseDps: 0.005, accNoiseUg: 400, sampleRateHz: 8000, aafHz: 256, gyroBiasWalk: 3e-4, turnOnBiasDps: 1.5 },
};

export interface FlexMode { freqHz: number; zeta: number; gain: number }

/** 2nd-order Butterworth low-pass (bilinear, prewarped). */
class Biquad {
  b0 = 1; b1 = 0; b2 = 0; a1 = 0; a2 = 0; x1 = 0; x2 = 0; y1 = 0; y2 = 0;
  setLowpass(fc: number, fs: number) {
    const k = Math.tan((Math.PI * Math.min(fc, fs * 0.45)) / fs), q = Math.SQRT1_2;
    const n = 1 / (1 + k / q + k * k);
    this.b0 = k * k * n; this.b1 = 2 * this.b0; this.b2 = this.b0;
    this.a1 = 2 * (k * k - 1) * n; this.a2 = (1 - k / q + k * k) * n;
  }
  run(x: number) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y; return y;
  }
}

/** Lightly damped structural mode: θ'' + 2ζω θ' + ω² θ = gain·τ ; outputs θ' (rate). */
class Mode {
  th = 0; w = 0;
  constructor(public m: FlexMode) {}
  step(tau: number, dt: number): number {
    const wn = 2 * Math.PI * this.m.freqHz;
    // semi-implicit (symplectic) Euler
    this.w += (this.m.gain * tau - 2 * this.m.zeta * wn * this.w - wn * wn * this.th) * dt;
    this.th += this.w * dt;
    return this.w;
  }
}

export class Imu {
  chip: GyroChip;
  private rng: Rng;
  private lpG = [new Biquad(), new Biquad(), new Biquad()];
  private lpA = [new Biquad(), new Biquad(), new Biquad()];
  private bias = [0, 0, 0];
  private scale = [1, 1, 1];
  private cross: number[] = [];
  private modes: Mode[];
  private modes2: Mode[];   // second (arm-bending) mode: carries motor harmonics at high rpm
  private accMode: Mode[];
  readonly gyroOut = { x: 0, y: 0, z: 0 };
  readonly accOut = { x: 0, y: 0, z: 0 };
  readonly gyroTrue = { x: 0, y: 0, z: 0 };
  /** Soft-mount isolation 0..1 (1 = hard mount). */
  mountIsolation = 1;
  private fs: number;
  private holdT = 0; // output register updates at the chip's ODR, not the physics rate

  /** Clear filter and structural-mode states (after a reset); calibration errors are kept. */
  resetState(): void {
    for (const b of [...this.lpG, ...this.lpA]) { b.x1 = b.x2 = b.y1 = b.y2 = 0; }
    for (const m of [...this.modes, ...this.modes2, ...this.accMode]) { m.th = 0; m.w = 0; }
    for (let i = 0; i < 3; i++) if (!Number.isFinite(this.bias[i])) this.bias[i] = 0;
  }

  constructor(chip: GyroChip, physicsHz: number, flex: { roll: FlexMode; pitch: FlexMode; yaw: FlexMode }, seed = 42) {
    this.chip = chip;
    this.rng = new Rng(seed);
    this.fs = physicsHz;
    for (const b of this.lpG) b.setLowpass(chip.aafHz, physicsHz);
    for (const b of this.lpA) b.setLowpass(Math.min(chip.aafHz, 500), physicsHz);
    const r = () => (this.rng.next() * 2 - 1);
    const tb = (chip.turnOnBiasDps * Math.PI) / 180;
    this.bias = [r() * tb, r() * tb, r() * tb];
    this.scale = [1 + r() * 0.004, 1 + r() * 0.004, 1 + r() * 0.004];
    this.cross = [r() * 0.008, r() * 0.008, r() * 0.008, r() * 0.008, r() * 0.008, r() * 0.008];
    this.modes = [new Mode(flex.roll), new Mode(flex.pitch), new Mode(flex.yaw)];
    const m2 = (f: FlexMode) => new Mode({ freqHz: f.freqHz * 2.6, zeta: Math.max(0.1, f.zeta * 3), gain: f.gain * 2.2 });
    this.modes2 = [m2(flex.roll), m2(flex.pitch), m2(flex.yaw)];
    this.accMode = [new Mode({ ...flex.roll, gain: 1 }), new Mode({ ...flex.pitch, gain: 1 }), new Mode({ freqHz: flex.roll.freqHz * 1.3, zeta: flex.roll.zeta, gain: 1 })];
  }

  /**
   * omega: true rigid-body rate (body, rad/s); specForce: true specific force (body, m/s²);
   * vibTorque / vibForce: body-frame vibration excitation this step (N·m, N); mass in kg.
   */
  sample(omega: V3, specForce: V3, vibTorque: V3, vibForce: V3, mass: number, dt: number): void {
    const c = this.chip;
    const iso = this.mountIsolation;
    const fx = (this.modes[0].step(vibTorque.x, dt) + this.modes2[0].step(vibTorque.x, dt)) * iso;
    const fy = (this.modes[1].step(vibTorque.y, dt) + this.modes2[1].step(vibTorque.y, dt)) * iso;
    const fz = (this.modes[2].step(vibTorque.z, dt) + this.modes2[2].step(vibTorque.z, dt)) * iso;
    const wx = omega.x + fx, wy = omega.y + fy, wz = omega.z + fz;
    this.gyroTrue.x = omega.x; this.gyroTrue.y = omega.y; this.gyroTrue.z = omega.z;
    // bias random walk
    const bw = c.gyroBiasWalk * Math.sqrt(dt);
    for (let i = 0; i < 3; i++) this.bias[i] += bw * this.rng.gauss();
    const sg = ((c.gyroNoiseDps * Math.PI) / 180) * Math.sqrt(this.fs / 2);
    const cr = this.cross, s = this.scale, b = this.bias;
    let gx = s[0] * wx + cr[0] * wy + cr[1] * wz + b[0] + sg * this.rng.gauss();
    let gy = s[1] * wy + cr[2] * wx + cr[3] * wz + b[1] + sg * this.rng.gauss();
    let gz = s[2] * wz + cr[4] * wx + cr[5] * wy + b[2] + sg * this.rng.gauss();
    gx = this.lpG[0].run(gx); gy = this.lpG[1].run(gy); gz = this.lpG[2].run(gz);
    const lim = (2000 * Math.PI) / 180, lsb = Math.PI / 180 / 16.4;
    const qz = (v: number) => Math.round(Math.max(-lim, Math.min(lim, v)) / lsb) * lsb;
    // a 3.2 kHz chip (BMI270) holds its last sample between data-ready edges: the 8 kHz loop sees
    // a staircase, as Betaflight does reading the real register
    this.holdT += dt;
    const fresh = this.holdT >= 1 / c.sampleRateHz - 1e-9;
    if (fresh) { this.holdT -= 1 / c.sampleRateHz; if (this.holdT > dt) this.holdT = 0; }
    if (fresh || c.sampleRateHz >= this.fs) { this.gyroOut.x = qz(gx); this.gyroOut.y = qz(gy); this.gyroOut.z = qz(gz); }

    // accelerometer: specific force + vibration (rigid + local flex) + noise
    const sa = c.accNoiseUg * 1e-6 * G0 * Math.sqrt(this.fs / 2);
    const am = 1 / Math.max(mass, 0.05);
    const ax = specForce.x + vibForce.x * am + this.accMode[0].step(vibForce.x * am * 40, dt) * iso * 0.02 + sa * this.rng.gauss();
    const ay = specForce.y + vibForce.y * am + this.accMode[1].step(vibForce.y * am * 40, dt) * iso * 0.02 + sa * this.rng.gauss();
    const az = specForce.z + vibForce.z * am + this.accMode[2].step(vibForce.z * am * 40, dt) * iso * 0.02 + sa * this.rng.gauss();
    const alim = 16 * G0, alsb = G0 / 2048;
    const qa = (v: number) => Math.round(Math.max(-alim, Math.min(alim, v)) / alsb) * alsb;
    this.accOut.x = qa(this.lpA[0].run(ax)); this.accOut.y = qa(this.lpA[1].run(ay)); this.accOut.z = qa(this.lpA[2].run(az));
  }
}
