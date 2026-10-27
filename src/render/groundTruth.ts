// Ground truth for the FPV camera: per-pixel range (metres from the lens), semantic class and
// instance id, seen through exactly the lens the picture used — the same Kannala–Brandt fisheye, the
// same rolling-shutter rotation table and mount vibration (FpvCamera.lensUniforms) — so labels line
// up with the frame pixel for pixel. The scene is drawn into a float cube map with every mesh's
// material swapped for one that writes (range, class, instance), then resampled through the lens
// with nearest filtering (labels must never blend). HyperDrone's renderer outputs depth, semantic
// segmentation and more the same way; here it comes with the simulator's own camera model.
import * as THREE from 'three';
import { ROT_N } from './fpvCamera';

/** Semantic classes (index = value in the segmentation image). */
export const GT_CLASSES = ['sky', 'ground', 'structure', 'vegetation', 'gate', 'person', 'drone_self', 'drone_other', 'object', 'target'] as const; // append only: datasets store the index
export type GtClass = (typeof GT_CLASSES)[number];
export const GT = Object.fromEntries(GT_CLASSES.map((c, i) => [c, i])) as Record<GtClass, number>;

/**
 * How an object is labelled: set userData.gt on it (or an ancestor) to a class name, { cls, id },
 * or 'skip' (not drawn in the ground truth: sky dome, light beams, markers). Untagged objects are
 * labelled by name ('terrain', 'trees', 'clutter', 'crowd', 'windsock'), else 'structure'.
 */
export type GtTag = GtClass | 'skip' | { cls: GtClass; id?: number };

const BY_NAME: Record<string, GtClass> = { terrain: 'ground', trees: 'vegetation', clutter: 'vegetation', crowd: 'person', windsock: 'object' };

function tagOf(o: THREE.Object3D): GtTag | null {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) {
    const t = p.userData?.gt as GtTag | undefined;
    if (t !== undefined) return t;
    if (p.name && BY_NAME[p.name]) return BY_NAME[p.name];
  }
  return null;
}

const gtVS = /* glsl */ `
#include <common>
#include <batching_pars_vertex>
#include <skinning_pars_vertex>
varying vec3 vView;
void main() {
  #include <batching_vertex>
  #include <skinbase_vertex>
  #include <begin_vertex>
  #include <skinning_vertex>
  #include <project_vertex>
  vView = mvPosition.xyz;
}`;
const gtFS = /* glsl */ `
precision highp float;
uniform float cls, inst;
varying vec3 vView;
void main() { gl_FragColor = vec4(length(vView), cls, inst, 1.0); }`;

