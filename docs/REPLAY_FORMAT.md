# .fpvreplay v1: the lap replay format

A lap replay is a recorded lap: where the quad was and how it was turned, its motor speeds, the
sticks Betaflight received, its armed state and flight modes, the battery, and Betaflight's OSD,
from about a second before gate 0 to about a second after the finish. The sim records every timed
lap (`src/app/replayRecorder.ts`), keeps your personal best's replay in the browser (IndexedDB),
posts it with the lap, and the relay stores it with the leaderboard entry. The replay player plays
these files, and you can download one or open one from disk.

- Codec: [`server/src/replayFormat.ts`](../server/src/replayFormat.ts), shared by the app and the
  relay. It needs only `CompressionStream`, which browsers, Cloudflare Workers and Node have.
- Relay check: [`server/src/replayCheck.ts`](../server/src/replayCheck.ts).
- Tests: [`tests/replay.test.ts`](../tests/replay.test.ts) (round trip, precision, size, the check,
  recording, playback).
- MIME type `application/vnd.fpv-sim.replay`, file extension `.fpvreplay`.

## File layout

| Bytes | Content |
| --- | --- |
| 0–3 | `FPVR` (46 50 56 52) |
| 4 | format version: 1 |
| 5 | compression: 1 = gzip (RFC 1952) |
| 6–7 | reserved, 0 |
| 8– | a gzip stream of the payload |

The payload is:

1. **Header length**: a varint, then the **header** as UTF-8 JSON, at most 16 KB.
2. **One block per column**, in the order of `header.cols`. Each block is a varint byte length,
   then `header.n` signed varints.
3. **OSD block**: a varint byte length (0 means no OSD), then the OSD frames.

A *varint* is unsigned LEB128: 7 bits per byte, low bits first, with the high bit set on every byte
but the last. A *signed varint* is a zigzag-mapped varint: 0, −1, 1, −2, 2 … become 0, 1, 2, 3, 4 ….
Every value is an integer below 2⁵³.

Because each block starts with its length, a reader can skip columns it doesn't know or doesn't
need. The relay decodes only the position. A reader refuses a version byte it doesn't know.
Readers limit the inflated payload (8 MB in this code), so a gzip bomb stops there.

## Header

```jsonc
{
  "v": 1,                       // = the version byte
  "app": "0.1.0+1a2b3c4",       // the app version that recorded it ("commit" optional)
  "date": 1761054000000,        // ms since the epoch, when the lap was finished
  "map": "field", "course": "", // track: map id and course id ("" for the map's own gates)
  "cls": "freestyle5",          // leaderboard drone class
  "summary": "5\" Freestyle 6S",
  "lapMs": 23456,               // the lap as the leaderboard has it: integer ms ...
  "splitsMs": [2012, ..., 23456],// ... and one split per gate since gate 0; the last one is the lap
  "gates": [{ "id": 0, "t": 0 }, { "id": 1, "t": 2.0118 }, ..., { "id": 0, "t": 23.4561 }],
                                // every pass, in lap time (s): the start through gate 0, each
                                // gate in order, the finish through gate 0 again
  "rate": 100, "n": 2546,       // samples per second, and how many
  "t0": -0.99,                  // lap time (s) of sample 0; ≤ 0, the pre-roll before gate 0
  "spec": { ... },              // the drone build (DroneSpec), so the player builds the same
                                // model and FPV camera (uptilt, FOV, video system)
  "timeScale": 1, "physicsHz": 8000,
  "wind": { "speed": 2.5, "direction": 240, "turbulence": 1, "gusts": 2 },
  "timeOfDay": "map",
  "invalid": null,              // why the lap doesn't count for the leaderboard (local replays)
  "cols": [{ "id": "px", "q": 0.001, "d": 2 }, ...],
  "osd": true                   // the OSD block has frames
}
```

Sample *i* is at lap time `t0 + i / rate`. Lap time 0 is the pass through gate 0 that started the lap.

## Columns

Each column is quantized to integers `k = round(value / q)`, then differenced `d` times:

- `d = 0`: the value itself;
- `d = 1`: `k[i] − k[i−1]`;
- `d = 2`: `k[i] − 2·k[i−1] + k[i−2]`.

The first `d` values are differenced less: the first value is `k[0]`, and for `d = 2` the second
is `k[1] − k[0]`. A decoder reverses this exactly, so every value comes back within `q / 2` of the
recording. For a smooth signal the second difference is its acceleration · dt²: a few millimetres
at 100 Hz. Almost every value fits in one byte, and gzip packs the long runs.

| id | unit | q | d | |
| --- | --- | --- | --- | --- |
| `px` `py` `pz` | m (ENU: east, north, up) | 0.001 | 2 | position, ±0.5 mm |
| `qw` `qx` `qy` `qz` | unit quaternion, body → ENU | 1/8192 | 2 | kept in one hemisphere from sample to sample; renormalize after decoding |
| `rpm0`…`rpm3` | rpm, Betaflight motor order | 25 | 1 | |
| `rc0`…`rc3` | µs | 1 | 1 | roll, pitch, throttle, yaw, as Betaflight received them |
| `vbus` | V | 0.01 | 1 | battery voltage |
| `ibus` | A | 0.1 | 1 | current |
| `mah` | mAh | 0.1 | 1 | drawn |
| `armed` | 0 / 1 | 1 | 1 | |
| `modes` | bits | 1 | 1 | Betaflight flight mode flags (1 Angle, 2 Horizon) |
| `vrs` | 0…1 | 0.01 | 1 | rotor wash (vortex ring) level, for the motor sound |

