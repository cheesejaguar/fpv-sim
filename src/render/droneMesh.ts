// Procedurally generated 3D model of the configured quad (frame plates & arms from the frame spec,
// motor bells sized by stator, prop blades lofted from the chord distribution, battery box from its
// dimensions, camera at the configured uptilt). Built in three-mapped body space: +X forward,
// +Y up, -Z left. Positions are relative to the CG so the object origin = physics origin.
import * as THREE from 'three';
import type { DerivedInfo, DroneSpec } from '../builder/derive';

/** fpvHidden: parts hidden while rendering the FPV camera (the camera body around the lens) */
export interface DroneModel {
  root: THREE.Group; props: THREE.Object3D[]; propDirs: number[]; blur: THREE.Mesh[]; fpvHidden: THREE.Object3D[];
  /** Show prop damage per rotor (Telemetry.rotorDamage): chipped blades shorter, a broken one snapped and bent. */
  setDamage(rotorDamage: { thrust: number; broken: boolean }[]): void;
  dispose(): void;
}

export const PROP_COLORS = [0xff3b30, 0x30c5ff, 0xffd60a, 0x34c759];
/** Prop colour of a build: fixed per spec name (FNV-1a), so a rebuild or respawn doesn't repaint the props. */
export function propColor(name: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 0x01000193);
  return PROP_COLORS[(h >>> 0) % PROP_COLORS.length];
}

/**
 * Blade length factors (1 = intact) for a rotor's damage. Chips come off the tips unevenly (the
 * blade that hit first loses most); a broken prop has one blade snapped near the hub.
 */
export function bladeLengths(blades: number, d: { thrust: number; broken: boolean }): number[] {
  const loss = Math.max(0, Math.min(1, 1 - d.thrust));
  return Array.from({ length: blades }, (_, b) => {
    if (d.broken && b === 0) return 0.38;
    return Math.max(0.45, 1 - loss * [1.1, 0.7, 0.45, 0.3][b % 4]);
  });
}

/**
 * Height of the FPV lens above the frame's base plane (m). Normally mid-stack; on ducted whoops the
 * camera sits in a canopy above the ducts, so they appear along the bottom of the picture.
 */
export function cameraMountZ(frame: { stackHeightMm: number; ducted?: boolean; ductHeightMm?: number }, motor: { bellHeightMm: number }): number {
  const st = frame.stackHeightMm / 1000;
  if (!frame.ducted) return st / 2;
  const ductTop = 0.006 + motor.bellHeightMm / 1000 + 0.004 + (frame.ductHeightMm ?? 10) / 2000;
  return Math.max(st / 2, ductTop + 0.005);
}

