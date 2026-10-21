# Contributing

Thanks for helping. Issues and pull requests are welcome on
[github.com/cheesejaguar/fpv-sim](https://github.com/cheesejaguar/fpv-sim). Before you open a pull
request:

```bash
npm ci
npx tsc --noEmit
npm test
npm run build
```

By contributing, you agree that your contribution is distributed under the project's licence,
GPL-3.0-or-later. The exception is assets in a map package, which keep the licence you declare
for them (see below).

## Contributing a map

Maps are data, not code. You add one folder, `public/maps/community/<your-map-id>/`, and the map
appears in **Simulation → Map** after the merge. You do not touch any TypeScript. The format is
documented in [docs/MAP_FORMAT.md](docs/MAP_FORMAT.md).

1. **Start from the example.** Copy `public/maps/community/quarry-loop/` to
   `public/maps/community/<id>/`. The `<id>` is 2 to 24 characters of `a-z 0-9 -`. Set `meta.id`
   to the same id, and set your own name, author, licence and version (`1.0.0`).
2. **Build it and fly it locally.** In the app, go to **Simulation → World → Load map folder…**
   and pick your folder, or drop a `.zip` of it onto the box. Errors appear right there. Load it
   again after every edit. This works in the deployed app at https://fpv-sim-gamma.vercel.app as
   well as in `npm run dev`. The files never leave your browser.
3. **Validate.**

   ```bash
   npm run map:validate -- public/maps/community/<id>
   npm run map:index        # adds your map to public/maps/community/index.json
   npm test
   ```

   The validator checks the JSON Schema, every structural rule, the size budgets, the licence
   files and the asset formats, and that the map builds. It prints the primitive, brush and
   triangle counts against their budgets. Commit the regenerated `index.json` with your map. CI
   fails if it is out of date.
4. **Write `ATTRIBUTION.md`.** List who made the map. For each asset you did not make yourself,
   give its source URL, author and licence, and say what you changed. Add `LICENSE.txt` with the
   full licence text if your licence requires it (MIT, BSD, ISC, Zlib, Apache, GPL, LGPL).
5. **Open a pull request** with the map template. Add `?template=map.md` to the compare URL, or
   copy the checklist from
   [.github/PULL_REQUEST_TEMPLATE/map.md](.github/PULL_REQUEST_TEMPLATE/map.md). Include a
   screenshot from the simulator. The **Maps** workflow runs the validator and the tests on your
   pull request.

### Licence rules (please read)

fpv-sim is GPL-3.0-or-later and is published on the open web, so every file in a map package must
be **freely redistributable and modifiable**.

| OK | Not OK |
|---|---|
| Your own work, under any licence below | Anything ripped from a commercial game: models, textures, sounds, levels, WAD/PAK/BSP contents, tracks from other drone simulators |
| CC0-1.0, CC-BY-3.0/4.0, CC-BY-SA-4.0 | CC-BY-**NC**, CC-BY-**ND**, "free for personal / non-commercial use" |
| MIT, BSD-2/3-Clause, ISC, Zlib, Apache-2.0, Unlicense | "All rights reserved", no licence stated, "found it on the internet" |
| GPL-2.0-or-later, GPL-3.0(-or-later), LGPL-2.1/3.0-or-later | Assets whose licence forbids redistribution or modification |
| Freedoom, LibreQuake and other free game-asset projects, with attribution | Store assets (Sketchfab "Standard", Unity / Unreal marketplaces, TurboSquid, ...) unless they are explicitly CC- or OSI-licensed |
| Real places and race tracks recreated from your own measurements or open data (e.g. OpenStreetMap, ODbL: credit it) | Logos and trademarks used as decoration |

- Put the package's licence in `meta.license` as an SPDX id, or an expression such as
  `CC-BY-4.0 AND MIT`.
- If you mix licences, say in `ATTRIBUTION.md` which file uses which.
- For CC-BY and CC-BY-SA, the attribution in `ATTRIBUTION.md` and the in-app credit (author and
  licence) satisfy the attribution requirement.
- If you are unsure about an asset, leave it out and ask in the pull request.
- Maintainers may remove a map if its licence turns out to be wrong.

### Budgets

The web build must stay fast for everyone, so packages have hard limits:

- 16 MiB per package.
- 5 000 primitives.
- 20 000 collision triangles.
- 150 000 drawn triangles.
- Textures up to 1024 px.

All the limits are listed in [docs/MAP_FORMAT.md](docs/MAP_FORMAT.md#budgets), and the validator
reports each number. Smaller is better: most good freestyle maps fit in well under 2 MiB.

### Updating a map

Bump `meta.version`, keep `meta.id`, and update `ATTRIBUTION.md`. Agree any change to someone
else's map with its author (mention them in the pull request).
