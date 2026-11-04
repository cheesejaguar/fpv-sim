#!/usr/bin/env bash
# Build ArduPilot (ArduPlane and ArduCopter) as WebAssembly: the real autopilot, its SITL hardware
# layer, with the physics supplied by the simulator through shared memory (see firmware/apwasm/README.md).
#
#   bash firmware/apwasm/build.sh            # configure (once) and build both vehicles
#   bash firmware/apwasm/build.sh plane      # only ArduPlane (or: copter)
#   bash firmware/apwasm/build.sh clean      # forget the configure step and the objects
#
# Output: public/ap/arduplane.{mjs,wasm}, public/ap/arducopter.{mjs,wasm}
# Needs git, python3 (3.9+) and network access the first time: the script fetches the pinned
# ArduPilot commit, its build dependencies and the pinned Emscripten SDK into firmware/.
set -euo pipefail

AP_REPO="https://github.com/ArduPilot/ardupilot.git"
AP_TAG="Plane-4.7.2"      # the same commit is Copter-4.7.2
AP_SHA="fb773567896014da007bca58358704d4a0d8516f"
EMSDK_VERSION="4.0.10"    # the compiler Betaflight's WASM build uses too
SUBMODULES=(modules/waf modules/mavlink modules/littlefs modules/DroneCAN/DSDL modules/DroneCAN/dronecan_dsdlc modules/DroneCAN/libcanard modules/DroneCAN/pydronecan)

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FW="$REPO/firmware"
AP="$FW/ardupilot"
HERE="$FW/apwasm"
BUILD="$FW/build"
OUT="$BUILD/ap-wasm"
JOBS="${JOBS:-$(nproc 2>/dev/null || echo 4)}"
what="${1:-all}"

if [ "$what" = clean ]; then rm -rf "$OUT" "$BUILD/ap-stamp"; echo "cleaned $OUT"; exit 0; fi

# ---- the pinned ArduPilot tree (a working copy owned by this script: it is reset and patched) ----
if [ ! -d "$AP/.git" ]; then
    echo "== cloning ArduPilot $AP_TAG ($AP_SHA) into firmware/ardupilot"
    git clone --depth 1 --branch "$AP_TAG" "$AP_REPO" "$AP"
fi
head="$(git -C "$AP" rev-parse HEAD)"
if [ "$head" != "$AP_SHA" ]; then
    git -C "$AP" fetch --depth 1 origin "$AP_SHA" && git -C "$AP" checkout -q --detach "$AP_SHA"
    head="$(git -C "$AP" rev-parse HEAD)"
fi
[ "$head" = "$AP_SHA" ] || { echo "error: firmware/ardupilot is at $head, expected $AP_SHA" >&2; exit 1; }
for m in "${SUBMODULES[@]}"; do
    [ -e "$AP/$m/.git" ] || git -C "$AP" submodule update --init --depth 1 "$m"
done

# ---- patches and the overlay (new files), applied whenever they change ----
mkdir -p "$BUILD"
stamp="$( (cat "$HERE"/patches/*.patch 2>/dev/null; find "$HERE/overlay" -type f -print0 | sort -z | xargs -0 cat) | sha256sum | cut -c1-16)"
if [ "$(cat "$BUILD/ap-stamp" 2>/dev/null)" != "$stamp" ]; then
    echo "== applying firmware/apwasm patches and overlay"
    git -C "$AP" checkout -q -- .
    git -C "$AP" clean -fdq -e /build
    for p in "$HERE"/patches/*.patch; do [ -e "$p" ] && git -C "$AP" apply --whitespace=nowarn "$p"; done
    cp -a "$HERE/overlay/." "$AP/"
    echo "$stamp" > "$BUILD/ap-stamp"
fi

# ---- Python build dependencies (waf generates the MAVLink and DroneCAN headers with them) ----
VENV="$BUILD/apvenv"
if [ ! -x "$VENV/bin/python" ]; then
    echo "== Python environment for the ArduPilot build"
    python3 -m venv "$VENV"
    "$VENV/bin/pip" install -q empy==3.3.4 future pexpect lxml packaging setuptools
fi
export PATH="$VENV/bin:$PATH"

# ---- the pinned Emscripten SDK ----
EMSDK="$BUILD/emsdk"
if [ ! -x "$EMSDK/upstream/emscripten/emcc" ] || ! grep -q "$EMSDK_VERSION" "$EMSDK/.emsdk_version" 2>/dev/null; then
    echo "== Emscripten SDK $EMSDK_VERSION"
    [ -d "$EMSDK/.git" ] || git clone --depth 1 https://github.com/emscripten-core/emsdk.git "$EMSDK"
    (cd "$EMSDK" && ./emsdk install "$EMSDK_VERSION" && ./emsdk activate "$EMSDK_VERSION" >/dev/null)
    echo "$EMSDK_VERSION" > "$EMSDK/.emsdk_version"
fi
# shellcheck disable=SC1091
source "$EMSDK/emsdk_env.sh" >/dev/null 2>&1

# ---- configure (once) and build ----
# (waf re-runs its configure step by itself when its scripts change: it must find Emscripten then too)
export CC=emcc CXX=em++ AR=emar
cd "$AP"
if ! grep -q "COMPILER_CXX = .clang++." "$OUT/c4che/wasm_cache.py" 2>/dev/null; then
    echo "== configuring the wasm board"
    ./waf configure --board wasm --out="$OUT" --disable-networking
fi
targets=()
case "$what" in
    plane) targets=(plane) ;;
    copter) targets=(copter) ;;
    all) targets=(plane copter) ;;
    *) echo "usage: build.sh [all|plane|copter|clean]" >&2; exit 2 ;;
esac
mkdir -p "$REPO/public/ap"
for t in "${targets[@]}"; do
    echo "== building Ardu$t"
    ./waf "$t" -j"$JOBS" ${WAF_ARGS:-}
    bin="$OUT/wasm/bin/ardu$t"
    cp "$bin.mjs" "$REPO/public/ap/ardu$t.mjs"
    cp "$bin.wasm" "$REPO/public/ap/ardu$t.wasm"
    ls -l "$REPO/public/ap/ardu$t".*
done
