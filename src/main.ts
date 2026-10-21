// Composition root: loads settings, starts the sim worker, builds the world and the services, wires
// input, multiplayer, the menu and the HUD, then runs the frame loop. The pieces live in src/app/.
// boot comes first: it checks the browser and turns errors thrown before the menu is up into a page.
import { bootDone, onBeforeReset, showFatal } from './app/boot';
import * as THREE from 'three';
import './style.css';
import { WorkerBridge } from './app/bridge';
import { AppCtx, makeLog } from './app/context';
import { initDvr } from './app/dvr';
import { startFrameLoop } from './app/frameLoop';
import { HudController } from './app/hudController';
import { SpectrumView, SticksView } from './app/instruments';
import { courseOf, LapBoard } from './app/leaderboard';
import { KEYS, load, save, validSim, validSpec, validView } from './app/persist';
import { newDrill, newRace, onGate, onRespawn, resetLaps, toggleDrill } from './app/race';
import { LapRecorder } from './app/replayRecorder';
import { simHardwareCli } from './bf/defaults';
import { buildDrone, DroneBuild, DroneSpec } from './builder/derive';
import { droneClass } from './builder/droneClass';
import { InputManager, SimAction } from './input/gamepad';
import { isLocalMap, onLocalMap } from './maps/localMaps';
import { hasMap, MAP_LIST, MAPS, preloadMap } from './maps/maps';
import { PrimitiveWorld, withCourse } from './maps/world';
import { MultiplayerClient } from './net/multiplayer';
import { MotorAudio } from './render/audio';
import { cameraMountQuat } from './render/coords';
import { buildDroneMesh } from './render/droneMesh';
import { FpvCamera } from './render/fpvCamera';
import { OsdRenderer } from './render/osdRenderer';
import { RemoteQuads } from './render/remoteQuads';
import { buildScene } from './render/scene';
import { VideoLink } from './render/videoLink';
import { PbShots } from './share/capture';
import { bfPanel } from './ui/bfPanel';
import { Blackbox } from './ui/blackbox';
import { builderPanel } from './ui/builderPanel';
import { el } from './ui/dom';
import { inputPanel } from './ui/inputPanel';
import { EASY_SPEC, GameMenu, GameMode } from './ui/menu/gameMenu';
import { inviteLink, loadPilot, multiplayerPanel } from './ui/multiplayerPanel';
import { settingsPanel, ViewSettings } from './ui/settingsPanel';
import { createShared, newestTime, R, REC, sampleRing, SimSettings } from './worker/shared';

// debugging handle window.__fpv (installed at the end): in dev builds, with ?debug in the URL, or
// after localStorage.setItem('fpv-debug', '1'). Read now: joining an invite link rewrites the URL.
const debug = import.meta.env.DEV || new URLSearchParams(location.search).has('debug') || (() => { try { return localStorage.getItem('fpv-debug') === '1'; } catch { return false; } })();

// ---------------------------------------------------------------------------------------------
// saved settings are versioned and validated (src/app/persist.ts)
const store = (k: string, v: unknown) => save(k, v);

const appEl = document.getElementById('app')!;

// first run starts on the easiest quad (65 mm tiny whoop); after that, whatever the pilot flew last
// (a saved build with parts this version doesn't have falls back to the whoop too)
const spec0: DroneSpec = load(KEYS.spec, (r) => validSpec(r, EASY_SPEC));
const sim0: SimSettings = load(KEYS.sim, validSim);
const view0: ViewSettings = load(KEYS.view, validView);

// ---------------------------------------------------------------------------------------------
// Worker + shared memory
const sh = createShared();
const bridge = new WorkerBridge();
onBeforeReset(() => bridge.worker.terminate()); // it holds the EEPROM database open
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
// GPU reset, driver update, sleep / wake, too many GPU tabs: the scene can't be trusted after this
renderer.domElement.addEventListener('webglcontextlost', () => {
  showFatal({
    title: 'Graphics stopped',
    lead: 'The browser lost the 3D graphics context. This can happen after a graphics driver update or reset, when the computer wakes from sleep, or when many tabs use the GPU. Reload to continue: your settings are kept.',
    report: 'WebGL context lost',
  });
  try { if (!ctx.menuOpen) gameMenu.open(); } catch { /* still starting up */ } // pause: a flying quad would crash meanwhile
});

