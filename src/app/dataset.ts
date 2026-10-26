// Datasets from the FPV camera: every recorded frame is the picture (the clean camera image, and
// optionally what the goggles received), per-pixel ground truth through the same lens (range,
// semantic class, instance: src/render/groundTruth.ts) and labels: camera intrinsics and pose, the
// quad's state and sticks, and every gate's opening corners projected into the image with their
// visibility (drone-racing perception). Frames are grabbed right after the camera captured them, so
// picture, ground truth and labels belong to the same instant. Works in live flight and in lap
// replays. Output: a .zip (Settings → Research), or one event per frame over the control API.
// Format: docs/DATASET.md.
import * as THREE from 'three';
import { openingCentre } from '../maps/gates';
import type { GateDef } from '../maps/world';
import { enuToThree } from '../render/coords';
import { projectFisheye } from '../render/fpvCamera';
import { GroundTruthCamera, GT_CLASSES } from '../render/groundTruth';
import { R } from '../worker/shared';
import { APP_VERSION } from '../ui/menu/about';
import type { AppCtx, CameraFrame } from './context';
import { encodePng, toBase64, ZipWriter } from './datasetFiles';

export const DATASET_FORMAT = 'fpvsim-dataset';
export const DATASET_VERSION = 1;
/** Depth images: uint16 millimetres; this value (and 0, nothing hit) mark "no range". */
export const DEPTH_MAX_MM = 65535;

export interface CaptureKinds {
  /** the clean camera picture (PNG) */
  rgb?: boolean;
  /** what the goggles received: link noise, break-up and the analog OSD (PNG) */
  received?: boolean;
  /** range from the lens, uint16 PNG in millimetres */
  depth?: boolean;
  /** semantic class (8-bit PNG) and instance id (16-bit PNG) per pixel */
  segmentation?: boolean;
}

export interface FrameFiles {
  labels: FrameLabels;
  rgb?: Uint8Array; received?: Uint8Array; depth?: Uint8Array; segmentation?: Uint8Array; instance?: Uint8Array;
}

export interface GateLabel {
  id: number;
  /** position in the course (0 = the start gate); next: the gate the course asks for now */
  index: number; next: boolean;
  kind: GateDef['kind'];
  /** opening corners (world ENU, m): top-left, top-right, bottom-right, bottom-left seen from the approach side (dive gates: the frame's corners) */
  cornersWorld: [number, number, number][];
  /** the same in image pixels (x right, y down, origin at the image's top-left corner); null behind the lens or outside the picture */
  corners: ([number, number] | null)[];
  /** per corner: in the picture and nothing solid between it and the lens */
  visible: boolean[];
  centreWorld: [number, number, number]; centre: [number, number] | null;
  /** distance from the lens to the opening's centre (m) */
  rangeM: number;
}

export interface FrameLabels {
  frame: number;
  /** sim time the camera captured this frame (s) */
  t: number;
  camera: {
    model: 'kannala-brandt'; width: number; height: number;
    /** k1..k4 of θ_d = θ(1 + k1θ² + k2θ⁴ + k3θ⁶ + k4θ⁸); the image corner lies at θ = fovDeg / 2 */
    k: number[]; fovDeg: number;
    /** pixels per unit θ_d: r_px = fPx · θ_d, measured from the image centre (cx, cy) */
    fPx: number; cx: number; cy: number;
    /** rolling-shutter readout, top row to bottom row (s); rows are exposed at t + (row/height - 0.5) · readoutS */
    readoutS: number; fps: number; uptiltDeg: number;
    /** emulated glass-to-glass latency of this video system (ms) */
    latencyMs: number;
  };
  /** camera pose: position (ENU, m) and camera-to-world rotation with OpenCV camera axes (x right, y down, z forward), row-major */
  pose: { pos: [number, number, number]; R: number[]; quat: [number, number, number, number] };
  /** the quad (body FLU, world ENU) */
  body: { pos: number[]; quat: number[]; vel: number[]; rates: number[]; gyro: number[]; motorRpm: number[]; rc: number[]; armed: boolean; vbus: number };
  gates: GateLabel[];
}

let gt: GroundTruthCamera | null = null;
let frameNo = 0;
const waiting: ((f: CameraFrame) => void)[] = [];
let recording: Recording | null = null;

interface Recording {
  hz: number; kinds: CaptureKinds; stream: ((f: FrameFiles) => void) | null; maxFrames: number;
  zip: ZipWriter | null; lines: string[]; frames: number; dropped: number; inFlight: number; lastT: number;
  meta: Record<string, unknown>; chain: Promise<void>; onChange?: () => void;
}

