// Map actors (src/sim/actors.ts): path kinematics as a pure function of time, the RF link budget
// (in-band overlap, antenna pattern, SINR in the RC link), detectors (range, field of view, line of
// sight, probability of detection, m-of-n confirmation), and the actors in the headless simulator:
// a seeded episode repeats its detections exactly, a jammer next to the quad takes its RC link down,
// detect-avoid scores, map packages load from disk through createNodeEnv's maps option.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { obsVectorLabels, obsVector } from '../src/api/types';
import { createNodeEnv } from '../src/headless/node';
import { loadMapPackage, PackageSource } from '../src/maps/mapFormat';
import { MAPS } from '../src/maps/maps';
import { ActorDef, MapDef, PathDef, PrimitiveWorld } from '../src/maps/world';
import {
  ActorSim, antennaGainDb, bandOverlap, DetectEvent, DetectorDef, fsplDb, headingAt, inFov, interferenceMw, lookAt, LookContext,
  pathProgress, posAt, randomizeActors, RC_BAND, REF_SIZE_M, sinrDb, velAt, VIDEO_BAND,
} from '../src/sim/actors';
import { RcLink, RC_NOISE_DBM } from '../src/sim/rcLink';
import type { Scenario } from '../src/scenario/scenario';

const deg = Math.PI / 180;
const have = existsSync(new URL('../public/bf/betaflight.mjs', import.meta.url));

