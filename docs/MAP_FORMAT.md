# fpvsim-map v1: the map format

fpv-sim maps are **map packages**: a folder with a `map.json` and the assets it uses. The format
is declarative JSON: no code. You can try a package in the app straight from your disk, and you
can contribute it to the repository with a pull request. After it is merged it appears in
**Simulation → Map** with no code changes.

- JSON Schema: [`schemas/map.v1.schema.json`](../schemas/map.v1.schema.json). Add
  `"$schema": "../../../../schemas/map.v1.schema.json"` to your `map.json` and VS Code (and other
  editors) will autocomplete and check it as you type.
- Loader and validator: [`src/maps/mapFormat.ts`](../src/maps/mapFormat.ts). The physics worker and
  the renderer both build the map from it, so collision and graphics always agree.
- Validator CLI: `npm run map:validate -- <package folder or .zip>`.
- Example package: [`public/maps/community/quarry-loop/`](../public/maps/community/quarry-loop/)
  (CC0). It uses a heightfield, gates, primitives, a texture, a glTF mesh with collision, trees,
  fog and a wake zone. Copy it to start your own map.
- Reference port: [`public/maps/bando/`](../public/maps/bando/) is the built-in Bando map in this
  format. The test suite checks that it matches the original procedural TypeScript map.

