#!/usr/bin/env node
// Verification campaigns and trade studies (docs/CAMPAIGNS.md): many seeded episodes of a scenario,
// flown by a pilot, in parallel, scored against requirements with statistical confidence.
//
//   npm run campaign -- campaigns/delivery-drop.json            run it; reports in campaign-out/<name>/
//   npm run campaign -- FILE --runs 50 --workers 4 --out DIR    override runs per variant, threads, output
//   npm run campaign -- --case DIR/cases/v0-r17.json            re-fly one saved run exactly (and its trace)
//
// Exit code: 0 all requirements pass, 1 a requirement fails, 2 inconclusive (more runs needed), 3 error.
import { cpus } from 'node:os';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { loadTs } from './lib/load-ts.mjs';

const args = process.argv.slice(2);
const flag = (k) => args.includes(k);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };
const log = (t) => process.stderr.write(`[campaign] ${t}\n`);
if (flag('--help') || flag('-h') || !args.length) {
  console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 10).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(args.length ? 0 : 3);
}
const toCsv = (labels, rows) => [labels.join(','), ...rows.map((r) => r.join(','))].join('\n') + '\n';

const { mods, close } = await loadTs('src/campaign/campaign.ts', 'src/campaign/report.ts', 'src/campaign/runner.ts', 'src/maps/maps.ts', 'src/ui/menu/about.ts', 'src/headless/node.ts');
const [C, R, runner, maps, about, node] = mods;
const app = `fpv-sim ${about.APP_VERSION ?? 'dev'}`;

if (flag('--case')) {
  // re-fly one saved run: the same scenario, seed and pilot give the same flight
  const file = resolve(opt('--case'));
  const k = JSON.parse(readFileSync(file, 'utf8'));
  const env = await node.createNodeEnv();
  const mod = k.pilot.type === 'module' ? await import(new URL(`file://${resolve(dirname(file), k.pilot.modulePath ?? k.pilot.path)}`).href) : undefined;
  const r = await runner.runEpisode(env, k.scenario, k.seed, k.pilot, { trace: true, module: mod });
  const same = JSON.stringify(r.outcome) === JSON.stringify(k.outcome);
  log(`${k.variant ?? ''} run ${k.run} seed ${k.seed}: ${r.outcome.reason} ${same ? '(identical to the campaign run)' : '(DIFFERENT from the campaign run: another firmware or simulator build?)'}`);
  for (const e of r.events) log(`  ${e}`);
  const out = file.replace(/\.json$/, '.refly.csv');
  writeFileSync(out, toCsv(runner.TRACE_LABELS, r.trace));
  log(`trace: ${out}`);
  await close();
  process.exit(same ? 0 : 1);
}

const file = resolve(args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1]?.startsWith('--') !== true) ?? '');
const raw = JSON.parse(readFileSync(file, 'utf8'));
if (opt('--runs')) raw.runs = Number(opt('--runs'));
const { campaign: c, errors } = C.parseCampaign(raw, (id) => id in maps.MAPS);
if (!c) { log(`invalid campaign:\n  ${errors.join('\n  ')}`); process.exit(3); }
const vs = C.variants(c);
const pilot = c.pilot ?? { type: 'reference' };
const modulePath = pilot.type === 'module' ? resolve(dirname(file), pilot.path) : undefined;
const nWorkers = Math.max(1, Math.min(Number(opt('--workers', Math.max(1, cpus().length))), vs.length * c.runs));
const outDir = resolve(opt('--out', join('campaign-out', (c.meta?.id ?? basename(file, '.json')).replace(/[^\w.-]+/g, '_'))));
mkdirSync(join(outDir, 'cases'), { recursive: true });
const saveFailures = c.saveFailures ?? 5;
log(`${c.meta?.name ?? basename(file)}: ${vs.length} variant(s) x ${c.runs} runs on ${nWorkers} worker(s) -> ${outDir}`);