The columns are sampled from the simulator's 1 kHz state history. The player interpolates
position and attitude with cubic Hermite splines (Catmull-Rom tangents), so playback is smooth at
any speed. It takes velocity from the spline's derivative and interpolates everything else linearly.

The required columns are `px py pz qw qx qy qz`. A file without them is refused. Other columns are
optional for readers.

## OSD frames

Betaflight's OSD character grid is stored as changes, at the rate the simulator publishes it
(≤ 50 Hz). Each frame is:

```
varint  dt         ms since the previous frame (the first: since sample 0)
varint  flags      bit 0: the grid size follows
[varint cols, varint rows]
varint  m          changed cells
m × ( varint gap, u8 char, u8 attr )
```

A cell's index is `row · 64 + column`. The first changed cell's index is `gap`, and each later one
is the previous index + 1 + `gap`. Cells start blank (char 0x20, attr 0). The first frame lists
every non-blank cell at sample 0. Attribute bit 0x40 means the cell blinks.

## Size

A 54 s lap flown in the sim (65 mm whoop, Practice Field figure-8, through Betaflight and the physics)
came out at 41 KB, about 0.73 KB per second of recording with the OSD. That breaks down to roughly
position 3 KB, attitude 9 KB, motor rpm 16 KB, sticks 8 KB, battery 2 KB and OSD 3 KB. Harder flying
(flips, punch-outs) adds some. The relay stores replays up to 256 KB. If a long lap comes out bigger,
the recorder drops the OSD and halves the sample rate until it fits (25 Hz at the least).

## The relay's check

A posted lap carries its replay (`POST /leaderboard`, see the README). Before the lap goes on the
board, the relay checks that:

- the header is the posted lap: track, class, lap time and splits, time scale 1;
- the passes are the track's gates in order, at the posted splits (±1.5 ms rounding);
- the samples cover the lap at 25–500 Hz, with at most 5 s before and after;
- the path never jumps: one sample to the next stays within what the class could fly;
- the speed, averaged over 0.1 s, stays below the class's top speed × 1.25 + 2 m/s;
- the speed never grows by more than the class's acceleration limit (full thrust plus gravity,
  with 25 % to spare) over any 0.25 s;
- the path passes through each gate's opening, the right way, within 30 ms of its split time. It
  uses the gates of `server/src/trackGates.ts` (generated from the maps by
  `node scripts/build-track-gates.mjs`), the same pass rules as the simulator, and a 5 cm margin.

The sim runs in the pilot's browser, so this is still not proof that a lap was flown. A forged
lap now needs a whole trajectory that flies the track within the class's physics, and the
trajectory is public.

## Reproducible runs (.fpvrun)

A lap replay records what happened. A **run** records what was done, so the flight can be
simulated again, exactly, with the full simulator state at every step. Use it for human
demonstrations with privileged state (imitation learning), studies that need the true trajectory
and sensor streams of a flight, or checking that two builds of the simulator agree.

Record one in **Settings → Research → Reproducible run**. *Start run* does four things:
- reboots Betaflight on a fresh instance with the current configuration;
- seeds every random process in the simulation from the run's seed: wind turbulence, sensor
  noise, the radio link, rotor wash;
- rebuilds the world and the quad on the pad;
- records the sticks of every RC packet the flight controller receives, with the physics step it
  arrived in, plus respawns.

What follows is a pure function of those packets (`FlightCore.beginRun`,
[`src/worker/flightCore.ts`](../src/worker/flightCore.ts)). Changing the drone, the map, the
physics settings or Betaflight ends the run. Pausing and the time scale don't matter.

Re-simulate it headless:

```bash
npm run resim -- flight.fpvrun --csv flight.csv [--hz 1000]
```

The CSV has the full state at up to 1 kHz:
- position, velocity, attitude and body rates;
- the gyro and accelerometer as Betaflight read them;
- motor speeds and commands;
- battery;
- the sticks Betaflight received, and whether it was armed.

The replayer ([`src/headless/replay.ts`](../src/headless/replay.ts)) checks that every recorded
packet arrives in the same physics step. If one doesn't, the run has diverged: another firmware
build or simulator version. The script says where and exits with status 3.
[`tests/workerHarness.test.ts`](../tests/workerHarness.test.ts) records a run in the real worker
and checks the re-simulation against the worker's state at every millisecond.

**File.** A gzip of one JSON document ([`src/worker/runLog.ts`](../src/worker/runLog.ts)):

| Field | Content |
| --- | --- |
| `format`, `version` | `"fpvsim-run"`, `1` |
| `app`, `firmware`, `firmwareBuild`, `created` | who recorded it, on which Betaflight build |
| `seed`, `mapId`, `courseId`, `settings`, `spec` | the run's seed, world, conditions and drone |
| `eeprom` | Betaflight's configuration image at the start (base64) |
| `steps` | physics steps flown |
| `packetSteps` | per RC packet, the physics step it arrived in (base64, uint32 little-endian) |
| `packetChannels` | per RC packet, 16 channels in µs (base64, float32 little-endian) |
| `events` | respawns: `{ k, type: "reset", repair, fullBattery, at? }` (k: the physics step) |
| `end` | why the recording ended |

A run stores 68 bytes per RC packet before compression, about 1 MB per minute at 250 Hz. Sticks compress well: a 9 s test flight came to 9 KB.
