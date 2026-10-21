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

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

if [ ! -d firmware/betaflight/src ]; then
    echo "== cloning betaflight 4.5.5 into firmware/betaflight"
    git clone --depth 1 --branch 4.5.5 https://github.com/betaflight/betaflight.git firmware/betaflight
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
    bash firmware/bfwasm/build.sh
