// Other pilots' quads: a light procedural model per peer (coloured frame, motors, prop discs that
// fade in with each motor's RPM, ducts on whoops) with a floating name tag. The quads are in the main
// scene, so they appear in the FPV cube-camera view as well as the chase / line-of-sight views; the
// name tags are on layer TAG_LAYER, which the FPV cameras don't render (a real video feed has no
// labels). Paused pilots (menu open) are drawn as a dim ghost.
import * as THREE from 'three';
import type { MultiplayerClient, Peer } from '../net/multiplayer';
import { enuToThree, quatEnuToThree } from './coords';

/** Spectator cameras (chase / line of sight / title orbit) enable this layer; FPV cameras render 0 only. */
export const TAG_LAYER = 2;
// frame sizeClass (src/data/catalog.ts) -> scale vs a 225 mm 5"
const FRAME_SCALE: Record<string, number> = { whoop: 0.31, '3in': 0.62, '5in': 1, '7in': 1.31 };
// prop disc offsets (three body: +x forward, +z right) in Betaflight motor order:
// 1 rear-right, 2 front-right, 3 rear-left, 4 front-left (pose rpm arrives in this order)
const MOTORS: [number, number][] = [[-1, 1], [1, 1], [-1, -1], [1, -1]];

interface Remote { group: THREE.Group; discs: THREE.Mesh[]; tag: THREE.Sprite; solid: THREE.Material[]; paused: boolean | null; drawTag(paused: boolean): void; dispose(): void }

function nameTag(name: string, color: string): { sprite: THREE.Sprite; draw(paused: boolean): void } {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const g = c.getContext('2d')!;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const draw = (paused: boolean) => {
    g.clearRect(0, 0, c.width, c.height);
    g.fillStyle = 'rgba(0,0,0,0.55)';
    g.beginPath(); g.roundRect(4, 8, 248, 48, 12); g.fill();
    g.fillStyle = color; g.fillRect(14, 22, 20, 20);
    g.fillStyle = paused ? '#aab' : '#fff'; g.font = 'bold 28px system-ui, sans-serif'; g.textBaseline = 'middle';
    g.fillText(paused ? `${name.slice(0, 14)} · paused` : name.slice(0, 20), 44, 33, 200);
    tex.needsUpdate = true;
  };
  draw(false);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: true, transparent: true }));
  s.scale.set(0.8, 0.2, 1);
  s.layers.set(TAG_LAYER);
  return { sprite: s, draw };
}

