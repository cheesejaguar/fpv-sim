// "Night Session": a floodlit race course in a park after dark. Eight floodlight towers (MapDef
// lights) light the course, the gates glow with their LED strips and a dashed line of LED markers
// on the grass shows the racing line, so orientation comes from the lit course, not the sky. The
// sky is 'night' (the `sun` is the moon). Ten obstacles over a ~300 m lap, about 25 s for a 5".
import { buildGatePrims } from './gates';
import { box, closedSpline, courseGates, CourseLeg, cyl, slab } from './kit';
import { fbm, MapDef, MapLight, Prim, seededRandom } from './world';

const sstep = (a: number, b: number, x: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** Opening sizes (m): roomy at night. */
export const NIGHT = { square: 1.8, arch: [3.0, 2.6], hurdle: [3.6, 1.8], dive: 2.0, flag: 3.2 } as const;
const STACK = NIGHT.square + 0.12;
const SQ = NIGHT.square;

const COURSE: CourseLeg[] = [
  [-35, -22, 0, 'square', 0, SQ, SQ],                                  // 0 start / finish
  [-8, -24, 0, 'arch', 0, NIGHT.arch[0], NIGHT.arch[1]],               // 1
  [18, -20, 15, 'square', 1.5, SQ, SQ],                                // 2 tower gate on 1.5 m legs
  [44, -12, 90, 'flag', 0, 0.6, NIGHT.flag],                           // 3 flag: round its east side
  [46, 12, 110, 'hurdle', 0, NIGHT.hurdle[0], NIGHT.hurdle[1]],        // 4 hurdle
  [28, 26, 170, 'dive', 3.2, NIGHT.dive, NIGHT.dive],                  // 5 dive gate
  [2, 28, 180, 'square', 0, SQ, SQ],                                   // 6
  [-22, 24, 200, 'ladder', STACK, SQ, SQ, { stack: 2 }],              // 7 two-high ladder: top opening
  [-50, 10, 270, 'flag', 0, 0.6, NIGHT.flag],                          // 8 flag: round its west side
  [-47, -8, 280, 'arch', 0, NIGHT.arch[0], NIGHT.arch[1]],             // 9
];

/** A clean racing line (closed spline control points), used by the tests and for the LED markers. */
export const NIGHT_LINE: [number, number, number][] = [
  [-35, -22, 1.0], [-21.5, -23, 1.0], [-8, -24, 1.2], [5, -22.5, 1.8], [18, -20, 2.4], [31, -16.5, 2.0], [41, -14.5, 1.5],
  [46.5, -12, 1.5], [48.5, -2, 1.4], [46, 12, 0.9], [41, 19.5, 2.2], [35, 23.5, 4.6], [31, 25, 5.0], [28, 26, 3.2], [24, 27, 1.6],
  [13, 28, 1.0], [2, 28, 0.9], [-10, 27, 1.6], [-22, 24, 2.85], [-36, 18, 2.0], [-46, 13.5, 1.5], [-52.5, 10, 1.4],
  [-51.5, 1, 1.3], [-47, -8, 1.2], [-44.5, -16.5, 1.0], [-40.5, -21.5, 1.0],
];

/** Floodlight towers: base position (x, y); the lamp head sits on top, facing the field. */
const TOWERS: [number, number][] = [[-60, -42], [-20, -42], [20, -42], [60, -42], [-60, 42], [-20, 42], [20, 42], [60, 42]];
const TOWER_H = 14;

export function nightMap(): MapDef {
  const rnd = seededRandom(2300);
  const terrain = (x: number, y: number) => {
    const r = Math.max(Math.abs(x) - 80, Math.abs(y) - 55);
    return r > 0 ? sstep(0, 70, r) * (5 + 4 * fbm(x / 70, y / 70, 3, 41)) : 0;
  };
  const gates = courseGates(COURSE);
  const prims: Prim[] = [];
  const decor: Prim[] = [];
  buildGatePrims(gates, prims);

  // --- floodlight towers: mast, lamp head turned to the field, lit lamp faces (MapDef lights) ---
  const lights: MapLight[] = [];
  for (const [x, y] of TOWERS) {
    cyl(prims, x, y, 0, 0.3, TOWER_H, { color: 0x5a6068, tag: 'tower' });
    const yaw = Math.atan2(x, -y); // local +y (lamp face) towards the field centre
    const fx = -Math.sin(yaw), fy = Math.cos(yaw);
    box(prims, x, y, TOWER_H + 0.9, 2.2, 0.35, 0.9, yaw, { visual: 'metal', mat: 'metal', tag: 'lights' });
    for (let r = 0; r < 2; r++) for (let c = 0; c < 3; c++) {
      const lx = -1.4 + c * 1.4, cx = Math.cos(yaw) * lx, cy = Math.sin(yaw) * lx;
      box(decor, x + cx + fx * 0.38, y + cy + fy * 0.38, TOWER_H + 0.45 + r * 0.9, 0.55, 0.03, 0.35, yaw, { visual: 'led', color: 0xf6f4ff, tag: 'flood' });
    }
    lights.push({ pos: { x: x + fx * 1.2, y: y + fy * 1.2, z: TOWER_H + 0.9 }, color: 0xf3f4ff, intensity: 420, range: 90 });
  }

  // --- LED markers on the grass, a dashed pair either side of the racing line ---
  const line = closedSpline(NIGHT_LINE, 1, 0.5);
  const cols = [0x22e3ff, 0xff3df2];
  for (let i = 0; i < line.length; i += 16) {
    const a = line[i], b = line[(i + 1) % line.length], L = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const nx = -(b.y - a.y) / L, ny = (b.x - a.x) / L;
    // skip markers that would sit under a gate frame
    if (gates.some((g) => Math.hypot(a.x - g.c.x, a.y - g.c.y) < 3)) continue;
    for (const s of [-1, 1]) box(decor, a.x + s * nx * 2.6, a.y + s * ny * 2.6, 0.05, 0.05, 0.05, 0.05, Math.atan2(ny, nx), { visual: 'led', color: cols[(i / 16) % 2 | 0] });
  }

  // --- start: pads, an LED screen beside the start gate; pilot box south of the course ---
  const g0 = gates[0];
  const pads = [-1.5, -0.5, 0.5, 1.5].map((k) => g0.c.y + k * 1.3);
  for (const y of pads) box(prims, g0.c.x - 8, y, 0.01, 0.4, 0.4, 0.01, 0, { visual: 'pad', mat: 'wood', tag: 'pad' });
  box(prims, g0.c.x, g0.c.y - 7, 2.6, 2.4, 0.15, 0.9, 0, { visual: 'screen', text: 'NIGHT SESSION|LAP TIMING ON', color: 0x05070d, mat: 'metal', tag: 'screen' });
  for (const s of [-1, 1]) cyl(prims, g0.c.x + s * 2.0, g0.c.y - 7, 0, 0.08, 1.7, { color: 0x3a3f47 });
  const PB = { x: 0, y: -50 };
  slab(prims, PB.x - 5, PB.y - 2, -0.05, PB.x + 5, PB.y + 2, 0.3, { visual: 'wood', mat: 'wood', tag: 'deck' });
  // canopy over the back half of the deck (LED string on its front edge): the pilots stand in front of it
  for (const sx of [-1, 1]) for (const y of [PB.y - 1.7, PB.y + 0.1]) cyl(prims, PB.x + sx * 4.7, y, 0.3, 0.04, 2.5, { color: 0xd0d4d8 });
  box(prims, PB.x, PB.y - 0.8, 2.85, 5, 1.2, 0.05, 0, { visual: 'plain', color: 0x26303b, mat: 'wood', tag: 'canopy' });
  box(decor, PB.x, PB.y + 0.4, 2.78, 4.9, 0.02, 0.02, 0, { visual: 'led', color: 0xffc070, tag: 'string' });

  // dark tree line round the park
  const trees: MapDef['trees'] = [];
  for (let i = 0; i < 110; i++) {
    const a = rnd() * Math.PI * 2, r = 1 + rnd() * 0.5, x = Math.cos(a) * 95 * r, y = Math.sin(a) * 68 * r;
    trees.push({ x, y, h: 10 + rnd() * 9, r: 2.8 + rnd() * 1.8, type: rnd() < 0.5 ? 'pine' : 'oak' });
  }

  return {
    id: 'night', name: 'Night Session — Floodlit race course', size: 110, terrain, groundMat: 'grass', prims, gates, decor,
    spawn: { pos: { x: g0.c.x - 8, y: pads[1], z: 0.02 }, yaw: 0, groundZ: 0.02 },
    pilot: { x: PB.x, y: PB.y + 1.6, z: 0.3 + 1.6 }, // front of the deck, in front of the canopy
    sun: { azimuthDeg: 140, elevationDeg: 28 }, sky: 'night', lights,
    wakeZones: [], elevationM: 60, trees,
  };
}
