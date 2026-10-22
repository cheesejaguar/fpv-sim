// Sky, sun / moon, ambient and fog for a map and a time of day, plus the lights that matter after
// sunset: stadium floodlights (aimed spots, no shadows, found from the map's `flood` lamp panels)
// and a map's own point lights (MapDef.lights, at most 8). The day skies keep the original look of
// each map ('map' time of day reproduces the previous lighting exactly); 'night' is a dark sky with
// a moon and stars, moonlight as the shadow-casting light and very little ambient.
import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { MAX_MAP_LIGHTS, type MapDef, type Prim } from '../maps/world';

export type TimeOfDay = 'map' | 'morning' | 'noon' | 'golden' | 'dusk' | 'night';
export type SkyKind = 'clear' | 'overcast' | 'dusk' | 'night';

export interface Environment {
  sky: SkyKind;
  /** sun (moon at night): azimuth from north clockwise, elevation (deg) */
  sunAz: number; sunEl: number;
  sunColor: number; sunIntensity: number;
  hemiSky: number; hemiGround: number; hemiIntensity: number;
  fogColor: number; fogDensity: number;
  turbidity: number; rayleigh: number; mie: number; skyScale: number;
  /** floodlights: 0 off .. 1 full (night) */
  floods: number;
}


const BASE: Record<Exclude<SkyKind, 'night'>, Omit<Environment, 'sky' | 'sunAz' | 'sunEl' | 'floods'>> = {
  clear: { sunColor: 0xfff1dd, sunIntensity: 4.5, hemiSky: 0xbfd9ff, hemiGround: 0x56603e, hemiIntensity: 1.9, fogColor: 0xbcd0e0, fogDensity: 0.0022, turbidity: 4, rayleigh: 1.4, mie: 0.006, skyScale: 0.3 },
  overcast: { sunColor: 0xfff1dd, sunIntensity: 2.2, hemiSky: 0xb8c2cc, hemiGround: 0x5a5650, hemiIntensity: 2.6, fogColor: 0xa9b0b5, fogDensity: 0.0045, turbidity: 12, rayleigh: 3.5, mie: 0.02, skyScale: 0.45 },
  dusk: { sunColor: 0xffc286, sunIntensity: 4.2, hemiSky: 0xc9c4dc, hemiGround: 0x5a4a38, hemiIntensity: 1.7, fogColor: 0xd6b8a0, fogDensity: 0.0022, turbidity: 7, rayleigh: 2.2, mie: 0.009, skyScale: 0.3 },
};
const NIGHT: Omit<Environment, 'sky' | 'sunAz' | 'sunEl' | 'floods'> = {
  sunColor: 0x9fb4e0, sunIntensity: 0.32, hemiSky: 0x34405e, hemiGround: 0x0c0c10, hemiIntensity: 0.5, fogColor: 0x0b0f19, fogDensity: 0.0035, turbidity: 2, rayleigh: 1, mie: 0.005, skyScale: 0.3,
};

const scaleHex = (c: number, k: number) => new THREE.Color(c).multiplyScalar(k).getHex();

/** Lighting for a map at a time of day ('map' = as the map was authored). */
export function environment(map: MapDef, tod: TimeOfDay = 'map'): Environment {
  const authored: SkyKind = map.sky;
  const overcast = authored === 'overcast';
  const fog = (e: Environment): Environment => {
    if (!map.fog) return e;
    // a map's own fog keeps its density; at night its colour goes dark with everything else
    return { ...e, fogDensity: map.fog.density, fogColor: e.sky === 'night' ? scaleHex(map.fog.color, 0.08) : e.sky === 'dusk' && tod === 'dusk' ? scaleHex(map.fog.color, 0.6) : map.fog.color };
  };
  if (tod === 'night' || (tod === 'map' && authored === 'night')) {
    return fog({ ...NIGHT, sky: 'night', sunAz: tod === 'map' ? map.sun.azimuthDeg : 140, sunEl: tod === 'map' ? Math.max(15, map.sun.elevationDeg) : 38, floods: 1 });
  }
  if (tod === 'map') {
    const k = authored === 'overcast' || authored === 'dusk' ? authored : 'clear';
    return fog({ ...BASE[k], sky: k, sunAz: map.sun.azimuthDeg, sunEl: map.sun.elevationDeg, floods: k === 'dusk' ? 0.3 : 0 });
  }
  // time-of-day override: clouds stay as authored, the sun moves and the light changes colour
  const sky: SkyKind = overcast ? 'overcast' : tod === 'golden' || tod === 'dusk' ? 'dusk' : 'clear';
  const b = BASE[sky], dim = overcast ? 0.55 : 1;
  switch (tod) {
    case 'morning': return fog({ ...b, sky, sunAz: 100, sunEl: 18, sunColor: overcast ? b.sunColor : 0xffe4c4, sunIntensity: 3.8 * dim, hemiIntensity: b.hemiIntensity * 0.92, fogColor: overcast ? b.fogColor : 0xc6d3e2, floods: 0 });
    case 'noon': return fog({ ...b, sky, sunAz: 180, sunEl: 62, sunColor: overcast ? b.sunColor : 0xfff6ea, sunIntensity: 4.8 * dim, hemiIntensity: b.hemiIntensity * 1.05, floods: 0 });
    case 'golden': return fog({ ...b, sky, sunAz: authored === 'dusk' ? map.sun.azimuthDeg : 250, sunEl: 9, sunIntensity: 4 * dim, floods: 0.3 });
    case 'dusk': return fog({
      ...b, sky, sunAz: authored === 'dusk' ? map.sun.azimuthDeg : 262, sunEl: 1.5, sunColor: 0xff9356, sunIntensity: 1.8 * dim,
      hemiSky: 0x8d82b0, hemiGround: 0x3a3028, hemiIntensity: 1.0 * dim, fogColor: overcast ? 0x6e6a70 : 0x9a8890, turbidity: 5, rayleigh: 2.6, mie: 0.008, skyScale: 0.26, floods: 0.75,
    });
  }
  return fog({ ...BASE.clear, sky: 'clear', sunAz: map.sun.azimuthDeg, sunEl: map.sun.elevationDeg, floods: 0 });
}

