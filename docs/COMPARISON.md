# How FPV Sim compares: a gap analysis

This page sets FPV Sim against the simulators drone developers use today, says which gaps this
release fills, and lists the gaps that remain. It was written in October 2026 from public sources
(listed at the end) and the project's own testing. Vendor claims are reported as claims.

## Who uses what

| Group | Typical tools | What they get from them |
| --- | --- | --- |
| Autonomy and RL research | NVIDIA Isaac Sim with Pegasus, Aerial Gym, Flightmare, gym-pybullet-drones, HyperDrone | photoreal or GPU-parallel rendering; thousands of drones per GPU for reinforcement learning |
| Autopilot development (PX4 / ArduPilot) | Gazebo with PX4 or ArduPilot SITL, jMAVSim, AirSim (archived; Project AirSim was announced as its successor) | the autopilot's own code in the loop over MAVLink; ROS 2 integration |
| Engineering and model-based design | MATLAB / Simulink UAV Toolbox, in-house plant models | design studies, controller design, code generation, HIL rigs |
| Military operator training | VBS4 with Bohemia's drone module (InVeris *fats Drone*), FlowState by OneArc / BAE Systems (US Marine Corps), MVRsimulation's FPV team trainer, Ukrainian trainers such as F-Drones' military edition | battlespace context, jamming and EW conditions, team and counter-UAS training |
| Hobby and commercial FPV pilots | Liftoff, Velocidrone, Uncrashed, DRL Sim | feel, tracks, multiplayer |
| RF and GNSS resilience testing | SDR jammer / GNSS simulators (e.g. GPSPatron), GNSS threat simulators in research | real RF interference on real hardware |

## Where FPV Sim stood before this release

Already distinctive:
- **The real flight firmware.** It runs Betaflight 4.5.5 compiled to WebAssembly in lock-step with
  an 8 kHz plant. Other simulators run a model of a flight controller, or need a separate SITL
  build.
- **Component-level physics** derived from a parts list:
  - BEMT rotors;
  - ESC and motor electrical and thermal models;
  - battery sag with cell spread;
  - IMU vibration from frame modes;
  - crash damage.
- **Reproducible runs**: a seeded headless environment, a control API, camera datasets with ground
  truth, and training drills (the previous release).
- It runs in a browser tab with no install.

Gaps against the field:

| Gap | Who has it | Status after this release |
| --- | --- | --- |
| Fault injection (motor, prop, sensors, links, battery) | Gazebo plugins, PX4's `failure` command, MATLAB fault blocks | **Filled.** 16 fault kinds, scheduled or injected live, randomizable ([OPERATIONS.md](OPERATIONS.md)) |
| EW: jamming, GNSS denial and spoofing | FlowState, F-Drones (military), SDR test benches | **Filled, and goes further.** See *novel 1* below |
| Payloads and drops | VBS4 munitions, delivery-drone tools | **Filled.** Payload mass on the airframe, release, ballistic fall in the wind, a drop task, CEP statistics |
| PX4 / ArduPilot in the loop | Gazebo, AirSim, Pegasus | **Filled.** `npm run sitl` is the physics plant for PX4 (MAVLink HIL, lock-step) and ArduPilot (JSON) ([AUTOPILOTS.md](AUTOPILOTS.md)) |
| Navigation sensors (compass, rangefinder, optical flow) | Gazebo, Isaac, AirSim | **Filled.** In the observations and the PX4 / ArduPilot streams |
| Monte Carlo and batch evaluation | MATLAB (Parallel Computing Toolbox), custom scripts around Gazebo | **Filled, and goes further.** See *novel 3* |
| Design trade studies | MATLAB / Simulink, eCalc-style calculators | **Filled.** Campaign sweeps over builds with a Pareto front, flown with the real firmware |
| Sim-to-real validation | mostly manual, per lab | **Filled, and goes further.** See *novel 2* |
| Photoreal rendering (Unreal / Omniverse) | AirSim, Isaac Sim, Flightmare | **Open.** FPV Sim renders with three.js in the browser: fisheye, rolling shutter and ground truth, but not photoreal |
| GPU-parallel RL throughput (thousands of envs) | Aerial Gym, HyperDrone, OmniDrones | **Open by design.** About 10× real time per CPU core with the real firmware; campaigns use every core. FPV Sim is the fidelity end: train elsewhere, verify here |
| Fixed-wing and VTOL | Gazebo / PX4, RealFlight, X-Plane | **Open.** Multirotors only |
| ROS 2 bridge | Gazebo, Isaac, Aerial Gym | **Partly open.** The JSON control API and Python client work from any ROS 2 node; there is no native bridge package |
| Hardware in the loop (a real FC on USB) | PX4 HITL, Gazebo, MATLAB | **Open** |
| Thermal / IR and lidar point clouds | AirSim (IR), Isaac (RTX lidar) | **Open.** Range and segmentation images exist ([DATASET.md](DATASET.md)); thermal could be built on the semantic classes |
| Multi-vehicle headless (swarms) | Pegasus, Aerial Gym, Gazebo | **Partly open.** Live multiplayer exists; headless runs one vehicle per environment |
| Large real-world terrain (geo tiles) | Project AirSim (Bing Maps), Cesium co-simulation | **Open.** Built-in and community maps only |