const path = (mode: PathDef['mode'], delay = 0): PathDef => ({ id: 'p', points: [{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, { x: 10, y: 10, z: 0 }], speed: 2, mode, delay });
const onPath = (p: PathDef): ActorDef => ({ type: 'target', id: 't', name: 't', pos: { ...p.points[0] }, path: p.id, shape: 'box', size: { x: 1, y: 1, z: 1 }, radius: 1, solid: false });

describe('actor kinematics', () => {
  test('posAt is a pure function of time along the path: loop, pingpong, once, delay', () => {
    const loop = path('loop'), a = onPath(loop);
    // 10 m east, 10 m north, then back to the start (the loop closes): 34.14 m at 2 m/s
    expect(posAt(a, [loop], 2.5)).toEqual({ x: 5, y: 0, z: 0 });
    expect(posAt(a, [loop], 7.5)).toEqual({ x: 10, y: 5, z: 0 });
    const L = 20 + 10 * Math.SQRT2;
    const p = posAt(a, [loop], L / 2 + 2.5); // one lap later: the same place
    expect(p.x).toBeCloseTo(5, 9); expect(p.y).toBeCloseTo(0, 9);
    // the same time, the same place, however often it is asked and in which order
    const ts = [0.3, 17.1, 4.2, 0.3, 99.9, 17.1];
    const first = ts.map((t) => posAt(a, [loop], t));
    expect(ts.map((t) => posAt(a, [loop], t))).toEqual(first);
    expect(first[0]).toEqual(first[3]);

    const pp = path('pingpong'), b = onPath(pp);
    expect(posAt(b, [pp], 12.5)).toEqual({ x: 10, y: 5, z: 0 }); // 25 m in: 5 m back from the far end
    expect(velAt(b, [pp], 12.5)).toEqual({ x: -0, y: -2, z: -0 });
    expect(headingAt(b, [pp], 12.5)).toBeCloseTo(-Math.PI / 2, 9); // coming back south
    expect(posAt(b, [pp], 20)).toEqual({ x: 0, y: 0, z: 0 }); // back at the start

    const once = path('once', 3), c = onPath(once);
    expect(posAt(c, [once], 2)).toEqual({ x: 0, y: 0, z: 0 }); // before its delay: waits at the start
    expect(velAt(c, [once], 2)).toEqual({ x: 0, y: 0, z: 0 });
    expect(posAt(c, [once], 3 + 5)).toEqual({ x: 10, y: 0, z: 0 });
    expect(posAt(c, [once], 1000)).toEqual({ x: 10, y: 10, z: 0 }); // stops at the end
    expect(pathProgress(once, 1000)).toEqual({ s: 20, dir: 0 });
    expect(headingAt(c, [once], 1000)).toBeCloseTo(Math.PI / 2, 9);
    // a fixed actor (or an unknown path) stays where it is
    expect(posAt({ ...c, path: undefined }, [once], 50)).toEqual({ x: 0, y: 0, z: 0 });
  });

  test('randomizeActors: a seeded draw, fixed actors jittered, paths shifted and scaled, solid targets kept', () => {
    const p = path('loop');
    const map = { paths: [p], actors: [onPath(p), { ...onPath(p), id: 'fixed', path: undefined, pos: { x: 5, y: 5, z: 0 } }, { ...onPath(p), id: 'wall', path: undefined, solid: true, pos: { x: 1, y: 1, z: 0 } }] } as unknown as MapDef;
    const r1 = randomizeActors(map, { jitterM: 2, speedScale: [1.5], seed: 7 }), r2 = randomizeActors(map, { jitterM: 2, speedScale: [1.5], seed: 7 });
    expect(r1).toEqual(r2);
    expect(r1.paths![0].speed).toBe(3);
    const fixed = r1.actors!.find((a) => a.id === 'fixed')!;
    expect(fixed.pos).not.toEqual({ x: 5, y: 5, z: 0 });
    expect(Math.abs(fixed.pos.x - 5)).toBeLessThanOrEqual(2);
    expect(r1.actors!.find((a) => a.id === 'wall')!.pos).toEqual({ x: 1, y: 1, z: 0 });
    expect(r1.actors![0].pos).toEqual(r1.paths![0].points[0]); // a path actor starts on its (shifted) path
    expect(map.paths![0].speed).toBe(2); // the map itself is not touched
  });
});

describe('RF link budget', () => {
  test('free-space loss, band overlap, antenna pattern', () => {
    expect(fsplDb(1, 2440)).toBeCloseTo(100.19, 2);
    expect(bandOverlap(2440, 80, RC_BAND)).toBeCloseTo(0.812 / 80, 9); // a wideband jammer: 1 % of it in the LoRa channel
    expect(bandOverlap(2440, 0.4, RC_BAND)).toBe(1);
    expect(bandOverlap(5800, 20, RC_BAND)).toBe(0); // 5.8 GHz misses the RC link
    expect(bandOverlap(5800, 40, VIDEO_BAND)).toBeCloseTo(0.5, 9);
    expect(bandOverlap(5800, 0, VIDEO_BAND)).toBe(1); // a carrier inside the channel
    const ant = { yaw: 0, pitch: 0, beam: 30 * deg }, o = { x: 0, y: 0, z: 0 };
    expect(antennaGainDb(ant, o, { x: 10, y: 0, z: 0 })).toBeCloseTo(0, 9);
    expect(antennaGainDb(ant, o, { x: 10 * Math.cos(15 * deg), y: 10 * Math.sin(15 * deg), z: 0 })).toBeCloseTo(-3, 6);
    expect(antennaGainDb(ant, o, { x: -10, y: 0, z: 0 })).toBe(-25); // behind it
    expect(antennaGainDb(undefined, o, { x: -10, y: 0, z: 0 })).toBe(0);
  });

  test('interference power: EIRP − FSPL − obstruction, times overlap and duty', () => {
    const e = { type: 'rf-emitter', id: 'j', name: 'j', pos: { x: 0, y: 0, z: 0 }, freqMHz: 2440, eirpDbm: 30, bwMHz: 0.812, duty: 0.5 } as Extract<ActorDef, { type: 'rf-emitter' }>;
    const rx = { x: 100, y: 0, z: 0 };
    const dbm = 30 - fsplDb(0.1, 2440) - 10;
    expect(interferenceMw(e, e.pos, rx, RC_BAND, 10)).toBeCloseTo(10 ** (dbm / 10) * 0.5, 12);
    expect(interferenceMw({ ...e, freqMHz: 5800 }, e.pos, rx, RC_BAND, 10)).toBe(0);
    expect(sinrDb(-80, -100, 0)).toBeCloseTo(20, 9);
    expect(sinrDb(-80, -100, 1e-10)).toBeCloseTo(20 - 10 * Math.log10(2), 9); // interference = noise: 3 dB less
  });

  test('RC link: no interference keeps the margin bit for bit; interference costs SINR', () => {
    const world = { obstructionDb: () => 3 };
    const a = new RcLink(9), b = new RcLink(9), c = new RcLink(9);
    const pilot = { x: 0, y: 0, z: 1.6 }, quad = { x: 300, y: 40, z: 20 };
    for (let k = 0; k < 50; k++) { a.updateBudget(world, pilot, quad, 0.05); b.updateBudget(world, pilot, quad, 0.05, 0); c.updateBudget(world, pilot, quad, 0.05, 10 ** (RC_NOISE_DBM / 10)); }
    expect(b.marginDb).toBe(a.marginDb);
    expect(b.rssiDbm).toBe(a.rssiDbm);
    // interference equal to the receiver noise: 3 dB of margin gone (the RSSI itself is the same)
    expect(c.rssiDbm).toBe(a.rssiDbm);
    expect(a.marginDb - c.marginDb).toBeCloseTo(10 * Math.log10(2), 9);
    // a strong jammer: the link is gone
    const j = new RcLink(9);
    j.updateBudget(world, pilot, quad, 0.05, 1e-3);
    let ok = 0; for (let k = 0; k < 200; k++) ok += j.packet() ? 1 : 0;
    expect(ok).toBe(0);
  });
});

/** A small package map (flat field) with actors, built through the real loader. */
function mapDoc(id: string, actors: unknown[], extra: object = {}) {
  return {
    format: 'fpvsim-map', formatVersion: 1, meta: { id, name: `Test ${id}`, author: 'Tests', license: 'CC0-1.0', version: '1.0.0' },
    size: 200, spawn: { pos: [0, 0, 0.25], yawDeg: 90 }, ...extra, actors,
  };
}
function memSource(doc: object): PackageSource {
  const files: Record<string, Uint8Array> = { 'map.json': new TextEncoder().encode(JSON.stringify(doc)) };
  return { list: async () => Object.entries(files).map(([path, v]) => ({ path, size: v.length })), url: (p) => `mem://${p}`, read: async (p) => { if (!files[p]) throw new Error('no such file'); return files[p]; } };
}
const buildMap = async (doc: object) => (await loadMapPackage(memSource(doc))).build();

describe('detectors', () => {
  const det = (o: Partial<DetectorDef> = {}): DetectorDef => ({ type: 'detector', id: 'd', name: 'd', pos: { x: 0, y: 0, z: 2 }, sensor: 'camera', yaw: 0, pitch: 0, fovH: 60 * deg, fovV: 40 * deg, rangeM: 200, r50M: 50, sensitivityDbm: -90, rateHz: 10, confirmM: 2, confirmN: 3, ...o });
  const clear: LookContext = { sizeM: REF_SIZE_M, vtxDbm: 25, light: 1, los: () => ({ db: 0, hardDb: 0, foliageDb: 0 }) };
  const at = (r: number) => ({ x: r, y: 0, z: 2 });

  test('field of view in the sensor frame', () => {
    const d = det({ yaw: 90 * deg, pitch: 10 * deg });
    expect(inFov(d, { x: 0, y: 10, z: 1.7 })).toBe(true); // north, 10° up
    expect(inFov(d, { x: 0, y: -10, z: 0 })).toBe(false); // behind
    expect(inFov(d, { x: 10 * Math.tan(35 * deg), y: 10, z: 1.7 })).toBe(false); // 35° off to the side (fov 60)
    expect(inFov(d, { x: 0, y: 10, z: 10 * Math.tan(40 * deg) })).toBe(false); // 40° up: 30° above the boresight
    expect(inFov(det({ fovH: 2 * Math.PI, fovV: Math.PI }), { x: -3, y: -1, z: -9 })).toBe(true);
  });

  test('probability of detection: 50 % at r50M, falls with range; out of range / view / sight: none', () => {
    const cam = det();
    expect(lookAt(cam, cam.pos, at(50), clear).pd).toBeCloseTo(0.5, 9);
    expect(lookAt(cam, cam.pos, at(20), clear).pd).toBeGreaterThan(0.95);
    expect(lookAt(cam, cam.pos, at(90), clear).pd).toBeLessThan(0.05);
    expect(lookAt(cam, cam.pos, at(250), clear)).toMatchObject({ inRange: false, pd: 0 });
    expect(lookAt(cam, cam.pos, { x: -40, y: 0, z: 2 }, clear)).toMatchObject({ inFov: false, pd: 0 });
    // a wall in the way blocks the camera and the radar; foliage only weakens them
    const wall: LookContext = { ...clear, los: () => ({ db: 14, hardDb: 14, foliageDb: 0 }) };
    const tree: LookContext = { ...clear, los: () => ({ db: 4, hardDb: 0, foliageDb: 4 }) };
    expect(lookAt(cam, cam.pos, at(20), wall)).toMatchObject({ clear: false, pd: 0 });
    expect(lookAt(cam, cam.pos, at(20), tree).pd).toBeCloseTo(lookAt(cam, cam.pos, at(20), clear).pd * 10 ** -0.4, 9);
    // a bigger target is seen farther, darkness halves the range and more
    expect(lookAt(cam, cam.pos, at(50), { ...clear, sizeM: 2 * REF_SIZE_M }).pd).toBeGreaterThan(0.98);
    expect(lookAt(cam, cam.pos, at(50), { ...clear, light: 0.3 }).pd).toBeLessThan(0.01);
    const radar = det({ sensor: 'radar', r50M: 120 });
    expect(lookAt(radar, radar.pos, at(120), clear).pd).toBeCloseTo(0.5, 9);
    expect(lookAt(radar, radar.pos, at(60), clear).pd).toBeGreaterThan(0.99); // SNR ∝ 1/r⁴: +12 dB at half the range
    expect(lookAt(radar, radar.pos, at(60), wall).pd).toBe(0);
    // rf: the quad's VTX against the sensitivity, through walls (weakened)
    const rf = det({ sensor: 'rf', sensitivityDbm: -80, rangeM: 5000, fovH: 2 * Math.PI, fovV: Math.PI });
    const r50 = 1000 * 10 ** ((25 + 80 - 20 * Math.log10(5800) - 32.44) / 20); // where 25 dBm − FSPL = −80 dBm
    expect(lookAt(rf, rf.pos, at(r50), clear).pd).toBeCloseTo(0.5, 6);
    expect(lookAt(rf, rf.pos, at(r50 / 8), wall).pd).toBeGreaterThan(0.9); // 18 dB closer, 14 dB of wall: still heard
  });

  test('m-of-n confirmation on a step-count cadence, seeded per detector', async () => {
    const m = await buildMap(mapDoc('det-test', [
      { type: 'detector', id: 'near', sensor: 'camera', pos: [0, 0, 2], rangeM: 300, r50M: 100, rateHz: 10, confirm: [2, 3] },
      { type: 'detector', id: 'blind', sensor: 'camera', pos: [0, 0, 2], yawDeg: 180, rangeM: 300, r50M: 100, rateHz: 10, confirm: [2, 3] },
      { type: 'detector', id: 'coin', sensor: 'camera', pos: [0, 0, 2], rangeM: 300, r50M: 30, rateHz: 50, confirm: [1, 1] },
    ]));
    const world = new PrimitiveWorld(m);
    const ctx: LookContext = { ...{ sizeM: REF_SIZE_M, vtxDbm: 25, light: 1 }, los: (a, b) => world.losLoss(a, b) };
    const run = (seed: number) => {
      const sim = new ActorSim(m, seed), ev: DetectEvent[] = [], looks: number[] = [];
      for (let step = 1; step <= 8000; step++) { // 1 s at 8 kHz
        sim.stepDetectors(step, 8000, step / 8000, { x: 30, y: 0, z: 2 }, ctx, (e) => ev.push(e));
        if (step === 800 || step === 1600) looks.push(sim.detectedMask);
      }
      return { ev, looks };
    };
    const a = run(5);
    // 'near' (Pd ~1): on at its second look (0.2 s); 'blind' never; looks every 800 steps at 10 Hz
    expect(a.ev.filter((e) => e.id === 'near')).toEqual([{ index: 0, id: 'near', name: 'near', t: 0.2, on: true }]);
    expect(a.ev.some((e) => e.id === 'blind')).toBe(false);
    expect(a.looks[0] & 1).toBe(0); expect(a.looks[1] & 1).toBe(1);
    // 'coin' (Pd 0.5, 1-of-1): flickers; the same seed flickers the same way, another seed differently
    const coin = (r: ReturnType<typeof run>) => r.ev.filter((e) => e.id === 'coin').map((e) => `${e.t}${e.on}`);
    expect(coin(a).length).toBeGreaterThan(6);
    expect(coin(run(5))).toEqual(coin(a));
    expect(coin(run(6))).not.toEqual(coin(a));
  });

  test('losLoss shares obstructionDb: walls are hard, canopies foliage', async () => {
    const m = await buildMap(mapDoc('los-test', [], {
      primitives: [{ type: 'box', pos: [10, 0, 2], size: [1, 10, 4], material: 'concrete' }, { type: 'sphere', pos: [-10, 0, 2], radius: 2, material: 'foliage' }],
    }));
    const w = new PrimitiveWorld(m), o = { x: 0, y: 0, z: 2 };
    const wall = w.losLoss(o, { x: 20, y: 0, z: 2 }), tree = w.losLoss(o, { x: -20, y: 0, z: 2 }), open = w.losLoss(o, { x: 0, y: 20, z: 2 });
    expect(wall.db).toBe(w.obstructionDb(o, { x: 20, y: 0, z: 2 }));
    expect(wall.hardDb).toBe(14); expect(wall.foliageDb).toBe(0);
    expect(tree).toEqual({ db: 4, hardDb: 0, foliageDb: 4 });
    expect(open).toEqual({ db: 0, hardDb: 0, foliageDb: 0 });
    expect(w.losLoss(o, { x: 0, y: 20, z: -5 }).hardDb).toBeGreaterThan(0); // through the ground
  });
});

describe('actor rendering', () => {
  test('ActorsView draws every actor, labels targets for the ground truth, moves path actors with actor time', async () => {
    const { ActorsView } = await import('../src/render/actors');
    const m = await buildMap(mapDoc('view-test', [
      { type: 'rf-emitter', id: 'jammer', pos: [5, 5, 3], freqMHz: 2440, eirpDbm: 30, antenna: { yawDeg: 90, beamDeg: 40 } },
      { type: 'ground-station', id: 'gs', pos: [-5, 0, 2], link: 'both' },
      { type: 'detector', id: 'cam', sensor: 'camera', pos: [0, -10, 4], rangeM: 80 },
      { type: 'target', id: 'truck', shape: 'vehicle', path: 'road' },
      { type: 'target', id: 'walker', shape: 'person', pos: [2, 2, 0] },
      { type: 'target', id: 'crate', pos: [3, 3, 0], solid: true },
    ], { paths: [{ id: 'road', points: [[0, 0, 0], [40, 0, 0]], speedMs: 4, mode: 'once' }] }));
    const v = new ActorsView(m);
    expect(v.group.children.map((c) => c.name)).toEqual(['actor-jammer', 'actor-gs', 'actor-cam', 'actor-truck', 'actor-walker', 'actor-crate']);
    expect(v.group.children.slice(3).map((c) => c.userData.gt)).toEqual([{ cls: 'target', id: 1 }, { cls: 'target', id: 2 }, { cls: 'target', id: 3 }]);
    const truck = v.group.children[3];
    v.update(5);
    expect(truck.position.x).toBeCloseTo(20, 9); // three: x east, y up, z south
    expect(truck.position.z).toBeCloseTo(-0, 9);
    v.dispose();
    expect(v.group.parent).toBeNull();
  });
});

describe('vector layout', () => {
  test('observations.actors appends after the probes, only when on', () => {
    const base = obsVectorLabels(2);
    const withActors = obsVectorLabels(2, ['truck']);
    expect(withActors.slice(0, base.length)).toEqual(base);
    expect(withActors.slice(base.length)).toEqual(['target.truck.pos.x', 'target.truck.pos.y', 'target.truck.pos.z', 'target.truck.vel.x', 'target.truck.vel.y', 'target.truck.vel.z', 'detectedCount', 'rcMarginDb']);
    expect(obsVectorLabels(2, null)).toEqual(base);
  });
});

// ---------------------------------------------------------------------------------------------
// headless: map packages from disk, seeded detections, a jammer, detect-avoid

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
function packageDir(doc: object): string {
  const d = mkdtempSync(join(tmpdir(), 'fpvsim-map-'));
  dirs.push(d);
  writeFileSync(join(d, 'map.json'), JSON.stringify(doc));
  writeFileSync(join(d, 'ATTRIBUTION.md'), '# Test map\nCC0');
  return d;
}

const RANGE = mapDoc('actor-range', [
  { type: 'detector', id: 'radar-1', name: 'Radar 1', sensor: 'radar', pos: [0, -60, 3], yawDeg: 90, fovDeg: [90, 40], rangeM: 300, r50M: 60, rateHz: 20, confirm: [2, 3] },
  { type: 'target', id: 'truck', shape: 'vehicle', path: 'road' },
], { paths: [{ id: 'road', points: [[20, -20, 0], [20, 20, 0]], speedMs: 4, mode: 'pingpong' }], spawns: [{ id: 'east', pos: [10, 0, 0.25], yawDeg: 90 }], environment: { wind: { speed: 1, directionDeg: 180 } } });
const JAMMED = mapDoc('jammed-range', [{ type: 'rf-emitter', id: 'jammer', pos: [3, 0, 1.5], freqMHz: 2440, bwMHz: 1, eirpDbm: 40 }]);
const QUIET = mapDoc('quiet-range', [{ type: 'rf-emitter', id: 'video-only', pos: [3, 0, 1.5], freqMHz: 5800, bwMHz: 20, eirpDbm: 30 }]);

const hover = (map: string, extra: Partial<Scenario> = {}): Scenario => ({
  format: 'fpvsim-scenario', version: 1, seed: 3, map: { id: map },
  start: { armed: true, mode: 'angle' }, task: { type: 'hover', heightM: 2 }, episode: { maxSeconds: 2, controlHz: 50 }, ...extra,
});
const fly = (o: { agl: number; vel: number[] }) => ({ throttle: Math.max(0, Math.min(1, 0.32 + 0.1 * (2 - o.agl) - 0.08 * o.vel[2])) });

describe.skipIf(!have)('actors in the headless simulator', () => {
  test('createNodeEnv registers map packages from disk; a seeded episode repeats its detections exactly', async () => {
    const seen: string[] = [];
    const env = await createNodeEnv({ maps: [packageDir(RANGE), packageDir(JAMMED), packageDir(QUIET)], onMap: (m) => seen.push(m.id) });
    expect(seen).toEqual(['actor-range', 'jammed-range', 'quiet-range']);
    expect('actor-range' in MAPS).toBe(true);
    const sc = hover('actor-range', { observations: { actors: true }, start: { armed: true, mode: 'angle', spawn: 'east' } });
    const runOnce = async () => {
      const r = await env.reset({ scenario: sc, seed: 21 });
      const events: unknown[] = [], trace: number[][] = [obsVector(r.obs)];
      let o = r.obs, res;
      do { res = env.step(fly(o)); o = res.obs; events.push(...res.info.events.filter((e) => e.type === 'detect')); trace.push(obsVector(o)); } while (!res.terminated && !res.truncated);
      return { r, res, events, trace };
    };
    const a = await runOnce(), b = await runOnce();
    expect(a.r.obs.pos[0]).toBeCloseTo(10, 0); // the 'east' spawn
    expect(a.r.info.episode.settings.wind.speed).toBe(1); // the map's wind (the scenario sets none)
    expect(a.events.length).toBeGreaterThan(0);
    expect(b.events).toEqual(a.events);
    expect(b.trace).toEqual(a.trace);
    expect(a.res.info.metrics.detectedS).toBeGreaterThan(0);
    // observations.actors: the truck where posAt puts it, its numbers at the end of the vector
    const labels = obsVectorLabels(0, a.r.info.episode.observeActors);
    expect(a.trace[0]).toHaveLength(labels.length);
    const truck = a.res.obs.actors!.targets[0];
    expect(truck.id).toBe('truck');
    expect(Math.abs(truck.vel[1])).toBeCloseTo(4, 6);
    expect(truck.pos[1]).toBeCloseTo(-20 + 4 * a.res.obs.t, 1);
  }, 120000);

  test('a jammer next to the quad takes the RC link down: Betaflight fails safe (an out-of-band one does nothing)', async () => {
    const env = await createNodeEnv();
    const lq = async (map: string) => {
      // (on the pad, disarmed: jammed, it could not arm at all)
      await env.reset({ scenario: hover(map, { start: {}, observations: { actors: true }, episode: { maxSeconds: 3, controlHz: 50 } }) });
      let o = env.observe();
      for (let i = 0; i < 50; i++) o = env.step({ throttle: 0 }).obs;
      return { lq: env.core.rcLink.lq, margin: o.actors!.rcMarginDb, flags: o.armingFlags };
    };
    const jammed = await lq('jammed-range'), quiet = await lq('quiet-range');
    expect(quiet.lq).toBeGreaterThan(95);
    expect(quiet.margin).toBeGreaterThan(30);
    expect(quiet.flags).not.toContain('RX_FAILSAFE');
    expect(jammed.lq).toBeLessThan(5);
    expect(jammed.margin).toBeLessThan(-8);
    expect(jammed.flags).toContain('RX_FAILSAFE');
  }, 120000);

  test('detect-avoid ends the episode once the quad was detected for too long', async () => {
    const env = await createNodeEnv();
    const sc = hover('actor-range', { task: { type: 'detect-avoid', points: [[0, 80, 3]], maxDetectedS: 0.2 }, episode: { maxSeconds: 6, controlHz: 50 } });
    await env.reset({ scenario: sc, seed: 2 });
    let o = env.observe(), res;
    do { res = env.step(fly(o)); o = res.obs; } while (!res.terminated && !res.truncated);
    expect(res.info.reason).toBe('detected');
    expect(res.terminated).toBe(true);
    expect(res.info.metrics.failed).toBe(true);
    expect(res.info.metrics.detectedS).toBeGreaterThan(0.2);
    expect(res.info.metrics.firstDetectT).not.toBeNull();
  }, 120000);
});
