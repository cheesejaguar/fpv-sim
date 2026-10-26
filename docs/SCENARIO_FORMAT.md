# fpvsim-scenario v1: the scenario format

A scenario is one JSON document that pins down an experiment or a drill: the map and course, the
drone, the conditions, Betaflight's configuration, the start, the task, the episode's limits, what
the observations include, and what is randomized. Handed to someone else, it gives them the same
setup. With a seed, it gives them the same episodes.

The same file works:
- in the **headless simulator**, through the control API or Python ([API.md](API.md)): each
  `reset` is one episode;
- in the **live game**: Settings → Research → Scenario, or the API's `reset` (the pilot or a
  program flies it, and the task is scored);
- in **training drills**, which generate their scenarios per level ([`src/training/curriculum.ts`](../src/training/curriculum.ts)).

- Parser and episode resolution: [`src/scenario/scenario.ts`](../src/scenario/scenario.ts).
  Randomization: [`src/scenario/randomize.ts`](../src/scenario/randomize.ts). Tasks:
  [`src/scenario/tasks.ts`](../src/scenario/tasks.ts).
- JSON Schema: [`schemas/scenario.v1.schema.json`](../schemas/scenario.v1.schema.json). The parser
  checks everything the schema does and more (map ids, preset names, component ids).
- Examples: [`scenarios/`](../scenarios/). Tests: [`tests/scenario.test.ts`](../tests/scenario.test.ts).

Units are metres, seconds and degrees. The world frame is ENU: x east, y north, z up.

## Example

```json
{
  "$schema": "../schemas/scenario.v1.schema.json",
  "format": "fpvsim-scenario",
  "version": 1,
  "meta": { "id": "hover-randomized", "name": "Hover under domain randomization", "license": "CC0-1.0" },
  "seed": 42,
  "map": { "id": "practice" },
  "drone": { "preset": "5\" Freestyle 6S" },
  "start": { "armed": true, "mode": "angle" },
  "task": { "type": "hover", "heightM": 2, "radiusM": 1 },
  "episode": { "maxSeconds": 10, "controlHz": 100, "crashSpeedMs": 3 },
  "observations": { "probes": 16, "probeRangeM": 20 },
  "randomize": {
    "drone": {
      "parts": { "battery": { "choice": ["b6s1300", "b6s1100", "b6s1300hv"] } },
      "overrides": { "massScale": { "uniform": [0.9, 1.15] }, "propThrustScale": { "normal": [1, 0.05], "min": 0.85, "max": 1.15 } },
      "unit": true
    },
    "sim": { "windSpeed": { "uniform": [0, 6] }, "windDirection": { "uniform": [0, 360] } },
    "start": { "dz": { "uniform": [1.5, 2.5] }, "yawDeg": { "uniform": [-180, 180] } }
  }
}
```

## Fields

Only `format` and `version` are required. Unknown keys are errors, so a typo never silently falls
back to a default.

