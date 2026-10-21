// Shared crash / contact / wind scenarios for the collision, damage and wind tests.
import { buildDrone, DEFAULT_SPEC, DroneSpec } from '../../src/builder/derive';
import { MapDef, Material, Prim, PrimitiveWorld } from '../../src/maps/world';
import { qFromEuler } from '../../src/sim/math';
import { QuadEnv, QuadSim } from '../../src/sim/quad';
import { WakeField } from '../../src/sim/wake';
import { Wind, WindParams } from '../../src/sim/wind';

export const DT = 1 / 8000;
export const CALM: WindParams = { speed20ft: 0, directionDeg: 0, z0: 0.03, turbulence: 0, gustiness: 0, gustMax: 0 };

export function testMap(prims: Prim[], groundMat: Material = 'concrete', extra: Partial<MapDef> = {}): MapDef {
  return {
    id: 'test', name: 'test', size: 100, terrain: () => 0, groundMat, prims, gates: [], spawn: { pos: { x: 0, y: 0, z: 0.1 }, yaw: 0 },
    sun: { azimuthDeg: 0, elevationDeg: 45 }, sky: 'clear', wakeZones: [], elevationM: 0, trees: [], ...extra,
  };
}

export function rig(prims: Prim[], groundMat: Material = 'concrete', spec: DroneSpec = DEFAULT_SPEC, damage = true, wind: WindParams = CALM, extra: Partial<MapDef> = {}) {
  const q = new QuadSim(buildDrone(spec).params, 8000);
  const map = testMap(prims, groundMat, extra);
  const env: QuadEnv = { world: new PrimitiveWorld(map), wind: new Wind(wind), wake: new WakeField(), ambientC: 20, altitudeOffset: 0, damageEnabled: damage };
  env.wind.zones = map.wakeZones;
  return { q, env, map };
}

export const run = (q: QuadSim, env: QuadEnv, s: number, thr = 0, each?: (i: number) => void) => {
  for (let i = 0; i < s / DT; i++) { q.command([thr, thr, thr, thr], false); q.step(DT, env); each?.(i); }
};

/** Level quad flying +x at v into an obstacle placed at x = 1 m; returns the final x. */
export function flatInto(prims: Prim[], v: number, z = 2, thr = 0, s = 0.25, each?: (q: QuadSim) => void) {
  const r = rig(prims);
  r.q.reset({ x: 0, y: 0, z });
  r.q.s.vel = { x: v, y: 0, z: 0 };
  run(r.q, r.env, s, thr, each && (() => each(r.q)));
  return r;
}

export function touchdown(groundMat: Material, v: number, pitch: number, s = 3, spec = DEFAULT_SPEC) {
  const r = rig([], groundMat, spec);
  r.q.reset({ x: 0, y: 0, z: 0.25 });
  r.q.s.q = qFromEuler(0, pitch, 0);
  r.q.s.vel = { x: v, y: 0, z: -2 };
  let flipped = false;
  run(r.q, r.env, s, 0, () => {
    const q = r.q.s.q; const upZ = 1 - 2 * (q.x * q.x + q.y * q.y); // body z axis · world z
    if (upZ < -0.2) flipped = true;
  });
  return { ...r, slide: r.q.s.pos.x, flipped };
}

export const damageOf = (q: QuadSim) => ({
  thrust: Math.min(...q.aero.map((a) => (a.damage.broken ? 0 : a.damage.thrustFactor))),
  broken: q.aero.filter((a) => a.damage.broken).length,
  imbalance: Math.max(...q.aero.map((a) => a.damage.imbalance)),
});
