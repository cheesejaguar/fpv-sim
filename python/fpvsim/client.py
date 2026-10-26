"""Client for the FPV Sim control API (protocol "fpvsim-api" v1, see docs/API.md).

Newline-delimited JSON over TCP, to a headless simulation (``npm run api``) or, through the
relay (``npm run api -- --live``), to the browser game. Standard library only.

    from fpvsim import Client
    with Client.launch() as sim:                 # starts `node scripts/fpv-api.mjs --stdio`
        obs = sim.reset(scenario="scenarios/hover-whoop-gym.json")["obs"]
        for _ in range(500):
            r = sim.step(throttle=0.4)
"""
from __future__ import annotations

import itertools
import json
import os
import queue
import socket
import subprocess
import sys
import threading
from pathlib import Path
from typing import Any, Callable, Iterable

__all__ = ["Client", "ApiError", "REPO_ROOT"]

#: the repository this package lives in (where scripts/fpv-api.mjs is)
REPO_ROOT = Path(__file__).resolve().parents[2]


class ApiError(RuntimeError):
    """The simulator refused a request (the message says why)."""


def _scenario(s: Any) -> Any:
    """A scenario given as a dict, a JSON string, or a path to a .json file."""
    if s is None or isinstance(s, dict):
        return s
    if isinstance(s, (str, os.PathLike)):
        text = str(s)
        if text.lstrip().startswith("{"):
            return json.loads(text)
        p = Path(text)
        if not p.is_absolute() and not p.exists():
            p = REPO_ROOT / p
        return json.loads(p.read_text(encoding="utf-8"))
    raise TypeError("scenario: a dict, a JSON string or a path")


