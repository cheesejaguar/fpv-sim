// Procedural 3D model of a fixed-wing build (src/data/airframes.ts through src/builder/plane.ts):
// the fuselage pod, the tapered and swept wing with its dihedral, the tail of its layout
// (tailplane and fin, V-tail panels, or a flying wing's winglets), the motors and props spinning
// about the fuselage axis, and the FPV camera in the nose. Same body space and interface as the
// quad's (droneMesh.ts): three-mapped (+X forward, +Y up, -Z left), relative to the CG.
import * as THREE from 'three';
import type { DerivedInfo, DroneSpec } from '../builder/derive';
import { bladeLengths, DroneModel, makeBladeGeometry, mergeStatic, propColor } from './droneMesh';

type P3 = [number, number, number];

/**
 * A thin flat panel (a wing half, a tail surface): the planform quad (leading root, leading tip,
 * trailing tip, trailing root) thickened along `normal`, thicker at the root than the tip.
 */
function panel(c: [P3, P3, P3, P3], normal: P3, tRoot: number, tTip: number): THREE.BufferGeometry {
  const t = [tRoot, tTip, tTip, tRoot];
  const v: number[] = [];
  for (const side of [1, -1]) c.forEach((p, i) => v.push(p[0] + normal[0] * side * t[i] / 2, p[1] + normal[1] * side * t[i] / 2, p[2] + normal[2] * side * t[i] / 2));
  // 0..3 top, 4..7 bottom
  const idx = [0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 1, 5, 6, 1, 6, 2, 2, 6, 7, 2, 7, 3, 3, 7, 4, 3, 4, 0];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  g.setIndex(idx);
  const flat = g.toNonIndexed(); g.dispose();
  flat.computeVertexNormals();
  return flat;
}

