"""Fly the browser game from Python, in real time: a position-hold autopilot over the live API.

1. Start the relay:        npm run api -- --live
2. Open the simulator with ?api=ws://127.0.0.1:8765 in the address (allow the connection), e.g.
   http://localhost:5173/?api=ws://127.0.0.1:8765 or https://fpv-sim-gamma.vercel.app/?api=ws://127.0.0.1:8765
3. python3 python/examples/live_autopilot.py

The script loads the Whoop Gym hover scenario, arms in angle mode, holds the hover box for 20 s
reading state at 50 Hz, then hands the sticks back to your controller. Watch it fly in the goggles;
the banner in the page takes the controls back at any time.
"""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fpvsim import Client  # noqa: E402

HZ = 50

with Client() as sim:
    print("connected to", sim.hello()["app"], "(live game)")
    sim.on("episode", lambda e: print("episode ended:", e["reason"]))
    r = sim.reset(scenario="scenarios/hover-whoop-gym.json")
    hover = 0.45
    iz = 0.0
    t_end = time.time() + 20
    try:
        while time.time() < t_end:
            o = sim.state()["obs"]
            if o["goalBody"] is None:
                break
            gx, gy, gz = o["goalBody"]
            vx, vy, vz = o["vel"]
            iz = max(-0.2, min(0.2, iz + 0.05 * gz / HZ))
            sim.act(throttle=max(0.0, min(1.0, hover + iz + 0.1 * gz - 0.1 * vz)),
                    pitch=max(-0.3, min(0.3, 0.2 * gx)), roll=max(-0.3, min(0.3, -0.2 * gy)), arm=True, mode="angle")
            time.sleep(1 / HZ)
        print("metrics:", {k: v for k, v in sim.metrics().items() if isinstance(v, (int, float))})
    finally:
        sim.act(throttle=0.0)
        time.sleep(0.5)
        sim.release()
        print("sticks handed back to the pilot")
