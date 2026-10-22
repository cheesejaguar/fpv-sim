# Quake maps: sources, licenses, attribution

The simulator's Quake maps are built in the browser from id Software's original level sources by
`src/maps/quakeMap.ts`. No original Quake textures, BSP files, models or sounds are used or
distributed.

This project is not affiliated with or endorsed by id Software, ZeniMax / Bethesda, John Romero,
or the LibreQuake, Freedoom or Blasphemer projects. "Quake" is a trademark of its owner. It is
used here only to identify where the level layouts come from.

## Level geometry: GNU GPL

| File | Level | Origin |
|---|---|---|
| `e1m1.map` | E1M1 "The Slipgate Complex" | `E1M1.MAP`, unmodified |
| `dm3.map` | DM3 "The Abandoned Base" | `DM3.MAP`, unmodified |

- Copyright © 1996 id Software. John Romero released the original Quake map sources in October
  2006, for Quake's 10th anniversary. The release's readme states that they "are released under
  the terms of the GPL".
- Source archive: <https://rome.ro/s/1996-quake-map-sources.zip>, linked from
  <https://rome.ro/resources>. These files are byte-identical to the copies in
  <https://github.com/fzwoch/quake_map_source>.
- The release's own readme is included as `release_readme.txt`. The license text that came with
  it is included as `COPYING-GPL-2.0.txt` (GPL version 2, the archive's `gnu.txt`).
- The release names no GPL version, so any version may be chosen (GPL v2 §9). That makes the
  sources compatible with this project's GPL-3.0-or-later license.
- The simulator's changes happen at load time and leave the files themselves unchanged:
  - doors, triggers and secret doors are removed;
  - tool and sky brushes are not drawn;
  - liquids are not solid;
  - geometry is scaled to 1/32 m per Quake unit.

## Textures: LibreQuake, BSD-3-Clause

- Every texture in `textures/` comes from the LibreQuake project
  (<https://github.com/lavenderdotpet/LibreQuake>, `texture-wads/`, commit `dd4d5bf`). The pixels
  are unmodified; the files are losslessly re-encoded as palette PNGs (`scripts/optimize-png.mjs`),
  which drops editor metadata.
  - Copyright © 2019-2023 Contributors to the LibreQuake project.
  - Licensed under the BSD 3-Clause license: see `textures/LICENSE-LibreQuake.txt`.
  - Contributors are listed in `textures/CREDITS-LibreQuake.txt`.
- Some LibreQuake textures derive from the Freedoom and Blasphemer projects. Their BSD-3-Clause
  notices are included as `textures/LICENSE-Freedoom.adoc` and `textures/LICENSE-Blasphemer.md`.
- The id texture names in the .map files are substitutes, not originals. Each name is mapped to a
  LibreQuake texture chosen for the same role (wall, floor, light, trim):
  - `textures/manifest.json` records each choice and the image size;
  - `scripts/vendor-quake.mjs` holds the mapping table.
  - The originals' appearance is not reproduced.

## Regenerating

```bash
node scripts/vendor-quake.mjs <unzipped rome.ro archive> <LibreQuake checkout>
```
