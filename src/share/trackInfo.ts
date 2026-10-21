// A track's name and its gates from above, for the track-map card. Builds the map (procedural
// maps build at once; map packages are fetched first), so it is loaded only when a card needs it.
import { openingCentre } from '../maps/gates';
import { MAP_LIST, MAPS, preloadMap } from '../maps/maps';
import { GateDef, withCourse } from '../maps/world';
import type { GatePlan } from './types';

/** Gates as the card draws them: the counted opening's centre, its direction and width. */
export const gatePlan = (gates: GateDef[]): GatePlan[] => gates.map((g) => { const c = openingCentre(g); return { x: c.x, y: c.y, yaw: g.yaw, width: g.width, kind: g.kind }; });

/** "Practice Field · Slalom" and that course's gates. */
export async function trackInfo(map: string, course: string): Promise<{ label: string; gates: GatePlan[] }> {
  await preloadMap(map);
  const m = MAPS[map](), name = MAP_LIST[map]?.name.split(' — ')[0] ?? map;
  const cn = course ? m.courses?.find((c) => c.id === course)?.name ?? course : '';
  return { label: cn ? `${name} · ${cn}` : name, gates: gatePlan(withCourse(m, course).gates) };
}
