// "Meadow Park": an open field of about 400 x 300 m for cruising and freestyle. Rolling meadow
// to the north, flat sports fields to the south; tree lines along the edges, an avenue whose trees
// leave gaps to thread, lone oaks to orbit, a small grove, a picnic shelter to fly under, football
// goals, a few free-standing poles (no power lines anywhere) and a small car park. The pilot box
// is a raised deck by the car park with a clear view north-east over the whole field.
import { bakeHeightfield, beam, box, cyl, slab, tiles } from './kit';
import { fbm, MapDef, Prim, seededRandom } from './world';

const deg = Math.PI / 180;
const sstep = (a: number, b: number, x: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** Flat areas (x0, y0, x1, y1): car park + pilot box, sports fields. Terrain is blended to 0 within 20 m of them. */
const FLAT: [number, number, number, number][] = [[-160, -140, -66, -92], [-45, -90, 70, -10]];
/** Distance (m) from a point to the nearest flat rectangle (0 inside). */
function flatDist(x: number, y: number): number {
  let d = Infinity;
  for (const [x0, y0, x1, y1] of FLAT) d = Math.min(d, Math.hypot(Math.max(x0 - x, 0, x - x1), Math.max(y0 - y, 0, y - y1)));
  return d;
}

/** The analytic height (baked into a 1.5 m grid by parkMap). */
export function parkHeight(x: number, y: number): number {
  // rolling to the north, gentle in the south; a grassy mound in the north-east; rising beyond the edges
  const flat = flatDist(x, y);
  if (flat <= 0) return 0;
  const amp = 0.8 + 2.4 * sstep(-80, 60, y);
  let h = amp * (2 * fbm(x / 110, y / 110, 3, 11) + 0.35 * fbm(x / 28, y / 28, 2, 12));
  h += 7 * Math.exp(-((x - 120) ** 2 + (y - 85) ** 2) / (2 * 32 * 32));
  const r = Math.max(Math.abs(x) - 200, Math.abs(y) - 150);
  if (r > 0) h += sstep(0, 80, r) * (10 + 6 * fbm(x / 70, y / 70, 2, 13));
  return h * sstep(0, 20, flat);
}
let baked: ((x: number, y: number) => number) | null = null;

export function parkMap(): MapDef {
  const rnd = seededRandom(1907);
  const terrain = (baked ??= bakeHeightfield(parkHeight, 240, 1.5));
  const prims: Prim[] = [];
  const decor: Prim[] = [];
  const white = { visual: 'plain' as const, color: 0xf2f2f2 };

  // --- car park: asphalt slab, bay lines, a few parked cars, lamp posts ---
  const CP = { x0: -150, y0: -130, x1: -100, y1: -100 };
  tiles(prims, CP.x0, CP.y0, -0.04, CP.x1, CP.y1, 0.06, { visual: 'plain', color: 0x3b3e42, tag: 'carpark' }, 8);
  for (const yRow of [-126, -104]) for (let i = 0; i <= 16; i++) box(decor, CP.x0 + 3 + i * 2.7, yRow + (yRow < -115 ? 2.5 : -2.5), 0.065, 0.05, 2.5, 0.005, 0, white);
  const carCols = [0xb3261e, 0x1d4fa3, 0xe8e8e8, 0x2b2b2b, 0x6b7178, 0x2e7d32, 0xd8b43c];
  const bays = [1, 2, 4, 7, 9, 12, 14];
  bays.forEach((b, i) => {
    const x = CP.x0 + 3 + (b + 0.5) * 2.7, y = i % 2 ? -106.5 : -123.5, col = carCols[i % carCols.length];
    box(prims, x, y, 0.62, 0.9, 2.2, 0.38, 0, { visual: 'plain', color: col, mat: 'metal', tag: 'car' });
    box(prims, x, y + (i % 2 ? -0.2 : 0.2), 1.27, 0.8, 1.2, 0.27, 0, { visual: 'plain', color: 0x30363d, mat: 'metal', tag: 'car' });
    for (const sx of [-0.8, 0.8]) for (const sy of [-1.4, 1.4]) box(prims, x + sx, y + sy, 0.39, 0.12, 0.33, 0.33, 0, { visual: 'plain', color: 0x1a1a1a, mat: 'metal', tag: 'car' });
  });
  for (const x of [-145, -125, -105]) for (const y of [-115]) {
    cyl(prims, x, y, 0.06, 0.08, 7, { color: 0x6b7178 });
    box(prims, x + 0.4, y, 7.0, 0.5, 0.18, 0.07, 0, { visual: 'metal', mat: 'metal', tag: 'lamp' });
    box(decor, x + 0.4, y, 6.92, 0.4, 0.12, 0.01, 0, { visual: 'led', color: 0xfff2d0 });
  }

  // --- pilot box: a raised deck, a pop-up canopy over its back half (shade for the table, open sky
  // in front of the pilot), flag poles beside it ---
  const PB = { x: -80, y: -105 };
  slab(prims, PB.x - 2.5, PB.y - 2, -0.05, PB.x + 2.5, PB.y + 2, 0.3, { visual: 'wood', mat: 'wood', tag: 'deck' });
  for (const sx of [-1, 1]) for (const y of [PB.y - 1.8, PB.y + 0.2]) cyl(prims, PB.x + sx * 2.3, y, 0.3, 0.03, 2.45, { color: 0xd0d4d8 });
  box(prims, PB.x, PB.y - 0.8, 2.8, 2.5, 1.25, 0.05, 0, { visual: 'plain', color: 0x1f6fb2, mat: 'wood', tag: 'canopy' });
  box(prims, PB.x, PB.y - 1.2, 1.05, 0.9, 0.35, 0.03, 0, { visual: 'wood', mat: 'wood', tag: 'table' });
  for (const dx of [-0.8, 0.8]) for (const dy of [-0.25, 0.25]) cyl(prims, PB.x + dx, PB.y - 1.2 + dy, 0.3, 0.025, 0.72, { color: 0x50555c });
  const flagCols = [0xd23c2c, 0x1f5fd1, 0x2fa35a];
  flagCols.forEach((col, i) => {
    const x = PB.x - 16 + i * 2.2, y = PB.y + 4;
    cyl(prims, x, y, 0, 0.05, 10, { color: 0xeeeeee });
    box(prims, x + 0.65, y, 9.4, 0.6, 0.01, 0.4, 0, { visual: 'plain', color: col, mat: 'foliage', tag: 'flag' });
  });
  // launch pad in front of the pilot (clear of the deck and the poles' collision cells)
  const PAD = { x: PB.x + 5, y: PB.y + 10 };
  box(prims, PAD.x, PAD.y, 0.01, 0.4, 0.4, 0.01, 0, { visual: 'pad', mat: 'wood', tag: 'pad' });

  // --- sports fields: a football pitch with two goals (frames only: fly through) ---
  const FP = { x: 12, y: -50, hx: 45, hy: 30 };
  for (const s of [-1, 1]) {
    box(decor, FP.x, FP.y + s * FP.hy, 0.015, FP.hx, 0.06, 0.015, 0, white);
    box(decor, FP.x + s * FP.hx, FP.y, 0.015, 0.06, FP.hy, 0.015, 0, white);
    const gx = FP.x + s * FP.hx;
    for (const sy of [-1, 1]) box(prims, gx, FP.y + sy * 3.72, 1.28, 0.06, 0.06, 1.28, 0, { visual: 'plain', color: 0xf4f4f4, mat: 'metal', tag: 'goal' });
    box(prims, gx, FP.y, 2.5, 0.06, 3.78, 0.06, 0, { visual: 'plain', color: 0xf4f4f4, mat: 'metal', tag: 'goal' });
  }
  box(decor, FP.x, FP.y, 0.015, 0.06, FP.hy, 0.015, 0, white);
  for (let i = 0; i < 24; i++) { const a = (i / 24) * 2 * Math.PI; box(decor, FP.x + 9.15 * Math.cos(a), FP.y + 9.15 * Math.sin(a), 0.015, 0.06, 1.2, 0.015, a, white); }

  // --- picnic shelter: gable roof on four posts, a table under it ---
  const SH = { x: -30, y: -78 };
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) cyl(prims, SH.x + sx * 2.8, SH.y + sy * 1.8, 0, 0.1, 2.86, { color: 0x6d4c33, mat: 'wood' });
  for (const s of [-1, 1]) beam(prims, { x: SH.x, y: SH.y, z: 3.35 }, { x: SH.x, y: SH.y + s * 2.4, z: 2.75 }, 3.3, 0.04, { visual: 'wood', mat: 'wood', tag: 'shelter' });
  box(prims, SH.x, SH.y, 0.76, 1.0, 0.45, 0.03, 0, { visual: 'wood', mat: 'wood', tag: 'table' });
  for (const sy of [-0.75, 0.75]) box(prims, SH.x, SH.y + sy, 0.45, 1.0, 0.15, 0.03, 0, { visual: 'wood', mat: 'wood', tag: 'bench' });
  // park benches along the field edge
  for (const [x, y, yaw] of [[-60, -40, 0], [-20, 5, 0], [40, 5, 0], [90, -60, 90 * deg]] as const) {
    const g = terrain(x, y);
    box(prims, x, y, g + 0.45, 0.9, 0.22, 0.03, yaw, { visual: 'wood', mat: 'wood', tag: 'bench' });
    box(prims, x, y, g + 0.22, 0.85, 0.18, 0.22, yaw, { visual: 'plain', color: 0x2b2f36, mat: 'metal', tag: 'bench' });
  }

  // --- free-standing poles to orbit and power-loop (no wires) ---
  const poles: [number, number, number, number, number][] = [[40, 40, 12, 0.14, 0x6d4c33], [-20, -5, 8, 0.1, 0x8a8f94], [125, 5, 10, 0.12, 0x6d4c33], [-70, 40, 14, 0.16, 0x8a8f94]];
  for (const [x, y, h, r, color] of poles) cyl(prims, x, y, terrain(x, y) - 0.3, r, h + 0.3, { color, mat: color === 0x6d4c33 ? 'wood' : 'metal', tag: 'pole' });

  // --- trees ---
  const trees: MapDef['trees'] = [];
  const tree = (x: number, y: number, h: number, r: number, type: 'pine' | 'oak') => trees.push({ x, y, h, r, type });
  // tree lines along the north and east edges, woods to the west
  for (let x = -190; x <= 190; x += 7 + rnd() * 2) tree(x, 125 + (rnd() - 0.5) * 6, 12 + rnd() * 8, 3 + rnd() * 1.5, rnd() < 0.35 ? 'pine' : 'oak');
  for (let y = -130; y <= 115; y += 8 + rnd() * 2) tree(175 + (rnd() - 0.5) * 6, y, 11 + rnd() * 8, 3 + rnd() * 1.2, rnd() < 0.5 ? 'pine' : 'oak');
  for (let i = 0; i < 40; i++) tree(-175 - rnd() * 30, -120 + rnd() * 240, 12 + rnd() * 10, 3 + rnd() * 1.5, rnd() < 0.6 ? 'pine' : 'oak');
  // an avenue across the meadow: two rows, 12 m apart along the rows, 12 m between the rows
  for (let x = -100; x <= 100; x += 12) for (const y of [14, 26]) tree(x + (rnd() - 0.5) * 1.5, y + (rnd() - 0.5) * 1.0, 10 + rnd() * 3, 2.6 + rnd() * 0.5, 'oak');
  // lone oaks to orbit
  for (const [x, y] of [[-40, 60], [60, 75], [100, -85], [-120, -20], [20, 95], [140, 40]]) tree(x, y, 16 + rnd() * 4, 5 + rnd() * 1.2, 'oak');
  // gap pairs: two trees whose canopies leave a ~3.5 m gap to thread
  for (const [x, y, a] of [[80, 60, 20], [-60, 90, 70], [150, -40, 0]]) {
    const r = 3.2, d = r + 1.75, c = Math.cos(a * deg), s = Math.sin(a * deg);
    tree(x - c * d, y - s * d, 13, r, 'oak'); tree(x + c * d, y + s * d, 14, r, 'oak');
  }
  // a small grove in the north-west
  for (let i = 0; i < 16; i++) { const a = rnd() * Math.PI * 2, rr = Math.sqrt(rnd()) * 22; tree(-120 + Math.cos(a) * rr, 70 + Math.sin(a) * rr, 11 + rnd() * 7, 2.6 + rnd() * 1.2, rnd() < 0.5 ? 'pine' : 'oak'); }
  // skyline beyond the park
  for (let i = 0; i < 70; i++) { const a = rnd() * Math.PI * 2, rr = 240 + rnd() * 120; tree(Math.cos(a) * rr, Math.sin(a) * rr * 0.8, 12 + rnd() * 10, 3 + rnd() * 2, rnd() < 0.5 ? 'pine' : 'oak'); }

  return {
    id: 'park', name: 'Meadow Park — Open field freestyle', size: 210, terrain, groundMat: 'grass', prims, gates: [], decor,
    spawn: { pos: { x: PAD.x, y: PAD.y, z: 0.02 }, yaw: 50 * deg, groundZ: 0.02 },
    pilot: { x: PB.x, y: PB.y + 1.6, z: 0.3 + 1.6 }, // front of the deck, in front of the canopy
    sun: { azimuthDeg: 215, elevationDeg: 38 }, sky: 'clear',
    // wind shadow of the grove and the north tree line
    wakeZones: [{ x: -120, y: 70, radius: 24, height: 15, intensity: 0.8 }, { x: 0, y: 125, radius: 40, height: 16, intensity: 0.6 }],
    elevationM: 210, trees,
  };
}
