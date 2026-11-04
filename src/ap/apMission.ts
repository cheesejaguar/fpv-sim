// A map's mission (MapDef.mission, drawn as a path in the map builder) as ArduPilot mission items:
// take off, the path's points as waypoints, then RTL, land at the last one, or a jump back to the
// first waypoint. Positions go from the simulator's world (ENU metres from the map's GPS origin) to
// latitude / longitude the way ArduPilot's own Location offsets do (flat earth, scaled longitude),
// heights to metres above home (MAV_FRAME_GLOBAL_RELATIVE_ALT: home is where the vehicle armed,
// the spawn's ground).
import type { MissionDef } from '../maps/world';
import type { GpsOrigin } from '../worker/ubxGps';
import type { ApVehicle } from './apConfig';
import { ApMissionItem, MAV_CMD } from './apLink';

/** ArduPilot's earth radius for Location offsets (m). */
const R_EARTH = 6378100;

/** World ENU (m from the origin) to latitude / longitude (deg). */
export function enuToLatLon(o: GpsOrigin, x: number, y: number): { lat: number; lon: number } {
  const lat = o.lat + (y / R_EARTH) * (180 / Math.PI);
  const lon = o.lon + (x / (R_EARTH * Math.cos((o.lat * Math.PI) / 180))) * (180 / Math.PI);
  return { lat, lon };
}

/** The mission items (ArduPilot numbers them 1..n after its home, item 0). groundZ: the spawn's ground height. */
export function missionItems(m: MissionDef, vehicle: ApVehicle, origin: GpsOrigin, groundZ: number): ApMissionItem[] {
  const items: ApMissionItem[] = [];
  const first = enuToLatLon(origin, m.points[0].x, m.points[0].y);
  // a plane's takeoff climbs out at 12 degrees to the altitude; a copter's goes straight up
  items.push({ command: MAV_CMD.NAV_TAKEOFF, ...first, alt: m.takeoffAltM, params: [vehicle === 'plane' ? 12 : 0, 0, 0, NaN] });
  if (m.speedMs) items.push({ command: MAV_CMD.DO_CHANGE_SPEED, lat: 0, lon: 0, alt: 0, params: [vehicle === 'plane' ? 0 : 1, m.speedMs, -1, 0], frame: 2 });
  const firstWp = items.length + 1; // ArduPilot's index of the first waypoint (home is 0)
  for (const p of m.points) {
    const ll = enuToLatLon(origin, p.x, p.y);
    items.push({ command: MAV_CMD.NAV_WAYPOINT, ...ll, alt: Math.max(vehicle === 'plane' ? 8 : 2, p.z - groundZ) });
  }
  const last = m.points[m.points.length - 1];
  if (m.end === 'loop') items.push({ command: MAV_CMD.DO_JUMP, lat: 0, lon: 0, alt: 0, params: [firstWp, -1, 0, 0], frame: 2 });
  else if (m.end === 'land') items.push({ command: MAV_CMD.NAV_LAND, ...enuToLatLon(origin, last.x, last.y), alt: 0 });
  else items.push({ command: MAV_CMD.NAV_RETURN_TO_LAUNCH, lat: 0, lon: 0, alt: 0 });
  return items;
}