function buildRemote(peer: Peer): Remote {
  const disp: { dispose(): void }[] = [];
  const T = <X extends { dispose(): void }>(x: X) => (disp.push(x), x);
  const k = FRAME_SCALE[peer.info.frame] ?? 1;
  const ky = Math.max(0.55, k); // heights shrink less than spans (a whoop is not a flat 5")
  const group = new THREE.Group();
  const col = new THREE.Color(peer.info.color);
  const frameMat = T(new THREE.MeshStandardMaterial({ color: 0x1b1d20, roughness: 0.5 }));
  const accent = T(new THREE.MeshStandardMaterial({ color: col, roughness: 0.4, emissive: col, emissiveIntensity: 0.25 }));
  const body = new THREE.Mesh(T(new THREE.BoxGeometry(0.11 * k, 0.03 * ky, 0.045 * k)), frameMat);
  const top = new THREE.Mesh(T(new THREE.BoxGeometry(0.075 * k, 0.035 * ky, 0.035 * k)), accent); // battery
  top.position.y = 0.035 * ky;
  group.add(body, top);
  const half = 0.1125 * k * Math.SQRT1_2;
  const discs: THREE.Mesh[] = [];
  const ducted = peer.info.frame === 'whoop';
  for (const [x, z] of MOTORS) {
    const arm = new THREE.Mesh(T(new THREE.BoxGeometry(Math.hypot(half, half) * 1.05, 0.006 * ky, 0.014 * k)), frameMat);
    arm.position.set((x * half) / 2, 0, (z * half) / 2);
    arm.rotation.y = Math.atan2(-z, x);
    const motor = new THREE.Mesh(T(new THREE.CylinderGeometry(0.014 * k, 0.014 * k, 0.014 * ky, 12)), accent);
    motor.position.set(x * half, 0.012 * ky, z * half);
    // each disc has its own material: opacity follows that motor's rpm
    const disc = new THREE.Mesh(T(new THREE.CircleGeometry(0.0635 * k, 24)), T(new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.25, depthWrite: false, side: THREE.DoubleSide })));
    disc.rotation.x = -Math.PI / 2;
    disc.position.set(x * half, 0.024 * ky, z * half);
    group.add(arm, motor, disc);
    if (ducted) {
      const duct = new THREE.Mesh(T(new THREE.CylinderGeometry(0.07 * k, 0.07 * k, 0.03 * ky, 20, 1, true)), frameMat);
      duct.position.set(x * half, 0.02 * ky, z * half);
      group.add(duct);
    }
    discs.push(disc);
  }
  group.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
  const tag = nameTag(peer.info.name, peer.info.color); // world-positioned above the quad (see update)
  disp.push(tag.sprite.material.map!, tag.sprite.material);
  return { group, discs, tag: tag.sprite, solid: [frameMat, accent], paused: null, drawTag: tag.draw, dispose() { for (const d of disp) d.dispose(); } };
}

/** Paused pilots: a see-through ghost (no shadow) with a "paused" tag. */
function setPaused(r: Remote, paused: boolean) {
  if (r.paused === paused) return;
  r.paused = paused;
  for (const m of r.solid) { m.transparent = paused; m.opacity = paused ? 0.3 : 1; m.depthWrite = !paused; m.needsUpdate = true; }
  r.group.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = !paused; });
  (r.tag.material as THREE.SpriteMaterial).opacity = paused ? 0.6 : 1;
  r.drawTag(paused);
}

export class RemoteQuads {
  private remotes = new Map<number, Remote>();
  private tmpQ = new THREE.Quaternion();

  /** Sync meshes with the peer list and place them at their interpolated poses. */
  update(scene: THREE.Scene, mp: MultiplayerClient, now: number): void {
    for (const [id, r] of this.remotes) {
      if (!mp.peers.has(id) || r.group.parent !== scene) { r.group.removeFromParent(); r.tag.removeFromParent(); r.dispose(); this.remotes.delete(id); }
    }
    for (const [id, peer] of mp.peers) {
      let r = this.remotes.get(id);
      if (!r) { r = buildRemote(peer); this.remotes.set(id, r); scene.add(r.group, r.tag); }
      const pose = mp.poseOf(peer, now);
      r.group.visible = r.tag.visible = !!pose;
      if (!pose) continue;
      enuToThree(pose.p[0], pose.p[1], pose.p[2], r.group.position);
      quatEnuToThree(pose.q[0], pose.q[1], pose.q[2], pose.q[3], this.tmpQ);
      r.group.quaternion.copy(this.tmpQ);
      r.tag.position.copy(r.group.position).y += 0.32; // sprites face the camera; keep the tag above
      setPaused(r, pose.h === 1);
      const dim = r.paused ? 0.4 : 1;
      r.discs.forEach((d, i) => { (d.material as THREE.MeshBasicMaterial).opacity = dim * (0.08 + 0.3 * Math.min(1, Math.abs(pose.r[i] ?? 0) / 20000)); });
    }
  }

  clear(): void { for (const r of this.remotes.values()) { r.group.removeFromParent(); r.tag.removeFromParent(); r.dispose(); } this.remotes.clear(); }

  /** Hide every remote quad until the next update() (a lap replay is shown in the same scene). */
  hide(): void { for (const r of this.remotes.values()) r.group.visible = r.tag.visible = false; }
}
