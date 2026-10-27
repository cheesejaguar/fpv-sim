#!/usr/bin/env node
// Digital twin from a real Betaflight blackbox log (docs/DIGITAL_TWIN.md): replay the log's sticks
// through the simulator, report the sim-to-real gap, and fit the build to the log.
//
//   npm run twin -- flight.bbl                                 gap report for the default 5" build
//   npm run twin -- flight.bbl --preset "7\" Long Range Li-ion" --fit
//   npm run twin -- flight.bbl --spec my-drone.json --fit inertiaScale,propTorqueScale --evals 40
//
// Options: --log N (which log in the file, default the longest), --from S --to S (the stretch to
// compare, default the first 8 s of flight), --cli diff.txt (the drone's `diff all`; default: the
// tune rebuilt from the log's headers), --out DIR (default twin-out/<log name>).
// Writes report.md, report.html, gap.json and (with --fit) twin-spec.json: the fitted drone, ready for
// a scenario's "drone": { "spec": ... } or the app's drone builder.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { loadTs } from './lib/load-ts.mjs';

const args = process.argv.slice(2);
const flag = (k) => args.includes(k);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 && i + 1 < args.length && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const log = (t) => process.stderr.write(`[twin] ${t}\n`);
const file = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') && !['--fit'].includes(args[i - 1])));
if (flag('--help') || flag('-h') || !file) {
  console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 15).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(file ? 0 : 1);
}
const { mods, close } = await loadTs('src/headless/node.ts', 'src/sysid/bblDecode.ts', 'src/sysid/twin.ts', 'src/sysid/twinReport.ts', 'src/builder/derive.ts');
const [node, bbl, twin, rep, derive] = mods;
const logs = bbl.decodeBbl(new Uint8Array(readFileSync(resolve(file)))).filter((l) => l.frameCount > 100);
if (!logs.length) { log('no flight log in the file'); process.exit(1); }
const real = opt('--log') !== undefined ? logs[Number(opt('--log'))] : logs.reduce((a, b) => (b.frameCount > a.frameCount ? b : a));
log(`${logs.length} log(s); using #${real.index} (${real.frameCount} frames, ${real.sysConfig.firmwareRevision ?? 'unknown firmware'})`);
let spec;
if (opt('--spec')) spec = JSON.parse(readFileSync(opt('--spec'), 'utf8'));
else {
  const name = opt('--preset', derive.DEFAULT_SPEC.name);
  spec = derive.PRESETS.find((p) => p.name === name);
  if (!spec) { log(`no preset "${name}" (${derive.PRESETS.map((p) => p.name).join(', ')})`); process.exit(1); }
}
const cli = opt('--cli') ? readFileSync(opt('--cli'), 'utf8').split('\n') : undefined;
const s = bbl.bblSeries(real);
const auto = twin.autoSegment(s);
const segment = { fromS: Number(opt('--from', auto.fromS)), toS: Number(opt('--to', auto.toS)) };
const env = await node.createNodeEnv();
const t0 = performance.now();
const r = await twin.replayLog(env, real, { spec, cli, segment });
const gap = twin.compareLogs(real, r.sim, segment);
log(`gap: cost ${gap.cost.toFixed(4)}; ${rep.thrustNote(gap)}`);
let fit;
if (flag('--fit')) {
  const p = opt('--fit');
  const params = p ? p.split(',') : undefined;
  let k = 0;
  fit = await twin.fitTwin(env, real, { spec, cli, segment, params, maxEvals: Number(opt('--evals', 36)), onEval: (x, g) => log(`  fit ${++k}: ${Object.entries(x).map(([n, v]) => `${n} ${v.toFixed(3)}`).join(', ')} -> ${g.cost.toFixed(4)}`) });
  log(`fitted: ${Object.entries(fit.overrides).map(([n, v]) => `${n} ${v.toFixed(3)}`).join(', ')}; cost ${fit.before.cost.toFixed(4)} -> ${fit.after.cost.toFixed(4)}`);
}
const out = resolve(opt('--out', join('twin-out', basename(file).replace(/\.[^.]+$/, ''))));
mkdirSync(out, { recursive: true });
const view = { log: basename(file), spec: spec.name ?? 'custom', gap, fit, cliErrors: r.cliErrors };
writeFileSync(join(out, 'report.md'), rep.twinMarkdown(view));
writeFileSync(join(out, 'report.html'), rep.twinHtml(view));
writeFileSync(join(out, 'gap.json'), JSON.stringify({ gap, fit: fit ? { overrides: fit.overrides, before: fit.before, after: fit.after, history: fit.history } : null, cliErrors: r.cliErrors }, null, 1));
if (fit) writeFileSync(join(out, 'twin-spec.json'), JSON.stringify({ ...fit.spec, name: `${spec.name ?? 'drone'} (twin of ${basename(file)})` }, null, 2));
log(`${((performance.now() - t0) / 1000).toFixed(0)} s · ${join(out, 'report.html')}`);
await close();
