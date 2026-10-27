// Race course tools without three.js: lap length (the same measure as the training curriculum's
// courseLength), the racing line (Catmull-Rom through the gate openings, from the spawn round the
// course and back to gate 0) and the course checks the problems list shows.
import { openingCentre } from '../maps/gates';
import type { MapDocV1 } from '../maps/mapDoc';
import type { GateDef, MapDef } from '../maps/world';
import type { V3 } from '../sim/math';
import type { Op, Path } from './editorDoc';

export interface Problem { level: 'error' | 'warning' | 'info'; text: string; ref?: Path; fix?: { label: string; ops: Op[] } }

/** Lap length (m): straight lines from opening to opening, round to gate 0 again (curriculum.ts courseLength). */
export function lapLength(gates: GateDef[]): number {
  const pts = gates.map(openingCentre);
  let L = 0;
  for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; L += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z); }
  return pts.length > 1 ? L : 0;
}

/** Racing line: spawn (1 m up) -> gate 0 -> … -> last gate -> gate 0, sampled every ~step m, and its length. */
export function racingLine(spawn: V3, gates: GateDef[], step = 0.5): { points: V3[]; length: number } {
  if (!gates.length) return { points: [], length: 0 };
  const P = [{ x: spawn.x, y: spawn.y, z: spawn.z + 1 }, ...gates.map(openingCentre)];
  if (gates.length > 1) P.push(openingCentre(gates[0]));
  const out: V3[] = [];
  for (let i = 0; i < P.length - 1; i++) {
    const p0 = P[Math.max(0, i - 1)], p1 = P[i], p2 = P[i + 1], p3 = P[Math.min(P.length - 1, i + 2)];
    const n = Math.max(2, Math.ceil(Math.hypot(p2.x - p1.x, p2.y - p1.y, p2.z - p1.z) / step));
    for (let k = 0; k < n; k++) {
      const t = k / n, t2 = t * t, t3 = t2 * t;
      const f = (a: 'x' | 'y' | 'z') => 0.5 * (2 * p1[a] + (-p0[a] + p2[a]) * t + (2 * p0[a] - 5 * p1[a] + 4 * p2[a] - p3[a]) * t2 + (-p0[a] + 3 * p1[a] - 3 * p2[a] + p3[a]) * t3);
      out.push({ x: f('x'), y: f('y'), z: f('z') });
    }
  }
  out.push({ ...P[P.length - 1] });
  let length = 0;
  for (let i = 1; i < out.length; i++) length += Math.hypot(out[i].x - out[i - 1].x, out[i].y - out[i - 1].y, out[i].z - out[i - 1].z);
  return { points: out, length };
}

/** The gates of course c (-1 = the map's default course) and where their documents live. */
export function courseGates(def: MapDef, c: number): GateDef[] { return c < 0 ? def.gates : def.courses?.[c]?.gates ?? []; }
export const coursePath = (c: number): Path => (c < 0 ? ['gates'] : ['courses', c, 'gates']);

/** Course checks: gates too close, gates facing away from the line, a missing race tag or start pad. */
export function raceProblems(doc: MapDocV1, def: MapDef): Problem[] {
  const out: Problem[] = [];
  const check = (gates: GateDef[], c: number, name: string) => {
    const base = coursePath(c), pts = gates.map(openingCentre);
    for (let i = 0; i < gates.length; i++) for (let j = i + 1; j < gates.length; j++) {
      const d = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y, pts[i].z - pts[j].z);
      if (d < 3) out.push({ level: 'warning', text: `${name}: gates ${i + 1} and ${j + 1} are only ${d.toFixed(1)} m apart (at least 3 m keeps them flyable)`, ref: [...base, j] });
    }
    if (gates.length < 2) return;
    const sp = c >= 0 && def.courses?.[c]?.spawn ? def.courses[c].spawn!.pos : def.spawn.pos;
    for (let i = 0; i < gates.length; i++) {
      const g = gates[i];
      if (g.kind === 'dive' || g.kind === 'flag') continue; // flown downwards / round: no facing
      const prev = i === 0 ? { x: sp.x, y: sp.y } : pts[i - 1], next = pts[(i + 1) % gates.length];
      const tx = next.x - prev.x, ty = next.y - prev.y, n = Math.hypot(tx, ty);
      if (n < 1e-6) continue;
      const dot = (-Math.sin(g.yaw) * tx + Math.cos(g.yaw) * ty) / n;
      if (dot < -0.2) {
        const p = [...base, i, 'yawDeg'], yaw = ((((g.yaw * 180) / Math.PI + 180) % 360) + 360) % 360;
        out.push({ level: 'warning', text: `${name}: gate ${i + 1} faces away from the racing line (you would fly through it backwards)`, ref: [...base, i], fix: { label: 'Turn it round', ops: [{ k: 'set', path: p, v: Math.round(yaw * 100) / 100 }] } });
      }
    }
  };
  check(def.gates, -1, 'Main course');
  (def.courses ?? []).forEach((c, i) => check(c.gates, i, `Course "${c.name}"`));
  const anyGates = def.gates.length > 0 || (def.courses ?? []).some((c) => c.gates.length > 0);
  const tags = doc.meta.tags ?? [];
  if (anyGates && !tags.includes('race'))
    out.push({ level: 'info', text: 'The map has gates but no "race" tag: the map browser lists it as a race map with it', fix: { label: 'Add the race tag', ops: [{ k: 'set', path: ['meta', 'tags'], v: [...tags, 'race'].slice(0, 8) }] } });
  if (anyGates) {
    const s = def.spawn.pos;
    const padNear = (doc.primitives ?? []).some((p) => p.type === 'box' && p.visual === 'pad' && Math.hypot(p.pos[0] - s.x, p.pos[1] - s.y) < 3);
    if (!padNear) out.push({ level: 'info', text: 'No start pad at the spawn: add a pad box so pilots see where the race starts', fix: { label: 'Add a start pad', ops: [{ k: 'ins', path: ['primitives'], v: { type: 'box', pos: [s.x, s.y, def.terrain(s.x, s.y) + 0.02], size: [1.2, 1.2, 0.04], visual: 'pad', material: 'concrete' } }] } });
  }
  return out;
}
