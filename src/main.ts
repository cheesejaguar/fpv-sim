import * as THREE from 'three';
import './style.css';
import { buildDrone, DEFAULT_SPEC, DroneBuild, DroneSpec } from './builder/derive';
import { InputManager } from './input/gamepad';
import { webHidSupported } from './input/steamHid';
import { MAPS, preloadMap } from './maps/maps';
import { MapDef, pilotPos, PrimitiveWorld, spawnGroundZ } from './maps/world';
import { MotorAudio } from './render/audio';
import { cameraMountQuat, enuToThree, quatEnuToThree } from './render/coords';
import { buildDroneMesh, DroneModel } from './render/droneMesh';
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
import { DEFAULT_VIEW, settingsPanel, ViewSettings } from './ui/settingsPanel';
import { createShared, DEFAULT_SETTINGS, FromWorker, GyroSpectrum, newestTime, R, REC, sampleRing, SimSettings, Telemetry, ToWorker } from './worker/shared';

// ---------------------------------------------------------------------------------------------
const load = <T,>(k: string, d: T): T => { try { const s = localStorage.getItem(k); return s ? { ...d, ...JSON.parse(s) } : d; } catch { return d; } };
const store = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } };

let spec: DroneSpec = load('fpv-spec', DEFAULT_SPEC);
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
const gateTimes: { gate: number; t: number }[] = [];
let lapStart = -1, bestLap = Infinity, lastLap = 0, lapCount = 0;
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
  const n = map.gates.length;
  gateTimes.push({ gate, t });
  if (gate === 0) {
    if (lapStart >= 0) { lastLap = t - lapStart; lapCount++; bestLap = Math.min(bestLap, lastLap); mp.sendLap(lapCount, lastLap, bestLap); }
    lapStart = t;
  }
  void n;
}

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
window.addEventListener('resize', () => { renderer.setSize(innerWidth, innerHeight); chaseCam.aspect = innerWidth / innerHeight; chaseCam.updateProjectionMatrix(); });

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
input.onReset = () => send({ type: 'reset', repair: true });
input.onMenu = () => toggleMenu();
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
function joinRoom(code: string) {
  const p = loadPilot();
  mp.join(code, { name: p.name, color: p.color, frame: build.info.components.frame.sizeClass, map: simSettings.mapId });
  history.replaceState(null, '', inviteLink(code));
}
const drillMesh = new THREE.Mesh(new THREE.SphereGeometry(1.5, 32, 16), new THREE.MeshBasicMaterial({ color: 0x39b6ff, transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide }));
const chaseCam = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.05, 3000);

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

function applySim(s: SimSettings) {
  const mapChanged = s.mapId !== simSettings.mapId;
  simSettings = s; store('fpv-sim-settings', s);
  // loading is async (Quake maps fetch their sources): remember now whether the room asked for it
  const fromRoom = applyingRoomMap;
  if (mapChanged) void preloadMap(s.mapId).then(() => {
    if (simSettings.mapId !== s.mapId) return; // superseded while loading
    sceneB.scene.remove(drone.root); sceneB.dispose();
    map = MAPS[s.mapId](); world = new PrimitiveWorld(map); sceneB = buildScene(map); sceneB.scene.add(drone.root);
    lapStart = -1; bestLap = Infinity; lapCount = 0;
    if (mp.connected && !fromRoom) mp.sendMap(s.mapId); // the room flies one shared map
  }, (e) => log(`Map ${s.mapId} failed to load: ${e}`));
  send({ type: 'settings', settings: { ...s, paused: menuOpen && pauseInMenu } });
}

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
  if (e.code === 'Escape') toggleMenu();
  if (e.code === 'KeyR') { input.disarm(); send({ type: 'reset', repair: true }); }
  if (e.code === 'KeyC') { const order: ViewSettings['view'][] = ['fpv', 'chase', 'los']; applyView({ ...view, view: order[(order.indexOf(view.view) + 1) % 3] }); }
  if (e.code === 'KeyH') applyView({ ...view, telemetry: !view.telemetry });
  if (e.code === 'KeyG') { drill.on = !drill.on; drill.t0 = -1; drill.inside = 0; }
  if (e.code === 'KeyB') { input.disarm(); send({ type: 'reset', repair: true, fullBattery: true }); }
  if (e.code === 'KeyF') toggleSpectrum();
});
// Every page gesture (not just the first) unlocks / resumes audio: controller input can't, and the
// browser may suspend the context later (tab switch, audio device change).
for (const ev of ['pointerdown', 'keydown', 'touchstart'] as const) window.addEventListener(ev, () => audio.unlock(), { capture: true });

