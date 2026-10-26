#!/usr/bin/env node
// FPV Sim control API server (docs/API.md).
//
//   npm run api                              headless, lock-step, TCP 127.0.0.1:7878 (one simulation per connection)
//   npm run api -- --realtime                headless on the wall clock (game engines, custom front ends)
//   npm run api -- --stdio                   one headless simulation over stdin / stdout
//   npm run api -- --live                    relay to the browser game: open the simulator with ?api=ws://127.0.0.1:8765
//
// Options: --port N (TCP, default 7878), --ws-port N (--live, default 8765), --host ADDR (default
// 127.0.0.1), --scenario FILE (the default scenario of every new connection), --origin URL (--live:
// another page origin allowed to connect; localhost pages and the public site always are).
// Needs the firmware build (public/bf, npm run firmware).
import { readFileSync } from 'node:fs';
import { loadTs } from './lib/load-ts.mjs';

const args = process.argv.slice(2);
const flag = (k) => args.includes(k);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };
const opts = (k) => args.flatMap((a, i) => (a === k && i + 1 < args.length ? [args[i + 1]] : []));
if (flag('--help') || flag('-h')) {
  console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 13).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(0);
}
const log = (t) => process.stderr.write(`[fpv-api] ${t}\n`);
const host = opt('--host', '127.0.0.1');
if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') log(`warning: listening on ${host}: anyone who can reach it can control the simulation`);
const scenarioFile = opt('--scenario');
const scenario = scenarioFile ? JSON.parse(readFileSync(scenarioFile, 'utf8')) : undefined;
const { mods } = await loadTs('src/api/nodeServer.ts', 'src/ui/menu/about.ts');
const [{ serveHeadless, serveRelay, serveStdio }, about] = mods;
const app = `fpv-sim ${about.APP_VERSION ?? 'dev'}`;

if (flag('--live')) {
  const r = await serveRelay({ port: Number(opt('--port', 7878)), wsPort: Number(opt('--ws-port', 8765)), host, origins: opts('--origin'), log });
  log(`live relay: programs connect to tcp://${host}:${r.port}; open the simulator with ?api=ws://127.0.0.1:${r.wsPort}`);
  log(`  e.g. https://fpv-sim-gamma.vercel.app/?api=ws://127.0.0.1:${r.wsPort}  or  http://localhost:5173/?api=ws://127.0.0.1:${r.wsPort}`);
} else if (flag('--stdio')) {
  await serveStdio({ clock: flag('--realtime') ? 'realtime' : 'lockstep', app, scenario, log });
  process.exit(0);
} else {
  const clock = flag('--realtime') ? 'realtime' : 'lockstep';
  const s = await serveHeadless({ clock, app, scenario, host, port: Number(opt('--port', 7878)), log });
  log(`headless (${clock}) on tcp://${host}:${s.port}: newline-delimited JSON, one simulation per connection`);
}
