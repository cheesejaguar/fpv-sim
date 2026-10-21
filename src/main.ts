// Composition root: loads settings, starts the sim worker, builds the world and the services, wires
// input, multiplayer, the menu and the HUD, then runs the frame loop. The pieces live in src/app/.
import * as THREE from 'three';
import './style.css';
import { WorkerBridge } from './app/bridge';
import { AppCtx, makeLog } from './app/context';
import { startFrameLoop } from './app/frameLoop';
import { HudController } from './app/hudController';
import { SpectrumView, SticksView } from './app/instruments';
import { newDrill, newRace, onGate, onRespawn, resetLaps, toggleDrill } from './app/race';
import { simHardwareCli } from './bf/defaults';
import { buildDrone, DroneBuild, DroneSpec } from './builder/derive';
import { InputManager, SimAction } from './input/gamepad';
import { isLocalMap, onLocalMap } from './maps/localMaps';
import { hasMap, MAPS, preloadMap } from './maps/maps';
import { PrimitiveWorld } from './maps/world';
import { MultiplayerClient } from './net/multiplayer';
import { MotorAudio } from './render/audio';
import { cameraMountQuat } from './render/coords';
import { buildDroneMesh } from './render/droneMesh';
import { FpvCamera } from './render/fpvCamera';
import { OsdRenderer } from './render/osdRenderer';
import { RemoteQuads } from './render/remoteQuads';
import { buildScene } from './render/scene';
import { VideoLink } from './render/videoLink';
import { bfPanel } from './ui/bfPanel';
import { Blackbox } from './ui/blackbox';
import { builderPanel } from './ui/builderPanel';
import { el } from './ui/dom';
import { inputPanel } from './ui/inputPanel';
import { EASY_SPEC, GameMenu, GameMode } from './ui/menu/gameMenu';
import { inviteLink, loadPilot, multiplayerPanel } from './ui/multiplayerPanel';
import { DEFAULT_VIEW, settingsPanel, ViewSettings } from './ui/settingsPanel';
import { createShared, DEFAULT_SETTINGS, newestTime, R, REC, sampleRing, SimSettings } from './worker/shared';

// ---------------------------------------------------------------------------------------------
const load = <T,>(k: string, d: T): T => { try { const s = localStorage.getItem(k); return s ? { ...d, ...JSON.parse(s) } : d; } catch { return d; } };
const store = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } };

const appEl = document.getElementById('app')!;
if (!crossOriginIsolated) {
  appEl.append(el('div', { class: 'fatal' }, 'This page must be cross-origin isolated (COOP/COEP headers) for SharedArrayBuffer. Run it with "npm run dev" or "npm run preview".'));
  throw new Error('not cross-origin isolated');
}

// first run starts on the easiest quad (65 mm tiny whoop); after that, whatever the pilot flew last
const spec0: DroneSpec = load('fpv-spec', EASY_SPEC);
const sim0: SimSettings = load('fpv-sim-settings', DEFAULT_SETTINGS);
const view0: ViewSettings = load('fpv-view', DEFAULT_VIEW);

// ---------------------------------------------------------------------------------------------
// Worker + shared memory
const sh = createShared();
const bridge = new WorkerBridge();
bridge.send({ type: 'init', sab: sh.sab, spec: spec0, settings: sim0 });

// Rendering
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.shadowMap.autoUpdate = false;
renderer.toneMapping = THREE.NoToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
appEl.append(renderer.domElement);

if (!hasMap(sim0.mapId)) sim0.mapId = 'field';
await preloadMap(sim0.mapId).catch((e) => { console.warn(e); sim0.mapId = 'field'; });
const map0 = MAPS[sim0.mapId]();
const build0 = buildDrone(spec0);
const makeDroneModel = (b: DroneBuild) => buildDroneMesh(b.spec, b.info, b.params.rotors.map((r) => ({ ...r.pos, dir: r.dir })), b.info.cgMm);

const logLines: string[] = [];
const ctx: AppCtx = {
  spec: spec0, sim: sim0, view: view0,
  build: build0, map: map0, world: new PrimitiveWorld(map0), scene: buildScene(map0), drone: makeDroneModel(build0),
  mountQ: cameraMountQuat(spec0.cameraUptiltDeg),
  sh, send: bridge.send, renderer,
  fpv: new FpvCamera(renderer, view0.cubeSize), osd: new OsdRenderer(), link: new VideoLink(), audio: new MotorAudio(),
  input: new InputManager(), mp: new MultiplayerClient(), remotes: new RemoteQuads(), blackbox: new Blackbox(),
  tel: null, fwStatus: 'Loading Betaflight firmware…', menuOpen: false,
  rec: new Float64Array(REC), pilot: { x: 0, y: 0, z: 1.6 },
  race: newRace(), drill: newDrill(), logLines, log: makeLog(logLines),
};
ctx.scene.scene.add(ctx.drone.root);
ctx.fpv.setVideo(ctx.build.info.components.video, ctx.view.renderScale);
void ctx.osd.setFont(ctx.view.osdFont);

