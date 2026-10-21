// Builds the Three.js scene for a MapDef: terrain, primitives (merged per material), render-only
// decor (crowds instanced), instanced trees, gates (a mesh set each so the next gate can glow), sky,
// sun with shadows and atmospheric fog.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { gateIdOf } from '../maps/gates';
import { BoxPrim, MapDef, Prim } from '../maps/world';
import { addQuakeLevel } from './quakeScene';
import { brickTexture, concreteTexture, dirtTexture, gateTexture, grassTexture, metalTexture, netTexture, padTexture, textTexture, woodTexture } from './textures';

export interface SceneBundle {
  scene: THREE.Scene;
  sun: THREE.DirectionalLight;
  sunDir: THREE.Vector3;
  gateMeshes: THREE.Object3D[];
  /** Light up gate index `next` (and, dimmer, the one after); on = false leaves every gate normal. t in s. */
  setGateHighlight(next: number, on: boolean, t: number): void;
  dispose(): void;
}

const HIGHLIGHT = 0x5dff3a, NEXT2 = 0xffb020;

interface GateVisual {
  id: number;
  frameMat: THREE.MeshStandardMaterial; ledMat: THREE.MeshBasicMaterial; ledBase: number;
  glow: THREE.Mesh; glowMat: THREE.MeshBasicMaterial; beam: THREE.Mesh; beamMat: THREE.MeshBasicMaterial;
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

export function buildScene(map: MapDef): SceneBundle {
  const scene = new THREE.Scene();
  const disposables: { dispose(): void }[] = [];
  const track = <T extends { dispose(): void }>(x: T) => (disposables.push(x), x);

  // ---- sky / light ----
  const sky = new Sky();
  sky.scale.setScalar(4000);
  const u = sky.material.uniforms;
  const overcast = map.sky === 'overcast', dusk = map.sky === 'dusk'; // dusk: low golden-hour sun
  u.turbidity.value = overcast ? 12 : dusk ? 7 : 4;
  u.rayleigh.value = overcast ? 3.5 : dusk ? 2.2 : 1.4;
  u.mieCoefficient.value = overcast ? 0.02 : dusk ? 0.009 : 0.006;
  u.mieDirectionalG.value = 0.85;
  const phi = THREE.MathUtils.degToRad(90 - map.sun.elevationDeg), theta = THREE.MathUtils.degToRad(map.sun.azimuthDeg);
  // azimuth from north (ENU +y = three -z), clockwise
  const sunDir = new THREE.Vector3(Math.sin(phi) * Math.sin(theta), Math.cos(phi), -Math.sin(phi) * Math.cos(theta));
  u.sunPosition.value.copy(sunDir);
  // Sky.js radiance is ~10x the sunlit-ground radiance our lights produce; real sunlit grass and
  // clear sky have comparable luminance, so scale the sky into proportion for the camera model.
  sky.material.uniforms.skyScale = { value: overcast ? 0.45 : 0.3 };
  sky.material.fragmentShader = 'uniform float skyScale;\n' + sky.material.fragmentShader.replace('gl_FragColor = vec4( texColor, 1.0 );', 'gl_FragColor = vec4( texColor * skyScale, 1.0 );');
  sky.material.needsUpdate = true;
  scene.add(sky);

  const hemi = new THREE.HemisphereLight(overcast ? 0xb8c2cc : dusk ? 0xc9c4dc : 0xbfd9ff, overcast ? 0x5a5650 : dusk ? 0x5a4a38 : 0x56603e, overcast ? 2.6 : dusk ? 1.7 : 1.9);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(dusk ? 0xffc286 : 0xfff1dd, overcast ? 2.2 : dusk ? 4.2 : 4.5);
  sun.position.copy(sunDir).multiplyScalar(120);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera as THREE.OrthographicCamera;
  sc.left = -45; sc.right = 45; sc.top = 45; sc.bottom = -45; sc.near = 1; sc.far = 400;
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.03;
  scene.add(sun, sun.target);
  scene.fog = new THREE.FogExp2(map.fog?.color ?? (overcast ? 0xa9b0b5 : dusk ? 0xd6b8a0 : 0xbcd0e0), map.fog?.density ?? (overcast ? 0.0045 : 0.0022));

  // ---- terrain ----
  if (map.ground !== false) {
    const S = map.size * 2.2, N = 320;
    const tg = new THREE.PlaneGeometry(S, S, N, N);
    tg.rotateX(-Math.PI / 2);
    const pos = tg.getAttribute('position') as THREE.BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), zt = pos.getZ(i);
      const h = map.terrain(x, -zt);
      pos.setY(i, h);
      const v = 0.85 + 0.15 * Math.sin(x * 0.05 + zt * 0.031) * Math.cos(zt * 0.043 - x * 0.02);
      colors[i * 3] = v; colors[i * 3 + 1] = v; colors[i * 3 + 2] = v;
    }
    tg.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const uvs = tg.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < uvs.count; i++) uvs.setXY(i, uvs.getX(i) * S / 3, uvs.getY(i) * S / 3);
    tg.computeVertexNormals();
    const groundTex = track(map.groundTexture ? imageTexture(map.groundTexture) : map.groundMat === 'grass' ? grassTexture() : dirtTexture());
    const ground = new THREE.Mesh(track(tg), track(new THREE.MeshStandardMaterial({ map: groundTex, vertexColors: true, roughness: 0.95 })));
    ground.receiveShadow = true;
    scene.add(ground);
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
  const gateParts = new Map<number, { frame: THREE.BufferGeometry[]; led: THREE.BufferGeometry[]; glow: THREE.BufferGeometry[]; top: number }>();
  const partsFor = (id: number) => { let g = gateParts.get(id); if (!g) { g = { frame: [], led: [], glow: [], top: 0 }; gateParts.set(id, g); } return g; };
  const gateById = new Map(map.gates.map((g) => [g.id, g]));
  const m4 = new THREE.Matrix4(), s3 = new THREE.Vector3(1, 1, 1);
  const place = (geo: THREE.BufferGeometry, pr: SolidPrim) => {
    geo.applyMatrix4(primMatrix(pr, m4));
    if (!geo.index) return geo;
    const flat = geo.toNonIndexed(); geo.dispose();
    return flat;
  };
  // gate frame + self-lit LED strip along each tube (on the faces the pilot sees) + a slightly
  // inflated copy that becomes the additive glow halo when the gate is highlighted
  const addGatePrim = (pr: SolidPrim, gid: number) => {
    const parts = partsFor(gid), G = 0.07;
    if (pr.kind === 'box') {
      const hx = pr.half.x, hy = pr.half.y, hz = pr.half.z;
      parts.frame.push(place(boxGeometryWorldUV(hx * 2, hz * 2, hy * 2, 0.5), pr));
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
  const decorPlain: BoxPrim[] = [];
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
      } else if (isDecor && vis === 'plain') { decorPlain.push(pr); return; }
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
        if (vis === 'led') { key = `led${pr.color ?? 0xffffff}`; make = () => new THREE.MeshBasicMaterial({ color: pr.color ?? 0xffffff }); shadow = false; }
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
  // render-only plain boxes (crowds): a single instanced draw
  if (decorPlain.length) {
    const im = new THREE.InstancedMesh(track(new THREE.BoxGeometry(1, 1, 1)), track(new THREE.MeshStandardMaterial({ roughness: 0.9 })), decorPlain.length);
    const col = new THREE.Color();
    decorPlain.forEach((pr, i) => {
      primMatrix(pr, m4).scale(s3.set(pr.half.x * 2, pr.half.z * 2, pr.half.y * 2));
      im.setMatrixAt(i, m4); im.setColorAt(i, col.setHex(pr.color ?? 0x888888));
    });
    im.receiveShadow = true;
    scene.add(im);
  }

  // ---- gates: frame / LED strip / glow halo / light beam, one set per gate ----
  const gateColors = [0xff6a00, 0x1e90ff, 0xff2d75, 0x2bd96b, 0xffd400];
  const ledColors = [0xffa040, 0x40c8ff, 0xff5aa0, 0x5cff8a, 0xfff060];
  const beamGeo = track(lightBeamGeometry());
  const gates: GateVisual[] = [];
  const gateMeshes: THREE.Object3D[] = [];
  for (const [gid, parts] of [...gateParts].sort((a, b) => a[0] - b[0])) {
    const col = gateColors[gid % gateColors.length], led = ledColors[gid % ledColors.length];
    const frameMat = track(new THREE.MeshStandardMaterial({ map: track(gateTexture('#' + col.toString(16).padStart(6, '0'))), roughness: 0.6, emissive: col, emissiveIntensity: 0.12 }));
    const merge = (l: THREE.BufferGeometry[]) => { const m = track(mergeGeometries(l, false)!); for (const x of l) x.dispose(); return m; };
    const frame = new THREE.Mesh(merge(parts.frame), frameMat);
    frame.castShadow = true; frame.receiveShadow = true;
    const ledMat = track(new THREE.MeshBasicMaterial({ color: led }));
    const glowMat = track(new THREE.MeshBasicMaterial({ color: HIGHLIGHT, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false }));
    const glow = new THREE.Mesh(merge(parts.glow), glowMat);
    glow.visible = false; glow.renderOrder = 2;
    const beamMat = track(new THREE.MeshBasicMaterial({ color: HIGHLIGHT, vertexColors: true, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    const beam = new THREE.Mesh(beamGeo, beamMat);
    const gd = gateById.get(gid);
    if (gd) beam.position.set(gd.c.x, parts.top, -gd.c.y);
    beam.visible = false; beam.renderOrder = 3;
    scene.add(frame, glow, beam);
    if (parts.led.length) scene.add(new THREE.Mesh(merge(parts.led), ledMat));
    gateMeshes.push(frame);
    gates.push({ id: gid, frameMat, ledMat, ledBase: led, glow, glowMat, beam, beamMat, state: -1 });
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
      g.glow.visible = g.beam.visible = state > 0;
      g.state = state;
    }
  };

  // ---- trees (instanced) ----
  const pines = map.trees.filter((t) => t.type === 'pine'), oaks = map.trees.filter((t) => t.type === 'oak');
  const trunkGeo = track(new THREE.CylinderGeometry(0.12, 0.2, 1, 7));
  const trunkMat = track(new THREE.MeshStandardMaterial({ color: 0x5a4632, roughness: 1 }));
  const pineGeo = track(new THREE.ConeGeometry(1, 1, 9));
  const pineMat = track(new THREE.MeshStandardMaterial({ color: 0x2d4a2a, roughness: 1 }));
  const oakGeo = track(new THREE.IcosahedronGeometry(1, 1));
  const oakMat = track(new THREE.MeshStandardMaterial({ color: 0x41632f, roughness: 1, flatShading: true }));
  const all = map.trees, q = new THREE.Quaternion(), p3 = new THREE.Vector3();
  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, all.length);
  const pineI = new THREE.InstancedMesh(pineGeo, pineMat, pines.length * 3);
  const oakI = new THREE.InstancedMesh(oakGeo, oakMat, oaks.length * 2);
  let ip = 0, io = 0;
  all.forEach((t, i) => {
    const gz = map.terrain(t.x, t.y);
    m4.compose(p3.set(t.x, gz + t.h * 0.3, -t.y), q.identity(), s3.set(t.r * 0.6, t.h * 0.6, t.r * 0.6)); trunks.setMatrixAt(i, m4);
    if (t.type === 'pine') for (let k = 0; k < 3; k++) {
      const hh = t.h * (0.55 - k * 0.12), rr = t.r * (1.1 - k * 0.28);
      m4.compose(p3.set(t.x, gz + t.h * (0.35 + k * 0.2) + hh / 2, -t.y), q.identity(), s3.set(rr, hh, rr)); pineI.setMatrixAt(ip++, m4);
    } else {
      m4.compose(p3.set(t.x, gz + t.h * 0.62, -t.y), q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), t.x), s3.set(t.r, t.r * 0.85, t.r)); oakI.setMatrixAt(io++, m4);
      m4.compose(p3.set(t.x + t.r * 0.4, gz + t.h * 0.8, -t.y + t.r * 0.3), q.identity(), s3.set(t.r * 0.7, t.r * 0.6, t.r * 0.7)); oakI.setMatrixAt(io++, m4);
    }
  });
  for (const im of [trunks, pineI, oakI]) { im.castShadow = true; im.receiveShadow = true; im.instanceMatrix.needsUpdate = true; scene.add(im); }

  // ---- glTF meshes (map packages); they load asynchronously, like the Quake textures ----
  let disposed = false;
  if (map.meshes?.length) {
    const loader = new GLTFLoader();
    for (const mi of map.meshes) loader.load(mi.url, (gltf) => {
      const root = gltf.scene;
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
      if (disposed) { root.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.geometry.dispose(); }); return; }
      scene.add(root);
    }, undefined, (e) => console.warn(`map mesh ${mi.url} failed to load`, e));
  }

  return {
    scene, sun, sunDir, gateMeshes, setGateHighlight,
    dispose() { disposed = true; for (const d of disposables) d.dispose(); sky.material.dispose(); sky.geometry.dispose(); },
  };
}
