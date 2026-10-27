// Editor camera: orbit (round a target point: drag, pan, wheel) and fly (WASD, right-drag to look,
// Q / E down / up, Shift fast), both on one state so switching keeps the view. Gamepad: left stick
// moves, right stick looks, triggers go down / up, LB slows, RB speeds up. three.js world space.
import * as THREE from 'three';

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const dz = (x: number) => (Math.abs(x) < 0.15 ? 0 : (x - Math.sign(x) * 0.15) / 0.85);

export class EditorCamera {
  readonly cam = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 8000);
  /** orbit centre (three world) */
  readonly target = new THREE.Vector3();
  /** heading round the up axis and elevation above the target (rad), distance to the target (m) */
  yaw = 0.6; pitch = 0.55; dist = 40;
  mode: 'orbit' | 'fly' = 'orbit';
  private keys = new Set<string>();
  private off = new THREE.Vector3();

  constructor() { this.update(); }

  /** Camera position = target + dist * direction(yaw, pitch). */
  update() {
    const c = Math.cos(this.pitch);
    this.off.set(c * Math.sin(this.yaw), Math.sin(this.pitch), c * Math.cos(this.yaw)).multiplyScalar(this.dist);
    this.cam.position.copy(this.target).add(this.off);
    this.cam.lookAt(this.target);
    if (this.cam.aspect !== innerWidth / innerHeight) { this.cam.aspect = innerWidth / innerHeight; this.cam.updateProjectionMatrix(); }
  }

  /**
   * Turn by a mouse / stick motion (rad; dx > 0 = right, dy > 0 = down): round the target (orbit,
   * the scene follows the hand) or from where the camera is (fly: look right / down).
   */
  turn(dx: number, dy: number, aroundTarget = this.mode === 'orbit') {
    if (aroundTarget) { this.yaw -= dx; this.pitch = clamp(this.pitch + dy, -1.2, 1.53); }
    else {
      const p = this.cam.position.clone();
      this.yaw -= dx; this.pitch = clamp(this.pitch + dy, -1.4, 1.53);
      // keep the eye where it is: the target moves in front of it
      const c = Math.cos(this.pitch);
      this.target.copy(p).sub(this.off.set(c * Math.sin(this.yaw), Math.sin(this.pitch), c * Math.cos(this.yaw)).multiplyScalar(this.dist));
    }
    this.update();
  }

  /** Slide the target in the view plane by screen pixels. */
  pan(dx: number, dy: number, viewH: number) {
    const k = (2 * this.dist * Math.tan((this.cam.fov * Math.PI) / 360)) / viewH;
    const right = new THREE.Vector3().setFromMatrixColumn(this.cam.matrixWorld, 0), up = new THREE.Vector3().setFromMatrixColumn(this.cam.matrixWorld, 1);
    this.target.addScaledVector(right, -dx * k).addScaledVector(up, dy * k);
    this.update();
  }

  /** Wheel: orbit zooms toward the target; fly moves forward. */
  wheel(deltaY: number) {
    if (this.mode === 'orbit') this.dist = clamp(this.dist * Math.exp(deltaY * 0.0012), 0.5, 4000);
    else this.move(new THREE.Vector3(0, 0, -1).applyQuaternion(this.cam.quaternion).multiplyScalar(-deltaY * 0.01 * Math.max(1, this.dist * 0.05)));
    this.update();
  }

  move(v: THREE.Vector3) { this.target.add(v); this.update(); }

  /** Look at a point from about `radius` away, keeping the heading. */
  frame(p: THREE.Vector3, radius: number) { this.target.copy(p); this.dist = clamp(radius * 2.6, 3, 3000); this.update(); }

  key(code: string, down: boolean) { if (down) this.keys.add(code); else this.keys.delete(code); }
  clearKeys() { this.keys.clear(); }

  /** Per frame: held keys and the gamepad. Returns true when the view moved. */
  tick(dt: number, pad: Gamepad | null): boolean {
    const k = this.keys, f = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)), r = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    let fwd = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0), side = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0), up = (k.has('KeyE') ? 1 : 0) - (k.has('KeyQ') ? 1 : 0);
    let fast = k.has('ShiftLeft') || k.has('ShiftRight') ? 4 : 1, look = false;
    if (pad) {
      const a = pad.axes;
      fwd -= dz(a[1] ?? 0); side += dz(a[0] ?? 0); up += (pad.buttons[7]?.value ?? 0) - (pad.buttons[6]?.value ?? 0);
      if (pad.buttons[5]?.pressed) fast *= 4; if (pad.buttons[4]?.pressed) fast *= 0.25;
      const lx = dz(a[2] ?? 0), ly = dz(a[3] ?? 0);
      if (lx || ly) { this.turn(lx * 2.2 * dt, ly * 1.6 * dt, false); look = true; }
    }
    if (!fwd && !side && !up) return look;
    const speed = Math.max(4, this.dist * 0.9) * fast;
    this.move(f.multiplyScalar(fwd * speed * dt).addScaledVector(r, side * speed * dt).add(new THREE.Vector3(0, up * speed * dt, 0)));
    return true;
  }

  save() { return { t: this.target.toArray(), yaw: this.yaw, pitch: this.pitch, dist: this.dist, mode: this.mode }; }
  restore(s: ReturnType<EditorCamera['save']>) { this.target.fromArray(s.t); this.yaw = s.yaw; this.pitch = s.pitch; this.dist = s.dist; this.mode = s.mode; this.update(); }
}
