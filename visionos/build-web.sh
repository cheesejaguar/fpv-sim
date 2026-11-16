#!/usr/bin/env bash
# Builds the simulator core (the web app: Betaflight / ArduPilot WebAssembly, physics, menus) and
# copies it into visionos/WebBundle/, which the Xcode project packs into the app. Run it once before
# the first Xcode build, and again whenever src/ changes.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/.." && pwd)"
cd "$repo"
[ -d node_modules ] || npm ci
npm run build
out="$here/WebBundle"
mkdir -p "$out"
# everything the page loads; no JavaScript source maps (Quake's *.map level sources stay), no website-only files
find "$out" -mindepth 1 ! -name '.gitkeep' -delete
cp -R dist/. "$out/"
find "$out" \( -name '*.js.map' -o -name '*.css.map' -o -name '*.mjs.map' \) -delete
( cd "$out" && rm -f share.html sitemap.xml robots.txt og.png privacy.html )
echo "WebBundle: $(du -sh "$out" | cut -f1) in $out"