/** Hook the frame loop's camera frames (once). */
function hook(ctx: AppCtx) {
  if (ctx.onCameraFrame) return;
  ctx.onCameraFrame = (f) => {
    for (const w of waiting.splice(0)) w(f);
    const r = recording;
    if (!r || f.t < r.lastT + 1 / r.hz - 1e-6) return;
    if (r.frames + r.inFlight >= r.maxFrames) return;
    if (r.inFlight >= 3) { r.dropped++; r.onChange?.(); return; } // the encoder can't keep up: skip, never stall the flight
    r.lastT = f.t;
    r.inFlight++;
    const job = grab(ctx, f, r.kinds);
    r.chain = r.chain.then(async () => {
      try {
        const files = await job;
        if (r.stream) r.stream(files);
        else if (r.zip) store(r.zip, files);
        r.lines.push(JSON.stringify(files.labels));
        r.frames++;
      } catch (e) { r.dropped++; console.warn('dataset frame failed', e); }
      r.inFlight--;
      r.onChange?.();
    });
  };
}

const pad = (n: number) => String(n).padStart(6, '0');
function store(zip: ZipWriter, f: FrameFiles) {
  const n = pad(f.labels.frame);
  if (f.rgb) zip.add(`rgb/${n}.png`, f.rgb);
  if (f.received) zip.add(`received/${n}.png`, f.received);
  if (f.depth) zip.add(`depth/${n}.png`, f.depth);
  if (f.segmentation) zip.add(`segmentation/${n}.png`, f.segmentation);
  if (f.instance) zip.add(`instance/${n}.png`, f.instance);
}

/** Everything about one camera frame. Starts all GPU work at once (the next capture changes the lens state). */
function grab(ctx: AppCtx, f: CameraFrame, k: CaptureKinds): Promise<FrameFiles> {
  const fpv = ctx.fpv, lens = fpv.lensUniforms;
  const w = fpv.frameRT.width, h = fpv.frameRT.height;
  const labels = frameLabels(ctx, f, frameNo++, w, h);
  const rgbP = k.rgb ? fpv.readFrame('camera') : null;
  const recvP = k.received ? fpv.readFrame('received') : null;
  let gtP: ReturnType<GroundTruthCamera['render']> | null = null;
  if (k.depth || k.segmentation) {
    gt ??= new GroundTruthCamera(ctx.renderer, Math.max(512, Math.min(1024, fpv.cubeSize)));
    // the quad's own camera body is hidden from its lens, as in the picture
    for (const o of ctx.drone.fpvHidden) o.visible = false;
    try { gtP = gt.render(ctx.scene.scene, f.lensPos, f.lensQ, lens, w, h); } finally { for (const o of ctx.drone.fpvHidden) o.visible = true; }
  }
  return (async () => {
    const out: FrameFiles = { labels };
    if (rgbP) { const p = await rgbP; out.rgb = await encodePng(p.width, p.height, p.rgba, 'rgba8'); }
    if (recvP) { const p = await recvP; out.received = await encodePng(p.width, p.height, p.rgba, 'rgba8'); }
    if (gtP) {
      const g = await gtP;
      if (k.depth) {
        const mm = new Uint16Array(g.range.length);
        for (let i = 0; i < mm.length; i++) { const r = g.range[i]; mm[i] = r > 0 ? Math.min(DEPTH_MAX_MM, Math.max(1, Math.round(r * 1000))) : 0; }
        out.depth = await encodePng(g.width, g.height, mm, 'gray16');
      }
      if (k.segmentation) {
        out.segmentation = await encodePng(g.width, g.height, g.cls, 'gray8');
        out.instance = await encodePng(g.width, g.height, g.inst, 'gray16');
      }
    }
    return out;
  })();
}

// three world <-> ENU, and the OpenCV camera axes from three's (x right, y up, looking down -z)
const M3_ENU_FROM_THREE = new THREE.Matrix3().set(1, 0, 0, 0, 0, -1, 0, 1, 0);
const M3_THREECAM_FROM_CV = new THREE.Matrix3().set(1, 0, 0, 0, -1, 0, 0, 0, -1);
const _m3 = new THREE.Matrix3(), _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _qi = new THREE.Quaternion(), _v = new THREE.Vector3();

