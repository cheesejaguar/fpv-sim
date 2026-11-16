// The bridge to a native host app (the Apple Vision Pro app in visionos/). The page keeps doing what
// it always does: Betaflight and the physics in the worker, menus, HUD, audio, laps. When the native
// app opens its immersive space it draws the world itself (RealityKit, stereo), and this module feeds
// it:
//   - the scene, as binary blobs (sceneExport.ts) POSTed to the app's loopback server whenever the
//     map, the time of day or the drone changes;
//   - the quad's state from the worker's ring at ~120 Hz (the native side extrapolates to its frame);
//   - what moves or changes look in the scene (props, gate highlights, actors): transforms,
//     visibility, tints;
//   - the Betaflight OSD picture and a few HUD numbers.
// And it takes from the app: the game controller (as a standard Gamepad the rest of the code already
// understands) and a few commands. While the native side draws, the WebGL passes are skipped
// (ctx.native.active, read by the frame loop).
//
// Without a host (any browser) installNativeHost returns null and nothing here runs.
import * as THREE from 'three';
import type { AppCtx } from '../app/context';
import { quatEnuToThree } from '../render/coords';
import { newestTime, R, REC, sampleRing } from '../worker/shared';
import { exportPart, materialSig, Part, partMeshes, shownInTree, texturePending, Tracked } from './sceneExport';

export interface NativeState {
  /** the native side is drawing the world: the page skips its own 3D passes */
  active: boolean;
}
export interface NativeDeps {
  respawn(): void;
  toggleMenu(): void;
}

interface Port { postMessage(m: unknown): void }
function findPort(): Port | null {
  const w = window as unknown as { webkit?: { messageHandlers?: Record<string, Port | undefined> }; __fpvNativeMock?: Port };
  return w.webkit?.messageHandlers?.fpvNative ?? w.__fpvNativeMock ?? null;
}
/** true inside the native app (also before installNativeHost ran) */
export const hasNativeHost = () => !!findPort();

const TICK_MS = 8;
const EPS = 1e-5;

/** A standard-mapping Gamepad fed by the native app's GameController framework. */
class NativePad {
  id = ''; index = 0; connected = false; mapping = 'standard'; timestamp = 0;
  axes: number[] = [0, 0, 0, 0];
  buttons: { pressed: boolean; touched: boolean; value: number }[] = Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 }));
  vibrationActuator = null;
  hapticActuators: unknown[] = [];
}

