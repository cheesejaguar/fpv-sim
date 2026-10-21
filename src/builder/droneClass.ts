// The drone class a lap is ranked in on the leaderboard, and the short drone summary shown with it:
// a preset's own id and name while the build still is that preset, else "custom" with the frame
// size, motor and cell count from the build.
import { CLASSES, CUSTOM } from '../../server/src/leaderboardCore';
import { DroneBuild, DroneSpec, PRESETS } from './derive';

/** Leaderboard class id of each preset, by preset name (stable ids: the leaderboard stores them). */
export const PRESET_CLASS: Readonly<Record<string, string>> = {
  '5" Freestyle 6S': 'freestyle5',
  '5" Race 4S': 'race5',
  '5" Freestyle DJI O4 + GoPro': 'freestyle5-o4',
  '5" HDZero 6S': 'freestyle5-hdz',
  '7" Long Range Li-ion': 'longrange7',
  'Beginner: 65 mm Tiny Whoop 1S': 'whoop65',
  'Beginner: 75 mm Whoop 1S': 'whoop75',
  'Beginner: 3" Cinewhoop 4S HD': 'cinewhoop3',
  '3" Toothpick 4S': 'toothpick3',
};

/** Classes in menu order: each preset, then custom. */
export const CLASS_IDS: readonly string[] = [...PRESETS.map((p) => PRESET_CLASS[p.name]).filter(Boolean), CUSTOM];

export const className = (cls: string): string => CLASSES[cls]?.name ?? 'Custom';

// Not part of the hardware: the build's name, the camera angle (pilot preference; older saves of a
// preset carry an older default) and the prop direction (set to match the Betaflight motor config).
const IGNORED = new Set<keyof DroneSpec>(['name', 'cameraUptiltDeg', 'propDirection']);

function sameHardware(a: DroneSpec, b: DroneSpec): boolean {
  for (const k of Object.keys(a) as (keyof DroneSpec)[]) {
    if (IGNORED.has(k) || k === 'overrides') continue;
    if (a[k] !== b[k]) return false;
  }
  for (const k of Object.keys(b) as (keyof DroneSpec)[]) if (!IGNORED.has(k) && !(k in a)) return false;
  const oa = Object.entries(a.overrides ?? {}).filter(([, v]) => v !== undefined), ob = b.overrides ?? {};
  return oa.length === Object.values(ob).filter((v) => v !== undefined).length && oa.every(([k, v]) => (ob as Record<string, unknown>)[k] === v);
}

/** The preset this build still is (same parts and settings), or null. */
export function presetOf(spec: DroneSpec): DroneSpec | null {
  return PRESETS.find((p) => sameHardware(p, spec)) ?? null;
}

// specs are replaced as a whole when they change, so the class of one can be kept (the HUD asks every frame)
const classOf = new WeakMap<DroneSpec, string>();

/** Leaderboard class: the preset's id, else 'custom'. */
export function droneClass(spec: DroneSpec): string {
  let c = classOf.get(spec);
  if (c === undefined) {
    const p = presetOf(spec);
    classOf.set(spec, (c = (p && PRESET_CLASS[p.name]) || CUSTOM));
  }
  return c;
}

/** Summary for the board: the preset's name, or e.g. `Custom · 5" · 2207 1950KV · 6S`. */
export function droneSummary(b: Pick<DroneBuild, 'spec' | 'info'>): string {
  const cls = droneClass(b.spec);
  if (cls !== CUSTOM) return className(cls);
  const { frame, motor, prop, battery } = b.info.components, ov = b.spec.overrides;
  const size = frame.sizeClass === 'whoop' ? `${frame.wheelbaseMm} mm` : `${Math.round(prop.diameterIn)}"`;
  const kv = Math.round(ov.kv ?? motor.kv), cells = Math.round(ov.cells ?? battery.cells);
  return `Custom · ${size} · ${motor.stator} ${kv}KV · ${cells}S`;
}
