// Weight / thrust-to-weight / flight time for drone cards, computed in a worker and cached
// (memory + localStorage, keyed by the spec) so the New Game screen opens instantly.
import type { DroneSpec } from '../../builder/derive';

export interface DroneStats { auwG: number; tw: number; minutes: number }

const LS = 'fpv-drone-stats-v1';
const cache = new Map<string, DroneStats>();
try { for (const [k, v] of Object.entries(JSON.parse(localStorage.getItem(LS) || '{}'))) cache.set(k, v as DroneStats); } catch { /* ignore */ }
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

/** Cached stats right now, or null (then call droneStats() to get them). */
export function cachedStats(s: DroneSpec): DroneStats | null { return cache.get(statsKey(s)) ?? null; }

export function droneStats(s: DroneSpec): Promise<DroneStats | null> {
  const key = statsKey(s);
  const hit = cache.get(key);
  if (hit) return Promise.resolve(hit);
  return new Promise((res) => {
    const list = waiting.get(key);
    if (list) { list.push(res); return; }
    waiting.set(key, [res]);
    getWorker().postMessage({ key, spec: s });
  });
}
