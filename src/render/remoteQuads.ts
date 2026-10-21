// Other pilots' quads: a light procedural model per peer (coloured frame, motors, prop discs that
// fade in with RPM) with a floating name tag. Added to the main scene, so they appear in the FPV
// cube-camera view as well as the chase / line-of-sight views.
import * as THREE from 'three';
import type { MultiplayerClient, Peer } from '../net/multiplayer';
import { enuToThree, quatEnuToThree } from './coords';

const FRAME_SCALE: Record<string, number> = { '3in': 0.6, '5in': 1, '7in': 1.3 };

interface Remote { group: THREE.Group; discs: THREE.Mesh[]; tag: THREE.Sprite; dispose(): void }

function nameTag(name: string, color: string): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = 'rgba(0,0,0,0.55)';
  g.beginPath(); g.roundRect(4, 8, 248, 48, 12); g.fill();
  g.fillStyle = color; g.fillRect(14, 22, 20, 20);
  g.fillStyle = '#fff'; g.font = 'bold 28px system-ui, sans-serif'; g.textBaseline = 'middle';
  g.fillText(name.slice(0, 20), 44, 33, 200);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: true, transparent: true }));
  s.scale.set(0.8, 0.2, 1);
  return s;
}

function buildRemote(peer: Peer): Remote {
  const disp: { dispose(): void }[] = [];
  const T = <X extends { dispose(): void }>(x: X) => (disp.push(x), x);
  const k = FRAME_SCALE[peer.info.frame] ?? 1;
  const group = new THREE.Group();
  const col = new THREE.Color(peer.info.color);
  const frameMat = T(new THREE.MeshStandardMaterial({ color: 0x1b1d20, roughness: 0.5 }));
  const accent = T(new THREE.MeshStandardMaterial({ color: col, roughness: 0.4, emissive: col, emissiveIntensity: 0.25 }));
  const discMat = T(new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.25, depthWrite: false, side: THREE.DoubleSide }));
  const body = new THREE.Mesh(T(new THREE.BoxGeometry(0.11 * k, 0.03, 0.045 * k)), frameMat);
  const top = new THREE.Mesh(T(new THREE.BoxGeometry(0.075 * k, 0.035, 0.035 * k)), accent); // battery
  top.position.y = 0.035;
  group.add(body, top);
  const half = 0.1125 * k * Math.SQRT1_2;
  const discs: THREE.Mesh[] = [];
  for (const [x, z] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const arm = new THREE.Mesh(T(new THREE.BoxGeometry(Math.hypot(half, half) * 1.05, 0.006, 0.014 * k)), frameMat);
    arm.position.set((x * half) / 2, 0, (z * half) / 2);
    arm.rotation.y = Math.atan2(-z, x);
    const motor = new THREE.Mesh(T(new THREE.CylinderGeometry(0.014 * k, 0.014 * k, 0.014, 12)), accent);
    motor.position.set(x * half, 0.012, z * half);
    const disc = new THREE.Mesh(T(new THREE.CircleGeometry(0.0635 * k, 24)), discMat);
    disc.rotation.x = -Math.PI / 2;
    disc.position.set(x * half, 0.024, z * half);
    group.add(arm, motor, disc);
    discs.push(disc);
  }
  group.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
  const tag = nameTag(peer.info.name, peer.info.color); // world-positioned above the quad (see update)
  disp.push(tag.material.map!, tag.material);
  return { group, discs, tag, dispose() { for (const d of disp) d.dispose(); } };
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
      const spin = Math.min(1, Math.abs(pose.r) / 20000);
      for (const d of r.discs) (d.material as THREE.MeshBasicMaterial).opacity = 0.08 + 0.3 * spin;
    }
  }

  clear(): void { for (const r of this.remotes.values()) { r.group.removeFromParent(); r.tag.removeFromParent(); r.dispose(); } this.remotes.clear(); }
}
