import { expect, test } from 'vitest';
import * as THREE from 'three';
import { dvrFileName, pickMimeType, recClock } from '../src/app/dvr';
import { PROPS, VIDEO } from '../src/data/catalog';
import { bladeSolidity, kbDistort, mountVibration, noiseSigma, projectFisheye, propLook, quatToRotVec, SHUTTER_MAX, SHUTTER_MIN, shutterTime } from '../src/render/fpvCamera';
import { goggleItems, rssiPercent, scale2x, signalBars } from '../src/render/osdRenderer';
import { bitrateAt, maxBitrateMbps } from '../src/render/videoLink';

const prop = (id: string) => PROPS.find((p) => p.id === id)!;

test('shutter: 1/2000 s in daylight, the frame period (≤ 1/60 s) in the dark, monotonic between', () => {
  expect(shutterTime(0.06, 60)).toBe(SHUTTER_MIN);
  expect(shutterTime(5, 59.94)).toBeCloseTo(SHUTTER_MAX, 9);
  expect(shutterTime(5, 120)).toBeCloseTo(1 / 120, 9); // can't expose longer than a frame
  let prev = 0;
  for (let e = 0.06; e <= 5; e *= 1.3) { const s = shutterTime(e, 60); expect(s).toBeGreaterThanOrEqual(prev); prev = s; }
});

test('sensor noise grows with the square root of the gain at a given picture level', () => {
  const y = 0.18;
  expect(noiseSigma(4, y) / noiseSigma(1, y)).toBeCloseTo(2, 6);
  expect(noiseSigma(5, y)).toBeGreaterThan(noiseSigma(0.3, y) * 3);
  expect(noiseSigma(1, 0)).toBeGreaterThan(0); // read-noise floor in the blacks
});

/** Inverse of kbDistort, as the fisheye shader does it (Newton). */
function kbTheta(td: number, k: number[]) {
  let t = td;
  for (let i = 0; i < 5; i++) {
    const t2 = t * t, f = t * (1 + k[0] * t2 + k[1] * t2 ** 2 + k[2] * t2 ** 3 + k[3] * t2 ** 4) - td;
    const df = 1 + 3 * k[0] * t2 + 5 * k[1] * t2 ** 2 + 7 * k[2] * t2 ** 3 + 9 * k[3] * t2 ** 4;
    t -= f / df;
  }
  return t;
}

test('fisheye projection: centre, rated diagonal FOV at the corner, and the shader inverse', () => {
  for (const v of VIDEO) {
    const aspect = v.kind === 'analog' ? 4 / 3 : 16 / 9, hf = THREE.MathUtils.degToRad(v.fovDeg) / 2;
    const hd = kbDistort(hf, v.fisheyeK), rc = Math.hypot(aspect, 1) / 2;
    expect(projectFisheye({ x: 0, y: 0, z: -1 }, hd, v.fisheyeK, aspect).theta).toBeCloseTo(0, 9);
    // a direction half the rated FOV off axis, towards the corner, lands on the corner
    const ph = Math.atan2(1, aspect), d = { x: Math.sin(hf) * Math.cos(ph), y: Math.sin(hf) * Math.sin(ph), z: -Math.cos(hf) };
    const p = projectFisheye(d, hd, v.fisheyeK, aspect);
    expect(p.x).toBeCloseTo(aspect / 2, 6); expect(p.y).toBeCloseTo(0.5, 6);
    // round trip through the shader's model
    for (const th of [0.1, 0.5, 1.0, hf]) {
      const q = projectFisheye({ x: Math.sin(th), y: 0, z: -Math.cos(th) }, hd, v.fisheyeK, aspect);
      expect(kbTheta((q.x / rc) * hd, v.fisheyeK)).toBeCloseTo(th, 6);
    }
  }
});

test('rotation vectors from quaternions (shortest way round)', () => {
  const out = [0, 0, 0];
  quatToRotVec(new THREE.Quaternion(), out); expect(out).toEqual([0, 0, 0]);
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.3);
  quatToRotVec(q, out); expect(out[0]).toBeCloseTo(0, 9); expect(out[1]).toBeCloseTo(0.3, 9); expect(out[2]).toBeCloseTo(0, 9);
  quatToRotVec({ x: -q.x, y: -q.y, z: -q.z, w: -q.w }, out); expect(out[1]).toBeCloseTo(0.3, 9);
});

test('mount vibration: props spin at rpm/60 Hz; damaged props shake the camera far more', () => {
  const rpm = [20000, 20000, 20000, 20000];
  const ok = mountVibration(rpm, [0, 1, 2, 3].map(() => ({ thrust: 1, broken: false })), 20000);
  const hurt = mountVibration(rpm, [{ thrust: 0.6, broken: false }, { thrust: 1, broken: false }, { thrust: 1, broken: false }, { thrust: 1, broken: true }], 20000);
  expect(ok.freq[0]).toBeCloseTo(20000 / 60, 9);
  expect(ok.amp[0]).toBeLessThan(0.0005);               // < 0.03°: invisible
  expect(hurt.amp[0]).toBeGreaterThan(ok.amp[0] * 10);   // chipped prop: jello
  expect(hurt.amp[3]).toBeGreaterThan(hurt.amp[0]);      // broken: worse
  expect(mountVibration([0, 0, 0, 0], undefined, 20000).amp.every((a) => a === 0)).toBe(true);
  // imbalance force ∝ rpm²
  const half = mountVibration([10000, 0, 0, 0], [{ thrust: 0.6, broken: false }], 20000);
  expect(hurt.amp[0] / half.amp[0]).toBeCloseTo(4, 6);
});

