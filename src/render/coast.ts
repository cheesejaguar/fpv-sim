// Photo-real landscape layers for map packages, fetched only for maps that use them (scene.ts):
//
// - the drape: an aerial photo laid over the terrain (MapDef.drape). Up close the map's detail
//   texture (dirt / grass) modulates it, so the ground keeps texture where the photo's pixels are a
//   metre wide; outside the photo the detail texture alone shows.
// - the sea (MapDef.water): a water surface at the water level, coloured by the depth of the
//   terrain under it (clear and turquoise in the shallows, dark offshore), with foam along the shore,
//   moving swell and wind-ripple normals, the sun's glint and the sky reflected at grazing angles. A
//   ring around the map carries the open sea out to the horizon.
import * as THREE from 'three';
import type { MapDef } from '../maps/world';
import type { WorldUniforms } from './sway';

type Track = <T extends { dispose(): void }>(x: T) => T;

/** Water grid quads per side over the terrain (2.2 × map.size), and the open-sea ring's outer half-width (m). */
const WATER_N = 320, SEA_HALF = 6000;

export function addCoast(scene: THREE.Scene, map: MapDef, tiles: THREE.Mesh[], skyColor: number, u: WorldUniforms, track: Track) {
  if (map.drape && tiles.length) {
    const detail = (tiles[0].material as THREE.MeshStandardMaterial).map;
    const mat = track(drapeMaterial(map.drape, detail, track));
    for (const t of tiles) t.material = mat;
  }
  if (map.water) for (const m of seaMeshes(map, skyColor, u, track)) scene.add(m);
}

// ---------------------------------------------------------------------------------------------
// Drape

const DRAPE_MAP = /* glsl */ `
#ifdef USE_MAP
  // terrain uv = ENU metres / 3 (ground.ts terrainTiles)
  vec2 dW = vMapUv * 3.0, dUv = (dW - uDrapeRect.xy) * uDrapeRect.zw;
  float dIn = step(0.0, dUv.x) * step(dUv.x, 1.0) * step(0.0, dUv.y) * step(dUv.y, 1.0);
  vec3 dPhoto = texture2D(map, clamp(dUv, 0.0, 1.0)).rgb;
  vec3 dDet = texture2D(uDetail, vMapUv).rgb, dMean = textureLod(uDetail, vec2(0.5), 12.0).rgb;
  // detail luminance relative to its own mean: ~1 on average, so the photo keeps its colour
  float dL = dot(dDet, vec3(0.299, 0.587, 0.114)) / max(1e-3, dot(dMean, vec3(0.299, 0.587, 0.114)));
  float dNear = (1.0 - smoothstep(20.0, 140.0, length(vViewPosition))) * uDrapeDetail;
  vec3 dCol = mix(dDet, dPhoto * mix(1.0, dL, dNear), dIn);
  // cliffs: a photo taken from above smears down a steep face; show weathered rock there instead
  // (world-space normal of the interpolated vertex normal: rotation part of the view matrix, transposed)
  float dUp = (vec4(normalize(vNormal), 0.0) * viewMatrix).y;
  float dRock = (1.0 - smoothstep(0.5, 0.78, dUp)) * dIn;
  vec3 dStone = mix(vec3(0.085, 0.078, 0.07), dPhoto * 0.6, 0.35) * mix(1.0, dL, 0.8);
  diffuseColor.rgb *= mix(dCol, dStone, dRock);
#endif`;

function drapeMaterial(d: NonNullable<MapDef['drape']>, detail: THREE.Texture | null, track: Track): THREE.MeshStandardMaterial {
  const photo = track(new THREE.TextureLoader().load(d.url));
  photo.colorSpace = THREE.SRGBColorSpace; photo.anisotropy = 8;
  photo.wrapS = photo.wrapT = THREE.ClampToEdgeWrapping;
  const m = new THREE.MeshStandardMaterial({ map: photo, roughness: 0.95 });
  const uniforms = { uDetail: { value: detail ?? photo }, uDrapeRect: { value: new THREE.Vector4(d.x0, d.y0, 1 / d.w, 1 / d.h) }, uDrapeDetail: { value: detail ? d.detail : 0 } };
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <map_pars_fragment>', '#include <map_pars_fragment>\nuniform sampler2D uDetail;\nuniform vec4 uDrapeRect;\nuniform float uDrapeDetail;')
      .replace('#include <map_fragment>', DRAPE_MAP);
  };
  m.customProgramCacheKey = () => 'ground-drape';
  return m;
}

