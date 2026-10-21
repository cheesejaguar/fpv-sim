// "Whoop Gym": the first map for tiny whoops. A 25 x 15 x 6 m school sports hall with a timed
// tiny-whoop course: thin 0.7-0.8 m gates, under a table, through a hoop, over a bar, round a
// flag, up onto the gallery, down the staircase and through a dive gate. Free hoops hang from the
// roof trusses, chairs and a basketball rim are there for freestyle lines. No wind indoors.
//
// Sizes: a 65 mm whoop is ~9 cm across its ducts, so a 0.7 m opening is ~7 craft wide (the
// "tiny whoop" gates sold for living-room racing are 0.3-0.6 m); a real basketball rim is
// 0.457 m across at 3.05 m. The south wall has a row of open clerestory windows (sun patches on
// the floor); the eight ceiling fixtures are MapDef lights.
import { buildGatePrims } from './gates';
import { beam, box, cyl, headingYaw, hoop, rim, slab, tiles } from './kit';
import { GateDef, MapDef, MapLight, Prim } from './world';

/** Interior half extents (m) and ceiling height. */
export const GYM = { x: 12.5, y: 7.5, h: 6, gallery: 3.0 } as const;
const WHOOP_T = 0.02; // gate tube half thickness: 4 cm tube

/** The timed course (ids in order). */
function gymGates(): GateDef[] {
  const g = (id: number, x: number, y: number, hd: number, kind: GateDef['kind'], z: number, w: number, h: number, extra: Partial<GateDef> = {}): GateDef =>
    ({ id, c: { x, y, z }, yaw: headingYaw(hd), kind, width: w, height: h, tube: WHOOP_T, ...extra });
  return [
    g(0, -7.5, -5, 0, 'square', 0.3, 0.7, 0.7),        // start / finish
    g(1, -3.5, -5, 0, 'hurdle', 0, 1.5, 0.6),           // under the table
    g(2, 1, -4.8, 0, 'arch', 0.85, 0.8, 0.8),           // hoop on a stand (round opening)
    g(3, 5.5, -4.8, 0, 'square', 0.92, 1.3, 1.0),       // over the bar
    g(4, 9.8, -2.3, 90, 'flag', 0, 0.6, 2.0),           // round the flag, then climb
    g(5, 6, 6.25, 180, 'square', GYM.gallery, 0.8, 0.8), // gate on the gallery
    g(6, -5, 6.75, 180, 'square', 0.3, 0.7, 0.7),       // at the foot of the stairs
    g(7, -10, 2.5, 270, 'dive', 1.3, 0.8, 0.8),         // dive gate
  ];
}

/**
 * A clean line round the course (closed spline control points, x y z), used by the tests to prove the
 * lap is flyable for a whoop: clear of every obstacle, every gate counted in order.
 */
export const GYM_LINE: [number, number, number][] = [
  [-7.5, -5, 0.65], [-5.6, -5, 0.45], [-3.5, -5, 0.32], [-1.3, -4.9, 0.8], [1, -4.8, 1.25], [3.3, -4.8, 1.45], [5.5, -4.8, 1.35],
  [7.8, -4.5, 1.3], [10, -3.6, 1.3], [10.9, -2.3, 1.5], [11, -0.5, 2.0], [10.8, 2, 2.8], [10.2, 4.3, 3.45], [9, 5.8, 3.45],
  [7.6, 6.25, 3.4], [6, 6.25, 3.4], [3.5, 6.5, 3.45], [1.5, 6.75, 3.45], [-1, 6.75, 2.2], [-3, 6.75, 1.05], [-5, 6.75, 0.65],
  [-7.2, 6.4, 1.2], [-9.2, 5.3, 1.8], [-10, 3.6, 1.75], [-10, 2.5, 1.3], [-10.1, 1.2, 0.9], [-10.5, -1, 0.8], [-10.3, -3.3, 0.7],
  [-9.3, -4.7, 0.65],
];

