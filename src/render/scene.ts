// Builds the Three.js scene for a MapDef: tiled terrain with an anti-repeat ground shader and near
// clutter, primitives (merged per material), render-only decor (crowd figures instanced), instanced
// leaf-card trees with LOD, gates (a mesh set each so the next gate can glow; flag banners as waving
// cloth), a windsock, sky / sun / moon for the time of day with floodlights and map lights after
// dark, a texel-snapped sun shadow, and fog. Wind animation and LOD run on shared uniforms (sway.ts).
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { gateIdOf, isFlagBanner } from '../maps/gates';
import { BoxPrim, MapDef, Prim } from '../maps/world';
import { buildCrowd } from './crowd';
import { buildClutter, groundMaterial, terrainTiles } from './ground';
import { addQuakeLevel } from './quakeScene';
import { buildLights, buildSky, courseCentre, Environment, environment, skyDir, TimeOfDay } from './sky';
import { flowDir, makeWorldUniforms, NO_LOD, windStrength } from './sway';
import { brickTexture, concreteTexture, dirtTexture, foliageAtlas, gateTexture, grassTexture, grassTuftTexture, macroNoiseTexture, metalTexture, netTexture, padTexture, pitchTexture, textTexture, woodTexture } from './textures';
import { buildTrees } from './trees';
import { buildWindsock, clothMaterials, flagCloth, windsockSpot } from './windVisuals';

export type { TimeOfDay } from './sky';
export interface SceneOptions {
  /** 'map' (default) lights the map as authored; the others move the sun / switch to night. */
  timeOfDay?: TimeOfDay;
}

export interface SceneBundle {
  scene: THREE.Scene;
  /** the shadow-casting sky light (the moon at night) */
  sun: THREE.DirectionalLight;
  sunDir: THREE.Vector3;
  /** sky ambient; its base intensity is scaled down where the sky is hidden (interiors) */
  hemi: THREE.HemisphereLight;
  hemiBase: number;
  gateMeshes: THREE.Object3D[];
  /** the lighting in use (time of day resolved) */
  env: Environment;
  /** Light up gate index `next` (and, dimmer, the one after); on = false leaves every gate normal. t in s. */
  setGateHighlight(next: number, on: boolean, t: number): void;
  /**
   * Wind for the visuals (flags, trees, grass, windsock, crowd motion): speed (m/s), direction it
   * blows FROM (deg, 0 = north, as SimSettings.wind), time (s). Call every frame; smoothed here.
   */
  setWind(speedMs: number, dirDeg: number, t: number): void;
  dispose(): void;
}

const HIGHLIGHT = 0x5dff3a, NEXT2 = 0xffb020;
/** Sun shadow box half-size (m) and resolution. */
const SHADOW_HALF = 45, SHADOW_RES = 2048;

interface GateVisual {
  id: number;
  frameMat: THREE.MeshStandardMaterial; ledMat: THREE.MeshBasicMaterial; ledBase: number;
  glow: THREE.Mesh; glowMat: THREE.MeshBasicMaterial; beam: THREE.Mesh; beamMat: THREE.MeshBasicMaterial;
  cloth: THREE.MeshStandardMaterial | null;
  state: number;
}

type SolidPrim = Exclude<Prim, { kind: 'brush' }>;
const _q = new THREE.Quaternion(), _qp = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(1, 1, 1);
const Y_AXIS = new THREE.Vector3(0, 1, 0), Z_AXIS = new THREE.Vector3(0, 0, 1);
/**
 * Three-space matrix of a primitive's local frame, matching PrimitiveWorld's collision frames:
 * boxes yaw about ENU z, then pitch about their local y (ENU y = three -Z); cylinders stand on c.
 */
export function primMatrix(pr: SolidPrim, out: THREE.Matrix4): THREE.Matrix4 {
  if (pr.kind === 'box') {
    _q.setFromAxisAngle(Y_AXIS, pr.yaw);
    if (pr.pitch) _q.multiply(_qp.setFromAxisAngle(Z_AXIS, -pr.pitch));
    _p.set(pr.c.x, pr.c.z, -pr.c.y);
  } else {
    _q.identity();
    _p.set(pr.c.x, pr.kind === 'cyl' ? pr.c.z + pr.h / 2 : pr.c.z, -pr.c.y);
  }
  return out.compose(_p, _q, _s);
}