// lens resampling: the fisheye shader's geometry (fpvCamera.ts fisheyeFS) at the pixel's centre,
// at its row's readout time, no motion blur, nearest texel
const lensFS = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform samplerCube cube;
uniform float halfFovDiag, aspect, readout, rotCap, vibOn, tab0, tabDt;
uniform vec4 kb, vibAmp, vibFreq, vibPhase;
uniform vec3 rotTab[${ROT_N}];
float kbTheta(float td) {
  float t = td;
  for (int i = 0; i < 5; i++) {
    float t2 = t*t;
    float f = t*(1.0 + kb.x*t2 + kb.y*t2*t2 + kb.z*t2*t2*t2 + kb.w*t2*t2*t2*t2) - td;
    float df = 1.0 + 3.0*kb.x*t2 + 5.0*kb.y*t2*t2 + 7.0*kb.z*t2*t2*t2 + 9.0*kb.w*t2*t2*t2*t2;
    t -= f / df;
  }
  return t;
}
vec3 rotAt(float t) {
  float x = clamp((t - tab0) / tabDt, 0.0, ${ROT_N - 1}.0 - 0.001);
  int i = int(x);
  vec3 r = mix(rotTab[i], rotTab[i + 1], x - float(i));
  if (vibOn > 0.5) { vec4 ph = vibPhase + 6.2831853 * vibFreq * t; r.x += dot(vibAmp, sin(ph)); r.y += dot(vibAmp, cos(ph)); }
  return r;
}
vec3 rotate(vec3 d, vec3 r) {
  float a = length(r);
  if (a < 1e-7) return d;
  vec3 k = r / a; a = min(a, rotCap);
  float c = cos(a), s = sin(a);
  return d * c + cross(k, d) * s + k * dot(k, d) * (1.0 - c);
}
void main() {
  vec2 p = (vUv - 0.5) * vec2(aspect, 1.0);
  float rc = length(vec2(aspect, 1.0) * 0.5);
  float th = kbTheta(length(p) / rc * halfFovDiag);
  float ph = atan(p.y, p.x);
  vec3 d = vec3(sin(th) * cos(ph), sin(th) * sin(ph), -cos(th));
  float tRow = (0.5 - vUv.y) * readout;
  gl_FragColor = textureCube(cube, rotate(d, rotAt(tRow)));
}`;

const LENS_KEYS = ['halfFovDiag', 'aspect', 'readout', 'rotCap', 'vibOn', 'tab0', 'tabDt', 'kb', 'vibAmp', 'vibFreq', 'vibPhase', 'rotTab'] as const;

export interface GroundTruthFrame {
  width: number; height: number;
  /** range from the lens (m) per pixel, top row first; 0 where nothing was hit (sky) */
  range: Float32Array;
  /** semantic class per pixel (GT_CLASSES index) */
  cls: Uint8Array;
  /** instance id per pixel: gate id + 1 for gates, 0 elsewhere */
  inst: Uint16Array;
}

export class GroundTruthCamera {
  private cubeRT: THREE.WebGLCubeRenderTarget;
  private cubeCam: THREE.CubeCamera;
  private outRT: THREE.WebGLRenderTarget | null = null;
  private lensMat: THREE.ShaderMaterial;
  private quadScene = new THREE.Scene();
  private quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private mats = new Map<string, THREE.ShaderMaterial>();

  constructor(private renderer: THREE.WebGLRenderer, cubeSize = 768) {
    this.cubeRT = new THREE.WebGLCubeRenderTarget(cubeSize, { type: THREE.FloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false });
    this.cubeCam = new THREE.CubeCamera(0.005, 3000, this.cubeRT);
    const uniforms: Record<string, THREE.IUniform> = { cube: { value: this.cubeRT.texture } };
    for (const k of LENS_KEYS) uniforms[k] = { value: null };
    this.lensMat = new THREE.ShaderMaterial({ vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }', fragmentShader: lensFS, uniforms, depthTest: false, depthWrite: false });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.lensMat);
    quad.frustumCulled = false;
    this.quadScene.add(quad);
  }

  private mat(cls: number, inst: number): THREE.ShaderMaterial {
    const key = `${cls}:${inst}`;
    let m = this.mats.get(key);
    if (!m) {
      m = new THREE.ShaderMaterial({ vertexShader: gtVS, fragmentShader: gtFS, uniforms: { cls: { value: cls }, inst: { value: inst } }, side: THREE.DoubleSide });
      this.mats.set(key, m);
    }
    return m;
  }

  /**
   * Render the ground truth for a frame captured at this lens pose (three world space) through the
   * camera's lens (FpvCamera.lensUniforms, as the capture left them), at width × height.
   */
  async render(scene: THREE.Scene, lensPos: THREE.Vector3, lensQuat: THREE.Quaternion, lens: Record<string, THREE.IUniform>, width: number, height: number): Promise<GroundTruthFrame> {
    const r = this.renderer;
    // swap every drawable's material for a label material; hide what has no label
    const swapped: [THREE.Mesh, THREE.Material | THREE.Material[]][] = [], hidden: THREE.Object3D[] = [];
    scene.traverseVisible((o) => {
      const m = o as THREE.Mesh;
      if ((o as THREE.Sprite).isSprite || (o as THREE.Points).isPoints || (o as THREE.Line).isLine) { hidden.push(o); return; }
      if (!m.isMesh) return;
      const mat = Array.isArray(m.material) ? m.material[0] : m.material;
      // additive glows, light shafts and other see-through effects are not surfaces
      if (mat && mat.transparent && !mat.depthWrite) { hidden.push(o); return; }
      const tag = tagOf(o);
      if (tag === 'skip') { hidden.push(o); return; }
      const cls = tag === null ? GT.structure : typeof tag === 'string' ? GT[tag] : GT[tag.cls];
      const id = tag && typeof tag === 'object' && tag.id !== undefined ? tag.id + 1 : 0;
      swapped.push([m, m.material]);
      m.material = this.mat(cls, id);
    });
    for (const o of hidden) o.visible = false;
    const bg = scene.background, fog = scene.fog, prevRT = r.getRenderTarget(), cc = r.getClearColor(new THREE.Color()), ca = r.getClearAlpha();
    const smAuto = r.shadowMap.autoUpdate;
    scene.background = null; scene.fog = null; r.shadowMap.autoUpdate = false;
    r.setClearColor(0x000000, 0);
    try {
      this.cubeCam.position.copy(lensPos); this.cubeCam.quaternion.copy(lensQuat); this.cubeCam.updateMatrixWorld(true);
      this.cubeCam.update(r, scene);
    } finally {
      for (const [m, mat] of swapped) m.material = mat;
      for (const o of hidden) o.visible = true;
      scene.background = bg; scene.fog = fog; r.shadowMap.autoUpdate = smAuto;
      r.setClearColor(cc, ca);
    }
    // through the lens
    if (!this.outRT || this.outRT.width !== width || this.outRT.height !== height) {
      this.outRT?.dispose();
      this.outRT = new THREE.WebGLRenderTarget(width, height, { type: THREE.FloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false });
    }
    const u = this.lensMat.uniforms;
    for (const k of LENS_KEYS) u[k].value = lens[k]?.value;
    r.setRenderTarget(this.outRT);
    r.render(this.quadScene, this.quadCam);
    r.setRenderTarget(prevRT);
    const px = new Float32Array(width * height * 4);
    await r.readRenderTargetPixelsAsync(this.outRT, 0, 0, width, height, px);
    const n = width * height, range = new Float32Array(n), cls = new Uint8Array(n), inst = new Uint16Array(n);
    for (let y = 0; y < height; y++) {
      const src = (height - 1 - y) * width; // GL rows run bottom-up
      for (let x = 0; x < width; x++) {
        const i = (src + x) * 4, o = y * width + x;
        range[o] = px[i]; cls[o] = Math.round(px[i + 1]); inst[o] = Math.round(px[i + 2]);
      }
    }
    return { width, height, range, cls, inst };
  }

  dispose() {
    this.cubeRT.dispose(); this.outRT?.dispose(); this.lensMat.dispose();
    for (const m of this.mats.values()) m.dispose();
  }
}
