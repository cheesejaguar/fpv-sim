import { describe, expect, it } from 'vitest';
import { fft, Spectrum } from '../src/sim/fft';

function naiveDft(x: number[]) {
  const n = x.length, re: number[] = [], im: number[] = [];
  for (let k = 0; k < n; k++) {
    let r = 0, i = 0;
    for (let t = 0; t < n; t++) { r += x[t] * Math.cos((-2 * Math.PI * k * t) / n); i += x[t] * Math.sin((-2 * Math.PI * k * t) / n); }
    re.push(r); im.push(i);
  }
  return { re, im };
}

describe('fft', () => {
  it('matches a naive DFT', () => {
    const x = Array.from({ length: 64 }, (_, i) => Math.sin(i * 0.7) + 0.3 * Math.cos(i * 2.1) + ((i * 37) % 11) / 11);
    const re = Float64Array.from(x), im = new Float64Array(64);
    fft(re, im);
    const d = naiveDft(x);
    for (let k = 0; k < 64; k++) { expect(re[k]).toBeCloseTo(d.re[k], 9); expect(im[k]).toBeCloseTo(d.im[k], 9); }
  });

  it('rejects non power-of-two lengths', () => {
    expect(() => fft(new Float64Array(12), new Float64Array(12))).toThrow();
  });

  it('Spectrum finds a sine at the right bin and amplitude', () => {
    const fs = 8000, n = 2048, f = 312.5, A = 3; // 312.5 Hz = bin 80 exactly
    const ring = new Float64Array(n);
    const head = 517; // arbitrary ring position: oldest sample index
    for (let i = 0; i < n; i++) ring[(head + i) % n] = 5 + A * Math.sin((2 * Math.PI * f * i) / fs);
    const out = new Float32Array(257);
    new Spectrum(n).compute(ring, head, out);
    let best = 0;
    for (let k = 1; k < out.length; k++) if (out[k] > out[best]) best = k;
    expect(best).toBe(80);
    expect(out[80]).toBeCloseTo(20 * Math.log10(A), 1);
    expect(out[0]).toBeLessThan(-40); // mean removed
    expect(out[150]).toBeLessThan(out[80] - 60); // Hann sidelobes far down
  });

  it('whiteFloorDb predicts the mean level of white noise', () => {
    const n = 2048, sp = new Spectrum(n), out = new Float32Array(n / 2);
    let seed = 1;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const sigma = 1 / Math.sqrt(12), avg = new Float64Array(n / 2), runs = 40;
    for (let r = 0; r < runs; r++) {
      const ring = Float64Array.from({ length: n }, () => rnd() - 0.5); // uniform: sigma = 1/sqrt(12)
      sp.compute(ring, 0, out);
      for (let k = 0; k < n / 2; k++) avg[k] += 10 ** (out[k] / 10) / runs; // average power
    }
    let p = 0;
    for (let k = 10; k < n / 2; k++) p += avg[k] / (n / 2 - 10);
    expect(10 * Math.log10(p)).toBeCloseTo(sp.whiteFloorDb(sigma), 0);
  });
});
