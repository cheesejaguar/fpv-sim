# fpvsim-api v1: the control API

The control API lets a program fly FPV Sim and read its state. The same JSON messages work in
three setups:

| Backend | Clock | What it is for | Start it with |
| --- | --- | --- | --- |
| **Headless, lock-step** | the program steps it | research, reinforcement learning, batch evaluation: deterministic, as fast as the CPU allows (~5–10× real time per core with Betaflight in the loop) | `npm run api` |
| **Headless, real time** | the wall clock | a game engine or custom front end drawing the world, with FPV Sim as its flight model | `npm run api -- --realtime` |
| **Live game** | the wall clock | the browser game itself, with its rendering, sound and HUD: bots, assisted flying, demos, datasets from the camera | `npm run api -- --live`, then open the sim with `?api=ws://127.0.0.1:8765` |

All three run the same flight core: Betaflight 4.5.5 compiled to WebAssembly, in lock-step with
the physics at 8 kHz ([`src/worker/flightCore.ts`](../src/worker/flightCore.ts)).

- Protocol: [`src/api/protocol.ts`](../src/api/protocol.ts). Headless backend:
  [`src/api/headlessBackend.ts`](../src/api/headlessBackend.ts). Live backend:
  [`src/app/liveApi.ts`](../src/app/liveApi.ts). Transports:
  [`src/api/nodeServer.ts`](../src/api/nodeServer.ts), [`scripts/fpv-api.mjs`](../scripts/fpv-api.mjs).
- Python client and Gymnasium environment: [`python/`](../python/README.md).
- Tests: [`tests/apiServer.test.ts`](../tests/apiServer.test.ts),
  [`tests/headlessEnv.test.ts`](../tests/headlessEnv.test.ts).

## Transports

**TCP, newline-delimited JSON.** `npm run api` listens on `127.0.0.1:7878`. Each connection gets
its own headless simulation. Options:

| Option | Meaning |
| --- | --- |
| `--port N` | TCP port (default 7878) |
| `--host ADDR` | listen address (default `127.0.0.1`; anything else lets other computers in) |
| `--realtime` | the simulation runs on the wall clock (no `step`) |
| `--stdio` | one simulation over stdin / stdout instead of TCP (logs on stderr) |
| `--scenario FILE` | the default scenario of each connection's first `reset` |
| `--map FOLDER\|ZIP` | register a map package from disk (a folder or a `.zip`, such as a map builder export) under its `meta.id`, so scenarios can use it as `map.id`; repeatable. Validated at start: a broken package stops the server |
| `--live` | relay to the browser game (below) |
| `--ws-port N` | `--live`: the WebSocket port the page connects to (default 8765) |
| `--origin URL` | `--live`: another page origin allowed to connect |

**The live game.** `npm run api -- --live` starts a relay: programs connect to it over TCP, as to a
headless simulation, and the simulator page connects to it over a WebSocket. Open the simulator
with `?api=ws://127.0.0.1:8765` in the address, for example
`https://fpv-sim-gamma.vercel.app/?api=ws://127.0.0.1:8765` or
`http://localhost:5173/?api=ws://127.0.0.1:8765`. The page asks before it connects. You can also
connect from **Settings → Research → Control API**. A banner shows while a program is connected
or flying, and one click takes the controls back.

- The page only connects to relays on this computer (`ws://localhost` or `ws://127.0.0.1`).
- The relay only accepts pages from `localhost`, `127.0.0.1` and the public site (`--origin` adds
  more), and listens on the loopback interface.
- Several programs can share one page: request ids are kept per program, and events go to all of them.

**In the page.** `window.fpvSim` has the same commands as promises, for devtools, userscripts and
browser automation (Playwright):

```js
await fpvSim.reset({ format: 'fpvsim-scenario', version: 1, map: { id: 'gym' } });
await fpvSim.act({ arm: true, throttle: 0.45, mode: 'angle' });
const { obs } = await fpvSim.state();
const off = await fpvSim.on('gate', (e) => console.log('gate', e.gate));
await fpvSim.release();
```

`fpvSim.call(cmd, params)` sends any command; `fpvSim.connect(url)` connects to a relay.

## Messages

A request is one JSON object with `cmd` and an optional `id` (a number or a string). The answer
carries the same `id` and `"ok": true` with the result's fields, or `"ok": false` and `"error"`.
Requests are answered in the order they arrive. Events have an `event` field and no `id`.

