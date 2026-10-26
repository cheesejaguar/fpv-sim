# External autopilots: PX4 and ArduPilot

`npm run sitl` makes FPV Sim the physics plant of a PX4 or ArduPilot SITL build. You get the same:
- rotors, motors, ESCs and battery;
- wind, contacts and crash damage;
- jammers, spoofers, faults and payloads ([OPERATIONS.md](OPERATIONS.md)).

That is the same plant the Betaflight simulator uses, with the autopilot's motor outputs in place
of Betaflight's.

```bash
npm run sitl -- --px4 --scenario scenarios/fault-motor-hover.json
# in PX4-Autopilot:  make px4_sitl none_iris        (PX4 connects to tcp://127.0.0.1:4560)

npm run sitl -- --ardupilot --write-params fpvsim.parm
# in ArduPilot:      sim_vehicle.py -v ArduCopter -f JSON --add-param-file=fpvsim.parm
#             or:    arducopter --model JSON:127.0.0.1 --defaults fpvsim.parm
```

Options:

| Option | Default | |
| --- | --- | --- |
| `--scenario FILE` | | map, drone, wind, `ops` |
| `--seed N` | | |
| `--port N` | 4560 PX4, 9002 ArduPilot | |
| `--host ADDR` | 127.0.0.1 | |
| `--rate HZ` | 250 | PX4 lock-step rate |
| `--gps-hz HZ` | 10 | PX4 GPS rate |
| `--status S` | 2 | print the state every S seconds |
| `--write-params FILE` | | a starting parameter file for the build: rotor geometry and spin, hover throttle, battery (QGroundControl `.params` for PX4, `.parm` for ArduPilot). Rate gains are not tuned: a 5" racer needs far lower gains than the iris defaults |

The drone is the scenario's build, as a props-in quad X. That is both autopilots' motor order and
spin: front-right CCW, rear-left CCW, front-left CW, rear-right CW.

## PX4 (MAVLink HIL, lock-step)

See [`src/sitl/mavlink.ts`](../src/sitl/mavlink.ts) for the protocol, with references to PX4's
`SimulatorMavlink.cpp`, and [`src/sitl/server.ts`](../src/sitl/server.ts) for the server.

The handshake:
1. FPV Sim listens on TCP 4560, and PX4 connects.
2. Until PX4's mixer sends its first outputs, the plant runs on the wall clock so PX4 can boot.
3. After that, it is lock-step: each `HIL_ACTUATOR_CONTROLS` advances the plant one PX4 step
   (4 ms) and answers with the next `HIL_SENSOR`. Its `time_usec` is PX4's clock.

| Simulator → PX4 | Content |
| --- | --- |
| `HIL_SENSOR` (every step) | the IMU averaged over the step (body FRD), magnetometer (gauss), barometer (hPa, pressure altitude, temperature). Every sensor group is flagged as PX4 requires |
| `HIL_GPS` (10 Hz) | the GNSS solution with jamming, spoofing and faults (lat / lon degE7, NED velocity, eph / epv, satellites) |
| `DISTANCE_SENSOR`, `HIL_OPTICAL_FLOW` (62.5 Hz) | the downward rangefinder; integrated flow with the gyro |
| `HIL_STATE_QUATERNION` (62.5 Hz) | ground truth for PX4's logs |

`controls[0..3]` (0..1) drive the motors when PX4 says it is armed.

## ArduPilot (JSON backend)

See [`src/sitl/ardupilotJson.ts`](../src/sitl/ardupilotJson.ts) for the protocol, with references
to ArduPilot's `SIM_JSON.cpp`.
- ArduPilot sends a servo packet to UDP 9002 for each physics frame: 16 or 32 channels, PWM.
- FPV Sim steps once per new `frame_count` (by 1 / `frame_rate`) and replies with one JSON state
  line:
  - IMU (body FRD);
  - NED position and velocity from home;
  - attitude quaternion;
  - rangefinder;
  - battery.
- A resent frame is answered without stepping.

ArduPilot simulates its own GPS receiver from `position`, so the layer reaches it like this:
- **Spoofing:** the counterfeit offset is added to `position`.
- **Jamming / GNSS loss:** use ArduPilot's `SIM_GPS1_ENABLE` (or `SIM_GPS_DISABLE` on older
  versions).
- **Motor, prop, IMU, barometer and payload faults:** act in the plant and the IMU stream as they
  do for PX4.

## What was checked

[`tests/sitl.test.ts`](../tests/sitl.test.ts) and [`tests/sitlProtocol.test.ts`](../tests/sitlProtocol.test.ts):
- A stand-in ArduPilot (an attitude and altitude controller that reads only the JSON state) flies
  the plant through the real protocol to 2 m and holds it there for 6 s, at 400 Hz lock-step.
- A stand-in PX4 checks:
  - the HIL clock (exactly 4000 µs per step);
  - FRD signs (gravity reads −9.81 on z at rest; the field points down);
  - every sensor group's flags, GPS units, ground truth, rangefinder;
  - the TCP server's wall-clock-then-lock-step behaviour;
  - motors lifting the quad;
  - a GNSS jammer taking PX4's fix away.
- The MAVLink codec's CRC_EXTRA values are computed from the message definitions and match the
  generated C library, with a hand-checked byte vector.

Not done here: a run against real PX4 or ArduPilot binaries. Neither can be built or run in this
project's CI. The protocol layer follows their sources, cited in the code. Please report anything
that doesn't connect.
