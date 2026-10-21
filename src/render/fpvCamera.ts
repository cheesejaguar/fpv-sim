// FPV camera emulation.
//  1. A cube camera at the lens, aligned with it, renders the world once per *camera frame* (so the
//     video has the camera's real cadence even on a 144 Hz monitor). The face behind the lens is never
//     sampled at <= 165° FOV and is skipped; the four side faces only render their forward part.
//  2. Fisheye pass: Kannala–Brandt projection (θ_d = θ(1 + k1θ² + k2θ⁴ + k3θ⁶ + k4θ⁸)) at the rated
//     diagonal FOV. Each pixel takes 4-8 cube samples spread over the pixel (anti-aliasing, with the
//     mip level from the fisheye's local compression) and over the row's exposure: rolling shutter and
//     motion blur follow the camera's real orientation through the frame (16 poses from the 1 kHz state
//     ring) plus a mount-vibration term from the props (a damaged prop → jello). Sun glare, veil and
//     lens ghosts; sensor noise ∝ √gain.
//  3. Auto-exposure (log-average + centre-weighted, asymmetric adaptation) sets gain and shutter time;
//     light above clip spreads into a small glow (bright LEDs); digital: temporal denoise.
//  4. Video link: analog (YIQ chroma bandwidth, FM-threshold noise / sparkles, sync tearing,
//     interlaced fields, colour loss) or digital (macroblocking, freeze, decimation) — then the OSD and
//     the goggles' own overlay.
import * as THREE from 'three';
import type { VideoSpec } from '../data/catalog';

// ---------------------------------------------------------------------------------------------
// Camera maths shared by the shaders and the frame loop (plain numbers: unit-tested)

/** Shortest / longest exposure: FPV cameras shorten the shutter in daylight (~1/2000 s) and open it
 *  to the frame period (~1/60 s) in the dark before they add gain. */
export const SHUTTER_MIN = 1 / 2000, SHUTTER_MAX = 1 / 60;
/** Exposure factor e (scene -> mid-grey, 0.06 … 5) at which the shutter is fully open. */
export const E_SHUTTER = 2;
/** Exposure time for exposure factor e: ~1/800 s in daylight (e ≈ 0.4), the frame period from
 *  E_SHUTTER on. Mirrored in fisheyeFS. */
export function shutterTime(e: number, fps: number): number {
  const smax = Math.min(SHUTTER_MAX, 1 / fps);
  return Math.min(Math.max(smax * Math.pow(Math.max(e, 0) / E_SHUTTER, 1.6), SHUTTER_MIN), smax);
}
/** Sensor gain behind exposure factor e: the analog / digital gain that brightens a dark scene (1× in
 *  bright daylight, 20× at the darkest the auto-exposure goes). */
export const E_UNITY = 0.25;
export const sensorGain = (e: number) => Math.max(1, e / E_UNITY);
/** Sensor noise (std dev, linear output units) at exposure factor e and output level y: photon shot
 *  noise amplified by the gain plus a read-noise floor, ∝ √gain. Digital cameras' spatial NR leaves
 *  ~60 %. Mirrored in fisheyeFS / tnrFS. */
export const NOISE_K = 0.012;
export function noiseSigma(e: number, y: number, k = NOISE_K): number { return k * Math.sqrt(sensorGain(e) * (Math.max(0, y) + 0.01)); }

/** Kannala–Brandt forward model: distorted angle θ_d for an incidence angle θ. */
export function kbDistort(theta: number, k: readonly number[]): number {
  const t2 = theta * theta;
  return theta * (1 + k[0] * t2 + k[1] * t2 * t2 + k[2] * t2 ** 3 + k[3] * t2 ** 4);
}
/** Where a camera-space direction (three camera: -Z forward, +Y up) lands in the frame, in the
 *  fisheye shader's centred coordinates (x across · aspect, y up, units of frame height). */
export function projectFisheye(d: { x: number; y: number; z: number }, halfFovDiag: number, k: readonly number[], aspect: number) {
  const len = Math.hypot(d.x, d.y, d.z) || 1;
  const theta = Math.acos(Math.max(-1, Math.min(1, -d.z / len)));
  const ph = Math.atan2(d.y, d.x);
  const r = (kbDistort(theta, k) / halfFovDiag) * (Math.hypot(aspect, 1) / 2);
  return { x: r * Math.cos(ph), y: r * Math.sin(ph), theta };
}
/** Rotation vector (axis · angle, rad) of a unit quaternion, shortest way round. */
export function quatToRotVec(q: { x: number; y: number; z: number; w: number }, out: ArrayLike<number> & { [i: number]: number }, o = 0) {
  const sg = q.w < 0 ? -1 : 1, x = q.x * sg, y = q.y * sg, z = q.z * sg, w = q.w * sg;
  const s = Math.hypot(x, y, z), k = s > 1e-9 ? (2 * Math.atan2(s, w)) / s : 2;
  out[o] = x * k; out[o + 1] = y * k; out[o + 2] = z * k;
}
/** Camera-mount vibration per motor: the once-per-revolution imbalance of each prop shakes the
 *  camera at the prop's rotation rate, with a force ∝ rpm² (normalised to this quad's hover rpm, so
 *  a whoop and a 7" behave alike). A healthy prop barely moves a soft-mounted camera; a chipped one
 *  rocks it a fraction of a degree and a broken one about a degree, which a short exposure's rolling
 *  shutter turns into jello and a long one into a shaky blur. amp in rad, freq in Hz. */
export function mountVibration(rpm: readonly number[], damage: readonly { thrust: number; broken: boolean }[] | undefined, hoverRpm: number) {
  const amp = [0, 0, 0, 0], freq = [0, 0, 0, 0];
  for (let k = 0; k < 4; k++) {
    const w = Math.abs(rpm[k] ?? 0), d = damage?.[k];
    const dmg = d ? (d.broken ? 1 : Math.max(0, Math.min(1, 1 - d.thrust))) : 0;
    const s = Math.min(3, (w / Math.max(1000, hoverRpm)) ** 2);
    amp[k] = Math.min(0.025, s * (0.0002 + 0.02 * dmg));
    freq[k] = w / 60;
  }
  return { amp, freq };
}
/** Blade solidity: share of the prop disc the blades cover (B · blade area / πR²) from the chord
 *  distribution (chord / R at evenly spaced stations from hub to tip). */
export function bladeSolidity(blades: number, chordFracs: readonly number[], hubFrac: number): number {
  const n = chordFracs.length;
  if (n < 2) return 0;
  let a = 0;
  for (let i = 0; i < n - 1; i++) a += (chordFracs[i] + chordFracs[i + 1]) / 2;
  return (blades * (a / (n - 1)) * (1 - hubFrac)) / Math.PI;
}
/** How a spinning prop looks in one exposure: each blade sweeps rpm × shutter of arc. Short sweeps
 *  freeze distinct blades; once the sweeps close the gaps between blades the prop reads as a disc
 *  whose opacity is the time-averaged blade coverage, i.e. the solidity. */