/** Vertical light shaft above a gate: open cylinder fading out with height (vertex colours). */
function lightBeamGeometry(): THREE.BufferGeometry {
  const H = 26, g = new THREE.CylinderGeometry(0.1, 0.32, H, 12, 8, true);
  g.translate(0, H / 2 + 0.3, 0);
  const pos = g.getAttribute('position'), c = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) { const f = Math.pow(1 - pos.getY(i) / (H + 0.3), 1.6); c[i * 3] = c[i * 3 + 1] = c[i * 3 + 2] = f; }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return g;
}

function boxGeometryWorldUV(sx: number, sy: number, sz: number, texel = 2): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(sx, sy, sz);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  const dims: [number, number][] = [[sz, sy], [sz, sy], [sx, sz], [sx, sz], [sx, sy], [sx, sy]];
  for (let f = 0; f < 6; f++) for (let v = 0; v < 4; v++) {
    const i = f * 4 + v;
    uv.setXY(i, (uv.getX(i) * dims[f][0]) / texel, (uv.getY(i) * dims[f][1]) / texel);
  }
  return g;
}

/** Repeating sRGB texture from an image URL (map packages). */
function imageTexture(url: string): THREE.Texture {
  const t = new THREE.TextureLoader().load(url);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/**
 * Shadows fade out over the outer ~9 % of the sun's shadow box instead of ending in a hard line
 * (the box follows the quad, so that line used to sweep across the ground and pop shadows). A
 * global chunk patch, applied once, to the directional / spot shadow lookups only.
 */
function patchShadowFade() {
  const chunks = THREE.ShaderChunk as unknown as Record<string, string>, k = 'shadowmap_pars_fragment', src = chunks[k];
  const ret = 'return mix( 1.0, shadow, shadowIntensity );', cut = src.indexOf('float getPointShadow');
  if (src.includes('sfEdge') || !src.includes(ret)) return;
  const head = cut > 0 ? src.slice(0, cut) : src, tail = cut > 0 ? src.slice(cut) : '';
  chunks[k] = head.split(ret).join('vec2 sfEdge = abs( shadowCoord.xy * 2.0 - 1.0 );\n\t\t\tshadow = mix( shadow, 1.0, smoothstep( 0.82, 1.0, max( sfEdge.x, sfEdge.y ) ) );\n\t\t\t' + ret) + tail;
}

/**
 * Snap the sun's shadow box to whole shadow-map texels in the light's view plane: the box follows
 * the quad, and sub-texel moves made every shadow edge shimmer. Light and target move together, so
 * the light direction is unchanged.
 */
export function snapShadow(sun: THREE.DirectionalLight) {
  const sh = sun.shadow, base = sh.updateMatrices.bind(sh), texel = (2 * SHADOW_HALF) / SHADOW_RES;
  const r = new THREE.Vector3(), up = new THREE.Vector3(), t = new THREE.Vector3();
  sh.updateMatrices = (light: THREE.Light) => {
    base(light); // orients the shadow camera (its axes depend only on the sun direction)
    const e = sh.camera.matrixWorld.elements, l = light as THREE.DirectionalLight;
    r.set(e[0], e[1], e[2]); up.set(e[4], e[5], e[6]);
    t.setFromMatrixPosition(l.target.matrixWorld);
    const a = t.dot(r), b = t.dot(up), da = Math.round(a / texel) * texel - a, db = Math.round(b / texel) * texel - b;
    if (da === 0 && db === 0) return;
    t.copy(r).multiplyScalar(da).addScaledVector(up, db);
    l.position.add(t); l.target.position.add(t);
    l.updateMatrixWorld(); l.target.updateMatrixWorld();
    base(light);
  };
}

/** Dispose everything a (late-loading) glTF scene holds: geometry, materials and their textures. */
function disposeObject(root: THREE.Object3D) {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.geometry.dispose();
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
      for (const v of Object.values(mat)) if (v instanceof THREE.Texture) { v.dispose(); (v.image as { close?: () => void } | null)?.close?.(); }
      mat.dispose();
    }
  });
}

