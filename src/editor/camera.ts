// Editor camera, as in Unity and Unreal: hold the right button to look around and fly (WASD, Q / E
// down / up, Shift faster, the wheel sets the speed), Alt + left drag orbits round the view centre,
// the middle button pans, the wheel zooms toward the cursor. Perspective, or orthographic for the
// top and side views (snapped from the axis gizmo). Gamepad: left stick moves, right stick looks,
// triggers go down / up, LB slows, RB speeds up. three.js world space (y up, -z north).
//
// The panels cover parts of the screen: the projection is offset so the view centre (orbit target,
// framing, the axis gizmo's views) is the middle of the visible viewport, not of the window.
import * as THREE from 'three';

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const dz = (x: number) => (Math.abs(x) < 0.15 ? 0 : (x - Math.sign(x) * 0.15) / 0.85);
/** highest elevation: just short of straight down (lookAt needs a horizontal hint) */
const TOP = Math.PI / 2 - 1e-3;
const ease = (t: number) => 1 - Math.pow(1 - t, 3);
const NO_KEYS: ReadonlySet<string> = new Set();

export type View = 'top' | 'bottom' | 'north' | 'south' | 'east' | 'west';
interface Pose { t: THREE.Vector3; yaw: number; pitch: number; dist: number }

export class EditorCamera {
  readonly persp = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 8000);
  readonly ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 20000);
  /** orbit centre (three world) */
  readonly target = new THREE.Vector3();
  /** heading round the up axis and elevation above the target (rad), distance to the target (m) */
  yaw = 0.6; pitch = 0.55; dist = 40;
  /** orthographic projection (top and side views) */
  orthographic = false;
  /** right-drag: look and fly, or orbit round the target */
  rightDrag: 'fly' | 'orbit' = 'fly';
  /** fly speed multiplier */
  speed = 1;
  /** the right button is held: WASD / Q / E fly */
  flying = false;
  private keys = new Set<string>();
  private off = new THREE.Vector3();
  private anim: { from: Pose; to: Pose; t: number; dur: number } | null = null;
  /** visible viewport inside the window (CSS px) */
  private vp = { x: 0, y: 0, w: innerWidth, h: innerHeight };

  constructor() { this.update(); }

  /** The camera in use. */
  get cam(): THREE.PerspectiveCamera | THREE.OrthographicCamera { return this.orthographic ? this.ortho : this.persp; }

  /** Where the 3D view is visible (the rest of the window is covered by panels). */
  setViewport(x: number, y: number, w: number, h: number) {
    this.vp = { x, y, w: Math.max(1, w), h: Math.max(1, h) };
    this.update();
  }

  /** Camera position = target + dist * direction(yaw, pitch). */
  update() {
    const c = Math.cos(this.pitch);
    this.off.set(c * Math.sin(this.yaw), Math.sin(this.pitch), c * Math.cos(this.yaw));
    const W = innerWidth, H = innerHeight, aspect = W / H;
    // the view centre lands in the middle of the visible viewport
    const sx = W / 2 - (this.vp.x + this.vp.w / 2), sy = H / 2 - (this.vp.y + this.vp.h / 2);
    const p = this.persp;
    p.position.copy(this.target).addScaledVector(this.off, this.dist);
    p.lookAt(this.target);
    p.aspect = aspect;
    p.setViewOffset(W, H, sx, sy, W, H);
    const o = this.ortho, halfH = this.dist * Math.tan((p.fov * Math.PI) / 360);
    o.left = -halfH * aspect; o.right = halfH * aspect; o.top = halfH; o.bottom = -halfH;
    // far back along the view direction, so nothing in front of the target is clipped
    o.position.copy(this.target).addScaledVector(this.off, Math.max(this.dist, 3000));
    o.lookAt(this.target);
    o.setViewOffset(W, H, sx, sy, W, H);
    p.updateMatrixWorld(); o.updateMatrixWorld();
  }

  /**
   * Turn by a mouse / stick motion (rad; dx > 0 = right, dy > 0 = down): round the target (orbit,
   * the scene follows the hand) or from where the camera is (look right / down).
   */
  turn(dx: number, dy: number, aroundTarget: boolean) {
    this.anim = null;
    const max = this.orthographic ? TOP : 1.53;
    if (aroundTarget) { this.yaw -= dx; this.pitch = clamp(this.pitch + dy, -1.2, max); }
    else {
      const eye = this.persp.position.clone();
      this.yaw -= dx; this.pitch = clamp(this.pitch + dy, -1.4, max);
      // keep the eye where it is: the target moves in front of it
      const c = Math.cos(this.pitch);
      this.target.copy(eye).sub(this.off.set(c * Math.sin(this.yaw), Math.sin(this.pitch), c * Math.cos(this.yaw)).multiplyScalar(this.dist));
    }
    this.update();
  }

  /** Slide the target in the view plane by screen pixels. */
  pan(dx: number, dy: number) {
    this.anim = null;
    const k = (2 * this.dist * Math.tan((this.persp.fov * Math.PI) / 360)) / innerHeight;
    const right = new THREE.Vector3().setFromMatrixColumn(this.cam.matrixWorld, 0), up = new THREE.Vector3().setFromMatrixColumn(this.cam.matrixWorld, 1);
    this.target.addScaledVector(right, -dx * k).addScaledVector(up, dy * k);
    this.update();
  }

  /**
   * Wheel: zoom (toward `toward`, the point under the cursor, when given), or while flying move
   * forward. Returns nothing; the speed while flying is the editor's (it steps `speed`).
   */
  wheel(deltaY: number, toward?: THREE.Vector3 | null) {
    this.anim = null;
    const f = Math.exp(clamp(deltaY, -300, 300) * 0.0012), d = clamp(this.dist * f, 0.5, 4000);
    // the point under the cursor stays under it: the target slides toward it by the same factor
    if (toward && d !== this.dist) this.target.lerp(toward, 1 - d / this.dist);
    this.dist = d;
    this.update();
  }

  move(v: THREE.Vector3) { this.anim = null; this.target.add(v); this.update(); }

  /** Look at a point from about `radius` away, keeping the heading (animated). */
  frame(p: THREE.Vector3, radius: number) { this.animateTo({ t: p.clone(), yaw: this.yaw, pitch: this.pitch, dist: clamp(radius * 2.6, 3, 3000) }); }

  /** Snap to a view along an axis (animated): the top view looks straight down with north up. */
  view(v: View, ortho = this.orthographic) {
    const pose: Pose = { t: this.target.clone(), yaw: this.yaw, pitch: this.pitch, dist: this.dist };
    switch (v) {
      case 'top': pose.pitch = TOP; pose.yaw = 0; break;
      case 'bottom': pose.pitch = -1.2; break;
      // looking toward the named direction: "north" looks north (the camera is south of the target)
      case 'north': pose.pitch = 0; pose.yaw = 0; break;
      case 'south': pose.pitch = 0; pose.yaw = Math.PI; break;
      case 'east': pose.pitch = 0; pose.yaw = -Math.PI / 2; break;
      case 'west': pose.pitch = 0; pose.yaw = Math.PI / 2; break;
    }
    // the shortest way round
    pose.yaw = this.yaw + (((pose.yaw - this.yaw + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    this.orthographic = ortho;
    this.animateTo(pose);
  }

  private animateTo(to: Pose, dur = 0.28) {
    if (matchMedia?.('(prefers-reduced-motion: reduce)').matches) dur = 0;
    this.anim = { from: { t: this.target.clone(), yaw: this.yaw, pitch: this.pitch, dist: this.dist }, to, t: 0, dur };
    if (!dur) this.step(1);
  }

  private step(u: number) {
    const a = this.anim!, k = ease(u);
    this.target.lerpVectors(a.from.t, a.to.t, k);
    this.yaw = a.from.yaw + (a.to.yaw - a.from.yaw) * k; this.pitch = a.from.pitch + (a.to.pitch - a.from.pitch) * k;
    this.dist = Math.exp(Math.log(a.from.dist) + (Math.log(a.to.dist) - Math.log(a.from.dist)) * k);
    if (u >= 1) this.anim = null;
    this.update();
  }

  key(code: string, down: boolean) { if (down) this.keys.add(code); else this.keys.delete(code); }
  clearKeys() { this.keys.clear(); }

  /** Per frame: the framing animation, held keys (while flying) and the gamepad. Returns true when the view moved. */
  tick(dt: number, pad: Gamepad | null): boolean {
    let moved = false;
    if (this.anim) { this.anim.t += dt; this.step(Math.min(1, this.anim.dur ? this.anim.t / this.anim.dur : 1)); moved = true; }
    const k: ReadonlySet<string> = this.flying ? this.keys : NO_KEYS, f = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)), r = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    // flying moves along the view direction (up / down included), as in Unity and Unreal
    if (this.flying) f.set(0, 0, -1).applyQuaternion(this.persp.quaternion);
    let fwd = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0), side = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0), up = (k.has('KeyE') ? 1 : 0) - (k.has('KeyQ') ? 1 : 0);
    let fast = k.has('ShiftLeft') || k.has('ShiftRight') ? 3 : 1;
    if (pad) {
      const a = pad.axes;
      fwd -= dz(a[1] ?? 0); side += dz(a[0] ?? 0); up += (pad.buttons[7]?.value ?? 0) - (pad.buttons[6]?.value ?? 0);
      if (pad.buttons[5]?.pressed) fast *= 4;
      if (pad.buttons[4]?.pressed) fast *= 0.25;
      const lx = dz(a[2] ?? 0), ly = dz(a[3] ?? 0);
      if (lx || ly) { this.turn(lx * 2.2 * dt, ly * 1.6 * dt, false); moved = true; }
    }
    if (!fwd && !side && !up) return moved;
    const speed = Math.max(4, this.dist * 0.9) * fast * this.speed;
    this.move(f.multiplyScalar(fwd * speed * dt).addScaledVector(r, side * speed * dt).add(new THREE.Vector3(0, up * speed * dt, 0)));
    return true;
  }

  save() { return { t: this.target.toArray(), yaw: this.yaw, pitch: this.pitch, dist: this.dist, ortho: this.orthographic }; }
  restore(s: Partial<ReturnType<EditorCamera['save']>> & { t: number[] }) {
    this.target.fromArray(s.t); this.yaw = s.yaw ?? this.yaw; this.pitch = s.pitch ?? this.pitch; this.dist = s.dist ?? this.dist; this.orthographic = !!s.ortho;
    this.update();
  }
}
