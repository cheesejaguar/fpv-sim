// Racing lines for course tests: a closed Catmull-Rom spline through control points, flown against a
// map's collision world and pass detection (gate order, obstacle clearance).
import { gatePassed } from '../../src/maps/gates';
import { closedSpline } from '../../src/maps/kit';
import { GateDef, PrimitiveWorld } from '../../src/maps/world';
import { ContactHit, MATERIALS } from '../../src/sim/contact';
import type { V3 } from '../../src/sim/math';

/** Closed Catmull-Rom spline through P (starting just before P[0]), sampled every ~`step` m, `laps` times round. */
export const splineLine = (P: [number, number, number][], laps: number, step = 0.02): V3[] => closedSpline(P, laps, step);

export function lineLength(line: V3[]): number {
  let len = 0;
  for (let i = 1; i < line.length; i++) len += Math.hypot(line[i].x - line[i - 1].x, line[i].y - line[i - 1].y, line[i].z - line[i - 1].z);
  return len;
}

/**
 * Fly a sphere of radius r along the line: the first point where it touches anything (prims, trees or
 * the ground), and the gate ids counted in order (the worker's rule: only the next gate can count).
 */
export function flyLine(world: PrimitiveWorld, gates: GateDef[], line: V3[], r: number): { touch: (V3 & { what: string }) | null; events: number[] } {
  const hit: ContactHit = { depth: 0, nx: 0, ny: 0, nz: 0, material: MATERIALS.grass };
  let next = 0, touch: (V3 & { what: string }) | null = null;
  const events: number[] = [];
  for (let i = 1; i < line.length; i++) {
    const p = line[i];
    if (!touch && world.sphere(p, r, hit)) touch = { ...p, what: hit.material.name };
    const g = gates[next % gates.length];
    if (gates.length && gatePassed(g, line[i - 1], p)) { events.push(g.id); next++; }
  }
  return { touch, events };
}