// ---------------------------------------------------------------------------------------------
// HUD
const hud = el('div', { class: 'hud' });
const status = el('div', { class: 'fw-status' });
const telBox = el('div', { class: 'tel' });
const sticks = el('canvas', { class: 'sticks', width: 220, height: 100 }) as HTMLCanvasElement;
const lapBox = el('div', { class: 'laps' });
const crashBox = el('div', { class: 'crash' });
// Browsers block audio until a click / key press on the page (controller buttons don't count).
const soundHint = el('div', { class: 'sound-hint' }, '🔇 Click anywhere (or press a key) to enable motor sound');
const helpBox = el('div', { class: 'help' }, 'Esc menu · R reset · B new battery · C camera · H telemetry · G hover-box drill · F noise spectrum');
const SPEC_W = 380, SPEC_ROW = 92;
const specCanvas = el('canvas', { class: 'spectrum', width: SPEC_W, height: SPEC_ROW * 3 + 22 }) as HTMLCanvasElement;
specCanvas.style.display = 'none';
// Shown while no controller is available. The 2026 Steam Controller is never visible to the
// Gamepad API (outside Steam it acts as keyboard + mouse), so offer the direct WebHID driver.
const hidStatus = el('div', { class: 'hid-status' });
const padBox = el('div', { class: 'pad-warn' },
  el('b', {}, 'No game controller detected — keyboard fallback is active.'),
  el('div', {}, 'Xbox, PS5 DualSense, DJI FPV Remote Controller 3 (USB-C) or other USB joystick: connect it, click this page, then press a button or move a stick — browsers only reveal a controller after its first input.'),
  ...(webHidSupported()
    ? [
      el('div', {}, 'Steam Controller (2026): browsers can’t see it as a gamepad. Quit Steam completely (tray icon → Exit), connect it by cable or its wireless puck, then click:'),
      el('button', { class: 'primary', onclick: () => void input.steamHid.request() }, 'Connect Steam Controller'),
    ]
    // Safari / Firefox: no WebHID, so the 2026 Steam Controller can't be driven from the page
    : [el('div', { class: 'note' }, 'Steam Controller (2026): this browser has no WebHID, which the direct connection needs. Use Chrome or Edge for that controller.')]),
  hidStatus,
);
// Radios / HID joysticks with an unknown stick layout: point at the setup wizard.
const setupBox = el('div', { class: 'pad-warn' },
  el('b', {}, 'New controller: run the stick & switch setup once.'),
  el('div', {}, 'Press Esc → Controller → “Start stick & switch setup”. It detects your sticks, their directions and your arm / flight-mode switches.'),
);
hud.append(soundHint, status, padBox, setupBox, telBox, sticks, lapBox, crashBox, specCanvas, helpBox);
app.append(hud);

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
  specCanvas.style.display = specShown ? 'block' : 'none';
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
  status.textContent = fwStatus;
  status.style.display = fwStatus ? 'block' : 'none';
  padBox.style.display = input.active ? 'none' : 'block';
  setupBox.style.display = input.active && input.profileFor(input.active).needsSetup && !menuOpen ? 'block' : 'none';
  hidStatus.textContent = input.steamHid.status;
  if (view.telemetry && tel) {
    const b = tel.battery;
    const head = newestTime(sh);
    sampleRing(sh, head, rec);
    const spd = Math.hypot(rec[R.vx], rec[R.vy], rec[R.vz]) * 3.6;
    const rpm = [rec[R.rpm0], rec[R.rpm1], rec[R.rpm2], rec[R.rpm3]].map((r) => Math.abs(r).toFixed(0).padStart(5)).join(' ');
    const modes = tel.modeFlags;
    const lines = [
      `${tel.fw}   sim ${(tel.simRate).toFixed(1)}× rt  step ${tel.stepCostUs.toFixed(1)} µs`,
      `ARM ${Atomics.load(sh.ctrl, 5) ? 'ARMED' : 'disarmed'}  ${tel.armingFlagNames.length ? 'blocked: ' + tel.armingFlagNames.join(',') : ''}`,
      `mode ${modes & 1 ? 'ANGLE' : modes & 2 ? 'HORIZON' : 'ACRO'}${rec[R.crashFlip] ? '  TURTLE' : ''}`,
      `batt ${b.v.toFixed(2)} V (${b.cellV.toFixed(2)} V/cell)  ${b.i.toFixed(1)} A  sag ${b.sag.toFixed(2)} V`,
      `     ${b.mah.toFixed(0)} mAh  SoC ${(b.soc * 100).toFixed(0)} %  ${b.tempC.toFixed(1)} °C`,
      `rpm ${rpm}`,
      `motor °C ${tel.motorTemps.map((t) => t.toFixed(0)).join(' ')}`,
      `speed ${spd.toFixed(0)} km/h  alt ${(rec[R.pz] - map.terrain(rec[R.px], rec[R.py])).toFixed(1)} m  prop-wash ${(rec[R.vrs] * 100).toFixed(0)} %`,
      `video ${build.info.components.video.name}  ${link.state.distance.toFixed(0)} m  ${link.state.rssiDbm.toFixed(0)} dBm${build.info.components.video.kind === 'analog' ? `  CNR ${link.state.cnr.toFixed(0)} dB` : ''}`,
      `props ${tel.rotorDamage.map((d) => (d.broken ? 'BROKEN' : `${(d.thrust * 100).toFixed(0)}%`)).join(' ')}`,
      ...logLines.slice(-3),
    ];
    telBox.textContent = lines.join('\n');
    telBox.style.display = 'block'; sticks.style.display = 'block';
    drawSticks();
  } else { telBox.style.display = 'none'; sticks.style.display = 'none'; }
  lapBox.textContent = map.gates.length ? `Lap ${lapCount}  last ${lastLap ? lastLap.toFixed(2) : '--'} s  best ${bestLap < Infinity ? bestLap.toFixed(2) : '--'} s  next gate ${(gateTimes.length % map.gates.length) + 1}/${map.gates.length}` : '';
  // live room leaderboard (best lap first)
  if (mp.connected && map.gates.length) {
    const rows = [{ name: loadPilot().name + ' (you)', lap: lapCount, best: bestLap }, ...[...mp.peers.values()].map((p) => ({ name: p.info.name, lap: p.lap?.lap ?? 0, best: p.lap?.best || Infinity }))]
      .sort((a, b) => a.best - b.best);
    lapBox.textContent += '\n' + rows.map((r, i) => `${i + 1}. ${r.name.padEnd(16)} lap ${String(r.lap).padStart(2)}  best ${r.best < Infinity ? r.best.toFixed(2) + ' s' : '--'}`).join('\n');
  }
  crashBox.textContent = tel?.crash ?? '';
  soundHint.style.display = audio.blocked && !menuOpen ? 'block' : 'none';
  // haptic thump on a new crash, scaled by impact speed ("Impact 12.3 m/s")
  const crash = tel?.crash ?? null;
  if (crash && crash !== lastCrash) {
    const v = parseFloat(crash.replace(/[^\d.]/g, '')) || 8;
    input.rumble(Math.min(1, v / 15), Math.min(1, v / 25), 180 + Math.min(320, v * 15));
  }
  lastCrash = crash;
  if (drill.on) {
    const head = newestTime(sh);
    sampleRing(sh, head, rec);
    const sp = map.spawn.pos, gz = spawnGroundZ(map);
    const d = Math.hypot(rec[R.px] - sp.x, rec[R.py] - sp.y, rec[R.pz] - (gz + 3));
    const armed = rec[R.armed] > 0.5;
    if (armed && drill.t0 < 0) { drill.t0 = head; drill.inside = 0; drill.last = head; }
    if (armed && drill.t0 >= 0) { if (d < 1.5) drill.inside += head - drill.last; drill.last = head; }
    const el2 = drill.t0 >= 0 ? head - drill.t0 : 0;
    const score = el2 > 0 ? (100 * drill.inside) / el2 : 0;
    if (el2 >= 30 && armed) { drill.best = Math.max(drill.best, score); drill.t0 = -1; log(`Hover drill: ${score.toFixed(0)} % inside the box`); }
    lapBox.textContent = `HOVER DRILL  ${d < 1.5 ? 'IN BOX' : `off by ${(d - 1.5).toFixed(1)} m`}  ${el2.toFixed(1)}/30 s  score ${score.toFixed(0)} %  best ${drill.best.toFixed(0)} %`;
  }
}

