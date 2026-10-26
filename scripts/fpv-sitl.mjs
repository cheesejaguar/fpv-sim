#!/usr/bin/env node
// FPV Sim as the physics plant of an external autopilot (docs/AUTOPILOTS.md).
//
//   npm run sitl -- --px4                  PX4 SITL connects to tcp://127.0.0.1:4560 (lock-step HIL)
//   npm run sitl -- --ardupilot            ArduPilot SITL (--model JSON:127.0.0.1) on udp://127.0.0.1:9002
//
// Options: --scenario FILE (map, drone, wind, jammers / spoofers / faults / payload: docs/SCENARIO_FORMAT.md),
// --seed N, --port N, --host ADDR (default 127.0.0.1), --rate HZ (PX4 sensor / lock-step rate,
// default 250), --gps-hz HZ (PX4, default 10), --status S (print the state every S seconds, default 2),
// --write-params FILE (a starting parameter file for this build: geometry, hover throttle, battery).
// The drone flies with the scenario's build (props-in quad X, the autopilots' motor order).
import { readFileSync } from 'node:fs';
import { loadTs } from './lib/load-ts.mjs';

const args = process.argv.slice(2);
const flag = (k) => args.includes(k);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };
if (flag('--help') || flag('-h') || (!flag('--px4') && !flag('--ardupilot'))) {
  console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 11).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(flag('--help') || flag('-h') ? 0 : 1);
}
const log = (t) => process.stderr.write(`[fpv-sitl] ${t}\n`);
const host = opt('--host', '127.0.0.1');
const scenarioFile = opt('--scenario');
const scenario = scenarioFile ? JSON.parse(readFileSync(scenarioFile, 'utf8')) : undefined;
const { mods } = await loadTs('src/headless/node.ts', 'src/sitl/plant.ts', 'src/sitl/server.ts');
const [node, { SitlPlant }, { servePx4, serveArduPilot }] = mods;
node.installNodeHost();
const plant = new SitlPlant();
plant.onLog = log;
const seed = opt('--seed') !== undefined ? Number(opt('--seed')) : undefined;
const { episode } = await plant.reset(scenario, seed);
const f = plant.facts();
log(`${episode.spec.name} on ${episode.mapId}: ${(f.massKg * 1000).toFixed(0)} g, ${f.cells}S, thrust/weight ${f.thrustToWeight.toFixed(1)}, hover at ${(f.hoverThrottle * 100).toFixed(0)} % throttle`);
const paramsFile = opt('--write-params');
if (paramsFile) {
  (await import('node:fs')).writeFileSync(paramsFile, plant.autopilotParams(flag('--px4') ? 'px4' : 'ardupilot'));
  log(`wrote ${paramsFile}`);
}
if (flag('--px4')) {
  const port = Number(opt('--port', 4560));
  await servePx4(plant, { host, port, sensorHz: Number(opt('--rate', 250)), gpsHz: Number(opt('--gps-hz', 10)), log });
  log(`waiting for PX4 on tcp://${host}:${port}  (e.g. PX4-Autopilot: make px4_sitl none_iris)`);
} else {
  const port = Number(opt('--port', 9002));
  await serveArduPilot(plant, { host, port, log });
  log(`waiting for ArduPilot on udp://${host}:${port}  (e.g. sim_vehicle.py -v ArduCopter -f JSON --add-param-file=... or arducopter --model JSON:127.0.0.1)`);
}
const every = Number(opt('--status', 2));
if (every > 0) setInterval(() => {
  const s = plant.core.quad.s, o = plant.core.ops?.status(plant.core);
  log(`t ${plant.core.simT.toFixed(1)} s  pos ${[s.pos.x, s.pos.y, s.pos.z].map((v) => v.toFixed(1)).join(' ')}  ${Math.hypot(s.vel.x, s.vel.y, s.vel.z).toFixed(1)} m/s  ${s.vbus.toFixed(1)} V ${s.ibus.toFixed(0)} A${o && o.gnss.state !== 'ok' ? `  GNSS ${o.gnss.state}` : ''}${o?.faults.length ? `  faults: ${o.faults.join(', ')}` : ''}`);
}, every * 1000);
