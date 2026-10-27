# fpvsim (Python)

A Python client for the FPV Sim control API ([docs/API.md](../docs/API.md)) and a Gymnasium
environment over the headless simulator. The client uses only the standard library. The
environment needs numpy, and `gymnasium` if you want real Gymnasium spaces.

The simulator runs in Node (`npm ci` in the repository first) or in the browser. This package only
talks to it.

```bash
# use it from the repository (or add python/ to PYTHONPATH)
python3 python/examples/hover_pid.py
```

## A private headless simulation

```python
from fpvsim import Client

with Client.launch() as sim:            # starts `node scripts/fpv-api.mjs --stdio` for this process
    r = sim.reset(scenario="scenarios/hover-whoop-gym.json", seed=3)
    hover = r["info"]["drone"]["hoverThrottle"]
    while True:
        res = sim.step(throttle=hover + 0.05, pitch=0.0)
        if res["terminated"] or res["truncated"]:
            print(res["info"]["reason"], res["info"]["metrics"])
            break
```

`Client.launch(realtime=True)` runs the simulation on the wall clock: use `act`, `subscribe` and
event handlers (`sim.on("state", f)`), as a game engine would.

## Operations: jamming, faults, payloads

```python
sim.reset(scenario="scenarios/ew-jammer-hover.json")      # a scenario with an "ops" block
sim.fault({"at": 0, "kind": "motor_failure", "motor": 2}) # inject faults now ("at" counts from now)
sim.ops({"link": {"type": "fiber"}})                      # replace the operational environment (None removes it)
sim.drop()                                                # release the payload
grid = sim.linkmap(centre=[0, 0], half_m=250, n=21)       # RC link margin / GNSS satellites over an area
```

`python3 python/examples/ops_demo.py` shows each of them ([docs/OPERATIONS.md](../docs/OPERATIONS.md)).

## Gymnasium

```python
from fpvsim import FpvSimEnv
env = FpvSimEnv("scenarios/hover-randomized.json")   # observation: the API's vector; action: [roll, pitch, yaw, throttle]
obs, info = env.reset(seed=1)
obs, reward, terminated, truncated, info = env.step(env.action_space.sample())
```

It passes `gymnasium.utils.env_checker.check_env`, including the check that a seed repeats an
episode. Each environment is one Node process. Use `gymnasium.vector.AsyncVectorEnv` for parallel
rollouts.

## The live game

```bash
npm run api -- --live                 # then open the simulator with ?api=ws://127.0.0.1:8765
```

```python
with Client() as sim:                 # tcp://127.0.0.1:7878 (FPVSIM_PORT to change)
    sim.reset(scenario="scenarios/hover-whoop-gym.json")
    sim.act(arm=True, mode="angle", throttle=0.45)
    print(sim.state()["obs"]["pos"])
    sim.release()                     # the pilot's controller flies again
```

## Examples

| File | What |
| --- | --- |
| `examples/hover_pid.py` | a cascaded position controller holding the hover box, headless, lock-step |
| `examples/gym_random.py` | the Gymnasium environment with a random policy; Gymnasium's env checker |
| `examples/realtime_stream.py` | headless on the wall clock: 60 Hz state stream, sticks as they change |
| `examples/live_autopilot.py` | flies the browser game in real time, then hands the sticks back |
| `examples/record_dataset.py` | streams a camera dataset (picture, depth, segmentation, labels) from the browser game to a folder |