export function propLook(rpm: number, shutter: number, blades: number, solidity: number) {
  const sweep = (Math.abs(rpm) / 60) * 2 * Math.PI * shutter;
  const smear = Math.min(1, sweep / ((2 * Math.PI) / Math.max(1, blades)));
  const t = Math.max(0, Math.min(1, (smear - 0.1) / 0.4));
  return { sweepDeg: (sweep * 180) / Math.PI, blades: smear < 0.5, disc: smear > 0.1, discOpacity: Math.min(0.6, solidity * t * t * (3 - 2 * t)) };
}

// ---------------------------------------------------------------------------------------------
const quadVS = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const HASH = /* glsl */ `
// sin-free hash (Hoskins): fract(sin(x)*k) collapses to 0 for large x in fp32
float hash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }`;

export const ROT_N = 16;
const fisheyeFS = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform samplerCube cube;
uniform sampler2D expTex, sunTex;
uniform float halfFovDiag, aspect, readout, shutterMax, nSamples, footprint, seed, noiseK, hasNear;
uniform vec4 kb;
uniform vec3 rotTab[${ROT_N}];  // camera rotation (rotation vectors, camera frame) through the frame
uniform float tab0, tabDt;     // time of rotTab[0] relative to the frame's middle row, and spacing (s)
uniform vec4 vibAmp, vibFreq, vibPhase;
uniform float vibOn;
uniform vec3 sunCam, sunColor; // sun direction in camera space; its colour
uniform vec2 sunImg;           // sun position in centred frame coordinates
uniform float sunGain, ghostGain, veil;
const vec3 LUM = vec3(0.2126, 0.7152, 0.0722);
${HASH}
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
// camera orientation at time t (relative to the middle row) as a rotation vector
vec3 rotAt(float t) {
  float x = clamp((t - tab0) / tabDt, 0.0, ${ROT_N - 1}.0 - 0.001);
  int i = int(x);
  vec3 r = mix(rotTab[i], rotTab[i + 1], x - float(i));
  if (vibOn > 0.5) {
    // each prop's once-per-rev imbalance rocks the camera in pitch and yaw (a whirl)
    vec4 ph = vibPhase + 6.2831853 * vibFreq * t;
    r.x += dot(vibAmp, sin(ph)); r.y += dot(vibAmp, cos(ph));
  }
  return r;
}
vec3 omegaAt(float t) {
  float x = clamp((t - tab0) / tabDt, 0.0, ${ROT_N - 1}.0 - 0.001);
  int i = int(x);
  vec3 w = (rotTab[i + 1] - rotTab[i]) / tabDt;
  if (vibOn > 0.5) {
    vec4 ph = vibPhase + 6.2831853 * vibFreq * t, a = vibAmp * 6.2831853 * vibFreq;
    w.x += dot(a, cos(ph)); w.y -= dot(a, sin(ph));
  }
  return w;
}
vec3 rotate(vec3 d, vec3 r) {
  // Rodrigues; capped so a sample never leaves the part of the cube that was rendered
  float a = length(r);
  if (a < 1e-7) return d;
  vec3 k = r / a; a = min(a, 0.5);
  float c = cos(a), s = sin(a);
  return d * c + cross(k, d) * s + k * dot(k, d) * (1.0 - c);
}
vec3 ghost(vec2 q, vec2 at, float rad, vec3 col) {
  float x = length(q - at) / rad;
  return col * smoothstep(1.0, 0.8, x) * (0.45 + 0.55 * smoothstep(0.2, 0.95, x));
}
void main() {
  vec2 p = (vUv - 0.5) * vec2(aspect, 1.0);
  float rc = length(vec2(aspect, 1.0) * 0.5);
  float r = length(p);
  float th = kbTheta(r / rc * halfFovDiag);   // equidistant base radius -> distorted angle -> θ
  float ph = atan(p.y, p.x);
  vec3 d = vec3(sin(th) * cos(ph), sin(th) * sin(ph), -cos(th));
  // pixel footprint on the sphere: drives the mip level, so the compressed periphery doesn't shimmer
  vec3 gx = dFdx(d), gy = dFdy(d);
  float e = max(textureLod(expTex, vec2(0.5), 0.0).r, 0.06); // (0 before the first metering)
  // exposure time: short in daylight, up to the frame period in the dark (shutterTime() in JS)
  float shutter = clamp(shutterMax * pow(e / ${E_SHUTTER.toFixed(1)}, 1.6), ${SHUTTER_MIN}, shutterMax);
  // rolling shutter: rows read top -> bottom over 'readout' seconds; each row integrates over its
  // own exposure window, so fast rotation both skews and smears the picture
  float tRow = (0.5 - vUv.y) * readout;
  // the quad's own parts (alpha 1 in the cube, the world 0) are bolted to the camera: no skew, no blur
  bool own = hasNear > 0.5 && textureGrad(cube, d, gx * footprint, gy * footprint).a > 0.5;
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  for (int i = 0; i < 8; i++) {
    float fi = float(i);
    if (fi >= nSamples) break;
    vec2 j = fract(vec2(0.5) + fi * vec2(0.7548777, 0.5698403)) - 0.5;  // R2 sequence over the pixel
    float ts = tRow + ((fi + 0.5) / nSamples - 0.5) * shutter;
    vec3 ds = normalize(d + j.x * gx + j.y * gy);
    vec3 w = own ? ds : rotate(ds, rotAt(ts));
    // each sample stands for its share of the pixel, or (fast motion) for the arc it sweeps
    vec3 fx = gx * footprint, fy = gy * footprint;
    vec3 m = own ? vec3(0.0) : cross(omegaAt(ts), w) * (shutter / nSamples);
    if (dot(m, m) > dot(fx, fx)) { fx = m; fy = normalize(cross(m, w) + 1e-9) * length(gy) * footprint; }
    vec4 s = textureGrad(cube, w, fx, fy);
    // a world sample that lands on the quad would see what is behind it, which the cube doesn't have
    float k = own || hasNear < 0.5 ? 1.0 : step(s.a, 0.5);
    acc += min(s.rgb, vec3(6e4)) * k; // (min: a clear sky's sun disc can overflow half floats)
    wsum += k;
  }
  vec3 c = wsum > 0.0 ? acc / wsum : min(textureGrad(cube, d, gx, gy).rgb, vec3(6e4));
  // optical vignetting (cos^4 law, softened for fisheye)
  c *= pow(cos(min(th, 1.45) * 0.55), 3.0);
  // sun: lens glare (scatter in the glass: a bright core and a wide skirt), a veil over the whole
  // frame, and ghosts of the aperture reflected between elements, mirrored through the centre
  if (sunGain > 0.0) {
    // sun strength = visible share × disc luminance × disc solid angle (π · 0.53°²)
    vec2 sv = textureLod(sunTex, vec2(0.5), 0.0).rg;
    float S = sv.r * sv.g * 2.7e-4 * sunGain;
    float g = acos(clamp(dot(d, sunCam), -1.0, 1.0));
    float psf = 3.6 / (1.0 + g * g * 1600.0) + 0.28 * exp(-g * 5.0) + veil;
    vec2 q = (vUv - 0.5) * vec2(aspect, 1.0);
    vec3 gh = ghost(q, -0.42 * sunImg, 0.045, vec3(0.25, 0.9, 0.45)) + ghost(q, -0.85 * sunImg, 0.085, vec3(0.7, 0.35, 0.95)) * 0.6
            + ghost(q, -1.4 * sunImg, 0.03, vec3(1.0, 0.72, 0.3));
    c += S * (sunColor * psf + gh * ghostGain);
  }
  // the meter sees the clean signal (alpha: log luminance; its mip average = log-average luminance)
  float L = log(max(dot(c, LUM), 1e-3));
  // sensor noise before the camera's gamma: shot noise amplified by the gain + a read-noise floor
  // (noiseSigma() in JS), mostly luma with some chroma
  float y = max(dot(c, LUM), 0.0) * e;
  float sig = noiseK * sqrt(max(1.0, e / ${E_UNITY}) * (y + 0.01));
  vec2 fc = gl_FragCoord.xy + seed;
  float nl = hash(fc) + hash(fc + 71.3) - 1.0;
  vec3 nc = vec3(hash(fc + 13.1), hash(fc + 29.7), hash(fc + 47.9)) - 0.5;
  c = max(c + (nl * 1.2 + nc * 0.6) * (sig / e), 0.0);
  gl_FragColor = vec4(c, L);
}`;

/** Fraction of the sun's disc that is visible in the cube (16 taps across it). */
const sunProbeFS = /* glsl */ `
precision highp float;
uniform samplerCube cube;
uniform vec3 sunCam;
uniform float radius;
const vec3 LUM = vec3(0.2126, 0.7152, 0.0722);
void main() {
  vec3 t1 = normalize(cross(sunCam, abs(sunCam.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
  vec3 t2 = cross(sunCam, t1);
  float v = 0.0, lsum = 0.0;
  for (int i = 0; i < 16; i++) {
    float fi = float(i), a = fi * 2.39996, rr = radius * sqrt((fi + 0.5) / 16.0);
    float L = min(dot(textureLod(cube, normalize(sunCam + (t1 * cos(a) + t2 * sin(a)) * rr), 0.0).rgb, LUM), 6e4);
    float k = smoothstep(SUN_LO, SUN_HI, L);
    v += k; lsum += k * L;
  }
  // r: visible fraction, g: mean luminance of the visible part
  gl_FragColor = vec4(v / 16.0, lsum / max(v, 1e-3), 0.0, 1.0);
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
  // mid-grey target in linear light (the camera gamma brightens it to ~0.43 on screen); ~7 stops
  // of range: dark interiors brighten (noisily) but are not pushed to daylight, sky is pulled down
  float target = clamp(0.12 / max(lum, 1e-4), 0.06, 5.0);
  float prev = textureLod(prevExp, vec2(0.5), 0.0).r;
  if (!(prev > 0.0 && prev < 100.0)) prev = target; // first frame (and never let a NaN stick)
  // cameras react faster to over-exposure (bursting out into the sky) than to darkness
  gl_FragColor = vec4(mix(prev, target, target > prev ? kUp : kDown), 0.0, 0.0, 1.0);
}`;

// glow: light above clip spreads a few pixels (halation in the lens / sensor stack). Bright pass +
// separable Gaussian at half resolution: smooth, no blocky mip upsampling.
const GW = [1, 0.8007, 0.4111, 0.1353, 0.0286], GSUM = GW[0] + 2 * (GW[1] + GW[2] + GW[3] + GW[4]);
const blurFS = (bright: boolean) => /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D src, expTex;
uniform vec2 stepUv;
const float W[5] = float[5](${GW.map((w) => (w / GSUM).toFixed(5)).join(', ')});
vec3 tap(vec2 uv, float e) {
  vec3 c = textureLod(src, uv, 0.0).rgb;
  ${bright ? 'return min(max(c * e - 0.85, 0.0), 6.0) / e; // above clip, in scene units' : 'return c;'}
}
void main() {
  float e = max(textureLod(expTex, vec2(0.5), 0.0).r, 0.06); // (0 before the first metering)
  vec3 s = tap(vUv, e) * W[0];
  for (int i = 1; i < 5; i++) s += (tap(vUv + stepUv * float(i), e) + tap(vUv - stepUv * float(i), e)) * W[i];
  gl_FragColor = vec4(s, 1.0);
}`;

// Digital cameras' temporal noise reduction: blends each frame into the last where they differ by
// less than the noise. In the dark (high gain) the threshold is high, so moving low-contrast detail
// smears into ghost trails, as on DJI / Walksnail footage at dusk.
const tnrFS = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D cur, prev, expTex;
uniform float noiseK;
const vec3 LUM = vec3(0.2126, 0.7152, 0.0722);
void main() {
  vec4 c = textureLod(cur, vUv, 0.0);
  vec3 p = textureLod(prev, vUv, 0.0).rgb;
  if (any(isnan(p)) || any(isinf(p))) p = c.rgb; // the history is recursive: never let a bad value stick
  float e = max(textureLod(expTex, vec2(0.5), 0.0).r, 0.06); // (0 before the first metering)
  float strength = clamp((e - 0.7) / 2.5, 0.0, 0.85);
  float sig = noiseK * sqrt(max(1.0, e / ${E_UNITY}) * (max(dot(c.rgb, LUM), 0.0) * e + 0.01));
  float dl = length((c.rgb - p) * e);
  float th = 3.0 * sig + 0.012;
  float k = strength * exp(-0.5 * dl * dl / (th * th));
  gl_FragColor = vec4(min(mix(c.rgb, p, k), vec3(6e4)), c.a);
}`;

const commonPost = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D frame, prevFrame, glow, prevGlow, osd, gog, expTex;
uniform float time, cnr, osdOn, gogOn, glowK, wdr, frameH, frameW, oddField, interlaced, freeze, block, lost, hdz, gammaOut;
uniform vec4 osdRect;   // x0,y0,x1,y1 in frame uv
uniform vec2 screenFit; // scale of frame quad on screen (letterbox)
// Texture reads below use explicit LOD 0: they happen inside per-line / per-block choices (interlaced
// fields, macroblocks), where implicit derivatives are undefined. Apple GPUs (Metal, every Mac
// browser) then pick a far-too-blurry mip on alternate lines, which showed as heavy banding.
${HASH}
vec3 tone(vec3 c, float e) {
  c *= e;
  // WDR: log-ish compression of highlights, lift shadows
  c = mix(c, log2(1.0 + c * 3.0) / log2(4.0), wdr);
  // highlight shoulder (what a camera's WDR does): bright areas such as windows seen from a dark
  // interior roll off smoothly instead of hard-clipping to flat white. Half of it acts on luminance,
  // so bright sky keeps some of its colour rather than desaturating completely.
  const float K = 0.62;
  vec3 perCh = min(c, K) + (1.0 - K) * (1.0 - exp(-max(c - K, 0.0) / (1.0 - K)));
  float L = max(dot(c, vec3(0.2126, 0.7152, 0.0722)), 1e-4);
  float Ls = min(L, K) + (1.0 - K) * (1.0 - exp(-max(L - K, 0.0) / (1.0 - K)));
  return mix(perCh, min(c * (Ls / L), vec3(1.0)), 0.7);
}
// camera transfer curve (Rec.709-like gamma): the frame buffers are linear light
vec3 oetf(vec3 c) { return pow(max(c, 0.0), vec3(gammaOut)); }
vec4 osdAt(vec2 uv) {
  vec2 o = (uv - osdRect.xy) / (osdRect.zw - osdRect.xy);
  if (o.x < 0.0 || o.y < 0.0 || o.x > 1.0 || o.y > 1.0) return vec4(0.0);
  return textureLod(osd, vec2(o.x, o.y), 0.0) * osdOn;
}
// the goggles' own overlay (signal, recording ...) is drawn after the link, over the whole frame
vec3 goggle(vec3 c, vec2 uv) {
  vec4 g = textureLod(gog, uv, 0.0) * gogOn;
  return mix(c, g.rgb, g.a);
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
  float e = max(textureLod(expTex, vec2(0.5), 0.0).r, 0.06); // (0 before the first metering)
  bool useprev = interlaced > 0.5 && mod(line, 2.0) == oddField;
  // glow is smooth: one tap serves the luma, chroma and sharpening taps
  vec3 glw = (useprev ? textureLod(prevGlow, suv, 0.0).rgb : textureLod(glow, suv, 0.0).rgb) * glowK;
  // luma: full bandwidth tap, chroma: wide horizontal blur (~1.3 MHz vs 4.2 MHz luma)
  vec3 cY = useprev ? textureLod(prevFrame, suv, 0.0).rgb : textureLod(frame, suv, 0.0).rgb;
  vec3 cC = vec3(0.0);
  for (int i = -3; i <= 3; i++) {
    vec2 ou = suv + vec2(float(i) * 1.6 / frameW, 0.0);
    cC += useprev ? textureLod(prevFrame, ou, 0.0).rgb : textureLod(frame, ou, 0.0).rgb;
  }
  cC /= 7.0;
  cY = tone(cY + glw, e); cC = tone(cC + glw, e);
  // sharpening ringing typical of analog cameras
  // (taps from the same field as the centre sample, or moving edges ghost)
  vec2 dl = vec2(1.5 / frameW, 0.0);
  vec3 cL = tone((useprev ? textureLod(prevFrame, suv - dl, 0.0).rgb : textureLod(frame, suv - dl, 0.0).rgb) + glw, e);
  vec3 cR = tone((useprev ? textureLod(prevFrame, suv + dl, 0.0).rgb : textureLod(frame, suv + dl, 0.0).rgb) + glw, e);
  vec3 sharp = cY + (cY - 0.5 * (cL + cR)) * 0.6;
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
  gl_FragColor = vec4(goggle(clamp(rgb, 0.0, 1.0), uv), 1.0);
}`;

const digitalFS = commonPost + /* glsl */ `
void main() {
  vec2 uv = (vUv - 0.5) / screenFit + 0.5;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { gl_FragColor = vec4(vec3(0.0), 1.0); return; }
  // no signal: goggles show black (the HD OSD travels over the same link, so it is gone too)
  if (lost > 0.5) { gl_FragColor = vec4(goggle(vec3(0.0), uv), 1.0); return; }
  float e = max(textureLod(expTex, vec2(0.5), 0.0).r, 0.06); // (0 before the first metering)
  vec2 suv = uv;
  vec3 c;
  if (hdz > 0.5) {
    // HDZero: no inter-frame compression; a weak link shows as torn horizontal strips and pixel
    // errors that grow gradually, with no smearing and no added latency
    float strip = floor(uv.y * frameH / 8.0);
    float sh = hash(vec2(strip, floor(time * 90.0)));
    if (sh < block * 0.35) suv.x = fract(uv.x + (hash(vec2(strip, time)) - 0.5) * 0.2 * block);
    c = textureLod(frame, suv, 0.0).rgb + textureLod(glow, suv, 0.0).rgb * glowK;
    float px = hash(floor(uv * vec2(frameW, frameH) / 2.0) + floor(time * 90.0));
    if (px < block * block * 0.25) c = vec3(hash(uv + time), hash(uv - time), hash(uv * 3.0 + time));
  } else {
    // DJI / Walksnail: link margin -> compression quality: block size grows, blocks smear from the
    // previous frame; when frozen the decoder keeps showing its last frame
    vec2 bs = vec2(16.0) / vec2(frameW, frameH) * (1.0 + block * 3.0);
    vec2 bid = floor(uv / bs);
    float bh = hash(bid + floor(time * 20.0));
    if (block > 0.05) suv = mix(uv, (bid + 0.5) * bs, smoothstep(0.3, 1.0, block) * step(bh, block));
    c = (bh < block * 0.6 && freeze < 0.5) ? textureLod(prevFrame, suv, 0.0).rgb : textureLod(frame, suv, 0.0).rgb;
    // encoder smoothing at high motion (bitrate starvation)
    vec3 blur = textureLod(frame, suv, 1.5).rgb;
    c = mix(c, blur, 0.15 + 0.5 * block) + textureLod(glow, suv, 0.0).rgb * glowK;
  }
  c = tone(c, e);
  c = oetf(c);
  // HD OSD is drawn by the VTX/goggles after decoding: crisp
  vec4 o = osdAt(uv);
  c = mix(c, o.rgb, o.a);
  gl_FragColor = vec4(goggle(clamp(c, 0.0, 1.0), uv), 1.0);
}`;

// Sun disc luminance in the cube (Sky.js disc scaled by the map's sky scale) is ~10-100× the
// brightest sky; anything below SUN_LO is cloud / wall / sky.
const SUN_LO = 4.0, SUN_HI = 20.0;

interface Face { i: number; vp: THREE.Vector4 }
type Rect = { x: number; y: number; w: number; h: number };

export class FpvCamera {
  cubeRT: THREE.WebGLCubeRenderTarget;
  cubeCam: THREE.CubeCamera;
  private nearCam: THREE.CubeCamera;
  private faces: Face[] = [];
  frameRT: THREE.WebGLRenderTarget;
  prevRT: THREE.WebGLRenderTarget;
  private rawRT: THREE.WebGLRenderTarget | null = null;
  private glowTmp!: THREE.WebGLRenderTarget;
  private glowRT!: THREE.WebGLRenderTarget;
  private prevGlowRT!: THREE.WebGLRenderTarget;
  private expRT: THREE.WebGLRenderTarget[];
  private sunRT: THREE.WebGLRenderTarget;
  private expIdx = 0;
  private quadScene = new THREE.Scene();
  private quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private quad: THREE.Mesh;
  private fisheyeMat: THREE.ShaderMaterial;
  private sunMat: THREE.ShaderMaterial;
  private expMat: THREE.ShaderMaterial;
  private brightMat: THREE.ShaderMaterial;
  private blurMat: THREE.ShaderMaterial;
  private tnrMat: THREE.ShaderMaterial;
  private postMat!: THREE.ShaderMaterial;
  // shadow-map refresh: an empty render (camera looking at nothing) with the whole scene visible
  private voidCam = new THREE.PerspectiveCamera(1, 1, 1, 2);
  private voidRT = new THREE.WebGLRenderTarget(1, 1);
  video!: VideoSpec;
  field = 0;
  private seed = 0;
  private reading = false;
  private expBuf = new Float32Array(4);
  private captures = 0;
  /** Exposure factor the auto-exposure settled on (read back from the GPU a frame or two late). */
  exposure = 0.4;
  /** Glass-to-glass latency being emulated now: catalog (or override) + link extra − display compensation (ms). */
  effectiveLatencyMs = 0;
  /** Sun direction (three world space, unit) and colour; the frame loop copies the scene's. */
  sunDir = new THREE.Vector3(0, 1, 0);
  sunColor = new THREE.Color(1, 1, 1);
  /** Camera orientation through the frame (see setMotion) and mount vibration (see setVibration). */
  private rotTab = new Float32Array(ROT_N * 3);
  /** Where the last presented video frame, its OSD grid and the goggle overlay's text blocks (none
   *  when it is off) sit on screen (CSS px, top-left origin). */
  layout: { frame: Rect; osd: Rect; goggle: Rect[] } = { frame: { x: 0, y: 0, w: 0, h: 0 }, osd: { x: 0, y: 0, w: 0, h: 0 }, goggle: [] };

  constructor(private renderer: THREE.WebGLRenderer, cubeSize = 768) {
    this.cubeRT = this.makeCubeRT(cubeSize);
    this.cubeCam = new THREE.CubeCamera(0.02, 3000, this.cubeRT);
    // the quad's own props / ducts pass within a centimetre of the lens: a second pass with a
    // 3 mm near plane draws them, so the world pass keeps its depth precision
    this.nearCam = new THREE.CubeCamera(0.003, 2, this.cubeRT);
    this.layoutFaces();
    this.frameRT = this.makeFrameRT(640, 480);
    this.prevRT = this.makeFrameRT(640, 480);
    this.makeGlowRTs(640, 480);
    // exposure state: float + nearest (read back on the CPU, and no float-linear filtering needed)
    const rt1 = () => new THREE.WebGLRenderTarget(1, 1, { type: THREE.FloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false });
    this.expRT = [rt1(), rt1()];
    this.sunRT = rt1();
    const U = <T,>(value: T) => ({ value });
    this.fisheyeMat = new THREE.ShaderMaterial({
      vertexShader: quadVS, fragmentShader: fisheyeFS, depthTest: false, depthWrite: false,
      uniforms: {
        cube: U(this.cubeRT.texture), expTex: U<THREE.Texture | null>(null), sunTex: U(this.sunRT.texture),
        halfFovDiag: U(1.4), aspect: U(4 / 3), kb: U(new THREE.Vector4()), readout: U(0.016), shutterMax: U(SHUTTER_MAX),
        nSamples: U(4), footprint: U(0.6), seed: U(0), noiseK: U(NOISE_K), hasNear: U(0),
        rotTab: U(Array.from({ length: ROT_N }, () => new THREE.Vector3())), tab0: U(-0.02), tabDt: U(0.04 / (ROT_N - 1)),
        vibAmp: U(new THREE.Vector4()), vibFreq: U(new THREE.Vector4()), vibPhase: U(new THREE.Vector4()), vibOn: U(0),
        sunCam: U(new THREE.Vector3(0, 0, -1)), sunColor: U(new THREE.Color()), sunImg: U(new THREE.Vector2()), sunGain: U(0), ghostGain: U(0), veil: U(0.014),
      },
    });
    this.sunMat = new THREE.ShaderMaterial({ vertexShader: quadVS, fragmentShader: sunProbeFS.replace('SUN_LO', SUN_LO.toFixed(1)).replace('SUN_HI', SUN_HI.toFixed(1)), depthTest: false, uniforms: { cube: U(this.cubeRT.texture), sunCam: U(new THREE.Vector3()), radius: U(0.0072) } });
    this.expMat = new THREE.ShaderMaterial({ vertexShader: quadVS, fragmentShader: exposureFS, depthTest: false, uniforms: { frame: U(null), prevExp: U(null), kUp: U(0.1), kDown: U(0.1) } });
    this.brightMat = new THREE.ShaderMaterial({ vertexShader: quadVS, fragmentShader: blurFS(true), depthTest: false, uniforms: { src: U(null), expTex: U(null), stepUv: U(new THREE.Vector2()) } });
    this.blurMat = new THREE.ShaderMaterial({ vertexShader: quadVS, fragmentShader: blurFS(false), depthTest: false, uniforms: { src: U(null), expTex: U(null), stepUv: U(new THREE.Vector2()) } });
    this.tnrMat = new THREE.ShaderMaterial({ vertexShader: quadVS, fragmentShader: tnrFS, depthTest: false, uniforms: { cur: U(null), prev: U(null), expTex: U(null), noiseK: U(NOISE_K) } });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.fisheyeMat);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
    this.voidCam.position.set(0, 1e7, 0); this.voidCam.lookAt(1, 1e7, 0); this.voidCam.updateMatrixWorld();
  }

  get cubeSize() { return this.cubeRT.width; }

  /** Cube map resolution (Settings → Video). */
  setCubeSize(n: number) {
    if (n === this.cubeRT.width) return;
    this.cubeRT.dispose();
    this.cubeRT = this.makeCubeRT(n);
    this.cubeCam.renderTarget = this.nearCam.renderTarget = this.cubeRT;
    this.fisheyeMat.uniforms.cube.value = this.sunMat.uniforms.cube.value = this.cubeRT.texture;
    this.layoutFaces();
  }

  private makeCubeRT(n: number) {
    // mipmapped + anisotropic: each fisheye sample is filtered over its own footprint (the periphery
    // compresses the cube several times), which is what keeps fences and wires from shimmering
    const rt = new THREE.WebGLCubeRenderTarget(n, { type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter });
    rt.texture.anisotropy = 8;
    return rt;
  }

  /**
   * The cube turns with the lens. Its back face is never sampled (a ≤165° fisheye stays within 83°
   * of the axis; rolling shutter / blur samples are capped at 29° beyond that), so it is skipped,
   * and each side face renders only the part facing forward: an off-axis frustum over that part of
   * the face, so culling drops what lies behind as well: ~32 % fewer cube pixels than 6 full faces.
   */
  private layoutFaces() {
    const r = this.renderer, n = this.cubeRT.width;
    for (const cc of [this.cubeCam, this.nearCam]) {
      cc.coordinateSystem = r.coordinateSystem; cc.updateCoordinateSystem();
      cc.position.set(0, 0, 0); cc.quaternion.identity(); cc.updateMatrixWorld(true);
      for (const c of cc.children as THREE.PerspectiveCamera[]) c.updateProjectionMatrix(); // full faces again
    }
    const M = 0.55; // margin past 90° (tan of the extra angle: 0.55 → ~29°)
    const look = new THREE.Vector3(), v = new THREE.Vector3();
    this.faces = [];
    const cams = this.cubeCam.children as THREE.PerspectiveCamera[];
    cams.forEach((cam, i) => {
      cam.getWorldDirection(look);
      if (look.z > 0.9) return; // behind the lens
      let x0 = -1, x1 = 1, y0 = -1, y1 = 1;
      if (look.z > -0.9) {
        // side face: which edge of it points forward (cube -Z)?
        v.copy(look).add(new THREE.Vector3(0, 0, -0.5)).project(cam);
        if (Math.abs(v.x) > Math.abs(v.y)) { if (v.x > 0) x0 = -M; else x1 = M; } else { if (v.y > 0) y0 = -M; else y1 = M; }
      }
      const px0 = Math.floor(((x0 + 1) / 2) * n), px1 = Math.ceil(((x1 + 1) / 2) * n), py0 = Math.floor(((y0 + 1) / 2) * n), py1 = Math.ceil(((y1 + 1) / 2) * n);
      this.faces.push({ i, vp: new THREE.Vector4(px0, py0, px1 - px0, py1 - py0) });
      // projection of the sub-rectangle: NDC [a, b] of the full face mapped to [-1, 1]
      const a0 = (px0 / n) * 2 - 1, a1 = (px1 / n) * 2 - 1, b0 = (py0 / n) * 2 - 1, b1 = (py1 / n) * 2 - 1;
      const sx = 2 / (a1 - a0), sy = 2 / (b1 - b0);
      const S = new THREE.Matrix4().set(sx, 0, 0, -sx * (a0 + a1) / 2, 0, sy, 0, -sy * (b0 + b1) / 2, 0, 0, 1, 0, 0, 0, 0, 1);
      for (const cc of [this.cubeCam, this.nearCam]) {
        const c = cc.children[i] as THREE.PerspectiveCamera;
        c.projectionMatrix.premultiply(S);
        c.projectionMatrixInverse.copy(c.projectionMatrix).invert();
      }
    });
  }

  private makeFrameRT(w: number, h: number) {
    return new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false });
  }

  private makeGlowRTs(w: number, h: number) {
    const mk = () => new THREE.WebGLRenderTarget(Math.ceil(w / 2), Math.ceil(h / 2), { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false });
    this.glowTmp?.dispose(); this.glowRT?.dispose(); this.prevGlowRT?.dispose();
    this.glowTmp = mk(); this.glowRT = mk(); this.prevGlowRT = mk();
  }

  setVideo(v: VideoSpec, renderScale = 1) {
    this.video = v;
    const aspect = v.kind === 'analog' ? 4 / 3 : 16 / 9;
    // analog: the video standard's active lines (NTSC 480, PAL 576)
    const h = Math.round((v.kind === 'analog' ? (v.resolution[1] >= 576 ? 576 : 480) : 720) * renderScale);
    const w = Math.round(h * aspect);
    this.frameRT.dispose(); this.prevRT.dispose(); this.rawRT?.dispose();
    this.frameRT = this.makeFrameRT(w, h); this.prevRT = this.makeFrameRT(w, h);
    // digital: the fisheye renders to a raw buffer that the temporal denoiser then feeds into frameRT
    this.rawRT = v.kind === 'digital' ? this.makeFrameRT(w, h) : null;
    this.makeGlowRTs(w, h);
    const u = this.fisheyeMat.uniforms;
    u.aspect.value = aspect;
    // the frame corner must map to half the rated FOV after distortion: feed the shader the
    // distorted angle θ_d(halfFov) as its corner radius
    u.halfFovDiag.value = kbDistort(THREE.MathUtils.degToRad(v.fovDeg) / 2, v.fisheyeK);
    u.kb.value.set(...v.fisheyeK);
    u.readout.value = v.rollingShutterMs / 1000;
    u.shutterMax.value = Math.min(SHUTTER_MAX, 1 / v.fps);
    // digital cameras run spatial noise reduction before encoding: less grain, at the cost of detail
    u.noiseK.value = this.tnrMat.uniforms.noiseK.value = NOISE_K * (v.kind === 'digital' ? 0.6 : 1);
    this.postMat?.dispose();
    this.postMat = new THREE.ShaderMaterial({
      vertexShader: quadVS, fragmentShader: v.kind === 'analog' ? analogFS : digitalFS, depthTest: false,
      uniforms: {
        frame: { value: null }, prevFrame: { value: null }, glow: { value: null }, prevGlow: { value: null }, osd: { value: null }, gog: { value: null }, expTex: { value: null },
        time: { value: 0 }, cnr: { value: 40 }, osdOn: { value: 1 }, gogOn: { value: 0 }, glowK: { value: 0.6 }, wdr: { value: v.kind === 'analog' ? 0.3 : 0.15 },
        frameW: { value: w }, frameH: { value: h }, oddField: { value: 0 }, interlaced: { value: v.interlaced ? 1 : 0 },
        freeze: { value: 0 }, block: { value: 0 }, lost: { value: 0 }, hdz: { value: v.system === 'hdzero' ? 1 : 0 }, gammaOut: { value: 1 / 2.2 }, osdRect: { value: new THREE.Vector4(0.03, 0.03, 0.97, 0.97) }, screenFit: { value: new THREE.Vector2(1, 1) },
      },
    });
  }

  /** Shutter time the camera is using now (s). */
  get shutter() { return shutterTime(this.exposure, this.video?.fps ?? 60); }

  /** The motion window one capture needs: rows span ±readout/2 around the middle row, each exposed for up to ±shutter/2. */
  motionWindow() {
    const half = (this.video.rollingShutterMs / 1000 + Math.min(SHUTTER_MAX, 1 / this.video.fps)) / 2;
    return { t0: -half, dt: (2 * half) / (ROT_N - 1) };
  }

  /**
   * Camera orientation through the frame: lensAt(t, q) writes the lens orientation at time t
   * (s, relative to the middle row's time) into q. Stored as rotations relative to the middle row,
   * in the camera's frame (the cube is rendered at the middle row's pose).
   */
  setMotion(lensAt: (t: number, q: THREE.Quaternion) => void) {
    const { t0, dt } = this.motionWindow();
    const q0 = new THREE.Quaternion(), q = new THREE.Quaternion();
    lensAt(0, q0); q0.invert();
    const tab = this.rotTab;
    for (let k = 0; k < ROT_N; k++) { lensAt(t0 + k * dt, q); quatToRotVec(q.premultiply(q0), tab, k * 3); }
    const u = this.fisheyeMat.uniforms;
    (u.rotTab.value as THREE.Vector3[]).forEach((v, k) => v.fromArray(tab, k * 3));
    u.tab0.value = t0; u.tabDt.value = dt;
  }

  /** Mount vibration (mountVibration()): amplitude rad, frequency Hz per motor; t = capture time (s) for continuous phase. */
  setVibration(v: { amp: number[]; freq: number[] }, t: number) {
    const u = this.fisheyeMat.uniforms;
    u.vibAmp.value.fromArray(v.amp); u.vibFreq.value.fromArray(v.freq);
    u.vibPhase.value.set(...(v.freq.map((f, k) => ((2 * Math.PI * f * t) % (2 * Math.PI)) + k * 1.7) as [number, number, number, number]));
    u.vibOn.value = v.amp.some((a) => a > 2e-5) ? 1 : 0;
  }

  /**
   * Refresh the shadow map with the whole quad in it (the capture hides the quad while it renders the
   * world pass): an otherwise empty render, from a camera that sees nothing, still runs the shadow pass.
   */
  renderShadows(scene: THREE.Scene) {
    const r = this.renderer, prev = r.getRenderTarget();
    r.shadowMap.needsUpdate = true;
    r.setRenderTarget(this.voidRT);
    r.render(scene, this.voidCam);
    r.setRenderTarget(prev);
  }

  /** Capture a new camera frame at the given lens pose (three world space, the frame's middle row).
   *  near: the quad itself (drawn in the near pass, on top of the world). */
  capture(scene: THREE.Scene, lensPos: THREE.Vector3, lensQuat: THREE.Quaternion, dtSinceLast: number, near?: THREE.Object3D) {
    const r = this.renderer, digital = this.video.kind === 'digital';
    // keep previous field/frame for interlacing & digital freeze/smear / denoise
    let t = this.prevRT; this.prevRT = this.frameRT; this.frameRT = t;
    t = this.prevGlowRT; this.prevGlowRT = this.glowRT; this.glowRT = t;
    this.renderCube(scene, lensPos, lensQuat, near);
    this.fisheyeMat.uniforms.hasNear.value = near ? 1 : 0;
    const expTex = this.expRT[this.expIdx].texture; // last frame's exposure (gain, shutter)
    const u = this.fisheyeMat.uniforms;
    // sun in camera space: is it in (or near) the picture, and how much of it does the cube show?
    const sunCam = u.sunCam.value.copy(this.sunDir).applyQuaternion(new THREE.Quaternion().copy(lensQuat).invert()).normalize();
    const sp = projectFisheye(sunCam, u.halfFovDiag.value, this.video.fisheyeK, u.aspect.value);
    // glare from the front element fades once the sun is well outside the field of view; the cube
    // only exists up to ~110° off the axis
    const deg = THREE.MathUtils.radToDeg(sp.theta);
    u.sunGain.value = smooth(110, 85, deg); u.ghostGain.value = 0.08 * smooth(100, 78, deg);
    u.sunImg.value.set(sp.x, sp.y);
    const sc = this.sunColor, sl = 0.2126 * sc.r + 0.7152 * sc.g + 0.0722 * sc.b;
    u.sunColor.value.copy(sc).multiplyScalar(1 / Math.max(1e-3, sl)); // tint only: S carries the brightness
    if (u.sunGain.value > 0) {
      this.sunMat.uniforms.sunCam.value.copy(sunCam);
      this.quad.material = this.sunMat;
      r.setRenderTarget(this.sunRT); r.render(this.quadScene, this.quadCam);
    }
    // more samples when the picture moves more than a couple of pixels during the exposure
    const raw = digital ? this.rawRT! : this.frameRT;
    const pxPerRad = raw.height / ((2 * u.halfFovDiag.value) / Math.hypot(u.aspect.value, 1));
    const om = u.rotTab.value as THREE.Vector3[];
    const va = u.vibAmp.value as THREE.Vector4, vf = u.vibFreq.value as THREE.Vector4;
    const rate = om[ROT_N - 1].distanceTo(om[0]) / (u.tabDt.value * (ROT_N - 1)) + 2 * Math.PI * (va.x * vf.x + va.y * vf.y + va.z * vf.z + va.w * vf.w);
    u.nSamples.value = rate * this.shutter * pxPerRad > 2.5 ? 8 : 4;
    u.footprint.value = u.nSamples.value > 4 ? 0.45 : 0.6;
    u.expTex.value = expTex;
    this.seed = (this.seed + 1) % 4096; u.seed.value = this.seed * 17.17;
    this.quad.material = this.fisheyeMat;
    r.setRenderTarget(raw); r.render(this.quadScene, this.quadCam);
    if (digital) {
      const tu = this.tnrMat.uniforms;
      tu.cur.value = raw.texture; tu.prev.value = this.prevRT.texture; tu.expTex.value = expTex;
      this.quad.material = this.tnrMat;
      r.setRenderTarget(this.frameRT); r.render(this.quadScene, this.quadCam);
    }
    // glow above clip: bright pass + horizontal blur, then vertical, at half resolution
    const bu = this.brightMat.uniforms, vu = this.blurMat.uniforms;
    bu.src.value = raw.texture; bu.expTex.value = expTex; bu.stepUv.value.set(1 / this.glowTmp.width, 0);
    this.quad.material = this.brightMat;
    r.setRenderTarget(this.glowTmp); r.render(this.quadScene, this.quadCam);
    vu.src.value = this.glowTmp.texture; vu.stepUv.value.set(0, 1 / this.glowTmp.height);
    this.quad.material = this.blurMat;
    r.setRenderTarget(this.glowRT); r.render(this.quadScene, this.quadCam);
    // auto exposure
    const src = this.expRT[this.expIdx], dst = this.expRT[1 - this.expIdx];
    this.expMat.uniforms.frame.value = raw.texture;
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
    // the shutter / prop look on the CPU side follow the exposure a frame or two late (no stall)
    if (!this.reading && this.captures++ % 3 === 0) {
      this.reading = true;
      r.readRenderTargetPixelsAsync(dst, 0, 0, 1, 1, this.expBuf).then((b) => { if (b[0] > 0) this.exposure = b[0]; }, () => {}).finally(() => { this.reading = false; });
    }
  }

  private renderCube(scene: THREE.Scene, lensPos: THREE.Vector3, lensQuat: THREE.Quaternion, near?: THREE.Object3D) {
    const r = this.renderer, rt = this.cubeRT, tex = rt.texture, n = rt.width;
    for (const cc of [this.cubeCam, this.nearCam]) { cc.position.copy(lensPos); cc.quaternion.copy(lensQuat); cc.updateMatrixWorld(true); }
    const gm = tex.generateMipmaps, xr = r.xr.enabled, au = scene.matrixWorldAutoUpdate;
    r.xr.enabled = false;
    tex.generateMipmaps = false; // once, after the last face
    // every render() would walk the whole scene to update world matrices: once is enough
    scene.updateMatrixWorld(); scene.matrixWorldAutoUpdate = false;
    const faces = this.faces, last = faces.length - 1;
    if (near) near.visible = false;
    faces.forEach((f, k) => {
      if (!near && k === last) tex.generateMipmaps = gm;
      rt.viewport.copy(f.vp); rt.scissor.copy(f.vp); rt.scissorTest = true;
      r.setRenderTarget(rt, f.i);
      r.render(scene, this.cubeCam.children[f.i] as THREE.Camera);
    });
    if (near) {
      near.visible = true;
      // near pass: only the quad (and the lights), depth cleared per face so it sits on top
      const hidden: THREE.Object3D[] = [];
      for (const c of scene.children) if (c !== near && c.visible && !(c as THREE.Light).isLight) { c.visible = false; hidden.push(c); }
      const bg = scene.background, ac = r.autoClear;
      scene.background = null; r.autoClear = false;
      // its pixels are tagged in alpha: the world's alpha is cleared to 0 together with the depth,
      // the quad's opaque parts then write 1 (a spinning prop disc only its opacity, so the world
      // behind it still smears), and the fisheye keeps them out of the motion blur
      const gl = r.getContext(), cc = r.getClearColor(new THREE.Color()), ca = r.getClearAlpha();
      r.setClearColor(cc, 0);
      faces.forEach((f, k) => {
        if (k === last) tex.generateMipmaps = gm;
        rt.viewport.copy(f.vp); rt.scissor.copy(f.vp); rt.scissorTest = true;
        r.setRenderTarget(rt, f.i);
        gl.colorMask(false, false, false, true);
        r.clear(true, true, false);
        gl.colorMask(true, true, true, true);
        r.render(scene, this.nearCam.children[f.i] as THREE.Camera);
      });
      r.setClearColor(cc, ca);
      r.autoClear = ac; scene.background = bg;
      for (const c of hidden) c.visible = true;
    }
    rt.viewport.set(0, 0, n, n); rt.scissor.set(0, 0, n, n); rt.scissorTest = false;
    tex.generateMipmaps = gm; r.xr.enabled = xr; scene.matrixWorldAutoUpdate = au;
  }

  /** Composite to the screen with link artefacts, OSD and the goggles' overlay. */
  present(osdTex: THREE.Texture | null, osdAspect: number, time: number, link: { cnr: number; freeze: boolean; block: number; lost: number }, osdOn: boolean, gog: { texture: THREE.Texture; boxes: Rect[] } | null = null) {
    const gogTex = gog?.texture ?? null;
    const r = this.renderer;
    const u = this.postMat.uniforms;
    u.frame.value = this.frameRT.texture; u.prevFrame.value = this.prevRT.texture; u.expTex.value = this.expRT[this.expIdx].texture;
    u.glow.value = this.glowRT.texture; u.prevGlow.value = this.prevGlowRT.texture;
    u.osd.value = osdTex; u.osdOn.value = osdOn && osdTex ? 1 : 0;
    u.gog.value = gogTex; u.gogOn.value = gogTex ? 1 : 0;
    // analog noise and tearing change once per video field, not per monitor refresh; wrapped so the
    // fp32 shader time keeps its precision after hours of flying
    const tq = this.video.kind === 'analog' ? Math.floor(time * this.video.fps) / this.video.fps : time;
    u.time.value = tq % 1000;
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
    // same rectangles in CSS pixels for the HUD layout
    const cw = r.domElement.clientWidth || size.x, ch = r.domElement.clientHeight || size.y;
    const fw = u.screenFit.value.x * cw, fh = u.screenFit.value.y * ch;
    const f = this.layout.frame; f.x = (cw - fw) / 2; f.y = (ch - fh) / 2; f.w = fw; f.h = fh;
    const o = this.layout.osd; o.w = ow * fw; o.h = oh * fh; o.x = f.x + (0.5 - ow / 2) * fw; o.y = f.y + (0.5 - oh / 2) * fh;
    this.layout.goggle = (gog?.boxes ?? []).map((b) => ({ x: f.x + b.x * fw, y: f.y + b.y * fh, w: b.w * fw, h: b.h * fh }));
    this.quad.material = this.postMat;
    r.setRenderTarget(null);
    r.render(this.quadScene, this.quadCam);
  }

  dispose() {
    this.cubeRT.dispose(); this.frameRT.dispose(); this.prevRT.dispose(); this.rawRT?.dispose();
    this.glowTmp.dispose(); this.glowRT.dispose(); this.prevGlowRT.dispose(); this.sunRT.dispose(); this.voidRT.dispose();
    for (const e of this.expRT) e.dispose();
    for (const m of [this.fisheyeMat, this.sunMat, this.expMat, this.brightMat, this.blurMat, this.tnrMat, this.postMat]) m?.dispose();
  }
}

function smooth(e0: number, e1: number, x: number) { const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); }