```jsonc
→ {"id": 1, "cmd": "reset", "scenario": {"format": "fpvsim-scenario", "version": 1, "map": {"id": "gym"}}, "seed": 7}
← {"id": 1, "ok": true, "obs": {...}, "info": {"seed": 7, "episode": {...}, "drone": {...}}, "vectorLabels": [...]}
→ {"id": 2, "cmd": "step", "action": {"throttle": 0.5, "arm": true}}
← {"id": 2, "ok": true, "obs": {...}, "reward": 0.01, "terminated": false, "truncated": false, "info": {...}}
← {"event": "gate", "gate": 3, "t": 12.4}
```

Messages are limited to 1 MiB (the live relay accepts 16 MiB from the page: captures carry
images). Unknown commands, unknown keys in an action and out-of-range values are refused before
any simulation sees them. A connection whose first line is not a JSON object (an HTTP request a web
page made a browser send, for example) is closed. A client that stops reading has events dropped
once 32 MiB are waiting, and is disconnected if a reply can't be queued.

## Commands

| Command | Parameters | Answer | Headless lock-step | Headless real time | Live |
| --- | --- | --- | :-: | :-: | :-: |
| `hello` | | protocol, version, backend, clock, app, firmware, commands, vectorLabels | ✓ | ✓ | ✓ |
| `reset` | `scenario?`, `seed?`, `pilot?` | `obs`, `info`, `vectorLabels` | ✓ | ✓ | ✓ |
| `step` | `action?`, `steps?` (1–100000), `vector?` | `obs`, `reward`, `terminated`, `truncated`, `info`, `vec?` | ✓ | | |
| `act` | `action` | | ✓ | ✓ | ✓ |
| `release` | | | | | ✓ |
| `state` | `vector?` | `obs`, `metrics`, `vec?` | ✓ | ✓ | ✓ |
| `subscribe` | `stream: "state"`, `hz?` (default 60) | `hz` | | ✓ | ✓ |
| `unsubscribe` | `stream: "state"` | | | ✓ | ✓ |
| `cli` | `lines` (Betaflight CLI, disarmed) | `output` | ✓ | ✓ | ✓ |
| `respawn` | `fullBattery?` | | ✓ | ✓ | ✓ |
| `teleport` | `pos` [x, y, z], `yawDeg?` | | ✓ | ✓ | ✓ |
| `pause` / `resume` | | | | ✓ | ✓ |
| `metrics` | | `metrics` | ✓ | ✓ | ✓ |
| `capture` | `rgb?`, `received?`, `depth?`, `segmentation?` | `labels`, PNGs (base64) | | | ✓ |
| `record` | `action: "start" \| "stop"`, `hz?`, kinds, `maxFrames?` | `frame` events; stop: `frames`, `dropped`, `meta` ([DATASET.md](DATASET.md)) | | | ✓ |
| `fault` | `faults`: [{ `at`, `kind`, `motor?`, `axis?`, `value?`, `duration?` }] (`at` counts from now) | | ✓ | ✓ | ✓ |
| `drop` | | (releases the payload) | ✓ | ✓ | ✓ |
| `ops` | `config`: an `ops` block, or null to remove it | `status` (headless) | ✓ | ✓ | ✓ |
| `linkmap` | `centre?` [x, y], `halfM?` (200), `n?` (21), `heightM?` (20) | `map`: `xs`, `ys`, `marginDb`, `jammedFrac`, `gnssSats`, `pilot`, `link` | ✓ | ✓ | |
| `bye` | | | ✓ | ✓ | ✓ |

**fault**, **drop**, **ops** and **linkmap** drive the operational layer: jammers and spoofers,
the fibre-optic link, scheduled faults and the payload ([OPERATIONS.md](OPERATIONS.md)). In the
live game they work on the running flight (the Research tab's Operations section uses the same
messages).

