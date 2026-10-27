// The render loop: emulated glass-to-glass latency and camera cadence, the FPV capture (cubemap +
// fisheye + link artefacts + OSD), the title-screen orbit, spectator views, multiplayer poses, audio.
// The quad's state comes from the worker's ring, or from a lap replay while one is watched
// (ctx.replay: no latency, its own clock, an orbit camera besides the pilot's views).
import * as THREE from 'three';
import { pilotPos, spawnGroundZ } from '../maps/world';
import { enuToThree, quatEnuToThree } from '../render/coords';
import { cameraMountZ } from '../render/droneMesh';
import { autoCubeSize, bladeSolidity, mountVibration, propLook, SHUTTER_MAX } from '../render/fpvCamera';
import { GoggleOverlay } from '../render/osdRenderer';
import type { RemoteSound } from '../render/audio';
import { TAG_LAYER } from '../render/remoteQuads';
import { newestTime, R, REC, sampleRing } from '../worker/shared';
import type { AppCtx } from './context';
import { dvrState } from './dvr';
import { PRE_S } from './replayRecorder';

export interface FrameLoopDeps {
  /** true while the title screen wants the orbiting quad behind it */
  backdrop(): boolean;
  /** HUD update, after the frame is drawn */
  afterFrame(): void;
  /** true while a menu screen covers the view (the picture behind it is dimmed): the title orbit
   *  and the spectator views are then redrawn at ~10 Hz only */
  dimmed?(): boolean;
}

/** Minimum interval (ms) between redraws of the title orbit (~60 fps; with a 2 ms tolerance so a
 *  60 Hz display still draws every frame) and of any backdrop behind a menu screen (~10 Hz). */
const TITLE_MS = 1000 / 60, DIMMED_MS = 100;
const Y_UP = new THREE.Vector3(0, 1, 0);
const _euler = new THREE.Euler();

// The browser + monitor pipeline (rAF -> compositor -> scan-out) already adds ~1.5 frames plus the
// panel's response; measure the frame interval and subtract that from the emulated video latency.
class DisplayLatency {
  private frameMs = 16.7; private last = 0;
  comp(now: number, auto: boolean, manualMs: number): number {
    if (this.last) { const d = now - this.last; if (d > 2 && d < 100) this.frameMs += (d - this.frameMs) * 0.05; }
    this.last = now;
    return auto ? Math.min(50, 1.5 * this.frameMs + 6) : manualMs;
  }
}

// Sky ambient in the camera: rays from the lens find how much open sky surrounds it, so a bando's
// interior is lit by its windows and the sun patches, not by a full outdoor sky (real interiors are
// ~1-5 % of outdoor ambient). Smoothed so passing a doorway doesn't pop.
const SKY_DIRS = [[0, 0, 1], [0.6, 0, 0.8], [-0.6, 0, 0.8], [0, 0.6, 0.8], [0, -0.6, 0.8], [0.85, 0.3, 0.42], [-0.85, -0.3, 0.42], [0.3, -0.85, 0.42], [-0.3, 0.85, 0.42]];

/** Ring marker for the line-of-sight view: a far-off whoop is a pixel or two even when zoomed. */
function losMarker(): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  g.lineWidth = 7; g.strokeStyle = 'rgba(0,0,0,0.55)'; g.beginPath(); g.arc(32, 32, 25, 0, Math.PI * 2); g.stroke();
  g.lineWidth = 3; g.strokeStyle = '#ffffff'; g.beginPath(); g.arc(32, 32, 25, 0, Math.PI * 2); g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, sizeAttenuation: false, depthTest: false, depthWrite: false, transparent: true }));
  s.renderOrder = 10; s.visible = false;
  return s;
}

