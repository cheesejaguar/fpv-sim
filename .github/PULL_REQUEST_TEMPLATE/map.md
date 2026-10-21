<!-- Map pull request. Format: docs/MAP_FORMAT.md. Guide: CONTRIBUTING.md#contributing-a-map -->

## Map

- **Name / id:** <!-- e.g. Quarry Loop / quarry-loop -->
- **Author(s):**
- **Licence (SPDX):** <!-- e.g. CC-BY-4.0 -->
- **Kind:** <!-- race (gates) / freestyle / both -->
- **Description:**

## Screenshot

<!-- Required: at least one in-simulator screenshot (FPV or chase view). -->

## Checklist

### Licence and attribution
- [ ] The licence is one of the accepted ones listed in CONTRIBUTING.md (CC0, CC-BY, CC-BY-SA-4.0, MIT, BSD, ISC, Zlib, Apache-2.0, GPL / LGPL). It is compatible with distribution alongside a GPL-3.0-or-later program, and it is **not** NonCommercial or NoDerivatives.
- [ ] I made every asset myself, or each third-party asset is freely licensed and credited.
- [ ] **No copyrighted game assets**: nothing ripped from commercial games or other simulators (models, textures, sounds, levels, WAD / PAK / BSP contents).
- [ ] `ATTRIBUTION.md` lists the author(s). For every third-party asset it gives the source URL, author, licence and changes.
- [ ] `LICENSE.txt` is included if the licence requires its text (MIT / BSD / ISC / Zlib / Apache / GPL / LGPL).

### Package
- [ ] Everything is in `public/maps/community/<id>/`, and the folder name equals `meta.id`.
- [ ] `npm run map:validate -- public/maps/community/<id>` passes with no errors (paste the summary below).
- [ ] `npm run map:index` was run, and `public/maps/community/index.json` is committed.
- [ ] It is within the budgets: package <= 16 MiB, <= 5 000 primitives, <= 20 000 collision triangles, textures <= 1024 px.
- [ ] There are no unreferenced or unrelated files (no `.blend` sources, no `.zip`s).
- [ ] Nothing outside the map folder and `index.json` is changed (other changes go in a separate pull request).

### Tested
- [ ] I loaded the map in the app (Simulation → World → Load map folder…) and flew it. The spawn is on the ground, the gates (if any) count laps in order, and nothing is invisible but solid, or the reverse.
- [ ] `npm test` passes.

```
<!-- validator output summary -->
```