function frameLabels(ctx: AppCtx, f: CameraFrame, frame: number, width: number, height: number): FrameLabels {
  const v = ctx.build.info.components.video, u = ctx.fpv.lensUniforms;
  const halfFovDiag = u.halfFovDiag.value as number, aspect = u.aspect.value as number, k = v.fisheyeK;
  // r_px = θ_d / halfFovDiag · (half the image diagonal in pixels)
  const fPx = Math.hypot(width, height) / 2 / halfFovDiag;
  // camera-to-world rotation, ENU world and OpenCV camera axes
  _m3.setFromMatrix4(_m4.makeRotationFromQuaternion(f.lensQ));
  const Rm = new THREE.Matrix3().multiplyMatrices(M3_ENU_FROM_THREE, _m3).multiply(M3_THREECAM_FROM_CV);
  const e = Rm.elements; // column-major
  const Rrow = [e[0], e[3], e[6], e[1], e[4], e[7], e[2], e[5], e[8]];
  _q.setFromRotationMatrix(_m4.setFromMatrix3(Rm));
  const lensEnu: [number, number, number] = [f.lensPos.x, -f.lensPos.z, f.lensPos.y];
  _qi.copy(f.lensQ).invert();
  const project = (p: [number, number, number]): [number, number] | null => {
    enuToThree(p[0], p[1], p[2], _v).sub(f.lensPos).applyQuaternion(_qi);
    if (_v.z >= -1e-6 && Math.hypot(_v.x, _v.y) < 1e-6) return null;
    const pr = projectFisheye(_v, halfFovDiag, k, aspect);
    if (pr.theta > Math.PI * 0.95) return null;
    const x = (pr.x / aspect + 0.5) * width, y = (0.5 - pr.y) * height;
    return x >= 0 && x <= width && y >= 0 && y <= height ? [x, y] : null;
  };
  const world = ctx.world, lensV = { x: lensEnu[0], y: lensEnu[1], z: lensEnu[2] };
  const unblocked = (p: [number, number, number]) => {
    const d = Math.hypot(p[0] - lensV.x, p[1] - lensV.y, p[2] - lensV.z);
    if (d < 1e-3) return true;
    const dir = { x: (p[0] - lensV.x) / d, y: (p[1] - lensV.y) / d, z: (p[2] - lensV.z) / d };
    // the corner sits on the gate's own frame: anything solid well before it hides it
    return !(world.raycast(lensV, dir, d) < d - 0.3);
  };
  const gates = ctx.map.gates, next = ctx.replay ? ctx.replay.nextGate : ctx.race.nextGate;
  const gl: GateLabel[] = gates.map((g, i) => {
    const corners = gateCorners(g), c = openingCentre(g);
    const cw: [number, number, number] = [c.x, c.y, c.z];
    const px = corners.map(project);
    return {
      id: g.id, index: i, next: i === next % Math.max(1, gates.length), kind: g.kind,
      cornersWorld: corners, corners: px, visible: corners.map((p, j) => px[j] !== null && unblocked(p)),
      centreWorld: cw, centre: project(cw), rangeM: Math.hypot(c.x - lensV.x, c.y - lensV.y, c.z - lensV.z),
    };
  });
  const r = f.rec;
  return {
    frame, t: f.t,
    camera: {
      model: 'kannala-brandt', width, height, k: [...k], fovDeg: v.fovDeg, fPx, cx: width / 2, cy: height / 2,
      readoutS: v.rollingShutterMs / 1000, fps: v.fps, uptiltDeg: ctx.spec.cameraUptiltDeg, latencyMs: v.latencyMs,
    },
    pose: { pos: lensEnu, R: Rrow, quat: [_q.w, _q.x, _q.y, _q.z] },
    body: {
      pos: [r[R.px], r[R.py], r[R.pz]], quat: [r[R.qw], r[R.qx], r[R.qy], r[R.qz]], vel: [r[R.vx], r[R.vy], r[R.vz]],
      rates: [r[R.wx], r[R.wy], r[R.wz]], gyro: [r[R.gx], r[R.gy], r[R.gz]], motorRpm: [r[R.rpm0], r[R.rpm1], r[R.rpm2], r[R.rpm3]],
      rc: [r[R.rc0], r[R.rc1], r[R.rc2], r[R.rc3]], armed: r[R.armed] > 0.5, vbus: r[R.vbus],
    },
    gates: gl,
  };
}

/** A gate's opening corners (ENU): see GateLabel.cornersWorld. */
export function gateCorners(g: GateDef): [number, number, number][] {
  const cy = Math.cos(g.yaw), sy = Math.sin(g.yaw), hw = g.width / 2;
  const tx = cy, ty = sy;           // across the opening (to the right seen from the approach side)
  const nx = -sy, ny = cy;          // the direction of travel through it
  const c = g.c;
  if (g.kind === 'dive') return [[-1, 1], [1, 1], [1, -1], [-1, -1]].map(([a, b]) => [c.x + a * hw * tx + b * hw * nx, c.y + a * hw * ty + b * hw * ny, c.z] as [number, number, number]);
  if (g.kind === 'flag') { const o = openingCentre(g); return [[o.x, o.y, o.z]]; }
  const top = c.z + g.height; // (an arch: the corners of the rectangle around its round head)
  return [[c.x - hw * tx, c.y - hw * ty, top], [c.x + hw * tx, c.y + hw * ty, top], [c.x + hw * tx, c.y + hw * ty, c.z], [c.x - hw * tx, c.y - hw * ty, c.z]];
}

