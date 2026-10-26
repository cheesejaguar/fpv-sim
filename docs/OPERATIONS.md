# Operations: radio environment, faults, payloads

The operational layer puts a drone in a contested, imperfect world. It covers:
- jammers and GNSS spoofers placed in the map;
- a fibre-optic link instead of radio;
- scheduled or injected faults on motors, props, sensors, links and the battery;
- a payload to carry and drop;
- the navigation sensors autonomy stacks need (compass, rangefinder, optical flow).

Every effect enters where it lives in the real hardware, so the real Betaflight reacts as it would:
- a lost packet never reaches the flight controller (RC failsafe);
- a gyro fault is in the samples the firmware reads (a confused attitude estimate);
- a spoofed fix goes to Betaflight's GPS code (GPS rescue to the wrong place).

Set it up in three ways, with the same configuration:
- a scenario's `ops` block ([SCENARIO_FORMAT.md](SCENARIO_FORMAT.md));
- the control API: `ops`, `fault`, `drop` and `linkmap` ([API.md](API.md));
- in the app: **Settings → Research → Operations**. The telemetry overlay (H) shows the link,
  jamming, GNSS and faults.

Code:
- [`src/worker/ops.ts`](../src/worker/ops.ts): the layer;
- [`src/sim/ew.ts`](../src/sim/ew.ts): propagation and jamming;
- [`src/sim/faults.ts`](../src/sim/faults.ts): fault kinds;
- [`src/sim/sensors.ts`](../src/sim/sensors.ts): the navigation sensors.

Tests: [`tests/ops.test.ts`](../tests/ops.test.ts).

```jsonc
"ops": {
  "link": { "type": "radio", "band": "2.4" },          // or "fiber"; "900" for 900 MHz ELRS
  "emitters": [
    { "id": "j1", "band": "2.4", "pos": [-44, -16, 3], "erpW": 20, "fromS": 2 },
    { "kind": "spoofer", "band": "gnss", "pos": [-44, -6, 10], "erpW": 1e-6, "driftMps": [2, 0, 0] }
  ],
  "faults": [{ "at": 4, "kind": "motor_degraded", "motor": 2, "value": 0.7 }],
  "payload": { "name": "parcel", "massG": 300, "cdA": 0.004, "releaseAux": 6 }
}
```

Times (`at`, `fromS`, `untilS`) count from the episode start (headless), or from when the
configuration was applied (live game, API `ops`). Positions are east, north and **height above the
ground** in metres.

## Emitters

| Field | Meaning |
| --- | --- |
| `kind` | `jammer` (noise over its band, the default) or `spoofer` (counterfeit GNSS) |
| `band` | `2.4` (80 MHz), `900` (26 MHz), `5.8` (300 MHz), `gnss` (20 MHz around L1), `1.2` (60 MHz). Or give `freqMHz` and `bandwidthMHz` |
| `erpW` | effective radiated power toward the drone (W) |
| `fromS` / `untilS` | when it is on |
| `driftMps` | spoofer: the counterfeit position walks away at this ENU velocity once it has captured the receiver |

**Propagation** to each receiver:
- free-space path loss;
- obstruction by the map's buildings, terrain and foliage (the video link's 5.8 GHz ray march,
  scaled down for lower frequencies: about 0.7 at 2.4 GHz and 0.45 at 900 MHz);
- diffraction past the 4/3-earth radio horizon, which is about 10 dB at the horizon and rises to
  40 dB at twice its range.

**Control link** (receiver on the drone): ELRS frequency hopping.
- A jammer covering a share *f* of the hop band hits that share of packets.
- A hit packet survives if the signal beats the jamming inside one receiver channel by LoRa's
  demodulation SNR: −2.5 dB at 500 Hz down to −10 dB at 50 Hz.
- So a partial-band jammer degrades the link instead of killing it.
- Betaflight sees exactly the packets that arrive. A jammer that lets 2–5 % through keeps
  Betaflight in its first failsafe stage, holding off the final stage, as real links do.

**Video link** (receiver at the pilot): jamming adds to the goggles' noise floor.
- Analog video degrades in snow.
- Digital video runs its break-up, freeze and resync state machine.

**GNSS** (receiver on the drone):
- jamming-to-signal ratio against the −127 dBm authentic signals, through a patch antenna that
  looks up (−4 dBi toward the horizon);
- effective C/N0 = 1 / (1/C/N0 + (J/S) / Rc);
- satellites below 26 dB-Hz are lost, and the error grows as C/N0 falls;
- with fewer than 4 satellites, there is no fix.

A spoofer captures the receiver when its signal is 3 dB above the authentic ones (and not drowned
by jamming). The reported position then walks away at `driftMps`.

## Fibre-optic link

`"link": { "type": "fiber", "fiber": { … } }`:
- radio jamming no longer reaches the control or video links;
- the spool on the drone pays out along the path flown.

