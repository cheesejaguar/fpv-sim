// Rendering cost cuts that must not change the picture: the cube faces' rendered parts cover every
// direction the fisheye can sample, welded / indexed geometry draws the same triangles, the crowd's
// arms and the night lights are split the way the shaders expect, and the small layout helpers.
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buildDrone, DEFAULT_SPEC } from '../src/builder/derive';
import { VIDEO } from '../src/data/catalog';
import { MAPS } from '../src/maps/maps';
import { armsGeometry, armsUp, buildCrowd, figureGeometry } from '../src/render/crowd';
import { buildDroneMesh } from '../src/render/droneMesh';
import { autoCubeSize, cubeFaceRects, faceArea, FACE_GUARD, kbDistort, kbTheta, mountVibration, MOTION_REACH, ROT_CAP } from '../src/render/fpvCamera';
import { GOGGLE_BAND, goggleCanvasRows } from '../src/render/osdRenderer';
import { weldSoup } from '../src/render/quakeScene';
import { buildLights, buildSky, environment, floodTowers, SKY_RENDER_ORDER } from '../src/render/sky';
import { makeWorldUniforms } from '../src/render/sway';

/** Face cameras exactly as FpvCamera renders them (three's WebGL cube convention, fov -90°). */
function faceCams() {
  const cc = new THREE.CubeCamera(0.1, 10, new THREE.WebGLCubeRenderTarget(8));
  cc.coordinateSystem = THREE.WebGLCoordinateSystem; cc.updateCoordinateSystem(); cc.updateMatrixWorld(true);
  const cams = cc.children as THREE.PerspectiveCamera[];
  for (const c of cams) c.updateProjectionMatrix();
  return cams;
}

describe('cube face layout', () => {
  const cams = faceCams(), dirs = cams.map((c) => c.getWorldDirection(new THREE.Vector3()));
  // random direction within `angle` of a random point of the frame (seeded)
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const sample = (fovDeg: number, k: readonly number[], aspect: number, angle: number) => {
    const edge = rnd() < 0.5;
    let x = (rnd() - 0.5) * aspect, y = rnd() - 0.5;
    if (edge) { if (rnd() < 0.5) x = Math.sign(x || 1) * (aspect / 2); else y = Math.sign(y || 1) * 0.5; }
    const hd = kbDistort(THREE.MathUtils.degToRad(fovDeg) / 2, k), rc = Math.hypot(aspect, 1) / 2;
    const th = kbTheta((Math.hypot(x, y) / rc) * hd, k), ph = Math.atan2(y, x);
    const d = new THREE.Vector3(Math.sin(th) * Math.cos(ph), Math.sin(th) * Math.sin(ph), -Math.cos(th));
    const axis = new THREE.Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize();
    return d.applyAxisAngle(axis, angle * Math.sqrt(rnd()));
  };

  for (const v of VIDEO) {
    const aspect = v.kind === 'analog' ? 4 / 3 : 16 / 9;
    it(`${v.id}: every direction within the margin of the frame lands inside its face's part`, () => {
      for (const margin of [0.08, 0.2, ROT_CAP]) {
        const rects = cubeFaceRects(v.fovDeg, v.fisheyeK, aspect, margin, 32);
        expect(rects[4]).toBeNull(); // the face behind the lens (+z) is never needed
        for (let n = 0; n < 3000; n++) {
          const d = sample(v.fovDeg, v.fisheyeK, aspect, margin);
          let f = 0;
          dirs.forEach((w, i) => { if (w.dot(d) > dirs[f].dot(d)) f = i; });
          const p = d.clone().project(cams[f]), r = rects[f];
          expect(r).not.toBeNull();
          expect(p.x).toBeGreaterThanOrEqual(r!.x0 - 1e-9); expect(p.x).toBeLessThanOrEqual(r!.x1 + 1e-9);
          expect(p.y).toBeGreaterThanOrEqual(r!.y0 - 1e-9); expect(p.y).toBeLessThanOrEqual(r!.y1 + 1e-9);
        }
      }
    }, 30000);
  }

  it('slow motion renders far less of the cube than the old fixed layout (4.1 faces)', () => {
    const dji = VIDEO.find((v) => v.id === 'v-dji-o3')!, analog = VIDEO.find((v) => v.id === 'v-analog')!;
    const area = (v: typeof dji, m: number) => faceArea(cubeFaceRects(v.fovDeg, v.fisheyeK, v.kind === 'analog' ? 4 / 3 : 16 / 9, m, 32));
    expect(area(analog, 0.11)).toBeLessThan(3.1);
    expect(area(dji, 0.11)).toBeLessThan(2.6);
    // the full rotation cap is no worse than the old layout
    expect(area(analog, ROT_CAP)).toBeLessThan(4.25);
    expect(area(dji, ROT_CAP)).toBeLessThan(3.9);
    // margins grow monotonically; the smallest layout still holds the guard and a little motion
    expect(area(dji, 0.08)).toBeLessThan(area(dji, 0.2));
    expect(0.08 - FACE_GUARD).toBeGreaterThan(0.01 * MOTION_REACH);
  }, 30000);

  it('auto cube size: lower for analog only, never above 768', () => {
    const byId = (id: string) => VIDEO.find((v) => v.id === id)!;
    expect(autoCubeSize(byId('v-analog'))).toBe(640);
    expect(autoCubeSize(byId('v-analog-whoop'))).toBe(576);
    expect(autoCubeSize(byId('v-analog-pal'))).toBe(768);
    for (const v of VIDEO.filter((x) => x.kind === 'digital')) expect(autoCubeSize(v)).toBe(768);
    expect(autoCubeSize(byId('v-analog'), 2)).toBe(768);
    expect(autoCubeSize(byId('v-analog'), 0.5)).toBe(512);
  });

  it('kbTheta inverts kbDistort', () => {
    for (const v of VIDEO) for (const th of [0.1, 0.7, 1.3]) expect(kbTheta(kbDistort(th, v.fisheyeK), v.fisheyeK)).toBeCloseTo(th, 9);
  });
});

