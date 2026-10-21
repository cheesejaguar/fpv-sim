#!/usr/bin/env bash
# Build the real Betaflight 4.5.5 firmware as a WebAssembly module.
#
#   bash scripts/build-firmware.sh          # from Git Bash, WSL or Linux/macOS
#
# Output: public/bf/betaflight.mjs + public/bf/betaflight.wasm
# Requires Docker. The compiler is pinned to the emscripten/emsdk image below.
#
# PowerShell equivalent (from the repository root):
#   docker run --rm -v "${PWD}:/src" -w /src emscripten/emsdk:4.0.10 bash firmware/bfwasm/build.sh
set -euo pipefail

EMSDK_IMAGE="${EMSDK_IMAGE:-emscripten/emsdk:4.0.10}"

# Betaflight is pinned by commit, not only by tag: the patches and the WASM
# hardware layer are written against exactly this tree.
BF_REPO="https://github.com/betaflight/betaflight.git"
BF_TAG="4.5.5"
BF_SHA="4adbd3ef7cb546947600e5f747bd5453c9573063"

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

if [ ! -d firmware/betaflight/src ]; then
    echo "== cloning betaflight $BF_TAG ($BF_SHA) into firmware/betaflight"
    git clone --depth 1 --branch "$BF_TAG" "$BF_REPO" firmware/betaflight
fi
bf_head="$(git -C firmware/betaflight rev-parse HEAD 2>/dev/null || echo none)"
if [ "$bf_head" != "$BF_SHA" ]; then
    # the tag moved upstream, or an old checkout: fetch the pinned commit itself
    echo "== firmware/betaflight is at $bf_head, fetching the pinned $BF_SHA"
    if git -C firmware/betaflight fetch --depth 1 origin "$BF_SHA"; then
        git -C firmware/betaflight checkout -q --detach "$BF_SHA" || true
    fi
    bf_head="$(git -C firmware/betaflight rev-parse HEAD 2>/dev/null || echo none)"
fi
if [ "$bf_head" != "$BF_SHA" ]; then
    echo "error: firmware/betaflight is at $bf_head, expected Betaflight $BF_TAG = $BF_SHA." >&2
    echo "  Fix: delete firmware/betaflight and run bash scripts/build-firmware.sh again." >&2
    exit 1
fi

# Docker needs a host path it understands for the bind mount.
if command -v cygpath >/dev/null 2>&1; then
    # Git Bash / MSYS on Windows: hand Docker a Windows path, and stop MSYS
    # from rewriting the container-side paths.
    MOUNT_SRC="$(cygpath -w "$REPO")"
    export MSYS_NO_PATHCONV=1
else
    MOUNT_SRC="$REPO"
fi

TTY_FLAGS=()
if [ -t 1 ]; then
    TTY_FLAGS=(-t)
fi

docker run --rm "${TTY_FLAGS[@]}" \
    -e JOBS="${JOBS:-}" \
    -v "$MOUNT_SRC:/src" -w /src \
    "$EMSDK_IMAGE" \
    bash firmware/bfwasm/build.sh "$BF_SHA"