// ---------------------------------------------------------------------------------------------
// Menu
let menuOpen = false;
const pauseInMenu = true;
const menu = el('div', { class: 'menu hidden' });
const tabs = el('nav', { class: 'tabs' });
const body = el('div', { class: 'menu-body' });
menu.append(el('header', {}, el('h1', {}, 'FPV Sim'), el('span', { class: 'sub' }, 'Betaflight-in-the-loop FPV trainer · ', el('a', { href: 'https://github.com/cheesejaguar/fpv-sim', target: '_blank', rel: 'noopener' }, 'source (GPL-3.0)')), tabs, el('button', { class: 'close', onclick: () => toggleMenu() }, 'Fly ▶')), body);
app.append(menu);
const bfBridge = {
  cliBatch: (lines: string[]) => new Promise<string>((res) => { const id = batchId++; batchWaiters.set(id, res); send({ type: 'cliBatch', lines, id }); }),
  cliSend: (text: string) => send({ type: 'cli', text }),
  onCliOut: (cb: (t: string) => void) => { cliListeners.push(cb); },
};
const TABS: [string, () => HTMLElement][] = [
  ['Drone builder', () => builderPanel(() => spec, (s) => { applySpec(s); toggleMenu(); })],
  ['Betaflight', () => bfPanel(bfBridge, {
    hardwareCli: (keepOsdLayout, propsOut) => simHardwareCli(build, { keepOsdLayout, propsOut }),
    propsOut: () => spec.propDirection === 'props-out',
    setPropsOut: (out) => applySpec({ ...spec, propDirection: out ? 'props-out' : 'props-in' }),
  })],
  ['Controller', () => inputPanel(input)],
  ['Simulation', () => settingsPanel(simSettings, view, applySim, applyView)],
  ['Multiplayer', () => multiplayerPanel(mp, joinRoom)],
  ['Blackbox', () => el('div', { class: 'panel' }, el('section', { class: 'sec' }, el('h3', {}, 'Blackbox-lite recorder'),
    el('p', {}, `Records the 1 kHz true state, raw gyro, motor DShot outputs and RPM, battery and your RC sticks whenever the quad is armed (last 5 minutes kept). ${blackbox.length} samples recorded.`),
    el('div', { class: 'actions' }, el('button', { class: 'primary', onclick: () => blackbox.download() }, 'Download CSV'), el('button', { onclick: () => { blackbox.clear(); renderTabs(); } }, 'Clear')))),
  ],
];
let tabIdx = 0;
function renderTabs() {
  tabs.replaceChildren(...TABS.map(([n], i) => el('button', { class: i === tabIdx ? 'on' : '', onclick: () => { tabIdx = i; renderTabs(); } }, n)));
  body.replaceChildren(TABS[tabIdx][1]());
}
function toggleMenu() {
  menuOpen = !menuOpen;
  menu.classList.toggle('hidden', !menuOpen);
  if (menuOpen) { input.disarm(); renderTabs(); }
  send({ type: 'settings', settings: { ...simSettings, paused: menuOpen && pauseInMenu } });
}

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
  const lat = Math.max(0, baseLat + jitter - view.displayCompMs) / 1000;
  const period = 1 / v.fps;
  const tDisp = head - lat;
  const tCap = Math.floor(tDisp / period) * period;
  // props spin visual
  const rpmNow = [rec[R.rpm0], rec[R.rpm1], rec[R.rpm2], rec[R.rpm3]];
  if (view.view === 'fpv') {
    if (tCap !== lastCap && poseAt(tCap)) {
      const dtw = (now - lastCapWall) / 1000; lastCapWall = now;
      lastCap = tCap;
      jitter = (Math.random() - 0.5) * v.latencyJitterMs;
      // lens pose: body pose * camera mount offset
      drone.root.updateMatrixWorld();
      const camOffset = tmpV.set(build.info.components.frame.plateLengthMm / 2000 + 0.006 - build.info.cgMm.x / 1000, build.info.components.frame.stackHeightMm / 2000 - build.info.cgMm.z / 1000, 0);
      lensPos.copy(camOffset).applyQuaternion(drone.root.quaternion).add(drone.root.position);
      lensQ.copy(drone.root.quaternion).multiply(mountQ);
      // angular rate in camera frame (body FLU -> three body -> camera)
      omegaCam.set(rec[R.wx], rec[R.wz], -rec[R.wy]).applyQuaternion(tmpQ.copy(mountQ).invert());
      drone.root.visible = false;
      sceneB.sun.position.copy(sceneB.sunDir).multiplyScalar(120).add(drone.root.position);
      sceneB.sun.target.position.copy(drone.root.position);
      renderer.shadowMap.needsUpdate = true;
      fpv.capture(sceneB.scene, lensPos, lensQ, omegaCam, dtw);
      drone.root.visible = true;
      // link budget at capture time
      const up = tmpV.set(0, 1, 0).applyQuaternion(drone.root.quaternion);
      if (view.linkEffects) link.update(v, world, pilot, { x: rec[R.px], y: rec[R.py], z: rec[R.pz] }, { x: up.x, y: -up.z, z: up.y }, dtw, now / 1000);
      else link.state = { ...link.state, cnr: 45, block: 0, freeze: false, latencyExtraMs: 0 };
    }
    osd.update(sh, now);
    fpv.present(osd.texture, (osd.cols * 12) / (osd.rows * 18) * (v.kind === 'analog' ? 0.9 : 1), now / 1000, link.state, view.osd && osd.hasContent);
  } else {
    // spectator views show the true (undelayed) state
    if (poseAt(head)) {
      spinProps(rpmNow);
      const p = drone.root.position;
      if (view.view === 'chase') {
        const back = tmpV.set(-1.6, 0.6, 0).applyQuaternion(tmpQ.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yawOf(drone.root.quaternion)));
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
  audio.update(rpmNow.map(Math.abs), rec[R.ibus], build.info.components.prop.blades, build.info.components.motor.poles);
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

// debugging handle (inspect from devtools)
(window as any).__fpv = { mp, get scene() { return sceneB.scene; }, sh, R, REC, sampleRing, newestTime, get tel() { return tel; }, get spectrum() { return specView; }, input, link, cli: (lines: string[]) => bfBridge.cliBatch(lines) };
