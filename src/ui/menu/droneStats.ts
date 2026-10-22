// Weight / thrust-to-weight / flight time for drone cards, computed in a worker and cached
// (memory + localStorage, keyed by the spec) so the New Game screen opens instantly. The presets'
// numbers come prebuilt (scripts/build-bemt-tables.mjs, via vite.config.ts): the menu's warm-up of
// every preset no longer costs ~1.2 s of worker CPU per prop on a first visit.
import { preloadPropTable, type DroneSpec } from '../../builder/derive';

export interface DroneStats { auwG: number; tw: number; minutes: number }

/** Defined by vite.config.ts: prebuiltKey(preset) -> its numbers (null: not available). */
declare const __DRONE_STATS__: Record<string, DroneStats> | null | undefined;

const LS = 'fpv-drone-stats-v1';
const cache = new Map<string, DroneStats>();
try { for (const [k, v] of Object.entries(JSON.parse(localStorage.getItem(LS) || '{}'))) cache.set(k, v as DroneStats); } catch { /* ignore */ }
const prebuilt = typeof __DRONE_STATS__ === 'object' && __DRONE_STATS__ ? __DRONE_STATS__ : {};
const waiting = new Map<string, ((s: DroneStats | null) => void)[]>();
let worker: Worker | null = null;

function persist() {
  try { localStorage.setItem(LS, JSON.stringify(Object.fromEntries([...cache].slice(-40)))); } catch { /* ignore */ }
}

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./droneStats.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<{ key: string; stats: DroneStats | null }>) => {
      const { key, stats } = e.data;
      if (stats) { cache.set(key, stats); persist(); }
      for (const cb of waiting.get(key) ?? []) cb(stats);
      waiting.delete(key);
    };
  }
  return worker;
}

export const statsKey = (s: DroneSpec) => JSON.stringify(s);
/** Short key of the prebuilt numbers (FNV-1a of statsKey): keeps them small in the bundle. */
export function prebuiltKey(s: DroneSpec): string {
  const k = statsKey(s);
  let h = 0x811c9dc5;
  for (let i = 0; i < k.length; i++) h = Math.imul(h ^ k.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, '0') + k.length.toString(16);
}

/**
 * Cached stats right now, or null (then call droneStats() to get them). The drone picker asks this
 * for every card it shows: the card's prop table is fetched meanwhile (~23 kB each), so picking
 * that drone doesn't stall the page while the table is built (buildDrone runs on the main thread).
 */
export function cachedStats(s: DroneSpec): DroneStats | null {
  void preloadPropTable(s.prop);
  return prebuilt[prebuiltKey(s)] ?? cache.get(statsKey(s)) ?? null;
}

export function droneStats(s: DroneSpec): Promise<DroneStats | null> {
  const key = statsKey(s);
  const hit = prebuilt[prebuiltKey(s)] ?? cache.get(key);
  if (hit) return Promise.resolve(hit);
  return new Promise((res) => {
    const list = waiting.get(key);
    if (list) { list.push(res); return; }
    waiting.set(key, [res]);
    getWorker().postMessage({ key, spec: s });
  });
}