describe('geometry that draws the same triangles for less', () => {
  it('a welded triangle soup has the same triangles and fewer vertices', () => {
    // two quads sharing an edge, as 4 triangles of 3 vertices each
    const P = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 2, 0, 0, 2, 1, 0, 1, 0, 0, 2, 1, 0, 1, 1, 0];
    const pos = new Float32Array(P), uv = new Float32Array((P.length / 3) * 2).map((_, i) => P[Math.floor(i / 2) * 3 + (i % 2)]);
    const col = new Float32Array(P.length).fill(0.5);
    const w = weldSoup(pos, uv, col);
    expect(w.position.length / 3).toBe(6);
    for (let i = 0; i < w.index.length; i++) {
      const j = w.index[i];
      expect([...w.position.subarray(j * 3, j * 3 + 3)]).toEqual([...pos.subarray(i * 3, i * 3 + 3)]);
      expect([...w.uv.subarray(j * 2, j * 2 + 2)]).toEqual([...uv.subarray(i * 2, i * 2 + 2)]);
    }
    // a different colour at the same corner stays a separate vertex
    col[3 * 3] = 0.9;
    expect(weldSoup(pos, uv, col).position.length / 3).toBe(7);
  });

  it('crowd: indexed body (22 vertices), arms only for those who raise them (~1 in 8)', () => {
    expect(figureGeometry().index).not.toBeNull();
    expect(figureGeometry().getAttribute('position').count).toBe(22);
    expect(armsGeometry().getAttribute('position').count).toBe(16);
    const field = MAPS.field(), people = (field.decor ?? []).filter((p) => p.tag === 'crowd') as never[] as { c: { x: number; y: number } }[];
    const up = people.filter((p) => armsUp(p.c.x, -p.c.y)).length / people.length;
    expect(up).toBeGreaterThan(0.08); expect(up).toBeLessThan(0.17);
    const crowd = buildCrowd(people.slice(0, 600) as never[], { x: 0, y: 0 }, makeWorldUniforms())!;
    const counts = { body: 0, arms: 0 };
    for (const im of crowd.meshes) counts[im.geometry.getAttribute('position').count === 22 ? 'body' : 'arms'] += im.count;
    expect(counts.body).toBe(600);
    expect(counts.arms).toBe(people.slice(0, 600).filter((p) => armsUp(p.c.x, -p.c.y)).length);
  }, 30000);

  it('the quad: static parts merged per material, same triangles, the camera still hideable', () => {
    const b = buildDrone(DEFAULT_SPEC);
    const m = buildDroneMesh(b.spec, b.info, b.params.rotors.map((r) => ({ ...r.pos, dir: r.dir })), b.info.cgMm);
    let meshes = 0;
    m.root.traverse((o) => { if ((o as THREE.Mesh).isMesh) { meshes++; expect(o.castShadow).toBe(true); } });
    expect(meshes).toBeLessThan(30);
    expect(m.fpvHidden.length).toBeGreaterThan(0);
    for (const o of m.fpvHidden) expect(o.parent).toBe(m.root);
    expect(m.props.length).toBe(4);
  }, 30000);
});

describe('lights and sky', () => {
  it('a floodlit tower with its own map light is lit once (Night Session: 6 spots + 2 point lights)', () => {
    const night = MAPS.night(), l = buildLights(night, environment(night, 'map'));
    const spots = l.lights.filter((x) => (x as THREE.SpotLight).isSpotLight).length, points = l.lights.filter((x) => (x as THREE.PointLight).isPointLight).length;
    expect(floodTowers(night).length).toBe(6);
    expect(spots).toBe(6); expect(points).toBe(2);
    // the bulbs of all 8 map lights stay
    expect(l.objects.filter((o) => (o as THREE.Mesh).isMesh).length).toBe(8);
    // in daylight (no floods) the map's own lights are all there
    expect(buildLights(night, environment(night, 'noon')).lights.length).toBe(8);
  });

  it('both skies are drawn after every other opaque object', () => {
    const f = MAPS.field();
    for (const tod of ['map', 'night'] as const) {
      const env = environment(f, tod);
      expect(buildSky(env, new THREE.Vector3(0, 1, 0)).renderOrder).toBe(SKY_RENDER_ORDER);
    }
  });
});

describe('small helpers', () => {
  it('the goggle overlay canvas covers its band plus the text shadow', () => {
    for (const h of [480, 576, 720, 1440]) expect(goggleCanvasRows(h)).toBeGreaterThanOrEqual(Math.ceil(h * (GOGGLE_BAND + 0.015)));
  });
  it('mountVibration can fill a reused object', () => {
    const out = { amp: [9, 9, 9, 9], freq: [9, 9, 9, 9] };
    const r = mountVibration([20000, 20000, 20000, 20000], undefined, 20000, out);
    expect(r).toBe(out);
    expect(out.freq[0]).toBeCloseTo(20000 / 60, 9);
  });
});
