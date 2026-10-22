// Derives the headline numbers for drone cards off the main thread: buildDrone() builds the
// propeller BEMT table, ~1.2 s per prop, which would freeze the menu. The prebuilt table is fetched
// first when there is one (the presets' numbers themselves come prebuilt, see droneStats.ts).
import { buildDrone, droneCardStats, DroneSpec, preloadPropTable } from '../../builder/derive';

self.onmessage = async (e: MessageEvent<{ key: string; spec: DroneSpec }>) => {
  const { key, spec } = e.data;
  try {
    await preloadPropTable(spec.prop);
    self.postMessage({ key, stats: droneCardStats(buildDrone(spec).info) });
  } catch {
    self.postMessage({ key, stats: null });
  }
};