To contribute a map, see [Contributing a map](../CONTRIBUTING.md#contributing-a-map).

## Package layout

```
public/maps/community/<id>/
  map.json            the map (required)
  ATTRIBUTION.md      who made the map and every asset in it, sources, licences (required)
  LICENSE.txt         full licence text (required for MIT / BSD / Apache / GPL / ISC / Zlib)
  preview.jpg         optional, 16:9, 640 x 360 recommended
  heightfield.png     ... any assets map.json references, in any subfolders
  textures/*.png
  *.glb
```

- `<id>` is the folder name and must equal `meta.id`: 2 to 24 characters of `a-z`, `0-9` and `-`.
- Paths in `map.json` are **relative to the package folder**: forward slashes, no `..`, no URLs,
  only `A-Z a-z 0-9 . _ - /`. A map can never load files from outside its package. The one
  exception is the built-in LibreQuake texture set for Quake geometry (see below).
- Allowed file types: `.json .png .jpg .jpeg .webp .glb .map .md .txt`. Game archives (`.wad
  .pak .pk3 .bsp .mdl`), scripts and HTML are rejected.
- The validator warns about files that `map.json` does not reference.

## Units and coordinates

- Lengths are in **metres**, angles in **degrees**, colours are `"#rrggbb"`.
- The frame is **ENU**: **x = east, y = north, z = up**. Positions are `[x, y, z]` arrays, and
  ground positions are `[x, y]`. The map is centred on the origin.
- The playable area is the square `|x|, |y| <= size`. The terrain mesh is drawn out to
  `2.2 x size`.
- `yawDeg` rotates an object counter-clockwise about +z (seen from above). For the **spawn**, the
  yaw is the drone's heading: 0 = facing east, 90 = facing north. A **gate** at yaw 0 spans
  east-west and you fly through it northwards.
- glTF meshes use glTF's own axes (+Y up, −Z forward). The loader converts them: glTF +X → east,
  −Z → north, +Y → up. This is the usual Blender glTF export ("+Y up") with Blender's −Y axis
  pointing north.

## map.json

```jsonc
{
  "$schema": "../../../../schemas/map.v1.schema.json",
  "format": "fpvsim-map",
  "formatVersion": 1,
  "meta": {
    "id": "quarry-loop",                 // = folder name
    "name": "Quarry Loop",               // <= 64 chars, shown in the map menu
    "author": "Your Name",               // <= 96 chars
    "license": "CC-BY-4.0",              // SPDX id or expression, see "Licences"
    "version": "1.0.0",                  // semantic version of the map; bump it when you change it
    "description": "…",                  // optional, <= 600 chars
    "preview": "preview.jpg",            // optional
    "tags": ["race"],                    // optional, <= 8 short tags
    "homepage": "https://…"              // optional
  },
  "units": "m", "frame": "ENU",           // optional; the only allowed values, for readers' benefit
  "size": 110,                           // half-extent of the playable area (m), <= 2000
  "elevationM": 310,                     // altitude above sea level: air density, barometer (default 0)
  "spawn": { "pos": [0, -34, 0.25], "yawDeg": 90, "groundZ": 0 }, // groundZ optional: floor height at the spawn
  "pilot": [-2, -36, 1.6],               // optional: where the pilot / video receiver stands
  "environment": {
    "sky": "clear",                      // clear | overcast | dusk
    "sun": { "azimuthDeg": 160, "elevationDeg": 42 },   // azimuth clockwise from north
    "fog": { "color": "#c9d3dc", "density": 0.003 },   // optional, exponential-squared, 1/m
    "windScale": 1                       // optional: multiplies the configured wind (indoor: 0.1-0.3)
  },
  "ground": { … },
  "primitives": [ … ],
  "gates": [ … ],
  "trees": [ … ],
  "wakeZones": [ … ],
  "indoor": [ … ],
  "geometry": [ … ]
}
```

Unknown properties are errors, so a typo like `"siz"` is caught. The validator suggests the
right name. Keys that start with `x-` are free for your own notes or tools, and so is `$comment`.

### ground

The terrain is a height function z(x, y). The drone collides with it and it is drawn as a mesh.
There are three types. All of them take `material` (`grass` | `dirt` | `concrete`, default
`grass`), `visible` (default `true`; `false` keeps the collision but does not draw the mesh) and
`texture` (an image that repeats every 3 m and replaces the material's texture).

**flat**: `{ "type": "flat", "z": 0 }`.

**heightfield**: a greyscale PNG.

```json
{ "type": "heightfield", "image": "heightfield.png", "extent": [240, 240], "center": [0, 0], "zMin": -1, "zMax": 15, "material": "dirt" }
```

- `extent` is the size in metres `[east-west, north-south]` and `center` is its centre (default
  `[0, 0]`). Pixel (0, 0) is the **north-west** corner. Columns run east and rows run south.
  Pixel centres sit on a regular grid from edge to edge, so a 129 px image over 240 m has a
  sample every 1.875 m. Heights are interpolated bilinearly, and the edge pixels extend outwards.
- Black is `zMin` and white is `zMax`. 8-bit gives 256 levels, and 16-bit greyscale gives
  smooth slopes. RGB(A) images use the red channel. Palette and interlaced PNGs are rejected.
- The image must be 2 to 1025 px per side.

**noise**: seeded procedural terrain. This is the same deterministic value-noise fBm the
built-in maps use, so every client gets exactly the same hills.

```json
{ "type": "noise", "base": 0, "material": "dirt", "layers": [
  { "scale": 60, "octaves": 3, "seed": 2, "amplitude": 6, "mask": { "shape": "square", "from": 80, "to": 140 } },
  { "scale": 8, "octaves": 2, "seed": 7, "amplitude": 0.04 }
] }
```

z = `base` + the sum over the layers of `mask × fbm(x / scale, y / scale, octaves, seed) ×
amplitude`. fbm is in roughly −1 to 1. `mask` (optional) fades a layer in from 0 at distance
`from` to 1 at `to`, measured from `center` (default origin). The `square` shape uses the
Chebyshev distance max(|dx|, |dy|) and `circle` uses the Euclidean distance. `invert: true` flips
the mask (hills in the middle). This is how you keep a flat flying field in the centre. Up to 8
layers, octaves 1 to 8, default 4.

Without a `ground`, the terrain is flat at z = 0, or it comes from the Quake / Doom geometry.

### primitives

These are analytic solids with exact collision: the fastest kind of geometry to collide with
and to draw.

```json
{ "type": "box", "pos": [18, 0, 0.6], "size": [1.2, 1.2, 1.2], "yawDeg": 10, "pitchDeg": 0, "material": "wood", "visual": "wood", "texture": "textures/hazard.png", "color": "#2a5bd7", "tag": "crate" }
{ "type": "cylinder", "pos": [40, 40, 0], "radius": 3, "height": 12, "material": "metal", "color": "#9aa3a8" }
{ "type": "sphere", "pos": [-8, 24, 0.4], "radius": 1.4, "material": "concrete", "color": "#8c8478" }
```

- **box**: `pos` is the centre and `size` is the full size `[x, y, z]` before rotation. The box
  turns by `yawDeg` about +z, then by `pitchDeg` about its own y axis (use pitch for ramps).
- **cylinder**: vertical. `pos` is the centre of its **base**.
- **sphere**: `pos` is the centre.
- `material` is the physics surface. It sets the bounce, friction and stiffness, and how much a
  prop strike damages the props: `grass dirt concrete metal wood foliage gate`. The default is
  `concrete` for boxes and spheres and `metal` for cylinders.
- `visual` (boxes only) picks the look: `concrete brick metal wood pad glass plain gate`, plus the
  stadium dressing `led` (self-lit strip in `color`), `banner` and `screen` (show `text`, up to 40
  characters, on both large faces), and `net` (see-through safety netting). The
  default is `concrete`. `plain` uses `color`. `texture` (boxes only) is an image that repeats
  every 2 m in world space and replaces the visual.
- `color` tints cylinders and spheres, and `plain` boxes.
- `tag` is a free label. `tank` gives a cylinder the riveted-metal look.

### gates

Race gates, listed in **lap order**. The lap timer counts them in this order.

```json
{ "kind": "square", "pos": [0, -14], "yawDeg": 0 }
{ "kind": "arch", "pos": [14, 30], "yawDeg": -50, "width": 3.0, "height": 2.6 }
{ "kind": "dive", "pos": [30, -14, 5] }
{ "kind": "flag", "pos": [34, 14], "yawDeg": 180 }
```

| kind | what | default width × height (m) |
|---|---|---|
| `square` | MultiGP square gate with a base plate | 1.524 × 1.524 (5 ft) |
| `arch` | the same frame without the plate, bigger | 3.0 × 2.6 |
| `dive` | a horizontal frame on four poles that you dive through; `pos` needs z (frame height) | 1.524 square |
| `flag` | a pole with a flag; fly around it | height 3.2 |
| `hurdle` | a wide, low opening under a banner | 3.6 × 1.8 |
| `ladder` | `stack` openings on top of each other (default 3); only the top one counts | 1.524 × 1.524 each |

Any gate may set `"onTop": true` to sit on the gate below it with no legs or bottom bar (e.g. a
split-S stack).

With a 2-element `pos` the gate stands on the terrain.

### trees, wakeZones, indoor

```json
{ "pos": [-55, 45], "height": 14, "radius": 3.5, "type": "oak" }
{ "pos": [40, 40], "radius": 8, "height": 14, "intensity": 1.0 }
{ "min": [-18, 9, 0], "max": [18, 31, 12], "windScale": 0.1 }
```

Trees are drawn instanced and collide as a trunk cylinder plus a solid core; the rest of the
canopy is a porous drag volume (a quad slows down inside it and its props get nicked).
A wake zone is an obstacle (building, silo, tree line): centre `pos`, footprint `radius` and
`height`. The wake is laid out downwind of it for the live wind direction: sheltered, more
turbulent air behind it (eddies about half the obstacle height), a downdraft on the lee side and
an updraft at the windward roof edge. `intensity` 1 is a typical building.
`indoor` boxes (`min` / `max` corners) are enclosed spaces in an outdoor map: the wind inside
is multiplied by `windScale` (default 0.1). For a fully indoor map use `environment.windScale`.

### geometry: external sources

```json
{ "type": "gltf", "src": "arch.glb", "pos": [0, 18, 0], "yawDeg": 0, "scale": 1, "collision": "mesh", "material": "concrete" }
{ "type": "quake", "src": "level.map", "scale": 0.03125, "ambient": 40, "spawnClass": "info_player_start", "textures": "builtin:librequake" }
{ "type": "doom", "src": "map01.json", "scale": 0.03125, "textures": "textures/manifest.json" }
```

**glTF meshes** (`.glb` only: binary glTF 2.0 with the buffers and images **embedded**).
Draco, meshopt and KTX2 compression are rejected, so export uncompressed. The renderer draws the
glTF materials as they are (PBR, textures, double-sided). The mesh is placed at `pos`, turned by
`yawDeg` about +z and scaled uniformly by `scale`. Collision rules:

| `collision` | what the drone collides with | use for |
|---|---|---|
| `mesh` (default) | every triangle, exactly. Each one becomes a thin convex slab, 5 cm thick behind its front face, in the same convex-brush collider as Quake brushes. Meshes do not need to be watertight or have consistent normals. Counts against the 20 000 collision-triangle budget. | structures you fly through, under or around: arches, bridges, ruins |
| `box` | one box: the mesh's bounding box in its own frame, turned with it | crates, vehicles, buildings you don't enter |
| `none` | nothing (visual only) | distant scenery, small detail; add a few primitives as simplified collision |

For a detailed visual mesh, keep collision cheap: use `collision: "none"` and add a few boxes or
cylinders around the parts that matter, or add the same mesh's low-poly version as a second
`gltf` entry with `collision: "mesh"`, hidden inside the detailed one.
Collision is computed from the glTF node hierarchy (matrices and TRS) of the default scene.
Only triangle-list primitives collide. Points, lines and strips are drawn only.

**Quake `.map`** brush sources and **Doom levels** as lump JSON (the format
`scripts/vendor-freedoom.mjs` produces) load through the same code as the built-in Quake and
Freedoom maps (`src/maps/quakeMap.ts`, `src/maps/doomMap.ts`): every brush and sector is an exact
convex collider, with baked lighting. The level is centred on the origin with its lowest floor at
z = 0, and 1 unit = 1/32 m by default. Spawn, pilot, sun, sky and wind scale come from the level
unless `map.json` sets them, and so does the ground (there is none). Anything else in `map.json`
(primitives, gates, trees) is added on top, so you can put a race course inside a Quake level.
Textures:

- `"textures": "builtin:librequake"` (the default for Quake) uses the LibreQuake (BSD-3-Clause)
  textures that ship with the simulator, by Quake texture name.
- Otherwise, give a manifest JSON in your package: `{ "<texture name>": { "file": "x.png", "w":
  64, "h": 64 } }`, with files relative to the manifest. For Doom levels the names are `w/NAME`
  for walls and `f/NAME` for flats.
- **The level and its textures must be freely licensed** (see Licences). The id Software `.map`
  sources are GPL, but the original Quake/Doom textures, models and WADs are not, and they are
  never accepted.

Only one `quake` or `doom` entry is allowed per map, and up to 16 geometry entries in total.

## Budgets

These keep the web build fast. A map that loads in the browser should not add seconds to anyone's
startup. The loader enforces them: a package over budget does not load and the validator reports
the numbers.

| | limit |
|---|---|
| `map.json` | 1 MiB |
| whole package | 16 MiB |
| any single file | 8 MiB |
| `size` (half-extent) | 2000 m |
| primitives (including the 3-8 parts each gate generates) | 5 000 |
| gates / trees / wake zones / indoor boxes / geometry entries | 64 / 3 000 / 32 / 32 / 16 |
| convex brushes (Quake / Doom geometry + mesh collision) | 20 000 |
| glTF triangles drawn, all meshes | 150 000 |
| glTF triangles with `collision: "mesh"` | 20 000 |
| texture images (`texture` fields, glTF images): size, file | 1024 × 1024 px, 1 MiB |
| heightfield | 2 to 1025 px per side |
| preview image | 512 KiB |

Tips: power-of-two textures (256, 512, 1024) mipmap best. JPEG suits photos and PNG suits sharp
edges. A 129 or 257 px heightfield is plenty for most maps. Boxes are much cheaper than mesh
triangles.

## Licences

The repository is GPL-3.0-or-later, and everything in it must be distributable under compatible
terms. `meta.license` is an [SPDX](https://spdx.org/licenses/) id, or an expression like
`CC-BY-4.0 AND MIT` when different assets use different licences. Accepted:

`CC0-1.0`, `CC-BY-3.0`, `CC-BY-4.0`, `CC-BY-SA-4.0`, `Unlicense`, `MIT`, `BSD-2-Clause`,
`BSD-3-Clause`, `ISC`, `Zlib`, `Apache-2.0`, `GPL-2.0-or-later`, `GPL-3.0-only`,
`GPL-3.0-or-later`, `LGPL-2.1-or-later`, `LGPL-3.0-or-later`.

**Not accepted:**

- NonCommercial (`-NC`) or NoDerivatives (`-ND`) licences.
- "Free for personal use", "all rights reserved", or no licence at all.
- **Any asset taken from a commercial game.** This covers ripped models, textures, sounds and
  levels: Quake/Doom/Half-Life WAD or PAK contents, Liftoff/Velocidrone/DRL tracks, anything from
  a game's install folder. It applies even when the game's own maps are "free to download". A map
  that *recreates* a real place or a real-world race track from your own measurements is fine.

Every package needs an `ATTRIBUTION.md` that lists the author(s) of the map and, for each asset
you did not make yourself, its source URL, author and licence. The licences above that require
their text to travel with the files (MIT, BSD, ISC, Zlib, Apache, GPL, LGPL) also need a
`LICENSE.txt` in the package. CC licences only need the link in `ATTRIBUTION.md`.

## Trying a map locally

1. Make a folder with `map.json` (start from a copy of `quarry-loop`).
2. In the app, open the menu, go to **Simulation**, then **World**, and use **Load map (.zip /
   files)…** or **Load map folder…**. You can also drop a `.zip` or the folder onto the box. The
   package is validated and you see every error. If it is valid, it is selected and you can fly
   it right away. Nothing is uploaded: the files stay in your browser.
3. Edit, then load it again: the selected map rebuilds in place. Maps loaded from disk are listed
   as "from disk", are not shared with multiplayer rooms, and are gone after a page reload.
4. Before opening a pull request, run the same checks the CI runs:

```bash
npm run map:validate -- path/to/my-map
```

Use `--local` to skip the repository rules (licence files, folder name) while you iterate.

## Versioning

`formatVersion` is the format's major version. Within v1, new optional properties may be added,
and older simulators reject maps that use them, because unknown keys are errors. Breaking changes
bump the version, and the simulator then supports both versions. `meta.version` is your map's own
version.