// ---------------------------------------------------------------------------------------------
// Sea

const SEA_VS_PARS = /* glsl */ `
attribute float aDepth;
varying float vDepth;
varying vec2 vSeaW;`;
const SEA_VS = /* glsl */ `
#include <worldpos_vertex>
vDepth = aDepth;
vSeaW = (modelMatrix * vec4(transformed, 1.0)).xz;`;

const SEA_FS_PARS = /* glsl */ `
uniform vec4 uWind;
uniform vec3 uSeaSky, uSeaShallow, uSeaDeep;
varying float vDepth;
varying vec2 vSeaW;
float sHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float sNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p), w = f * f * (3.0 - 2.0 * f);
  return mix(mix(sHash(i), sHash(i + vec2(1, 0)), w.x), mix(sHash(i + vec2(0, 1)), sHash(i + vec2(1, 1)), w.x), w.y);
}
// slope (d height / d x, d height / d z) of a few directional waves: swell from the west, wind chop
vec2 sWaves(vec2 p, float t, float dist) {
  vec2 g = vec2(0.0);
  vec4 W[5];
  W[0] = vec4(0.97, 0.24, 42.0, 0.20); W[1] = vec4(0.88, -0.47, 17.0, 0.11); W[2] = vec4(0.62, 0.78, 7.5, 0.06);
  W[3] = vec4(-0.31, 0.95, 3.1, 0.03); W[4] = vec4(0.12, -0.99, 1.4, 0.015);
  for (int i = 0; i < 5; i++) {
    vec2 dir = W[i].xy; float k = 6.2831853 / W[i].z, c = sqrt(9.81 / k);
    // a wave fades out before it is under ~2 px (no moire on far water)
    g += dir * W[i].w * k * cos(dot(dir, p) * k - c * k * t) * (1.0 - smoothstep(W[i].z * 12.0, W[i].z * 40.0, dist));
  }
  return g;
}`;
const SEA_COLOR = /* glsl */ `
float sD = max(vDepth, 0.0), sT = uWind.w;
diffuseColor.rgb = mix(uSeaShallow, uSeaDeep, smoothstep(0.0, 9.0, sD));
diffuseColor.a = mix(0.45, 0.97, smoothstep(0.0, 4.0, sD));
// surf: a broken band along the shore that washes in and out
float sFoam = smoothstep(1.6, 0.1, sD + 0.5 * sin(sT * 0.9 + vSeaW.x * 0.05 + vSeaW.y * 0.03));
sFoam *= smoothstep(0.35, 0.75, sNoise(vSeaW * 0.6 + vec2(sT * 0.3, 0.0)) * 0.6 + sNoise(vSeaW * 2.3 - sT * 0.2) * 0.4 + sFoam * 0.3);
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.85, 0.88, 0.88), sFoam);
diffuseColor.a = max(diffuseColor.a, sFoam);`;
const SEA_NORMAL = /* glsl */ `
#include <normal_fragment_maps>
{
  float sDist = length(vViewPosition);
  vec2 sG = sWaves(vSeaW, sT, sDist) * (0.6 + 0.4 * uWind.z);
  // fine ripples (wind), fading with distance so far water does not sparkle
  float sFar = 1.0 - smoothstep(15.0, 70.0, sDist);
  vec2 q = vSeaW * 1.7 + uWind.xy * sT * 0.9;
  sG += (vec2(sNoise(q + 3.1), sNoise(q.yx - 7.4)) - 0.5) * 0.35 * sFar * (0.4 + uWind.z);
  normal = normalize((viewMatrix * vec4(normalize(vec3(-sG.x, 1.0, -sG.y)), 0.0)).xyz);
}`;
const SEA_OUT = /* glsl */ `
{
  float sF = 0.02 + 0.98 * pow(1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0), 5.0);
  outgoingLight = mix(outgoingLight, uSeaSky, sF * (1.0 - sFoam) * 0.85);
}
#include <opaque_fragment>`;