function datasetMeta(ctx: AppCtx, kinds: CaptureKinds): Record<string, unknown> {
  return {
    format: DATASET_FORMAT, version: DATASET_VERSION, app: `fpv-sim ${APP_VERSION}`, created: new Date().toISOString(),
    map: ctx.map.id, course: ctx.sim.courseId ?? '', drone: ctx.spec, video: ctx.build.info.components.video,
    wind: ctx.sim.wind, replay: !!ctx.replay,
    files: kinds, classes: GT_CLASSES, depth: { unit: 'mm', format: 'png16', none: 0, max: DEPTH_MAX_MM, kind: 'range along the ray from the lens' },
    instance: { format: 'png16', gate: 'gate id + 1', none: 0 },
  };
}

/** The next camera frame (and its files) — the control API's capture. */
export async function capture(ctx: AppCtx, o: CaptureKinds & { labels?: boolean }): Promise<Record<string, unknown>> {
  hook(ctx);
  const kinds: CaptureKinds = { rgb: o.rgb ?? true, received: o.received, depth: o.depth, segmentation: o.segmentation };
  const f = await new Promise<CameraFrame>((res, rej) => {
    waiting.push(res);
    setTimeout(() => { const i = waiting.indexOf(res); if (i >= 0) { waiting.splice(i, 1); rej(new Error('capture: no camera frame within 3 s (FPV view off, or the menu covers it?)')); } }, 3000);
  });
  const files = await grab(ctx, f, kinds);
  return filesToJson(files);
}

function filesToJson(f: FrameFiles): Record<string, unknown> {
  const out: Record<string, unknown> = { labels: f.labels, classes: GT_CLASSES };
  for (const k of ['rgb', 'received', 'depth', 'segmentation', 'instance'] as const) if (f[k]) out[k] = toBase64(f[k]!);
  return out;
}

export interface RecordOptions extends CaptureKinds { hz?: number; maxFrames?: number }

/**
 * Start recording at hz (sim time) until stopRecording. emit: stream each frame as an API event
 * instead of collecting a .zip in memory.
 */
export function startRecording(ctx: AppCtx, o: RecordOptions & { stream?: boolean }, emit?: (e: { event: 'frame' } & Record<string, unknown>) => void, onChange?: () => void): Record<string, unknown> {
  hook(ctx);
  if (recording) throw new Error('record: already recording');
  const kinds: CaptureKinds = { rgb: o.rgb ?? true, received: o.received ?? false, depth: o.depth ?? true, segmentation: o.segmentation ?? true };
  const stream = o.stream && emit ? (f: FrameFiles) => emit({ event: 'frame', ...filesToJson(f) }) : null;
  recording = {
    hz: Math.min(60, Math.max(0.1, o.hz ?? 10)), kinds, stream, maxFrames: o.maxFrames ?? (stream ? Infinity : 600),
    zip: stream ? null : new ZipWriter(), lines: [], frames: 0, dropped: 0, inFlight: 0, lastT: -Infinity,
    meta: datasetMeta(ctx, kinds), chain: Promise.resolve(), onChange,
  };
  frameNo = 0;
  return { recording: true, hz: recording.hz, kinds };
}

export function recordingStatus(): { frames: number; dropped: number; bytes: number; max: number } | null {
  const r = recording;
  return r ? { frames: r.frames, dropped: r.dropped, bytes: r.zip?.size ?? 0, max: r.maxFrames } : null;
}

/** Stop; returns the .zip (base64 over the API, a Blob for the page) unless frames were streamed. */
export async function stopRecording(ctx: AppCtx, asBlob = false): Promise<Record<string, unknown> & { blob?: Blob }> {
  void ctx;
  const r = recording;
  if (!r) throw new Error('record: not recording');
  recording = null;
  await r.chain;
  const meta = { ...r.meta, frames: r.frames, dropped: r.dropped };
  if (!r.zip) return { frames: r.frames, dropped: r.dropped, meta };
  r.zip.add('meta.json', JSON.stringify(meta, null, 2));
  r.zip.add('frames.jsonl', r.lines.join('\n') + '\n');
  const zip = r.zip.finish();
  if (asBlob) return { frames: r.frames, dropped: r.dropped, blob: new Blob([zip as BlobPart], { type: 'application/zip' }) };
  return { frames: r.frames, dropped: r.dropped, zip: toBase64(zip) };
}
