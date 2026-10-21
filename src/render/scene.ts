// Builds the Three.js scene for a MapDef: terrain, primitives (merged per material), instanced trees,
// gates, sky, sun with shadows and atmospheric fog.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { MapDef, Prim } from '../maps/world';
import { addQuakeLevel } from './quakeScene';
import { brickTexture, concreteTexture, dirtTexture, gateTexture, grassTexture, metalTexture, padTexture, woodTexture } from './textures';

export interface SceneBundle {
  scene: THREE.Scene;
  sun: THREE.DirectionalLight;
  sunDir: THREE.Vector3;
  gateMeshes: THREE.Object3D[];
  dispose(): void;
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

export function buildScene(map: MapDef): SceneBundle {
  const scene = new THREE.Scene();
  const disposables: { dispose(): void }[] = [];
  const track = <T extends { dispose(): void }>(x: T) => (disposables.push(x), x);

  // ---- sky / light ----
  const sky = new Sky();
  sky.scale.setScalar(4000);
  const u = sky.material.uniforms;
  const overcast = map.sky === 'overcast';
  u.turbidity.value = overcast ? 12 : 4;
  u.rayleigh.value = overcast ? 3.5 : 1.4;
  u.mieCoefficient.value = overcast ? 0.02 : 0.006;
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

  const hemi = new THREE.HemisphereLight(overcast ? 0xb8c2cc : 0xbfd9ff, overcast ? 0x5a5650 : 0x56603e, overcast ? 2.6 : 1.9);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff1dd, overcast ? 2.2 : 4.5);
  sun.position.copy(sunDir).multiplyScalar(120);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera as THREE.OrthographicCamera;
  sc.left = -45; sc.right = 45; sc.top = 45; sc.bottom = -45; sc.near = 1; sc.far = 400;
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.03;
  scene.add(sun, sun.target);
  scene.fog = new THREE.FogExp2(overcast ? 0xa9b0b5 : 0xbcd0e0, overcast ? 0.0045 : 0.0022);

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
    const groundTex = track(map.groundMat === 'grass' ? grassTexture() : dirtTexture());
    const ground = new THREE.Mesh(track(tg), track(new THREE.MeshStandardMaterial({ map: groundTex, vertexColors: true, roughness: 0.95 })));
    ground.receiveShadow = true;
    scene.add(ground);
  }
  if (map.quake) for (const d of addQuakeLevel(scene, map)) track(d);

  // ---- primitives, merged per visual ----
  const texCache: Record<string, THREE.Texture> = {
    concrete: track(concreteTexture()), brick: track(brickTexture()), metal: track(metalTexture()), wood: track(woodTexture()), pad: track(padTexture()),
  };
  const groups = new Map<string, { mat: THREE.Material; geos: THREE.BufferGeometry[] }>();
  const gateColors = [0xff6a00, 0x1e90ff, 0xff2d75, 0x2bd96b, 0xffd400];
  const matFor = (key: string, make: () => THREE.Material) => {
    let g = groups.get(key);
    if (!g) { g = { mat: track(make()), geos: [] }; groups.set(key, g); }
    return g;
  };
  const gateMeshes: THREE.Object3D[] = [];
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p3 = new THREE.Vector3(), s3 = new THREE.Vector3(1, 1, 1);
  for (const pr of map.prims as Prim[]) {
    if (pr.kind === 'brush') continue; // drawn by addQuakeLevel
    let geo: THREE.BufferGeometry, key: string, make: () => THREE.Material;
    if (pr.kind === 'box') {
      const vis = pr.visual ?? 'plain';
      geo = boxGeometryWorldUV(pr.half.x * 2, pr.half.z * 2, pr.half.y * 2, vis === 'pad' ? Math.max(pr.half.x, pr.half.y) * 2 : 2);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), pr.yaw);
      p3.set(pr.c.x, pr.c.z, -pr.c.y);
      if (vis === 'gate') {
        const gi = parseInt((pr.tag ?? '').replace(/\D/g, '') || '0', 10);
        const col = gateColors[gi % gateColors.length];
        key = `gate${col}`; make = () => new THREE.MeshStandardMaterial({ map: gateTexture('#' + col.toString(16).padStart(6, '0')), roughness: 0.6, emissive: col, emissiveIntensity: 0.12 });
      } else if (vis === 'plain') { key = `plain${pr.color ?? 0x888888}`; make = () => new THREE.MeshStandardMaterial({ color: pr.color ?? 0x888888, roughness: 0.8 }); }
      else { key = vis; make = () => new THREE.MeshStandardMaterial({ map: texCache[vis] ?? null, roughness: vis === 'metal' ? 0.55 : 0.92, metalness: vis === 'metal' ? 0.5 : 0 }); }
    } else if (pr.kind === 'cyl') {
      geo = new THREE.CylinderGeometry(pr.r, pr.r, pr.h, pr.r > 1 ? 32 : 10);
      q.identity(); p3.set(pr.c.x, pr.c.z + pr.h / 2, -pr.c.y);
      const isGate = (pr.tag ?? '').startsWith('gate');
      key = isGate ? 'gatepole' : pr.mat === 'dirt' ? 'bale' : pr.tag === 'tank' ? 'tank' : 'metalcyl';
      make = () => new THREE.MeshStandardMaterial({ color: isGate ? 0xffffff : pr.color ?? 0x8a8f94, map: key === 'tank' ? texCache.metal : null, roughness: key === 'bale' ? 1 : 0.5, metalness: key === 'metalcyl' || key === 'tank' ? 0.6 : 0 });
    } else {
      geo = new THREE.SphereGeometry(pr.r, 16, 12);
      q.identity(); p3.set(pr.c.x, pr.c.z, -pr.c.y);
      key = `sph${pr.color ?? 0}`; make = () => new THREE.MeshStandardMaterial({ color: pr.color ?? 0x777777 });
    }
    m4.compose(p3, q, s3);
    geo.applyMatrix4(m4);
    if (geo.index) geo = geo.toNonIndexed();
    matFor(key, make).geos.push(geo);
  }
  for (const [key, g] of groups) {
    const merged = track(mergeGeometries(g.geos, false)!);
    for (const x of g.geos) x.dispose();
    const mesh = new THREE.Mesh(merged, g.mat);
    mesh.castShadow = true; mesh.receiveShadow = true;
    scene.add(mesh);
    if (key.startsWith('gate')) gateMeshes.push(mesh);
  }

  // ---- trees (instanced) ----
  const pines = map.trees.filter((t) => t.type === 'pine'), oaks = map.trees.filter((t) => t.type === 'oak');
  const trunkGeo = track(new THREE.CylinderGeometry(0.12, 0.2, 1, 7));
  const trunkMat = track(new THREE.MeshStandardMaterial({ color: 0x5a4632, roughness: 1 }));
  const pineGeo = track(new THREE.ConeGeometry(1, 1, 9));
  const pineMat = track(new THREE.MeshStandardMaterial({ color: 0x2d4a2a, roughness: 1 }));
  const oakGeo = track(new THREE.IcosahedronGeometry(1, 1));
  const oakMat = track(new THREE.MeshStandardMaterial({ color: 0x41632f, roughness: 1, flatShading: true }));
  const all = map.trees;
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

  return {
    scene, sun, sunDir, gateMeshes,
    dispose() { for (const d of disposables) d.dispose(); sky.material.dispose(); sky.geometry.dispose(); },
  };
}