/** Unit vector (three space) towards a sky position: azimuth from north (three -z) clockwise. */
export function skyDir(azDeg: number, elDeg: number, out = new THREE.Vector3()): THREE.Vector3 {
  const phi = THREE.MathUtils.degToRad(90 - elDeg), theta = THREE.MathUtils.degToRad(azDeg);
  return out.set(Math.sin(phi) * Math.sin(theta), Math.cos(phi), -Math.sin(phi) * Math.cos(theta));
}

const NIGHT_VS = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww; // on the far plane
}`;
const NIGHT_FS = /* glsl */ `
varying vec3 vDir;
uniform vec3 moonDir;
float h3(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
void main() {
  vec3 d = normalize(vDir);
  float up = d.y;
  // linear radiance: deep blue zenith, a little sky glow (towns, airglow) on the horizon
  vec3 c = mix(vec3(0.010, 0.014, 0.028), vec3(0.0025, 0.0045, 0.012), smoothstep(-0.02, 0.55, up));
  c += vec3(0.05, 0.035, 0.022) * exp(-max(up, 0.0) * 14.0) * 0.5;
  // stars: one candidate per cell of a 3D grid on the sphere, ~1.5 cube-map texels wide
  vec3 p = d * 260.0, cell = floor(p);
  float h = h3(cell);
  if (h > 0.985 && up > 0.0) {
    vec3 sp = cell + 0.5 + (vec3(h3(cell + 7.1), h3(cell + 3.7), h3(cell + 1.3)) - 0.5) * 0.6;
    float s = smoothstep(0.55, 0.0, length(p - sp)) * (h - 0.985) / 0.015;
    c += vec3(0.9, 0.95, 1.0) * s * s * 1.6 * smoothstep(0.0, 0.15, up);
  }
  // moon: a ~0.6 deg disc and a soft halo
  float m = dot(d, moonDir);
  c += vec3(1.0, 0.97, 0.9) * 1.8 * smoothstep(0.99993, 0.99996, m);
  c += vec3(0.25, 0.28, 0.36) * pow(max(m, 0.0), 900.0) * 0.35 + vec3(0.03, 0.035, 0.05) * pow(max(m, 0.0), 30.0);
  // below the horizon: the dark ground (the terrain covers it where there is one)
  c = mix(c, vec3(0.004, 0.004, 0.005), smoothstep(0.0, -0.04, up));
  gl_FragColor = vec4(c, 1.0);
}`;

/**
 * Draw order of the sky domes: after every other opaque object. Both write their depth on the far
 * plane, so drawn last they only shade the pixels nothing else covered (early depth test) instead of
 * running the sky shader under the whole picture and painting over it. three sorts opaque objects
 * by material id before distance, and the sky's material is the scene's first: it used to be drawn
 * first, under everything (indoors: on every pixel of every cube face, for nothing).
 */
export const SKY_RENDER_ORDER = 1000;

/** The sky dome: three's Sky (scaled into proportion with the lit ground) by day, the night sky at night. */
export function buildSky(env: Environment, sunDir: THREE.Vector3): THREE.Mesh {
  if (env.sky === 'night') {
    const m = new THREE.Mesh(new THREE.SphereGeometry(2500, 32, 16), new THREE.ShaderMaterial({
      vertexShader: NIGHT_VS, fragmentShader: NIGHT_FS, side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { moonDir: { value: sunDir.clone() } },
    }));
    m.frustumCulled = false; m.renderOrder = SKY_RENDER_ORDER;
    return m;
  }
  const sky = new Sky();
  sky.scale.setScalar(4000);
  const u = sky.material.uniforms;
  u.turbidity.value = env.turbidity; u.rayleigh.value = env.rayleigh; u.mieCoefficient.value = env.mie; u.mieDirectionalG.value = 0.85;
  u.sunPosition.value.copy(sunDir);
  // Sky.js radiance is ~10x the sunlit-ground radiance our lights produce; real sunlit grass and
  // clear sky have comparable luminance, so scale the sky into proportion for the camera model.
  sky.material.uniforms.skyScale = { value: env.skyScale };
  sky.material.fragmentShader = 'uniform float skyScale;\n' + sky.material.fragmentShader.replace('gl_FragColor = vec4( texColor, 1.0 );', 'gl_FragColor = vec4( texColor * skyScale, 1.0 );');
  sky.material.needsUpdate = true;
  sky.renderOrder = SKY_RENDER_ORDER;
  return sky;
}

/** Lamp positions of a map's floodlight towers: `flood`-tagged panels grouped per tower (ENU). */
export function floodTowers(map: MapDef): { x: number; y: number; z: number }[] {
  const towers: { x: number; y: number; z: number; n: number }[] = [];
  for (const p of [...map.prims, ...(map.decor ?? [])] as Prim[]) {
    if (p.tag !== 'flood' || p.kind === 'brush') continue;
    let t = towers.find((q) => Math.hypot(q.x / q.n - p.c.x, q.y / q.n - p.c.y) < 12);
    if (!t) towers.push((t = { x: 0, y: 0, z: 0, n: 0 }));
    t.x += p.c.x; t.y += p.c.y; t.z += p.c.z; t.n++;
  }
  return towers.slice(0, 6).map((t) => ({ x: t.x / t.n, y: t.y / t.n, z: t.z / t.n }));
}

/** Where the floodlights aim: the middle of the course (gates), else the spawn (ENU, on the ground). */
export function courseCentre(map: MapDef): { x: number; y: number; z: number } {
  const g = map.gates;
  const x = g.length ? g.reduce((s, q) => s + q.c.x, 0) / g.length : map.spawn.pos.x;
  const y = g.length ? g.reduce((s, q) => s + q.c.y, 0) / g.length : map.spawn.pos.y;
  return { x, y, z: map.terrain(x, y) };
}

export interface NightLights { lights: THREE.Light[]; objects: THREE.Object3D[]; dispose(): void }

/**
 * Floodlights (one shadowless spot per tower, calibrated to ~0.25 lux-units each at the course
 * centre at full output, wide penumbra so the near corner isn't burnt out) and the map's point
 * lights with a small glowing bulb each. Lights go straight into the scene root: the FPV camera's
 * near pass hides every non-light child, and the quad must stay lit there.
 */
export function buildLights(map: MapDef, env: Environment): NightLights {
  const lights: THREE.Light[] = [], objects: THREE.Object3D[] = [], disp: { dispose(): void }[] = [];
  if (env.floods > 0) {
    const c = courseCentre(map), target = new THREE.Vector3(c.x, c.z, -c.y);
    for (const t of floodTowers(map)) {
      const pos = new THREE.Vector3(t.x, t.z, -t.y), d = pos.distanceTo(target), cos = Math.max(0.2, (pos.y - target.y) / d);
      const spot = new THREE.SpotLight(0xfff1dc, (0.25 * d * d / cos) * env.floods, 0, THREE.MathUtils.degToRad(66), 0.9, 2);
      spot.position.copy(pos); spot.target.position.copy(target);
      spot.castShadow = false;
      lights.push(spot); objects.push(spot.target);
    }
  }
  const ml = (map.lights ?? []).slice(0, MAX_MAP_LIGHTS);
  if (ml.length) {
    const bulbGeo = new THREE.SphereGeometry(0.07, 10, 6); disp.push(bulbGeo);
    for (const l of ml) {
      const pl = new THREE.PointLight(l.color, l.intensity, l.range, 2);
      pl.position.set(l.pos.x, l.pos.z, -l.pos.y);
      lights.push(pl);
      const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(l.color).multiplyScalar(4) }); disp.push(mat); // HDR: blooms in the FPV camera
      const bulb = new THREE.Mesh(bulbGeo, mat); bulb.position.copy(pl.position);
      objects.push(bulb);
    }
  }
  return { lights, objects, dispose() { for (const l of lights) l.dispose(); for (const d of disp) d.dispose(); } };
}