if (!hasMap(sim0.mapId)) sim0.mapId = 'field';
await preloadMap(sim0.mapId).catch((e) => { console.warn(e); sim0.mapId = 'field'; });
const map0 = withCourse(MAPS[sim0.mapId](), sim0.courseId);
const build0 = buildDrone(spec0);
const makeDroneModel = (b: DroneBuild) => buildDroneMesh(b.spec, b.info, b.params.rotors.map((r) => ({ ...r.pos, dir: r.dir })), b.info.cgMm);

const logLines: string[] = [];
const ctx: AppCtx = {
  spec: spec0, sim: sim0, view: view0,
  build: build0, map: map0, world: new PrimitiveWorld(map0), scene: buildScene(map0, { timeOfDay: view0.timeOfDay }), drone: makeDroneModel(build0),
  mountQ: cameraMountQuat(spec0.cameraUptiltDeg),
  sh, send: bridge.send, renderer,
  fpv: new FpvCamera(renderer, view0.cubeSize), osd: new OsdRenderer(), link: new VideoLink(), audio: new MotorAudio(),
  input: new InputManager(), mp: new MultiplayerClient(), remotes: new RemoteQuads(), blackbox: new Blackbox(),
  tel: null, fwStatus: 'Loading Betaflight firmware…', menuOpen: false,
  rec: new Float64Array(REC), pilot: { x: 0, y: 0, z: 1.6 },
  race: newRace(), drill: newDrill(), lb: new LapBoard(), replays: new LapRecorder(), replay: null, logLines, log: makeLog(logLines),
};
ctx.scene.scene.add(ctx.drone.root);
ctx.fpv.setVideo(ctx.build.info.components.video, ctx.view.renderScale);
void ctx.osd.setFont(ctx.view.osdFont);

const sticks = new SticksView(), spectrum = new SpectrumView();
bridge.onMessage = (m) => {
  switch (m.type) {
    case 'ready': ctx.fwStatus = ''; ctx.log(`Firmware running: ${m.fw}`); break;
    case 'fwMissing': ctx.fwStatus = m.reason; ctx.log(m.reason); break;
    case 'fatal': {
      // the bridge already restarted the worker once: a second failure needs a reload
      ctx.fwStatus = `The simulator stopped: ${m.reason} — reload the page`; ctx.log(ctx.fwStatus);
      showFatal({
        title: 'The simulator stopped',
        lead: 'The flight simulation (Betaflight and the physics) stopped and could not be restarted. Reload to continue: your settings and your Betaflight configuration are kept.',
        detail: m.reason,
        report: `Simulator worker failed: ${m.reason}`,
      });
      break;
    }
    case 'telemetry': ctx.tel = m.tel; break;
    case 'log': ctx.log(m.text); break;
    case 'gate': onGate(ctx, m.gate, m.t); break;
    case 'spectrum': spectrum.onSpectrum(m.spec); break;
    case 'mapLoaded': onWorkerMap(m.id, m.requested, m.ok, m.error); break;
    case 'overload': {
      // the worker already flies at the lower rate: settings follow, so later messages don't undo it
      ctx.sim = { ...ctx.sim, physicsHz: m.physicsHz }; store(KEYS.sim, ctx.sim);
      ctx.log(`This computer can't run the simulation in real time (${Math.round(m.simRate * 100)} %): physics rate lowered to ${m.physicsHz} Hz`);
      break;
    }
  }
};

// ---------------------------------------------------------------------------------------------
// Settings changes
function sendReset(fullBattery = false) { ctx.input.disarm(); onRespawn(ctx); ctx.send({ type: 'reset', repair: true, fullBattery }); }

