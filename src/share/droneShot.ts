// Studio shot of the pilot's drone for the "Drone" share card: the same procedural model the sim
// flies (droneMesh.ts, from the build), rendered once offscreen with three.js from a three-quarter
// front view, under a soft studio environment with the card's colours as rim lights, on a
// transparent background. Its own small WebGL context, released right after.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { CUSTOM } from '../../server/src/leaderboardCore';
import { DerivedInfo, DroneBuild, DroneSpec, PRESETS } from '../builder/derive';
import { PRESET_CLASS } from '../builder/droneClass';
import { buildDroneMesh } from '../render/droneMesh';
import type { Palette, Picture } from './types';

/** What the model needs from a build (DroneBuild has it; the worker sends it). */
export interface DroneData { spec: DroneSpec; info: DerivedInfo; rotors: { x: number; y: number; z: number; dir: number }[] }

export const fromBuild = (b: DroneBuild): DroneData => ({ spec: b.spec, info: b.info, rotors: b.params.rotors.map((r) => ({ ...r.pos, dir: r.dir })) });

/** Derive a build in a worker (build.worker.ts): the BEMT tables would block the page for a second or more. */
export function buildOffThread(spec: DroneSpec): Promise<DroneData> {
  return new Promise((done, fail) => {
    const w = new Worker(new URL('./build.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<DroneData | { error: string }>) => { w.terminate(); if ('error' in e.data) fail(new Error(e.data.error)); else done(e.data); };
    w.onerror = (e) => { w.terminate(); fail(new Error(e.message || 'The drone could not be built.')); };
    w.postMessage(spec);
  });
}

/** The spec to show for a board class when the pilot's own build isn't known (the phone page): the
 *  preset, or for a custom build the preset nearest its size in the summary ("Custom · 5" · …"). */
export function specForClass(cls: string, summary = ''): DroneSpec {
  const preset = PRESETS.find((p) => PRESET_CLASS[p.name] === cls);
  if (preset && cls !== CUSTOM) return preset;
  const size = /· (\d{1,2})"/.exec(summary)?.[1], mm = /· (\d{2,3}) mm/.exec(summary)?.[1];
  const want = mm ? (Number(mm) < 70 ? 'whoop65' : 'whoop75') : size ? ({ 1: 'whoop65', 2: 'whoop75', 3: 'toothpick3', 4: 'toothpick3', 6: 'longrange7', 7: 'longrange7', 8: 'longrange7' } as Record<string, string>)[size] ?? 'freestyle5' : 'freestyle5';
  return PRESETS.find((p) => PRESET_CLASS[p.name] === want) ?? PRESETS[0];
}

/** Name and a few numbers for under the picture: "642 g", "T/W 9.8", "2207 1950KV", "6S", the video system. */
export function droneChips(b: Pick<DroneData, 'spec' | 'info'>): string[] {
  const { frame, motor, prop, battery, video } = b.info.components, ov = b.spec.overrides;
  const size = frame.sizeClass === 'whoop' ? `${frame.wheelbaseMm} mm` : `${Math.round(prop.diameterIn)}"`;
  return [size, `${Math.round(b.info.auwG)} g`, `T/W ${b.info.thrustToWeight.toFixed(1)}`, `${motor.stator} ${Math.round(ov.kv ?? motor.kv)}KV`, `${Math.round(ov.cells ?? battery.cells)}S`, video.name.split(/\s*[(,]/)[0]];
}

/** Display name of a build: a preset's own name without "Beginner: ". */
export const droneName = (s: DroneSpec) => s.name.replace(/^Beginner:\s*/, '');

/** The alpha bounding box of a rendered frame, so the card can show the drone as large as it fits. */
function trim(src: HTMLCanvasElement): HTMLCanvasElement {
  const w = src.width, h = src.height, ctx = src.getContext('2d', { willReadFrequently: true })!;
  const d = ctx.getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return src;
  const m = 12, out = document.createElement('canvas');
  x0 = Math.max(0, x0 - m); y0 = Math.max(0, y0 - m); x1 = Math.min(w - 1, x1 + m); y1 = Math.min(h - 1, y1 + m);
  out.width = x1 - x0 + 1; out.height = y1 - y0 + 1;
  out.getContext('2d')!.drawImage(src, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

/** Render the build (null if this browser can't make a WebGL context). */
export function droneShot(build: DroneData, p: Palette, w = 1400, h = 1000): Picture | null {
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true, powerPreference: 'low-power' });
  } catch { return null; }
  const model = buildDroneMesh(build.spec, build.info, build.rotors, build.info.cgMm);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const env = pmrem.fromScene(room, 0.04).texture;
  try {
    renderer.setPixelRatio(1);
    renderer.setSize(w, h, false);
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    const scene = new THREE.Scene();
    scene.environment = env;
    scene.environmentIntensity = 0.35; // carbon stays dark: a soft studio, not a white room
    // props at rest, blades showing (no motion-blur discs), each at its own angle
    model.props.forEach((hub, k) => { hub.rotation.y = 0.4 + k * 1.3; for (const c of hub.children) c.visible = c !== model.blur[k]; });
    model.blur.forEach((d) => { d.visible = false; });
    scene.add(model.root);
    const key = new THREE.DirectionalLight(0xffffff, 2.0); key.position.set(2.5, 2.2, 1.5);
    const fill = new THREE.DirectionalLight(0xffffff, 0.6); fill.position.set(1, 1, -2.5);
    const rimA = new THREE.DirectionalLight(new THREE.Color(p.secondary), 3.2); rimA.position.set(-2.5, 1.2, -1.5);
    const rimB = new THREE.DirectionalLight(new THREE.Color(p.accent), 2.6); rimB.position.set(-2, 0.8, 2.5);
    scene.add(key, fill, rimA, rimB, new THREE.HemisphereLight(0xdfe7ff, 0x1b1d2a, 0.5));
    // three-quarter front view from slightly above, framing the whole quad
    const box = new THREE.Box3().setFromObject(model.root), sphere = box.getBoundingSphere(new THREE.Sphere());
    const cam = new THREE.PerspectiveCamera(28, w / h, 0.01, 100);
    const az = THREE.MathUtils.degToRad(38), el = THREE.MathUtils.degToRad(24);
    const dist = (sphere.radius / Math.sin(THREE.MathUtils.degToRad(cam.fov) / 2)) * 1.02;
    cam.position.set(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)).multiplyScalar(dist).add(sphere.center);
    cam.lookAt(sphere.center);
    renderer.render(scene, cam);
    const out = document.createElement('canvas');
    out.width = w; out.height = h;
    out.getContext('2d')!.drawImage(renderer.domElement, 0, 0);
    const img = trim(out);
    return { image: img, w: img.width, h: img.height };
  } finally {
    model.dispose(); env.dispose(); pmrem.dispose(); room.dispose?.();
    renderer.dispose(); renderer.forceContextLoss();
  }
}
