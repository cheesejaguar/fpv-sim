// The render loop: emulated glass-to-glass latency and camera cadence, the FPV capture (cubemap +
// fisheye + link artefacts + OSD), the title-screen orbit, spectator views, multiplayer poses, audio.
import * as THREE from 'three';
import { pilotPos, spawnGroundZ } from '../maps/world';
import { enuToThree, quatEnuToThree } from '../render/coords';
import { cameraMountZ } from '../render/droneMesh';
import { newestTime, R, REC, sampleRing } from '../worker/shared';
import type { AppCtx } from './context';

export interface FrameLoopDeps {
  /** true while the title screen wants the orbiting quad behind it */
  backdrop(): boolean;
  /** HUD update, after the frame is drawn */
  afterFrame(): void;
}

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

export function startFrameLoop(ctx: AppCtx, deps: FrameLoopDeps) {
  const { renderer, sh, rec, pilot } = ctx;
  const tmpQ = new THREE.Quaternion(), tmpV = new THREE.Vector3(), lensPos = new THREE.Vector3(), lensQ = new THREE.Quaternion();
  const omegaCam = new THREE.Vector3();
  const mpRec = new Float64Array(REC);
  const display = new DisplayLatency();
  let lastCap = -1, lastCapWall = performance.now(), jitter = 0;
  let lastShadowAt = 0, brownoutUntil = -1e9;
  let skyOpen = 1, skyTimer = 0;
  const drillMesh = new THREE.Mesh(new THREE.SphereGeometry(1.5, 32, 16), new THREE.MeshBasicMaterial({ color: 0x39b6ff, transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide }));
  const chaseCam = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.05, 3000);
  // title-screen backdrop: a slow orbit around the quad sitting on the pad
  const orbitCam = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 0.02, 3000);
  window.addEventListener('resize', () => { renderer.setSize(innerWidth, innerHeight); chaseCam.aspect = orbitCam.aspect = innerWidth / innerHeight; chaseCam.updateProjectionMatrix(); orbitCam.updateProjectionMatrix(); });

  const poseAt = (t: number): boolean => {
    if (!sampleRing(sh, t, rec)) return false;
    enuToThree(rec[R.px], rec[R.py], rec[R.pz], ctx.drone.root.position);
    quatEnuToThree(rec[R.qw], rec[R.qx], rec[R.qy], rec[R.qz], ctx.drone.root.quaternion);
    return true;
  };
  const yawOf = (q: THREE.Quaternion) => new THREE.Euler().setFromQuaternion(q, 'YXZ').y;
  const spinProps = (rpm: number[]) => {
    const drone = ctx.drone;
    drone.props.forEach((p, k) => {
      const r = rpm[k] ?? 0;
      p.rotation.y += (r / 60) * 2 * Math.PI * (1 / 60) * drone.propDirs[k] * 0.13;
      drone.blur[k].visible = Math.abs(r) > 3000;
      for (const c of p.children) if (c !== drone.blur[k]) c.visible = Math.abs(r) < 6000;
    });
  };
  const updateSkyAmbient = (dt: number) => {
    skyTimer -= dt;
    if (skyTimer <= 0) {
      skyTimer = 0.08;
      const p = { x: rec[R.px], y: rec[R.py], z: rec[R.pz] };
      let open = 0;
      for (const [x, y, z] of SKY_DIRS) if (!(ctx.world.raycast(p, { x, y, z }, 40) < 40)) open++;
      skyOpen += (open / SKY_DIRS.length - skyOpen) * 0.35;
    }
    ctx.scene.hemi.intensity = ctx.scene.hemiBase * (0.04 + 0.96 * skyOpen);
  };

  const animate = (now: number) => {
    requestAnimationFrame(animate);
    const { view, build, link, fpv, osd, mp } = ctx, sceneB = ctx.scene, drone = ctx.drone;
    // multiplayer: publish our newest pose, place the other pilots before anything is rendered
    if (mp.connected && sampleRing(sh, newestTime(sh), mpRec)) {
      const rr = mpRec;
      mp.sendPose(now, [rr[R.px], rr[R.py], rr[R.pz]], [rr[R.qw], rr[R.qx], rr[R.qy], rr[R.qz]],
        (Math.abs(rr[R.rpm0]) + Math.abs(rr[R.rpm1]) + Math.abs(rr[R.rpm2]) + Math.abs(rr[R.rpm3])) / 4, rr[R.armed] > 0.5);
    }
    ctx.remotes.update(sceneB.scene, mp, now);
    const v = build.info.components.video;
    const head = newestTime(sh);
    pilotPos(ctx.map, pilot);
    // ---- emulated glass-to-glass latency + camera frame cadence ----
    const baseLat = (view.latencyOverrideMs || v.latencyMs) + link.state.latencyExtraMs;
    const lat = Math.max(0, baseLat + jitter - display.comp(now, view.displayCompAuto, view.displayCompMs)) / 1000;
    const period = 1 / v.fps;
    const tCap = Math.floor((head - lat) / period) * period;
    // props spin visual
    const rpmNow = [rec[R.rpm0], rec[R.rpm1], rec[R.rpm2], rec[R.rpm3]];
    sceneB.setGateHighlight(ctx.race.nextGate, view.highlightGate, now / 1000);
    if (view.view !== 'fpv' || deps.backdrop()) sceneB.hemi.intensity = sceneB.hemiBase; // spectators: true lighting
    if (deps.backdrop()) {
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
        lensQ.copy(drone.root.quaternion).multiply(ctx.mountQ);
        // angular rate in camera frame (body FLU -> three body -> camera)
        omegaCam.set(rec[R.wx], rec[R.wz], -rec[R.wy]).applyQuaternion(tmpQ.copy(ctx.mountQ).invert());
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
        if (view.linkEffects) link.update(v, ctx.world, pilot, { x: rec[R.px], y: rec[R.py], z: rec[R.pz] }, { x: up.x, y: -up.z, z: up.y }, dtw, now / 1000, Math.hypot(rec[R.vx], rec[R.vy], rec[R.vz]));
        else link.state = { ...link.state, cnr: 45, block: 0, freeze: false, lost: 0, latencyExtraMs: 0 };
      }
      // 1S brownout: on a punch a whoop's pack sags below what the camera / VTX regulators need
      // (~2.9-3.0 V), and the video drops out for about a second while they restart
      if (build.info.components.battery.cells === 1 && rec[R.vbus] > 0.5 && rec[R.vbus] < 2.95 && now > brownoutUntil + 400) brownoutUntil = now + 800 + Math.random() * 600;
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
    ctx.blackbox.pump(sh, ctx.input.channels);
    if (drillMesh.parent !== sceneB.scene) sceneB.scene.add(drillMesh);
    drillMesh.visible = ctx.drill.on;
    if (ctx.drill.on) enuToThree(ctx.map.spawn.pos.x, ctx.map.spawn.pos.y, spawnGroundZ(ctx.map) + 3, drillMesh.position);
    // where the listener is: the pilot (FPV / line of sight) or the chase camera
    const hearD = view.view === 'chase' ? 2 : Math.hypot(rec[R.px] - pilot.x, rec[R.py] - pilot.y, rec[R.pz] - pilot.z);
    ctx.audio.update(rpmNow.map(Math.abs), rec[R.ibus], build.info.components.prop.blades, build.info.components.motor.poles, hearD, rec[R.vrs]);
    deps.afterFrame();
  };
  requestAnimationFrame(animate);
}
