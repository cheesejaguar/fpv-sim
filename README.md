# FPV Sim — Betaflight-in-the-loop FPV trainer (browser)

A browser FPV quadcopter simulator built for training pilots. It runs the **real Betaflight 4.5.5
firmware compiled to WebAssembly**, in lock-step with a physics / electrical / sensor model at 8 kHz.
The drone and its flight model are generated from component-level specs: frame, motors, props,
battery, ESC, FC gyro and video system.

Source: https://github.com/cheesejaguar/fpv-sim

## Quick start

```bash
npm install
npm run firmware   # builds public/bf/betaflight.{mjs,wasm} (Docker, emscripten/emsdk:4.0.10)
npm run fonts      # downloads Betaflight's OSD fonts (public/fonts/*.mcm)
npm run dev        # http://localhost:5173
```

The page must be cross-origin isolated, because it uses SharedArrayBuffer. `npm run dev` and
`npm run preview` send the COOP/COEP headers.

On first boot the simulator configures Betaflight over its own CLI and `save`s:
- DShot600 with bidirectional telemetry.
- Motor poles and KV from the builder.
- Prop direction.
- Arm on AUX1; acro/horizon/angle on AUX2; turtle on AUX3; beeper on AUX4.
- OSD layout.

The EEPROM image persists in IndexedDB. Everything else is stock Betaflight 4.5 defaults: rates,
PIDs, filters, RPM filter, dynamic notch, TPA, anti-gravity, and so on.

## Controller

The simulator uses the browser Gamepad API, so any USB or Bluetooth controller with sticks works.

**Supported out of the box:**
- **Xbox** (Series / One / 360) and **PlayStation 5 DualSense**: recognised automatically. Buttons
  are labelled per controller (A/B/X/Y or ✕○□△), and crashes rumble the pad in Chrome and Edge.
- **DJI FPV Remote Controller 3**: connect its USB-C port and it appears as "DJI Virtual Joystick"
  (USB 2ca3:1021). Run the **stick & switch setup** once. DJI doesn't document the axis order, so
  the wizard detects each stick, its direction, and the arm / flight-mode switches. Many radios
  report switches as axes, which is supported, including 3-position mode switches.
- **Other RC radios** (EdgeTX / OpenTX in USB-joystick mode) and **HID joysticks**: same wizard.
- **2026 Steam Controller**: driven directly over WebHID (see below).

The Controller tab offers:
- Presets.
- Per-channel "move the stick to detect".
- Inversion.
- Calibration, deadzone and expo.
- Arm, mode, turtle, beeper, reset and menu buttons.
- Live raw axes, and the RC channels sent to Betaflight.

**Steam Controller on Windows:**
1. Keep Steam running.
2. Set the Desktop Layout to *Gamepad*, or add the browser as a non-Steam game with the gamepad
   template.
3. Set the right trackpad to *Joystick Move* (absolute).
4. Press a button with the page focused; browsers only expose pads after the first input.

Gamepad sticks spring back to centre, so the throttle has three modes:
- Full range: centre is 50%.
- Upper half: centre is 0%.
- Analog trigger.

Default mapping (Mode 2, standard gamepad):

| Control | Action |
|---|---|
| Left stick | Throttle / yaw |
| Right stick | Pitch / roll |
| RB | Arm (toggle) |
| LB | Acro → horizon → angle |
| X | Turtle |
| A | Respawn |
| Start | Menu |

Keyboard fallback, for testing only:

| Key | Action |
|---|---|
| W / S | Throttle |
| A / D | Yaw |
| Arrows | Pitch / roll |
| Space | Arm |
| 1 / 2 / 3 | Modes |
| T | Turtle |
| R | Reset |
| B | New battery |
| C | Camera view |
| H | Telemetry |
| G | Hover-box drill |
| F | Gyro noise spectrum |
| Esc | Menu |

## What is simulated

**Flight controller.** Betaflight 4.5.5's own code runs everything:
- Gyro filtering: RPM filter from emulated bidirectional-DShot eRPM, dynamic notch and lowpasses.
- PID, feedforward, I-term relax, anti-gravity, TPA, airmode, dynamic idle and the mixer.
- Mahony attitude estimation on simulated gyro and accelerometer.
- Battery monitoring through ADC counts: vbat sag compensation, warnings and cell detection.
- Arming logic, failsafe, crash flip, CLI and the OSD.

The hardware layer is replaced; see [firmware/README.md](firmware/README.md). One patch makes the
virtual gyro go through Betaflight's normal boot calibration. Because of that, the simulated IMU's
turn-on bias is removed exactly as on hardware. Keep the quad still while it boots.

