// Derives the headline numbers for drone preset cards off the main thread: buildDrone() builds the
// propeller BEMT tables, ~0.6 s per drone, which would freeze the menu.
import { buildDrone, DroneSpec } from '../../builder/derive';

self.onmessage = (e: MessageEvent<{ key: string; spec: DroneSpec }>) => {
  const { key, spec } = e.data;
  try {
    const i = buildDrone(spec).info;
    self.postMessage({ key, stats: { auwG: i.auwG, tw: i.thrustToWeight, minutes: i.flightTimeMixedMin } });
  } catch {
    self.postMessage({ key, stats: null });
  }
};
