# Betaflight 4.5.5 → WebAssembly

The simulator runs the **real Betaflight 4.5.5 firmware**, compiled to WASM and
stepped in lock-step with the JS physics at 8 kHz. Nothing of the flight
controller is re-implemented: gyro filtering (RPM filter, dynamic notch,
lowpasses), PID/feedforward/I-term relax/anti-gravity, mixer + airmode,
dynamic idle, Mahony attitude estimation, failsafe, arming logic, CLI, MSP, OSD
and CMS are Betaflight's own code. Only the hardware layer is replaced.

```
firmware/
  betaflight/            pristine upstream clone (tag 4.5.5), never edited
  bfwasm/
    target/WASM/         target.h / target.mk (derived from target/SITL)
    src/                 replacement hardware layer (see below)
    include/             header shadows (serial_tcp.h, build/atomic.h)
    patches/*.patch      5 small upstream diffs, applied to a copy at build time
    Makefile, build.sh   emcc build (runs inside Docker)
  build/                 generated: patched copy + objects (gitignored)
public/bf/betaflight.{mjs,wasm}   build output (ES module factory + wasm)
scripts/build-firmware.sh         host entry point
scripts/bf-smoke.mjs              end-to-end smoke test
```

## Build

Docker is the only requirement; the compiler is pinned to
`emscripten/emsdk:4.0.10`.

```bash
bash scripts/build-firmware.sh
```

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
| `void bf_set_gyro_acc(gx,gy,gz, ax,ay,az)` | IMU sample, see conventions below. Latched; re-applied every gyro period. |
| `void bf_set_rc(const uint16_t ch[16])` | One received RC frame, µs (1000–2000), AETR1234 channel map by default. Call at the radio link rate (e.g. 150–500 Hz); Betaflight's failsafe triggers if frames stop. |
| `void bf_set_battery(volts, amps, mah_drawn)` | Pack voltage and current. Converted to 12-bit ADC counts through the live `vbat_scale`/`ibata_scale` settings, so Betaflight's filtering, cell detection, sag compensation and warnings run as on hardware. `mah_drawn >= 0` overrides BF's mAh counter; negative lets BF integrate. |
| `void bf_set_erpm(const float erpm[4])` | Electrical RPM per motor (mechanical RPM × pole pairs), motor index order. Encoded as real bidirectional-DShot GCR telemetry (period, `eee mmmmmmmmm`) and decoded by Betaflight's own code (RPM filter, dynamic idle, RPM limit, OSD/CLI). 0 = stopped. |
| `void bf_set_baro(float pascal)` | Static pressure for the virtual barometer. |
| `int bf_get_motors(uint16_t out[4])` | Last DShot value sent per motor: 0 = stop, 48–2047 throttle (DShot command frames read as 0). Returns 1 if armed. Analog protocols are mapped onto the same 48–2047 range. |
| `int bf_get_motor_reversed(void)` | 1 while the ESCs have been commanded to reversed spin (crash flip / turtle, `DSHOT_CMD_SPIN_DIRECTION_REVERSED`), back to 0 after `..._NORMAL`. |
| `int bf_serial_write(port, buf, len)` / `int bf_serial_read(port, buf, max)` | In-memory UARTs, port 0 = UART1 = MSP + CLI (`#` enters the CLI; replies arrive after ~100 ms of virtual time). Host queues: 4 KB in, 64 KB out per port; survive firmware reboots. |
| `bf_osd_chars/attrs/cols/rows/frame` | OSD character buffer, `rows*cols` bytes, row major. `chars` are font indices for a Betaflight `.mcm` font; `attrs` are displayport attributes (Betaflight blinks by itself). `frame` increments on every completed OSD draw. Canvas follows `vcd_video_system`: PAL/AUTO 30×16, NTSC 30×13, HD `osd_canvas_width×height` (53×20). **Betaflight 4.5's default is HD**; set `vcd_video_system = PAL` for analog. |
| `bf_eeprom_ptr/size/loaded/dirty` | The 32 KB config image (`eepromData`). Write it before `bf_init()` + `bf_eeprom_loaded(1)` to restore; `bf_eeprom_dirty()` returns 1 once after the image changed (CLI `save`, MSP save, …) — persist it then. |
| `uint32_t bf_arming_disable_flags(void)` | `armingDisableFlags_e` bitmask (0 = can arm). |
| `int bf_get_flight_mode_flags(void)` | `flightModeFlags` (ANGLE=1, HORIZON=2, …). |
| `void bf_get_attitude(float rpy_deg[3])` | Betaflight's own attitude estimate: roll + = right wing down, pitch + = nose up, yaw = heading 0–360°, + clockwise seen from above. |
| `void bf_get_debug(int16_t out[8])` | `debug[0..7]` for the configured `debug_mode`. |

Extras: `bf_micros()`, `bf_boot_count()`, `bf_gyro_period_us()`, `bf_debug_dump()` (prints PG registry size, tasks, UART and RX state).

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

**Reboot** (CLI `save`/`exit`, MSP reboot): `systemReset()` only sets a flag;
after the current task returns, `bf_step` restores *all* static data
(`[__global_base, __data_end)`) from a snapshot taken before the first boot,
keeps the EEPROM image and the host-facing state (`bfwasmPersist`: inputs,
serial queues), and runs `init()` again — equivalent to an MCU reset, with
no hand-maintained list of statics to clear. The heap is untouched, so
buffers the host `_malloc`ed stay valid.

## What is stubbed / not simulated (and why)

* **No SPI/I2C buses, no hardware gyro/baro/mag drivers** – virtual sensors
  (`accgyro_virtual.c`, `barometer_virtual.c`). Magnetometer and GPS are not
  built (not needed for an FPV quad; GPS rescue therefore unavailable).
* **Task execution time is zero** – virtual time doesn't advance while a task
  runs, so `tasks` shows 0 µs and CPU load 0 %. Loop timing is perfect.
* **Serial passthrough / 4-way ESC interface** – would block the FC forever;
  `serialPassthrough()` is a no-op.
* **Blackbox, LED strip, VTX control, transponder, camera control, telemetry
  protocols, serial RX protocols, ESC sensor (serial telemetry)** – not built
  (no flash/SD, RC comes from `bf_set_rc`).
* **Extended DShot telemetry** (EDT temperature/voltage/current) and DShot
  telemetry error statistics – not emulated; only eRPM.
* **Font upload** (MSP/CMS) is accepted and ignored: the host owns the font.
* **Servos** – outputs ignored.
* `SIMULATOR_BUILD` side effects inherited from upstream: accelerometer counts as
  calibrated, gyro overflow check and yaw-spin recovery are compiled out, MSP
  arming is not blocked.
* Betaflight's `bootgrace` still applies: arming is refused for the first
  seconds after boot, as on hardware.
