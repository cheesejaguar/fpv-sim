# ArduPilot in the browser

Planes fly **ArduPlane 4.7.2**, and any quad can fly **ArduCopter 4.7.2** instead of Betaflight.
The builder's ArduPilot page switches a quad over. Either way it is the real firmware: ArduPilot's
SITL build, compiled to WebAssembly with its hardware layer and all of its flight code. That covers
the EKF, TECS, L1 / navigation, missions, failsafes, Lua scripting and MAVLink. It runs in its own
thread in your browser, or in Node for the headless simulator and the API.

## How it runs

- **One worker per firmware.** ArduPilot runs in its own Web Worker with its own threads.
  `src/ap/apHost.mjs` is the host, and runs unchanged in a Node worker thread.
- **Lock-step physics.** The physics answers through ArduPilot's SITL JSON backend. Once per
  ArduPilot frame (1 ms) the flight core writes the plant's state into shared memory. That state
  is IMU, position, velocity, attitude, airspeed, battery and RC. The flight core then waits for
  the servo outputs ArduPilot computes from it, usually tens of microseconds
  (`src/ap/apLink.ts`). ArduPilot therefore runs exactly as fast as the simulation: slowed down,
  paused or faster than real time alike.
- **Sensors.** GPS, barometer, compass and airspeed are ArduPilot's own SITL sensor models, fed by
  the plant's state. The IMU is the simulator's, with its noise, vibration and misalignment.
- **MAVLink.** SERIAL0 is the simulator's own ground station (`ApHub`). It reads what the HUD and
  OSD show, uploads parameters and the map's mission, and sends modes and arming. SERIAL1 is a
  raw pass-through for your programs and ground stations (below).
- **RC.** Packets reach ArduPilot only as the radio link delivers them. A lost link is a lost link,
  and ArduPilot fails safe. The pitch channel is flipped to ArduPilot's convention: stick forward
  is low PWM.
- **OSD.** ArduPilot's own OSD needs a chip the browser build doesn't have. Instead the simulator
  draws an ArduPilot-style screen from what its ground station hears: mode, arming, battery,
  speed, altitude, GPS, home, waypoints and messages.

## Switches

