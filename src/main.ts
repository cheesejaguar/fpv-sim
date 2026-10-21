import * as THREE from 'three';
import './style.css';
import { buildDrone, DEFAULT_SPEC, DroneBuild, DroneSpec } from './builder/derive';
import { InputManager } from './input/gamepad';
import { webHidSupported } from './input/steamHid';
import { isLocalMap, onLocalMap } from './maps/localMaps';
import { MAPS, preloadMap } from './maps/maps';
import { MapDef, pilotPos, PrimitiveWorld, spawnGroundZ } from './maps/world';
import { MotorAudio } from './render/audio';
import { cameraMountQuat, enuToThree, quatEnuToThree } from './render/coords';
import { buildDroneMesh, cameraMountZ, DroneModel } from './render/droneMesh';
import { FpvCamera } from './render/fpvCamera';
import { OsdRenderer } from './render/osdRenderer';
import { buildScene, SceneBundle } from './render/scene';
import { VideoLink } from './render/videoLink';
import { bfPanel } from './ui/bfPanel';
import { simHardwareCli } from './bf/defaults';
import { Blackbox } from './ui/blackbox';
import { MultiplayerClient } from './net/multiplayer';
import { RemoteQuads } from './render/remoteQuads';
import { inviteLink, loadPilot, multiplayerPanel } from './ui/multiplayerPanel';
import { builderPanel } from './ui/builderPanel';
import { el } from './ui/dom';
import { inputPanel } from './ui/inputPanel';
import { EASY_SPEC, GameMenu, GameMode } from './ui/menu/gameMenu';
import { DrillInfo, Hud, osdRects } from './ui/hud/hud';
import { DEFAULT_VIEW, settingsPanel, ViewSettings } from './ui/settingsPanel';
import { createShared, DEFAULT_SETTINGS, FromWorker, GyroSpectrum, newestTime, R, REC, sampleRing, SimSettings, Telemetry, ToWorker } from './worker/shared';

// ---------------------------------------------------------------------------------------------
const load = <T,>(k: string, d: T): T => { try { const s = localStorage.getItem(k); return s ? { ...d, ...JSON.parse(s) } : d; } catch { return d; } };
const store = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } };

// first run starts on the easiest quad (65 mm tiny whoop); after that, whatever the pilot flew last
let spec: DroneSpec = load('fpv-spec', EASY_SPEC);
let simSettings: SimSettings = load('fpv-sim-settings', DEFAULT_SETTINGS);
let view: ViewSettings = load('fpv-view', DEFAULT_VIEW);

const app = document.getElementById('app')!;
if (!crossOriginIsolated) {
  app.append(el('div', { class: 'fatal' }, 'This page must be cross-origin isolated (COOP/COEP headers) for SharedArrayBuffer. Run it with "npm run dev" or "npm run preview".'));
  throw new Error('not cross-origin isolated');
}

// ---------------------------------------------------------------------------------------------
// Worker + shared memory
const sh = createShared();
const worker = new Worker(new URL('./worker/sim.worker.ts', import.meta.url), { type: 'module' });
const send = (m: ToWorker) => worker.postMessage(m);
let tel: Telemetry | null = null;
let fwStatus = 'Loading Betaflight firmware…';
const cliListeners: ((t: string) => void)[] = [];
const batchWaiters = new Map<number, (s: string) => void>();
let batchId = 1;
let lapStart = -1, bestLap = Infinity, lastLap = 0, lapCount = 0;
let nextGate = 0; // index into map.gates of the gate to fly next (mirrors the worker's counter)
const logLines: string[] = [];
// Hover-box drill: stay inside a 1.5 m sphere centred 3 m above the pad; score = time inside / elapsed.
const drill = { on: false, t0: 0, inside: 0, last: 0, best: 0 };

worker.onmessage = (e: MessageEvent<FromWorker>) => {
  const m = e.data;
  switch (m.type) {
    case 'ready': fwStatus = ''; log(`Firmware running: ${m.fw}`); break;
    case 'fwMissing': fwStatus = m.reason; log(m.reason); break;
    case 'telemetry': tel = m.tel; break;
    case 'cliOut': for (const l of cliListeners) l(m.text); break;
    case 'cliBatchDone': batchWaiters.get(m.id)?.(m.output); batchWaiters.delete(m.id); break;
    case 'log': log(m.text); break;
    case 'built': break;
    case 'gate': onGate(m.gate, m.t); break;
    case 'spectrum': onSpectrum(m.spec); break;
  }
};
send({ type: 'init', sab: sh.sab, spec, settings: simSettings });

function log(t: string) { logLines.push(t); if (logLines.length > 6) logLines.shift(); }

function onGate(gate: number, t: number) {
  const i = map.gates.findIndex((g) => g.id === gate);
  nextGate = (i + 1) % map.gates.length;
  if (i === 0) {
    if (lapStart >= 0) { lastLap = t - lapStart; lapCount++; bestLap = Math.min(bestLap, lastLap); mp.sendLap(lapCount, lastLap, bestLap); }
    lapStart = t;
  }
}
/** The worker respawned the quad (reset key / map change): its gate counter restarts at gate 0. */
function onRespawn() { nextGate = 0; lapStart = -1; link.reset(); }
function sendReset(fullBattery = false) { input.disarm(); onRespawn(); send({ type: 'reset', repair: true, fullBattery }); }

