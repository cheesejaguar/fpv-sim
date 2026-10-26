# Verification campaigns and trade studies

A campaign flies many seeded episodes of a scenario, in parallel, scores them against written
requirements with statistical confidence, and writes a report a reviewer can sign off. A sweep turns
it into a trade study over design choices.

```bash
npm run campaign -- campaigns/delivery-drop.json                 # report in campaign-out/delivery-drop/
npm run campaign -- campaigns/battery-trade.json --runs 30 --workers 8
npm run campaign -- --case campaign-out/delivery-drop/cases/v0-r17.json   # re-fly one failure exactly
```

The exit code is 0 when every requirement passes, 1 when one fails, 2 when one is inconclusive and
3 on an error. That makes a campaign a CI gate on a firmware tune, a build or a controller.

Code:
- [`src/campaign/campaign.ts`](../src/campaign/campaign.ts): format, statistics, requirements;
- [`src/campaign/runner.ts`](../src/campaign/runner.ts): one run;
- [`src/campaign/pilot.ts`](../src/campaign/pilot.ts): the reference autopilot;
- [`src/campaign/report.ts`](../src/campaign/report.ts): reports;
- [`scripts/fpv-campaign.mjs`](../scripts/fpv-campaign.mjs): parallel runner (one worker thread
  per core, each with its own Betaflight).

Examples in [`campaigns/`](../campaigns):

| Campaign | What it asks |
| --- | --- |
| `delivery-drop.json` | parcel drops in wind from 0 to 7 m/s: success rate, miss distance, impact speed |
| `gnss-denied-route.json` | a route flown on GNSS, against a jammer and a spoofer (a sweep) |
| `motor-failure.json` | hover through a weakened motor or a damaged prop |
| `battery-trade.json` | battery × payload mass: energy, success and accuracy, with a Pareto front |

## The file

```jsonc
{
  "format": "fpvsim-campaign", "version": 1,
  "meta": { "id": "delivery-drop", "name": "…", "description": "…" },
  "runs": 200,                      // per variant
  "seed": 2026,
  "pilot": { "type": "reference", "navigation": "truth", "cruiseMs": 6, "cruiseAglM": 8 },
  "scenario": { … a scenario, with its randomization … },
  "sweep": { "drone.spec.battery": ["b6s1100", "b6s1300"], "ops.payload.massG": [150, 400] },
  "requirements": [
    { "id": "DEL-1", "text": "lands within 3 m", "metric": "success", "rate": ">=", "value": 0.8, "confidence": 0.9 },
    { "id": "DEL-2", "metric": "missM", "stat": "p95", "op": "<=", "value": 2.5, "where": "success" }
  ],
  "objectives": [{ "metric": "energyWh", "goal": "min" }, { "metric": "success", "goal": "max" }],
  "saveFailures": 5
}
```

### Pilots

| `type` | What flies |
| --- | --- |
| `reference` | the built-in mission autopilot. It flies the task's goal through Betaflight in angle mode, the way a companion computer would: climb, cruise, hold, then release a payload when its ballistic prediction lands on the target. `navigation: "gnss"` flies on the GNSS solution (horizontal) and the barometer (height), so jamming and spoofing reach it as they would a real stack. Options: `cruiseMs`, `maxTiltDeg`, `cruiseAglM`, `angleLimitDeg` |
| `module` | your controller: `path` to an ES module exporting `createPilot({ scenario, seed, hoverThrottle, options })`, which returns `{ act(obs) }`. `act` returns an action (API.md), or `{ action, release }`. The observation is the same as the API's |
| `none` | sticks centred, throttle at hover: a passive quad for fault surveys and link surveys |

### Sweeps

Each key is a dotted path into the scenario, and its list holds the values to try. Array indexes
are allowed: `ops.emitters.0.kind`. Every combination is a variant.

Run *k* of every variant uses the same seed, so variants are compared on the same wind, starts and
fault timings (common random numbers). The comparison then reflects the design difference, not
luck.

### Metrics

Each run reports:
- its end `reason`: `success`, `failure`, `crash`, `out_of_bounds`, `timeout`;
- the task's metrics (`rmsErrorM`, `missM`, `bestLapS`, `passed` …);
- these:

| Metric | |
| --- | --- |
| `success`, `crashed` | flags |
| `flightS`, `distanceM`, `maxSpeedMs` | |
| `energyWh`, `mAh` | drawn from the pack |
| `minCellV` | sustained (0.5 s filtered) minimum cell voltage |
| `maxTiltDeg`, `maxImpactMs` | |
| `minLq` | the RC link's worst link quality |
| `gnssLostS`, `gnssSpoofedS`, `maxPosErrM` | navigation under jamming and spoofing |
| `payloadReleased`, `faults`, `fiberBroken` | |
| `impactX`, `impactY`, `impactSpeedMs` | drops |

`"metric": "reason=timeout"` is a flag too.

### Requirements

**Proportion requirements** (`rate: ">="` or `"<="`, `value`, `confidence`, default 0.9) count the
runs where the metric holds. They are judged on the exact one-sided Clopper–Pearson bound:

| Verdict | When (for `>=`) |
| --- | --- |
| pass | the lower bound clears the value |
| fail | the upper bound misses it |
| inconclusive | anything in between. The report says how many runs would settle it if no further failures came. 59 clean runs show ≥ 95 % at 95 % confidence |

**Statistic requirements** (`stat`: `mean`, `p50`, `p90`, `p95`, `p99`, `max`, `min`; `op`;
`value`) compare that statistic over the runs. `where: "success"` restricts them to successful
runs, for example the miss distance of drops that happened.

## The report

`report.html` is self-contained (no scripts or external files), alongside `report.md` and
`report.json`. The JSON holds every run's outcome. The report shows:
- the overall verdict (the worst over every variant);
- per variant: how runs ended, the requirement verdicts with what was measured, metric
  distributions (mean with 95 % CI, p50, p95, min, max), and drop accuracy (CEP50, CEP90, R95 and
  an impact scatter);
- the failure cases kept;
- for sweeps, the trade-study table with the Pareto-optimal variants.

### Failure cases

Up to `saveFailures` failed runs per variant are kept in `cases/`:
- a case file (scenario, seed, pilot, outcome, events);
- a 20 Hz CSV trace (position, velocity, attitude, height, throttle, cell voltage, link quality,
  satellites).

`--case FILE` re-flies one and checks the outcome is identical. Determinism holds for the same
scenario, seed, pilot, firmware and simulator build.

## Speed

Each worker runs its own Betaflight and plant at about 10× real time.
- With 4 cores, 40 parcel drops of 10–40 s each take about 35 s.
- A 1,000-run campaign of 30 s episodes on 16 cores takes about 3–4 minutes.