export function installNativeHost(ctx: AppCtx, deps: NativeDeps): NativeState | null {
  const port = findPort();
  if (!port) return null;
  const state: NativeState = { active: false };
  const post = (m: unknown) => { try { port.postMessage(m); } catch (e) { console.warn('native host', e); } };

  // ---- game controller: the app's pad replaces navigator.getGamepads() while one is connected ----
  const pad = new NativePad();
  const realPads = navigator.getGamepads?.bind(navigator);
  Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => (pad.connected ? [pad] : realPads?.() ?? []) });
  const padEvent = (type: string) => window.dispatchEvent(Object.assign(new Event(type), { gamepad: pad }));

  // ---- scene export: again whenever what is drawn changed and has settled ----
  const ids = new WeakMap<object, number>(); let nextObj = 1;
  const idOf = (o: object) => { let i = ids.get(o); if (!i) ids.set(o, (i = nextObj++)); return i; };
  const sigOf = (part: Part): string => {
    const list = partMeshes(ctx, part);
    let pending = 0, geo = 0;
    for (const m of list) {
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) { const t = (mat as THREE.MeshStandardMaterial).map; if (t && texturePending(t)) pending++; }
      // (terrain tiles swap LOD geometry while the web renderer draws: not a change of the scene)
      if (!m.userData.levels) geo = (geo * 31 + idOf(m.geometry)) | 0;
    }
    return part === 'world'
      ? `${idOf(ctx.scene)}|${list.length}|${pending}|${geo}`
      : `${idOf(ctx.drone)}|${list.length}|${pending}|${geo}|${ctx.mountQ.toArray().map((x) => x.toFixed(4)).join(',')}`;
  };
  interface PartState { sent: string; seen: string; since: number; busy: boolean; seq: number; tracked: Tracked[] }
  const parts: Record<Part, PartState> = {
    world: { sent: '', seen: '', since: 0, busy: false, seq: 0, tracked: [] },
    drone: { sent: '', seen: '', since: 0, busy: false, seq: 0, tracked: [] },
  };
  let exportSeq = 0;
  const SETTLE_MS = 350;
  async function sendPart(part: Part, sig: string) {
    const ps = parts[part];
    ps.busy = true;
    try {
      const seq = ++exportSeq;
      const { blob, json, tracked } = await exportPart(ctx, part, seq);
      const r = await fetch(`/__native/scene?part=${part}&seq=${seq}`, { method: 'POST', body: blob, headers: { 'Content-Type': 'application/octet-stream' } });
      if (!r.ok) throw new Error(`scene upload: HTTP ${r.status}`);
      ps.sent = sig; ps.seq = seq; ps.tracked = tracked;
      post({ k: 'scene', part, seq, bytes: blob.size, meshes: json.meshes.length });
    } catch (e) {
      console.warn('native scene export', e);
      ps.since = performance.now() + 2000; // try again in a while
    } finally { ps.busy = false; }
  }
  function watchScene() {
    const now = performance.now();
    for (const part of ['world', 'drone'] as const) {
      const ps = parts[part];
      if (ps.busy) continue;
      const sig = sigOf(part);
      if (sig !== ps.seen) { ps.seen = sig; ps.since = now; continue; }
      if (sig !== ps.sent && now - ps.since >= SETTLE_MS) void sendPart(part, sig);
    }
  }
  setInterval(watchScene, 150);

  // ---- per-tick state ----
  const rec = new Float64Array(REC), q = new THREE.Quaternion(), inv = new THREE.Matrix4(), rel = new THREE.Matrix4();
  let tick = 0, lastT = NaN, lastSent = 0, lastOsd: string | null = null, lastHud = '';
  const r3 = (x: number) => Math.round(x * 1e4) / 1e4;

  function sendState(now: number) {
    const rp = ctx.replay;
    const ok = rp ? rp.sample(rp.time, rec) : sampleRing(ctx.sh, newestTime(ctx.sh), rec);
    if (!ok) return;
    if (rec[R.t] === lastT && now - lastSent < 250) return; // paused: a trickle keeps the native side current
    lastT = rec[R.t]; lastSent = now;
    quatEnuToThree(rec[R.qw], rec[R.qx], rec[R.qy], rec[R.qz], q);
    post({ k: 's', a: [
      performance.timeOrigin + now, rec[R.t],
      rec[R.px], rec[R.pz], -rec[R.py],
      q.x, q.y, q.z, q.w,
      rec[R.vx], rec[R.vz], -rec[R.vy],
      // body rates in the three-mapped body axes (as the frame loop's lens extrapolation)
      rec[R.wx], rec[R.wz], -rec[R.wy],
      rec[R.rpm0], rec[R.rpm1], rec[R.rpm2], rec[R.rpm3],
      rec[R.armed] > 0.5 ? 1 : 0, rp ? 1 : 0,
    ] });
  }

  /** transforms and visibility of what moved since the last call */
  function sendMoves() {
    ctx.scene.scene.updateMatrixWorld();
    for (const part of ['world', 'drone'] as const) {
      const ps = parts[part];
      if (!ps.seq || ps.busy) continue;
      if (part === 'drone') inv.copy(ctx.drone.root.matrixWorld).invert();
      const n: unknown[] = [];
      for (const t of ps.tracked) {
        const e = part === 'drone' ? rel.multiplyMatrices(inv, t.obj.matrixWorld).elements : t.obj.matrixWorld.elements;
        let moved = false;
        for (let i = 0; i < 16; i++) if (Math.abs(e[i] - t.m[i]) > EPS) { moved = true; break; }
        const vis = shownInTree(t.obj);
        if (!moved && vis === t.visible) continue;
        t.visible = vis;
        if (moved) { for (let i = 0; i < 16; i++) t.m[i] = e[i]; n.push([t.id, vis ? 1 : 0, Array.from(t.m, r3)]); }
        else n.push([t.id, vis ? 1 : 0]);
      }
      if (n.length) post({ k: 'd', part, seq: ps.seq, n });
    }
  }
  /** tints: colour, opacity, emissive of materials that changed (gate highlights, prop discs) */
  function sendLooks() {
    for (const part of ['world', 'drone'] as const) {
      const ps = parts[part];
      if (!ps.seq || ps.busy) continue;
      const n: unknown[] = [];
      for (const t of ps.tracked) {
        const sig = materialSig(t.mat);
        if (sig === t.sig) continue;
        t.sig = sig;
        const [col, op, em] = sig.split('|');
        n.push([t.id, col ? col.split(',').map(Number) : null, Number(op) / 50, em ? em.split(',').map(Number) : null]);
      }
      if (n.length) post({ k: 'm', part, seq: ps.seq, n });
    }
  }
  function sendOsd(now: number) {
    ctx.osd.update(ctx.replay ? ctx.replay.osd : ctx.sh, now);
    const on = ctx.view.osd && ctx.osd.hasContent;
    const png = on ? ctx.osd.canvas.toDataURL('image/png') : '';
    if (png === lastOsd) return;
    lastOsd = png;
    post({ k: 'osd', on, png: png.slice(png.indexOf(',') + 1), cols: ctx.osd.cols, rows: ctx.osd.rows });
  }
  function sendHud() {
    const race = ctx.race;
    const hud = {
      k: 'hud', map: ctx.map.name, menu: ctx.menuOpen, fw: ctx.fwStatus,
      armed: rec[R.armed] > 0.5, volts: Math.round(rec[R.vbus] * 100) / 100,
      laps: race.lapCount, last: Math.round(race.lastLap * 1000) / 1000, best: Number.isFinite(race.bestLap) ? Math.round(race.bestLap * 1000) / 1000 : 0,
      lap: race.lapStart >= 0 ? Math.round((rec[R.t] - race.lapStart) * 10) / 10 : -1,
      gate: race.nextGate, gates: ctx.map.gates.length,
    };
    const s = JSON.stringify(hud);
    if (s === lastHud) return;
    lastHud = s;
    post(hud);
  }

  let timer: ReturnType<typeof setInterval> | undefined;
  const onTick = () => {
    const now = performance.now();
    tick++;
    sendState(now);
    if (tick % 2 === 0) sendMoves();
    if (tick % 8 === 1) sendLooks();
    if (tick % 12 === 3) sendOsd(now);
    if (tick % 25 === 5) sendHud();
  };

  // a note over the (frozen) picture while the native side draws
  const note = document.createElement('div');
  note.textContent = 'Flying in the immersive view';
  note.style.cssText = 'position:fixed;left:50%;top:18px;transform:translateX(-50%);z-index:50;padding:8px 16px;border-radius:999px;background:rgba(15,15,35,.82);color:#e2e8f0;font:600 14px system-ui,sans-serif;pointer-events:none;display:none';
  document.body.append(note);

  const api = {
    /** The immersive space opened (the native side draws) or closed (the page draws again). */
    setImmersive(on: boolean) {
      if (on === state.active) return;
      state.active = on;
      note.style.display = on ? 'block' : 'none';
      clearInterval(timer); timer = undefined;
      if (on) {
        lastT = NaN; lastOsd = null; lastHud = '';
        // everything the native side tracks is sent afresh: it may have missed changes while closed
        for (const ps of Object.values(parts)) for (const t of ps.tracked) { t.m.fill(NaN); t.sig = ''; }
        timer = setInterval(onTick, TICK_MS);
      }
      window.dispatchEvent(new Event('resize')); // (the frame loop redraws its own picture when it is back)
    },
    /** Send both scene parts again (the native side started over). */
    requestScene() { for (const ps of Object.values(parts)) { ps.sent = ''; ps.since = 0; } },
    /** Controller state: id, axes [lx, ly, rx, ry] (y down, as the Gamepad API), 17 standard button values. */
    pad(id: string, axes: number[], buttons: number[]) {
      const fresh = !pad.connected || pad.id !== id;
      if (fresh && pad.connected) { pad.connected = false; padEvent('gamepaddisconnected'); }
      pad.id = id; pad.connected = true; pad.timestamp = performance.now();
      for (let i = 0; i < 4; i++) pad.axes[i] = axes[i] ?? 0;
      for (let i = 0; i < 17; i++) { const v = buttons[i] ?? 0, b = pad.buttons[i]; b.value = v; b.pressed = v > 0.5; b.touched = v > 0; }
      if (fresh) padEvent('gamepadconnected');
    },
    padGone() { if (pad.connected) { pad.connected = false; padEvent('gamepaddisconnected'); } },
    respawn() { deps.respawn(); },
    toggleMenu() { deps.toggleMenu(); },
  };
  (window as unknown as { __fpvNative: typeof api }).__fpvNative = api;
  post({ k: 'ready', v: 1 });
  return state;
}