// ---------------------------------------------------------------------------------------------
// Rendering
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.shadowMap.autoUpdate = false;
renderer.toneMapping = THREE.NoToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
app.append(renderer.domElement);
window.addEventListener('resize', () => { renderer.setSize(innerWidth, innerHeight); chaseCam.aspect = orbitCam.aspect = innerWidth / innerHeight; chaseCam.updateProjectionMatrix(); orbitCam.updateProjectionMatrix(); });

if (!MAPS[simSettings.mapId]) simSettings.mapId = 'field';
await preloadMap(simSettings.mapId).catch((e) => { console.warn(e); simSettings.mapId = 'field'; });
let map: MapDef = MAPS[simSettings.mapId]();
let world = new PrimitiveWorld(map);
let sceneB: SceneBundle = buildScene(map);
let build: DroneBuild = buildDrone(spec);
let drone: DroneModel = makeDroneModel(build);
sceneB.scene.add(drone.root);
const fpv = new FpvCamera(renderer, view.cubeSize);
fpv.setVideo(build.info.components.video, view.renderScale);
let mountQ = cameraMountQuat(spec.cameraUptiltDeg);
const osd = new OsdRenderer();
void osd.setFont(view.osdFont);
const link = new VideoLink();
const audio = new MotorAudio();
const input = new InputManager();
input.onReset = () => { onRespawn(); send({ type: 'reset', repair: true }); };
input.onMenu = () => gameMenu.toggle();
const blackbox = new Blackbox();
// Live multiplayer: remote pilots' poses arrive through the room relay and are drawn in our scene.
const mp = new MultiplayerClient();
const remotes = new RemoteQuads();
const mpRec = new Float64Array(REC);
let applyingRoomMap = false;
mp.onMap = (m) => {
  if (!MAPS[m] || m === simSettings.mapId) return;
  applyingRoomMap = true;
  applySim({ ...simSettings, mapId: m });
  applyingRoomMap = false;
  log(`Room switched the map to ${MAPS[m]().name}`);
};
/** room: name / visibility, used if we are the first pilot in (the host) */
function joinRoom(code: string, room?: { name: string; public: boolean }) {
  const p = loadPilot();
  mp.join(code, { name: p.name, color: p.color, frame: build.info.components.frame.sizeClass, map: simSettings.mapId, room });
  history.replaceState(null, '', inviteLink(code));
}
let lastShadowAt = 0, brownoutUntil = -1e9;
// The browser + monitor pipeline (rAF -> compositor -> scan-out) already adds ~1.5 frames plus the
// panel's response; measure the frame interval and subtract that from the emulated video latency.
let frameMs = 16.7, lastFrameAt = 0;
function displayComp(now: number): number {
  if (lastFrameAt) { const d = now - lastFrameAt; if (d > 2 && d < 100) frameMs += (d - frameMs) * 0.05; }
  lastFrameAt = now;
  return view.displayCompAuto ? Math.min(50, 1.5 * frameMs + 6) : view.displayCompMs;
}
// Sky ambient in the camera: rays from the lens find how much open sky surrounds it, so a bando's
// interior is lit by its windows and the sun patches, not by a full outdoor sky (real interiors are
// ~1-5 % of outdoor ambient). Smoothed so passing a doorway doesn't pop.
let skyOpen = 1, skyTimer = 0;
const SKY_DIRS = [[0, 0, 1], [0.6, 0, 0.8], [-0.6, 0, 0.8], [0, 0.6, 0.8], [0, -0.6, 0.8], [0.85, 0.3, 0.42], [-0.85, -0.3, 0.42], [0.3, -0.85, 0.42], [-0.3, 0.85, 0.42]];
function updateSkyAmbient(dt: number) {
  skyTimer -= dt;
  if (skyTimer <= 0) {
    skyTimer = 0.08;
    const p = { x: rec[R.px], y: rec[R.py], z: rec[R.pz] };
    let open = 0;
    for (const [x, y, z] of SKY_DIRS) if (!(world.raycast(p, { x, y, z }, 40) < 40)) open++;
    const target = open / SKY_DIRS.length;
    skyOpen += (target - skyOpen) * 0.35;
  }
  sceneB.hemi.intensity = sceneB.hemiBase * (0.04 + 0.96 * skyOpen);
}
const drillMesh = new THREE.Mesh(new THREE.SphereGeometry(1.5, 32, 16), new THREE.MeshBasicMaterial({ color: 0x39b6ff, transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide }));
const chaseCam = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.05, 3000);
// title-screen backdrop: a slow orbit around the quad sitting on the pad
const orbitCam = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 0.02, 3000);

function makeDroneModel(b: DroneBuild) {
  const cgMm = b.info.cgMm;
  return buildDroneMesh(b.spec, b.info, b.params.rotors.map((r) => ({ ...r.pos, dir: r.dir })), cgMm);
}

function applySpec(s: DroneSpec) {
  spec = s; store('fpv-spec', s);
  build = buildDrone(s);
  sceneB.scene.remove(drone.root); drone.dispose();
  drone = makeDroneModel(build); sceneB.scene.add(drone.root);
  fpv.setVideo(build.info.components.video, view.renderScale);
  mountQ = cameraMountQuat(s.cameraUptiltDeg);
  input.disarm();
  send({ type: 'spec', spec: s });
}