## Three things nobody else offers

### Novel 1: an EW battlespace that reaches the real firmware

Jammers and spoofers are placed in the world with a power, band and schedule. Each radio link has
its own physics ([`src/sim/ew.ts`](../src/sim/ew.ts)):

| Link | What is modelled | What the drone sees |
| --- | --- | --- |
| **Control** (ELRS 2.4 GHz or 900 MHz) | Frequency hopping: a jammer hits only the hops inside its band. The jamming power inside one receiver channel has to beat LoRa's demodulation SNR | A partial-band jammer degrades the link instead of killing it |
| **Video** (5.8 GHz, at the goggles) | Jamming raises the noise floor | Analog snow, or the digital break-up and freeze state machine |
| **GNSS L1** | Effective C/N0 under jamming (the Betz / Kaplan formula). Satellites drop below the tracking threshold, the error grows, the fix goes. A spoofer that beats the real signals captures the receiver and walks its position away | Fewer satellites, a worse fix, no fix, or a counterfeit position |

Propagation for every link includes:
- free-space loss;
- obstruction by the map's buildings and terrain, scaled by frequency;
- a radio-horizon diffraction loss.

A fibre-optic link replaces the radio:
- the spool runs out at its length;
- the fibre snaps if paid out too fast;
- the paying-out fibre drags;
- the spool gets lighter in flight.

**Why it matters.** Lost packets are lost to the real Betaflight, and a spoofed fix goes to its
real GPS code, so the drone does what the shipped firmware does. It fails safe, falls back to GPS
rescue, or hangs on to the odd packet that gets through. Our tests show the last case: a jammer that
leaves 2–5 % of packets lets Betaflight hold off its final failsafe stage. A scripted "link lost"
event would never show that.

**Who has what.**
- Military trainers (FlowState, F-Drones) advertise jamming and radio-horizon effects in a game
  engine.
- RF test benches use real hardware.

We found no tool that combines the physical link budget with the production firmware's response,
runs headless for statistics, and runs in a browser for training.

### Novel 2: a digital twin from your own flight log

`npm run twin -- flight.bbl` ([DIGITAL_TWIN.md](DIGITAL_TWIN.md)):
1. Takes a Betaflight blackbox log from the real drone.
2. Rebuilds the drone's tune from the log's own headers: PIDs, rates, filters, feedforward, TPA,
   dynamic idle.
3. Flies the logged sticks through the same firmware in the simulator.
4. Compares the simulator's blackbox with the real one, decoded by the same decoder, axis by axis.

The report covers:
- gyro error and correlation;
- tracking error and delay;
- vibration noise;
- controller effort;
- motor output, which shows thrust against weight.

The fit then adjusts the build (inertia, prop thrust and torque, drag) until the simulated flight
matches. The result is a drone spec that scenarios, campaigns and the app load directly.

Elsewhere, sim-to-real calibration is a manual research exercise. Here it is one command on the
`.bbl` file every Betaflight pilot already records.

### Novel 3: verification campaigns with exact statistics and reproducible failures

`npm run campaign -- campaigns/delivery-drop.json` ([CAMPAIGNS.md](CAMPAIGNS.md)):
- Flies hundreds or thousands of randomized episodes in parallel: wind, builds, faults, jammer
  placement, payload mass.
