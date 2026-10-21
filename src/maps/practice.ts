// "Practice Field": a mown field with a lap-timed spec track and three drill areas beside it, each a
// separately timed course (MapDef.courses):
//  - spec track (the default course): a spec-style layout of standard 5' x 5' (1.524 m) gates, a
//    10' x 5' hurdle, a 5' dive gate at 8' (2.44 m), a 3-high ladder and two 3 m flags, ~280 m a lap.
//    Sizes follow the published MultiGP obstacle specs (https://www.multigp.com/), the layout is ours.
//  - slalom: weave a line of seven poles (alternate sides; each pass is an opening beside the pole),
//    round the turn flag and back up the return lane.
//  - figure-8: two gates at the ends of an 8 round two pylons; both are flown southbound, so only a
//    real figure-8 (lobes turned opposite ways) counts, a plain loop does not.
//  - power loop: a tower with a low gate (eastbound) and a high gate (westbound) on the same posts:
//    through the bottom, loop up and back through the top, down and through the bottom again.
// The pilot box sits on the south side, looking north over the spec track.
import { buildGatePrims } from './gates';
import { box, courseGates, CourseLeg, cyl, slab } from './kit';
import { CourseDef, fbm, GateDef, MapDef, Prim, seededRandom } from './world';

const deg = Math.PI / 180;
const sstep = (a: number, b: number, x: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** Standard gate opening (5 ft), hurdle width (10 ft), dive gate height (8 ft), flag height. */
export const SPEC = { gate: 1.524, hurdle: 3.048, dive: 2.44, flag: 3.0 } as const;
const STACK = SPEC.gate + 0.12; // ladder pitch: opening + frame bar
const SQ = SPEC.gate;

const SPEC_TRACK: CourseLeg[] = [
  [-39, 6, 0, 'square', 0, SQ, SQ],                           // 0 start / finish
  [-18, 6, 0, 'square', 0, SQ, SQ],                           // 1
  [4, 7, 5, 'hurdle', 0, SPEC.hurdle, SQ],                    // 2 hurdle
  [24, 10, 15, 'square', 0, SQ, SQ],                          // 3
  [46, 16, 90, 'flag', 0, 0.6, SPEC.flag],                    // 4 flag: round its east side
  [47, 36, 100, 'dive', SPEC.dive, SQ, SQ],                   // 5 dive gate
  [30, 54, 160, 'ladder', 2 * STACK, SQ, SQ, { stack: 3 }],  // 6 ladder: top opening
  [8, 58, 180, 'square', 0, SQ, SQ],                          // 7
  [-14, 52, 200, 'square', 0, SQ, SQ],                        // 8
  [-50, 44, 270, 'flag', 0, 0.6, SPEC.flag],                  // 9 flag: round its west side
];

/** Slalom: start gate, seven poles at x = SLALOM_X (alternate sides), turn flag, return gate. */
const SLALOM_X = -100;
const SLALOM_POLES = [-8, 2, 12, 22, 32, 42, 52];
/** Figure-8 centre, half length (gate to centre) and lobe pylons' offset. */
const F8 = { x: 112, y: 26, a: 30 };
/** Power-loop tower position and the high gate's opening base. */
const PL = { x: 95, y: -40, high: 4.5 };

/** Clean lines through each course (closed spline control points), used by the tests. */
export const PRACTICE_LINES: Record<string, [number, number, number][]> = {
  spec: [
    [-39, 6, 0.8], [-29, 6, 0.8], [-18, 6, 0.8], [-7, 6.3, 0.8], [4, 7, 0.75], [14, 8.2, 0.8], [24, 10, 0.8], [35, 12.5, 1.2],
    [44, 12.5, 1.4], [48.5, 16, 2.0], [49, 24, 3.4], [48.2, 31, 4.5], [47, 36, 2.44], [45.5, 40, 1.5], [39, 49, 3.4], [30, 54, 4.05],
    [19, 57.5, 2.4], [8, 58, 0.8], [-3, 56, 0.8], [-14, 52, 0.8], [-30, 47.5, 1.2], [-44, 47, 1.4], [-53, 44, 1.5], [-53, 32, 1.4],
    [-52, 18, 1.2], [-50, 9, 1.0], [-45.5, 6, 0.85],
  ],
  slalom: [
    [SLALOM_X, -22, 1.0], [SLALOM_X + 1, -15, 1.1],
    ...SLALOM_POLES.map((y, i): [number, number, number] => [SLALOM_X + (i % 2 ? -2 : 2), y, 1.2]),
    [SLALOM_X + 3, 64, 1.4], [SLALOM_X, 71, 1.6], [SLALOM_X - 8, 72, 1.6], [SLALOM_X - 14, 64, 1.4], [SLALOM_X - 15, 50, 1.2],
    [SLALOM_X - 15, 20, 1.0], [SLALOM_X - 15, -10, 1.0], [SLALOM_X - 11, -28, 1.0], [SLALOM_X - 4, -32, 1.0],
  ],
  figure8: Array.from({ length: 16 }, (_, k): [number, number, number] => {
    const t = (k / 16) * 2 * Math.PI + Math.PI / 2; // start at gate A (east end)
    return [F8.x + F8.a * Math.sin(t), F8.y + 26 * Math.sin(t) * Math.cos(t), 0.8];
  }),
  powerloop: [
    [PL.x, PL.y, 0.8], [PL.x + 3, PL.y, 1.4], [PL.x + 4.6, PL.y, 3.2], [PL.x + 3.4, PL.y, 4.9], [PL.x, PL.y, 5.3],
    [PL.x - 3.4, PL.y, 4.9], [PL.x - 4.6, PL.y, 3.2], [PL.x - 3, PL.y, 1.4],
  ],
};

function drillCourses(): CourseDef[] {
  const sq = (id: number, x: number, y: number, hd: number, z = 0): GateDef => ({ id, c: { x, y, z }, yaw: (hd - 90) * deg, kind: 'square', width: SQ, height: SQ });
  const slalom: GateDef[] = [
    sq(100, SLALOM_X, -22, 90),
    // pole i: a 4 m wide, 4 m tall opening beside the pole, on alternate sides (travel north: lat = x - c.x)
    ...SLALOM_POLES.map((y, i): GateDef => ({ id: 101 + i, c: { x: SLALOM_X + (i % 2 ? -2.25 : 2.25), y, z: 0 }, yaw: 0, kind: 'square', width: 4, height: 4 })),
    { id: 108, c: { x: SLALOM_X, y: 64, z: 0 }, yaw: 0, kind: 'flag', width: 0.6, height: SPEC.flag },
    sq(109, SLALOM_X - 15, 20, 270),
  ];
  const figure8: GateDef[] = [sq(200, F8.x + F8.a, F8.y, 270), sq(201, F8.x - F8.a, F8.y, 270)];
  const powerloop: GateDef[] = [sq(300, PL.x, PL.y, 0), sq(301, PL.x, PL.y, 180, PL.high)];
  return [
    { id: 'slalom', name: 'Slalom', gates: slalom, spawn: { pos: { x: SLALOM_X, y: -30, z: 0.02 }, yaw: 90 * deg, groundZ: 0.02 } },
    { id: 'figure8', name: 'Figure-8', gates: figure8, spawn: { pos: { x: F8.x + 18, y: F8.y + 16, z: 0.02 }, yaw: 0, groundZ: 0.02 } },
    { id: 'powerloop', name: 'Power loop', gates: powerloop, spawn: { pos: { x: PL.x - 14, y: PL.y, z: 0.02 }, yaw: 0, groundZ: 0.02 } },
  ];
}

export function practiceMap(): MapDef {
  const rnd = seededRandom(5150);
  const terrain = (x: number, y: number) => {
    // a mown, flat field; gentle country beyond it
    const r = Math.max(Math.abs(x) - 165, Math.abs(y) - 115);
    return r > 0 ? sstep(0, 90, r) * (7 + 5 * fbm(x / 80, y / 80, 3, 21)) : 0;
  };
  const prims: Prim[] = [];
  const decor: Prim[] = [];
  const gates = courseGates(SPEC_TRACK);
  const drills = drillCourses();
  buildGatePrims(gates, prims);

  // --- drill hardware ---
  const [slalom, figure8, powerloop] = drills.map((d) => d.gates);
  buildGatePrims([slalom[0], slalom[8], slalom[9]], prims);
  SLALOM_POLES.forEach((y, i) => {
    const tag = `gate${101 + i}`;
    cyl(prims, SLALOM_X, y, 0, 0.05, 3.2, { mat: 'gate', tag });
    box(prims, SLALOM_X + (i % 2 ? -0.3 : 0.3), y, 2.9, 0.28, 0.012, 0.25, 0, { visual: 'gate', mat: 'foliage', tag }); // pennant on the pass side
  });
  buildGatePrims(figure8, prims);
  for (const s of [-1, 1]) { // lobe pylons
    cyl(prims, F8.x + s * F8.a / 2, F8.y, 0, 0.1, 4, { color: 0xff6a00, tag: 'pylon' });
    box(prims, F8.x + s * F8.a / 2, F8.y - 0.4, 3.0, 0.015, 0.35, 0.8, 0, { visual: 'plain', color: 0xff6a00, mat: 'foliage', tag: 'pylon' });
  }
  buildGatePrims(powerloop, prims);
  cyl(prims, PL.x - 20, PL.y - 20, 0, 0.15, 14, { color: 0x8a8f94, tag: 'pole' }); // a tall pole for free power loops

  // --- signs ---
  const sign = (x: number, y: number, yaw: number, text: string) => {
    box(prims, x, y, 2.4, 1.6, 0.04, 0.4, yaw, { visual: 'banner', text, color: 0x0b1a3a, mat: 'wood', tag: 'sign' });
    for (const s of [-1, 1]) cyl(prims, x + Math.cos(yaw) * s * 1.55, y + Math.sin(yaw) * s * 1.55, 0, 0.04, 2.0, { color: 0x50555c });
  };
  sign(-40, -2, 0, 'SPEC TRACK · START');
  sign(SLALOM_X + 8, -30, 0, 'SLALOM');
  sign(F8.x, F8.y - 22, 0, 'FIGURE 8');
  sign(PL.x, PL.y - 9, 0, 'POWER LOOP');

  // --- start pads behind gate 0, pilot box on the south side ---
  const g0 = gates[0];
  const pads = [-1.5, -0.5, 0.5, 1.5].map((k) => g0.c.y + k * 1.3);
  for (const y of pads) box(prims, g0.c.x - 8, y, 0.01, 0.4, 0.4, 0.01, 0, { visual: 'pad', mat: 'wood', tag: 'pad' });
  for (const d of drills) box(prims, d.spawn!.pos.x, d.spawn!.pos.y, 0.01, 0.4, 0.4, 0.01, 0, { visual: 'pad', mat: 'wood', tag: 'pad' });
  const PB = { x: 0, y: -16 };
  slab(prims, PB.x - 6, PB.y - 2, -0.05, PB.x + 6, PB.y + 2, 0.3, { visual: 'wood', mat: 'wood', tag: 'deck' });
  // canopy over the back half of the deck: the pilots stand in front of it, under open sky
  for (const sx of [-1, 1]) for (const y of [PB.y - 1.7, PB.y + 0.1]) cyl(prims, PB.x + sx * 5.7, y, 0.3, 0.04, 2.5, { color: 0xd0d4d8 });
  box(prims, PB.x, PB.y - 0.8, 2.85, 6, 1.2, 0.05, 0, { visual: 'plain', color: 0xf2f2f2, mat: 'wood', tag: 'canopy' });
  for (let i = 0; i < 4; i++) box(prims, PB.x - 4.5 + i * 3, PB.y - 1, 0.55, 0.25, 0.25, 0.25, 0, { visual: 'plain', color: 0xe23b3b, tag: 'chair' });

  // --- tree belt round the field ---
  const trees: MapDef['trees'] = [];
  for (let i = 0; i < 150; i++) {
    const a = rnd() * Math.PI * 2, r = 1 + rnd() * 0.45, x = Math.cos(a) * 185 * r, y = Math.sin(a) * 135 * r;
    trees.push({ x, y, h: 11 + rnd() * 10, r: 2.8 + rnd() * 2, type: rnd() < 0.5 ? 'pine' : 'oak' });
  }

  return {
    id: 'practice', name: 'Practice Field — Spec track + drills', size: 200, terrain, groundMat: 'grass', prims, gates, decor,
    courses: [{ id: 'spec', name: 'Spec track', gates }, ...drills],
    spawn: { pos: { x: g0.c.x - 8, y: pads[1], z: 0.02 }, yaw: 0, groundZ: 0.02 },
    pilot: { x: PB.x, y: PB.y + 1.6, z: 0.3 + 1.6 }, // front of the deck, in front of the canopy
    sun: { azimuthDeg: 160, elevationDeg: 45 }, sky: 'clear',
    wakeZones: [], elevationM: 90, trees,
  };
}
