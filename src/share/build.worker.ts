// Derives a build for the share card's drone render off the main thread: buildDrone() builds the
// propeller BEMT tables (~1 s on a desktop, longer on a phone), which would freeze the share sheet.
import { buildDrone, DroneSpec } from '../builder/derive';

self.onmessage = (e: MessageEvent<DroneSpec>) => {
  try {
    const b = buildDrone(e.data);
    self.postMessage({ spec: b.spec, info: b.info, rotors: b.params.rotors.map((r) => ({ ...r.pos, dir: r.dir })) });
  } catch (err) {
    self.postMessage({ error: String((err as Error)?.message ?? err) });
  }
};