function applySim(s: SimSettings, reloadMap = false) {
  const mapChanged = reloadMap || s.mapId !== simSettings.mapId;
  simSettings = s; store('fpv-sim-settings', s);
  // loading is async (Quake maps fetch their sources): remember now whether the room asked for it
  const fromRoom = applyingRoomMap;
  if (mapChanged) void preloadMap(s.mapId).then(() => {
    if (simSettings.mapId !== s.mapId) return; // superseded while loading
    sceneB.scene.remove(drone.root); sceneB.dispose();
    map = MAPS[s.mapId](); world = new PrimitiveWorld(map); sceneB = buildScene(map); sceneB.scene.add(drone.root);
    lapStart = -1; bestLap = Infinity; lapCount = 0; nextGate = 0;
    if (mp.connected && !fromRoom && !isLocalMap(s.mapId)) mp.sendMap(s.mapId); // the room flies one shared map
  }, (e) => log(`Map ${s.mapId} failed to load: ${e}`));
  send({ type: 'settings', settings: { ...s, paused: menuOpen && pauseInMenu } });
}

// maps loaded from disk: the worker needs them too; reloading the selected one rebuilds it
onLocalMap((id, info, urls) => {
  send({ type: 'registerMap', id, info, urls });
  if (simSettings.mapId === id) applySim(simSettings, true);
});

function applyView(v: ViewSettings) {
  const fontChanged = v.osdFont !== view.osdFont, scaleChanged = v.renderScale !== view.renderScale;
  view = v; store('fpv-view', v);
  if (fontChanged) void osd.setFont(v.osdFont);
  if (scaleChanged) fpv.setVideo(build.info.components.video, v.renderScale);
  audio.enabled = v.audio; audio.volume = v.volume;
}

// ---------------------------------------------------------------------------------------------
// Input: poll fast (250 Hz) for low latency, independent of the render rate
setInterval(() => { const ch = input.poll(); sh.rc.set(ch); Atomics.add(sh.ctrl, 0, 1); }, 4);
window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
  if (menuOpen) return; // the menu handles its own keys
  if (e.code === 'Escape') gameMenu.toggle();
  if (e.code === 'KeyR') sendReset();
  if (e.code === 'KeyC') { const order: ViewSettings['view'][] = ['fpv', 'chase', 'los']; applyView({ ...view, view: order[(order.indexOf(view.view) + 1) % 3] }); }
  if (e.code === 'KeyH') applyView({ ...view, telemetry: !view.telemetry });
  if (e.code === 'KeyG') { drill.on = !drill.on; drill.t0 = -1; drill.inside = 0; }
  if (e.code === 'KeyB') sendReset(true);
  if (e.code === 'KeyF') toggleSpectrum();
});
// Every page gesture (not just the first) unlocks / resumes audio: controller input can't, and the
// browser may suspend the context later (tab switch, audio device change).
for (const ev of ['pointerdown', 'keydown', 'touchstart'] as const) window.addEventListener(ev, () => audio.unlock(), { capture: true });

// ---------------------------------------------------------------------------------------------
// HUD (ui/hud): menu-styled widgets laid out around the Betaflight OSD
const sticks = el('canvas', { width: 220, height: 100 }) as HTMLCanvasElement;
const SPEC_W = 380, SPEC_ROW = 92;
const specCanvas = el('canvas', { width: SPEC_W, height: SPEC_ROW * 3 + 22 }) as HTMLCanvasElement;
const hud = new Hud(sticks, specCanvas);
app.append(hud.root);
// Shown while no controller is available. The 2026 Steam Controller is never visible to the
// Gamepad API (outside Steam it acts as keyboard + mouse), so offer the direct WebHID driver.
const hidStatus = el('p', { class: 'sub' });
const padNotice = el('div', { class: 'card notice warn' },
  el('b', {}, 'No controller: keyboard fallback'),
  el('p', {}, 'Connect a controller, then press a button on it: browsers only reveal a gamepad after its first input.'),
  ...(webHidSupported()
    ? [el('p', { class: 'sub' }, 'Steam Controller (2026): quit Steam, connect it, then'), el('button', { onclick: () => void input.steamHid.request() }, 'Connect Steam Controller')]
    // Safari / Firefox: no WebHID, which the 2026 Steam Controller's direct connection needs
    : [el('p', { class: 'sub' }, 'Steam Controller (2026) needs Chrome or Edge (WebHID).')]),
  hidStatus);
// Radios / HID joysticks with an unknown stick layout: point at the setup wizard.
const setupNotice = el('div', { class: 'card notice' },
  el('b', {}, 'New controller'),
  el('p', {}, 'Run the stick & switch setup once: Esc, Settings, Controller.'));
const fwNotice = el('div', { class: 'card notice status' });
const lostNotice = el('div', { class: 'card notice warn status' }, el('b', {}, 'VIDEO SIGNAL LOST'), el('p', {}, 'Fly back toward yourself, or respawn: A / ✕ on a controller, R on the keyboard.'));
let lostSince = -1;
// Browsers block audio until a click / key press on the page (controller buttons don't count).
const soundChip = el('div', { class: 'chip' }, 'Click or press a key to enable sound');
let armedSince = -1;
let hudLayoutAt = 0;