class Client:
    """One connection: requests are answered in order; events go to the handlers (on() / events)."""

    def __init__(self, host: str = "127.0.0.1", port: int | None = None, timeout: float = 120.0, *, _streams=None, _proc=None):
        port = port if port is not None else int(os.environ.get("FPVSIM_PORT", "7878"))
        self._ids = itertools.count(1)
        self._lock = threading.Lock()
        self._waiting: dict[int, "queue.Queue[dict]"] = {}
        self._handlers: dict[str, list[Callable[[dict], None]]] = {}
        #: events not taken by a handler (newest last; bounded)
        self.events: "queue.Queue[dict]" = queue.Queue(maxsize=10000)
        self.timeout = timeout
        self._proc = _proc
        if _streams is not None:
            self._rfile, self._wfile = _streams
            self._sock = None
        else:
            self._sock = socket.create_connection((host, port), timeout=timeout)
            self._sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            self._sock.settimeout(None)
            self._rfile = self._sock.makefile("r", encoding="utf-8", newline="\n")
            self._wfile = self._sock.makefile("w", encoding="utf-8", newline="\n")
        self._closed = False
        self._reader = threading.Thread(target=self._read, name="fpvsim-reader", daemon=True)
        self._reader.start()

    # -- connection -------------------------------------------------------------------------------

    @classmethod
    def launch(cls, realtime: bool = False, scenario: Any = None, node: str = "node", root: Path | str | None = None) -> "Client":
        """Start a private headless simulation (node scripts/fpv-api.mjs --stdio) and connect to it."""
        root = Path(root) if root else REPO_ROOT
        cmd = [node, str(root / "scripts" / "fpv-api.mjs"), "--stdio"]
        if realtime:
            cmd.append("--realtime")
        if scenario is not None:
            import tempfile
            f = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
            json.dump(_scenario(scenario), f)
            f.close()
            cmd += ["--scenario", f.name]
        proc = subprocess.Popen(cmd, cwd=root, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=sys.stderr, text=True, encoding="utf-8", bufsize=1)
        return cls(_streams=(proc.stdout, proc.stdin), _proc=proc)

    def close(self) -> None:
        if self._closed:
            return
        try:
            self.call("bye", timeout=5)
        except Exception:
            pass
        self._closed = True
        # end the stream first, so the reader thread sees EOF instead of blocking on a closed file
        # (closing a buffered file another thread is reading can deadlock)
        try:
            if self._sock is not None:
                self._sock.shutdown(socket.SHUT_RDWR)
            else:
                self._wfile.close()  # the server exits when its stdin ends
        except Exception:
            pass
        if self._proc is not None:
            try:
                self._proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self._proc.kill()
        self._reader.join(timeout=5)
        for f in (self._wfile, self._rfile):
            try:
                f.close()
            except Exception:
                pass
        if self._sock is not None:
            self._sock.close()

    def __enter__(self) -> "Client":
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    def _read(self) -> None:
        for line in self._rfile:
            line = line.strip()
            if not line:
                continue
            try:
                m = json.loads(line)
            except ValueError:
                continue
            if "event" in m and "id" not in m:
                hs = self._handlers.get(m["event"], []) + self._handlers.get("*", [])
                for h in hs:
                    try:
                        h(m)
                    except Exception as e:  # a handler's bug must not stop the reader
                        print(f"fpvsim: event handler failed: {e!r}", file=sys.stderr)
                if not hs:
                    if self.events.full():
                        self.events.get_nowait()
                    self.events.put_nowait(m)
                continue
            q = self._waiting.pop(m.get("id"), None)
            if q is not None:
                q.put(m)
        # the connection ended: wake everyone waiting
        for q in list(self._waiting.values()):
            q.put({"ok": False, "error": "connection closed"})
        self._waiting.clear()

    # -- requests ---------------------------------------------------------------------------------

    def call(self, cmd: str, timeout: float | None = None, **params: Any) -> dict:
        """Send one command; returns the reply (without id / ok), raises ApiError when refused."""
        if self._closed:
            raise ApiError("connection closed")
        rid = next(self._ids)
        q: "queue.Queue[dict]" = queue.Queue(maxsize=1)
        self._waiting[rid] = q
        msg = json.dumps({"id": rid, "cmd": cmd, **{k: v for k, v in params.items() if v is not None}}, separators=(",", ":"))
        with self._lock:
            self._wfile.write(msg + "\n")
            self._wfile.flush()
        try:
            r = q.get(timeout=timeout if timeout is not None else self.timeout)
        except queue.Empty:
            self._waiting.pop(rid, None)
            raise ApiError(f"{cmd}: no answer within {timeout or self.timeout} s") from None
        if not r.get("ok"):
            raise ApiError(f"{cmd}: {r.get('error')}")
        r.pop("ok", None)
        r.pop("id", None)
        return r

    def on(self, event: str, handler: Callable[[dict], None]) -> None:
        """Call handler(message) for every event of this kind ('state', 'gate', 'impact', 'log', 'episode', 'control', 'bye', or '*')."""
        self._handlers.setdefault(event, []).append(handler)

    # -- commands ---------------------------------------------------------------------------------

    def hello(self) -> dict:
        return self.call("hello", client="fpvsim-python")

    def reset(self, scenario: Any = None, seed: int | None = None) -> dict:
        """Start an episode; scenario: a dict, JSON text or a path (relative paths also from the repo)."""
        return self.call("reset", scenario=_scenario(scenario), seed=seed)

    def step(self, action: dict | None = None, steps: int | None = None, vector: bool = False, **sticks: Any) -> dict:
        """Lock-step: apply the action (dict, or keywords roll / pitch / yaw / throttle / arm / mode ...) for one control period."""
        a = dict(action or {}, **sticks)
        return self.call("step", action=a or None, steps=steps, vector=vector or None)

    def act(self, action: dict | None = None, **sticks: Any) -> None:
        """Real time: set the sticks / switches from now on (the live game: take over the controller)."""
        self.call("act", action=dict(action or {}, **sticks))

    def release(self) -> None:
        """Live game: hand the sticks back to the pilot."""
        self.call("release")

    def state(self, vector: bool = False) -> dict:
        return self.call("state", vector=vector or None)

    def subscribe(self, hz: float = 60) -> None:
        self.call("subscribe", stream="state", hz=hz)

    def unsubscribe(self) -> None:
        self.call("unsubscribe", stream="state")

    def cli(self, lines: Iterable[str] | str) -> str:
        if isinstance(lines, str):
            lines = lines.splitlines()
        return self.call("cli", lines=list(lines))["output"]

    def respawn(self, full_battery: bool = False) -> dict:
        return self.call("respawn", fullBattery=full_battery or None)

    def teleport(self, pos: Iterable[float], yaw_deg: float = 0.0) -> dict:
        return self.call("teleport", pos=list(pos), yawDeg=yaw_deg)

    def pause(self) -> None:
        self.call("pause")

    def resume(self) -> None:
        self.call("resume")

    def metrics(self) -> dict:
        return self.call("metrics")["metrics"]

    def capture(self, rgb: bool = True, depth: bool = False, segmentation: bool = False, labels: bool = True) -> dict:
        """Live game only: the camera frame (PNG, base64) and ground truth; see docs/DATASET.md."""
        return self.call("capture", rgb=rgb, depth=depth, segmentation=segmentation, labels=labels)

    def record(self, action: str, hz: float | None = None, **kinds: bool) -> dict:
        """Live game only: record('start', hz=10, depth=True) ... record('stop') -> {'zip': base64}."""
        return self.call("record", action=action, hz=hz, **kinds)
