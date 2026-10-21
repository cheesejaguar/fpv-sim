#!/usr/bin/env bash
# Inner build: runs inside the emscripten/emsdk container with the repository
# mounted at the current directory. Invoked by scripts/build-firmware.sh.
#
#  1. copy firmware/betaflight (pristine upstream 4.5.5) -> firmware/build/betaflight
#  2. apply firmware/bfwasm/patches/*.patch to the copy
#  3. make -C firmware/bfwasm  -> public/bf/betaflight.{mjs,wasm}
set -euo pipefail

REPO="$(pwd)"
UPSTREAM="$REPO/firmware/betaflight"
BFWASM="$REPO/firmware/bfwasm"
BUILD="$REPO/firmware/build"
BF="$BUILD/betaflight"

if [ ! -f "$UPSTREAM/src/main/fc/init.c" ]; then
    echo "error: $UPSTREAM is missing; clone betaflight 4.5.5 there first:" >&2
    echo "  git clone --depth 1 --branch 4.5.5 https://github.com/betaflight/betaflight.git firmware/betaflight" >&2
    exit 1
fi

# Stamp: upstream revision + patch contents. Re-copy only when it changes so
# incremental builds stay incremental.
upstream_rev="$(git -C "$UPSTREAM" rev-parse HEAD 2>/dev/null || echo unknown)"
stamp="$( { echo "$upstream_rev"; cat "$BFWASM"/patches/*.patch; } | sha256sum | cut -d' ' -f1)"

if [ ! -f "$BF/.bfwasm-stamp" ] || [ "$(cat "$BF/.bfwasm-stamp")" != "$stamp" ]; then
    echo "== preparing patched Betaflight tree in firmware/build/betaflight"
    rm -rf "$BF" "$BUILD/obj"
    mkdir -p "$BF/lib/main"
    cp -a "$UPSTREAM/mk" "$BF/mk"
    mkdir -p "$BF/src"
    cp -a "$UPSTREAM/src/main" "$BF/src/main"
    cp -a "$UPSTREAM/lib/main/MAVLink" "$BF/lib/main/MAVLink"
    cp -a "$UPSTREAM/lib/main/google" "$BF/lib/main/google"
    for p in "$BFWASM"/patches/*.patch; do
        echo "   patch $(basename "$p")"
        patch -s -p1 -d "$BF" < "$p"
    done
    echo "$stamp" > "$BF/.bfwasm-stamp"
fi

JOBS="${JOBS:-$(nproc)}"
echo "== emcc $(emcc --version | head -1)"
make -C "$BFWASM" -j"$JOBS" BF="$BF" OBJ="$BUILD/obj" OUT="$REPO/public/bf"
