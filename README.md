# FPV Sim — Betaflight-in-the-loop FPV trainer (browser)

A browser FPV quadcopter simulator built for training pilots. It runs the **real Betaflight 4.5.5
firmware compiled to WebAssembly**, in lock-step with a physics / electrical / sensor model at 8 kHz.
The drone and its flight model are generated from component-level specs: frame, motors, props,
battery, ESC, FC gyro and video system.

Live: https://fpv-sim-gamma.vercel.app · Source: https://github.com/cheesejaguar/fpv-sim

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

## Menus

The sim opens on a title screen, with your quad orbiting on the launch pad behind it:
- **Quick fly**: fly straight away with the current map and drone.
- **New game**: *Local* (pick a mode, map and drone) or *Multiplayer* (host or join a room).
  Modes are free flight, race and hover drill.
- **Server browser**: public rooms.
- **Settings**: Simulation, Controller, Betaflight (tuning, CLI, `diff all` import), Drone builder,
  Multiplayer relay and Blackbox.
- **Betaflight quick start**: a nine-chapter guide covering arming, flight modes, rates (with a
  live rate-curve explorer), PIDs, filters, OSD / LQ / RSSI, the CLI and your first flight.

Controllers navigate all of it:
- D-pad or left stick moves, **A** selects and **B** goes back.
- **LB / RB** switch tabs, and the right stick scrolls.
- **Start** pauses and resumes.