export function buildScene(map: MapDef, opts: SceneOptions = {}): SceneBundle {
  patchShadowFade();
  const scene = new THREE.Scene();
  const disposables: { dispose(): void }[] = [];
  const track = <T extends { dispose(): void }>(x: T) => (disposables.push(x), x);
  const u = makeWorldUniforms();
  const env = environment(map, opts.timeOfDay ?? 'map');

  // ---- sky / light ----
  const sunDir = skyDir(env.sunAz, env.sunEl);
  const sky = buildSky(env, sunDir);
  track(sky.geometry); track(sky.material as THREE.Material);
  sky.userData.gt = 'skip'; // ground truth: the sky is where nothing is hit
  scene.add(sky);
  const hemi = new THREE.HemisphereLight(env.hemiSky, env.hemiGround, env.hemiIntensity);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(env.sunColor, env.sunIntensity);
  sun.position.copy(sunDir).multiplyScalar(120);
  sun.castShadow = true;
  sun.shadow.mapSize.set(SHADOW_RES, SHADOW_RES);
  const sc = sun.shadow.camera as THREE.OrthographicCamera;
  sc.left = -SHADOW_HALF; sc.right = SHADOW_HALF; sc.top = SHADOW_HALF; sc.bottom = -SHADOW_HALF; sc.near = 1; sc.far = 400;
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.03;
  snapShadow(sun);
  scene.add(sun, sun.target);
  track(sun); // DirectionalLight.dispose() frees the shadow map render target
  scene.fog = new THREE.FogExp2(env.fogColor, env.fogDensity);
  const night = buildLights(map, env);
  track(night);
  for (const l of night.lights) scene.add(l);
  for (const o of night.objects) { o.userData.gt ??= 'object'; scene.add(o); }

  // ---- terrain: tiles (each cube face culls what it doesn't see), anti-repeat ground ----
  if (map.ground !== false) {
    const builtin = !map.groundTexture, grass = map.groundMat === 'grass';
    const groundTex = track(builtin ? (grass ? grassTexture() : dirtTexture()) : imageTexture(map.groundTexture!));
    // the stadium's painted pitch is part of the ground's own shading (no second lit pass over it)
    const pitch = map.id === 'field' || (map as unknown as { pitch?: boolean }).pitch ? { tex: track(pitchTexture(120, 73)), w: 120, h: 73 } : undefined;
    const mat = track(groundMaterial(groundTex, track(macroNoiseTexture()), builtin, grass, pitch));
    for (const g of terrainTiles(map)) {
      const tile = new THREE.Mesh(track(g), mat);
      tile.receiveShadow = true; tile.name = 'terrain';
      scene.add(tile);
    }
  }
  if (map.quake) for (const d of addQuakeLevel(scene, map)) track(d);

  // ---- primitives, merged per visual; gates get their own meshes so each can be lit up ----
  const texCache: Record<string, THREE.Texture> = {
    concrete: track(concreteTexture()), brick: track(brickTexture()), metal: track(metalTexture()), wood: track(woodTexture()), pad: track(padTexture()),
  };
  const groups = new Map<string, { mat: THREE.Material; geos: THREE.BufferGeometry[]; shadow: boolean }>();
  const matFor = (key: string, make: () => THREE.Material, shadow: boolean) => {
    let g = groups.get(key);
    if (!g) { g = { mat: track(make()), geos: [], shadow }; groups.set(key, g); }
    return g;
  };
  const gateParts = new Map<number, { frame: THREE.BufferGeometry[]; led: THREE.BufferGeometry[]; glow: THREE.BufferGeometry[]; cloth: BoxPrim[]; top: number }>();
  const partsFor = (id: number) => { let g = gateParts.get(id); if (!g) { g = { frame: [], led: [], glow: [], cloth: [], top: 0 }; gateParts.set(id, g); } return g; };
  const gateById = new Map(map.gates.map((g) => [g.id, g]));
  const m4 = new THREE.Matrix4(), s3 = new THREE.Vector3(1, 1, 1);
  // (kept indexed: every primitive geometry is, so they merge as such, and shared corners are shaded
  // once instead of once per triangle: 1.5x fewer vertices for boxes, ~2-5x for cylinders / spheres)
  const place = (geo: THREE.BufferGeometry, pr: SolidPrim) => geo.applyMatrix4(primMatrix(pr, m4));
  // gate frame + self-lit LED strip along each tube (on the faces the pilot sees) + a slightly
  // inflated copy that becomes the additive glow halo when the gate is highlighted
  const addGatePrim = (pr: SolidPrim, gid: number) => {
    const parts = partsFor(gid), G = 0.07;
    if (pr.kind === 'box') {
      const hx = pr.half.x, hy = pr.half.y, hz = pr.half.z;
      if (isFlagBanner(pr)) parts.cloth.push(pr); // drawn as cloth (its collision stays the thin box)
      else parts.frame.push(place(boxGeometryWorldUV(hx * 2, hz * 2, hy * 2, 0.5), pr));
      parts.glow.push(place(new THREE.BoxGeometry(hx * 2 + G * 2, hz * 2 + G * 2, hy * 2 + G * 2), pr));
      if (pr.visual === 'gate' && pr.mat === 'gate') {
        // strip runs along the tube and sticks 4 mm out of the faces across the direction of travel
        // (local y for upright gates, z for a dive frame)
        const dive = gateById.get(gid)?.kind === 'dive', L = Math.max(hx, hy, hz);
        const sx = hx === L ? hx : hx * 0.35;
        const sy = dive ? (hy === L ? hy : hy * 0.35) : hy + 0.004;
        const sz = hz === L ? hz : dive ? hz + 0.004 : hz * 0.35;
        parts.led.push(place(new THREE.BoxGeometry(sx * 2, sz * 2, sy * 2), pr));
      }
      parts.top = Math.max(parts.top, pr.c.z + Math.abs(Math.cos(pr.pitch ?? 0)) * hz + Math.abs(Math.sin(pr.pitch ?? 0)) * hx);
    } else if (pr.kind === 'cyl') {
      parts.frame.push(place(new THREE.CylinderGeometry(pr.r, pr.r, pr.h, 10), pr));
      parts.glow.push(place(new THREE.CylinderGeometry(pr.r + G, pr.r + G, pr.h + G, 10), pr));
      parts.top = Math.max(parts.top, pr.c.z + pr.h);
    } else {
      parts.frame.push(place(new THREE.SphereGeometry(pr.r, 12, 8), pr));
      parts.glow.push(place(new THREE.SphereGeometry(pr.r + G, 12, 8), pr));
      parts.top = Math.max(parts.top, pr.c.z + pr.r);
    }
  };
  const decorPlain: BoxPrim[] = [], crowd: BoxPrim[] = [];
  // floodlight lamps glow (HDR, so the FPV camera blooms them) when the lights are on, grey glass by day
  const floodColor = new THREE.Color(0xfff3d6).multiplyScalar(env.floods > 0 ? 1 + 5 * env.floods : 0.62);
  const addPrim = (pr: Prim, isDecor: boolean) => {
    if (pr.kind === 'brush') return; // drawn by addQuakeLevel
    const gid = gateIdOf(pr.tag);
    if (gid >= 0) { addGatePrim(pr, gid); return; }
    let geo: THREE.BufferGeometry, key: string, make: () => THREE.Material, shadow = !isDecor;
    if (pr.kind === 'box') {
      const vis = pr.visual ?? 'plain';
      if (pr.texture) {
        // map packages: image texture from the package, overrides the built-in visual
        const url = pr.texture;
        geo = boxGeometryWorldUV(pr.half.x * 2, pr.half.z * 2, pr.half.y * 2, 2);
        key = `tex:${url}`; make = () => new THREE.MeshStandardMaterial({ map: track(imageTexture(url)), roughness: 0.85 });
      } else if (isDecor && vis === 'plain') { (pr.tag === 'crowd' ? crowd : decorPlain).push(pr); return; }
      else if (vis === 'banner' || vis === 'screen') {
        // printed / LED boards: the text faces out of both large sides (local ±y)
        geo = new THREE.BoxGeometry(pr.half.x * 2, pr.half.z * 2, pr.half.y * 2);
        const text = pr.text ?? '', bg = pr.color ?? 0x111111, aspect = pr.half.x / pr.half.z, screen = vis === 'screen';
        key = `${vis}|${text}|${bg}|${aspect.toFixed(1)}`;
        make = () => {
          const tex = track(textTexture(text, bg, aspect, screen));
          return screen ? new THREE.MeshBasicMaterial({ map: tex }) : new THREE.MeshStandardMaterial({ map: tex, roughness: 0.5, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.35 });
        };
        shadow &&= !screen;
      } else {
        geo = boxGeometryWorldUV(pr.half.x * 2, pr.half.z * 2, pr.half.y * 2, vis === 'pad' ? Math.max(pr.half.x, pr.half.y) * 2 : vis === 'net' ? 0.8 : 2);
        if (vis === 'led' && pr.tag === 'flood') { key = 'flood'; make = () => new THREE.MeshBasicMaterial({ color: floodColor }); shadow = false; }
        else if (vis === 'led') { key = `led${pr.color ?? 0xffffff}`; make = () => new THREE.MeshBasicMaterial({ color: pr.color ?? 0xffffff }); shadow = false; }
        else if (vis === 'net') {
          key = 'net'; shadow = false;
          make = () => new THREE.MeshStandardMaterial({ map: track(netTexture()), color: 0x9aa0a6, transparent: true, depthWrite: false, side: THREE.DoubleSide, roughness: 0.9 });
        } else if (vis === 'plain' || vis === 'gate') { key = `plain${pr.color ?? 0x888888}`; make = () => new THREE.MeshStandardMaterial({ color: pr.color ?? 0x888888, roughness: 0.8 }); }
        else { key = vis; make = () => new THREE.MeshStandardMaterial({ map: texCache[vis] ?? null, roughness: vis === 'metal' ? 0.55 : 0.92, metalness: vis === 'metal' ? 0.5 : 0 }); }
      }
    } else if (pr.kind === 'cyl') {
      geo = new THREE.CylinderGeometry(pr.r, pr.r, pr.h, pr.r > 1 ? 32 : pr.r > 0.2 ? 16 : 10);
      const kind = pr.mat === 'dirt' ? 'bale' : pr.tag === 'tank' ? 'tank' : 'metalcyl';
      key = kind + (pr.color ?? ''); // per colour: merged geometry shares one material
      make = () => new THREE.MeshStandardMaterial({ color: pr.color ?? 0x8a8f94, map: kind === 'tank' ? texCache.metal : null, roughness: kind === 'bale' ? 1 : 0.5, metalness: kind === 'metalcyl' || kind === 'tank' ? 0.6 : 0 });
    } else {
      geo = new THREE.SphereGeometry(pr.r, 16, 12);
      key = `sph${pr.color ?? 0}`; make = () => new THREE.MeshStandardMaterial({ color: pr.color ?? 0x777777 });
    }
    matFor(key, make, shadow).geos.push(place(geo, pr));
  };
  for (const pr of map.prims) addPrim(pr, false);
  for (const pr of map.decor ?? []) addPrim(pr, true);
  for (const [, g] of groups) {
    const merged = track(mergeGeometries(g.geos, false)!);
    for (const x of g.geos) x.dispose();
    const mesh = new THREE.Mesh(merged, g.mat);
    mesh.castShadow = g.shadow; mesh.receiveShadow = true;
    scene.add(mesh);
  }
  // render-only plain boxes: a single instanced draw
  if (decorPlain.length) {
    const im = track(new THREE.InstancedMesh(track(new THREE.BoxGeometry(1, 1, 1)), track(new THREE.MeshStandardMaterial({ roughness: 0.9 })), decorPlain.length));
    const col = new THREE.Color();
    decorPlain.forEach((pr, i) => {
      primMatrix(pr, m4).scale(s3.set(pr.half.x * 2, pr.half.z * 2, pr.half.y * 2));
      im.setMatrixAt(i, m4); im.setColorAt(i, col.setHex(pr.color ?? 0x888888));
    });
    im.receiveShadow = true;
    scene.add(im);
  }
  // spectators: instanced figures facing the course
  const people = buildCrowd(crowd, courseCentre(map), u);
  if (people) { track(people); for (const m of people.meshes) { m.name = 'crowd'; scene.add(m); } }

  // ---- gates: frame / LED strip / glow halo / light beam (+ cloth for flags), one set per gate ----
  const gateColors = [0xff6a00, 0x1e90ff, 0xff2d75, 0x2bd96b, 0xffd400];
  const ledColors = [0xffa040, 0x40c8ff, 0xff5aa0, 0x5cff8a, 0xfff060];
  const beamGeo = track(lightBeamGeometry());
  const gates: GateVisual[] = [];
  const gateMeshes: THREE.Object3D[] = [];
  for (const [gid, parts] of [...gateParts].sort((a, b) => a[0] - b[0])) {
    const col = gateColors[gid % gateColors.length], led = ledColors[gid % ledColors.length];
    const gateTex = track(gateTexture('#' + col.toString(16).padStart(6, '0')));
    const frameMat = track(new THREE.MeshStandardMaterial({ map: gateTex, roughness: 0.6, emissive: col, emissiveIntensity: 0.12 }));
    const merge = (l: THREE.BufferGeometry[]) => { const m = track(mergeGeometries(l, false)!); for (const x of l) x.dispose(); return m; };
    const ledMat = track(new THREE.MeshBasicMaterial({ color: led }));
    const glowMat = track(new THREE.MeshBasicMaterial({ color: HIGHLIGHT, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false }));
    const glow = new THREE.Mesh(merge(parts.glow), glowMat);
    glow.visible = false; glow.renderOrder = 2;
    const beamMat = track(new THREE.MeshBasicMaterial({ color: HIGHLIGHT, vertexColors: true, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    const beam = new THREE.Mesh(beamGeo, beamMat);
    const gd = gateById.get(gid);
    if (gd) beam.position.set(gd.c.x, parts.top, -gd.c.y);
    beam.visible = false; beam.renderOrder = 3;
    scene.add(glow, beam);
    if (parts.frame.length) {
      const frame = new THREE.Mesh(merge(parts.frame), frameMat);
      frame.castShadow = true; frame.receiveShadow = true; frame.userData.gt = { cls: 'gate', id: gid };
      scene.add(frame); gateMeshes.push(frame);
    }
    if (parts.led.length) { const m = new THREE.Mesh(merge(parts.led), ledMat); m.userData.gt = { cls: 'gate', id: gid }; scene.add(m); }
    let cloth: THREE.MeshStandardMaterial | null = null;
    if (parts.cloth.length) {
      const cm = clothMaterials(u, gateTex, col);
      cloth = track(cm.mat); track(cm.depth);
      for (const pr of parts.cloth) { const m = flagCloth(pr, cm.mat, cm.depth); m.userData.gt = { cls: 'gate', id: gid }; track(m.geometry); scene.add(m); gateMeshes.push(m); }
    }
    gates.push({ id: gid, frameMat, ledMat, ledBase: led, glow, glowMat, beam, beamMat, cloth, state: -1 });
  }

  /** Light up the gate to fly through next (and, dimmer, the one after); others stay normal. */
  const setGateHighlight = (next: number, on: boolean, t: number) => {
    const n = map.gates.length;
    if (!n) return;
    const nextId = map.gates[((next % n) + n) % n].id, afterId = map.gates[(next + 1) % n].id;
    const pulse = 0.5 + 0.5 * Math.sin(t * Math.PI * 2 * 1.6);
    for (const g of gates) {
      const state = !on ? 0 : g.id === nextId ? 2 : g.id === afterId ? 1 : 0;
      if (state === 2) {
        // HDR values above 1: the FPV camera's bloom flares around the lit gate
        g.ledMat.color.setHex(HIGHLIGHT).multiplyScalar(1.6 + 1.4 * pulse);
        g.glowMat.color.setHex(HIGHLIGHT); g.glowMat.opacity = 0.22 + 0.25 * pulse;
        g.beamMat.color.setHex(HIGHLIGHT); g.beamMat.opacity = 0.14 + 0.1 * pulse;
        g.frameMat.emissiveIntensity = 0.35 + 0.35 * pulse;
      } else if (state !== g.state) {
        if (state === 1) {
          g.ledMat.color.setHex(NEXT2); g.glowMat.color.setHex(NEXT2); g.glowMat.opacity = 0.1;
          g.beamMat.color.setHex(NEXT2); g.beamMat.opacity = 0.06;
        } else g.ledMat.color.setHex(g.ledBase);
        g.frameMat.emissiveIntensity = state === 1 ? 0.22 : 0.12;
      }
      if (g.cloth) g.cloth.emissiveIntensity = g.frameMat.emissiveIntensity;
      g.glow.visible = g.beam.visible = state > 0;
      g.state = state;
    }
  };

  // ---- trees (instanced leaf cards, near / far LOD), ground clutter, windsock ----
  const trees = map.trees.length ? buildTrees(map, u, track(foliageAtlas())) : null;
  if (trees) { track(trees); for (const m of trees.meshes) { m.name = 'trees'; scene.add(m); } }
  const clutter = buildClutter(map, u, track(grassTuftTexture()));
  if (clutter) { track(clutter); for (const m of clutter.meshes) { m.name = 'clutter'; scene.add(m); } }
  const sockAt = windsockSpot(map), sock = sockAt ? buildWindsock(sockAt) : null;
  if (sock) { track(sock); sock.object.name = 'windsock'; scene.add(sock.object); }
  // LOD centre = whichever camera renders (the cube faces, the chase camera); runs before the shadow
  // pass. The FPV shadow refresh (a camera looking at nothing) keeps the lens's LOD (sway.ts NO_LOD).
  scene.onBeforeRender = (_r, _s, camera) => {
    if (camera.userData[NO_LOD]) return;
    u.uLod.value.setFromMatrixPosition(camera.matrixWorld); trees?.update(u.uLod.value); clutter?.update(u.uLod.value);
  };

  // ---- glTF meshes (map packages); they load asynchronously, like the Quake textures ----
  let disposed = false;
  if (map.meshes?.length) {
    const meshes = map.meshes;
    // the glTF loader is only fetched for maps that have meshes
    void import('three/examples/jsm/loaders/GLTFLoader.js').then(({ GLTFLoader }) => {
    if (disposed) return;
    const loader = new GLTFLoader();
    for (const mi of meshes) loader.load(mi.url, (gltf) => {
      const root = gltf.scene;
      // a scene switched away while this loaded: free it all, it will never be drawn
      if (disposed) { disposeObject(root); return; }
      root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        m.castShadow = true; m.receiveShadow = true;
        track(m.geometry);
        for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
          track(mat);
          for (const v of Object.values(mat)) if (v instanceof THREE.Texture) track(v);
        }
      });
      // glTF axes are three.js axes; place in ENU (three: x, z, -y), yaw about up
      root.position.set(mi.pos.x, mi.pos.z, -mi.pos.y);
      root.rotation.y = mi.yaw;
      root.scale.setScalar(mi.scale);
      scene.add(root);
    }, undefined, (e) => console.warn(`map mesh ${mi.url} failed to load`, e));
    }, (e) => console.warn('glTF loader failed to load', e));
  }

  // ---- wind: smoothed (gusts build over ~0.4 s), direction as a vector so it turns the short way ----
  const flow = new THREE.Vector2(), want = new THREE.Vector2();
  let speed = -1, lastT = 0;
  const setWind = (speedMs: number, dirDeg: number, t: number) => {
    const sp = Math.max(0, speedMs) * (map.windScale ?? 1), [fx, fz] = flowDir(dirDeg);
    want.set(fx, fz);
    const k = speed < 0 ? 1 : Math.min(1, Math.max(0, t - lastT) / 0.4);
    lastT = t;
    speed = speed < 0 ? sp : speed + (sp - speed) * k;
    flow.lerp(want, k);
    if (flow.lengthSq() < 1e-6) flow.copy(want);
    const n = flow.length();
    u.uWind.value.set(flow.x / n, flow.y / n, windStrength(speed), t % 2048);
    sock?.update(flow.x / n, flow.y / n, speed, t);
  };

  return {
    hemi, hemiBase: hemi.intensity, env,
    scene, sun, sunDir, gateMeshes, setGateHighlight, setWind,
    dispose() {
      disposed = true;
      for (const d of disposables) d.dispose(); // incl. every InstancedMesh (frees its instance buffers)
    },
  };
}