export function buildDroneMesh(spec: DroneSpec, info: DerivedInfo, rotorPos: { x: number; y: number; z: number; dir: number }[], cg: { x: number; y: number; z: number }): DroneModel {
  const root = new THREE.Group();
  const disp: { dispose(): void }[] = [];
  const T = <X extends { dispose(): void }>(x: X) => (disp.push(x), x);
  const carbon = T(new THREE.MeshStandardMaterial({ color: 0x1b1d20, roughness: 0.45, metalness: 0.2 }));
  const alu = T(new THREE.MeshStandardMaterial({ color: 0xb8323a, roughness: 0.35, metalness: 0.8 }));
  const black = T(new THREE.MeshStandardMaterial({ color: 0x0c0c0c, roughness: 0.6 }));
  const tpu = T(new THREE.MeshStandardMaterial({ color: 0xff5a1f, roughness: 0.8 }));
  const ductMat = T(new THREE.MeshStandardMaterial({ color: 0x2b2f36, roughness: 0.55, side: THREE.DoubleSide }));
  const { frame, motor, prop, battery, video } = info.components;
  // body FLU (m, relative to CG) -> three body space
  const B = (x: number, y: number, z: number) => new THREE.Vector3(x - cg.x / 1000, z - cg.z / 1000, -(y - cg.y / 1000));

  // plates
  const pl = frame.plateLengthMm / 1000, pw = frame.plateWidthMm / 1000, st = frame.stackHeightMm / 1000;
  const bottom = new THREE.Mesh(T(new THREE.BoxGeometry(pl, 0.004, pw)), carbon); bottom.position.copy(B(0, 0, 0.002));
  const top = new THREE.Mesh(T(new THREE.BoxGeometry(pl * 0.9, 0.0025, pw * 0.95)), carbon); top.position.copy(B(0, 0, st));
  root.add(bottom, top);
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
    const so = new THREE.Mesh(T(new THREE.CylinderGeometry(0.0025, 0.0025, st, 8)), alu);
    so.position.copy(B(sx * pl * 0.4, sy * pw * 0.4, st / 2)); root.add(so);
  }
  // arms + motors + props
  const props: THREE.Object3D[] = [], blur: THREE.Mesh[] = [], dirs: number[] = [];
  const R = (prop.diameterIn * 0.0254) / 2;
  const bladeGeo = T(makeBladeGeometry(R, prop.chordFracs, prop.hubFrac));
  const propMat = T(new THREE.MeshStandardMaterial({ color: propColor(spec.name || spec.prop), roughness: 0.4, side: THREE.DoubleSide })); // opaque: transparent blades sort badly up close
  const blurMat = T(new THREE.MeshBasicMaterial({ color: propMat.color, transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide }));
  rotorPos.forEach((rp, k) => {
    const hx = rp.x + cg.x / 1000, hy = rp.y + cg.y / 1000; // back to frame coordinates
    const L = Math.hypot(hx, hy);
    const arm = new THREE.Mesh(T(new THREE.BoxGeometry(L, frame.armThicknessMm / 1000, frame.armWidthMm / 1000)), carbon);
    arm.position.copy(B(hx / 2, hy / 2, -frame.armThicknessMm / 2000));
    arm.rotation.y = Math.atan2(hy, hx);
    root.add(arm);
    const bell = new THREE.Mesh(T(new THREE.CylinderGeometry(motor.bellDiaMm / 2000, motor.bellDiaMm / 2000, motor.bellHeightMm / 1000, 20)), alu);
    bell.position.copy(B(hx, hy, 0.002 + motor.bellHeightMm / 2000)); root.add(bell);
    const hub = new THREE.Group();
    hub.position.copy(B(hx, hy, 0.006 + motor.bellHeightMm / 1000 + 0.004));
    for (let b = 0; b < prop.blades; b++) {
      const blade = new THREE.Mesh(bladeGeo, propMat);
      blade.rotation.y = (b / prop.blades) * Math.PI * 2;
      if (rp.dir < 0) blade.scale.z = -1; // mirror for CW props
      blade.castShadow = true;
      hub.add(blade);
    }
    const disc = new THREE.Mesh(T(new THREE.RingGeometry(R * 0.15, R, 32)), blurMat);
    disc.rotation.x = -Math.PI / 2; disc.visible = false;
    hub.add(disc);
    root.add(hub); props.push(hub); blur.push(disc); dirs.push(rp.dir);
    if (frame.ducted) {
      // prop guard duct: open thin-walled ring around the prop disc, with a lip at the top
      const dh = (frame.ductHeightMm ?? 10) / 1000;
      const ring = new THREE.Mesh(T(new THREE.CylinderGeometry(R * 1.08, R * 1.08, dh, 40, 1, true)), ductMat);
      ring.position.copy(B(hx, hy, 0.006 + motor.bellHeightMm / 1000 + 0.004));
      const lip = new THREE.Mesh(T(new THREE.TorusGeometry(R * 1.1, Math.max(0.0012, dh * 0.08), 8, 40)), ductMat);
      lip.rotation.x = Math.PI / 2; lip.position.y = dh / 2;
      ring.add(lip);
      root.add(ring);
    }
  });
  // battery
  const bd = battery.dims;
  const batZ = spec.batteryMount === 'top' ? st + 0.004 + bd[2] / 2000 : -0.003 - bd[2] / 2000;
  const batMat = T(new THREE.MeshStandardMaterial({ color: 0x2a2f3a, roughness: 0.7 }));
  const bat = new THREE.Mesh(T(new THREE.BoxGeometry(bd[0] / 1000, bd[2] / 1000, bd[1] / 1000)), batMat);
  bat.position.copy(B(0, 0, batZ)); bat.castShadow = true; root.add(bat);
  const strap = new THREE.Mesh(T(new THREE.BoxGeometry(0.02, bd[2] / 1000 + 0.004, bd[1] / 1000 + 0.004)), tpu);
  strap.position.copy(bat.position); root.add(strap);
  // camera with uptilt
  const cam = new THREE.Group();
  const camBody = new THREE.Mesh(T(new THREE.BoxGeometry(0.019, 0.019, 0.019)), black);
  const lens = new THREE.Mesh(T(new THREE.CylinderGeometry(0.006, 0.007, 0.01, 16)), black);
  lens.rotation.z = Math.PI / 2; lens.position.x = 0.013;
  cam.add(camBody, lens);
  cam.position.copy(B(pl / 2 - 0.008, 0, cameraMountZ(frame, motor)));
  cam.rotation.z = THREE.MathUtils.degToRad(spec.cameraUptiltDeg);
  cam.userData.fpvHide = true; // the lens sits inside it; everything else (ducts, props) stays in view
  root.add(cam);
  // VTX antenna
  const ant = new THREE.Mesh(T(new THREE.CylinderGeometry(0.0015, 0.0015, 0.05, 6)), black);
  ant.position.copy(B(-pl / 2, 0, st + 0.02)); ant.rotation.z = 0.6; root.add(ant);
  const antTip = new THREE.Mesh(T(new THREE.SphereGeometry(0.006, 10, 8)), tpu);
  antTip.position.copy(B(-pl / 2 - 0.016, 0, st + 0.042)); root.add(antTip);
  if (video.kind === 'digital') { const au = new THREE.Mesh(T(new THREE.BoxGeometry(0.03, 0.012, 0.03)), black); au.position.copy(B(-0.02, 0, st - 0.006)); root.add(au); }
  if (spec.extraMassG > 40) { const gp = new THREE.Mesh(T(new THREE.BoxGeometry(0.03, 0.045, 0.06)), black); gp.position.copy(B(0.02, 0, (spec.extraMassZmm + 15) / 1000 + 0.04)); gp.userData.fpvHide = true; root.add(gp); }
  root.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; } });
  const fpvHidden: THREE.Object3D[] = [];
  root.traverse((o) => { if (o.userData.fpvHide) fpvHidden.push(o); });
  let damageKey = '';
  const setDamage = (dmg: { thrust: number; broken: boolean }[]) => {
    const key = dmg.map((d) => (d.broken ? 'b' : d.thrust.toFixed(2))).join();
    if (key === damageKey) return;
    damageKey = key;
    props.forEach((hub, k) => {
      const d = dmg[k] ?? { thrust: 1, broken: false }, lens = bladeLengths(prop.blades, d);
      let b = 0;
      for (const c of hub.children) {
        if (c === blur[k]) continue;
        // blades run along +x from the hub: shorten them; the snapped one is bent up as well
        c.scale.x = lens[b]; c.rotation.z = d.broken && b === 0 ? 0.35 : 0;
        b++;
      }
      blur[k].scale.setScalar(Math.max(...lens)); // the blur disc is as big as the longest blade
    });
  };
  return { root, props, propDirs: dirs, blur, fpvHidden, setDamage, dispose() { for (const d of disp) d.dispose(); } };
}

/** Lofted blade from hub to tip along +X, chord along Z, slight pitch twist. */
function makeBladeGeometry(R: number, chordFracs: number[], hubFrac: number): THREE.BufferGeometry {
  const n = 12, verts: number[] = [], idx: number[] = [];
  for (let i = 0; i <= n; i++) {
    const rf = hubFrac + (1 - hubFrac) * (i / n);
    const u = (i / n) * (chordFracs.length - 1);
    const i0 = Math.min(chordFracs.length - 2, Math.floor(u));
    const c = (chordFracs[i0] + (chordFracs[i0 + 1] - chordFracs[i0]) * (u - i0)) * R;
    const twist = Math.atan(1 / (2 * Math.PI * rf)) * 0.9;
    const x = rf * R;
    const le = c * 0.35, te = -c * 0.65;
    verts.push(x, Math.sin(twist) * le, Math.cos(twist) * le, x, Math.sin(twist) * te, Math.cos(twist) * te);
    if (i < n) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}