function applySpec(s: DroneSpec) {
  ctx.replay?.close(); // a replay on screen puts the live quad back first
  ctx.spec = s; store(KEYS.spec, s);
  ctx.build = buildDrone(s);
  ctx.scene.scene.remove(ctx.drone.root); ctx.drone.dispose();
  ctx.drone = makeDroneModel(ctx.build); ctx.scene.scene.add(ctx.drone.root);
  ctx.fpv.setVideo(ctx.build.info.components.video, ctx.view.renderScale);
  ctx.mountQ = cameraMountQuat(s.cameraUptiltDeg);
  ctx.input.disarm();
  ctx.send({ type: 'spec', spec: s });
}

let applyingRoomMap = false;
/** Rebuild the rendered scene of the current map (new map, or the time of day changed). */
function rebuildScene() {
  ctx.replay?.close();
  ctx.scene.scene.remove(ctx.drone.root); ctx.scene.dispose();
  ctx.scene = buildScene(ctx.map, { timeOfDay: ctx.view.timeOfDay }); ctx.scene.scene.add(ctx.drone.root);
}
/** Rebuild the rendered world for a map that is loaded (preloaded or built in). */
function showMap(id: string) {
  ctx.map = withCourse(MAPS[id](), ctx.sim.courseId); ctx.world = new PrimitiveWorld(ctx.map);
  rebuildScene();
  resetLaps(ctx);
}
function applySim(s: SimSettings, reloadMap = false) {
  const shown = ctx.map.id; // what is on screen (and what the physics flew so far)
  const mapChanged = reloadMap || s.mapId !== ctx.sim.mapId || (s.courseId ?? '') !== (ctx.sim.courseId ?? '');
  ctx.sim = s; store(KEYS.sim, s);
  // loading is async (Quake maps fetch their sources): remember now whether the room asked for it
  const fromRoom = applyingRoomMap;
  if (mapChanged) void preloadMap(s.mapId).then(() => {
    if (ctx.sim.mapId !== s.mapId) return; // superseded while loading
    showMap(s.mapId);
    if (ctx.mp.connected && !fromRoom && !isLocalMap(s.mapId)) ctx.mp.sendMap(s.mapId); // the room flies one shared map
  }, (e) => {
    if (ctx.sim.mapId !== s.mapId) return;
    // physics and render must never disagree: stay on the map on screen and send the worker back to it
    ctx.log(`Map ${s.mapId} failed to load (${(e as Error)?.message ?? e}); staying on ${ctx.map.name}`);
    ctx.sim = { ...ctx.sim, mapId: hasMap(shown) ? shown : 'field' }; store(KEYS.sim, ctx.sim);
    if (ctx.sim.mapId !== ctx.map.id) showMap(ctx.sim.mapId);
    ctx.send({ type: 'settings', settings: { ...ctx.sim, paused: ctx.menuOpen } });
  });
  ctx.send({ type: 'settings', settings: { ...s, paused: ctx.menuOpen } });
}
/** The worker reports which map its physics actually loaded: the renderer follows its fallback. */
function onWorkerMap(id: string, requested: string, ok: boolean, error?: string) {
  if (id === ctx.sim.mapId) return; // physics flies what we show (or are about to)
  if (!ok && requested === ctx.sim.mapId) {
    ctx.sim = { ...ctx.sim, mapId: id }; store(KEYS.sim, ctx.sim);
    void preloadMap(id).then(() => {
      if (ctx.sim.mapId !== id) return;
      showMap(id);
      ctx.log(`Map ${requested} failed to load in the simulator${error ? ` (${error})` : ''}; flying ${ctx.map.name} instead`);
    }, (e) => ctx.log(`Map ${id} failed to load: ${e}`));
    return;
  }
  // the worker flies a map we don't show (an older request, or our own fallback at start-up): resync
  ctx.send({ type: 'settings', settings: { ...ctx.sim, paused: ctx.menuOpen } });
}

// maps loaded from disk: the worker needs them too; reloading the selected one rebuilds it
onLocalMap((id, info, urls) => {
  ctx.send({ type: 'registerMap', id, info, urls });
  if (ctx.sim.mapId === id) applySim(ctx.sim, true);
});

