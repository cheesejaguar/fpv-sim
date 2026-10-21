// Conversions between the simulator's ENU world / FLU body frames and Three.js (Y-up, -Z forward).
import * as THREE from 'three';

/** ENU (x east, y north, z up) -> three (x, y up, z south). */
export const enuToThree = (x: number, y: number, z: number, o = new THREE.Vector3()) => o.set(x, z, -y);

const C = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
const Ci = C.clone().invert();

/** Body-to-world quaternion in ENU -> equivalent rotation in three space (body FLU axes mapped too). */
export function quatEnuToThree(w: number, x: number, y: number, z: number, o = new THREE.Quaternion()) {
  o.set(x, y, z, w);
  return o.premultiply(C).multiply(Ci);
}

/**
 * Rotation taking a three camera (looks -Z, up +Y) to the FLU body axes with the given camera
 * uptilt, expressed in three's mapping of the body frame (FLU body mapped via C like the world).
 */
export function cameraMountQuat(uptiltDeg: number): THREE.Quaternion {
  // In three-mapped body space: forward (+x body) = +X, left (+y body) = -Z, up (+z body) = +Y.
  // Camera looks along -Z with up +Y; rotate -90° about Y so it looks along +X.
  const look = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 2);
  // uptilt: pitch the camera nose up about the body's left axis (three -Z): positive about +Z
  const tilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), (uptiltDeg * Math.PI) / 180);
  return tilt.multiply(look);
}
