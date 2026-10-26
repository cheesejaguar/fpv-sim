"""A Gymnasium environment over the headless simulator (lock-step, Betaflight in the loop).

    import fpvsim
    env = fpvsim.FpvSimEnv("scenarios/hover-randomized.json")
    obs, info = env.reset(seed=1)
    obs, reward, terminated, truncated, info = env.step(env.action_space.sample())

Actions: [roll, pitch, yaw, throttle], roll / pitch / yaw in [-1, 1] and throttle in [0, 1] (the
sticks of a Mode 2 radio). Observations: the server's observation vector (obsVector in
src/headless/env.ts; env.labels names each entry). Works without gymnasium installed (the spaces are
then simple stand-ins); numpy is required.
"""
from __future__ import annotations

from typing import Any

import numpy as np

from .client import Client, _scenario

try:  # optional
    import gymnasium as gym
    from gymnasium import spaces
    _Base = gym.Env
except ImportError:  # pragma: no cover - exercised when gymnasium is missing
    gym = None
    _Base = object

    class _Box:
        def __init__(self, low, high, shape=None, dtype=np.float32):
            self.low = np.broadcast_to(np.asarray(low, dtype=dtype), shape or np.shape(low)).copy()
            self.high = np.broadcast_to(np.asarray(high, dtype=dtype), shape or np.shape(high)).copy()
            self.shape = self.low.shape
            self.dtype = dtype

        def sample(self):
            lo = np.where(np.isfinite(self.low), self.low, -1.0)
            hi = np.where(np.isfinite(self.high), self.high, 1.0)
            return np.random.uniform(lo, hi).astype(self.dtype)

        def contains(self, x):
            x = np.asarray(x)
            return x.shape == self.shape and bool(np.all(x >= self.low) and np.all(x <= self.high))

    class spaces:  # noqa: N801 - mimics gymnasium.spaces
        Box = _Box


class FpvSimEnv(_Base):
    """One headless simulation (its own Node process) as a Gymnasium environment."""

    metadata = {"render_modes": []}

    def __init__(self, scenario: Any = "scenarios/hover-randomized.json", client: Client | None = None):
        self.scenario = _scenario(scenario)
        self.sim = client or Client.launch()
        self._own = client is None
        first = self.sim.reset(scenario=self.scenario)
        self.labels: list[str] = first["vectorLabels"]
        self.action_space = spaces.Box(low=np.array([-1, -1, -1, 0], dtype=np.float32), high=np.array([1, 1, 1, 1], dtype=np.float32), dtype=np.float32)
        self.observation_space = spaces.Box(low=-np.inf, high=np.inf, shape=(len(self.labels),), dtype=np.float32)
        self._first: dict | None = first

    def reset(self, *, seed: int | None = None, options: dict | None = None):
        if gym is not None:
            super().reset(seed=seed)
        if self._first is not None and seed is None and not options:
            r, self._first = self._first, None
        else:
            self._first = None
            r = self.sim.reset(scenario=(options or {}).get("scenario"), seed=seed)
            self.labels = r["vectorLabels"]
        st = self.sim.state(vector=True)
        return np.asarray(st["vec"], dtype=np.float32), {"seed": r["info"]["seed"], "obs": r["obs"], "episode": r["info"]["episode"]}

    def step(self, action):
        a = np.asarray(action, dtype=np.float64).reshape(4)
        r = self.sim.step({"roll": float(a[0]), "pitch": float(a[1]), "yaw": float(a[2]), "throttle": float(a[3])}, vector=True)
        info = r["info"]
        info["obs"] = r["obs"]
        return np.asarray(r["vec"], dtype=np.float32), float(r["reward"]), bool(r["terminated"]), bool(r["truncated"]), info

    def close(self):
        if self._own:
            self.sim.close()