function applyView(v: ViewSettings) {
  const fontChanged = v.osdFont !== ctx.view.osdFont, scaleChanged = v.renderScale !== ctx.view.renderScale, todChanged = v.timeOfDay !== ctx.view.timeOfDay;
  ctx.view = v; store(KEYS.view, v);
  if (todChanged) rebuildScene();
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
  if (a === 'drill') { toggleDrill(ctx); gameMenu.activeMode = ctx.drill.on ? 'drill' : gameMenu.activeMode === 'drill' ? 'free' : gameMenu.activeMode; } // the pause menu's Respawn keeps it
  if (a === 'battery') sendReset(true);
  if (a === 'spectrum') ctx.send({ type: 'spectrum', on: spectrum.toggle() });
}
WorkerBridge.pollSticks(sh, () => input.poll(), () => input.active); // ~1 kHz, timestamped samples into the shared stick ring
window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
  if (ctx.menuOpen) return; // the menu handles its own keys
  if (e.code === 'Escape') gameMenu.toggle();
  if (e.code === 'KeyR') sendReset();
  if (e.code === 'KeyL' && !Atomics.load(ctx.sh.ctrl, 5)) gameMenu.openInitials(); // post a new personal best (disarmed)
  const a = ({ KeyC: 'camera', KeyH: 'telemetry', KeyG: 'drill', KeyB: 'battery', KeyF: 'spectrum' } as Record<string, SimAction>)[e.code];
  if (a) simAction(a);
});
// Every page gesture (not just the first) unlocks / resumes audio: controller input can't, and the
// browser may suspend the context later (tab switch, audio device change).
for (const ev of ['pointerdown', 'keydown', 'touchstart'] as const) window.addEventListener(ev, () => ctx.audio.unlock(), { capture: true });
// Tab hidden while flying: pause (the sim keeps running in its worker otherwise) and silence the
// motors. Coming back stays paused on the pause menu; sound resumes with the next click or key.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) return;
  if (!ctx.menuOpen) { gameMenu.inFlight = true; gameMenu.open('pause'); }
  ctx.audio.update([0, 0, 0, 0], 0, 2, 14); // no frames run while hidden: ramp the motor voices down now
});

