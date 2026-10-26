"""FPV Sim from Python: the control API client and a Gymnasium environment.

See docs/API.md. The simulator runs in Node (headless, Betaflight in the loop) or in the browser
(the live game); this package only talks to it.
"""
from .client import ApiError, Client, REPO_ROOT

__all__ = ["Client", "ApiError", "REPO_ROOT", "FpvSimEnv"]
__version__ = "0.1.0"


def __getattr__(name):  # FpvSimEnv needs numpy: import it on first use
    if name == "FpvSimEnv":
        from .env import FpvSimEnv
        return FpvSimEnv
    raise AttributeError(name)
