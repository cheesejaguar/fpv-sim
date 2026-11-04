// Starting ArduPilot's thread in the browser: a module worker per firmware instance, the firmware
// served from public/ap/ (firmware/apwasm/build.sh).
import type { ApSpawn } from './apLink';
import type { ApVehicle } from './apConfig';

/** URL of a vehicle's firmware module (its .wasm and threads load next to it). */
export const apModuleUrl = (vehicle: ApVehicle, origin = self.location.origin) => new URL(`/ap/ardu${vehicle}.mjs`, origin).href;

export const browserSpawn: ApSpawn = (init, onMessage) => {
  const w = new Worker(new URL('./ap.worker.ts', import.meta.url), { type: 'module', name: 'ardupilot' });
  w.onmessage = (ev) => onMessage(ev.data);
  w.onerror = (ev) => { ev.preventDefault(); onMessage({ type: 'error', reason: ev.message || 'ArduPilot worker error' }); };
  w.postMessage(init);
  return { terminate: () => w.terminate() };
};