export function gymMap(): MapDef {
  const { x: X, y: Y, h: H } = GYM;
  const prims: Prim[] = [];
  const decor: Prim[] = [];
  const gates = gymGates();

  // --- shell: block walls, a row of open clerestory windows in the south wall, flat roof ---
  // Walls come in ~2 m pieces (the hall uses a 2 m collision grid: a whoop resting on the floor
  // queries ~50 collider spheres, each against the few prims listed in its cell); the roof is one
  // box, listed once in every cell.
  // painted block walls: a darker dado up to 2 m, light above
  const wall = { visual: 'plain' as const, color: 0xd9d6cc, tag: 'wall' }, dado = { ...wall, color: 0x6f86a3 }, P = 2;
  const shell = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => {
    if (z0 < 2) tiles(prims, x0, y0, z0, x1, y1, Math.min(2, z1), dado, P, P);
    if (z1 > 2) tiles(prims, x0, y0, Math.max(2, z0), x1, y1, z1, wall, P, P);
  };
  shell(-X - 0.2, Y, 0, X + 0.2, Y + 0.2, H);                                       // north
  shell(-X - 0.2, -Y - 0.2, 0, X + 0.2, -Y, 4.0);                                   // south, below the windows
  shell(-X - 0.2, -Y - 0.2, 5.4, X + 0.2, -Y, H);                                   // south lintel
  for (let i = 0; i <= 8; i++) box(prims, -X + (i * 2 * X) / 8, -Y - 0.1, 4.7, 0.3, 0.1, 0.7, 0, wall); // window piers
  for (const s of [-1, 1]) shell(Math.min(s * X, s * (X + 0.2)), -Y, 0, Math.max(s * X, s * (X + 0.2)), Y, H); // end walls
  slab(prims, -X - 0.2, -Y - 0.2, H, X + 0.2, Y + 0.2, H + 0.2, { visual: 'metal', mat: 'metal', tag: 'roof' });  // steel deck roof
  // steel roof trusses across the hall, LED high-bay fixtures between them
  for (const x of [-X / 2, 0, X / 2]) tiles(prims, x - 0.1, -Y, H - 0.35, x + 0.1, Y, H - 0.05, { visual: 'metal', mat: 'metal', tag: 'truss' }, P);
  const lights: MapLight[] = [];
  for (const x of [-0.75 * X, -0.25 * X, 0.25 * X, 0.75 * X]) for (const y of [-3.2, 3.2]) {
    box(prims, x, y, 5.42, 0.62, 0.17, 0.03, 0, { visual: 'metal', mat: 'metal', tag: 'fixture' });
    box(prims, x, y, 5.36, 0.6, 0.15, 0.03, 0, { visual: 'led', color: 0xfff6e8, mat: 'metal', tag: 'fixture' });
    for (const dx of [-0.5, 0.5]) cyl(prims, x + dx, y, 5.45, 0.006, H - 5.45);
    lights.push({ pos: { x, y, z: 5.25 }, color: 0xfff1dc, intensity: 18, range: 18 });
  }
  // floor (collision is the flat terrain at 0, maple boards drawn on top) and the yard outside
  slab(decor, -X, -Y, -0.05, X, Y, 0, { visual: 'wood', mat: 'wood' });
  const yard = { visual: 'concrete' as const };
  slab(decor, -60, -60, -0.05, 60, -Y - 0.2, 0, yard); slab(decor, -60, Y + 0.2, -0.05, 60, 60, 0, yard);
  slab(decor, -60, -Y - 0.2, -0.05, -X - 0.2, Y + 0.2, 0, yard); slab(decor, X + 0.2, -Y - 0.2, -0.05, 60, Y + 0.2, 0, yard);
  // court lines: boundary, half-way line, centre circle
  const line = { visual: 'plain' as const, color: 0xf2f2f2 };
  for (const s of [-1, 1]) { box(decor, s * (X - 0.6), 0, 0.003, 0.025, Y - 0.6, 0.001, 0, line); box(decor, 0, s * (Y - 0.6), 0.003, X - 0.6, 0.025, 0.001, 0, line); }
  box(decor, 0, 0, 0.003, 0.025, Y - 0.6, 0.001, 0, line);
  for (let i = 0; i < 24; i++) { const a = (i / 24) * 2 * Math.PI; box(decor, 1.8 * Math.cos(a), 1.8 * Math.sin(a), 0.003, 0.025, 0.24, 0.001, a, line); }
  // safety pads on the end walls, a door and exit sign in the north wall
  for (const s of [-1, 1]) tiles(prims, s * (X - 0.06), -Y + 0.1, 0, s * X, Y - 0.1, 2.0, { visual: 'plain', color: 0x1f4e9c, mat: 'wood', tag: 'pad' }, P);
  slab(decor, -10, Y - 0.03, 0, -8, Y, 2.2, { visual: 'plain', color: 0x5b6470 });
  box(decor, -9, Y - 0.04, 2.45, 0.2, 0.02, 0.08, 0, { visual: 'led', color: 0x2bd96b });

  // --- gallery along the north wall (3 m up), reached by a staircase; open at its east end ---
  const G = GYM.gallery;
  tiles(prims, 1.5, 5.0, G - 0.15, X, Y, G, { visual: 'plain', color: 0x9aa0a6, tag: 'gallery' }, P);
  for (const x of [1.8, 6.5, 11.0]) cyl(prims, x, 5.2, 0, 0.12, G - 0.15, { color: 0x9aa3ad });
  for (let x = 1.55; x <= 8.6; x += 1.0) cyl(prims, x, 5.05, G, 0.02, 1.0, { color: 0x3a3f47 });
  for (const z of [G + 0.5, G + 1.0]) { box(prims, 3.3, 5.05, z, 1.775, 0.025, 0.025, 0, { visual: 'metal', mat: 'metal' }); box(prims, 6.85, 5.05, z, 1.775, 0.025, 0.025, 0, { visual: 'metal', mat: 'metal' }); }
  cyl(prims, 1.55, 6.05, G, 0.02, 1.0, { color: 0x3a3f47 });
  box(prims, 1.55, 5.55, G + 1.0, 0.025, 0.5, 0.025, 0, { visual: 'metal', mat: 'metal' });
  // open-riser stairs (you can fly under them) from the floor at x = -4 up to the gallery at x = 1.5
  const STEPS = 12, RUN = 5.5 / STEPS, RISE = G / STEPS, x0 = -4.0;
  for (let i = 0; i < STEPS; i++) box(prims, x0 + (i + 0.5) * RUN, 6.75, (i + 1) * RISE - 0.025, RUN / 2 + 0.01, 0.65, 0.025, 0, { visual: 'wood', mat: 'wood', tag: 'stairs' });
  const nose = (i: number) => ({ x: x0 + i * RUN, z: (i + 1) * RISE }); // front edge of tread i
  beam(prims, { x: nose(0).x, y: 6.06, z: nose(0).z - 0.2 }, { x: nose(STEPS - 1).x, y: 6.06, z: nose(STEPS - 1).z - 0.2 }, 0.02, 0.12, { tag: 'stairs' });
  beam(prims, { x: nose(0).x, y: 6.06, z: nose(0).z + 0.9 }, { x: nose(STEPS - 1).x, y: 6.06, z: nose(STEPS - 1).z + 0.9 }, 0.025, 0.025, { tag: 'stairs' });
  for (const i of [0, 4, 8]) cyl(prims, nose(i).x + RUN / 2, 6.06, nose(i).z - 0.05, 0.02, 0.95, { color: 0x3a3f47 });
  // stacked mats under the gallery
  box(prims, 10.5, 6.3, 0.35, 1.0, 0.9, 0.35, 0, { visual: 'plain', color: 0x2f5fb3, mat: 'wood', tag: 'mats' });

  // --- the timed course ---
  const floor = () => 0;
  for (const gd of gates) {
    if (gd.id === 1 || gd.id === 2 || gd.id === 3) continue; // built below: table, hoop, bar
    buildGatePrims([gd], prims, gd.id === 5 ? () => G : floor);
  }
  const T = (id: number) => ({ tag: `gate${id}`, mat: 'gate' as const, visual: 'gate' as const });
  // 1: table to fly under; the aprons under the top edges are the lit "gate"
  const table = (cx: number, cy: number, yaw: number, gid?: number) => {
    const c = Math.cos(yaw), s = Math.sin(yaw), at = (lx: number, ly: number) => [cx + c * lx - s * ly, cy + s * lx + c * ly] as const;
    box(prims, cx, cy, 0.74, 0.9, 0.45, 0.02, yaw, { visual: 'wood', mat: 'wood', tag: 'table' }); // 1.8 across x 0.9 along travel
    for (const lx of [-0.85, 0.85]) for (const ly of [-0.4, 0.4]) { const [x, y] = at(lx, ly); cyl(prims, x, y, 0, 0.025, 0.72, { color: 0x50555c }); }
    if (gid !== undefined) for (const ly of [-0.44, 0.44]) { const [x, y] = at(0, ly); box(prims, x, y, 0.68, 0.8, 0.01, 0.04, yaw, T(gid)); }
  };
  table(gates[1].c.x, gates[1].c.y, gates[1].yaw, 1);
  // 2: hoop on a stand
  const g2 = gates[2], r2 = g2.width / 2;
  hoop(prims, { x: g2.c.x, y: g2.c.y, z: g2.c.z + r2 }, g2.yaw, r2, 0.025, T(2));
  cyl(prims, g2.c.x, g2.c.y, 0, 0.02, g2.c.z - 0.05, { mat: 'gate', tag: 'gate2' });
  box(prims, g2.c.x, g2.c.y, 0.01, 0.2, 0.2, 0.01, g2.yaw, { visual: 'metal', mat: 'metal', tag: 'gate2' });
  // 3: bar to fly over, between two standards
  const g3 = gates[3], c3 = Math.cos(g3.yaw), s3 = Math.sin(g3.yaw);
  for (const lx of [-0.7, 0.7]) {
    cyl(prims, g3.c.x + c3 * lx, g3.c.y + s3 * lx, 0, 0.02, 2.0, { mat: 'gate', tag: 'gate3' });
    box(prims, g3.c.x + c3 * lx, g3.c.y + s3 * lx, 0.01, 0.15, 0.15, 0.01, g3.yaw, { visual: 'metal', mat: 'metal', tag: 'gate3' });
  }
  box(prims, g3.c.x, g3.c.y, g3.c.z - 0.035, 0.72, 0.015, 0.015, g3.yaw, T(3));

  // --- freestyle props ---
  // hoops hanging from the roof on ropes
  for (const [x, y, z, hd, color] of [[-1.5, 1.0, 2.5, 0, 0xffb000], [3.0, 1.0, 2.2, 90, 0x00b4d8]] as const) {
    hoop(prims, { x, y, z }, headingYaw(hd), 0.5, 0.025, { color, tag: 'hoop' });
    cyl(prims, x, y, z + 0.55, 0.008, H - (z + 0.55), { color: 0xc8b48a });
  }
  // basketball board and rim on the west wall (3.05 m, 0.457 m rim)
  box(prims, -X + 0.8, 0, 3.425, 0.015, 0.9, 0.525, 0, { visual: 'plain', color: 0xf4f4f4, mat: 'wood', tag: 'board' });
  for (const y of [-0.5, 0.5]) box(prims, -X + 0.4, y, 3.5, 0.4, 0.03, 0.03, 0, { visual: 'metal', mat: 'metal' });
  rim(prims, { x: -X + 0.8 + 0.015 + 0.15 + 0.2286, y: 0, z: 3.05 }, 0.2286, 0.01, { color: 0xe8541c, tag: 'rim' });
  box(prims, -X + 0.8 + 0.1, 0, 3.05, 0.085, 0.04, 0.015, 0, { visual: 'metal', mat: 'metal' });
  // a row of chairs (under the seats, between the legs), a second table, plyo boxes
  for (let i = 0; i < 5; i++) {
    const x = -7 + i, y = 2.2, red = { visual: 'plain' as const, color: 0xc0392b, mat: 'wood' as const, tag: 'chair' };
    box(prims, x, y, 0.45, 0.21, 0.21, 0.015, 0, red);
    box(prims, x, y + 0.2, 0.675, 0.21, 0.012, 0.2, 0, red);
    for (const dx of [-0.18, 0.18]) for (const dy of [-0.18, 0.18]) cyl(prims, x + dx, y + dy, 0, 0.012, 0.44, { color: 0x2b2b2b });
  }
  table(1.5, -0.8, headingYaw(90));
  box(prims, 6.5, 1.5, 0.15, 0.5, 0.3, 0.15, 0, { visual: 'plain', color: 0x2b2f36, mat: 'wood', tag: 'plyo' });
  box(prims, 6.5, 1.5, 0.45, 0.45, 0.28, 0.15, 0, { visual: 'plain', color: 0x39424d, mat: 'wood', tag: 'plyo' });
  box(prims, 6.5, 1.5, 0.75, 0.4, 0.26, 0.15, 0, { visual: 'plain', color: 0x4a5561, mat: 'wood', tag: 'plyo' });
  // start pad behind gate 0
  box(prims, -9.5, -5, 0.005, 0.15, 0.15, 0.005, 0, { visual: 'pad', mat: 'wood', tag: 'pad' });

  // a few trees in the yard (seen through the windows)
  const trees: MapDef['trees'] = [[-20, -16], [-6, -18], [9, -17], [22, -15], [-24, 14], [18, 16]].map(([x, y], i) => ({ x, y, h: 9 + (i % 3) * 2, r: 2.6 + (i % 2) * 0.6, type: i % 3 === 1 ? 'pine' : 'oak' }));

  return {
    id: 'gym', name: 'Whoop Gym — Indoor tiny-whoop course', size: 30, terrain: () => 0, ground: false, groundMat: 'wood', prims, gates, decor,
    spawn: { pos: { x: -9.5, y: -5, z: 0.02 }, yaw: 0, groundZ: 0.01 },
    pilot: { x: -11.6, y: -6.6, z: 1.6 },
    sun: { azimuthDeg: 175, elevationDeg: 38 }, sky: 'clear', windScale: 0, collisionCell: 2,
    wakeZones: [], elevationM: 120, trees, lights,
  };
}