- Uses the reference autopilot or your own controller.
- Judges written requirements, such as "lands within 3 m in 80 % of runs at 90 % confidence", on
  exact Clopper–Pearson bounds.
  - It says *inconclusive* with the number of runs that would settle the question.
  - It never reports a pass on too few runs.
- Saves every failure as a case file that re-flies bit for bit (`--case`), with a trace.
- Runs design sweeps with common random numbers, so variants are compared on the same conditions,
  and marks the Pareto front.

The report is self-contained HTML plus JSON. The exit code (0 pass, 1 fail, 2 inconclusive) gates
CI. This is the evidence a SORA / ASTM safety case or a military T&E report asks for, produced
with the production firmware in the loop.

## What the example campaigns found

These are short runs during development; your numbers will differ with more runs.

| Campaign | Result |
| --- | --- |
| **Parcel drop** in wind 0–7 m/s, 40 runs | 39 delivered: hit rate ≥ 90.6 % at 90 % confidence, 95th-percentile miss 1.17 m. The one crash was a tree on the climb-out. Seeing it led to a climb-first rule in the reference pilot |
| **Route under GNSS threats**, 8 runs per threat | A barrage jammer cut route success to 3/8. A spoofer drove it to 0/8, with 3 crashes, the navigation error growing to 60 m. Same route, same seeds |
| **Battery against payload trade study**, 6 variants × 6 runs | The 6S 1100 mAh pack was on the Pareto front for both payloads. The Li-ion 7" pack with 400 g was the only variant that failed a delivery |

## Sources

- Pegasus Simulator (Isaac Sim, PX4): [arXiv 2307.05263](https://ar5iv.labs.arxiv.org/html/2307.05263)
- Aerial Gym Simulator: [arXiv 2503.01471](https://www.arxiv.org/pdf/2503.01471); Aerial Gym (Isaac Gym): [arXiv 2305.16510](https://ar5iv.labs.arxiv.org/html/2305.16510)
- Comparative review of drone simulators: [itvisnyk.kpi.ua](https://itvisnyk.kpi.ua/article/view/300614)
- Project AirSim: [DroneDJ, 2022](https://dronedj.com/2022/07/18/microsoft-project-airsim-drone-software/)
- MATLAB / AirSim co-simulation digital twin: [Cranfield](https://dspace.lib.cranfield.ac.uk/items/f78d247b-3448-4f41-8f99-32d59cc8259e)
- FlowState (US Marine Corps): [Stars and Stripes, Sept. 2026](https://www.stripes.com/branches/marine_corps/2026-09-07/marine-corps-drone-simulator-fpv-22783372.html)
- F-Drones combat FPV simulator: [LB.ua, Aug. 2026](https://en.lb.ua/news/2026/08/22/40244_f-drones_launches_its_own_fpv.html)
- MVRsimulation FPV team trainer: [Janes](https://www.janes.com/osint-insights/defence-news/c4isr/mvrsimulation-launches-new-fpv-uav-team-trainer)
- InVeris fats Drone: [Auganix](https://www.auganix.org/?p=17910); FPV drone ops simulator: [The Defense Post](https://thedefensepost.com/2025/12/09/fpv-drone-ops-simulator)
- GNSS spoofing / jamming impact simulator: [arXiv 2405.17925](https://arxiv.org/abs/2405.17925v2); GNSS threat simulator for urban drones: [MDPI Aerospace 12(9) 787](https://www.mdpi.com/2226-4310/12/9/787); SDR jammer simulators: [GPSPatron](https://gpspatron.com/drones-resilience-testing-with-multi-band-rf-jammer-simulator/)
- Fibre-optic FPV evaluations: [I MEF / DIU](https://www.imef.marines.mil/Media-Room/Stories/Article/Article/4402976/i-mef-marines-evaluate-fiber-optic-fpv-drones-during-diu-challenge/)
- SITL for testing and certification evidence: [MAVSec, arXiv 1905.00265](https://arxiv.org/pdf/1905.00265), [DesCert, arXiv 2203.15178](https://arxiv.org/pdf/2203.15178), [metamorphic testing, arXiv 2209.11031](https://arxiv.org/pdf/2209.11031)
- Effective C/N0 under jamming: Kaplan & Hegarty, *Understanding GPS/GNSS*, 3rd ed., ch. 9
