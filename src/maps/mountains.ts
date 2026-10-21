// "Ridgeline": 4 x 4 km of procedural mountains for long range and mountain surfing. You launch
// from a hilltop in the south, cross a winding valley and fly to the big ridge 2.2 km to the north,
// where an arch stands on its lowest saddle and a mast marks the summit. Trees are sparse pines on
// the mid slopes. The out-and-back is timed: start arch -> saddle arch -> back through the start.
//
// Terrain: ridged value noise (soft crests, so the 14 m render mesh follows the collision surface
// closely) plus the shaped features, baked once into an 8 m grid and interpolated bilinearly: every
// terrain query is a table lookup, much cheaper than evaluating the noise (the stadium's terrain is
// ~6 noise octaves per call).
import { buildGatePrims } from './gates';
import { bakeHeightfield, box, cyl, headingYaw } from './kit';
import { GateDef, MapDef, Prim, seededRandom, valueNoise } from './world';

const deg = Math.PI / 180;
const sstep = (a: number, b: number, x: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** Playable half extent (m), launch hill (the spawn is on its summit, found near here), far ridge line. */
export const RIDGE = { size: 2000, spawn: { x: 0, y: -900 }, plateau: 32, farY: 1300, saddleX: -150 } as const;
const GRID = { half: 2448, step: 8 }; // covers the rendered terrain (size x 2.2)

/** Soft ridge: 1 on the crest (noise = 0.5), falling off to both sides; eps rounds the crease. */
function ridge(x: number, y: number, s: number, seed: number) {
  const n = valueNoise(x / s, y / s, seed) * 2 - 1;
  return 1 - Math.sqrt(n * n + 0.04);
}

/** The analytic height (before baking). */
function rawHeight(x: number, y: number): number {
  // ridged multifractal: each octave weighted by the one above, so detail sits on the crests
  let h = 0, w = 1;
  const oct: [number, number][] = [[1150, 300], [520, 110], [240, 28], [115, 5]];
  for (let i = 0; i < oct.length; i++) {
    const r = ridge(x + 731 * i, y - 419 * i, oct[i][0], 31 + i);
    h += oct[i][1] * r * w;
    w = Math.min(1, Math.max(0, r * 1.25));
  }
  // the far ridge: a high wall of peaks across the north, with a saddle a little west of the middle
  h += 560 * Math.exp(-((y - RIDGE.farY) ** 2) / (2 * 230 * 230)) * (1 - 0.28 * Math.exp(-((x - RIDGE.saddleX) ** 2) / (2 * 220 * 220)));
  // a winding valley between the launch hill and the ridge
  const vy = 250 + 90 * Math.sin(x / 380);
  h -= 130 * Math.exp(-((y - vy) ** 2) / (2 * 150 * 150));
  // the launch hill
  const dx = x - RIDGE.spawn.x, dy = y - RIDGE.spawn.y;
  h += 170 * Math.exp(-(dx * dx + dy * dy) / (2 * 280 * 280));
  // a rim of mountains round the edge of the map
  h += 420 * sstep(1650, 2400, Math.max(Math.abs(x), Math.abs(y)));
  return h;
}

/**
 * Bake the heightfield into the 8 m grid, with a flat plateau on the launch hill's summit (found
 * near RIDGE.spawn) so the pilot stands on top with the ground falling away all round. Baked once
 * per thread.
 */
type Baked = { terrain: (x: number, y: number) => number; plateauZ: number; top: { x: number; y: number } };
let baked: Baked | null = null;
function bakeTerrain(): Baked {
  if (baked) return baked;
  let top: { x: number; y: number } = { ...RIDGE.spawn }, best = -Infinity;
  for (let dx = -400; dx <= 400; dx += 8) for (let dy = -400; dy <= 400; dy += 8) {
    if (dx * dx + dy * dy > 400 * 400) continue;
    const h = rawHeight(RIDGE.spawn.x + dx, RIDGE.spawn.y + dy);
    if (h > best) { best = h; top = { x: RIDGE.spawn.x + dx, y: RIDGE.spawn.y + dy }; }
  }
  const plateauZ = Math.round(best * 10) / 10;
  const terrain = bakeHeightfield((x, y) => {
    const h = rawHeight(x, y), d = Math.hypot(x - top.x, y - top.y);
    return d < RIDGE.plateau + 40 ? h + (plateauZ - h) * (1 - sstep(RIDGE.plateau, RIDGE.plateau + 40, d)) : h;
  }, GRID.half, GRID.step);
  return (baked = { terrain, plateauZ, top });
}

/** Lowest point of the far ridge's crest near the middle of the map (the saddle), and the summit. */
function crest(terrain: (x: number, y: number) => number) {
  let saddle = { x: 0, y: 0, z: Infinity }, summit = { x: 0, y: 0, z: -Infinity };
  for (let x = RIDGE.saddleX - 450; x <= RIDGE.saddleX + 450; x += 10) {
    let top = { x, y: 0, z: -Infinity };
    for (let y = RIDGE.farY - 450; y <= RIDGE.farY + 450; y += 8) { const z = terrain(x, y); if (z > top.z) top = { x, y, z }; }
    if (top.z < saddle.z) saddle = top;
    if (top.z > summit.z) summit = top;
  }
  return { saddle, summit };
}

export function mountainMap(): MapDef {
  const rnd = seededRandom(8848);
  const { terrain, plateauZ, top: S } = bakeTerrain();
  const { saddle, summit } = crest(terrain);
  const prims: Prim[] = [];

  // the out-and-back: start arch on the hilltop, a big arch across the saddle (both northbound). The
  // saddle arch is rooted below the lower of its two feet, so neither post floats on the slope.
  const W1 = 10, foot1 = Math.min(terrain(saddle.x - W1 / 2, saddle.y), terrain(saddle.x + W1 / 2, saddle.y), saddle.z) - 0.3;
  const gates: GateDef[] = [
    { id: 0, c: { x: S.x, y: S.y + 18, z: plateauZ }, yaw: headingYaw(90), kind: 'arch', width: 4, height: 3.6 },
    { id: 1, c: { x: saddle.x, y: saddle.y, z: foot1 }, yaw: headingYaw(90), kind: 'arch', width: W1, height: 8 + (saddle.z - foot1) },
  ];
  buildGatePrims(gates, prims, (x, y) => (x === saddle.x && y === saddle.y ? foot1 : terrain(x, y)));

  // hilltop: launch pad, a cairn, a bench and a wind sock pole; summit mast with a beacon
  box(prims, S.x, S.y, plateauZ + 0.01, 0.4, 0.4, 0.01, 0, { visual: 'pad', mat: 'wood', tag: 'pad' });
  for (const [dx, dy, r] of [[-6, -5, 0.7], [-6.4, -4.4, 0.45], [-5.5, -4.6, 0.4]] as const) prims.push({ kind: 'sphere', c: { x: S.x + dx, y: S.y + dy, z: plateauZ + r * 0.6 }, r, mat: 'concrete', color: 0x8d8a83, tag: 'cairn' });
  box(prims, S.x + 4, S.y - 6, plateauZ + 0.45, 0.9, 0.22, 0.03, 0, { visual: 'wood', mat: 'wood', tag: 'bench' });
  box(prims, S.x + 4, S.y - 6, plateauZ + 0.22, 0.85, 0.18, 0.22, 0, { visual: 'plain', color: 0x2b2f36, mat: 'metal', tag: 'bench' });
  cyl(prims, S.x - 8, S.y + 4, plateauZ, 0.04, 4.5, { color: 0xd0d4d8 });
  box(prims, S.x - 7.4, S.y + 4, plateauZ + 4.2, 0.55, 0.12, 0.12, 0, { visual: 'plain', color: 0xff6a00, mat: 'foliage', tag: 'windsock' });
  cyl(prims, summit.x, summit.y, summit.z - 1, 0.35, 26, { color: 0xc9473a, tag: 'mast' });
  box(prims, summit.x, summit.y, summit.z + 25.2, 0.3, 0.3, 0.2, 0, { visual: 'led', color: 0xff3020, mat: 'metal', tag: 'beacon' });

  // sparse pines on the mid slopes (not on the hilltop plateau or in the arches)
  const trees: MapDef['trees'] = [];
  const zLo = plateauZ - 260, zHi = plateauZ + 120;
  for (let n = 0; n < 6000 && trees.length < 420; n++) {
    const x = (rnd() * 2 - 1) * 1900, y = (rnd() * 2 - 1) * 1900, z = terrain(x, y);
    const slope = Math.hypot(terrain(x + 4, y) - terrain(x - 4, y), terrain(x, y + 4) - terrain(x, y - 4)) / 8;
    // forest patches: a low-frequency mask, the right altitude band, not too steep
    if (valueNoise(x / 300, y / 300, 77) < 0.55 || z < zLo || z > zHi || slope > 0.7) continue;
    if (Math.hypot(x - S.x, y - S.y) < 80 || gates.some((g) => Math.hypot(x - g.c.x, y - g.c.y) < 30)) continue;
    trees.push({ x, y, h: 9 + rnd() * 11, r: 2.2 + rnd() * 1.6, type: 'pine' });
  }

  return {
    id: 'mountains', name: 'Ridgeline — Mountain long range', size: RIDGE.size, terrain, groundMat: 'grass', prims, gates,
    spawn: { pos: { x: S.x, y: S.y, z: plateauZ + 0.02 }, yaw: 90 * deg, groundZ: plateauZ + 0.02 },
    pilot: { x: S.x - 2, y: S.y - 3, z: plateauZ + 1.6 },
    sun: { azimuthDeg: 200, elevationDeg: 32 }, sky: 'clear',
    fog: { color: 0xa9bccf, density: 0.00032 }, // ~20 % haze at 1.5 km, the far ridge still shows
    wakeZones: [], elevationM: 1100, trees,
  };
}
