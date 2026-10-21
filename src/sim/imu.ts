// MEMS IMU model: frame flex response to vibration, chip anti-alias filter, white noise from the
// datasheet noise density, bias instability (random walk), turn-on bias, scale-factor and
// cross-axis errors, accelerometer offsets, board misalignment, full-scale saturation and LSB
// quantisation. Output is in the units the Betaflight SITL bridge expects (rad/s and m/s² specific
// force, body FLU), quantised to the chip's LSB so the firmware sees realistic integer-step data.
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

/** Damped structural mode: θ'' + 2ζω θ' + ω² θ = gain·τ ; outputs θ' (rate). */
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

/**
 * Accelerometer zero-g offset (mg, per axis) and FC board-to-frame misalignment (°) of a build:
 * consumer MEMS accelerometers are specified at tens of mg of zero-g offset (datasheet initial
 * tolerances ±20-80 mg, plus solder / board stress), and a soft-mounted stack sits 0.5-2° off the
 * frame. Betaflight's accelerometer calibration (on a level surface) removes both from the
 * accelerometer, not the gyro's misalignment.
 */
export const ACC_OFFSET_MG: [number, number] = [20, 60];
export const BOARD_MISALIGN_DEG: [number, number] = [0.5, 2];

export class Imu {
  chip: GyroChip;
  private rng: Rng;
  private lpG = [new Biquad(), new Biquad(), new Biquad()];
  private lpA = [new Biquad(), new Biquad(), new Biquad()];
  private bias = [0, 0, 0];
  private scale = [1, 1, 1];
  private cross: number[] = [];
  /** Accelerometer offsets (m/s², board axes). */
  readonly accBias = [0, 0, 0];
  /** Board misalignment: rotation frame -> board (row-major 3x3) and its angle (rad). */
  readonly align = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  readonly misalignRad: number;
  // Per-arm structural modes, detuned a few % from each other (no two arms, motor mounts or bolt
  // preloads are identical): out-of-plane bending (rotation about the axis ⟂ to the arm), arm
  // torsion (about the arm) and in-plane bending (yaw, much stiffer: the arm is 3x wider than thick).
  private armU: V3[] = []; private armR: V3[] = [];
  private bend: Mode[] = []; private twist: Mode[] = []; private yawM: Mode[] = [];
  private modes2: Mode[];   // second (frame-plate) mode: carries motor harmonics at high rpm
  private accMode: Mode[];
  private floorGain: number;
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
    for (const m of [...this.bend, ...this.twist, ...this.yawM, ...this.modes2, ...this.accMode]) { m.th = 0; m.w = 0; }
    for (let i = 0; i < 3; i++) if (!Number.isFinite(this.bias[i])) this.bias[i] = 0;
  }

  /**
   * arms: rotor hub positions (body); one set of detuned arm modes per rotor (default: a 4-arm X).
   */
  constructor(chip: GyroChip, physicsHz: number, flex: { roll: FlexMode; pitch: FlexMode; yaw: FlexMode }, seed = 42, arms?: V3[]) {
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
    // accelerometer offsets and board misalignment (drawn after the gyro errors: those keep their values)
    for (let i = 0; i < 3; i++) this.accBias[i] = Math.sign(r() || 1) * (ACC_OFFSET_MG[0] + (ACC_OFFSET_MG[1] - ACC_OFFSET_MG[0]) * this.rng.next()) * 1e-3 * G0;
    const az = r() * Math.PI, el = r() * 0.3; // axis mostly in the board plane (roll / pitch tilt of the stack)
    const nx = Math.cos(el) * Math.cos(az), ny = Math.cos(el) * Math.sin(az), nz = Math.sin(el);
    const a = ((BOARD_MISALIGN_DEG[0] + (BOARD_MISALIGN_DEG[1] - BOARD_MISALIGN_DEG[0]) * this.rng.next()) * Math.PI) / 180;
    this.misalignRad = a;
    const c = Math.cos(a), s = Math.sin(a), t = 1 - c;
    // Rodrigues, frame -> board is the inverse rotation (transpose)
    const Rm = [c + nx * nx * t, nx * ny * t - nz * s, nx * nz * t + ny * s, ny * nx * t + nz * s, c + ny * ny * t, ny * nz * t - nx * s, nz * nx * t - ny * s, nz * ny * t + nx * s, c + nz * nz * t];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) this.align[i * 3 + j] = Rm[j * 3 + i];
    const hubs = arms && arms.length ? arms : [{ x: -1, y: -1, z: 0 }, { x: 1, y: -1, z: 0 }, { x: -1, y: 1, z: 0 }, { x: 1, y: 1, z: 0 }];
    const n = hubs.length;
    for (const h of hubs) {
      const L = Math.hypot(h.x, h.y) || 1;
      this.armR.push({ x: h.x / L, y: h.y / L, z: 0 });
      this.armU.push({ x: -h.y / L, y: h.x / L, z: 0 });
      // ±8 % detuning per arm; per-arm gain so that n arms together respond like the frame mode
      const d1 = 1 + 0.08 * r(), d2 = 1 + 0.08 * r(), d3 = 1 + 0.06 * r();
      this.bend.push(new Mode({ freqHz: flex.roll.freqHz * d1, zeta: flex.roll.zeta, gain: flex.roll.gain * 4 / n }));
      this.twist.push(new Mode({ freqHz: flex.pitch.freqHz * d2, zeta: flex.pitch.zeta, gain: flex.pitch.gain * 4 / n }));
      this.yawM.push(new Mode({ freqHz: flex.yaw.freqHz * d3, zeta: flex.yaw.zeta, gain: flex.yaw.gain * 4 / n }));
    }
    const m2 = (f: FlexMode) => new Mode({ freqHz: f.freqHz * 2.6, zeta: Math.max(0.12, f.zeta * 1.5), gain: f.gain * 1.6 });
    this.modes2 = [m2(flex.roll), m2(flex.pitch), m2(flex.yaw)];
    this.accMode = [new Mode({ ...flex.roll, gain: 1 }), new Mode({ ...flex.pitch, gain: 1 }), new Mode({ freqHz: flex.roll.freqHz * 1.3, zeta: flex.roll.zeta, gain: 1 })];
    // broadband floor straight at the board (bearing noise, commutation torque ripple, blade
    // turbulence, mostly well above the frame modes): the mode's mass-line response
    this.floorGain = flex.roll.gain / (2 * Math.PI * flex.roll.freqHz);
  }

  /**
   * omega: true rigid-body rate (body, rad/s); specForce: true specific force (body, m/s²);
   * vibTorque / vibForce: body-frame vibration excitation this step (N·m, N); mass in kg.
   * rotorVib: the same torque split per rotor (drives each arm's own modes; falls back to the
   * total spread evenly); floor: RMS (N·m) of the broadband vibration torque this step.
   */
  sample(omega: V3, specForce: V3, vibTorque: V3, vibForce: V3, mass: number, dt: number, rotorVib?: V3[], floor = 0): void {
    const c = this.chip;
    const iso = this.mountIsolation;
    let fx = 0, fy = 0, fz = 0;
    const n = this.bend.length;
    for (let k = 0; k < n; k++) {
      const v = rotorVib ? rotorVib[k] : vibTorque, sc = rotorVib ? 1 : 1 / n;
      const u = this.armU[k], rr = this.armR[k];
      const wb = this.bend[k].step((v.x * u.x + v.y * u.y) * sc, dt);
      const wt = this.twist[k].step((v.x * rr.x + v.y * rr.y) * sc, dt);
      fx += wb * u.x + wt * rr.x; fy += wb * u.y + wt * rr.y;
      fz += this.yawM[k].step(v.z * sc, dt);
    }
    fx = (fx + this.modes2[0].step(vibTorque.x, dt)) * iso;
    fy = (fy + this.modes2[1].step(vibTorque.y, dt)) * iso;
    fz = (fz + this.modes2[2].step(vibTorque.z, dt)) * iso;
    const fl = floor * this.floorGain * iso;
    const ox = omega.x + fx + fl * this.rng.gauss(), oy = omega.y + fy + fl * this.rng.gauss(), oz = omega.z + fz + 0.35 * fl * this.rng.gauss();
    // board misalignment
    const A = this.align;
    const wx = A[0] * ox + A[1] * oy + A[2] * oz, wy = A[3] * ox + A[4] * oy + A[5] * oz, wz = A[6] * ox + A[7] * oy + A[8] * oz;
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

    // accelerometer: specific force + vibration (rigid + local flex), seen through the misaligned
    // board, + offset + noise
    const sa = c.accNoiseUg * 1e-6 * G0 * Math.sqrt(this.fs / 2);
    const am = 1 / Math.max(mass, 0.05);
    const px = specForce.x + vibForce.x * am + this.accMode[0].step(vibForce.x * am * 40, dt) * iso * 0.02;
    const py = specForce.y + vibForce.y * am + this.accMode[1].step(vibForce.y * am * 40, dt) * iso * 0.02;
    const pz = specForce.z + vibForce.z * am + this.accMode[2].step(vibForce.z * am * 40, dt) * iso * 0.02;
    const ab = this.accBias;
    const ax = A[0] * px + A[1] * py + A[2] * pz + ab[0] + sa * this.rng.gauss();
    const ay = A[3] * px + A[4] * py + A[5] * pz + ab[1] + sa * this.rng.gauss();
    const az = A[6] * px + A[7] * py + A[8] * pz + ab[2] + sa * this.rng.gauss();
    const alim = 16 * G0, alsb = G0 / 2048;
    const qa = (v: number) => Math.round(Math.max(-alim, Math.min(alim, v)) / alsb) * alsb;
    this.accOut.x = qa(this.lpA[0].run(ax)); this.accOut.y = qa(this.lpA[1].run(ay)); this.accOut.z = qa(this.lpA[2].run(az));
  }
}
