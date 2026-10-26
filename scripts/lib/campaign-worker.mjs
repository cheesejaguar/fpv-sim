// A campaign worker thread (scripts/fpv-campaign.mjs): one headless simulator, runs one job at a time.
import { parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { loadTs } from './load-ts.mjs';

const { mods } = await loadTs('src/headless/node.ts', 'src/campaign/runner.ts');
const [node, runner] = mods;
const env = await node.createNodeEnv();
const pilotModule = workerData.modulePath ? await import(pathToFileURL(workerData.modulePath).href) : undefined;
parentPort.on('message', async (job) => {
  if (job === 'exit') process.exit(0);
  try {
    const r = await runner.runEpisode(env, job.scenario, job.seed, job.pilot, { trace: job.trace, module: pilotModule });
    if (r.outcome.success) delete r.trace;
    parentPort.postMessage({ ok: true, job: job.id, result: r });
  } catch (e) {
    parentPort.postMessage({ ok: false, job: job.id, error: String(e?.stack ?? e) });
  }
});
parentPort.postMessage({ ready: true, firmware: env.core?.bf?.version ?? 'Betaflight 4.5.5 (WASM)' });
