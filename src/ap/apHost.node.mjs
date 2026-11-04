// ArduPilot's thread in Node (src/ap/apNode.ts): a worker thread running src/ap/apHost.mjs.
import { parentPort, workerData } from 'node:worker_threads';
import { runArduPilot } from './apHost.mjs';

runArduPilot(workerData, (m) => parentPort.postMessage(m));
