# Digital twin from a flight log

Every Betaflight pilot can record a blackbox log. `npm run twin` turns one into:
- a **sim-to-real gap report**: how the simulator flies the same inputs, axis by axis;
- a **fitted twin**: the drone build adjusted until the simulated flight matches the log, saved as
  a spec that scenarios, campaigns, the API and the app's drone builder load directly.

```bash
npm run twin -- flight.bbl                                       # gap report, default 5" build
npm run twin -- flight.bbl --preset '7" Long Range Li-ion' --fit
npm run twin -- flight.bbl --spec my-drone.json --fit inertiaScale,propTorqueScale --evals 40 --from 12 --to 22
```

Options:

| Option | Default | |
| --- | --- | --- |
| `--log N` | the longest | which log in the file |
| `--from S` / `--to S` | the first 8 s of real flight | the stretch to compare |
| `--cli FILE` | rebuilt from the log | the drone's `diff all` |
| `--spec FILE` / `--preset NAME` | | the build on file |
| `--fit [params]` | | the scales to fit |
| `--evals N` | 36 | |
| `--out DIR` | `twin-out/<log>` | |

Output:
- `report.md` and `report.html`;
- `gap.json`;
- with `--fit`, `twin-spec.json`.

Code:
- [`src/sysid/bblDecode.ts`](../src/sysid/bblDecode.ts): a complete blackbox decoder (all
  encodings and predictors, resynchronisation like the reference parsers);
- [`src/sysid/twin.ts`](../src/sysid/twin.ts);
- [`src/sysid/twinReport.ts`](../src/sysid/twinReport.ts).

Tests:
- [`tests/bblDecode.test.ts`](../tests/bblDecode.test.ts);
- [`tests/twin.test.ts`](../tests/twin.test.ts).

## How it works

1. **The tune, from the log.** Betaflight writes its configuration into the log's headers. The
   twin rebuilds the CLI lines for:
   - PIDs, rates and rate type;
   - filters;
   - feedforward and TPA;
   - anti-gravity, dynamic idle and the rest.

   Simplified tuning is switched off so the logged values stand. A `--cli` diff can replace them.
2. **Replay.** The logged sticks are flown through the same Betaflight build, high above the
   ground in still air, so the flight can't hit anything:
   - roll, pitch and yaw come from `rcCommand` (yaw negated, as Betaflight flips it);
   - throttle is mapped back from Betaflight's `min_check` rescale;
   - for the gap report, a slow trim on the throttle keeps the simulated height on the log's
     `baroAlt`, so both fly the same vertical profile.
3. **Compare log with log.** The simulator records its own Betaflight blackbox during the replay.
   The same decoder reads it, and it is aligned with the real one on the setpoints, which come
   from the same sticks and rates. Comparing firmware signals with firmware signals means
   filtering, PIDs and the mixer are identical on both sides; what differs is the plant.

   Per axis, the report gives:

   | Measure | |
   | --- | --- |
   | gyro error and correlation | below ~40 Hz |
   | tracking error | gyro against setpoint, real and simulated |
   | setpoint-to-gyro delay | |
   | gyro noise | above ~100 Hz: vibration and filtering |
   | controller effort | P + I + D + F below ~10 Hz: what it took the loop to track |

   The motor output levels are reported with what they mean for thrust against weight.
4. **Fit.** Nelder–Mead searches the build's override scales in log space, minimising the gyro
   and effort mismatch. The default scales are `propThrustScale`, `inertiaScale` and
   `propTorqueScale`; `massScale` and `cdAScale` can also be fitted. Every evaluation is a full
   replay with the real firmware: about 2 s for an 8 s stretch.

## What to expect, and the limits

- **Weigh the drone.** A log shows thrust only against weight, and rotational authority only
  against inertia. Put the real all-up weight in the spec (`extraMassG`) and fit the rest. Fitting
  mass and thrust together is underdetermined.
- **The Betaflight loop hides the plant.** A well-tuned PID loop makes two different drones track
  the same setpoint. That is why the fit weighs the controller's effort, not just the gyro.
  Agile, varied flying (rolls, flips, throttle changes) identifies more than cruising.
- **Pick free flight.** Takeoffs, landings and flying close to the ground or to walls change the
  real drone's aerodynamics. The replay flies in free air, so compare a stretch of free flight.
- **Open loop.** The replay feeds the real sticks. The simulated attitude drifts away from the real
  one over a long stretch, and so does the drone's aerodynamic state. Short stretches (5–15 s)
  compare best.
- **Validated on synthetic truth.** The tests make a "real" log from a drone whose build differs
  from the one on file (inertia ×1.3, prop torque ×0.8):
  - a replay of the true build matches with gyro correlation above 0.99;
  - the build on file shows a clearly larger gap;
  - a 24-evaluation fit closes most of it, recovering inertia ≈1.5 and torque ≈0.73 in the right
    direction.

  Expect approximate, not exact, identification. Real logs add effects the plant may not model.
  That residual is what the gap report is for.
