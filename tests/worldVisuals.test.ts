// World rendering logic that runs without WebGL: tree templates against the collision model,
// terrain tiles / LOD, wind direction, lighting presets, windsock placement, the texel-snapped
// shadow, clutter placement, crowd facing, drone prop colour / damage.
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { FLAG, isFlagBanner } from '../src/maps/gates';
import { bandoMap, MAPS } from '../src/maps/maps';
import { MapDef, PrimitiveWorld } from '../src/maps/world';
import { buildCrowd, figureGeometry } from '../src/render/crowd';
import { bladeLengths, propColor, PROP_COLORS } from '../src/render/droneMesh';
import { blockStep, clutterPoints, TERRAIN_LOD_ERR, terrainTiles } from '../src/render/ground';
import { snapShadow } from '../src/render/scene';
import { buildLights, environment, floodTowers } from '../src/render/sky';
import { MAX_MAP_LIGHTS } from '../src/maps/world';
import { flowDir, makeWorldUniforms, windStrength } from '../src/render/sway';
import { farTemplate, oakTemplate, pineTemplate, TRUNK_PROFILE } from '../src/render/trees';
import { windsockSpot } from '../src/render/windVisuals';

const field = MAPS.field();

describe('trees match the collision model', () => {
  for (const [name, geo] of [['oak', oakTemplate(7)], ['pine', pineTemplate(101)]] as const) {
    it(`${name}: every leaf card stays inside the canopy sphere (radius 1 in canopy units)`, () => {
      const p = geo.getAttribute('position'), leaf = geo.getAttribute('aLeaf');
      let cards = 0, maxR = 0;
      for (let i = 0; i < p.count; i++) if (leaf.getX(i) > 0) { cards++; maxR = Math.max(maxR, Math.hypot(p.getX(i), p.getY(i), p.getZ(i))); }
      expect(cards / 4).toBeGreaterThan(100);       // dense enough to read as foliage
      expect(maxR).toBeLessThan(1.06);              // corners may overhang the porous sphere a hair
    });
    it(`${name}: budget (one draw per tree set, < 1000 triangles a tree)`, () => {
      expect(geo.getIndex()!.count / 3).toBeLessThan(1000);
    });
  }
  it('the trunk is at least as thick as the solid trunk cylinder (0.12 r) wherever that exists', () => {
    // collision trunk: radius 0.12 r up to 0.5 h - 0.2; visual q runs 0..1 over 0..0.62 h
    for (let i = 0; i + 1 < TRUNK_PROFILE.length; i++) {
      const [q0, r0] = TRUNK_PROFILE[i], [q1, r1] = TRUNK_PROFILE[i + 1];
      for (let k = 0; k <= 10; k++) {
        const q = q0 + ((q1 - q0) * k) / 10, r = r0 + ((r1 - r0) * k) / 10;
        if (q >= 0 && q <= 0.5 / 0.62) expect(r).toBeGreaterThanOrEqual(0.12);
      }
    }
  });
  it('trunk vertices are flagged for stretching, from slightly below the ground to the canopy centre', () => {
    const tq = oakTemplate(7).getAttribute('aTq');
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < tq.count; i++) if (tq.getX(i) > -0.5) { lo = Math.min(lo, tq.getX(i)); hi = Math.max(hi, tq.getX(i)); }
    expect(lo).toBeLessThan(0); expect(hi).toBe(1);
  });
  it('far stand-ins are a few dozen triangles', () => {
    for (const k of ['oak', 'pine'] as const) expect(farTemplate(k).getIndex()!.count / 3).toBeLessThan(60);
  });
  it('the solid core and trunk the quad collides with are where the visual tree is', () => {
    const t = { x: 0, y: 0, h: 12, r: 3, type: 'oak' as const };
    const m: MapDef = { ...field, prims: [], gates: [], decor: [], trees: [t], terrain: () => 0 };
    const w = new PrimitiveWorld(m), hit = { depth: 0, nx: 0, ny: 0, nz: 0, material: null as never };
    expect(w.sphere({ x: 0.3, y: 0, z: 2 }, 0.1, hit)).toBe(true);          // trunk (r 0.36 m)
    expect(w.sphere({ x: 0, y: 0, z: 0.62 * 12 + 0.5 }, 0.1, hit)).toBe(true); // core
    expect(w.foliage({ x: 2, y: 0, z: 0.62 * 12 })).toBeGreaterThan(0);   // porous canopy
  });
});

