"""The headless simulator on the wall clock: what a game engine (Unity, Godot, Unreal ...) does to
use FPV Sim as its flight model — Betaflight in the loop, 8 kHz physics — and draw the world itself.

    python3 python/examples/realtime_stream.py

It subscribes to the state at 60 Hz (one event per rendered frame), sends sticks as they change,
and prints the pose and the rate events arrive at.
"""
import math
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fpvsim import Client  # noqa: E402

latest = {}
count = 0
lock = threading.Lock()


def on_state(e):
    global count
    with lock:
        latest.update(e["obs"])
        count += 1


with Client.launch(realtime=True) as sim:
    r = sim.reset(scenario={"format": "fpvsim-scenario", "version": 1, "map": {"id": "practice"},
                            "drone": {"preset": "5\" Freestyle 6S"}, "start": {"armed": True, "mode": "angle"}})
    hover = r["info"]["drone"]["hoverThrottle"]
    sim.on("state", on_state)
    sim.on("gate", lambda e: print("gate", e["gate"]))
    sim.subscribe(hz=60)
    t0 = time.time()
    while time.time() - t0 < 6:
        t = time.time() - t0
        # hold 3 m and fly circles: the sticks a game would read from its controller
        with lock:
            agl, vz = latest.get("agl", 0.0), latest.get("vel", [0, 0, 0])[2]
        sim.act(throttle=max(0.0, min(1.0, hover + 0.1 * (3 - agl) - 0.08 * vz)), roll=0.25 * math.sin(t), pitch=0.25 * math.cos(t))
        time.sleep(1 / 120)
        if int(t * 2) != int((t - 1 / 120) * 2):
            with lock:
                p = latest.get("pos", [0, 0, 0])
                print(f"t={latest.get('t', 0):5.2f} s  pos=({p[0]:7.2f}, {p[1]:7.2f}, {p[2]:6.2f})  armed={latest.get('armed')}  state events: {count / max(t, 1e-3):.0f}/s")
    sim.unsubscribe()