function drawSticks() {
  const c = sticks.getContext('2d')!, ch = input.channels;
  c.clearRect(0, 0, 220, 100);
  const pad = (x: number, cx: number, cy: number) => { c.strokeStyle = 'rgba(255,255,255,.5)'; c.strokeRect(cx - 40, cy - 40, 80, 80); void x; };
  pad(0, 50, 50); pad(0, 170, 50);
  const dot = (cx: number, cy: number, x: number, y: number) => { c.fillStyle = '#4cf'; c.beginPath(); c.arc(cx + x * 40, cy - y * 40, 5, 0, 7); c.fill(); };
  dot(50, 50, (ch[3] - 1500) / 500, (ch[2] - 1500) / 500);
  dot(170, 50, (ch[0] - 1500) / 500, (ch[1] - 1500) / 500);
}

// ---------------------------------------------------------------------------------------------
// Gyro noise spectrum (F): raw IMU vs Betaflight-filtered gyro, FFT'd in the worker at ~10 Hz.
let specShown = false;
let specView: GyroSpectrum | null = null;
function toggleSpectrum() {
  specShown = !specShown; specView = null;
  send({ type: 'spectrum', on: specShown });
  if (specShown) drawSpectrum();
}
function onSpectrum(sp: GyroSpectrum) {
  if (!specShown) return;
  // light smoothing between frames so the traces are readable (like a blackbox analyser's averaging)
  if (specView && specView.bins === sp.bins) {
    for (let i = 0; i < sp.raw.length; i++) { sp.raw[i] = specView.raw[i] * 0.5 + sp.raw[i] * 0.5; sp.filtered[i] = specView.filtered[i] * 0.5 + sp.filtered[i] * 0.5; }
  }
  specView = sp;
  drawSpectrum();
}
function drawSpectrum() {
  const c = specCanvas.getContext('2d')!, W = SPEC_W, sp = specView;
  const L = 30, Rm = 6, plotW = W - L - Rm, maxHz = 1000, dbTop = 30, dbBot = -60;
  c.clearRect(0, 0, W, specCanvas.height);
  c.font = '10px ui-monospace, Consolas, monospace';
  const xOf = (hz: number) => L + (hz / maxHz) * plotW;
  ['roll', 'pitch', 'yaw'].forEach((name, a) => {
    const top = a * SPEC_ROW + 4, h = SPEC_ROW - 8;
    const yOf = (db: number) => top + ((dbTop - Math.max(dbBot, Math.min(dbTop, db))) / (dbTop - dbBot)) * h;
    c.strokeStyle = 'rgba(255,255,255,.12)'; c.lineWidth = 1;
    for (let db = dbBot; db <= dbTop; db += 10) { c.beginPath(); c.moveTo(L, yOf(db) + 0.5); c.lineTo(W - Rm, yOf(db) + 0.5); c.stroke(); }
    for (let hz = 0; hz <= maxHz; hz += 200) { c.beginPath(); c.moveTo(xOf(hz) + 0.5, top); c.lineTo(xOf(hz) + 0.5, top + h); c.stroke(); }
    c.fillStyle = 'rgba(255,255,255,.55)';
    c.fillText(name, L + 4, top + 10);
    c.fillText(`${dbTop}`, 4, yOf(dbTop) + 8); c.fillText(`${dbBot}`, 4, yOf(dbBot));
    if (!sp) return;
    // below this the filtered trace is Betaflight's integer °/s debug resolution, not real signal
    if (sp.hasFiltered) { c.fillStyle = 'rgba(57,182,255,.16)'; c.fillRect(L, yOf(sp.filteredFloorDb), plotW, top + h - yOf(sp.filteredFloorDb)); }
    // motor harmonics: band spans the 4 motors, line at their mean
    const lo = Math.min(...sp.motorHz), hi = Math.max(...sp.motorHz), mean = sp.motorHz.reduce((x, y) => x + y, 0) / 4;
    if (mean > 5) for (let hm = 1; hm <= 3; hm++) {
      c.fillStyle = 'rgba(255,220,80,.12)'; c.fillRect(xOf(lo * hm), top, Math.max(1, xOf(hi * hm) - xOf(lo * hm)), h);
      c.strokeStyle = 'rgba(255,220,80,.6)'; c.setLineDash([3, 3]);
      c.beginPath(); c.moveTo(xOf(mean * hm) + 0.5, top); c.lineTo(xOf(mean * hm) + 0.5, top + h); c.stroke(); c.setLineDash([]);
      if (a === 0 && mean * hm < maxHz - 20) { c.fillStyle = 'rgba(255,220,80,.85)'; c.fillText(`${hm}×`, xOf(mean * hm) + 2, top + 20); }
    }
    const trace = (arr: Float32Array, color: string) => {
      c.strokeStyle = color; c.lineWidth = 1.2; c.beginPath();
      for (let k = 1; k < sp.bins; k++) { const x = xOf(k * sp.binHz), y = yOf(arr[a * sp.bins + k]); if (k === 1) c.moveTo(x, y); else c.lineTo(x, y); }
      c.stroke();
    };
    trace(sp.raw, '#ff7a1a');
    if (sp.hasFiltered) trace(sp.filtered, '#39b6ff');
  });
  const by = SPEC_ROW * 3 + 14;
  c.fillStyle = 'rgba(255,255,255,.55)';
  for (let hz = 0; hz <= maxHz; hz += 200) c.fillText(`${hz}`, Math.min(xOf(hz) - 6, W - 30), by - 4);
  c.fillStyle = '#ff7a1a'; c.fillText('raw', L, by + 6);
  c.fillStyle = '#39b6ff'; c.fillText(sp && !sp.hasFiltered ? 'filtered: no signal yet (debug_mode GYRO_FILTERED?)' : 'BF filtered (shade: 1 °/s LSB)', L + 28, by + 6);
  c.fillStyle = 'rgba(255,220,80,.85)'; c.fillText(sp ? `motor ${(sp.motorHz.reduce((x, y) => x + y, 0) / 4).toFixed(0)} Hz · dB °/s` : 'collecting…', W - 118, by + 6);
}

