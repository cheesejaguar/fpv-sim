// Small in-place radix-2 FFT plus a Hann-windowed magnitude spectrum, used by the worker's
// noise-spectrum analyser (blackbox-style "raw vs filtered gyro").

/** In-place iterative radix-2 complex FFT. re/im length must be a power of two. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if (n & (n - 1)) throw new Error('fft length must be a power of two');
  // bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang), half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half;
        const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

/**
 * Hann-windowed amplitude spectrum in dB of the last `n` samples of a ring buffer.
 * ring: circular buffer of length n, `head` = index of the oldest sample. Writes bins 0..out.length-1
 * as 20·log10(amplitude), amplitude scaled so a sine of peak A reads ≈ A (window gain corrected).
 * The mean is removed first so DC / slow attitude rates don't leak into the low bins.
 */
export class Spectrum {
  readonly n: number;
  private win: Float64Array;
  private re: Float64Array;
  private im: Float64Array;
  private scale: number;
  private sumSq = 0;
  constructor(n: number) {
    this.n = n;
    this.win = new Float64Array(n);
    let sum = 0;
    for (let i = 0; i < n; i++) { this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n); sum += this.win[i]; this.sumSq += this.win[i] ** 2; }
    this.scale = 2 / sum;
    this.re = new Float64Array(n);
    this.im = new Float64Array(n);
  }
  /** Expected per-bin level (dB) of white noise with standard deviation sigma. */
  whiteFloorDb(sigma: number): number {
    return 20 * Math.log10(sigma * Math.sqrt(this.sumSq) * this.scale);
  }
  compute(ring: ArrayLike<number>, head: number, out: Float32Array): void {
    const n = this.n, re = this.re, im = this.im;
    let mean = 0;
    for (let i = 0; i < n; i++) mean += ring[i];
    mean /= n;
    for (let i = 0; i < n; i++) { re[i] = (ring[(head + i) % n] - mean) * this.win[i]; im[i] = 0; }
    fft(re, im);
    const m = Math.min(out.length, n >> 1);
    for (let k = 0; k < m; k++) out[k] = 20 * Math.log10(Math.hypot(re[k], im[k]) * this.scale + 1e-6);
  }
}
