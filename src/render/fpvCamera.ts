// FPV camera emulation.
//  1. Cube camera at the lens position renders the world (one capture per *camera frame*, so the
//     video has the real frame-rate cadence even on a 144 Hz monitor).
//  2. Fisheye pass: Kannala–Brandt projection (θ_d = θ(1 + k1θ² + k2θ⁴ + k3θ⁶ + k4θ⁸)) at the
//     configured diagonal FOV, with rolling-shutter skew from the camera-frame angular rate.
//  3. Auto-exposure (time constant ~150 ms) + WDR tone curve + bloom.
//  4. Video link: analog (YIQ chroma bandwidth, FM-threshold noise / sparkles, sync tearing,
//     interlaced fields, colour loss) or digital (macroblocking, freeze, decimation) — then OSD.
import * as THREE from 'three';
import type { VideoSpec } from '../data/catalog';

const quadVS = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const fisheyeFS = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform samplerCube cube;
uniform mat3 camToWorld;
uniform float halfFovDiag, aspect;
uniform vec4 kb;
uniform vec3 omegaCam;
uniform float readout;
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
void main() {
  vec2 p = (vUv - 0.5) * vec2(aspect, 1.0);
  float rc = length(vec2(aspect, 1.0) * 0.5);
  float r = length(p);
  float td = r / rc * halfFovDiag;   // equidistant base radius -> distorted angle
  float th = kbTheta(td);
  float ph = atan(p.y, p.x);
  vec3 d = vec3(sin(th) * cos(ph), sin(th) * sin(ph), -cos(th));
  // rolling shutter: rows read top -> bottom over 'readout' seconds
  float dt = (0.5 - vUv.y) * readout;
  d = normalize(d + cross(omegaCam * dt, d));
  vec3 w = camToWorld * d;
  vec3 c = textureCube(cube, w).rgb;
  // optical vignetting (cos^4 law, softened for fisheye)
  float v = pow(cos(min(th, 1.45) * 0.55), 3.0);
  c *= v;
  // alpha carries log luminance; its mip average = log-average (geometric mean) scene luminance
  float L = log(max(dot(c, vec3(0.2126, 0.7152, 0.0722)), 1e-3));
  gl_FragColor = vec4(c, L);
}`;

const exposureFS = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D frame;
uniform sampler2D prevExp;
uniform float kUp, kDown;
void main() {
  // log-average over the whole frame, blended with a centre-weighted meter (what FPV cams do)
  float logAvg = mix(textureLod(frame, vec2(0.5), 12.0).a, textureLod(frame, vec2(0.5), 5.0).a, 0.4);
  float lum = exp(logAvg);
  // ~8.5 stops of range: dark interiors brighten (noisily), bright sky is pulled down
  float target = clamp(0.2 / lum, 0.06, 24.0);
  float prev = texture2D(prevExp, vec2(0.5)).r;
  if (prev <= 0.0) prev = target;
  // cameras react faster to over-exposure (bursting out into the sky) than to darkness
  gl_FragColor = vec4(mix(prev, target, target > prev ? kUp : kDown), 0.0, 0.0, 1.0);
}`;