| Switch | Plane (ArduPlane) | Quad (ArduCopter) |
|---|---|---|
| AUX1 (CH5) | arm / disarm | arm / disarm |
| AUX2 (CH6), low / mid / high | ACRO / FBWA / CRUISE | ACRO / STABILIZE / ALT_HOLD |
| AUX3 (CH7) | RTL | RTL |
| AUX4 (CH8) | AUTO (the map's mission) | AUTO |

A 6-position switch on CH6 also reaches MANUAL and FBWB on a plane. Every mode is one parameter
away: `FLTMODE1`..`FLTMODE6`, or `RCn_OPTION` for any channel.

## Parameters

A build boots with these parameters, lowest priority first:

1. **Shared by every vehicle here** (`src/ap/apConfig.ts`):
   - MAVLink on SERIAL0 and SERIAL1, and the telemetry streams;
   - no on-board logging or terrain download, which would fill the in-memory file system;
   - the battery monitor and the switch layout above;
   - `ARMING_SKIPCHK -1`, so a sim session doesn't wait on pre-arm checks.
2. **The vehicle's own:**
   - a plane: its servo map, trim throttle, cruise airspeed, rate-loop feed-forward, mixing gain
     and hand-launch takeoff ([FIXED_WING.md](FIXED_WING.md));
   - a quad: Betaflight's motor order (`FRAME_TYPE` 12 or 18, props in or out), motor range,
     hover throttle, battery voltages, and a starting rate-loop tune. The tune comes from the
     quad's inertia and thrust, for a loop gain of about 60 rad/s.
3. **Yours:** the builder's ArduPilot page (one `NAME value` per line), or a scenario's
   `drone.spec.apParams`.

The builder lists the full starting set. A test (`tests/ardupilot.test.ts`) asks the running
firmware for every one of them back, since ArduPilot silently ignores a name it doesn't know.
4.7 renamed several older names: `ARMING_CHECK` → `ARMING_SKIPCHK`, `SRn_*` → `MAVn_*`,
`TRIM_ARSPD_CM` → `AIRSPEED_CRUISE`, `ANGLE_MAX` → `ATC_ANGLE_MAX`, `RTL_ALT` → `RTL_ALT_M`,
`WPNAV_SPEED` → `WP_SPD`.

Applying a build restarts ArduPilot with it, like a power cycle, and starts its stored state afresh.
A respawn, a teleport, a map change and a firmware hang power-cycle it too, as a pilot re-plugs the
pack (its EKF cannot follow a jump). Those keep what the API stored on it, as its EEPROM would:
parameters set with `ap` `params` and the last mission uploaded with `ap` `mission`. Changes a
ground station makes over the raw MAVLink pass-through last until the next power cycle. In the
headless environment the quad is held where it is while ArduPilot boots again, and the boot does not
count as episode time.

## Lua scripts

The builder's ArduPilot page holds the build's Lua scripts, saved and exported with it. They run
on ArduPilot from `scripts/` with its full Lua API: read sensors and state, change modes, fly
guided targets, talk to the ground station
([ArduPilot's Lua docs](https://ardupilot.org/plane/docs/common-lua-scripts.html)). The page has
three examples:

- `hello.lua`: altitude and distance home on the OSD every 10 s;
- `low-battery-rtl.lua`: RTL at 3.5 V per cell;
- `figure-eight.lua`: a plane flies a figure eight in GUIDED while CH8 is high.

Scenarios carry scripts too: `drone.spec.apScripts`, by file name.

## Missions

In the map builder, any path can be the map's mission. Select one of its points; the Details panel
has an **Autopilot mission** section. ArduPilot then:

- takes off to the takeoff altitude;
- flies the path's points as waypoints, at their heights above the spawn's ground;
- returns home, lands at the last point, or flies the path again.

The simulator uploads the mission when ArduPilot first has a GPS fix, and AUX4 flies it. The map
format holds it as `mission { path, end, takeoffAltM, speedMs }`
([MAP_FORMAT.md](MAP_FORMAT.md)).

## Programs: the API, MAVLink and Python

The control API ([API.md](API.md)) works with ArduPilot builds as with Betaflight ones: headless
lock-step, headless real time, or the live game.

- **`ap`**: a request to the simulator's ground station, one of:
  - `{"kind": "params", "params": {...}}`;
  - `{"kind": "mission", "items": [...]}`: home is added for you. Headless, the simulation steps
    until ArduPilot accepts the mission;
  - `{"kind": "mode", "mode": n}`;
  - `{"kind": "arm", "on": true}`;
  - `{"kind": "command", "command": MAV_CMD, "params": [...]}`.
- **`mavlink`**: raw MAVLink bytes (base64) into the pass-through port. `subscribe` with
  `{"stream": "mavlink"}` streams what ArduPilot sends there as `mavlink` events.
- **`npm run api -- --mavlink 5760`**: ArduPilot's MAVLink on TCP, as SITL's `tcp:5760`. pymavlink,
  MAVProxy, QGroundControl or Mission Planner connect to `tcp:127.0.0.1:5760`, headless or relayed
  to the live game (`--live --mavlink 5760`). In lock-step, MAVLink moves as the simulation is
  stepped.
- **Observations** gain an `ap` block: mode, armed, airspeed, ground speed, altitude above home,
  climb, throttle, GPS, waypoint progress, and whether a plane is still in the hand.

Python (`python/fpvsim`) has `set_params`, `set_mode`, `arm`, `upload_mission`, `mavlink` and
`subscribe_mavlink`. `python/examples/ardupilot_mission.py` does a full mission: it uploads a
square, launches by hand in AUTO, and prints the mission's progress, with a pymavlink ground
station listening if one is installed.

The simulator's GPS origin, x = y = 0, is 47.3977 N, 8.5456 E at the map's elevation. Mission
positions convert the way ArduPilot's own Location offsets do: `src/ap/apMission.ts`,
`enuToLatLon`.

## Building the firmware

```bash
bash firmware/apwasm/build.sh          # ArduPlane and ArduCopter -> public/ap/
bash firmware/apwasm/build.sh plane    # just one
```

See [firmware/apwasm/README.md](../firmware/apwasm/README.md). Without the build, planes and
ArduCopter quads say so on the menu, and the ArduPilot tests are skipped.

## Limits

- **No reproducible runs.** ArduPilot's threads are not bit-deterministic, so a recorded
  reproducible run (Betaflight builds) is not offered.
- **No on-board logs.** DataFlash logging is off by default because it would fill memory. Set
  `LOG_BACKEND_TYPE` to turn it on.
- **Nothing persists.** ArduPilot's parameters and mission storage live in memory for the session.
  The build's parameters and the map's mission come back on every boot.
- **No hardware.** No OSD chip, no ESC telemetry, no CAN, and no networking inside the firmware.
