// "FPV Grand Prix Stadium": the flagship race map (id 'field', file name kept from its first name). A floodlit stadium bowl at golden hour with a
// championship-style course flown inside safety netting, watched from tiered grandstands.
//
// Course design follows what top-level events actually use, with the openings made a little
// bigger than the rule-book minimum (as asked) so the course flows at speed:
//  - FAI Sporting Code Vol. F9 (Drone Sport), Annex C.1 "Racing circuit": gates must leave a free
//    space of at least 1.5 m diameter on the optimal line, obstacles to avoid (flags, pylons) 2.5 m;
//    pilots / spectators behind nets or fences; start models side by side 0.5-1 m apart.
//    https://www.fai.org/sites/default/files/ciam/wcup_drones/sc4_vol_f9_dronesport_19-3_0.pdf
//  - FAI World Drone Racing Championship tracks: Shenzhen 2018 ~650 m with 6 m of vertical
//    layering and LED-lit gates; Ningbo 2019 630 m, 16 air gates on three levels; 3-lap races.
//    https://www.fai.org/node/180270  https://www.fai.org/node/183662
//  - MultiGP obstacles: 5'x5' (1.52 m) standard gate, 7'x6' (2.13 x 1.83 m) championship gate,
//    towers, 3-high ladders, 7'x6' dive gate raised 15' (4.6 m), 10'x5' hurdle, split-S stacks,
//    flags. https://dev.multigp.com/multigp-drone-race-course-obstacles/
//    https://shop.multigp.com/product/standard-multigp-start-finish-gate-5x5/
//  - Drone Racing League: ~12' (3.7 m) LED finish gate. https://www.atomicdesign.tv/?p=3887
// Here: 2.3 x 2.0 m square gates (championship 7'x6' + ~10 %), 3.2 x 3.0 m arches, a 3.6 x 1.8 m
// hurdle, a 2.4 m dive gate at 4.6 m, a 3-high ladder, a split-S stack and two flag turns:
// 13 timed passes over a ~300 m lap, about 20-30 s for a good 5" pilot.
// All sponsor names below are invented.
import type { V3 } from '../sim/math';
import { buildGatePrims } from './gates';
import { BoxPrim, fbm, GateDef, MapDef, Prim, seededRandom } from './world';

const deg = Math.PI / 180;

/** Gate opening sizes (m). */
export const WC = {
  square: { w: 2.3, h: 2.0 },
  arch: { w: 3.2, h: 3.0 },
  hurdle: { w: 3.6, h: 1.8 },
  dive: { w: 2.4, z: 4.6 },
  flag: { h: 3.6 },
} as const;

// Course: x, y, heading (deg CCW from east = direction of travel), kind, opening base height.
type Leg = [number, number, number, GateDef['kind'], number?, Partial<GateDef>?];
const STACK = WC.square.h + 0.12; // split-S / ladder pitch: opening + frame bar
const COURSE: Leg[] = [
  [-34, -26, 0, 'square'],                              // 0  start / finish under the timing gantry
  [-12, -27, 0, 'hurdle'],                              // 1  hurdle: fly under the banner
  [14, -25, 5, 'arch'],                                 // 2  LED arch
  [50, -17, 90, 'flag'],                                // 3  flag turn (left, round the flag)
  [53, 4, 90, 'dive', WC.dive.z],                       // 4  dive gate: climb over, drop through
  [46, 24, 135, 'ladder', 2 * STACK, { stack: 3 }],     // 5  ladder: top of three openings
  [18, 33, 180, 'square', 2.0],                         // 6  tower gate on 2 m legs
  [-8, 33, 180, 'square'],                              // 7  low gate
  [-36, 31, 180, 'square', STACK, { onTop: true }],     // 8  split-S: in through the top...
  [-36, 31, 0, 'square'],                               // 9  ...out through the bottom, reversed
  [-20, 16, -70, 'arch'],                               // 10 arch into the infield
  [-26, -6, 200, 'square'],                             // 11 infield gate
  [-52, -14, 270, 'flag'],                              // 12 flag hairpin back to the start
];

/**
 * A clean racing line through the course (spline control points, x y z): used by the tests to
 * prove the course is flyable (clear of every obstacle, every gate counted in order).
 */