describe('terrain tiles', () => {
  it('flat ground gets 4x coarser quads, rough ground keeps the full grid', () => {
    expect(blockStep(() => 0, 0, 0, 20)).toBe(4);
    expect(blockStep((i, j) => Math.sin(i * 1.3) * Math.cos(j * 0.7) * 0.5, 0, 0, 20)).toBe(1);
  });
  it('the stadium floor is cheap, tile vertices lie on the terrain, edges are covered', () => {
    const tiles = terrainTiles(field);
    expect(tiles.length).toBe(16);
    let tris = 0, xmin = Infinity, xmax = -Infinity;
    for (const g of tiles) {
      tris += g.getIndex()!.count / 3;
      const p = g.getAttribute('position');
      for (let i = 0; i < p.count; i += 7) {
        const x = p.getX(i), z = p.getZ(i), y = p.getY(i), h = field.terrain(x, -z);
        // surface vertices exactly on the heightfield; skirt vertices hang 0.4 m below it
        expect(Math.abs(y - h) < 1e-3 || Math.abs(y - (h - 0.4)) < 1e-3).toBe(true);
        xmin = Math.min(xmin, x); xmax = Math.max(xmax, x);
      }
    }
    expect(tris).toBeLessThan(204800 * 0.75);   // the old single mesh: 320² quads
    expect(xmin).toBeCloseTo(-field.size * 1.1, 3); expect(xmax).toBeCloseTo(field.size * 1.1, 3);
    expect(TERRAIN_LOD_ERR).toBeLessThanOrEqual(0.05);
  });
});

describe('wind', () => {
  it('direction is where the wind comes FROM (meteorological), flow in three axes', () => {
    const [x, z] = flowDir(0); // from the north -> blows south = three +z
    expect(x).toBeCloseTo(0); expect(z).toBeCloseTo(1);
    const [x2, z2] = flowDir(270); // from the west -> blows east = three +x
    expect(x2).toBeCloseTo(1); expect(z2).toBeCloseTo(0);
  });
  it('strength grows with speed and saturates', () => {
    expect(windStrength(0)).toBe(0); expect(windStrength(8)).toBe(1); expect(windStrength(40)).toBe(1.8);
  });
  it('the flag banner geometry is unchanged (collision) and recognised as cloth', () => {
    const g = field.gates.find((x) => x.kind === 'flag')!;
    const banner = field.prims.find((p) => isFlagBanner(p) && p.tag === `gate${g.id}`)!;
    expect(banner.kind).toBe('box');
    if (banner.kind === 'box') { expect(banner.half.y).toBe(0.3); expect(banner.half.x).toBe(FLAG.thick); expect(banner.half.z).toBeCloseTo(g.height * 0.33); }
  });
  it('the windsock stands beside the pilot box, clear of everything, not between pilot and course', () => {
    const s = windsockSpot(field)!;
    expect(s).not.toBeNull();
    const pilot = field.pilot!;
    expect(Math.hypot(s.x - pilot.x, s.y - pilot.y)).toBeLessThan(25);
    expect(s.y).toBeLessThan(-38); // outside the safety net, on the pilots' side
    expect(windsockSpot({ ...field, ground: false })).toBeNull();
    // no course: beside the default pilot spot, but away from the spawn pad
    const b = bandoMap(), sb = windsockSpot(b)!;
    expect(Math.hypot(sb.x - b.spawn.pos.x, sb.y - b.spawn.pos.y)).toBeGreaterThan(6);
  });
});

describe('lighting', () => {
  it("'map' time of day reproduces the authored skies", () => {
    const e = environment(field);
    expect(e.sky).toBe('dusk'); expect(e.sunEl).toBe(12); expect(e.sunIntensity).toBe(4.2); expect(e.hemiIntensity).toBe(1.7);
    expect(e.floods).toBeGreaterThan(0); // the stadium's lights are on at golden hour
  });
  it('night: dark ambient, moonlight, floodlights full; map night sky via a cast works too', () => {
    const e = environment(field, 'night');
    expect(e.sky).toBe('night'); expect(e.floods).toBe(1); expect(e.hemiIntensity).toBeLessThan(0.6); expect(e.sunIntensity).toBeLessThan(0.5);
    expect(environment({ ...field, sky: 'night' as never }).sky).toBe('night');
  });
  it('time of day moves the sun and keeps an overcast map overcast', () => {
    expect(environment(field, 'noon').sunEl).toBeGreaterThan(50);
    expect(environment(field, 'dusk').sunEl).toBeLessThan(3);
    const bandoish = { ...field, sky: 'overcast' as const };
    expect(environment(bandoish, 'morning').sky).toBe('overcast');
  });
  it('one shadowless spot per floodlight tower, aimed at the course; map lights capped at 8', () => {
    expect(floodTowers(field).length).toBe(4);
    const l = buildLights(field, environment(field, 'night'));
    const spots = l.lights.filter((x) => (x as THREE.SpotLight).isSpotLight) as THREE.SpotLight[];
    expect(spots.length).toBe(4);
    for (const s of spots) { expect(s.castShadow).toBe(false); expect(s.target.position.y).toBeLessThan(1); }
    const many = { ...field, lights: Array.from({ length: 12 }, (_, i) => ({ pos: { x: i, y: 0, z: 3 }, color: 0xffaa66, intensity: 20, range: 15 })) };
    const pl = buildLights(many as MapDef, environment(field, 'noon')).lights.filter((x) => (x as THREE.PointLight).isPointLight);
    expect(pl.length).toBe(MAX_MAP_LIGHTS);
    expect(buildLights(field, environment(field, 'noon')).lights.length).toBe(0); // daytime: floods off
  });
});