const commonPost = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D frame, prevFrame, osd, expTex;
uniform float time, cnr, osdOn, wdr, frameH, frameW, oddField, interlaced, freeze, block, lost, hdz, gammaOut;
uniform vec4 osdRect;   // x0,y0,x1,y1 in frame uv
uniform vec2 screenFit; // scale of frame quad on screen (letterbox)
// sin-free hash (Hoskins): fract(sin(x)*k) collapses to 0 for large x in fp32
float hash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec3 tone(vec3 c, float e) {
  c *= e;
  // WDR: log-ish compression of highlights, lift shadows
  c = mix(c, log2(1.0 + c * 3.0) / log2(4.0), wdr);
  return c;
}
// camera transfer curve (Rec.709-like gamma): the frame buffers are linear light
vec3 oetf(vec3 c) { return pow(max(c, 0.0), vec3(gammaOut)); }
vec4 osdAt(vec2 uv) {
  vec2 o = (uv - osdRect.xy) / (osdRect.zw - osdRect.xy);
  if (o.x < 0.0 || o.y < 0.0 || o.x > 1.0 || o.y > 1.0) return vec4(0.0);
  return texture2D(osd, vec2(o.x, o.y)) * osdOn;
}
`;

const analogFS = commonPost + /* glsl */ `
vec3 rgb2yiq(vec3 c) { return vec3(dot(c, vec3(0.299, 0.587, 0.114)), dot(c, vec3(0.596, -0.274, -0.322)), dot(c, vec3(0.211, -0.523, 0.312))); }
vec3 yiq2rgb(vec3 y) { return vec3(y.x + 0.956*y.y + 0.621*y.z, y.x - 0.272*y.y - 0.647*y.z, y.x - 1.106*y.y + 1.703*y.z); }
void main() {
  vec2 uv = (vUv - 0.5) / screenFit + 0.5;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  float bad = clamp((22.0 - cnr) / 16.0, 0.0, 1.0);      // 0 clean .. 1 terrible
  float line = floor(uv.y * frameH);
  // sync problems: per-line horizontal tearing and vertical roll when the carrier drops
  float tear = smoothstep(9.0, 2.0, cnr);
  float shift = (hash(vec2(line * 0.37, floor(time * 30.0))) - 0.5) * 0.12 * tear * tear;
  shift += sin(line * 0.05 + time * 40.0) * 0.004 * tear;
  float roll = tear > 0.8 ? fract(time * 0.7) * (tear - 0.8) * 5.0 : 0.0;
  vec2 suv = vec2(fract(uv.x + shift), fract(uv.y + roll));
  float e = texture2D(expTex, vec2(0.5)).r;
  bool useprev = interlaced > 0.5 && mod(line, 2.0) == oddField;
  // luma: full bandwidth tap, chroma: wide horizontal blur (~1.3 MHz vs 4.2 MHz luma)
  vec3 cY = useprev ? texture2D(prevFrame, suv).rgb : texture2D(frame, suv).rgb;
  vec3 cC = vec3(0.0);
  for (int i = -3; i <= 3; i++) {
    vec2 ou = suv + vec2(float(i) * 1.6 / frameW, 0.0);
    cC += useprev ? texture2D(prevFrame, ou).rgb : texture2D(frame, ou).rgb;
  }
  cC /= 7.0;
  cY = tone(cY, e); cC = tone(cC, e);
  // sharpening ringing typical of analog cameras
  // (taps from the same field as the centre sample, or moving edges ghost)
  vec2 dl = vec2(1.5 / frameW, 0.0);
  vec3 cL = tone(useprev ? texture2D(prevFrame, suv - dl).rgb : texture2D(frame, suv - dl).rgb, e);
  vec3 cR = tone(useprev ? texture2D(prevFrame, suv + dl).rgb : texture2D(frame, suv + dl).rgb, e);
  vec3 sharp = cY + (cY - 0.5 * (cL + cR)) * 0.6;
  // small-sensor CMOS flare / bloom around the sun and bright sky
  sharp += max(tone(textureLod(frame, suv, 4.0).rgb, e) - 0.8, 0.0) * 0.8;
  sharp = oetf(sharp); cC = oetf(cC);
  vec3 yiq = vec3(rgb2yiq(sharp).x, rgb2yiq(cC).yz);
  // OSD is overlaid at the FC (MAX7456), i.e. before the RF link degrades it
  vec4 o = osdAt(suv);
  yiq.x = mix(yiq.x, dot(o.rgb, vec3(0.333)), o.a);
  yiq.yz *= (1.0 - o.a);
  // chroma loss / B&W when the subcarrier is buried
  yiq.yz *= smoothstep(8.0, 16.0, cnr);
  // thermal noise (luma) + FM threshold "sparkles" (horizontal black/white streaks)
  float n = (hash(uv * vec2(frameW, frameH) + fract(time * 17.0) * 91.0) - 0.5);
  yiq.x += n * (0.03 + 0.55 * bad * bad);
  float sp = hash(vec2(floor(uv.x * frameW / 6.0), line) + fract(time * 13.0) * 37.0);
  float pSpark = exp(-(cnr - 4.0) / 2.5) * 0.08;
  if (pSpark > 1e-4 && sp < pSpark) yiq.x = hash(vec2(line, time)) > 0.5 ? 1.0 : 0.0;
  yiq.yz += (vec2(hash(uv + time), hash(uv - time)) - 0.5) * 0.25 * bad;
  vec3 rgb = yiq2rgb(yiq);
  // total loss: snow
  float snow = smoothstep(4.0, -2.0, cnr);
  rgb = mix(rgb, vec3(hash(uv * 731.0 + time * 61.0)), snow);
  // faint scanline structure
  rgb *= 0.94 + 0.06 * cos(uv.y * frameH * 3.14159);
  gl_FragColor = vec4(clamp(rgb, 0.0, 1.0), 1.0);
}`;

const digitalFS = commonPost + /* glsl */ `
void main() {
  vec2 uv = (vUv - 0.5) / screenFit + 0.5;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 || lost > 0.5) {
    // no signal: goggles show black (the HD OSD travels over the same link, so it is gone too)
    gl_FragColor = vec4(vec3(0.0), 1.0); return;
  }
  float e = texture2D(expTex, vec2(0.5)).r;
  vec2 suv = uv;
  vec3 c;
  if (hdz > 0.5) {
    // HDZero: no inter-frame compression; a weak link shows as torn horizontal strips and pixel
    // errors that grow gradually, with no smearing and no added latency
    float strip = floor(uv.y * frameH / 8.0);
    float sh = hash(vec2(strip, floor(time * 90.0)));
    if (sh < block * 0.35) suv.x = fract(uv.x + (hash(vec2(strip, time)) - 0.5) * 0.2 * block);
    c = texture2D(frame, suv).rgb;
    float px = hash(floor(uv * vec2(frameW, frameH) / 2.0) + floor(time * 90.0));
    if (px < block * block * 0.25) c = vec3(hash(uv + time), hash(uv - time), hash(uv * 3.0 + time));
  } else {
    // DJI / Walksnail: link margin -> compression quality: block size grows, blocks smear from the
    // previous frame; when frozen the decoder keeps showing its last frame
    vec2 bs = vec2(16.0) / vec2(frameW, frameH) * (1.0 + block * 3.0);
    vec2 bid = floor(uv / bs);
    float bh = hash(bid + floor(time * 20.0));
    if (block > 0.05) suv = mix(uv, (bid + 0.5) * bs, smoothstep(0.3, 1.0, block) * step(bh, block));
    c = (bh < block * 0.6 && freeze < 0.5) ? texture2D(prevFrame, suv).rgb : texture2D(frame, suv).rgb;
    // encoder smoothing at high motion (bitrate starvation)
    vec3 blur = textureLod(frame, suv, 1.5).rgb;
    c = mix(c, blur, 0.15 + 0.5 * block);
  }
  c = tone(c, e);
  // bloom from bright sky / sun
  vec3 glow = max(tone(textureLod(frame, uv, 4.0).rgb, e) - 0.85, 0.0);
  c += glow * 0.6;
  c = oetf(c);
  // HD OSD is drawn by the VTX/goggles after decoding: crisp
  vec4 o = osdAt(uv);
  c = mix(c, o.rgb, o.a);
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

