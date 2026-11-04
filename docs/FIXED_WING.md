# Fixed-wing aircraft

FPV Sim flies planes as well as quads: five commercial FPV planes are presets, any of them can be
rebuilt in the drone builder with other motors, props, batteries and video systems, and every plane
flies **ArduPlane 4.7.2**, the real firmware compiled to WebAssembly ([ARDUPILOT.md](ARDUPILOT.md)).

## The presets

| Preset | Layout | Span | AUW | Wing loading | Stall / cruise / top | Cruise current | Endurance | Glide | Static margin |
|---|---|---|---|---|---|---|---|---|---|
| HEEWING T1 Ranger | V-tail, twin tractor | 730 mm | 437 g | 40 g/dm² | 26 / 55 / 118 km/h | 2.6 A | 24 min | 10.5 | 10 % |
| AtomRC Penguin | flying wing, twin tractor | 750 mm | 713 g | 47 g/dm² | 29 / 60 / 106 km/h | 6.0 A | 17 min | 9.1 | 7 % |
| SonicModell AR Wing Pro | flying wing, pusher | 1000 mm | 978 g | 54 g/dm² | 31 / 70 / 122 km/h | 3.9 A | 40 min | 13.8 | 7 % |
| ZOHD Talon GT Rebel | V-tail, pusher | 1000 mm | 1238 g | 88 g/dm² | 36 / 65 / 113 km/h | 3.7 A | 116 min | 13.8 | 10 % |
| Volantex Ranger 2000 | conventional, pusher | 2000 mm | 1264 g | 34 g/dm² | 22 / 50 / 73 km/h | 4.1 A | 26 min | 19.6 | 10 % |

The figures are the builder's, worked out with the same models the simulation flies. Each preset
uses the power system it ships with: the T1's 1404 3700KV motors on FX-3830 props and 3S 1300; the
Penguin's 2004 2400KV on 6026 props and 4S 2200; the AR Wing Pro's 2216 1400KV on an 8x5 and 4S
3300; the Talon's 2216 1300KV, 8x5 and a 4S2P 21700 Li-ion pack; and the Ranger 2000's 2215 1400KV,
an 8x4 folding prop and 3S 2200.

Sources: the makers' and retailers' published span, wing area, motors, props, batteries and weights
(`src/data/airframes.ts` names each). Where no source gave a figure, it is an estimate from the
published dimensions and photos, and the airframe lists it as such: some wing areas, taper, sweep,
dihedral, tail areas and arms, and every aerofoil coefficient. The builder shows the list under the
plane's figures.

## Flight model

A plane is the same plant as a quad (`src/sim/quad.ts`): rigid body, battery, motors, BEMT props,
IMU, contacts and damage. To that it adds lifting surfaces (`src/sim/wing.ts`):

- **Per surface.** Each wing half, tailplane, V-tail panel, fin and winglet sits at its own
  aerodynamic centre, with its own airflow: the vehicle's motion through the air plus the
  rotation's w × r. That gives the roll, pitch and yaw damping, and the dihedral effect, from the
  geometry rather than from fitted derivatives.
- **Lift and drag.** The attached lift slope follows Helmholtz's lifting-line fit for the
  surface's aspect ratio, with induced drag from the Oswald factor. Past the stall the surface
  blends into a flat plate (Beard and McLain's sigmoid), so a stalled wing drops a wing and keeps
  flying as a plate does.
- **Controls.** A control surface changes the zero-lift angle by its flap effectiveness and
  pitches the aerofoil nose down (thin-aerofoil theory, about 2/3 of its ideal value). Each servo
  follows its command at a slew rate.
- **Interference.** The wing's downwash reaches the tail, and a tractor prop's slipstream blows
  over the wing behind it.
- **Folding props** fold flat when the motor stops, so a glider glides.

## The builder

The plane builder (`src/builder/plane.ts`) sets each plane up the way a pilot sets up the real one:

- **CG.** It finds the neutral point from the wing's and tail's lift slopes, the tail volume and
  the downwash. It then slides the battery along its bay until the CG sits the airframe's static
  margin ahead of that point.
- **Trim.** It solves the tail's incidence (a flying wing's reflex) so the plane flies hands off,
  controls centred, at its design cruise speed. The thrust line, the slipstream and the fuselage
  are all included.
- **Torque.** It warps the wing a touch against a single prop's torque at cruise. Twins
  counter-rotate.
- **Figures.** It derives stall, cruise and top speed, cruise throttle and current, endurance,
  range and best glide from the same surface and rotor models.
- **ArduPlane setup.** It works out ArduPlane's setup:
  - the servo map of the layout;
  - trim throttle and cruise airspeed;
  - the rate loops' feed-forward. This is 45° divided by the roll or pitch rate full deflection
    gives at `SCALING_SPEED`, the quantity ArduPlane's AUTOTUNE measures; P and I follow in the
    ratios of ArduPlane's own defaults.

## Flying one

Planes start in the pilot's hand, at shoulder height on the spawn, nose a little up. Arm on AUX1,
then run the motor up. Past 65 % for 0.3 s, the hand throws the plane: a 0.4 s push to 11 m/s,
which the IMU feels as a real throw. In AUTO or TAKEOFF the motor stays off until ArduPilot feels
that throw, so throw by pushing the throttle stick past 80 % while armed. Lower the stick once the
plane flies: above half, AUTO's throttle nudge raises the target airspeed. The OSD tells you what
the hand is waiting for.

AUX2 picks the flight mode, the same way Betaflight's acro / horizon / angle does: low ACRO
(rate with attitude hold), mid FBWA (self-levelling), high CRUISE (holds heading and altitude).
AUX3 is RTL, and AUX4 AUTO, which flies the map's mission.

Tests: `tests/plane.test.ts` checks the plant: every preset balances at its static margin, holds
its cruise hands off, answers each control the way ArduPlane's outputs expect, and glides near its
best glide ratio. `tests/ardupilot.test.ts` checks the real ArduPlane flying it: FBWA climb-out,
AUTO takeoff and a mission.