Keyboard: arrow keys, Enter, Esc, and Q / E for tabs. While a menu is open its buttons never arm
the quad or change the flight mode. The design follows a system generated with
[UI UX Pro Max](https://uupm.cc/): "3D & Hyperrealism", Russo One and Chakra Petch (OFL), and
`prefers-reduced-motion` is respected.

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

**Wind** (`wind.ts`): log-law mean wind over the ground or roof below, Dryden turbulence
(MIL-HDBK-1797) driven by airspeed, rotor-scale gust gradients (frozen-field + roll gust) at each
rotor hub, 1−cos gusts, directional obstacle wakes (shelter, lee downdraft, roof-edge updraft, local
turbulence) and indoor volumes.

**Contacts** (`contact.ts`, `quad.ts`):
- Compliant contacts on ~70 collider spheres: Hunt–Crossley damping with speed-dependent restitution,
  multi-contact damping kept inside the integrator's stability limit, and entry-plane normals so thin
  gate tubes and posts cannot be tunnelled.
- Friction plus snag / ploughing on soft ground (grass digs prop tips in and cartwheels the quad)
  and rolling resistance; tree canopies are porous drag volumes around a solid core.
- Prop-disc colliders include blade tip velocity, so a prop strike yanks the frame and brakes the
  rotor.
- Energy-based damage rolled once per impact: chipped / broken props, bent motor shafts (1×-rpm
  imbalance into the vibration model) and bent arms (tilted thrust axis).

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

## Maps

Pick a map in **Simulation → Map**:
- **Open Field**: MultiGP-style race course with lap timing.
- **Bando**: abandoned industrial site for freestyle.
- **Quake E1M1, The Slipgate Complex**: freestyle map built from the original level source.
- **Quake DM3, The Abandoned Base**: freestyle map built from the original level source.
- **Freedoom MAP01, Hydroelectric Plant**: freestyle map built from the Freedoom level data.
- **Community maps**: contributed map packages, listed with their author and licence.
  - **Quarry Loop** (example, CC0): race loop in a gravel quarry.

### Your own maps

Maps are open data packages: a folder with a `map.json` (the versioned **fpvsim-map** format)
plus PNG heightfields, textures, `.glb` meshes, or Quake `.map` / Doom-lump geometry.
- The format and its budgets: [docs/MAP_FORMAT.md](docs/MAP_FORMAT.md). JSON Schema:
  [schemas/map.v1.schema.json](schemas/map.v1.schema.json).
- Try a map without a pull request: **Simulation → World → Load map (.zip / files)… / Load map
  folder…**, or drop it on the box. It loads in your browser only.
- Check a package with `npm run map:validate -- <folder or .zip>`.
- Contribute it: add `public/maps/community/<id>/` in a pull request, following
  [CONTRIBUTING.md](CONTRIBUTING.md#contributing-a-map). The map menu lists it automatically,
  from `public/maps/community/index.json`, which `npm run map:index` and every dev / build run
  regenerate.
- Bando is itself a package ([public/maps/bando/](public/maps/bando/)), the reference port of
  the procedural TypeScript map.

The Quake maps load in the browser from the original `.map` brush sources (`src/maps/quakeMap.ts`):
- Every convex brush is built by intersecting its planes.
- Collision is exact sphere vs. convex polyhedron, on a 3D grid.
- Rays and video-link obstruction are clipped against the same brushes.
- Faces get Quake texture axes and baked vertex lighting from the level's light entities.
- Doors and triggers are removed, so every area is reachable.
- Liquids are drawn but not solid.
- Wind is scaled down indoors.
- Scale is 1/32 m per Quake unit.

The Freedoom map loads its Doom-format lumps (`src/maps/doomMap.ts`):
- Each sector's boundary loops, holes included, are traced from its linedefs and triangulated.
- Floors, ceilings and upper / lower / middle wall segments are extruded from the sector heights.
- Collision uses the same convex brushes as the Quake maps:
  - a prism under each floor triangle and over each ceiling triangle;
  - a box behind each one-sided wall;
  - a thin box for grates (masked middle textures).
- Lighting is the sector light level.
- Doors start open.
- Sky ceilings are invisible but solid.
- Scale is 1/32 m per Doom unit: the 56-unit player is 1.75 m tall.

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

## Bring your real quad (Betaflight `diff all` import)

Settings → **Betaflight** → *Bring your real quad*:
1. In Betaflight Configurator's CLI on your real quad, run `diff all`.
2. Paste the output and click **Preview**. It shows the Betaflight version and board, and what will
   be kept or skipped, with a reason for each skipped line.
3. Click **Apply to simulated FC**.

**What's kept and what's dropped:**
- **Kept:** everything that defines how the quad flies — PIDs, feedforward, rates, filters
  including the RPM filter and dynamic notch, TPA, anti-gravity, I-term relax, dynamic idle,
  throttle settings, motor protocol, features and OSD layout.
- **Dropped:** lines describing the physical board, which the simulator's virtual hardware
  replaces — resources, timers, DMA, UARTs, receiver protocol, gyro buses and board alignment,
  battery sensor scaling, LEDs, VTX tables.
- **Simulator-owned:** motor poles/KV come from the drone builder, and the controller mode mapping
  stays AUX1 arm, AUX2 flight mode, AUX3 turtle.
- **Prop direction:** if your `yaw_motors_reversed` differs from the simulated airframe, the
  airframe is switched to match.

Any line Betaflight 4.5.5 rejects, such as a setting renamed in another version, is listed. Use
**Export sim diff all** to save the simulator's own configuration.

## Multiplayer (live rooms)

New game → **Multiplayer**: host a room (name it, and make it public to list it in the server
browser), share the invite link (`?room=CODE`), or join by code. **Server browser** on the title
screen lists every public room with its map and pilot count; it refreshes every 10 seconds.

- Up to 8 pilots per room.
- Each pilot runs their own full simulation, physics and Betaflight; the room relay only shares
  poses at 30 Hz, the roster, the shared map and lap times.
- Remote quads are drawn about 100 ms in the past and interpolated, which hides network jitter.
- Quads pass through each other: there are no collisions between pilots.
- The room flies one map. Changing it in *Simulation* switches everyone.
- On the race course, a live leaderboard shows each pilot's laps and best lap.

**Relay server.** The relay is a Cloudflare Worker with one Durable Object per room, in `server/`.
Public rooms report to a single `Lobby` Durable Object, which serves the server browser at
`GET /rooms`. A room reports when pilots join or leave and every 20 s while occupied, so entries
that stop reporting expire after 60 s. `server/src/roomCore.ts` and `server/src/lobbyCore.ts` hold
the logic, unit-tested in `tests/roomCore.test.ts` and `tests/lobby.test.ts`. It has:
- message validation;
- a 1 KB message limit;
- a 40 messages/s per-pilot rate limit;
- an origin allow-list (`ALLOWED_ORIGINS` in `server/wrangler.toml`).

Run these from the `server` folder, one per line. They work in Windows PowerShell too; if
PowerShell blocks `npm` / `npx` scripts, use `npm.cmd` / `npx.cmd`.

```
npm install
npx wrangler dev
npx wrangler login
npx wrangler deploy
```

- `npx wrangler dev` starts a local relay on `ws://127.0.0.1:8787`, which the sim uses
  automatically when it runs on localhost.
- `npx wrangler deploy` prints the relay address, `https://fpv-sim-rooms.<subdomain>.workers.dev`.

If you deploy your own relay, set `VITE_MP_URL=wss://fpv-sim-rooms.<subdomain>.workers.dev` in the Vercel project's
environment variables and redeploy. Without it, the app uses the public relay `wss://fpv-sim-rooms.newsanjose.workers.dev` (`src/net/config.ts`).
A relay URL can also be entered per browser in the Multiplayer tab.

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

### Credits & licenses (maps)

The in-app map selector shows the same credits.

| Map | Source | License |
|---|---|---|
| Open Field, Bando | Original procedural maps (this project) | GPL-3.0-or-later |
| Quake E1M1, Quake DM3: geometry | id Software's original 1996 `.map` sources, released by John Romero in 2006 ([rome.ro](https://rome.ro/resources)) | GNU GPL |
| Quake E1M1, Quake DM3: textures | [LibreQuake](https://github.com/lavenderdotpet/LibreQuake) replacements; some are derived from Freedoom / Blasphemer | BSD-3-Clause |
| Community maps (`public/maps/community/<id>/`) | Their authors, see each package's `ATTRIBUTION.md` | Per map (`meta.license`), shown in the map selector |
| Freedoom MAP01: level and textures | [Freedoom](https://freedoom.github.io/) 0.13.0 Phase 2 MAP01 (`freedoom2.wad`), © 2001-2024 Contributors to the Freedoom project | BSD-3-Clause |

- No original Quake textures, BSPs, models or sounds are included.
- No original id Software Doom / Doom II data is included.
- Full notices, license texts and the texture substitution list are in
  [`public/maps/quake/ATTRIBUTION.md`](public/maps/quake/ATTRIBUTION.md) and
  [`public/maps/freedoom/ATTRIBUTION.md`](public/maps/freedoom/ATTRIBUTION.md).
- This project is not affiliated with or endorsed by id Software, John Romero, or the LibreQuake,
  Freedoom or Blasphemer projects.
