# Betaflight 4.5.5 → WebAssembly

The simulator runs the **real Betaflight 4.5.5 firmware**, compiled to WASM and
stepped in lock-step with the JS physics at 8 kHz. Nothing of the flight
controller is re-implemented: gyro filtering (RPM filter, dynamic notch,
lowpasses), PID/feedforward/I-term relax/anti-gravity, mixer + airmode,
dynamic idle, Mahony attitude estimation, failsafe, arming logic, CLI, MSP, OSD
and CMS are Betaflight's own code. Only the hardware layer is replaced.

```
firmware/
  betaflight/            pristine upstream clone (tag 4.5.5 = 4adbd3ef7cb5…), never edited (gitignored)
  bfwasm/
    target/WASM/         target.h / target.mk (derived from target/SITL)
    src/                 replacement hardware layer (see below)
    include/             header shadows (drivers/serial_tcp.h, build/atomic.h)
    patches/*.patch      11 small upstream diffs, applied to a copy at build time
    Makefile, build.sh   emcc build (runs inside Docker)
  build/                 generated: patched copy + objects (gitignored)
public/bf/betaflight.{mjs,wasm}   build output (ES module factory + wasm)
scripts/build-firmware.sh         host entry point
scripts/bf-smoke.mjs              end-to-end smoke test
```

## Build

Docker is the only requirement; the compiler is pinned to
`emscripten/emsdk:4.0.10` and Betaflight to commit
`4adbd3ef7cb546947600e5f747bd5453c9573063` (tag 4.5.5): the script clones it,
fetches that exact commit if the tag ever moves, and refuses to build any
other tree (the patches are written against it).

```bash
bash scripts/build-firmware.sh
```

`firmware/.gitignore` only ignores `/build/` and `/betaflight/` at this level:
an unanchored `build/` used to swallow the `include/build/atomic.h` shadow, so a
fresh clone could not compile `drivers/dshot.c`.

PowerShell equivalent (repository root):

```powershell
docker run --rm -v "${PWD}:/src" -w /src emscripten/emsdk:4.0.10 bash firmware/bfwasm/build.sh
```

A clean build takes ~30 s; incremental builds only recompile what changed
(editing `Makefile`/`target.mk` rebuilds everything, since the ABI flags change
struct layouts). `build.sh` copies `firmware/betaflight` to
`firmware/build/betaflight` and applies `patches/` whenever the upstream
revision or a patch changes.

Compiler flags of note: `-O2 -fno-fast-math -ffp-contract=off` (deterministic
float maths), `-funsigned-char -fshort-enums` (match arm-none-eabi: Betaflight
writes enums through `uint8_t*` and assumes unsigned `char`). Link:
`MODULARIZE=1 EXPORT_ES6=1 ENVIRONMENT=web,worker,node ALLOW_MEMORY_GROWTH=1
MALLOC=none` (see "reboot" below), exports `HEAP*`, `cwrap`, `ccall`.

## Test

```bash
node scripts/bf-smoke.mjs
```

Boots, uses the CLI over UART1, configures + `save`s (surviving the reboot),
verifies the accelerometer/attitude and gyro sign conventions, arms with
bidirectional DShot telemetry, checks the PID pushes the motors against an
injected roll/pitch/yaw rate, checks crash-flip motor reversal, prints the OSD,
round-trips the EEPROM image into a second instance, and measures throughput.

Measured (Node 22, Windows 11): **~1.0 M `bf_step(125)` calls/s armed** (≈120×
real time at 8 kHz), ~1.7 M/s disarmed.

`npx vitest run tests/closedloop.test.ts tests/firmware.test.ts` flies the
real firmware on the generated plant: hover / rates / beginner presets, plus
accelerometer calibration, yaw spin recovery, the BMI270 3.2 kHz gyro path,
beeper and DShot beacon, the serial blackbox stream, the u-blox GPS handshake
up to a 3D fix and home point (against the worker's receiver emulator,
`src/worker/ubxGps.ts`), CPU load and eRPM telemetry errors.
`tests/worker.test.ts` covers EEPROM persistence across a reload and CLI
pacing, `tests/gps.test.ts` the GPS emulator, `tests/stickPath.test.ts` the
stick → setpoint / feedforward path.

