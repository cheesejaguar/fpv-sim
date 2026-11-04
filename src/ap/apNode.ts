// Starting ArduPilot's thread in Node (the headless environment, the API server, tests): a worker
// thread, the firmware loaded from public/ap/ on disk.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { ApVehicle } from './apConfig';
import type { ApSpawn } from './apLink';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');

/** file: URL of a vehicle's firmware module, or null when it has not been built (bash firmware/apwasm/build.sh). */
export function apModuleFile(vehicle: ApVehicle): string | null {
  const f = path.join(root, 'public', 'ap', `ardu${vehicle}.mjs`);
  return existsSync(f) ? pathToFileURL(f).href : null;
}

export const nodeSpawn: ApSpawn = (init, onMessage) => {
  const w = new Worker(path.join(here, 'apHost.node.mjs'), { workerData: init });
  w.on('message', onMessage);
  w.on('error', (e: Error) => onMessage({ type: 'error', reason: e.message }));
  // the firmware never returns on its own: don't keep the process alive for it
  w.unref();
  return { terminate: () => { void w.terminate(); } };
};
