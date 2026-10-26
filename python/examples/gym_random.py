"""The Gymnasium environment: a few episodes of a random policy on the randomized hover scenario.

Swap the random policy for your agent (stable-baselines3, CleanRL, RLlib ...). Each environment is
its own Node process; run several for parallel rollouts (gymnasium.vector.AsyncVectorEnv).

    python3 -m pip install gymnasium numpy
    python3 python/examples/gym_random.py
"""
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fpvsim import FpvSimEnv  # noqa: E402

env = FpvSimEnv("scenarios/hover-randomized.json")
print("observation:", env.observation_space.shape, "action:", env.action_space.shape)
print("labels:", ", ".join(env.labels[:12]), "...")
try:
    if hasattr(env, "spec") and "gymnasium" in sys.modules:
        from gymnasium.utils.env_checker import check_env
        check_env(env, skip_render_check=True)
        print("gymnasium env_checker: passed")
    for ep in range(3):
        obs, info = env.reset(seed=100 + ep)
        total, steps, done = 0.0, 0, False
        while not done:
            a = env.action_space.sample()
            a[3] = 0.5 + 0.1 * a[3]  # throttle around hover so episodes are not all crashes
            obs, r, terminated, truncated, info = env.step(a)
            total += r
            steps += 1
            done = terminated or truncated
        print(f"episode {ep} (seed {100 + ep}): {steps} steps, return {total:.2f}, ended: {info['reason']}")
    # the same seed replays the same episode
    a = np.zeros(4, dtype=np.float32); a[3] = 0.45
    o1, _ = env.reset(seed=7); o1 = [env.step(a)[0] for _ in range(50)][-1]
    o2, _ = env.reset(seed=7); o2 = [env.step(a)[0] for _ in range(50)][-1]
    print("same seed, same actions -> identical observations:", bool(np.array_equal(o1, o2)))
finally:
    env.close()