export const WORLD_CUP_LINE: [number, number, number][] = [
  [-34, -26, 1.0], [-23, -26.6, 0.9], [-12, -27, 0.9], [1, -26.3, 1.3], [14, -25, 1.5], [30, -23.8, 1.8], [44, -22, 2.0],
  [51.5, -19.5, 2.2], [53.5, -15, 2.6], [54, -8, 4.8], [53.5, -2, 6.0], [53, 4, 4.6], [52.2, 10, 3.6],
  [50, 17, 4.4], [46, 24, 5.24], [40, 29.5, 4.6], [30, 32.5, 3.6], [18, 33, 3.0], [5, 33, 1.8], [-8, 33, 1.0],
  [-22, 32, 2.1], [-30, 31, 3.0], [-36, 31, 3.12], [-38.6, 31, 3.0], [-40.2, 31, 2.1], [-38.6, 31, 1.15],
  [-36, 31, 1.0], [-30, 28.5, 1.1], [-23.5, 22, 1.2], [-20, 16, 1.4], [-19.5, 8, 1.5], [-21.5, -2.5, 1.5], [-26, -6, 1.0],
  [-38, -9.5, 1.3], [-50, -10, 1.5], [-55, -14, 1.5], [-53.5, -21, 1.3], [-46, -25.6, 1.1],
];

function courseGates(): GateDef[] {
  return COURSE.map(([x, y, hd, kind, z, extra], id) => {
    const yaw = (hd - 90) * deg; // GateDef yaw: travel direction (-sin, cos)
    const base = { id, c: { x, y, z: z ?? 0 }, yaw, kind, ...extra };
    switch (kind) {
      case 'arch': return { ...base, width: WC.arch.w, height: WC.arch.h };
      case 'hurdle': return { ...base, width: WC.hurdle.w, height: WC.hurdle.h };
      case 'dive': return { ...base, width: WC.dive.w, height: WC.dive.w };
      case 'flag': return { ...base, width: 0.6, height: WC.flag.h };
      default: return { ...base, width: WC.square.w, height: WC.square.h };
    }
  });
}

// ---------------------------------------------------------------------------------------------

// Stadium layout (m): safety nets enclose the flying area, grandstands start behind the ad boards.
const NET_X = 62, NET_Y = 38, NET_H = 7;
const STAND_X = 68, STAND_Y = 48, ROWS = 22, ROW_D = 0.85, ROW_RISE = 0.42, STAND_Z0 = 1.6;
const SPONSORS: [string, number][] = [
  ['FPV GRAND PRIX', 0x0b1a3a], ['KESTREL CELLS', 0xd2401e], ['HELIX FRAMES', 0x111111], ['PROPWASH ENERGY', 0x14743c],
  ['OPEN SIM LEAGUE', 0x5a1f8a], ['NANOSKY RADIO', 0x0f5ea8], ['GYRO LABS 8K', 0x222831], ['FLY SAFE · FLY FAST', 0xc99a06],
];