export class FpvCamera {
  cubeRT: THREE.WebGLCubeRenderTarget;
  cubeCam: THREE.CubeCamera;
  frameRT: THREE.WebGLRenderTarget;
  prevRT: THREE.WebGLRenderTarget;
  private expRT: THREE.WebGLRenderTarget[];
  private expIdx = 0;
  private quadScene = new THREE.Scene();
  private quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private quad: THREE.Mesh;
  private fisheyeMat: THREE.ShaderMaterial;
  private expMat: THREE.ShaderMaterial;
  private postMat!: THREE.ShaderMaterial;
  video!: VideoSpec;
  mount = new THREE.Quaternion();
  field = 0;
  lastFrameAt = -1;

  constructor(private renderer: THREE.WebGLRenderer, cubeSize = 768) {
    this.cubeRT = new THREE.WebGLCubeRenderTarget(cubeSize, { type: THREE.HalfFloatType, generateMipmaps: false });
    this.cubeCam = new THREE.CubeCamera(0.02, 3000, this.cubeRT);
    this.frameRT = this.makeFrameRT(640, 480);
    this.prevRT = this.makeFrameRT(640, 480);
    this.expRT = [0, 1].map(() => new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType }));
    this.fisheyeMat = new THREE.ShaderMaterial({
      vertexShader: quadVS, fragmentShader: fisheyeFS, depthTest: false, depthWrite: false,
      uniforms: { cube: { value: this.cubeRT.texture }, camToWorld: { value: new THREE.Matrix3() }, halfFovDiag: { value: 1.4 }, aspect: { value: 4 / 3 }, kb: { value: new THREE.Vector4() }, omegaCam: { value: new THREE.Vector3() }, readout: { value: 0.016 } },
    });
    this.expMat = new THREE.ShaderMaterial({ vertexShader: quadVS, fragmentShader: exposureFS, depthTest: false, uniforms: { frame: { value: null }, prevExp: { value: null }, kUp: { value: 0.1 }, kDown: { value: 0.1 } } });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.fisheyeMat);
    this.quadScene.add(this.quad);
  }

  private makeFrameRT(w: number, h: number) {
    const rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter });
    return rt;
  }

  setVideo(v: VideoSpec, renderScale = 1) {
    this.video = v;
    const aspect = v.kind === 'analog' ? 4 / 3 : 16 / 9;
    // analog: the video standard's active lines (NTSC 480, PAL 576)
    const h = Math.round((v.kind === 'analog' ? (v.resolution[1] >= 576 ? 576 : 480) : 720) * renderScale);
    const w = Math.round(h * aspect);
    this.frameRT.dispose(); this.prevRT.dispose();
    this.frameRT = this.makeFrameRT(w, h); this.prevRT = this.makeFrameRT(w, h);
    const u = this.fisheyeMat.uniforms;
    u.aspect.value = aspect;
    // the frame corner must map to half the rated FOV after distortion: feed the shader the
    // distorted angle θ_d(halfFov) as its corner radius
    const hf = THREE.MathUtils.degToRad(v.fovDeg) / 2, [k1, k2, k3, k4] = v.fisheyeK, h2 = hf * hf;
    u.halfFovDiag.value = hf * (1 + k1 * h2 + k2 * h2 * h2 + k3 * h2 ** 3 + k4 * h2 ** 4);
    u.kb.value.set(...v.fisheyeK);
    u.readout.value = v.rollingShutterMs / 1000;
    this.postMat?.dispose();
    this.postMat = new THREE.ShaderMaterial({
      vertexShader: quadVS, fragmentShader: v.kind === 'analog' ? analogFS : digitalFS, depthTest: false,
      uniforms: {
        frame: { value: null }, prevFrame: { value: null }, osd: { value: null }, expTex: { value: null },
        time: { value: 0 }, cnr: { value: 40 }, osdOn: { value: 1 }, wdr: { value: v.kind === 'analog' ? 0.3 : 0.15 },
        frameW: { value: w }, frameH: { value: h }, oddField: { value: 0 }, interlaced: { value: v.interlaced ? 1 : 0 },
        freeze: { value: 0 }, block: { value: 0 }, lost: { value: 0 }, hdz: { value: v.system === 'hdzero' ? 1 : 0 }, gammaOut: { value: 1 / 2.2 }, osdRect: { value: new THREE.Vector4(0.03, 0.03, 0.97, 0.97) }, screenFit: { value: new THREE.Vector2(1, 1) },
      },
    });
  }

  /** Capture a new camera frame at the given lens pose (three world space). */
  capture(scene: THREE.Scene, lensPos: THREE.Vector3, lensQuat: THREE.Quaternion, omegaCam: THREE.Vector3, dtSinceLast: number) {
    const r = this.renderer;
    // keep previous field/frame for interlacing & digital freeze/smear
    const t = this.prevRT; this.prevRT = this.frameRT; this.frameRT = t;
    this.cubeCam.position.copy(lensPos);
    this.cubeCam.update(r, scene);
    const u = this.fisheyeMat.uniforms;
    u.camToWorld.value.setFromMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(lensQuat));
    u.omegaCam.value.copy(omegaCam);
    this.quad.material = this.fisheyeMat;
    r.setRenderTarget(this.frameRT);
    r.render(this.quadScene, this.quadCam);
    // auto exposure
    const src = this.expRT[this.expIdx], dst = this.expRT[1 - this.expIdx];
    this.expMat.uniforms.frame.value = this.frameRT.texture;
    this.expMat.uniforms.prevExp.value = src.texture;
    const dts = Math.max(dtSinceLast, 0.001);
    this.expMat.uniforms.kUp.value = 1 - Math.exp(-dts / 0.3);   // brightening into the dark
    this.expMat.uniforms.kDown.value = 1 - Math.exp(-dts / 0.1); // pulling down a sudden bright scene
    this.quad.material = this.expMat;
    r.setRenderTarget(dst);
    r.render(this.quadScene, this.quadCam);
    this.expIdx = 1 - this.expIdx;
    r.setRenderTarget(null);
    this.field = 1 - this.field;
  }

  /** Composite to the screen with link artefacts and OSD. */
  present(osdTex: THREE.Texture | null, osdAspect: number, time: number, link: { cnr: number; freeze: boolean; block: number; lost: number }, osdOn: boolean) {
    const r = this.renderer;
    const u = this.postMat.uniforms;
    u.frame.value = this.frameRT.texture; u.prevFrame.value = this.prevRT.texture; u.expTex.value = this.expRT[this.expIdx].texture;
    u.osd.value = osdTex; u.osdOn.value = osdOn && osdTex ? 1 : 0;
    // analog noise and tearing change once per video field, not per monitor refresh
    u.time.value = this.video.kind === 'analog' ? Math.floor(time * this.video.fps) / this.video.fps : time;
    u.cnr.value = link.cnr; u.freeze.value = link.freeze ? 1 : 0; u.block.value = link.block; u.lost.value = link.lost;
    u.oddField.value = this.field;
    // letterbox to screen
    const size = r.getSize(new THREE.Vector2());
    const fa = this.fisheyeMat.uniforms.aspect.value, sa = size.x / size.y;
    u.screenFit.value.set(sa > fa ? fa / sa : 1, sa > fa ? 1 : sa / fa);
    // OSD rectangle: centred, keeping the character grid's aspect within the frame
    const m = 0.03;
    const frameAspect = fa;
    let ow = 1 - 2 * m, oh = ((1 - 2 * m) * frameAspect) / osdAspect;
    if (oh > 1 - 2 * m) { oh = 1 - 2 * m; ow = (oh * osdAspect) / frameAspect; }
    u.osdRect.value.set(0.5 - ow / 2, 0.5 - oh / 2, 0.5 + ow / 2, 0.5 + oh / 2);
    this.quad.material = this.postMat;
    r.setRenderTarget(null);
    r.render(this.quadScene, this.quadCam);
  }

  dispose() { this.cubeRT.dispose(); this.frameRT.dispose(); this.prevRT.dispose(); for (const e of this.expRT) e.dispose(); }
}
