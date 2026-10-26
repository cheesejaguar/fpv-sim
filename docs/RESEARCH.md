# FPV Sim for research, teaching and training

FPV Sim runs the real Betaflight 4.5.5 firmware in lock-step with a component-level physics model
at 8 kHz:
- blade-element rotors, prop wash and Dryden turbulence;
- battery sag, ESC behaviour and IMU vibration;
- a Kannala–Brandt fisheye camera with rolling shutter, latency and radio-link degradation.

This page lists what makes it usable as an instrument, not only as a game. Each item notes the idea
from UC Berkeley's HyperDrone paper (Eschmann & Loianno, *Simulation-to-Reality Transfer at
Millions of Frames per Second*, CoRL 2026, [arXiv:2610.28950](https://arxiv.org/abs/2610.28950))
that it follows.

FPV Sim does not compete with HyperDrone on throughput. HyperDrone batch-renders millions of frames
per second for reinforcement learning, using a simple dynamics model. FPV Sim is the
high-fidelity end, with the real firmware. Use it to evaluate and fine-tune policies trained
elsewhere, to study pilots, and to train them.

| Need | In FPV Sim | Lesson |
| --- | --- | --- |
| Drive it from a program | [Control API](API.md): headless lock-step, headless real time, and the live game; Python client and a Gymnasium environment ([python/](../python/README.md)); `window.fpvSim` in the page | a clean, scriptable loop is what makes a simulator usable for learning |
| Repeat an experiment exactly | Seeded episodes (headless): a pure function of scenario, seed, actions and firmware build. [Reproducible runs](REPLAY_FORMAT.md#reproducible-runs-fpvrun): a live flight re-simulated headless, step for step | HyperDrone is deterministic per seed. Determinism is treated as a feature here and tested |
| Hand an experiment to someone else | [Scenario files](SCENARIO_FORMAT.md) with a JSON Schema: map, drone, conditions, firmware `diff all`, start, task, limits, observations, randomization | open formats (HyperDrone: glTF scenes) make work accessible |
| Train robust policies | Domain randomization over **built** drones (parts and override scales go through the drone builder, so mass, inertia, thrust and battery stay consistent), wind, start and units; every draw repeatable from its seed | HyperDrone's randomization table, and RAPTOR's training over many airframes |
| Perception data | [Camera datasets](DATASET.md): the picture with range, semantic and instance ground truth through the same fisheye and rolling shutter, camera intrinsics and pose, and gate corners in the image | HyperDrone's renderer outputs depth, segmentation, normals and flow. Rolling shutter is its stated future work; here the labels include it |
| Cheap proximity sensing | Probe rays on a Fibonacci sphere in the observations | HyperDrone's 64 collision probes |
| Teach pilots | [Training drills](#training-drills) with an adaptive curriculum, scored by the same task code as headless episodes | HyperDrone's curriculum: widen the range when the error is below 25 % of it, in clipped steps |
| Trust the numbers | The physics tests against published data, the closed-loop firmware tests, and the parity tests below | sim-to-real transfer only means something if the simulator is checked |

## Architecture

```
                 ┌───────────────────────── the flight core (src/worker/flightCore.ts) ─────────────────────────┐
                 │ RC link → Betaflight (WASM) → DShot → ESC / motors → BEMT rotors → rigid body ← wind, contacts │
                 │ IMU / baro / current sensor / GPS ← plant                                     (8 kHz lock-step)  │
                 └───────────────────────────────────────────────────────────────────────────────────────────────┘
          browser worker (sim.worker.ts)                     headless (src/headless/env.ts, replay.ts)
          real time, shared memory, rendering                stepped by a program; Node or a worker
                 │                                                      │
     live API (src/app/liveApi.ts) ─ WebSocket ─ relay ─ TCP ─┐    headless API (src/api/headlessBackend.ts) ─ TCP / stdio
                                                              └──── Python (python/fpvsim), any language
```

The browser and the headless simulator run the same core: one implementation, not two that must
be kept in agreement. Three tests show it:
- [`tests/workerHarness.test.ts`](../tests/workerHarness.test.ts) runs the real worker in Node on
  a fake clock: the same inputs give bit-identical states. A reproducible run it records
  re-simulates headless with identical states at every millisecond.
- [`tests/headlessEnv.test.ts`](../tests/headlessEnv.test.ts): headless episodes repeat bit for
  bit from their seed.
- In the browser, a run recorded in the live game re-simulated headless without divergence (the
  check behind `npm run resim`).

## Quick start

```bash
npm ci
python3 python/examples/hover_pid.py scenarios/hover-randomized.json 3   # starts its own headless simulator
python3 -m pip install gymnasium numpy && python3 python/examples/gym_random.py
npm run api                         # headless simulations for any language: tcp://127.0.0.1:7878
npm run api -- --live               # the browser game: open it with ?api=ws://127.0.0.1:8765
python3 python/examples/live_autopilot.py
npm run resim -- flight.fpvrun      # a recorded run, re-simulated, as CSV
```

## Training drills

**Settings → Training** has seven drills:
- the whoop hover box;
- a 5" hover in wind;
- the Whoop Gym course;
- slalom, figure-8 and power loop on the Practice Field;
- the stadium lap.

Each drill turns a level (0–100 %) into a scenario, with a smaller box and a longer hold, more
wind, or a faster target lap. After each attempt, the task's metrics decide how it went:

- **Clean pass** (an error under a quarter of what the level allows): the level rises by 2.5–5 %,
  more the cleaner it was.
- **Pass that was only just made:** the level stays.
- **Crash, timeout or missed gate:** the level drops by 5 %.

The next attempt starts by itself. Every attempt is kept in the browser and exports as CSV or JSON,
for an instructor or a study. Drill scenarios run in the headless simulator too
([`src/training/curriculum.ts`](../src/training/curriculum.ts)), so pilots and policies are measured
on the same tasks with the same code.

## Limits worth knowing

- **Throughput.** Headless runs at about 5–10× real time per core with Betaflight in the loop.
  Parallelize with processes. There is no batch GPU rendering: camera datasets come from the live
  game.
- **Live game timing.** It runs in real time with the browser's timing, so it is not reproducible
  by itself. Record a reproducible run to get an exact re-simulation of it.
- **Probes and gate-corner visibility** use the collision world's ray cast: terrain, boxes and level
  brushes, not cylinders (trees, poles).
- **Foliage** is labelled by its leaf cards in segmentation.