**Noise spectrum** (press F): a blackbox-style analyser drawn over the HUD. The worker samples the
raw IMU gyro at the full physics rate and Betaflight's fully filtered gyro (`debug_mode =
GYRO_FILTERED`, set by the first-boot defaults), and FFTs 2048 samples per axis (Hann window,
~4 Hz bins) ten times a second. Orange is raw and blue is filtered, 0–1000 Hz in dB re 1 °/s.
Yellow lines mark the motor rotation frequency and its 2nd and 3rd harmonics, which the RPM filter
notches. Raise "Static imbalance" or "Vibration coupling" in the Drone builder to see the peaks
grow. Betaflight logs debug values as whole °/s, so the filtered trace cannot show detail below
about −31 dB (the shaded band), as in a real blackbox log. If you change `debug_mode` yourself,
the filtered trace disappears.

**Propellers** (`src/sim/bemt.ts`, `rotor.ts`):
- Blade-element momentum theory over radius and azimuth, with Prandtl tip loss.
- Glauert inflow in forward flight, momentum theory in climb and windmill-brake, and Leishman's
  empirical curve through the vortex-ring state.
- Low-Reynolds airfoil polar with post-stall flat-plate behaviour.
- The solution is tabulated non-dimensionally over (advance angle, inflow angle), so it covers
  hover, edgewise flight, descent and a stopped rotor. It is then calibrated to a static
  thrust/torque point.
- Added effects: H-force (rotor drag), low-Re torque correction, Cheeseman–Bennett ground effect,
  VRS / prop-wash unsteadiness (OU noise), reversed-spin efficiency (turtle mode) and blade damage.

**Prop wash** (`wake.ts`): each rotor sheds Lagrangian wake puffs that convect, spread and decay.
Descending or flipping back into your own wash raises local inflow and turbulence per rotor.

**Motors and ESC** (`motor.ts`):
- Equivalent DC machine with quasi-static current from back-EMF and winding plus ESC resistance.
- Complementary-PWM active braking and regeneration.
- No-load (iron and friction) losses, rotor plus prop inertia, ESC current limit and DShot
  quantisation with one frame of delay.
- Thermal model with temperature-dependent R and Kt.
- Stator reaction torque (yaw), and gyroscopic coupling of the rotor's angular momentum.

**Battery** (`battery.ts`):
- Second-order Thevenin equivalent circuit per cell.
- OCV(SoC) monotone-cubic tables for LiPo, LiHV and Li-ion.
- Arrhenius temperature dependence and low-SoC resistance rise.
- Pack thermal model and ageing.

The ESC bus voltage is solved exactly each step against all four ESCs, including current-limited
ones. Sag directly reduces available thrust, and Betaflight sees it through its ADC.

**Airframe** (`builder/derive.ts`):
- Mass budget and CG from component placement, and the full inertia tensor via the parallel-axis
  theorem.
- Anisotropic drag areas, collider set and frame structural modes.

**IMU** (`imu.ts`):
- Datasheet noise density, bias random walk, turn-on bias, scale and cross-axis errors.
- On-chip anti-alias filter, saturation and LSB quantisation.
- Vibration from prop imbalance and blade-pass ripple through lightly damped frame modes, so the
  RPM filter and dynamic notch have real work to do.

**Wind** (`wind.ts`): log-law mean wind, Dryden turbulence (MIL-HDBK-1797), 1−cos gusts, and
obstacle wake zones behind buildings.

**Contacts** (`contact.ts`, `quad.ts`):
- Compliant spring-damper contacts, with damping from per-material restitution and friction.
- Prop-disc colliders include blade tip velocity, so a prop strike yanks the frame and brakes the
  rotor.
- Energy-scaled stochastic prop damage: C_T loss, imbalance that feeds vibration, and broken blades.

**Video** (`render/fpvCamera.ts`, `videoLink.ts`):
- Cube-map capture at the camera frame rate, with real cadence.
- Kannala–Brandt fisheye at the system's FOV, camera uptilt and rolling shutter.
- Log-average auto-exposure with a time constant, plus WDR.
- Emulated glass-to-glass latency with jitter; a display-pipeline compensation setting covers
  your own monitor.
- Analog link: 5.8 GHz link budget with FSPL, two-ray multipath, obstruction raycasts, antenna
  pattern and fading. This drives FM-threshold noise and sparkles, chroma loss, sync tearing,
  interlaced fields and snow.
- Digital systems (DJI O3/O4, HDZero, Walksnail): macroblocking, freezes and latency growth as the
  link margin drops.
- The Betaflight OSD is rendered from the firmware's character buffer with the real MCM fonts.
  Analog OSD is overlaid before the RF link, as on a MAX7456. HD OSD is crisp.

## Builder

Every component can be swapped from dropdowns, and every physical parameter overridden with
sliders. The derived panel shows:
- AUW, CG and the inertia tensor.
- Static thrust and thrust-to-weight.
- Hover throttle and RPM.
- Hover and full-throttle current.
- Flight time and top speed.
- Drag areas, frame mode and pack DCIR.

**Data provenance:** manufacturer data is used where published. Winding resistance, rotor inertia,
thermal constants and prop static calibration are engineering estimates consistent with public
thrust-stand data; they are flagged in `src/data/catalog.ts`.

## Tests

```bash
npm test               # physics validation + Betaflight closed loop (needs the firmware build)
node scripts/bf-smoke.mjs   # firmware-only end-to-end checks
```

The physics tests check the generated quad against real-world numbers:
- 5" 6S hover is 17–35% throttle at 140–320 W/kg.
- Full-throttle punch draws 120–220 A, and sag stays above 3.2 V/cell.
- Motor time constant is 15–60 ms.
- 6S1300 sag at 100 A is 1.5–3.5 V.
- BEMT trends and figure of merit are physically plausible.
- Dryden intensity matches MIL-HDBK-1797.

The closed-loop test flies the real firmware and checks:
- Arming and a level hover.
- Yaw drift below 0.15 °/s after boot calibration.
- Full-stick roll rate close to Betaflight's default 670 °/s.

## Licence

GPL-3.0-or-later. This project embeds Betaflight (GPL-3.0) and uses its OSD fonts.