describe('sun shadow', () => {
  it('the shadow box moves in whole texels (no shimmer), the light direction is unchanged', () => {
    const sun = new THREE.DirectionalLight();
    const sc = sun.shadow.camera as THREE.OrthographicCamera;
    sc.left = -45; sc.right = 45; sc.top = 45; sc.bottom = -45; sc.updateProjectionMatrix();
    sun.shadow.mapSize.set(2048, 2048);
    snapShadow(sun);
    const dir = new THREE.Vector3(0.4, 0.7, -0.3).normalize(), texel = 90 / 2048;
    const ref = new THREE.Vector3(), p = new THREE.Vector3();
    for (let k = 0; k < 20; k++) {
      const target = new THREE.Vector3(3.17 + k * 0.013, 1.2, -7.31 + k * 0.007);
      sun.target.position.copy(target); sun.position.copy(dir).multiplyScalar(120).add(target);
      sun.updateMatrixWorld(); sun.target.updateMatrixWorld();
      sun.shadow.updateMatrices(sun);
      // a fixed world point lands at a fixed sub-texel offset in shadow-map space
      p.set(1, 0, 1).applyMatrix4(sun.shadow.matrix);
      const fx = (p.x * 2048) % 1, fy = (p.y * 2048) % 1;
      if (k === 0) ref.set(fx, fy, 0);
      expect(Math.abs(fx - ref.x)).toBeLessThan(1e-3); expect(Math.abs(fy - ref.y)).toBeLessThan(1e-3);
      expect(new THREE.Vector3().subVectors(sun.position, sun.target.position).normalize().dot(dir)).toBeCloseTo(1, 6);
      expect(sun.target.position.distanceTo(target)).toBeLessThan(texel);
    }
  });
});

describe('clutter and crowd', () => {
  it('scatter is deterministic and avoids ground-standing primitives', () => {
    const spots = [{ x: field.spawn.pos.x, y: field.spawn.pos.y, r: 20 }];
    const a = clutterPoints(field, spots, 2), b = clutterPoints(field, spots, 2);
    expect(a.length).toBeGreaterThan(200); expect(a).toEqual(b);
    const pads = field.prims.filter((p) => p.tag === 'pad');
    for (const t of a) for (const p of pads) if (p.kind === 'box') expect(Math.abs(t.x - p.c.x) < p.half.x && Math.abs(t.y - p.c.y) < p.half.y).toBe(false);
  });
  it('spectators face the pitch and the arms are flagged for the shader', () => {
    expect(figureGeometry().getAttribute('aPart').itemSize).toBe(3);
    const people = (field.decor ?? []).filter((p) => p.tag === 'crowd').slice(0, 400) as never[];
    const crowd = buildCrowd(people, { x: 0, y: 0 }, makeWorldUniforms())!;
    const m = new THREE.Matrix4(), pos = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    for (const im of crowd.meshes) for (let i = 0; i < im.count; i++) {
      im.getMatrixAt(i, m); m.decompose(pos, q, s);
      const fwd = new THREE.Vector3(1, 0, 0).applyQuaternion(q); // three: figure faces +x
      const toCentre = new THREE.Vector3(-pos.x, 0, -pos.z).normalize();
      expect(fwd.dot(toCentre)).toBeGreaterThan(0.5);
    }
  });
});

describe('drone mesh', () => {
  it('prop colour is fixed per spec name', () => {
    expect(propColor('5" Freestyle 6S')).toBe(propColor('5" Freestyle 6S'));
    expect(PROP_COLORS).toContain(propColor('anything'));
    expect(new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(propColor)).size).toBeGreaterThan(1);
  });
  it('damage shortens blades; a broken prop has one snapped blade', () => {
    expect(bladeLengths(3, { thrust: 1, broken: false })).toEqual([1, 1, 1]);
    const chipped = bladeLengths(3, { thrust: 0.8, broken: false });
    expect(Math.min(...chipped)).toBeLessThan(1); expect(Math.min(...chipped)).toBeGreaterThan(0.45);
    expect(bladeLengths(2, { thrust: 0.5, broken: true })[0]).toBeLessThan(0.4);
  });
});

