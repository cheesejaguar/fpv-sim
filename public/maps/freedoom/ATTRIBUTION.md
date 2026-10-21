# Freedoom MAP01: Hydroelectric Plant

The level geometry and textures in this folder come from **Freedoom**
(https://freedoom.github.io/), Phase 2, level MAP01 "Hydroelectric Plant".

- Source: Freedoom 0.13.0 release, `freedoom2.wad` (SHA-256 `a8772e088847032510d97ba2312406a6998f21cbab44d4ff10696faa9c0ecd4b`), from
  https://github.com/freedoom/freedoom/releases/tag/v0.13.0
- Copyright © 2001-2024 Contributors to the Freedoom project. All rights reserved.
- License: BSD-3-Clause. The full text is in [COPYING.txt](COPYING.txt).
- The Freedoom contributors are listed in [CREDITS.txt](CREDITS.txt).

## What is included

- `map01.json`: the level's THINGS, LINEDEFS, SIDEDEFS, VERTEXES, SECTORS lumps, unmodified, base64-encoded.
- `textures/`: the 51 wall textures and 28 flats this level uses. They
  were converted to PNG through Freedoom's PLAYPAL palette. Wall textures are composited from their patches
  as defined in TEXTURE1 / PNAMES. Pixels are otherwise unmodified.

At load time the simulator changes the level as follows:
- It opens doors and scales the geometry to metres.
- It ignores monsters, items and line specials.

## Not included

No original id Software Doom / Doom II data (IWADs, textures, sprites, sounds or levels) is used.

## No endorsement

This project is not affiliated with or endorsed by the Freedoom project or its contributors. Under the
BSD-3-Clause license, the Freedoom name and its contributors' names may not be used to endorse or promote
this project.

Regenerate this folder with `node scripts/vendor-freedoom.mjs <freedoom-0.13.0-dir>`.