**reset** starts an episode. The scenario ([SCENARIO_FORMAT.md](SCENARIO_FORMAT.md)) sets up the
map, drone, conditions, Betaflight configuration, start, task and limits. Without one, the last
scenario is used again (the server's `--scenario`, else free flight on the stadium map).
- **Headless:** every reset boots a fresh Betaflight: the simulator's defaults, the scenario's CLI,
  level calibration, the boot grace, then arming if `start.armed`. That takes about one second.
  `seed` picks the episode. Without a seed, episode *k* of the connection gets
  `subSeed(scenario.seed, k)`, and `info.seed` says which seed was used, so any episode can be
  repeated exactly.
- **Live game:** the reset applies the scenario to the running game (map, drone, conditions,
  Betaflight lines), closes the menu, respawns and starts the task. It is not reproducible
  (`info.reproducible: false`). With `pilot: true` the pilot flies it: the scenario's switches
  aren't taken over.

`info.drone` has the build's derived numbers: weight, thrust-to-weight, the throttle that holds a
hover, inertia, cells, capacity.

**step** (headless lock-step) applies the action and simulates `steps` control periods: one by
default, each `1 / episode.controlHz` long. It stops early when the episode ends. `reward` is the
sum. `vector: true` adds `vec`, the observation as a fixed-order list of numbers (below).

**act** sets the sticks and switches from now on. In the live game the program takes over from the
pilot's controller until `release` (or until someone clicks the banner). Arming there works the way
a pilot does it: while the action asks for `arm: true` and the quad isn't armed yet, the throttle is
held down, and the switch goes on once nothing else blocks arming. Headless, the action reaches
Betaflight exactly as given: arm with the throttle low.

**state** returns the newest observation (and the task's metrics so far). In real time,
`subscribe` streams it as `state` events instead of polling.

**cli** runs Betaflight CLI lines and returns the output. Betaflight ignores the CLI while armed.
End with `save` to keep a change. Saving reboots the flight controller, and in the live game it
also ends a reproducible run.

## Actions

```jsonc
{
  "roll": 0.0,      // -1 .. 1: right positive (Mode 2 right stick, left / right)
  "pitch": 0.0,     // -1 .. 1: forward positive (nose down)
  "yaw": 0.0,       // -1 .. 1: clockwise positive (seen from above)
  "throttle": 0.0,  //  0 .. 1
  "arm": true,      // AUX1
  "mode": "angle",  // AUX2: "acro" | "horizon" | "angle"
  "turtle": false,  // AUX3: crash flip
  "beeper": false,  // AUX4
  "rc": [1500, 1500, 1000, 1500]  // or raw RC channels (µs, AETR + AUX, up to 16): full control
}
```

Every field is optional. Sticks and switches not given stay where they were. The channels reach
Betaflight through the simulated ExpressLRS link (packet rate, range and fading as configured), as a
radio's would.

## Observations

```jsonc
{
  "t": 3.21,                              // episode time (s)
  "pos": [x, y, z], "vel": [vx, vy, vz],  // world ENU (x east, y north, z up), m and m/s
  "quat": [w, x, y, z],                   // attitude, body FLU -> world ENU
  "euler": [roll, pitch, yaw],            // rad: right wing down +, nose up +, heading counter-clockwise from east
  "rates": [p, q, r],                     // true body rates (rad/s, FLU)
  "gyro": [gx, gy, gz],                   // what Betaflight's gyro reads (noise, bias, vibration)
  "acc": [ax, ay, az],                    // specific force (m/s², body); null in the live game
  "motorRpm": [4], "motorCmd": [4],       // motor speeds, and Betaflight's DShot commands (0..2047)
  "rc": [roll, pitch, throttle, yaw],     // the channels Betaflight last received (µs)
  "battery": { "v", "i", "soc", "mah", "cellV" },
  "armed": true, "armingFlags": [],       // why Betaflight refuses to arm (e.g. "THROTTLE")
  "agl": 1.9,                             // height above the ground below (m)
  "goal": [x, y, z], "goalBody": [x, y, z], // where the task wants the quad next: world, and in the body frame
  "probes": [d0, d1, ...],                // proximity probes (m), see below
  "gate": { "next": 2, "total": 8 },
  "impact": 0, "damage": 0,               // peak impact speed this step (m/s), prop damage
  "nav": { "mag": [3], "rangeM": 2.9, "flow": { "x", "y", "quality" } },  // observations.nav: compass (gauss), downward rangefinder, optical flow
  "ops": { "link", "video", "gnss", "fix", "fiber", "payload", "faults" }, // with an ops block: the operational picture (OPERATIONS.md)
  "actors": {                            // only with the scenario's observations.actors (maps with actors)
    "targets": [{ "id": "truck", "pos": [x, y, z], "vel": [vx, vy, vz] }], // every target actor, map order (pos: its base)
    "detected": ["radar-1"],              // detectors holding a detection of the quad now
    "rcMarginDb": 12.5                    // RC uplink margin (dB), jammers included
  }
}
```

With a sensor fault in force (`gyro_bias`, `acc_bias` …), `gyro` and `acc` are the faulty readings
the firmware got; `rates` stays the truth.

**Vector.** `vec` (with `vector: true`) is `obsVector()` ([`src/api/types.ts`](../src/api/types.ts)):
pos, vel, quat, rates, gyro, acc (zeros when null), rpm / 10000 ×4, cellV, armed, agl, goalBody,
probes, and with `observations.actors` at the end: each target's pos and vel, the number of
detectors holding a detection (`detectedCount`), `rcMarginDb`. `vectorLabels` names each entry.
The Gymnasium environment uses this layout.

**Probes.** `observations.probes` in the scenario adds proximity rays on a Fibonacci sphere around
the quad (body frame), like HyperDrone's collision probes. Each value is the distance to the first
hit, capped at `probeRangeM`. The rays see terrain, boxes and level geometry, but not trees, poles
or other cylinders.

## Events

| Event | Fields | When |
| --- | --- | --- |
| `state` | `obs` | at the subscribed rate (real time) |
| `gate` | `gate`, `t` | the next gate of the course was passed |
| `impact` | `speed`, `t` | a collision |
| `episode` | `reason`, `metrics` | the task ended: `success`, `failure` (the task can no longer succeed, e.g. a `drop` that missed), `crash`, `out_of_bounds`, `timeout`, `detected` (a `detect-avoid` task detected for longer than it allows) (live game: also `respawn`) |
| `detect` | `detector`, `on`, `t` | headless (`info.events`): a detector of the map's actors began (`on: true`) or stopped holding a detection of the quad |
| `log` | `text` | simulator and Betaflight messages |
| `control` | `by`: `api` / `pilot` | live game: who flies |
| `frame` | `labels`, PNGs | live game: a recorded dataset frame (`record`) |
| `ops` | `type` (`fault`, `payload_release`, `payload_impact`, `fiber_break`, `gnss`), `t`, details | the operational layer: a fault on or off, the payload released or landed, the fibre broke, the GNSS state changed |
| `bye` | `reason` | live game: the page went away |

Lock-step episodes report gates, impacts, detections, logs and operational events in `step`'s
`info.events` instead (operational events with their own `type`).

## Rewards and metrics

Tasks are scored by [`src/scenario/tasks.ts`](../src/scenario/tasks.ts), and the same code scores
in-app training drills.

| Task | Reward | Ends with success | Metrics |
| --- | --- | --- | --- |
| `hover` | per second `exp(-(e/r)²)`: e is the distance to the target, r the box radius | inside for `holdS` in a row | inside time and fraction, RMS / max error, `normalizedError` = RMS / r |
| `gates` | metres closed toward the next gate's opening, +10 per gate | the last lap's finish through gate 0 | passed / total, splits, lap times |
| `waypoints` | metres closed toward the next point, +10 per point | every point visited | passed / total, splits |
| `reach-target` | metres closed toward the target, +10 when reached | within `radiusM` of the target for `holdS` | `targetDistM`, `minTargetDistM`, `reachedS` |
| `track-target` | 1 per second tracked: within `rangeM` and `fovDeg` of the camera axis | tracked `holdS` in a row | `trackedS`, `trackedFraction`, `targetDistM`, `minTargetDistM` |
| `detect-avoid` | metres closed toward the next point, +10 per point, −5 per second detected | the route flown, detected at most `maxDetectedS` in all (more: the episode ends, `detected`) | passed / total, splits, `failed` |
| `drop` | horizontal metres closed toward the target, +10 for a hit | the payload lands within `radiusM` (a miss ends the episode with `failure`) | `missM`, `impactSpeedMs`, `impactPos` |
| `free` | 0 | never | distance, top speed |

Every task also reports elapsed time, distance flown, top speed and the return. On a map with
detectors, every task also reports `detectedS` (seconds detected) and `firstDetectT` (s since the
start, `null`: never).

**Map packages from disk.** Headless, `--map` (above) or `createNodeEnv({ maps: [folder, zip] })`
([`src/headless/node.ts`](../src/headless/node.ts)) registers packages before the first reset;
they keep their `meta.id`, which may not be the id of one of the simulator's own maps.

## Python

```python
from fpvsim import Client, FpvSimEnv

with Client.launch() as sim:                       # a private headless simulation (node scripts/fpv-api.mjs --stdio)
    r = sim.reset(scenario="scenarios/hover-whoop-gym.json", seed=1)
    while True:
        res = sim.step(throttle=r["info"]["drone"]["hoverThrottle"])
        if res["terminated"] or res["truncated"]:
            break

env = FpvSimEnv("scenarios/hover-randomized.json")  # gymnasium.Env, actions [roll, pitch, yaw, throttle]
```

See [`python/README.md`](../python/README.md) and the examples in `python/examples/`.

## Performance

On one core, measured in the development container: about 11.7 µs per 8 kHz physics step with
Betaflight in the loop (5" quad, stadium map, `npm run bench:sim`). That is about 10× real time;
with observations, probes and TCP, lock-step episodes run at about 5×. A reset boots Betaflight in
about one second. Run one process per core for parallel rollouts (each `Client.launch()` is one).