const sticks = new SticksView(), spectrum = new SpectrumView();
bridge.onMessage = (m) => {
  switch (m.type) {
    case 'ready': ctx.fwStatus = ''; ctx.log(`Firmware running: ${m.fw}`); break;
    case 'fwMissing': ctx.fwStatus = m.reason; ctx.log(m.reason); break;
    case 'telemetry': ctx.tel = m.tel; break;
    case 'log': ctx.log(m.text); break;
    case 'gate': onGate(ctx, m.gate, m.t); break;
    case 'spectrum': spectrum.onSpectrum(m.spec); break;
  }
};

// ---------------------------------------------------------------------------------------------
// Settings changes
function sendReset(fullBattery = false) { ctx.input.disarm(); onRespawn(ctx); ctx.send({ type: 'reset', repair: true, fullBattery }); }

function applySpec(s: DroneSpec) {
  ctx.spec = s; store('fpv-spec', s);
  ctx.build = buildDrone(s);
  ctx.scene.scene.remove(ctx.drone.root); ctx.drone.dispose();
  ctx.drone = makeDroneModel(ctx.build); ctx.scene.scene.add(ctx.drone.root);
  ctx.fpv.setVideo(ctx.build.info.components.video, ctx.view.renderScale);
  ctx.mountQ = cameraMountQuat(s.cameraUptiltDeg);
  ctx.input.disarm();
  ctx.send({ type: 'spec', spec: s });
}

let applyingRoomMap = false;
function applySim(s: SimSettings, reloadMap = false) {
  const mapChanged = reloadMap || s.mapId !== ctx.sim.mapId;
  ctx.sim = s; store('fpv-sim-settings', s);
  // loading is async (Quake maps fetch their sources): remember now whether the room asked for it
  const fromRoom = applyingRoomMap;
  if (mapChanged) void preloadMap(s.mapId).then(() => {
    if (ctx.sim.mapId !== s.mapId) return; // superseded while loading
    ctx.scene.scene.remove(ctx.drone.root); ctx.scene.dispose();
    ctx.map = MAPS[s.mapId](); ctx.world = new PrimitiveWorld(ctx.map); ctx.scene = buildScene(ctx.map); ctx.scene.scene.add(ctx.drone.root);
    resetLaps(ctx);
    if (ctx.mp.connected && !fromRoom && !isLocalMap(s.mapId)) ctx.mp.sendMap(s.mapId); // the room flies one shared map
  }, (e) => ctx.log(`Map ${s.mapId} failed to load: ${e}`));
  ctx.send({ type: 'settings', settings: { ...s, paused: ctx.menuOpen } });
}

// maps loaded from disk: the worker needs them too; reloading the selected one rebuilds it
onLocalMap((id, info, urls) => {
  ctx.send({ type: 'registerMap', id, info, urls });
  if (ctx.sim.mapId === id) applySim(ctx.sim, true);
});

function applyView(v: ViewSettings) {
  const fontChanged = v.osdFont !== ctx.view.osdFont, scaleChanged = v.renderScale !== ctx.view.renderScale;
  ctx.view = v; store('fpv-view', v);
  if (fontChanged) void ctx.osd.setFont(v.osdFont);
  if (scaleChanged) ctx.fpv.setVideo(ctx.build.info.components.video, v.renderScale);
  ctx.audio.enabled = v.audio; ctx.audio.volume = v.volume;
}

// ---------------------------------------------------------------------------------------------
// Input: poll fast (250 Hz) for low latency, independent of the render rate
const input = ctx.input;
input.onReset = () => { onRespawn(ctx); ctx.send({ type: 'reset', repair: true }); };
input.onMenu = () => gameMenu.toggle();
input.onAction = (a) => simAction(a);
/** Shared by keyboard keys and controller buttons (B, D-pad). */
function simAction(a: SimAction) {
  if (a === 'camera') { const order: ViewSettings['view'][] = ['fpv', 'chase', 'los']; applyView({ ...ctx.view, view: order[(order.indexOf(ctx.view.view) + 1) % 3] }); }
  if (a === 'telemetry') applyView({ ...ctx.view, telemetry: !ctx.view.telemetry });
  if (a === 'drill') toggleDrill(ctx);
  if (a === 'battery') sendReset(true);
  if (a === 'spectrum') ctx.send({ type: 'spectrum', on: spectrum.toggle() });
}
setInterval(() => { const ch = input.poll(); sh.rc.set(ch); Atomics.add(sh.ctrl, 0, 1); }, 4);
window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
  if (ctx.menuOpen) return; // the menu handles its own keys
  if (e.code === 'Escape') gameMenu.toggle();
  if (e.code === 'KeyR') sendReset();
  const a = ({ KeyC: 'camera', KeyH: 'telemetry', KeyG: 'drill', KeyB: 'battery', KeyF: 'spectrum' } as Record<string, SimAction>)[e.code];
  if (a) simAction(a);
});
// Every page gesture (not just the first) unlocks / resumes audio: controller input can't, and the
// browser may suspend the context later (tab switch, audio device change).
for (const ev of ['pointerdown', 'keydown', 'touchstart'] as const) window.addEventListener(ev, () => ctx.audio.unlock(), { capture: true });