const jobs = [];
for (const v of vs) for (let k = 0; k < c.runs; k++) jobs.push({ id: jobs.length, variant: v.index, run: k, seed: C.runSeed(c, v.index, k), scenario: v.scenario, pilot, trace: saveFailures > 0 });
const results = [], cases = [];
const kept = new Map();
let next = 0, done = 0, firmware = 'Betaflight 4.5.5 (WASM)';
const t0 = performance.now();
let lastLog = 0;
await new Promise((resolveAll, reject) => {
  let live = nWorkers;
  for (let w = 0; w < nWorkers; w++) {
    const worker = new Worker(new URL('./lib/campaign-worker.mjs', import.meta.url), { workerData: { modulePath } });
    const feed = () => { if (next < jobs.length) worker.postMessage(jobs[next++]); else { worker.postMessage('exit'); if (--live === 0) resolveAll(); } };
    worker.on('message', (m) => {
      if (m.ready) { firmware = m.firmware; feed(); return; }
      const job = jobs[m.job];
      if (!m.ok) { log(`run ${job.run} of variant ${job.variant} failed to run:\n${m.error}`); reject(new Error('a run crashed the simulator')); return; }
      const r = m.result;
      results.push({ variant: job.variant, run: job.run, seed: job.seed, outcome: r.outcome, wallMs: r.wallMs, events: r.events });
      if (!r.outcome.success && (kept.get(job.variant) ?? 0) < saveFailures) {
        kept.set(job.variant, (kept.get(job.variant) ?? 0) + 1);
        const name = `v${job.variant}-r${job.run}`;
        const caseFile = join(outDir, 'cases', `${name}.json`);
        writeFileSync(caseFile, JSON.stringify({ format: 'fpvsim-case', version: 1, campaign: c.meta?.name ?? basename(file), variant: vs[job.variant].label, run: job.run, seed: job.seed, pilot: { ...pilot, ...(modulePath ? { modulePath } : {}) }, scenario: job.scenario, outcome: r.outcome, events: r.events }, null, 1));
        if (r.trace) writeFileSync(join(outDir, 'cases', `${name}.csv`), toCsv(runner.TRACE_LABELS, r.trace));
        cases.push({ variant: job.variant, run: job.run, seed: job.seed, reason: r.outcome.reason, file: `cases/${name}.json`, events: r.events });
      }
      done++;
      const now = performance.now();
      if (now - lastLog > 2000 || done === jobs.length) { lastLog = now; log(`${done}/${jobs.length} runs (${((now - t0) / 1000).toFixed(0)} s)`); }
      feed();
    });
    worker.on('error', reject);
  }
});
const wallS = (performance.now() - t0) / 1000;
results.sort((a, b) => a.variant - b.variant || a.run - b.run);
const report = R.buildReport(c, vs, results, cases, { app, firmware, workers: nWorkers, wallS });
writeFileSync(join(outDir, 'report.json'), JSON.stringify({ ...report, runs: results }, null, 1));
writeFileSync(join(outDir, 'report.md'), R.reportMarkdown(report));
writeFileSync(join(outDir, 'report.html'), R.reportHtml(report));
for (const v of report.variants) {
  log(`${v.label || 'result'}: ${Object.entries(v.outcomes).map(([k, n]) => `${k} ${n}`).join(', ')}`);
  for (const x of v.verdicts) log(`  ${x.verdict.toUpperCase().padEnd(12)} ${x.id}: ${x.measured}`);
}
if (report.pareto.length) log(`Pareto front: ${report.pareto.map((i) => vs[i].label).join(' | ')}`);
log(`verdict ${report.verdict.toUpperCase()} · ${report.totals.runs} runs in ${wallS.toFixed(1)} s · ${join(outDir, 'report.html')}`);
await close();
process.exit(report.verdict === 'fail' ? 1 : report.verdict === 'inconclusive' ? 2 : 0);
