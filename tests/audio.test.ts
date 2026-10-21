// Audio maths (the Web Audio graph itself is exercised in a browser): propagation, panning
// direction, Betaflight beeper patterns, DShot beacon timing, the generated reverb response.
import { describe, expect, it } from 'vitest';
import { BEACON_ON, BEACON_PERIOD, beaconOn, beepOn, BEEPER_HZ, impulseResponse, listenerDir, propagation, REF_DISTANCE, SPEED_OF_SOUND } from '../src/render/audio';

describe('propagation', () => {
  it('delay is distance / speed of sound', () => {
    expect(propagation(343).delay).toBeCloseTo(1, 6);
    expect(propagation(10).delay).toBeCloseTo(10 / SPEED_OF_SOUND, 6);
  });
  it('full level inside the reference distance, then 1/d with no floor', () => {
    expect(propagation(1).gain).toBeCloseTo(1, 2);
    const g40 = propagation(40).gain, g4 = propagation(REF_DISTANCE).gain;
    expect(20 * Math.log10(g40 / g4)).toBeCloseTo(-20, 0);
    // a quad 500 m out is ~ -45 dB: effectively inaudible (the old 0.04 floor kept it at -28 dB)
    expect(20 * Math.log10(propagation(500).gain)).toBeLessThan(-42);
  });
  it('air absorption closes the low-pass with distance', () => {
    expect(propagation(2).lowpassHz).toBeGreaterThan(15000);
    expect(propagation(100).lowpassHz).toBeLessThan(6000);
    expect(propagation(100).lowpassHz).toBeGreaterThan(propagation(300).lowpassHz);
  });
});

describe('listener direction', () => {
  const lis = { x: 0, y: 0, z: 0 }, north = { x: 0, y: 1, z: 0 };
  it('ahead is -z, right is +x, up is +y (Web Audio listener space)', () => {
    const a = listenerDir({ x: 0, y: 10, z: 0 }, lis, north); expect(a[2]).toBeCloseTo(-1); expect(a[0]).toBeCloseTo(0);
    const r = listenerDir({ x: 10, y: 0, z: 0 }, lis, north); expect(r[0]).toBeCloseTo(1);
    const u = listenerDir({ x: 0, y: 0, z: 10 }, lis, north); expect(u[1]).toBeCloseTo(1);
    const b = listenerDir({ x: 0, y: -10, z: 0 }, lis, north); expect(b[2]).toBeCloseTo(1);
  });
  it('no facing: straight ahead', () => { expect(listenerDir({ x: 5, y: 0, z: 0 }, lis)).toEqual([0, 0, -1]); });
});

describe('beeper and beacon', () => {
  it('Betaflight patterns: arming is a 300 ms tone then a blip, one-shot', () => {
    expect(beepOn('arming', 0.1)).toBe(true); expect(beepOn('arming', 0.32)).toBe(false);
    expect(beepOn('arming', 0.37)).toBe(true); expect(beepOn('arming', 5)).toBe(false);
  });
  it('repeating patterns loop: low battery 250 ms on / 500 ms off, beeper switch 100 / 100', () => {
    expect(beepOn('lowBattery', 0.1)).toBe(true); expect(beepOn('lowBattery', 0.5)).toBe(false); expect(beepOn('lowBattery', 0.85)).toBe(true);
    expect(beepOn('rxSet', 0.05)).toBe(true); expect(beepOn('rxSet', 0.15)).toBe(false); expect(beepOn('rxSet', 1.05)).toBe(true);
  });
  it('the piezo sits in the 2.7-4 kHz band', () => { expect(BEEPER_HZ).toBeGreaterThanOrEqual(2700); expect(BEEPER_HZ).toBeLessThanOrEqual(4000); });
  it('DShot beacon: short beeps, resent every 1.2 s', () => {
    expect(beaconOn(0.1)).toBe(true); expect(beaconOn(BEACON_ON + 0.05)).toBe(false); expect(beaconOn(BEACON_PERIOD + 0.1)).toBe(true);
  });
});

describe('reverb impulse response', () => {
  it('stereo, decorrelated, decays by ~60 dB over rt60', () => {
    const rate = 8000, ir = impulseResponse(rate, 1, 1.5);
    expect(ir.length).toBe(2); expect(ir[0].length).toBe(12000);
    const e = (x: Float32Array, a: number, b: number) => { let s = 0; for (let i = Math.floor(a * rate); i < Math.floor(b * rate); i++) s += x[i] * x[i]; return s / ((b - a) * rate); };
    const early = e(ir[0], 0.05, 0.15), late = e(ir[0], 0.95, 1.05);
    expect(10 * Math.log10(late / early)).toBeLessThan(-45);
    let c = 0; for (let i = 0; i < 4000; i++) c += ir[0][i] * ir[1][i];
    expect(Math.abs(c) / Math.sqrt(e(ir[0], 0, 0.5) * e(ir[1], 0, 0.5) * 4000 * 4000)).toBeLessThan(0.2);
  });
});
