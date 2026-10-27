// The viewport's reference grid, as in Unity and Unreal: minor lines at the snap step, major lines
// every ten, the east axis red and the north axis green, anti-aliased in the shader and fading out
// with distance (and where the minor lines would turn into a grey wash). It lies level at the
// ground height under the view centre; terrain above it hides it.
import * as THREE from 'three';

const VERT = /* glsl */ `
varying vec3 vW;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const FRAG = /* glsl */ `
uniform float uMinor;
uniform float uMajor;
uniform float uFade;
uniform vec3 uCentre;
varying vec3 vW;
// 1 on a line of the grid with this spacing, anti-aliased to about one pixel
float lines(vec2 p, float s, float px) {
  vec2 c = p / s, w = fwidth(c);
  vec2 g = abs(fract(c - 0.5) - 0.5) / (w * px);
  return 1.0 - min(min(g.x, g.y), 1.0);
}
void main() {
  vec2 p = vW.xz;
  float d = length(p - uCentre.xz);
  float fade = 1.0 - smoothstep(uFade * 0.35, uFade, d);
  // minor lines thin out before they get closer than a few pixels
  vec2 cw = fwidth(p / uMinor);
  float dense = 1.0 - smoothstep(0.12, 0.3, max(cw.x, cw.y));
  float a = max(lines(p, uMinor, 1.0) * 0.055 * dense, lines(p, uMajor, 1.1) * 0.13);
  vec3 col = vec3(0.86, 0.88, 0.95);
  // axes: east (z = 0 in three) red, north (x = 0) green
  vec2 fw = fwidth(p);
  float east = 1.0 - min(abs(p.y) / (fw.y * 1.6), 1.0), north = 1.0 - min(abs(p.x) / (fw.x * 1.6), 1.0);
  if (east > 0.0) { col = mix(col, vec3(0.94, 0.27, 0.27), east); a = max(a, east * 0.7); }
  if (north > 0.0) { col = mix(col, vec3(0.29, 0.85, 0.42), north); a = max(a, north * 0.7); }
  a *= fade;
  if (a < 0.003) discard;
  gl_FragColor = vec4(col, a);
}`;

export class RefGrid {
  readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private u = { uMinor: { value: 1 }, uMajor: { value: 10 }, uFade: { value: 200 }, uCentre: { value: new THREE.Vector3() } };

  constructor() {
    const mat = new THREE.ShaderMaterial({
      uniforms: this.u, vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      // drawn just above a flat ground at the same height
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    this.mesh.rotation.x = -Math.PI / 2;
    this.mesh.renderOrder = 1;
    this.mesh.name = 'editor-grid';
    this.mesh.frustumCulled = false;
  }

  /**
   * Per frame: centred under the view centre (three world) at the ground height there; step = the
   * snap step (m; 0 = snapping off: 1 m); dist = the camera's distance to its target.
   */
  update(centre: THREE.Vector3, groundY: number, step: number, dist: number) {
    const minor = step >= 0.05 ? step : 1, major = minor * 10;
    const fade = Math.min(6000, Math.max(60, dist * 7)), size = fade * 2.2;
    this.u.uMinor.value = minor; this.u.uMajor.value = major; this.u.uFade.value = fade;
    this.u.uCentre.value.set(centre.x, groundY, centre.z);
    // the plane moves in whole major cells, so its edges never swim (the lines come from world positions)
    this.mesh.position.set(Math.round(centre.x / major) * major, groundY + 0.005, Math.round(centre.z / major) * major);
    this.mesh.scale.set(size, size, 1);
  }

  dispose() { this.mesh.geometry.dispose(); this.mesh.material.dispose(); }
}