| Field | Default | |
| --- | --- | --- |
| `lengthM` | 10000 | the fibre on the spool: it breaks when it runs out |
| `massGPerKm` | 60 | fibre mass: the drone gets lighter as it pays out |
| `spoolMassG` | 60 | the empty spool |
| `tensionN` | 0.3 | drag of the paying-out fibre |
| `maxPayoutMps` | 40 | faster than this, the fibre snaps |

A break cuts the link: Betaflight fails safe, and the video is lost.

## Faults

| Kind | Fields | Effect |
| --- | --- | --- |
| `motor_failure` | `motor` | the ESC output is dead |
| `motor_degraded` | `motor`, `value` 0..1 | that share of the commanded power |
| `prop_damage` | `motor`, `value` 0..1 | thrust lost (1 = broken prop), permanent |
| `gyro_bias` | `axis`, `value` deg/s | offset in the gyro samples the firmware reads |
| `gyro_noise` | `axis`, `value` deg/s RMS | extra noise |
| `gyro_stuck` | `axis` | output frozen |
| `acc_bias` | `axis`, `value` m/s² | accelerometer offset |
| `baro_drift` | `value` m/s | pressure altitude drifts |
| `baro_failure` | | barometer frozen |
| `gps_loss` | | no satellites |
| `gps_degraded` | `value` ≥ 1 | error × value |
| `mag_interference` | `axis`, `value` gauss | compass offset |
| `rc_loss` | | no RC packet arrives |
| `video_loss` | | the video link is lost |
| `battery_degraded` | `value` ≥ 1 | resistance × value, capacity / value (a failing cell), permanent |
| `payload_release` | | drops the payload (an event) |

Common fields:
- `at`: start time (s);
- `duration`: how long it lasts (s; default: to the end);
- `motor`: 1-based, Betaflight's order (motor 1 rear right on a quad X);
- `axis`: `x`, `y`, `z` or `all`.

Faults are events in `info.events` and the API's `ops` events. The faults in force are in
`obs.ops.faults`.

## Payload

`"payload": { "massG": 300, "cdA": 0.004, "offset": [0, 0, -0.04], "releaseAux": 6 }`:
- its mass and inertia are added to the airframe;
- it is released by the `drop` command, a `payload_release` fault entry, or AUX `releaseAux`
  above 1700 µs;
- it then falls with gravity and quadratic drag in the wind (substepped at 4 kHz) until it hits
  terrain or an obstacle.

It leaves with the airframe's velocity at its attachment point, rotation included. The `drop` task
scores the horizontal miss. Campaigns report CEP50, CEP90 and R95, with an impact scatter
([CAMPAIGNS.md](CAMPAIGNS.md)).

## Navigation sensors

`observations.nav: true` adds `nav` to the observations. External autopilots get the same sensors
in their own streams ([AUTOPILOTS.md](AUTOPILOTS.md)).
- **Magnetometer** (gauss, body FLU):
  - the Earth's field at the map origin (default Zurich: 0.48 G, 63° dip, 3° E; set `ops.field`);
  - a per-unit hard- and soft-iron error;
  - interference proportional to the battery current;
  - noise.
- **Rangefinder**: downward along body −z, 5 cm to 12 m, a beam that loses the ground at steep
  tilt, 1 % noise.
- **Optical flow**: translational flow v / h about the body axes (PX4 convention), with quality.

`obs.ops.fix` is what a GNSS receiver on the drone reports at 10 Hz, with jamming, spoofing and
faults applied: position, velocity and accuracy, or null without a fix. The reference autopilot
navigates on it (`navigation: "gnss"`) and holds height on the barometer, as real stacks do.

## Planning: link maps

`linkmap` (headless API, or `Client.linkmap()` in Python) returns a grid around a point, at a
height above the ground, with the current emitters and the pilot's position:
- the RC link margin (dB; below 0, packets are lost);
- the share of jammed hops;
- the GNSS satellites still tracked.

Use it to plan routes around a jammer, or to place counter-UAS emitters.
[`python/examples/ops_demo.py`](../python/examples/ops_demo.py) prints one as ASCII.

## Limits

- One drone receiver and one pilot station. Emitters are isotropic toward the drone (`erpW` is
  the power toward it). Antenna patterns are modelled for the video link only.
- GNSS uses one aggregate C/N0 with an elevation spread. Satellite geometry, multipath and
  per-constellation effects are not modelled.
- Spoofing is a captured receiver walking at a set velocity. It does not model a spoofer
  replaying a trajectory.
- The fibre lies where the drone flew. Snags on trees or terrain are not modelled.
- Reproducible runs (`.fpvrun`) record sticks only: starting one removes the operational layer.
  Headless episodes with `ops` are fully reproducible from their seed.
