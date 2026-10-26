"""Record a camera dataset from the live game: pictures, depth, segmentation and labels, streamed
frame by frame and written to a folder (the layout of the in-app .zip, see docs/DATASET.md).

    npm run api -- --live          # then open the simulator with ?api=ws://127.0.0.1:8765
    python3 python/examples/record_dataset.py out_dir [seconds] [hz]

Fly yourself while it records (or run live_autopilot.py alongside).
"""
import base64
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fpvsim import Client  # noqa: E402

out = Path(sys.argv[1] if len(sys.argv) > 1 else "dataset")
seconds = float(sys.argv[2]) if len(sys.argv) > 2 else 10
hz = float(sys.argv[3]) if len(sys.argv) > 3 else 10
for d in ("rgb", "depth", "segmentation", "instance"):
    (out / d).mkdir(parents=True, exist_ok=True)
labels = open(out / "frames.jsonl", "w", encoding="utf-8")
n = 0


def on_frame(e):
    global n
    i = e["labels"]["frame"]
    for k in ("rgb", "depth", "segmentation", "instance"):
        if k in e:
            (out / k / f"{i:06d}.png").write_bytes(base64.b64decode(e[k]))
    labels.write(json.dumps(e["labels"]) + "\n")
    n += 1


with Client() as sim:
    print("connected to", sim.hello()["app"])
    sim.on("frame", on_frame)
    sim.record("start", hz=hz, rgb=True, depth=True, segmentation=True)
    time.sleep(seconds)
    r = sim.record("stop")
    time.sleep(0.5)
    (out / "meta.json").write_text(json.dumps(r.get("meta", {}), indent=2))
labels.close()
print(f"{n} frames in {out}/ ({r.get('dropped', 0)} skipped)")