const rec = new Float64Array(REC);
let lastCrash: string | null = null;
function updateHud() {
  hud.setVisible(!menuOpen);
  if (menuOpen) return;
  const now = performance.now();
  const head = newestTime(sh);
  sampleRing(sh, head, rec);
  const armed = rec[R.armed] > 0.5;
  if (armed && armedSince < 0) armedSince = now; else if (!armed) armedSince = -1;
  // notices: only the ones that matter right now, and controller help only while disarmed
  hidStatus.textContent = input.steamHid.status;
  fwNotice.textContent = fwStatus;
  const notices: HTMLElement[] = [];
  if (fwStatus) notices.push(fwNotice);
  // digital link down for more than a moment: say so, and how to get the quad back
  const vLost = view.view === 'fpv' && build.info.components.video.kind === 'digital' && (link.state.lost > 0 || link.state.freeze);
  if (vLost && lostSince < 0) lostSince = now; else if (!vLost) lostSince = -1;
  if (vLost && now - lostSince > 1200) notices.push(lostNotice);
  if (!input.active && !armed) notices.push(padNotice);
  if (input.active && input.profileFor(input.active).needsSetup && !armed) notices.push(setupNotice);
  if (audio.blocked) notices.push(soundChip);
  hud.notices(notices);
  // key hints collapse to a single "menu" chip a few seconds after arming
  hud.keys(input.active ? 'pad' : 'kb', armedSince >= 0 && now - armedSince > 3000);
  if (view.telemetry && tel) {
    const b = tel.battery;
    const spd = Math.hypot(rec[R.vx], rec[R.vy], rec[R.vz]) * 3.6;
    const rpm = [rec[R.rpm0], rec[R.rpm1], rec[R.rpm2], rec[R.rpm3]].map((r) => Math.abs(r).toFixed(0).padStart(5)).join(' ');
    const modes = tel.modeFlags;
    hud.tel([
      `${tel.fw}  sim ${(tel.simRate).toFixed(1)}× rt  ${tel.stepCostUs.toFixed(0)} µs`,
      `${Atomics.load(sh.ctrl, 5) ? 'ARMED' : 'disarmed'}  ${modes & 1 ? 'ANGLE' : modes & 2 ? 'HORIZON' : 'ACRO'}${rec[R.crashFlip] ? '  TURTLE' : ''}${tel.armingFlagNames.length ? '  blocked: ' + tel.armingFlagNames.join(',') : ''}`,
      `batt ${b.v.toFixed(2)} V  ${b.cellV.toFixed(2)} V/cell  ${b.i.toFixed(1)} A  sag ${b.sag.toFixed(2)} V`,
      `     ${b.mah.toFixed(0)} mAh  SoC ${(b.soc * 100).toFixed(0)} %  ${b.tempC.toFixed(1)} °C`,
      `rpm ${rpm}`,
      `motor °C ${tel.motorTemps.map((t) => t.toFixed(0)).join(' ')}`,
      `${spd.toFixed(0)} km/h  alt ${(rec[R.pz] - map.terrain(rec[R.px], rec[R.py])).toFixed(1)} m  wash ${(rec[R.vrs] * 100).toFixed(0)} %`,
      `video ${link.state.distance.toFixed(0)} m  ${link.state.rssiDbm.toFixed(0)} dBm${build.info.components.video.kind === 'analog' ? `  CNR ${link.state.cnr.toFixed(0)} dB` : ''}`,
      `props ${tel.rotorDamage.map((d) => (d.broken ? 'BROKEN' : `${(d.thrust * 100).toFixed(0)}%`)).join(' ')}`,
      ...logLines.slice(-2),
    ]);
    hud.sticks(true);
    drawSticks();
  } else { hud.tel(null); hud.sticks(false); }
  hud.spectrum(specShown);
  // race panel + live room leaderboard (best lap first), or the hover drill
  let drillInfo: DrillInfo | null = null;
  if (drill.on) {
    const sp = map.spawn.pos, gz = spawnGroundZ(map);
    const d = Math.hypot(rec[R.px] - sp.x, rec[R.py] - sp.y, rec[R.pz] - (gz + 3));
    if (armed && drill.t0 < 0) { drill.t0 = head; drill.inside = 0; drill.last = head; }
    if (armed && drill.t0 >= 0) { if (d < 1.5) drill.inside += head - drill.last; drill.last = head; }
    const el2 = drill.t0 >= 0 ? head - drill.t0 : 0;
    const score = el2 > 0 ? (100 * drill.inside) / el2 : 0;
    if (el2 >= 30 && armed) { drill.best = Math.max(drill.best, score); drill.t0 = -1; log(`Hover drill: ${score.toFixed(0)} % inside the box`); }
    drillInfo = { inBox: d < 1.5, offBy: Math.max(0, d - 1.5), elapsed: el2, score, best: drill.best };
  }
  const me = loadPilot();
  const board = mp.connected && map.gates.length
    ? [{ name: me.name, color: me.color, lap: lapCount, best: bestLap, me: true }, ...[...mp.peers.values()].map((p) => ({ name: p.info.name, color: p.info.color, lap: p.lap?.lap ?? 0, best: p.lap?.best || Infinity, me: false }))].sort((a, b) => a.best - b.best)
    : undefined;
  hud.race(map.gates.length ? { lap: lapCount, last: lastLap, best: bestLap, gate: nextGate + 1, gates: map.gates.length, board } : null, drillInfo);
  // crash banner; haptic thump + impact sound on a new crash, scaled by impact speed ("Impact 12.3 m/s")
  const crash = tel?.crash ?? null;
  hud.crash(crash ? crash.toUpperCase() : null);
  if (crash && crash !== lastCrash) {
    const v = parseFloat(crash.replace(/[^\d.]/g, '')) || 8;
    input.rumble(Math.min(1, v / 15), Math.min(1, v / 25), 180 + Math.min(320, v * 15));
    audio.impact(Math.min(1, v / 12), view.view === 'chase' ? 2 : Math.hypot(rec[R.px] - pilot.x, rec[R.py] - pilot.y, rec[R.pz] - pilot.z));
  }
  lastCrash = crash;
  // place everything around the OSD (~8 Hz: cheap, and widgets don't jitter)
  if (now - hudLayoutAt > 120) {
    hudLayoutAt = now;
    const fpvOn = view.view === 'fpv' && view.osd && osd.hasContent;
    hud.layout(fpvOn ? osdRects(osd.occupied, osd.cols, osd.rows, fpv.layout.osd) : [], view.view === 'fpv' ? fpv.layout.frame : null);
  }
}

