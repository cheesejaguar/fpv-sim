"""Operations demo (headless): the same hover under a 2.4 GHz jammer over a radio link and over a
fibre-optic link, a motor failure injected mid-flight, and a link-margin map for mission planning.

    python3 python/examples/ops_demo.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fpvsim import Client  # noqa: E402

BASE = {
    "format": "fpvsim-scenario", "version": 1, "seed": 4,
    "map": {"id": "field"}, "drone": {"preset": '5" Freestyle 6S'},
    "start": {"armed": True, "mode": "angle"},
    "task": {"type": "hover", "heightM": 3, "radiusM": 2},
    "episode": {"maxSeconds": 8, "controlHz": 50, "endOnCrash": False},
}
JAMMER = {"id": "j1", "band": "2.4", "pos": [-44, -16, 3], "erpW": 20, "fromS": 2}


def fly(sim, scenario, inject=None):
    o = sim.reset(scenario)["obs"]
    for i in range(400):
        if inject and i == 150:
            sim.fault(*inject)
        thr = max(0, min(1, 0.3 + 0.12 * (3 - o["agl"]) - 0.1 * o["vel"][2]))
        r = sim.step({"throttle": thr})
        o = r["obs"]
        for e in r["info"]["events"]:
            if e["type"] not in ("log",):
                print(f"   {e['t']:5.2f} s  {e}")
        if r["terminated"] or r["truncated"]:
            break
    ops = o.get("ops", {})
    link = ops.get("link", {})
    print(f"   end: t {o['t']:.1f} s, height {o['agl']:.1f} m, armed {o['armed']}, link {link.get('type')} LQ {link.get('lq')}, faults {ops.get('faults')}")


with Client.launch() as sim:
    print("radio link, jammer switched on at 2 s:")
    fly(sim, {**BASE, "ops": {"emitters": [JAMMER]}})
    print("fibre-optic link, same jammer:")
    fly(sim, {**BASE, "ops": {"emitters": [JAMMER], "link": {"type": "fiber"}}})
    print("motor 3 fails at 3 s:")
    fly(sim, {**BASE, "ops": {}}, inject=[{"at": 0, "kind": "motor_failure", "motor": 3}])

    sim.reset({**BASE, "ops": {"emitters": [{**JAMMER, "pos": [60, 40, 10], "fromS": 0}, {"band": "gnss", "pos": [-150, 120, 5], "erpW": 1}]}})
    m = sim.linkmap(centre=[0, 0], half_m=250, n=21, height_m=30)
    print("RC link margin at 30 m (# lost, + marginal, . fine; P = pilot) and GNSS satellites (0-9, * = 10+):")
    px, py = m["pilot"][0], m["pilot"][1]
    for j in range(len(m["ys"]) - 1, -1, -1):
        row = ""
        for i in range(len(m["xs"])):
            if abs(m["xs"][i] - px) < 13 and abs(m["ys"][j] - py) < 13:
                row += "P"
                continue
            mg = m["marginDb"][j][i]
            row += "#" if mg < 0 else "+" if mg < 10 else "."
        sats = "".join(str(s) if s < 10 else "*" for s in m["gnssSats"][j])
        print(f"   {row}   {sats}")