## JS usage

```js
import createBetaflight from '/bf/betaflight.mjs';
const bf = await createBetaflight();
const rc = bf._malloc(32), mot = bf._malloc(8), erpm = bf._malloc(16);
// optional: restore a saved config before boot
bf.HEAPU8.set(savedImage, bf._bf_eeprom_ptr()); bf._bf_eeprom_loaded(1);
bf._bf_set_gyro_acc(0, 0, 0, 0, 0, -9.80665);
bf._bf_set_battery(16.8, 0, 0);
bf._bf_init();
// every physics tick (125 us):
bf._bf_set_gyro_acc(p, q, r, ax, ay, az);
bf.HEAPF32.set(erpms, erpm >> 2); bf._bf_set_erpm(erpm);
bf._bf_step(125);
const armed = bf._bf_get_motors(mot);
const dshot = bf.HEAPU16.subarray(mot >> 1, (mot >> 1) + 4);
```

Always re-read `bf.HEAPU8` / `HEAPF32` / ... after calls: memory can grow and
replace the views. All pointer arguments point into wasm memory (`_malloc`).

## C API

| function | |
|---|---|
| `int bf_init(void)` | Boot. Returns 0, or `1 + failureMode_e` if the firmware hit `failureMode()`. Called again = power cycle (EEPROM kept if `bf_eeprom_loaded(1)` or after a firmware `save`). |
| `void bf_step(uint32_t dt_us)` | Advance virtual time by `dt_us` and run the scheduler. Any `dt` works; it is sliced at the gyro period (125 µs) so exactly one gyro/filter/PID run happens per 125 µs, followed by every other task that is due. |
| `void bf_set_gyro_acc(gx,gy,gz, ax,ay,az)` | IMU sample, see conventions below. Each call is one fresh sample: it becomes data-ready at the start of the next gyro slice of `bf_step` and is read once; without a new call the gyro/acc report no new data (a chip slower than the loop). Call it every step at 8 kHz, or only when the simulated chip latched a new sample. |
| `void bf_set_rc(const uint16_t ch[16])` | One received RC frame, µs (1000–2000), AETR1234 channel map by default. Call at the radio link rate (e.g. 150–500 Hz); Betaflight's failsafe triggers if frames stop. |
| `void bf_set_battery(volts, amps, mah_drawn)` | Pack voltage and current. Converted to 12-bit ADC counts through the live `vbat_scale`/`ibata_scale` settings, so Betaflight's filtering, cell detection, sag compensation and warnings run as on hardware. `mah_drawn >= 0` overrides BF's mAh counter; negative lets BF integrate. |
| `void bf_set_erpm(const float erpm[4])` | Electrical RPM per motor (mechanical RPM × pole pairs), motor index order. Encoded as real bidirectional-DShot GCR telemetry (period, `eee mmmmmmmmm`) and decoded by Betaflight's own code (RPM filter, dynamic idle, RPM limit, OSD/CLI). 0 = stopped. |
| `void bf_set_baro(float pascal)` | Static pressure for the virtual barometer. |
| `int bf_get_motors(uint16_t out[4])` | Last DShot value sent per motor: 0 = stop, 48–2047 throttle (DShot command frames read as 0). Returns 1 if armed. Analog protocols are mapped onto the same 48–2047 range. |
| `int bf_get_motor_reversed(void)` | 1 while the ESCs have been commanded to reversed spin (crash flip / turtle, `DSHOT_CMD_SPIN_DIRECTION_REVERSED`), back to 0 after `..._NORMAL`. |
| `int bf_serial_write(port, buf, len)` / `int bf_serial_read(port, buf, max)` | In-memory UARTs, port 0 = UART1 = MSP + CLI (`#` enters the CLI; replies arrive after ~100 ms of virtual time). Host queues: 4 KB in, 64 KB out per port; survive firmware reboots. |
| `bf_osd_chars/attrs/cols/rows/frame` | OSD character buffer, `rows*cols` bytes, row major. `chars` are font indices for a Betaflight `.mcm` font; `attrs` are displayport attributes (Betaflight blinks by itself). `frame` increments on every completed OSD draw. Canvas follows `vcd_video_system`: PAL/AUTO 30×16, NTSC 30×13, HD `osd_canvas_width×height` (53×20). **Betaflight 4.5's default is HD**; set `vcd_video_system = PAL` for analog. |
| `bf_eeprom_ptr/size/loaded/dirty` | The 32 KB config image (`eepromData`). Write it before `bf_init()` + `bf_eeprom_loaded(1)` to restore; `bf_eeprom_dirty()` returns 1 once after the image changed (CLI `save`, MSP save, acc calibration …) and resets itself on that read — persist the image whenever a read returns 1 (don't call it twice). |
| `uint32_t bf_arming_disable_flags(void)` | `armingDisableFlags_e` bitmask (0 = can arm). |
| `int bf_get_flight_mode_flags(void)` | `flightModeFlags` (ANGLE=1, HORIZON=2, …). |
| `void bf_get_attitude(float rpy_deg[3])` | Betaflight's own attitude estimate: roll + = right wing down, pitch + = nose up, yaw = heading 0–360°, + clockwise seen from above. |
| `void bf_get_debug(int16_t out[8])` | `debug[0..7]` for the configured `debug_mode`. |
| `void bf_set_gyro_rate(int hz)` | Output data rate of the simulated gyro chip: 8000 (default; ICM-42688-P, MPU6000), 6400 / 6664, 3200 (BMI270 with the default hardware LPF). Kept across reboots, applied at the next boot (`gyroSetSampleRate`, patch 0010). Below 8 kHz every fresh sample also fires a virtual data-ready interrupt, so Betaflight's scheduler locks the gyro task onto the chip timing as with a real EXTI line. |
| `int bf_calibrate_acc(void)` / `int bf_acc_calibrated(void)` / `int bf_acc_calibrating(void)` | Betaflight's accelerometer level calibration (400 samples ≈ 0.4 s, quad level and still; then `saveConfigAndNotify()`, so `bf_eeprom_dirty()` fires). Until calibrated, an acc mode (angle, horizon, GPS rescue) blocks arming with `ACC_CALIBRATION`, as on hardware (patch 0008). |
| `int bf_get_beeper(void)` | 1 while the buzzer output is on (Betaflight's own sequences: arming, RX loss, BEEPER switch, battery …). |
| `int bf_get_beacon(void)` | 1 for 250 ms after a `DSHOT_CMD_BEACON1..5` frame went out: the ESCs beep the motors (`beacon RX_SET` / `beacon RX_LOST` enable it; disarmed only). |
| `int bf_yaw_spin_detected(void)` | 1 while yaw spin recovery is active. |
| `int bf_cpu_load(void)` | CPU load in % (emulated F7 task timings, see below). |
| `int bf_gps_info(int32_t out[11])` | GPS as the FC sees it: state (5 = receiving), 3D fix, sats, lat/lon 1e-7°, alt cm, ground speed cm/s, course °×10, home fix, distance (m) and direction (°) to home. |

Extras: `bf_micros()`, `bf_boot_count()`, `bf_gyro_period_us()`, `bf_debug_dump()` (prints PG registry size, tasks, UART and RX state).

### Serial ports

| host port | UART | default use in the simulator |
|---|---|---|
| 0 | UART1 | MSP + CLI |
| 1 | UART2 | native blackbox: `serial 1 128 115200 57600 0 2000000`, `set blackbox_device = SERIAL`, `set blackbox_sample_rate = 1/4` (2 kHz at 8 kHz PID), `set blackbox_mode = NORMAL`. The stream from arm to disarm (`H Product:Blackbox flight data recorder by Nicholas Sherlock` … `End of log`) is a log file Blackbox Explorer / PIDtoolbox read as is; ~75 KiB/s at 2 kHz. Drain it at least every ~0.5 s (64 KiB queue). |
| 2 | UART3 | u-blox GPS (`feature GPS`, `serial 2 2 115200 115200 0 115200`, `gps_provider = UBLOX`): the host emulates the receiver (UBX: answer the MON-VER poll, ACK the CFG messages, send NAV-PVT) |

### Emulated hardware details

* **eRPM telemetry**: the reply read at a motor update carries the eRPM of
  the previous DShot frame (one frame of lag, like a real ESC); 0.1 % of
  replies are corrupt (deterministic xorshift): they keep the last value and
  count as `Dshot invalid pkts` in `dshot_telemetry_info`.
* **CPU load** (patch 0009, `cpu_load.c`): virtual time stands still inside a
  task, so each task run is charged its average F722 execution time (gyro 7,
  filter 14, PID 20, attitude 22, RX 21 µs …) in the load statistics only —
  `status`, `tasks`, MSP and the OSD see ~35 % at 8k/8k and ~16 % for a
  3.2 kHz BMI270 build. Scheduling decisions are not affected.
* **Gyro overflow / yaw spin** (patch 0007): the SITL-disabled checks run.
  Yaw spin recovery engages above `yaw_spin_threshold` (auto: max yaw rate
  + 25 %, ≥ 200 °/s margin). The overflow check itself is still skipped for
  the virtual gyro because Betaflight lists `GYRO_VIRTUAL` with the chips that
  have hardware overflow protection (`gyroHasOverflowProtection`), like the
  ICM-42688-P it imitates.

## Axis / sign convention (exact)

`bf_set_gyro_acc` takes **body FRD** (x forward, y right, z down), right-handed:

| input | meaning | unit |
|---|---|---|
| `gx` = p | roll rate, **+ = right wing going down** | rad/s |
| `gy` = q | pitch rate, **+ = nose going up** | rad/s |
| `gz` = r | yaw rate, **+ = nose going right** (clockwise seen from above) | rad/s |
| `ax, ay, az` | **specific force** (what an accelerometer measures = acceleration − gravity) in FRD | m/s² |

Level and at rest: `(0, 0, 0, 0, 0, -9.80665)`. Tilted right-wing-down by φ at
rest: `ay = -g·sinφ`; nose-up by θ: `ax = +g·sinθ`.

Betaflight's internal sensor frame is FLU (x forward, y left, z up). The
conversion in `wasm_api.c` is

```
gyroBF = ( p, -q, -r) · (180/π) · 16.384  LSB/(°/s)   (= 32768/2000, GYRO_SCALE_2000DPS)
accBF  = (ax, -ay, -az) · 256 / 9.80665   LSB          (acc_1G = 256)
```

clamped to int16 like a real ±2000 °/s IMU. 16.384 (not SITL's 16.4) makes the
rate exact. The accelerometer x sign differs from upstream SITL, which never
exercised it (SITL injects the attitude instead of running the IMU); here the
Mahony filter uses it, and the smoke test checks it: a right-wing-down tilt reads
positive roll, nose-up reads positive pitch, +p integrates to positive roll, +r
turns the heading clockwise, and the PID drives M1+M2 (right side) up against +p,
M1+M3 (rear) up against +q, M1+M4 (CW props, props-in default) up against +r.
Motor order is Betaflight QuadX: M1 rear-right, M2 front-right, M3 rear-left,
M4 front-left.

## How the hardware layer is replaced

| upstream (SITL) | WASM replacement | notes |
|---|---|---|
| `main.c` loop | `wasm_api.c` | `bf_init` = `init()`, `bf_step` drives `scheduler()` |
| `target/SITL/sitl.c` | `wasm_platform.c` | virtual µs clock, 1 cycle = 1 µs; `delay()` advances the clock and creates "sleep debt" that the next `bf_step` calls pay off without running the scheduler; `systemReset()` → reboot; `failureMode()` returns |
| `drivers/serial_tcp.c` + dyad | `serial_mem.c` | `serTcpOpen()` implemented over ring buffers |
| `drivers/dshot_dpwm.c`, timers, DMA | `motor_sim.c` | DShot device: real command queue/timing, GCR telemetry emulation |
| `drivers/max7456.c`, `io/displayport_max7456.c` | `displayport_mem.c` | MAX7456-type device rendering into RAM |
| `drivers/adc.c`, `pg/adc.c` | `battery_sim.c` | ADC counts for vbat/current |
| UDP RC | `rx_sim.c` | `RX_PROVIDER_UDP`, one frame per `bf_set_rc` |
| libc malloc | `wasm_malloc.c` | allocator state lives in the heap (survives reboots) |
| `drivers/sound_beeper.c` | `beeper_sim.c` | buzzer pin state for the host (`bf_get_beeper`) |
| — | `cpu_load.c` | emulated task execution times for the CPU load |
| — | `wasm_stubs.c` | hardware-only symbols generic code references |

Patches (`bfwasm/patches/`):

1. `pg.h`: wasm-ld has no linker scripts; put the parameter-group registry in
   named data segments and use the linker's `__start_/__stop_` symbols.
2. `scheduler.c`: drop the busy-wait on `schedLoopRemainingCycles` (virtual time
   can't advance inside it), count executed tasks for the step loop, guard the
   late-task statistics divisions.
3. `common_post.h`: keep `USE_DYN_NOTCH_FILTER` (4.5 uses the portable SDFT; the
   "arm_math" comment is stale).
4. `init.c`: always use the in-memory OSD device (SD and HD canvas).
5. `gyro.c`: calibrate the virtual gyro like a hardware one. Upstream skips it
   for `GYRO_VIRTUAL` because SITL's gyro feed is ideal; the simulator's IMU has
   turn-on bias and noise, so without this an uncalibrated bias shows up as
   yaw drift (and the "keep still while booting" behaviour would be missing).
6. `common_post.h`: keep `USE_RX_RSSI_DBM` without a serial CRSF receiver
   (`USE_SIM_RX_LINK_STATS`): the simulator reports ELRS-style LQ / RSSI dBm.
7. `gyro.c`: run the gyro overflow and yaw-spin detection that SITL compiles
   out (`#if !defined(SIMULATOR_BUILD) || defined(WASM_BUILD)`).
8. `acceleration_init.c`: `accHasBeenCalibrated()` checks the stored
   calibration instead of SITL's "always calibrated".
9. `scheduler.c`: CPU load from emulated task execution times (`cpu_load.c`)
   instead of the forced 0 %.
10. `gyro_sync.c`: the virtual gyro's sample rate follows `bf_set_gyro_rate()`
    (BMI270 3.2 kHz, acc 800 Hz).
11. `serial.c`: no blocking `serialPassthrough()` (would hang the
    single-threaded firmware on `gpspassthrough`); `wasm_stubs.c` has a no-op.

**Reboot** (CLI `save`/`exit`, MSP reboot): `systemReset()` only sets a flag;
after the current task returns, `bf_step` restores *all* static data
(`[__global_base, __data_end)`) from a snapshot taken before the first boot,
keeps the EEPROM image and the host-facing state (`bfwasmPersist`: inputs,
serial queues), and runs `init()` again — equivalent to an MCU reset, with
no hand-maintained list of statics to clear. The heap is untouched, so
buffers the host `_malloc`ed stay valid.

## What is stubbed / not simulated (and why)

* **No SPI/I2C buses, no hardware gyro/baro/mag drivers** – virtual sensors
  (`accgyro_virtual.c`, `barometer_virtual.c`). No magnetometer (GPS rescue
  works without one, as on most FPV quads). GPS is a u-blox protocol receiver
  emulated by the host on UART3 (NMEA support is not built).
* **Task execution time is zero** – virtual time doesn't advance while a task
  runs; only the CPU-load statistics are emulated (see above). Loop timing is
  otherwise perfect, apart from the gyro task following a slower chip's
  samples on the 125 µs physics grid (BMI270: 250 / 375 µs periods averaging
  312.5 µs; about 0.2 % of runs see no fresh sample because Betaflight's
  integer 312 µs period drifts against the 312.5 µs chip between EXTI skew
  corrections).
* **Serial passthrough / 4-way ESC interface** – would block the FC forever;
  `serialPassthrough()` is a no-op.
* **LED strip, VTX control (SmartAudio / Tramp / MSP VTX, VTX tables),
  transponder, camera control, telemetry protocols, serial RX protocols, ESC
  sensor (serial telemetry)** – not built (RC comes from `bf_set_rc`).
  Blackbox logs to a serial port only (no flash / SD card emulation).
* **Extended DShot telemetry** (EDT temperature/voltage/current) – not
  emulated; eRPM only (with lag and rare corrupt frames, see above). DShot
  telemetry quality statistics (`USE_DSHOT_TELEMETRY_STATS`) are not built.
* **Font upload** (MSP/CMS) is accepted and ignored: the host owns the font.
* **Servos** – outputs ignored.
* `SIMULATOR_BUILD` side effects still inherited from upstream: MSP arming is
  not blocked.
* Betaflight's `bootgrace` still applies: arming is refused for the first
  seconds after boot, as on hardware.
* **Not done yet** – an MSP bridge for Betaflight Configurator (it would need a
  WebSerial-like transport to UART1, e.g. a WebSocket relay to a virtual COM
  port, since the Configurator can't reach a page's worker) and VTX tables /
  SmartAudio on a memory UART (needs `USE_VTX_*` built and a SmartAudio
  responder on the host side, plus a video-link model that follows the VTX
  power / channel).

## Host side (src/worker)

What the simulator's worker adds around the firmware:

* **EEPROM persistence** (`fwCli.ts`, `kv.ts`): `EepromStore.check()` is the
  only reader of `bf_eeprom_dirty()` and stores the image in IndexedDB right
  away (queued, newest last). The sim defaults are re-applied on first boot,
  when Betaflight reset its stored config while booting (image dirty right
  after boot), on a new `DEFAULTS_VERSION`, or when the firmware build hash
  (`__FW_VERSION__`) changed. IndexedDB that is blocked / failing / hung (3 s)
  only costs persistence.
* **CLI batches** run on firmware time with the plant held at rest (no
  integration; the IMU reads the quad still in its attitude, with its own bias
  and noise). Each line ends on the CLI prompt; a batch first waits for the
  disarm (Betaflight ignores `#` while armed).
* **Gyro ODR**: `setGyroRate(chip.sampleRateHz)` before every boot; the IMU
  sample goes to `bf_set_gyro_acc` only on the physics steps where the chip
  latched one. The first boot also runs the level accelerometer calibration.
* **RC sticks**: the main thread writes timestamped stick samples (Gamepad
  timestamp) into a shared ring at ~0.5–1 kHz; each ELRS packet carries the
  newest sample 2.5 ms (+ a mixer-sync offset that keeps the sampling instant
  between input updates) before its slot — see `tests/stickPath.test.ts`.
* **GPS** (`ubxGps.ts`): u-blox M8 emulator on UART3 — MON-VER replies, ACKs,
  CFG-RATE, NAV-PVT (+ NAV-SAT) from the plant's ENU state at a fixed origin
  plus the map elevation; ~1.5 m CEP wandering error, ~0.1 m/s Doppler
  velocity noise, cold start: 3D fix with 12 satellites ~8 s after power-on.
* **Blackbox** (`bbl.ts`): UART2 drained every 10 ms into one log per armed
  session (32 MB kept) → "Download .bbl".
* **Sensor errors** (`fcHardware.ts`): baro noise (0.3 m σ) and prop-wash
  overpressure (≈1 % of the disk loading in free air, up to ≈7 % at the
  ground: reads ~0.6 m low on the pad); current sensor offset ±1 A and scale
  ±10 % per build (mAh integrated from it); 1S boards brown out below 2.8 V
  for > 30 ms and boot again ~0.8 s after the pack recovers.