// ---------------------------------------------------------------------------------------------
// Menu (title screen, new game, server browser, settings, Betaflight guide, pause)
let menuOpen = false;
const pauseInMenu = true;
const bfBridge = {
  cliBatch: (lines: string[]) => new Promise<string>((res) => { const id = batchId++; batchWaiters.set(id, res); send({ type: 'cliBatch', lines, id }); }),
  cliSend: (text: string) => send({ type: 'cli', text }),
  onCliOut: (cb: (t: string) => void) => { cliListeners.push(cb); },
};
function blackboxPanel(): HTMLElement {
  const root = el('div', { class: 'panel' });
  const render = () => root.replaceChildren(el('section', { class: 'sec' }, el('h3', {}, 'Blackbox-lite recorder'),
    el('p', {}, `Records the 1 kHz true state, raw gyro, motor DShot outputs and RPM, battery and your RC sticks whenever the quad is armed (last 5 minutes kept). ${blackbox.length} samples recorded.`),
    el('div', { class: 'actions' }, el('button', { class: 'primary', onclick: () => blackbox.download() }, 'Download CSV'), el('button', { onclick: () => { blackbox.clear(); render(); } }, 'Clear'))));
  render();
  return root;
}
/** New game / respawn from the menu: repaired quad, fresh battery, the chosen mode. */
function startFlight(mode: GameMode) {
  drill.on = mode === 'drill'; drill.t0 = -1; drill.inside = 0;
  bestLap = Infinity; lastLap = 0; lapCount = 0;
  sendReset(true);
}
const gameMenu = new GameMenu({
  input, mp,
  spec: () => spec, applySpec,
  sim: () => simSettings, applySim: (s) => applySim(s),
  build: () => build,
  fwStatus: () => fwStatus,
  settingsTabs: [
    { id: 'sim', label: 'Simulation', icon: 'sliders', render: () => settingsPanel(simSettings, view, applySim, applyView) },
    { id: 'controller', label: 'Controller', icon: 'gamepad', render: () => inputPanel(input) },
    { id: 'bf', label: 'Betaflight', icon: 'cpu', render: () => bfPanel(bfBridge, {
      hardwareCli: (keepOsdLayout, propsOut) => simHardwareCli(build, { keepOsdLayout, propsOut }),
      propsOut: () => spec.propDirection === 'props-out',
      setPropsOut: (out) => applySpec({ ...spec, propDirection: out ? 'props-out' : 'props-in' }),
    }) },
    { id: 'builder', label: 'Drone builder', icon: 'wrench', render: () => builderPanel(() => spec, (s) => { applySpec(s); gameMenu.resume(); }) },
    { id: 'mp', label: 'Multiplayer', icon: 'users', render: () => multiplayerPanel(mp, joinRoom) },
    { id: 'blackbox', label: 'Blackbox', icon: 'database', render: blackboxPanel },
  ],
  startFlight, joinRoom,
  onOpenChange: (open) => {
    menuOpen = open;
    input.suspended = open; // menu buttons must not arm / switch modes / respawn
    send({ type: 'settings', settings: { ...simSettings, paused: open && pauseInMenu } });
  },
});
app.append(gameMenu.root);