// ---------------------------------------------------------------------------------------------
// Live multiplayer: remote pilots' poses arrive through the room relay and are drawn in our scene.
ctx.mp.onMap = (m) => {
  if (!hasMap(m) || m === ctx.sim.mapId) return;
  applyingRoomMap = true;
  applySim({ ...ctx.sim, mapId: m, courseId: '' }); // the room shares the map; everyone flies its default course
  applyingRoomMap = false;
  ctx.log(`Room switched the map to ${MAP_LIST[m]?.name ?? m}`);
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
hudCtl.hud.onMenuTap = () => gameMenu.toggle(); // the Esc key hint is a button on touch screens
hudCtl.onPostLap = () => gameMenu.openInitials();
hudCtl.onShareLap = () => { const p = ctx.lb.pending; if (p) gameMenu.openShare({ map: p.map, course: p.course, cls: p.cls }); };
appEl.append(hudCtl.hud.root);
// the view at each new personal best (share cards), and the newest best of this session
const shots = new PbShots(ctx);

function blackboxPanel(): HTMLElement {
  const root = el('div', { class: 'panel' });
  const bblStatus = el('p', { class: 'note' }, '');
  // Betaflight's own log from its serial blackbox port: a real .bbl for Blackbox Explorer / PIDtoolbox
  const downloadBbl = async () => {
    bblStatus.textContent = 'Collecting the Betaflight log…';
    const { data, sessions } = await bridge.getBbl();
    if (!data.byteLength) { bblStatus.textContent = 'No Betaflight log yet: it records from arming to disarming.'; return; }
    const a = el('a', { href: URL.createObjectURL(new Blob([data], { type: 'application/octet-stream' })), download: `fpv-sim-${new Date().toISOString().replace(/[:.]/g, '-')}.bbl` }) as HTMLAnchorElement;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    bblStatus.textContent = `Downloaded ${sessions} flight${sessions === 1 ? '' : 's'} (${(data.byteLength / 1048576).toFixed(1)} MB).`;
  };
  const render = () => root.replaceChildren(el('section', { class: 'sec' }, el('h3', {}, 'Blackbox-lite recorder'),
    el('p', {}, `Records the 1 kHz true state, raw gyro, motor DShot outputs and RPM, battery and your RC sticks whenever the quad is armed (the last ${Math.round(ctx.blackbox.seconds / 60)} minutes are kept). ${ctx.blackbox.length} samples recorded.`),
    el('div', { class: 'actions' }, el('button', { class: 'primary', onclick: () => ctx.blackbox.download() }, 'Download CSV'), el('button', { onclick: () => { ctx.blackbox.clear(); render(); } }, 'Clear'))),
  el('section', { class: 'sec' }, el('h3', {}, 'Betaflight blackbox (.bbl)'),
    el('p', {}, 'Betaflight logs every armed flight itself at 2 kHz (blackbox on a serial port, as with an OpenLog): gyro raw and filtered, PID terms, setpoints, RC, motors, eRPM, battery. Opens in Blackbox Explorer and PIDtoolbox like a log from a real quad. The newest 32 MB are kept.'),
    el('div', { class: 'actions' }, el('button', { class: 'primary', onclick: () => void downloadBbl() }, 'Download .bbl'), el('button', { onclick: () => { bridge.clearBbl(); bblStatus.textContent = 'Betaflight log cleared.'; } }, 'Clear')),
    bblStatus));
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
    { id: 'sim', label: 'Simulation', icon: 'sliders', render: () => settingsPanel(ctx.sim, ctx.view, applySim, applyView, {
      video: () => ctx.build.info.components.video,
      effectiveLatencyMs: () => (ctx.fpv as { effectiveLatencyMs?: number }).effectiveLatencyMs,
    }) },
    { id: 'controller', label: 'Controller', icon: 'gamepad', render: () => inputPanel(input) },
    { id: 'bf', label: 'Betaflight', icon: 'cpu', render: () => bfPanel(bridge, {
      hardwareCli: (keepOsdLayout, propsOut) => simHardwareCli(ctx.build, { keepOsdLayout, propsOut }),
      propsOut: () => ctx.spec.propDirection === 'props-out',
      setPropsOut: (out) => applySpec({ ...ctx.spec, propDirection: out ? 'props-out' : 'props-in' }),
      factoryReset: () => ctx.send({ type: 'factoryReset' }),
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
  board: ctx.lb,
  track: () => ({ map: ctx.map.id, course: courseOf(ctx.map), cls: droneClass(ctx.spec) }),
  lastLap: () => { const l = ctx.replays.last; return l ? { lapMs: l.lap.meta.lapMs, replay: l.replay } : null; },
  // the replay player (and its scene swap) load the first time a replay is opened
  watch: async (bytes, label, ui) => (await import('./ui/replay/player')).openPlayer(ctx, bytes, label, ui),
  shots,
});
appEl.append(gameMenu.root);

// ---------------------------------------------------------------------------------------------
startFrameLoop(ctx, { backdrop: () => gameMenu.backdrop, afterFrame: () => { hudCtl.update(); shots.afterFrame(); } });
initDvr(ctx); // V records the goggle feed (picture + sound) to a .webm

// invite links: ?room=CODE joins that room on load
{
  const code = new URLSearchParams(location.search).get('room')?.toUpperCase();
  if (code && /^[A-Z0-9]{4,8}$/.test(code)) joinRoom(code);
}
gameMenu.open('title');
bootDone();

// debugging handle (inspect from devtools), see `debug` above
if (debug) (window as any).__fpv = {
  ctx, mp: ctx.mp, menu: gameMenu, hud: hudCtl.hud, input, link: ctx.link, sh: ctx.sh, R, REC, sampleRing, newestTime, replays: ctx.replays, shots,
  teleport: (x: number, y: number, z: number, yawDeg = 0) => { onRespawn(ctx); ctx.send({ type: 'reset', repair: true, at: { x, y, z, yawDeg } }); },
  osdCells: () => hudCtl.osdCells(), frameRect: () => ctx.fpv.layout.frame,
  get scene() { return ctx.scene.scene; }, get tel() { return ctx.tel; }, get spectrum() { return spectrum.data; },
  cli: (lines: string[]) => bridge.cliBatch(lines),
};