export function buildPlaneMesh(spec: DroneSpec, info: DerivedInfo, rotorPos: { x: number; y: number; z: number; dir: number }[], cg: { x: number; y: number; z: number }): DroneModel {
  const pl = info.plane!, a = pl.airframe, { motor, prop } = info.components;
  const root = new THREE.Group();
  root.userData.gt = 'drone_self';
  const disp: { dispose(): void }[] = [];
  const T = <X extends { dispose(): void }>(x: X) => (disp.push(x), x);
  const accent = propColor(spec.name || spec.prop);
  const foam = T(new THREE.MeshStandardMaterial({ color: 0xe9e9e4, roughness: 0.85, side: THREE.DoubleSide }));
  const trim = T(new THREE.MeshStandardMaterial({ color: accent, roughness: 0.7, side: THREE.DoubleSide }));
  const dark = T(new THREE.MeshStandardMaterial({ color: 0x1a1c20, roughness: 0.5 }));
  const alu = T(new THREE.MeshStandardMaterial({ color: 0xb8323a, roughness: 0.35, metalness: 0.8 }));
  // airframe coordinates (x forward from the wing root's leading edge, y left, z up; m) -> three body space
  const cx = cg.x / 1000, cy = cg.y / 1000, cz = cg.z / 1000;
  const B = (x: number, y: number, z: number): P3 => [x - cx, z - cz, -(y - cy)];
  const N = (x: number, y: number, z: number): P3 => [x, z, -y];
  const DEG = Math.PI / 180;

  // fuselage pod: a capsule along x, as wide and tall as the airframe's
  const f = a.fuselage, fL = f.lengthMm / 1000, fW = f.widthMm / 1000, fH = f.heightMm / 1000, xNose = f.noseMm / 1000;
  const r = fW / 2;
  const body = new THREE.Mesh(T(new THREE.CapsuleGeometry(r, Math.max(0.01, fL - 2 * r), 6, 16)), foam);
  body.rotation.z = Math.PI / 2; body.scale.set(fH / fW, 1, 1); // capsule along three-Y: turned to X, stretched to the pod's height
  body.position.set(...B(xNose - fL / 2, 0, fH * 0.05));
  root.add(body);

  // wing
  const b = a.spanMm / 1000, S = a.wingAreaDm2 / 100, lam = a.taper, cr = (2 * S) / (b * (1 + lam));
  const sw = Math.tan(a.sweepDeg * DEG), dih = a.dihedralDeg * DEG;
  for (const sy of [1, -1]) {
    const tipY = (sy * b) / 2, tipLe = -(b / 2) * sw, tipZ = (b / 2) * Math.tan(dih);
    const g = panel([B(0, 0, 0), B(tipLe, tipY, tipZ), B(tipLe - cr * lam, tipY, tipZ), B(-cr, 0, 0)], N(0, -sy * Math.sin(dih), Math.cos(dih)), cr * 0.1, cr * lam * 0.08);
    root.add(new THREE.Mesh(T(g), foam));
    // a coloured band on the tips (orientation in the air)
    const bandIn = 0.85;
    const gb = panel([B(tipLe * bandIn, tipY * bandIn, tipZ * bandIn), B(tipLe, tipY, tipZ), B(tipLe - cr * lam, tipY, tipZ), B(tipLe * bandIn - cr * (1 - (1 - lam) * bandIn), tipY * bandIn, tipZ * bandIn)], N(0, -sy * Math.sin(dih), Math.cos(dih)), cr * lam * 0.1, cr * lam * 0.09);
    root.add(new THREE.Mesh(T(gb), trim));
  }

  // tail
  const xAcW = -(b / 6) * ((1 + 2 * lam) / (1 + lam)) * sw - 0.25 * (2 / 3) * cr * ((1 + lam + lam * lam) / (1 + lam));
  const xAcT = xAcW - a.tail.armMm / 1000;
  if (a.layout === 'conventional') {
    const Sh = a.tail.hAreaDm2 / 100, hSpan = Math.sqrt(Sh * 4.2), hc = Sh / hSpan, le = xAcT + hc / 4;
    root.add(new THREE.Mesh(T(panel([B(le, -hSpan / 2, 0.03), B(le - 0.15 * hc, hSpan / 2, 0.03), B(le - hc, hSpan / 2, 0.03), B(le - hc, -hSpan / 2, 0.03)], N(0, 0, 1), hc * 0.08, hc * 0.06)), foam));
    const Sv = a.tail.vAreaDm2 / 100, vH = Math.sqrt(Sv * 1.6), vc = Sv / vH, vle = xAcT - 0.02 + vc / 4;
    root.add(new THREE.Mesh(T(panel([B(vle, 0, 0.03), B(vle - 0.3 * vc, 0, 0.03 + vH), B(vle - vc, 0, 0.03 + vH), B(vle - vc, 0, 0.03)], N(0, 1, 0), vc * 0.08, vc * 0.06)), trim));
  } else if (a.layout === 'vtail') {
    const Sp = a.tail.hAreaDm2 / 200, ps = Math.sqrt(Sp * 1.6), pc = Sp / ps, le = xAcT + pc / 4, va = (a.tail.vAngleDeg ?? 35) * DEG;
    for (const sy of [1, -1]) {
      const ty = sy * ps * Math.cos(va), tz = 0.03 + ps * Math.sin(va);
      root.add(new THREE.Mesh(T(panel([B(le, 0, 0.03), B(le - 0.2 * pc, ty, tz), B(le - pc, ty, tz), B(le - pc, 0, 0.03)], N(0, -sy * Math.sin(va), Math.cos(va)), pc * 0.08, pc * 0.06)), trim));
    }
  } else if (a.winglets) {
    const w = a.winglets, hW = w.heightMm / 1000, wc = w.areaDm2 / 100 / hW;
    for (const sy of [1, -1]) {
      const y = (sy * b) / 2, le = -(b / 2) * sw, z0 = (b / 2) * Math.tan(dih);
      root.add(new THREE.Mesh(T(panel([B(le - 0.02, y, z0), B(le - 0.02 - 0.5 * wc, y, z0 + hW), B(le - 0.02 - 1.2 * wc, y, z0 + hW), B(le - 0.02 - wc, y, z0)], N(0, 1, 0), wc * 0.06, wc * 0.05)), trim));
    }
  }

  // motors and props: the prop disc across the fuselage axis (the hub spins about its own +Y, turned to +X)
  const props: THREE.Object3D[] = [], blur: THREE.Mesh[] = [], dirs: number[] = [];
  const R = (prop.diameterIn * 0.0254) / 2;
  const bladeGeo = T(makeBladeGeometry(R, prop.chordFracs, prop.hubFrac));
  const propMat = T(new THREE.MeshStandardMaterial({ color: 0x202226, roughness: 0.4, side: THREE.DoubleSide }));
  const tractor = a.motors.mount === 'tractor';
  rotorPos.forEach((rp) => {
    const hx = rp.x + cx, hy = rp.y + cy, hz = rp.z + cz;
    const bell = new THREE.Mesh(T(new THREE.CylinderGeometry(motor.bellDiaMm / 2000, motor.bellDiaMm / 2000, motor.bellHeightMm / 1000, 16)), alu);
    bell.rotation.z = Math.PI / 2; bell.position.set(...B(hx, hy, hz));
    root.add(bell);
    if (a.motors.count === 2) {
      // a nacelle on the wing behind (or in front of) the motor
      const nac = new THREE.Mesh(T(new THREE.CapsuleGeometry(motor.bellDiaMm / 1600, 0.06, 4, 10)), foam);
      nac.rotation.z = Math.PI / 2; nac.position.set(...B(hx + (tractor ? -0.045 : 0.045), hy, hz));
      root.add(nac);
    }
    const mount = new THREE.Group();
    mount.position.set(...B(hx + (tractor ? 1 : -1) * (motor.bellHeightMm / 2000 + 0.008), hy, hz));
    mount.rotation.z = -Math.PI / 2;
    const hub = new THREE.Group();
    for (let k = 0; k < prop.blades; k++) {
      const blade = new THREE.Mesh(bladeGeo, propMat);
      blade.rotation.y = (k / prop.blades) * Math.PI * 2;
      if (rp.dir < 0) blade.scale.z = -1;
      hub.add(blade);
    }
    const disc = new THREE.Mesh(T(new THREE.RingGeometry(R * 0.15, R, 32)), T(new THREE.MeshLambertMaterial({ color: 0x202226, transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide })));
    disc.rotation.x = -Math.PI / 2; disc.visible = false;
    hub.add(disc);
    mount.add(hub); root.add(mount);
    props.push(hub); blur.push(disc); dirs.push(rp.dir);
  });

  // FPV camera in the nose, at the build's uptilt
  const lensAt = B(xNose + 0.004, 0, fH * 0.15);
  const cam = new THREE.Group();
  const camBody = new THREE.Mesh(T(new THREE.BoxGeometry(0.019, 0.019, 0.019)), dark);
  const lens = new THREE.Mesh(T(new THREE.CylinderGeometry(0.006, 0.007, 0.01, 16)), dark);
  lens.rotation.z = Math.PI / 2; lens.position.x = 0.008;
  cam.add(camBody, lens);
  cam.position.set(lensAt[0] - 0.008, lensAt[1], lensAt[2]);
  cam.rotation.z = THREE.MathUtils.degToRad(spec.cameraUptiltDeg);
  cam.userData.fpvHide = true;
  root.add(cam);
  // the nose itself would fill the bottom of the FPV picture from inside the pod: hidden in FPV too
  body.userData.fpvHide = true;

  root.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
  mergeStatic(root, T);
  const fpvHidden: THREE.Object3D[] = [];
  root.traverse((o) => { if (o.userData.fpvHide) fpvHidden.push(o); });
  let damageKey = '';
  const setDamage = (dmg: { thrust: number; broken: boolean }[]) => {
    const key = dmg.map((d) => (d.broken ? 'b' : d.thrust.toFixed(2))).join();
    if (key === damageKey) return;
    damageKey = key;
    props.forEach((hub, k) => {
      const d = dmg[k] ?? { thrust: 1, broken: false }, lens = bladeLengths(prop.blades, d);
      let i = 0;
      for (const c of hub.children) { if (c === blur[k]) continue; c.scale.x = lens[i]; c.rotation.z = d.broken && i === 0 ? 0.35 : 0; i++; }
      blur[k].scale.setScalar(Math.max(...lens));
    });
  };
  return {
    root, props, propDirs: dirs, blur, fpvHidden, setDamage,
    lens: new THREE.Vector3(...lensAt),
    dispose() { for (const d of disp) d.dispose(); },
  };
}