| Field | Meaning |
| --- | --- |
| `format`, `version` | `"fpvsim-scenario"`, `1` |
| `meta` | `id`, `name`, `description`, `author`, `license` (all text) |
| `seed` | master seed, 0 … 2³²−1 (default 0). Episode *k* of a run without explicit seeds is seeded with `subSeed(seed, k)`. |
| `map` | `{ "id": "<map id>", "course": "<course id>" }`: built-in maps, `bando`, `quake-e1m1` … and community maps. `course` picks a drill course (the Practice Field's `slalom`, `figure8`, `powerloop`). Default: `field`. |
| `drone` | `preset` (a preset's name, as in New game → Drone) and / or `spec`: fields of a drone build over it (components by catalogue id, `cameraUptiltDeg`, `batterySoc`, `overrides` …, see `DroneSpec` in [`src/builder/derive.ts`](../src/builder/derive.ts)). `spec.unitSeed` picks another unit of the same build: its own sensor offsets, cell spread and arm detuning. Default: the 5" freestyle quad. |
| `sim` | simulation settings: `physicsHz` (2000, 4000, 8000), `wind` (`speed` m/s at 6 m, `direction` FROM in degrees, `turbulence`, `gusts` per minute), `damage`, `propwash`, `rcLinkHz`, `rcTxPowerMw`, `ambientC`. The physics rate never changes during a scenario. |
| `firmware.cli` | Betaflight CLI lines run after the simulator's defaults and saved, such as a `diff all` from a real quad. Lines that describe the board's hardware are dropped, as Settings → Betaflight → *Bring your real quad* does. Rejected lines are reported (`info.cliErrors`). |
| `start` | `pos` [x, y, z] (default: the map's or course's spawn pad), `yawDeg` (counter-clockwise from east), `armed` (arm once Betaflight's boot grace is over), `mode` (`acro`, `horizon`, `angle`: AUX2). |
| `task` | what the episode asks (below). Default: `{ "type": "free" }`. |
| `episode` | `maxSeconds` (default 30), `controlHz` (actions per second, default 100), `endOnCrash` (default true) at `crashSpeedMs` (default 4 m/s), `endOutOfBounds` (default true). |
| `observations` | `probes`: proximity rays (0–256, default 0); `probeRangeM` (default 20). |
| `randomize` | domain randomization (below). |

## Tasks

| Type | Fields | Success |
| --- | --- | --- |
| `free` | | none: the episode runs to its time limit |
| `hover` | `target` [x, y, z] or `heightM` above the pad (default 3), `radiusM` (default 1.5), `holdS` | inside the box for `holdS` seconds in a row (without `holdS`: none, scored by time inside) |
| `gates` | `laps` (default 1) | every gate of the course in order, then through gate 0 again: a lap as the lap timer counts it |
| `waypoints` | `points` [[x, y, z], …], `radiusM` (default 1) | every point visited in order |

Rewards and metrics are in [API.md](API.md#rewards-and-metrics).

## Randomization

Every randomized value is a **distribution**:

| Form | Draws |
| --- | --- |
| a number or a string | that value |
| `{ "uniform": [min, max] }` | uniform in [min, max) |
| `{ "loguniform": [min, max] }` | uniform in log space (scales, rates), 0 < min |
| `{ "normal": [mean, sd], "min": a, "max": b }` | normal, clipped to [a, b] (both optional) |
| `{ "choice": [v1, v2, …], "weights": [w1, w2, …] }` | one of the values (weights optional) |

| Group | Keys |
| --- | --- |
| `randomize.drone` | `preset` (names), `parts.{frame, motor, prop, battery, esc, fc, video}` (catalogue ids), `overrides.<name>` (any builder override: `massScale`, `inertiaScale`, `propThrustScale`, `kv`, `cdAScale`, `irPerCellMohm` …), `cameraUptiltDeg`, `batterySoc`, `batteryAge`, `extraMassG`, `extraMassZmm`, `motorTiltDeg`, `unit` (a new unit per episode, default true) |
| `randomize.sim` | `windSpeed`, `windDirection`, `windTurbulence`, `windGusts`, `ambientC`, `propwash`, `rcLinkHz`, `rcTxPowerMw` |
| `randomize.start` | `dx`, `dy`, `dz` (offsets from the start, m), `yawDeg` (added to the start yaw) |

A randomized drone is **built**, not jittered. The sampled parts and overrides go through the
drone builder, which derives the mass budget, CG, inertia tensor, prop tables, motor and battery
models from them. A heavier draw moves the CG and the inertia with it, and another battery changes
the sag and the weight together. RAPTOR-style policies need exactly these correlations.

**Seeds.** An episode's seed decides everything random in it. Each randomized group draws from its
own stream (`subSeed(seed, 1)` for the drone, 2 for the conditions, 3 for the start), so adding a
drone range doesn't change the wind a seed draws. The episode seed also seeds every random process
in the simulation: wind turbulence, sensor noise, the radio link, rotor-wash noise. Headless,
`reset({ seed })` therefore repeats an episode bit for bit, given the same actions and firmware build.

## Versioning

`version` is 1. A later version that changes the meaning of a field gets a new number. The parser
refuses versions it doesn't know.