test('prop look: frozen blades at low rpm / short shutter, a disc of opacity ≈ solidity otherwise', () => {
  const p5 = prop('p-gf51466'), pw = prop('p-31mm4');
  const s5 = bladeSolidity(p5.blades, p5.chordFracs, p5.hubFrac), sw = bladeSolidity(pw.blades, pw.chordFracs, pw.hubFrac);
  expect(s5).toBeGreaterThan(0.08); expect(s5).toBeLessThan(0.25);
  expect(sw).toBeGreaterThan(s5); // whoop props: wide 4-blade
  const still = propLook(0, SHUTTER_MAX, 3, s5);
  expect(still.blades).toBe(true); expect(still.disc).toBe(false);
  const idleDay = propLook(3000, SHUTTER_MIN, 3, s5); // 3000 rpm at 1/2000 s: 9° of sweep
  expect(idleDay.blades).toBe(true);
  const fullDark = propLook(25000, SHUTTER_MAX, 3, s5);
  expect(fullDark.blades).toBe(false); expect(fullDark.disc).toBe(true);
  expect(fullDark.discOpacity).toBeCloseTo(s5, 6);
});

test('video link: bitrate steps down with margin; signal bars and RSSI', () => {
  expect(maxBitrateMbps('dji-o4')).toBe(60); expect(maxBitrateMbps('analog')).toBe(0);
  expect(bitrateAt('dji-o3', 20)).toBe(50);
  expect(bitrateAt('dji-o3', 0)).toBeLessThan(bitrateAt('dji-o3', 6));
  expect(signalBars({ kind: 'digital', cnr: 40, margin: 20, lost: false })).toBe(5);
  expect(signalBars({ kind: 'digital', cnr: 40, margin: 20, lost: true })).toBe(0);
  expect(signalBars({ kind: 'analog', cnr: 6, margin: 6, lost: false })).toBeLessThanOrEqual(1);
  expect(rssiPercent(40)).toBe(99); expect(rssiPercent(0)).toBe(0);
});

test('goggle overlay items per system', () => {
  const base = { cnr: 40, margin: 15, bitrateMbps: 48.6, latencyMs: 24, lost: false, recording: false, recMs: 0 };
  const dji = goggleItems({ ...base, system: 'dji-o4', kind: 'digital' });
  expect(dji.left).toEqual(['48.6Mbps', '24ms']); expect(dji.right).toEqual([]);
  expect(goggleItems({ ...base, system: 'dji-o4', kind: 'digital', recording: true, recMs: 75000 }).right).toEqual(['● 01:15']);
  expect(goggleItems({ ...base, system: 'analog', kind: 'analog' }).right).toEqual(['DVR']);
  expect(goggleItems({ ...base, system: 'analog', kind: 'analog', recording: true, recMs: 5000 }).right).toEqual(['REC 00:05']);
  expect(goggleItems({ ...base, system: 'hdzero', kind: 'digital' }).left).toContain('F4');
});

test('scale2x: a lone pixel stays square, a diagonal step gets smoothed, cells never bleed', () => {
  const W = 0xffffffff, B = 0xff000000, T = 0;
  // lone pixel: 4 copies
  let out = scale2x(new Uint32Array([T, T, T, T, W, T, T, T, T]), 3, 3);
  expect([out[2 * 6 + 2], out[2 * 6 + 3], out[3 * 6 + 2], out[3 * 6 + 3]]).toEqual([W, W, W, W]);
  expect(out.filter((v) => v === W).length).toBe(4);
  // diagonal W at (0,0) and (1,1): the 2-px staircase becomes a 1-px one (the gaps beside the
  // diagonal fill in, the outer corners are trimmed)
  out = scale2x(new Uint32Array([W, T, T, W]), 2, 2);
  expect(out[1 * 4 + 2]).toBe(W); expect(out[2 * 4 + 1]).toBe(W);
  expect(out[1 * 4 + 1]).toBe(T); expect(out[2 * 4 + 2]).toBe(T);
  expect(out[0]).toBe(W); expect(out[3 * 4 + 3]).toBe(W);
  // two 1-pixel cells side by side: no neighbour reads across the boundary
  out = scale2x(new Uint32Array([W, B]), 2, 1, 1, 1);
  expect(Array.from(out.slice(0, 2))).toEqual([W, W]); expect(Array.from(out.slice(2, 4))).toEqual([B, B]);
});

test('DVR helpers: container choice, file name, REC clock', () => {
  expect(pickMimeType((t) => t === 'video/webm')).toBe('video/webm');
  expect(pickMimeType((t) => t.startsWith('video/mp4'))).toMatch(/^video\/mp4/);
  expect(pickMimeType(() => false)).toBe('');
  expect(dvrFileName(new Date(2026, 9, 21, 14, 3, 7), 'video/webm;codecs=vp9')).toBe('fpv-dvr-2026-10-21_14-03-07.webm');
  expect(dvrFileName(new Date(2026, 0, 2, 3, 4, 5), 'video/mp4')).toMatch(/\.mp4$/);
  expect(recClock(0)).toBe('00:00'); expect(recClock(125400)).toBe('02:05');
});