// ---------------------------------------------------------------------------------------------
// Live multiplayer: remote pilots' poses arrive through the room relay and are drawn in our scene.
ctx.mp.onMap = (m) => {
  if (!hasMap(m) || m === ctx.sim.mapId) return;
  applyingRoomMap = true;
  applySim({ ...ctx.sim, mapId: m });
  applyingRoomMap = false;
  ctx.log(`Room switched the map to ${MAPS[m]().name}`);
};
/** room: name / visibility, used if we are the first pilot in (the host) */
function joinRoom(code: string, room?: { name: string; public: boolean }) {
  const p = loadPilot();
  ctx.mp.join(code, { name: p.name, color: p.color, frame: ctx.build.info.components.frame.sizeClass, map: ctx.sim.mapId, room });
  history.replaceState(null, '', inviteLink(code));
}

// ---------------------------------------------------------------------------------------------
// HUD + menu (title screen, new game, server browser, settings, Betaflight guide, pause)
const hudCtl = new HudController(ctx, sticks, spectrum);
appEl.append(hudCtl.hud.root);

function blackboxPanel(): HTMLElement {
  const root = el('div', { class: 'panel' });
  const render = () => root.replaceChildren(el('section', { class: 'sec' }, el('h3', {}, 'Blackbox-lite recorder'),
    el('p', {}, `Records the 1 kHz true state, raw gyro, motor DShot outputs and RPM, battery and your RC sticks whenever the quad is armed (last 5 minutes kept). ${ctx.blackbox.length} samples recorded.`),
    el('div', { class: 'actions' }, el('button', { class: 'primary', onclick: () => ctx.blackbox.download() }, 'Download CSV'), el('button', { onclick: () => { ctx.blackbox.clear(); render(); } }, 'Clear'))));
  render();
  return root;
}
/** New game / respawn from the menu: repaired quad, fresh battery, the chosen mode. */
function startFlight(mode: GameMode) {
  toggleDrill(ctx, mode === 'drill');
  resetLaps(ctx);
  sendReset(true);
}
const gameMenu = new GameMenu({
  input, mp: ctx.mp,
  spec: () => ctx.spec, applySpec,
  sim: () => ctx.sim, applySim: (s) => applySim(s),
  build: () => ctx.build,
  fwStatus: () => ctx.fwStatus,
  settingsTabs: [
    { id: 'sim', label: 'Simulation', icon: 'sliders', render: () => settingsPanel(ctx.sim, ctx.view, applySim, applyView) },
    { id: 'controller', label: 'Controller', icon: 'gamepad', render: () => inputPanel(input) },
    { id: 'bf', label: 'Betaflight', icon: 'cpu', render: () => bfPanel(bridge, {
      hardwareCli: (keepOsdLayout, propsOut) => simHardwareCli(ctx.build, { keepOsdLayout, propsOut }),
      propsOut: () => ctx.spec.propDirection === 'props-out',
      setPropsOut: (out) => applySpec({ ...ctx.spec, propDirection: out ? 'props-out' : 'props-in' }),
    }) },
    { id: 'builder', label: 'Drone builder', icon: 'wrench', render: () => builderPanel(() => ctx.spec, (s) => { applySpec(s); gameMenu.resume(); }) },
    { id: 'mp', label: 'Multiplayer', icon: 'users', render: () => multiplayerPanel(ctx.mp, joinRoom) },
    { id: 'blackbox', label: 'Blackbox', icon: 'database', render: blackboxPanel },
  ],
  startFlight, joinRoom,
  onOpenChange: (open) => {
    ctx.menuOpen = open;
    input.suspended = open; // menu buttons must not arm / switch modes / respawn
    ctx.send({ type: 'settings', settings: { ...ctx.sim, paused: open } });
  },
});
appEl.append(gameMenu.root);

// ---------------------------------------------------------------------------------------------
startFrameLoop(ctx, { backdrop: () => gameMenu.backdrop, afterFrame: () => hudCtl.update() });

// invite links: ?room=CODE joins that room on load
{
  const code = new URLSearchParams(location.search).get('room')?.toUpperCase();
  if (code && /^[A-Z0-9]{4,8}$/.test(code)) joinRoom(code);
}
gameMenu.open('title');

// debugging handle (inspect from devtools)
(window as any).__fpv = {
  ctx, mp: ctx.mp, menu: gameMenu, hud: hudCtl.hud, input, link: ctx.link, sh: ctx.sh, R, REC, sampleRing, newestTime,
  teleport: (x: number, y: number, z: number, yawDeg = 0) => { onRespawn(ctx); ctx.send({ type: 'reset', repair: true, at: { x, y, z, yawDeg } }); },
  osdCells: () => hudCtl.osdCells(), frameRect: () => ctx.fpv.layout.frame,
  get scene() { return ctx.scene.scene; }, get tel() { return ctx.tel; }, get spectrum() { return spectrum.data; },
  cli: (lines: string[]) => bridge.cliBatch(lines),
};
