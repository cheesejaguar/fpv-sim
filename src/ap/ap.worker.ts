/// <reference lib="webworker" />
// ArduPilot's thread in the browser: runs the firmware (src/ap/apHost.mjs) on the init message.
// From then on this worker's event loop is blocked in ArduPilot's main loop; the simulation worker
// talks to it through shared memory only.
import { ApInit, runArduPilot } from './apHost.mjs';

self.onmessage = (ev: MessageEvent<ApInit>) => {
  self.onmessage = null; // one firmware per worker
  void runArduPilot(ev.data, (m) => (self as unknown as Worker).postMessage(m));
};