export function startFrameLoop(ctx: AppCtx, deps: FrameLoopDeps) {
  const { renderer, sh, pilot } = ctx;
  const tmpQ = new THREE.Quaternion(), tmpV = new THREE.Vector3(), lensPos = new THREE.Vector3(), lensQ = new THREE.Quaternion();
  const mpRec = new Float64Array(REC), motionRec = new Float64Array(REC);
  // the state being drawn: the ring (into ctx.rec, which the HUD shares), or a replay (its own record)
  const replayRec = new Float64Array(REC);
  const ringState = (t: number, o: Float64Array) => sampleRing(sh, t, o);
  const replayState = (t: number, o: Float64Array) => ctx.replay?.sample(t, o) ?? false;
  let rec = ctx.rec, stateAt = ringState, lastSeq = -1, wasReplay = false;
  const display = new DisplayLatency();
  const gog = new GoggleOverlay();
  let lastCap = -1, lastCapWall = performance.now(), jitter = 0, lastNow = performance.now();
  let lastShadowAt = 0, brownoutUntil = -1e9;
  let skyOpen = 1, skyTimer = 0;
  // presenting the FPV picture only when something in it changed (see below)
  let presentDue = true, lastMode = '', lastGog = true;
  // title orbit / spectator views behind a menu: drawn at a capped rate (see TITLE_MS)
  let backdropDue = 0, lastViewAt = performance.now();
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const backdropReady = (now: number, minMs: number) => {
    if (!presentDue && now < backdropDue - 2) return false;
    backdropDue = Math.max(backdropDue + minMs, now - minMs);
    presentDue = false;
    return true;
  };
  // scratch for the per-frame / per-capture state (no allocations in the loop)
  const rpmNow = [0, 0, 0, 0], vib = { amp: [0, 0, 0, 0], freq: [0, 0, 0, 0] };
  let motionT = 0, motionHead = 0;
  const motionAt = (t: number, q: THREE.Quaternion) => lensAt(motionT + t, motionHead, q);
  const drillMesh = new THREE.Mesh(new THREE.SphereGeometry(1.5, 32, 16), new THREE.MeshBasicMaterial({ color: 0x39b6ff, transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide }));
  const marker = losMarker();
  const chaseCam = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.05, 3000);
  // title-screen backdrop: a slow orbit around the quad sitting on the pad
  const orbitCam = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 0.02, 3000);
  chaseCam.layers.enable(TAG_LAYER); orbitCam.layers.enable(TAG_LAYER); // remote pilots' name tags: spectator views only
  let viewH = innerHeight; // the canvas's CSS height (setSize below), so no frame reads layout for it
  const resize = () => { renderer.setSize(innerWidth, innerHeight); viewH = innerHeight; chaseCam.aspect = orbitCam.aspect = innerWidth / innerHeight; chaseCam.updateProjectionMatrix(); orbitCam.updateProjectionMatrix(); presentDue = true; };
  window.addEventListener('resize', resize);
  // moving the window to a monitor with another pixel density fires no resize: watch the resolution
  // itself (re-armed for the new value each time); the loop below re-applies the pixel ratio
  const watchDpr = () => matchMedia(`(resolution: ${devicePixelRatio}dppx)`).addEventListener('change', () => { resize(); watchDpr(); }, { once: true });
  watchDpr();
  // The FPV picture is a 640x480 / 1280x720 video: shading it at a retina pixel ratio (7.7 Mpx on a
  // 16" MacBook Pro) adds nothing, so FPV and the title backdrop render at ratio 1; the spectator
  // views keep the display's density.
  const applyPixelRatio = (want: number) => { if (renderer.getPixelRatio() !== want) { renderer.setPixelRatio(want); presentDue = true; } };
  // the shadow map is a full scene pass: 30 Hz is plenty, in every view
  const shadowsDue = (now: number) => { if (now - lastShadowAt < 33) return false; lastShadowAt = now; return true; };
  // motor sound goes quiet in the menus and while the tab is hidden (rAF stops then, so listen too)
  const setMuted = () => ctx.audio.setMuted(ctx.replay ? !ctx.replay.sound || document.hidden : ctx.menuOpen || document.hidden);
  document.addEventListener('visibilitychange', setMuted);

  const poseAt = (t: number): boolean => {
    if (!stateAt(t, rec)) return false;
    enuToThree(rec[R.px], rec[R.py], rec[R.pz], ctx.drone.root.position);
    quatEnuToThree(rec[R.qw], rec[R.qx], rec[R.qy], rec[R.qz], ctx.drone.root.quaternion);
    ctx.scene.actors?.update(actorTime(t)); // the map's moving actors, at the same time as the quad
    return true;
  };
  /** Actor time (src/sim/actors.ts) of sim time t: the worker says when their clock started (a replay: its own time). */
  const actorTime = (t: number) => (ctx.replay ? t : t - (ctx.tel?.actorT0 ?? 0));
  /** Lens orientation at sim time t (three world): ring pose (extrapolated with the body rates past the newest sample) × camera mount. */
  const lensAt = (t: number, head: number, q: THREE.Quaternion) => {
    if (!stateAt(Math.min(t, head), motionRec)) { q.copy(lensQ); return; }
    quatEnuToThree(motionRec[R.qw], motionRec[R.qx], motionRec[R.qy], motionRec[R.qz], q);
    if (t > head) {
      // little or no emulated latency: the end of the frame lies past the newest physics step
      tmpV.set(motionRec[R.wx], motionRec[R.wz], -motionRec[R.wy]).multiplyScalar(t - head);
      const a = tmpV.length();
      if (a > 1e-9) q.multiply(tmpQ.setFromAxisAngle(tmpV.divideScalar(a), a));
    }
    q.multiply(ctx.mountQ);
  };
  const yawOf = (q: THREE.Quaternion) => _euler.setFromQuaternion(q, 'YXZ').y;
  let solidity = { id: '', v: 0.15 };
  /** Props: spin by the real elapsed time; disc vs. blades from what one exposure of `shutter` s shows. */
  const spinProps = (rpm: number[], dt: number, shutter: number) => {
    const drone = ctx.drone, prop = ctx.build.info.components.prop;
    if (solidity.id !== prop.id) solidity = { id: prop.id, v: bladeSolidity(prop.blades, prop.chordFracs, prop.hubFrac) };
    drone.props.forEach((p, k) => {
      const r = rpm[k] ?? 0;
      // shown turning at a fraction of the true rate: at 30 000 rpm any sampled angle is a strobe anyway
      p.rotation.y += (r / 60) * 2 * Math.PI * dt * drone.propDirs[k] * 0.13;
      const look = propLook(r, shutter, prop.blades, solidity.v);
      const disc = drone.blur[k];
      disc.visible = look.disc;
      if (look.disc) (disc.material as THREE.Material).opacity = look.discOpacity;
      for (const c of p.children) if (c !== disc) c.visible = look.blades;
    });
  };
  const updateSky = (dt: number) => {
    skyTimer -= dt;
    if (skyTimer <= 0) {
      skyTimer = 0.08;
      const p = { x: rec[R.px], y: rec[R.py], z: rec[R.pz] };
      let open = 0;
      for (const [x, y, z] of SKY_DIRS) if (!(ctx.world.raycast(p, { x, y, z }, 40) < 40)) open++;
      skyOpen += (open / SKY_DIRS.length - skyOpen) * 0.35;
    }
  };

  const animate = (now: number) => {
    requestAnimationFrame(animate);
    // map builder: it draws its own scene with its own camera while the flight is paused
    if (ctx.editor) { ctx.editor.frame(now); lastMode = 'build'; lastNow = now; return; }
    ctx.replay?.frame(now);
    const rp = ctx.replay;
    const { view, build, link, fpv, osd, mp } = ctx, sceneB = ctx.scene, drone = ctx.drone;
    const dtFrame = Math.min(0.1, Math.max(0, (now - lastNow) / 1000)); lastNow = now;
    const backdrop = deps.backdrop();
    rec = rp ? replayRec : ctx.rec; stateAt = rp ? replayState : ringState;
    // a replay opened / closed, or playback jumped: the camera's frames start over
    if (!!rp !== wasReplay || (rp && rp.seq !== lastSeq)) { wasReplay = !!rp; lastSeq = rp?.seq ?? -1; lastCap = -Infinity; presentDue = true; }
    // multiplayer: publish our newest pose, place the other pilots before anything is rendered
    if (mp.connected && mp.poseDue(now) && sampleRing(sh, newestTime(sh), mpRec)) {
      const rr = mpRec;
      mp.sendPose(now, [rr[R.px], rr[R.py], rr[R.pz]], [rr[R.qw], rr[R.qx], rr[R.qy], rr[R.qz]],
        [rr[R.rpm0], rr[R.rpm1], rr[R.rpm2], rr[R.rpm3]], rr[R.armed] > 0.5, ctx.menuOpen); // paused: sent at a trickle, shown parked
    }
    if (rp) ctx.remotes.hide(); else ctx.remotes.update(sceneB.scene, mp, now);
    // flags, trees and the windsock move with the configured wind (a replay's: the wind it was flown in)
    const wind = rp ? rp.wind : ctx.sim.wind;
    sceneB.setWind(wind.speed, wind.direction, now / 1000);
    // chipped / snapped blades show on the model (and on the FPV view of the quad's own props)
    if (ctx.tel && !rp) drone.setDamage(ctx.tel.rotorDamage);
    const v = build.info.components.video;
    // Settings → cube map resolution (0: automatic for the video system, autoCubeSize)
    const cube = view.cubeSize > 0 ? view.cubeSize : autoCubeSize(v, view.renderScale);
    if (fpv.cubeSize !== cube) fpv.setCubeSize(cube);
    const head = rp ? rp.time : newestTime(sh);
    pilotPos(ctx.map, pilot);
    // ---- emulated glass-to-glass latency + camera frame cadence ----
    // (a replay has none: it shows what the camera saw, when it saw it)
    const baseLat = rp ? 0 : (view.latencyOverrideMs || v.latencyMs) + link.state.latencyExtraMs;
    const comp = display.comp(now, view.displayCompAuto, view.displayCompMs);
    fpv.effectiveLatencyMs = rp ? 0 : Math.max(0, baseLat - comp);
    const lat = rp ? 0 : Math.max(0, baseLat + jitter - comp) / 1000;
    const period = 1 / v.fps;
    // a replay in slow motion still gets a new picture every camera frame of wall time; paused, one at the playhead
    const per = rp ? (rp.playing ? period * Math.min(1, rp.speed) : 0) : period;
    const tCap = per > 0 ? Math.floor((head - lat) / per) * per : head;
    sceneB.setGateHighlight(rp ? rp.nextGate : ctx.race.nextGate, view.highlightGate, now / 1000);
    const mode = rp ? rp.cam : backdrop ? 'title' : view.view;
    if (mode !== 'fpv') sceneB.hemi.intensity = sceneB.hemiBase; // spectators: true lighting
    if (mode !== lastMode) { presentDue = true; lastMode = mode; }
    applyPixelRatio(mode === 'chase' || mode === 'los' || mode === 'orbit' ? Math.min(devicePixelRatio, 2) : 1);
    const dimmed = !rp && (deps.dimmed?.() ?? false);
    if (mode === 'title') {
      if (backdropReady(now, dimmed ? DIMMED_MS : TITLE_MS) && poseAt(head)) {
        const p = drone.root.position;
        const r = Math.max(0.28, build.info.components.frame.wheelbaseMm / 225 * 0.85);
        const a = reducedMotion.matches ? 2.2 : now * 0.00016 + 2.2;
        orbitCam.position.set(p.x + Math.cos(a) * r, p.y + 0.32 * r + 0.04, p.z + Math.sin(a) * r);
        orbitCam.lookAt(p.x, p.y + 0.02, p.z);
        sceneB.sun.position.copy(sceneB.sunDir).multiplyScalar(120).add(p);
        sceneB.sun.target.position.copy(p);
        renderer.shadowMap.needsUpdate = shadowsDue(now);
        renderer.setRenderTarget(null);
        renderer.render(sceneB.scene, orbitCam);
      }
    } else if (mode === 'fpv') {
      // (frames only move forward: per-frame jitter must never re-capture an older pose)
      // a frozen digital decoder shows its last frame, but the link itself keeps being evaluated
      // every camera frame, or it could never recover (fly back / respawn)
      let tick = false, captured = false;
      if (tCap > lastCap && poseAt(tCap)) {
        tick = true;
        const dtw = (now - lastCapWall) / 1000; lastCapWall = now;
        lastCap = tCap;
        jitter = (Math.random() - 0.5) * v.latencyJitterMs;
        rpmNow[0] = rec[R.rpm0]; rpmNow[1] = rec[R.rpm1]; rpmNow[2] = rec[R.rpm2]; rpmNow[3] = rec[R.rpm3];
        // lens pose: body pose * camera mount offset
        drone.root.updateMatrixWorld();
        const camOffset = tmpV.set(build.info.components.frame.plateLengthMm / 2000 + 0.006 - build.info.cgMm.x / 1000, cameraMountZ(build.info.components.frame, build.info.components.motor) - build.info.cgMm.z / 1000, 0);
        lensPos.copy(camOffset).applyQuaternion(drone.root.quaternion).add(drone.root.position);
        lensQ.copy(drone.root.quaternion).multiply(ctx.mountQ);
        if (!link.state.freeze) {
          sceneB.sun.position.copy(sceneB.sunDir).multiplyScalar(120).add(drone.root.position);
          sceneB.sun.target.position.copy(drone.root.position);
          fpv.sunDir.copy(sceneB.sunDir); fpv.sunColor.copy(sceneB.sun.color);
          updateSky(dtw);
          sceneB.hemi.intensity = sceneB.hemiBase * (0.04 + 0.96 * skyOpen);
          spinProps(rpmNow, dtw, fpv.shutter);
          // the camera's orientation through readout + exposure, and the props shaking its mount
          // (a replay has the whole recording: no extrapolation past the newest sample)
          motionT = tCap; motionHead = rp ? Infinity : newestTime(sh);
          fpv.setMotion(motionAt);
          fpv.setVibration(mountVibration(rpmNow, rp ? undefined : ctx.tel?.rotorDamage, build.info.hoverRpm, vib), tCap);
          // shadow map at <= 30 Hz, rendered while the whole quad is still visible (the capture
          // hides it for the world pass, so its own shadow would be missing otherwise)
          if (shadowsDue(now)) fpv.renderShadows(sceneB.scene);
          // hide only the camera itself: whoop ducts, props and a 5"'s props at high uptilt are in view
          for (const o of drone.fpvHidden) o.visible = false;
          fpv.capture(sceneB.scene, lensPos, lensQ, dtw, drone.root);
          for (const o of drone.fpvHidden) o.visible = true;
          captured = true;
        }
        // link budget at capture time
        const up = tmpV.set(0, 1, 0).applyQuaternion(drone.root.quaternion);
        const ops = rp ? undefined : ctx.tel?.ops;
        link.ew.jamDbm = ops?.video.jamDbm ?? -Infinity; link.ew.wired = ops?.link.type === 'fiber'; link.ew.lost = !!ops?.video.lost;
        if (rp ? rp.link : view.linkEffects || !!ops) link.update(v, ctx.world, pilot, { x: rec[R.px], y: rec[R.py], z: rec[R.pz] }, { x: up.x, y: -up.z, z: up.y }, dtw, now / 1000, Math.hypot(rec[R.vx], rec[R.vy], rec[R.vz]), rp ? undefined : actorTime(tCap));
        else link.clean(v);
      }
      // 1S brownout: on a punch a whoop's pack sags below what the camera / VTX regulators need
      // (~2.9-3.0 V), and the video drops out for about a second while they restart
      if ((rp ? rp.link : true) && build.info.components.battery.cells === 1 && rec[R.vbus] > 0.5 && rec[R.vbus] < 2.95 && now > brownoutUntil + 400) brownoutUntil = now + 800 + Math.random() * 600;
      if (now < brownoutUntil) { if (v.kind === 'analog') link.state.cnr = -8; else link.state.lost = 1; }
      // digital HD OSD is sent over the video link: it freezes with the picture
      osd.setHd(v.osd === 'hd');
      const osdChanged = !(v.kind === 'digital' && (link.state.freeze || link.state.lost)) && osd.update(rp ? rp.osd : sh, now);
      // the goggles' own overlay (signal, bitrate, latency, DVR): Settings can switch it off
      const gogOn = view.goggleOverlay;
      const gogChanged = gogOn && gog.update({
        system: v.system, kind: v.kind, cnr: link.state.cnr, margin: link.state.margin, bitrateMbps: link.state.bitrateMbps,
        latencyMs: v.latencyMs + link.state.latencyExtraMs, lost: link.state.lost > 0, recording: dvrState.recording, recMs: now - dvrState.startedAt,
      }, fpv.frameRT.width, fpv.frameRT.height, now);
      if (gogOn !== lastGog) { presentDue = true; lastGog = gogOn; }
      // the picture only changes with a camera frame (link artefacts, noise and fields step at that
      // rate too), the OSD or the overlay: on a 144 Hz display most refreshes have nothing to draw
      if (tick || osdChanged || gogChanged || presentDue) {
        fpv.present(osd.texture, (osd.cols * 12) / (osd.rows * 18) * (v.kind === 'analog' ? 0.9 : 1), now / 1000, link.state, view.osd && osd.hasContent, gogOn ? gog : null);
        presentDue = false;
      }
      // a new picture: the dataset recorder grabs it with its ground truth while the lens state is current
      if (captured && ctx.onCameraFrame) ctx.onCameraFrame({ t: tCap, lensPos: lensPos.clone(), lensQ: lensQ.clone(), rec: Float64Array.from(rec) });
    } else {
      // spectator views show the true (undelayed) state; behind a menu screen at ~10 Hz
      if ((!dimmed || backdropReady(now, DIMMED_MS)) && poseAt(head)) {
        if (!dimmed) presentDue = false;
        // behind a menu: the time since this view was last drawn (the smoothing runs per drawn frame)
        const dtv = dimmed ? Math.min(0.1, Math.max(0, (now - lastViewAt) / 1000)) : dtFrame; lastViewAt = now;
        rpmNow[0] = rec[R.rpm0]; rpmNow[1] = rec[R.rpm1]; rpmNow[2] = rec[R.rpm2]; rpmNow[3] = rec[R.rpm3];
        spinProps(rpmNow, dtv, SHUTTER_MAX); // ~ the eye's integration time
        updateSky(dtv);
        const p = drone.root.position;
        if (mode === 'chase') {
          // chase distance scales with the quad (1.6 m behind a 5", ~0.5 m behind a 65 mm whoop)
          const cs = Math.max(0.3, Math.min(1.3, build.info.components.frame.wheelbaseMm / 225));
          const back = tmpV.set(-1.6 * cs, 0.6 * cs, 0).applyQuaternion(tmpQ.setFromAxisAngle(Y_UP, yawOf(drone.root.quaternion)));
          // same feel at any refresh rate: 15 % per 60 Hz frame = time constant ~0.1 s
          chaseCam.position.lerp(back.add(p), 1 - Math.exp(-dtv / 0.1026));
          chaseCam.lookAt(p);
          if (chaseCam.fov !== 70) { chaseCam.fov = 70; chaseCam.updateProjectionMatrix(); }
        } else if (mode === 'orbit' && rp) {
          // replay: a camera on a sphere around the quad (the player turns and zooms it)
          const o = rp.orbit, ce = Math.cos(o.el);
          chaseCam.position.set(p.x + o.dist * ce * Math.sin(o.az), p.y + o.dist * Math.sin(o.el), p.z + o.dist * ce * Math.cos(o.az));
          chaseCam.lookAt(p);
          if (chaseCam.fov !== 60) { chaseCam.fov = 60; chaseCam.updateProjectionMatrix(); }
        } else {
          enuToThree(pilot.x, pilot.y, pilot.z, chaseCam.position);
          chaseCam.lookAt(p);
          // zoom out to the eye's ~60° near the pilot, in toward ~14° as the quad flies off (a camera
          // operator's framing), and ring it when it is still only a few pixels
          const d = chaseCam.position.distanceTo(p), wb = build.info.components.frame.wheelbaseMm / 1000;
          const fovT = Math.max(14, Math.min(60, (60 * 10) / Math.max(1, d)));
          const fov = chaseCam.fov === 70 ? fovT : chaseCam.fov + (fovT - chaseCam.fov) * (1 - Math.exp(-dtv / 0.4));
          if (Math.abs(fov - chaseCam.fov) > 1e-3) { chaseCam.fov = fov; chaseCam.updateProjectionMatrix(); }
          const H = viewH, tanH = Math.tan(THREE.MathUtils.degToRad(chaseCam.fov) / 2);
          const sizePx = ((wb * 1.4) / Math.max(0.1, d) / (2 * tanH)) * H;
          marker.visible = sizePx < 18;
          marker.position.copy(p);
          marker.scale.setScalar((2 * 30 * tanH) / H); // ~30 px across at any zoom (sizeAttenuation off)
        }
        if (marker.parent !== sceneB.scene) sceneB.scene.add(marker);
        sceneB.sun.position.copy(sceneB.sunDir).multiplyScalar(120).add(p);
        sceneB.sun.target.position.copy(p);
        renderer.shadowMap.needsUpdate = shadowsDue(now);
        renderer.setRenderTarget(null);
        renderer.render(sceneB.scene, chaseCam);
        marker.visible = false;
      }
    }
    ctx.blackbox.pump(sh, ctx.rcOverride ?? ctx.input.channels);
    ctx.replays.pump(sh, ctx.race.lapStart >= 0 ? ctx.race.lapStart - PRE_S : null, ctx.tel?.modeFlags ?? 0, now);
    if (drillMesh.parent !== sceneB.scene) sceneB.scene.add(drillMesh);
    // the hover box: the classic drill's, or a training drill's (its own size and height)
    const tgt = ctx.trainingTarget;
    drillMesh.visible = (ctx.drill.on || !!tgt) && !rp;
    if (tgt) { enuToThree(tgt.x, tgt.y, tgt.z, drillMesh.position); drillMesh.scale.setScalar(tgt.radius / 1.5); }
    else if (ctx.drill.on) { enuToThree(ctx.map.spawn.pos.x, ctx.map.spawn.pos.y, spawnGroundZ(ctx.map) + 3, drillMesh.position); drillMesh.scale.setScalar(1); }
    // where the listener is: the pilot (FPV / line of sight) or the chase camera
    const quad = { x: rec[R.px], y: rec[R.py], z: rec[R.pz] };
    const earView = rp ? (rp.cam === 'orbit' ? 'chase' : rp.cam) : view.view, cam = earView === 'chase';
    const cp = chaseCam.position, listener = cam ? { x: cp.x, y: -cp.z, z: cp.y } : { x: pilot.x, y: pilot.y, z: pilot.z };
    let fwd: { x: number; y: number; z: number };
    if (cam) { const f = chaseCam.getWorldDirection(tmpV); fwd = { x: f.x, y: -f.z, z: f.y }; }
    else { const n = Math.hypot(quad.x - pilot.x, quad.y - pilot.y, quad.z - pilot.z) || 1; fwd = { x: (quad.x - pilot.x) / n, y: (quad.y - pilot.y) / n, z: (quad.z - pilot.z) / n }; } // the pilot faces the quad
    const hearD = cam ? (rp?.cam === 'orbit' ? rp.orbit.dist : 2) : Math.hypot(rec[R.px] - pilot.x, rec[R.py] - pilot.y, rec[R.pz] - pilot.z);
    // Betaflight's own buzzer and DShot beacon (arming, RX loss, low battery, the beeper switch)
    ctx.audio.update([rec[R.rpm0], rec[R.rpm1], rec[R.rpm2], rec[R.rpm3]].map(Math.abs), rec[R.ibus], build.info.components.prop.blades, build.info.components.motor.poles, hearD, rec[R.vrs], {
      beeper: !rp && (ctx.tel?.beeper ?? false), beacon: !rp && (ctx.tel?.beacon ?? false), quad, quadVel: { x: rec[R.vx], y: rec[R.vy], z: rec[R.vz] },
      listener, listenerFwd: fwd, enclosed: 1 - skyOpen, view: earView,
    });
    // the other pilots' motors, from their newest pose (not over a replay)
    if (mp.connected && rp) ctx.audio.updateRemote([], listener, fwd);
    else if (mp.connected) {
      const others: RemoteSound[] = [];
      for (const [id, peer] of mp.peers) {
        const p = peer.poses[peer.poses.length - 1];
        if (p) others.push({ id, pos: { x: p.p[0], y: p.p[1], z: p.p[2] }, rpm: p.r });
      }
      ctx.audio.updateRemote(others, listener, fwd);
    }
    setMuted();
    deps.afterFrame();
  };
  requestAnimationFrame(animate);
}
