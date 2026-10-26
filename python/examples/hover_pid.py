"""Hold a hover box with a simple cascaded controller, headless and lock-step.

The quad flies in Betaflight's angle mode: this script only closes the outer loops (position ->
tilt, height -> throttle), Betaflight does the attitude control, exactly as it would for a pilot.

    python3 python/examples/hover_pid.py [scenario.json] [episodes]
"""
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fpvsim import Client  # noqa: E402

scenario = sys.argv[1] if len(sys.argv) > 1 else "scenarios/hover-whoop-gym.json"
episodes = int(sys.argv[2]) if len(sys.argv) > 2 else 2


class Controller:
    def __init__(self, hover_thr, dt):
        self.hover, self.dt, self.iz = hover_thr, dt, 0.0

    def __call__(self, o):
        gx, gy, gz = o["goalBody"]          # target in the body frame (x forward, y left, z up), m
        vb = body_velocity(o)               # velocity in the body frame, m/s
        # height: PID on the error around the build's hover throttle
        self.iz = max(-0.2, min(0.2, self.iz + 0.05 * gz * self.dt))
        thr = self.hover + self.iz + 0.10 * gz - 0.10 * o["vel"][2]
        # position: tilt toward the target (angle mode: stick = tilt), damped by the velocity
        pitch = max(-0.4, min(0.4, 0.2 * gx - 0.3 * vb[0]))    # forward stick when the target is ahead
        roll = max(-0.4, min(0.4, -0.2 * gy + 0.3 * vb[1]))    # right stick when the target is to the right (-y)
        return {"throttle": max(0.0, min(1.0, thr)), "pitch": pitch, "roll": roll, "yaw": 0.0}


def body_velocity(o):
    w, x, y, z = o["quat"]
    vx, vy, vz = o["vel"]
    # rotate world -> body (conjugate quaternion)
    q = (w, -x, -y, -z)
    tx = 2 * (q[2] * vz - q[3] * vy); ty = 2 * (q[3] * vx - q[1] * vz); tz = 2 * (q[1] * vy - q[2] * vx)
    return (vx + q[0] * tx + (q[2] * tz - q[3] * ty), vy + q[0] * ty + (q[3] * tx - q[1] * tz), vz + q[0] * tz + (q[1] * ty - q[2] * tx))


with Client.launch() as sim:
    print(sim.hello()["app"], "|", scenario)
    for ep in range(episodes):
        r = sim.reset(scenario=scenario if ep == 0 else None)
        info = r["info"]
        build = info["episode"]["spec"]["name"]
        print(f"episode {ep}: seed {info['seed']}, {build} ({info['drone']['auwG']:.0f} g, hover throttle {info['drone']['hoverThrottle']:.2f}), booted in {info['bootS']:.1f} s of sim time")
        o = r["obs"]
        control = Controller(info["drone"]["hoverThrottle"], 1 / info["episode"]["controlHz"])
        done = False
        while not done:
            res = sim.step(control(o))
            o = res["obs"]
            done = res["terminated"] or res["truncated"]
        m = res["info"]["metrics"]
        print(f"  ended: {res['info']['reason']}; inside the box {m.get('insideFraction', 0) * 100:.0f} % of {m['elapsedS']:.1f} s, "
              f"RMS error {m.get('rmsErrorM', math.nan):.2f} m (normalized {m.get('normalizedError', math.nan):.2f}), return {m['return']:.2f}")