// ---------------------------------------------------------------------------------------------
// Frame loop
const tmpQ = new THREE.Quaternion(), tmpV = new THREE.Vector3(), lensPos = new THREE.Vector3(), lensQ = new THREE.Quaternion();
const omegaCam = new THREE.Vector3();
let lastCap = -1, lastCapWall = performance.now();
let jitter = 0;
const pilot = { x: 0, y: 0, z: 1.6 };

function poseAt(t: number): boolean {
  if (!sampleRing(sh, t, rec)) return false;
  enuToThree(rec[R.px], rec[R.py], rec[R.pz], drone.root.position);
  quatEnuToThree(rec[R.qw], rec[R.qx], rec[R.qy], rec[R.qz], drone.root.quaternion);
  return true;
}

function animate(now: number) {
  requestAnimationFrame(animate);
  // multiplayer: publish our newest pose, place the other pilots before anything is rendered
  if (mp.connected && sampleRing(sh, newestTime(sh), mpRec)) {
    const rr = mpRec;
    mp.sendPose(now, [rr[R.px], rr[R.py], rr[R.pz]], [rr[R.qw], rr[R.qx], rr[R.qy], rr[R.qz]],
      (Math.abs(rr[R.rpm0]) + Math.abs(rr[R.rpm1]) + Math.abs(rr[R.rpm2]) + Math.abs(rr[R.rpm3])) / 4, rr[R.armed] > 0.5);
  }
  remotes.update(sceneB.scene, mp, now);
  const v = build.info.components.video;
  const head = newestTime(sh);
  pilotPos(map, pilot);
  // ---- emulated glass-to-glass latency + camera frame cadence ----
  const baseLat = (view.latencyOverrideMs || v.latencyMs) + link.state.latencyExtraMs;
  const lat = Math.max(0, baseLat + jitter - displayComp(now)) / 1000;
  const period = 1 / v.fps;
  const tDisp = head - lat;
  const tCap = Math.floor(tDisp / period) * period;
  // props spin visual
  const rpmNow = [rec[R.rpm0], rec[R.rpm1], rec[R.rpm2], rec[R.rpm3]];
  sceneB.setGateHighlight(nextGate, view.highlightGate, now / 1000);
  if (view.view !== 'fpv' || gameMenu.backdrop) sceneB.hemi.intensity = sceneB.hemiBase; // spectators: true lighting
  if (gameMenu.backdrop) {
    if (poseAt(head)) {
      const p = drone.root.position;
      const r = Math.max(0.28, build.info.components.frame.wheelbaseMm / 225 * 0.85);
      const a = matchMedia('(prefers-reduced-motion: reduce)').matches ? 2.2 : now * 0.00016 + 2.2;
      orbitCam.position.set(p.x + Math.cos(a) * r, p.y + 0.32 * r + 0.04, p.z + Math.sin(a) * r);
      orbitCam.lookAt(p.x, p.y + 0.02, p.z);
      sceneB.sun.position.copy(sceneB.sunDir).multiplyScalar(120).add(p);
      sceneB.sun.target.position.copy(p);
      renderer.shadowMap.needsUpdate = true;
      renderer.setRenderTarget(null);
      renderer.render(sceneB.scene, orbitCam);
    }
  } else if (view.view === 'fpv') {
    // (frames only move forward: per-frame jitter must never re-capture an older pose)
    // a frozen digital decoder shows its last frame, but the link itself keeps being evaluated
    // every camera frame, or it could never recover (fly back / respawn)
    if (tCap > lastCap && poseAt(tCap)) {
      const dtw = (now - lastCapWall) / 1000; lastCapWall = now;
      lastCap = tCap;
      jitter = (Math.random() - 0.5) * v.latencyJitterMs;
      // lens pose: body pose * camera mount offset
      drone.root.updateMatrixWorld();
      const camOffset = tmpV.set(build.info.components.frame.plateLengthMm / 2000 + 0.006 - build.info.cgMm.x / 1000, cameraMountZ(build.info.components.frame, build.info.components.motor) - build.info.cgMm.z / 1000, 0);
      lensPos.copy(camOffset).applyQuaternion(drone.root.quaternion).add(drone.root.position);
      lensQ.copy(drone.root.quaternion).multiply(mountQ);
      // angular rate in camera frame (body FLU -> three body -> camera)
      omegaCam.set(rec[R.wx], rec[R.wz], -rec[R.wy]).applyQuaternion(tmpQ.copy(mountQ).invert());
      if (!link.state.freeze) {
        // hide only the camera itself: whoop ducts, props and a 5"'s props at high uptilt are in view
        for (const o of drone.fpvHidden) o.visible = false;
        sceneB.sun.position.copy(sceneB.sunDir).multiplyScalar(120).add(drone.root.position);
        sceneB.sun.target.position.copy(drone.root.position);
        // shadow map at <= 30 Hz (a full scene pass): plenty for a moving camera
        if (now - lastShadowAt > 33) { renderer.shadowMap.needsUpdate = true; lastShadowAt = now; }
        updateSkyAmbient(dtw);
        spinProps(rpmNow);
        fpv.capture(sceneB.scene, lensPos, lensQ, omegaCam, dtw, drone.root);
        for (const o of drone.fpvHidden) o.visible = true;
      }
      // link budget at capture time
      const up = tmpV.set(0, 1, 0).applyQuaternion(drone.root.quaternion);
      if (view.linkEffects) link.update(v, world, pilot, { x: rec[R.px], y: rec[R.py], z: rec[R.pz] }, { x: up.x, y: -up.z, z: up.y }, dtw, now / 1000, Math.hypot(rec[R.vx], rec[R.vy], rec[R.vz]));
      else link.state = { ...link.state, cnr: 45, block: 0, freeze: false, lost: 0, latencyExtraMs: 0 };
    }
    // 1S brownout: on a punch a whoop's pack sags below what the camera / VTX regulators need
    // (~2.9-3.0 V), and the video drops out for about a second while they restart
    const cells = build.info.components.battery.cells;
    if (cells === 1 && rec[R.vbus] > 0.5 && rec[R.vbus] < 2.95 && now > brownoutUntil + 400) brownoutUntil = now + 800 + Math.random() * 600;
    if (now < brownoutUntil) { if (v.kind === 'analog') link.state.cnr = -8; else link.state.lost = 1; }
    // digital HD OSD is sent over the video link: it freezes with the picture
    if (!(v.kind === 'digital' && (link.state.freeze || link.state.lost))) osd.update(sh, now);
    fpv.present(osd.texture, (osd.cols * 12) / (osd.rows * 18) * (v.kind === 'analog' ? 0.9 : 1), now / 1000, link.state, view.osd && osd.hasContent);
  } else {
    // spectator views show the true (undelayed) state
    if (poseAt(head)) {
      spinProps(rpmNow);
      const p = drone.root.position;
      if (view.view === 'chase') {
        // chase distance scales with the quad (1.6 m behind a 5", ~0.5 m behind a 65 mm whoop)
        const cs = Math.max(0.3, Math.min(1.3, build.info.components.frame.wheelbaseMm / 225));
        const back = tmpV.set(-1.6 * cs, 0.6 * cs, 0).applyQuaternion(tmpQ.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yawOf(drone.root.quaternion)));
        chaseCam.position.lerp(back.add(p), 0.15);
        chaseCam.lookAt(p);
      } else {
        enuToThree(pilot.x, pilot.y, pilot.z, chaseCam.position);
        chaseCam.lookAt(p);
        chaseCam.fov = 60; chaseCam.updateProjectionMatrix();
      }
      sceneB.sun.position.copy(sceneB.sunDir).multiplyScalar(120).add(p);
      sceneB.sun.target.position.copy(p);
      renderer.shadowMap.needsUpdate = true;
      renderer.setRenderTarget(null);
      renderer.render(sceneB.scene, chaseCam);
    }
  }
  blackbox.pump(sh, input.channels);
  if (drillMesh.parent !== sceneB.scene) sceneB.scene.add(drillMesh);
  drillMesh.visible = drill.on;
  if (drill.on) enuToThree(map.spawn.pos.x, map.spawn.pos.y, spawnGroundZ(map) + 3, drillMesh.position);
  // where the listener is: the pilot (FPV / line of sight) or the chase camera
  const hearD = view.view === 'chase' ? 2 : Math.hypot(rec[R.px] - pilot.x, rec[R.py] - pilot.y, rec[R.pz] - pilot.z);
  audio.update(rpmNow.map(Math.abs), rec[R.ibus], build.info.components.prop.blades, build.info.components.motor.poles, hearD, rec[R.vrs]);
  updateHud();
}
function yawOf(q: THREE.Quaternion) { const e = new THREE.Euler().setFromQuaternion(q, 'YXZ'); return e.y; }
function spinProps(rpm: number[]) {
  drone.props.forEach((p, k) => {
    const r = rpm[k] ?? 0;
    p.rotation.y += (r / 60) * 2 * Math.PI * (1 / 60) * drone.propDirs[k] * 0.13;
    drone.blur[k].visible = Math.abs(r) > 3000;
    for (const c of p.children) if (c !== drone.blur[k]) c.visible = Math.abs(r) < 6000;
  });
}
requestAnimationFrame(animate);

// invite links: ?room=CODE joins that room on load
{
  const code = new URLSearchParams(location.search).get('room')?.toUpperCase();
  if (code && /^[A-Z0-9]{4,8}$/.test(code)) joinRoom(code);
}
gameMenu.open('title');

// debugging handle (inspect from devtools)
(window as any).__fpv = { mp, menu: gameMenu, hud, teleport: (x: number, y: number, z: number, yawDeg = 0) => { onRespawn(); send({ type: 'reset', repair: true, at: { x, y, z, yawDeg } }); }, osdCells: () => (osd.hasContent && view.view === 'fpv' && view.osd ? osdRects(osd.occupied, osd.cols, osd.rows, fpv.layout.osd) : []), frameRect: () => fpv.layout.frame, get scene() { return sceneB.scene; }, sh, R, REC, sampleRing, newestTime, get tel() { return tel; }, get spectrum() { return specView; }, input, link, cli: (lines: string[]) => bfBridge.cliBatch(lines) };
