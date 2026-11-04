"""Fly a plane's ArduPilot mission from Python, headless and lock-stepped.

    python3 python/examples/ardupilot_mission.py            (pymavlink optional: pip install pymavlink)

The simulation runs ArduPlane 4.7 (compiled to WebAssembly, in Node) on the AtomRC Penguin over
Meadow Park. The script sets two parameters, uploads a square mission, switches to AUTO and
throws the plane (throttle stick up while armed in AUTO: ArduPilot feels the throw and starts the
motor), then steps the simulation and prints the mission's progress. With pymavlink installed it
also listens to ArduPilot's own MAVLink on tcp:127.0.0.1:5760, as a ground station would (MAVProxy,
QGroundControl and Mission Planner connect there too).
"""
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fpvsim import Client  # noqa: E402

GPS_ORIGIN = (47.3977, 8.5456)  # the simulator's GPS origin (x, y = 0): docs/ARDUPILOT.md


def latlon(x: float, y: float) -> tuple[float, float]:
    """World ENU metres to latitude / longitude (ArduPilot's own flat-earth offsets)."""
    r = 6378100.0
    return (GPS_ORIGIN[0] + math.degrees(y / r), GPS_ORIGIN[1] + math.degrees(x / (r * math.cos(math.radians(GPS_ORIGIN[0])))))


SCENARIO = {
    "format": "fpvsim-scenario", "version": 1,
    "map": {"id": "park"},
    "drone": {"preset": "Plane: AtomRC Penguin"},
    "sim": {"physicsHz": 2000, "wind": {"speed": 2}},
    "episode": {"maxSeconds": 600, "endOutOfBounds": False},
}

try:
    from pymavlink import mavutil  # type: ignore
except ImportError:
    mavutil = None

with Client.launch(mavlink_port=5760 if mavutil else None) as sim:
    r = sim.reset(SCENARIO, seed=1)
    print("firmware:", sim.hello()["firmware"], "| mode:", r["obs"]["ap"]["mode"], "| in hand:", r["obs"]["ap"]["inHand"])
    gcs = mavutil.mavlink_connection("tcp:127.0.0.1:5760") if mavutil else None

    sim.set_params(AIRSPEED_CRUISE=17, WP_RADIUS=25)
    square = [(120, -120), (120, 120), (-120, 120), (-120, -120)]
    items = [{"command": 22, "lat": latlon(*square[0])[0], "lon": latlon(*square[0])[1], "alt": 30, "params": [12, 0, 0, 0]}]  # NAV_TAKEOFF
    items += [{"command": 16, "lat": la, "lon": lo, "alt": 40} for la, lo in (latlon(x, y) for x, y in square)]  # NAV_WAYPOINT
    items += [{"command": 177, "lat": 0, "lon": 0, "alt": 0, "params": [2, -1, 0, 0], "frame": 2}]  # DO_JUMP back to item 2, forever
    print(sim.upload_mission(items)["message"])

    # AUX2 (CH6) mid: FBWA; then AUX4 (CH8) AUTO, arm on AUX1 (CH5), the throttle stick up: the pilot throws
    sim.step({"rc": [1500, 1500, 1000, 1500, 1000, 1500, 1000, 1000]}, steps=50)
    sim.step({"rc": [1500, 1500, 1000, 1500, 1000, 1500, 1000, 2000]}, steps=50)
    sim.step({"rc": [1500, 1500, 1000, 1500, 2000, 1500, 1000, 2000]}, steps=75)
    sim.step({"rc": [1500, 1500, 2000, 1500, 2000, 1500, 1000, 2000]}, steps=100)  # the throw and the climb-out
    # the stick back down once it flies: in AUTO a throttle stick above half "nudges" the target
    # airspeed up toward AIRSPEED_MAX (THROTTLE_NUDGE)
    action = {"rc": [1500, 1500, 1000, 1500, 2000, 1500, 1000, 2000]}
    for i in range(240):
        o = sim.step(action, steps=25)["obs"]  # 0.5 s at the scenario's control rate
        a = o["ap"]
        if i % 12 == 0:
            print(f"t {o['t']:6.1f} s  {a['mode']:6}  wp {a['wpSeq']}/{a['wpTotal']}  {a['wpDist']:5.0f} m  alt {a['relAlt']:5.1f} m  airspeed {a['airspeed']:4.1f} m/s")
        if gcs:
            while (m := gcs.recv_match(blocking=False)) is not None:
                if m.get_type() == "STATUSTEXT":
                    print("  ArduPilot:", m.text)