export function worldCupMap(): MapDef {
  const rnd = seededRandom(2026);
  const terrain = (x: number, y: number) => {
    // flat bowl floor; gentle country beyond the stadium (mostly hidden behind the stands)
    const r = Math.max(Math.abs(x) - 100, Math.abs(y) - 80, 0);
    return Math.min(1, r / 60) * (fbm(x / 90, y / 90, 4, 3) * 8 + 3) + fbm(x / 9, y / 9, 2, 5) * 0.02;
  };
  const ground = () => 0;
  const gates = courseGates();
  const prims: Prim[] = [];
  const decor: Prim[] = [];
  buildGatePrims(gates, prims, ground);

  const box = (list: Prim[], c: V3, half: V3, yaw: number, rest: Partial<BoxPrim>) =>
    list.push({ kind: 'box', c, half, yaw, mat: 'concrete', visual: 'concrete', ...rest } as BoxPrim);
  /** A long box along x (yaw 0) or y (yaw 90°), cut into <= 8 m pieces to keep collision cells small. */
  const run = (list: Prim[], along: 'x' | 'y', from: number, to: number, at: number, z: number, hy: number, hz: number, rest: Partial<BoxPrim>, piece = 8) => {
    const n = Math.max(1, Math.ceil((to - from) / piece)), L = (to - from) / n;
    for (let i = 0; i < n; i++) {
      const m = from + (i + 0.5) * L;
      const c = along === 'x' ? { x: m, y: at, z } : { x: at, y: m, z };
      box(list, c, { x: L / 2, y: hy, z: hz }, along === 'x' ? 0 : 90 * deg, rest);
    }
  };

  // --- safety netting around the flying area: poles every ~8 m, soft net panels ---
  for (const s of [-1, 1]) {
    run(prims, 'x', -NET_X, NET_X, s * NET_Y, NET_H / 2, 0.02, NET_H / 2, { mat: 'foliage', visual: 'net', tag: 'net' });
    run(prims, 'y', -NET_Y, NET_Y, s * NET_X, NET_H / 2, 0.02, NET_H / 2, { mat: 'foliage', visual: 'net', tag: 'net' });
    for (let x = -NET_X; x <= NET_X + 0.1; x += NET_X / 8) prims.push({ kind: 'cyl', c: { x, y: s * NET_Y, z: 0 }, r: 0.06, h: NET_H + 0.2, mat: 'metal' });
    for (let y = -NET_Y + NET_Y / 5; y < NET_Y - 0.1; y += NET_Y / 5) prims.push({ kind: 'cyl', c: { x: s * NET_X, y, z: 0 }, r: 0.06, h: NET_H + 0.2, mat: 'metal' });
  }

  // --- grandstands: four straight stands of stepped concrete rows, open corners for the light towers ---
  const seatCols = [0x1d4fa3, 0x8f9aa6];
  const crowdCols = [0xd23c2c, 0xf2f2f2, 0x1f5fd1, 0xf0c419, 0x2a2a2a, 0x2fa35a, 0xff7a1a, 0x7a3fd1, 0x60c8ff, 0xc8b49a];
  const stands = [
    { along: 'x' as const, s: -1, len: STAND_X }, { along: 'x' as const, s: 1, len: STAND_X },
    { along: 'y' as const, s: -1, len: STAND_Y }, { along: 'y' as const, s: 1, len: STAND_Y },
  ];
  for (const st of stands) {
    const inner = st.along === 'x' ? STAND_Y : STAND_X;
    for (let k = 0; k < ROWS; k++) {
      const off = st.s * (inner + (k + 0.5) * ROW_D), top = STAND_Z0 + k * ROW_RISE;
      run(prims, st.along, -st.len, st.len, off, top / 2, ROW_D / 2, top / 2, { visual: 'plain', color: seatCols[(k >> 2) & 1], tag: 'stand' }, 9);
      // spectators: seated figures, denser near the front and around the halfway line
      for (let u = -st.len + 0.4; u < st.len - 0.3; u += 0.62) {
        const p = 0.62 - k * 0.012 - Math.abs(u) / st.len * 0.18;
        if (rnd() > p) continue;
        const o = off + st.s * 0.12, z = top + 0.36;
        const c = st.along === 'x' ? { x: u + (rnd() - 0.5) * 0.12, y: o, z } : { x: o, y: u + (rnd() - 0.5) * 0.12, z };
        box(decor, c, { x: 0.2, y: 0.15, z: 0.36 + rnd() * 0.05 }, st.along === 'x' ? 0 : 90 * deg, { visual: 'plain', color: crowdCols[Math.floor(rnd() * crowdCols.length)], tag: 'crowd' });
      }
    }
    // back wall, front wall with LED advertising boards
    const back = st.s * (inner + ROWS * ROW_D + 0.25), topZ = STAND_Z0 + ROWS * ROW_RISE;
    run(prims, st.along, -st.len, st.len, back, (topZ + 2.5) / 2, 0.25, (topZ + 2.5) / 2, { tag: 'stand' }, 9);
    const n = Math.round((2 * st.len) / 8);
    for (let i = 0; i < n; i++) {
      const u = -st.len + (i + 0.5) * (2 * st.len) / n;
      const [text, color] = SPONSORS[(i + (st.along === 'x' ? 0 : 3) + (st.s > 0 ? 5 : 0)) % SPONSORS.length];
      const at = st.s * (inner - 0.35);
      const c = st.along === 'x' ? { x: u, y: at, z: 0.55 } : { x: at, y: u, z: 0.55 };
      box(prims, c, { x: (st.len / n) - 0.05, y: 0.08, z: 0.55 }, st.along === 'x' ? 0 : 90 * deg, { visual: 'banner', text, color, mat: 'wood', tag: 'board' });
    }
  }
  // main (south) stand roof canopy on columns, LED fascia
  const roofZ = STAND_Z0 + ROWS * ROW_RISE + 5;
  for (let x = -60; x <= 60; x += 20) prims.push({ kind: 'cyl', c: { x, y: -(STAND_Y + ROWS * ROW_D + 0.8), z: 0 }, r: 0.35, h: roofZ, mat: 'metal' });
  run(prims, 'x', -STAND_X, STAND_X, -(STAND_Y + ROWS * ROW_D / 2 + 1), roofZ + 0.25, ROWS * ROW_D / 2 + 2, 0.25, { visual: 'metal', mat: 'metal', tag: 'roof' }, 12);
  run(decor, 'x', -STAND_X, STAND_X, -(STAND_Y - 1.05), roofZ + 0.1, 0.05, 0.12, { visual: 'led', color: 0x9fd8ff, tag: 'fascia' }, 34);

  // --- floodlight towers in the four corners ---
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
    const x = sx * (STAND_X + 4), y = sy * (STAND_Y + 4), h = 38;
    prims.push({ kind: 'cyl', c: { x, y, z: 0 }, r: 0.7, h, mat: 'metal' });
    const yaw = Math.atan2(x, -y); // local +y (panel front) points at the centre of the pitch
    const cx = Math.cos(yaw), cy = Math.sin(yaw), fx = -Math.sin(yaw), fy = Math.cos(yaw);
    box(prims, { x, y, z: h + 2 }, { x: 4.6, y: 0.5, z: 2.6 }, yaw, { visual: 'metal', mat: 'metal', tag: 'lights' });
    for (let r = 0; r < 4; r++) for (let c = 0; c < 6; c++) {
      const lx = -3.75 + c * 1.5;
      box(decor, { x: x + cx * lx + fx * 0.56, y: y + cy * lx + fy * 0.56, z: h + 0.2 + r * 1.2 }, { x: 0.6, y: 0.05, z: 0.45 }, yaw, { visual: 'led', color: 0xfff3d6, tag: 'flood' });
    }
  }

  // --- giant screens above the end stands ---
  for (const s of [-1, 1]) {
    const x = s * (STAND_X + ROWS * ROW_D + 4), z = STAND_Z0 + ROWS * ROW_RISE + 9;
    for (const dy of [-8, 8]) prims.push({ kind: 'cyl', c: { x, y: dy, z: 0 }, r: 0.4, h: z - 5, mat: 'metal' });
    box(prims, { x, y: 0, z }, { x: 10, y: 0.4, z: 5.6 }, 90 * deg, { visual: 'screen', text: s < 0 ? 'FPV GRAND PRIX|FINAL HEAT' : 'LIVE|PILOTS ARM YOUR QUADS', color: 0x05070d, mat: 'metal', tag: 'screen' });
  }

  // --- start / finish: timing gantry over gate 0, start pads behind it ---
  const g0 = gates[0];
  for (const s of [-1, 1]) box(prims, { x: g0.c.x, y: g0.c.y + s * 7, z: 4 }, { x: 0.3, y: 0.3, z: 4 }, 0, { visual: 'plain', color: 0x3a3f47, mat: 'metal', tag: 'gantry' });
  box(prims, { x: g0.c.x, y: g0.c.y, z: 8.6 }, { x: 0.35, y: 7.3, z: 0.6 }, 90 * deg, { visual: 'screen', text: 'START · FINISH', color: 0x05070d, mat: 'metal', tag: 'gantry' });
  for (const s of [-1, 1]) box(decor, { x: g0.c.x + s * 0.36, y: g0.c.y, z: 7.95 }, { x: 0.02, y: 7.1, z: 0.04 }, 0, { visual: 'led', color: 0x34ff7a, tag: 'timing' });
  const pads = [-1.5, -0.5, 0.5, 1.5].map((k) => g0.c.y + k * 1.3);
  for (const y of pads) box(prims, { x: -44, y, z: 0.01 }, { x: 0.4, y: 0.4, z: 0.01 }, 0, { visual: 'pad', mat: 'wood', tag: 'pad' });

  // --- pilot box: raised platform with canopy between the south net and the main stand ---
  box(prims, { x: 0, y: -43, z: 0.6 }, { x: 12, y: 3, z: 0.6 }, 0, { visual: 'plain', color: 0x2b2f36, tag: 'pilotbox' });
  for (let i = 0; i < 8; i++) box(prims, { x: -10.5 + i * 3, y: -43.5, z: 1.45 }, { x: 0.3, y: 0.3, z: 0.25 }, 0, { visual: 'plain', color: 0xe23b3b, tag: 'chair' });
  for (const x of [-11.5, 11.5]) for (const y of [-40.5, -45.5]) prims.push({ kind: 'cyl', c: { x, y, z: 1.2 }, r: 0.08, h: 2.6, mat: 'metal' });
  box(prims, { x: 0, y: -43, z: 3.9 }, { x: 12.2, y: 3.2, z: 0.1 }, 0, { visual: 'plain', color: 0xf2f2f2, mat: 'wood', tag: 'canopy' });
  box(prims, { x: 0, y: -40.1, z: 4.3 }, { x: 12, y: 0.08, z: 0.3 }, 0, { visual: 'banner', text: 'PILOTS', color: 0x0b1a3a, mat: 'wood', tag: 'board' });

  // trees on the skyline beyond the stadium
  const trees: MapDef['trees'] = [];
  for (let i = 0; i < 160; i++) {
    const a = rnd() * Math.PI * 2, r = 135 + rnd() * 70, x = Math.cos(a) * r, y = Math.sin(a) * r * 0.85;
    trees.push({ x, y, h: 10 + rnd() * 12, r: 2.5 + rnd() * 2.5, type: rnd() < 0.5 ? 'pine' : 'oak' });
  }

  return {
    id: 'field', name: 'FPV Grand Prix Stadium', size: 200, terrain, groundMat: 'grass', prims, gates, decor,
    spawn: { pos: { x: -44, y: pads[1], z: 0.25 }, yaw: 0 }, sun: { azimuthDeg: 245, elevationDeg: 12 }, sky: 'dusk',
    pilot: { x: 0, y: -42, z: 2.9 },
    wakeZones: [], elevationM: 50, trees,
  };
}