function seaMaterial(map: MapDef, skyColor: number, u: WorldUniforms): THREE.MeshStandardMaterial {
  const deep = new THREE.Color(map.water!.color ?? 0x0f3440);
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.12, metalness: 0, transparent: true });
  const uniforms = {
    uWind: u.uWind, uSeaSky: { value: new THREE.Color(skyColor) },
    uSeaDeep: { value: deep }, uSeaShallow: { value: deep.clone().lerp(new THREE.Color(0x3f8f86), 0.75) },
  };
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\n' + SEA_VS_PARS).replace('#include <worldpos_vertex>', SEA_VS);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + SEA_FS_PARS)
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + SEA_COLOR)
      .replace('#include <normal_fragment_maps>', SEA_NORMAL)
      .replace('#include <opaque_fragment>', SEA_OUT);
  };
  m.customProgramCacheKey = () => 'sea';
  return m;
}

/** The water grid over the terrain (depth per vertex) and the open-sea ring around it (three.js coordinates). */
export function seaGeometries(map: MapDef, N = WATER_N): THREE.BufferGeometry[] {
  const L = map.water!.level, S = map.size * 2.2, step = S / N, W = N + 1;
  const pos = new Float32Array(W * W * 3), depth = new Float32Array(W * W), idx: number[] = [];
  for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
    const x = -S / 2 + i * step, z = -S / 2 + j * step, k = j * W + i;
    pos.set([x, L, z], k * 3);
    depth[k] = L - map.terrain(x, -z);
  }
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const p = j * W + i;
    // skip quads with dry land under all four corners (the terrain hides them anyway)
    if (depth[p] < -2 && depth[p + 1] < -2 && depth[p + W] < -2 && depth[p + W + 1] < -2) continue;
    idx.push(p, p + W, p + 1, p + W, p + W + 1, p + 1);
  }
  const grid = new THREE.BufferGeometry();
  grid.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  grid.setAttribute('aDepth', new THREE.BufferAttribute(depth, 1));
  grid.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(W * W * 3).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  grid.setIndex(idx);
  grid.computeBoundingSphere();
  // ring: inner square = the grid's edge, outer square far beyond the camera's far plane; edge depth carried out
  const a = S / 2, b = SEA_HALF, edge = (x: number, z: number) => Math.max(20, L - map.terrain(x, -z));
  const rp = [-a, -a, a, -a, a, a, -a, a, -b, -b, b, -b, b, b, -b, b].flatMap((v, i, arr) => (i % 2 ? [] : [v, L, arr[i + 1]]));
  const rd = [edge(-a, -a), edge(a, -a), edge(a, a), edge(-a, a), 40, 40, 40, 40];
  const ring = new THREE.BufferGeometry();
  ring.setAttribute('position', new THREE.Float32BufferAttribute(rp, 3));
  ring.setAttribute('aDepth', new THREE.Float32BufferAttribute(rd, 1));
  ring.setAttribute('normal', new THREE.Float32BufferAttribute(rp.map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  ring.setIndex([0, 4, 1, 1, 4, 5, 1, 5, 2, 2, 5, 6, 2, 6, 3, 3, 6, 7, 3, 7, 0, 0, 7, 4]);
  ring.computeBoundingSphere();
  return [grid, ring];
}

function seaMeshes(map: MapDef, skyColor: number, u: WorldUniforms, track: Track): THREE.Mesh[] {
  const mat = track(seaMaterial(map, skyColor, u));
  return seaGeometries(map).map((g) => {
    const m = new THREE.Mesh(track(g), mat);
    m.receiveShadow = true; m.name = 'terrain'; m.renderOrder = 1;
    return m;
  });
}
