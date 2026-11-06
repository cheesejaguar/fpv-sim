# Real-world maps from open data

fpv-sim can fly real places built from public data. The first one is **Cascadia Coast: Thomas
Creek** (`public/maps/community/cascadia/`): a 1.6 km square of the southern Oregon coast in the
Samuel H. Boardman State Scenic Corridor. It has 60 m headland cliffs, 35 sea stacks, a Sitka
spruce forest and the Thomas Creek Bridge, Oregon's highest, 105 m over the creek.

`scripts/build-cascadia-map.mjs` builds it end to end. The script is the template for other
places.

```bash
node scripts/build-cascadia-map.mjs            # fetch (cached in node_modules/.cache/cascadia/) and build
node scripts/build-cascadia-map.mjs --offline  # rebuild from the cache only
npm run map:index && npm run map:validate -- public/maps/community/cascadia
```

## The pipeline

| Step | Data | How |
|---|---|---|
| Terrain | USGS 3DEP 1 m lidar DEM (public domain) | The USGS image service resamples it into a transverse Mercator grid centred on the map (scale 1, so x / y are true metres east / north, and grid north is true north). The DEM is fetched as raw float32 (`format=bsq`) and written as a 1025 px 16-bit heightfield, about 1.56 m per sample. |
| Ground photo | USDA NAIP 0.6 m aerial imagery (public domain) | Fetched from the same service in the same grid as a 2048 px JPEG, used as the ground `drape`. |
| Land, sea, sea stacks | OpenStreetMap coastline and islands | The coastline (land on its left) is closed far inland and filled. Islands give the stack footprints. |
| Missing stacks | NAIP 4-band | The lidar flattens water and drops most small stacks. Compact patches of rock-coloured pixels offshore become stacks, with heights from their size and steep sides. |
| Sea floor, beach | modelled | Lidar stops at the water and returns wave noise. Off the coastline the ground is a beach that shelves gently where the photo shows sand, then a sea floor that shelves away to 14 m. |
| Forest | NAIP NDVI and canopy darkness | Trees are placed every ~9.5 m on the forest the photo shows. They are kept off roads, the bridge and spawns, and are tall inland but stunted at the cliff edge. |
| Bridge | OSM's bridge line, published dimensions | A steel Warren deck truss on two towers, made of about 400 box primitives. Its deck meets the road's height at each end. |
| Spawns | from the terrain | Each spawn stands on a level 1.2 m launch pad, because lidar ground is rarely level enough to arm on. |

## Format features it uses

These features are not specific to Cascadia; any map package can use them ([MAP_FORMAT.md](MAP_FORMAT.md)):

- `ground.drape`: an aerial photo over the terrain, with the ground texture adding grain up close
  and rock on steep faces;
- `water`: a sea that is drawn with depth colour, surf and swell, and that a drone crashes into;
- `geo`: the real GPS origin, so ArduPilot missions and the API report true positions;
- a forest budget of 20 000 trees, and a terrain mesh as fine as the heightfield (up to 800 quads
  across).

## Building another place

Copy the script and change the centre (`LAT0`, `LON0`), the half extent `E` and the playable
`SIZE` (at most `E / 1.1`, so that the drawn terrain stays on the data). Then replace the
Cascadia parts: the bridge, the named spawns and the mission. Check these things:

- **Coverage.** 3DEP lidar covers most of the US; elsewhere the service falls back to 10 or 30 m
  data. NAIP is US-only. For other countries use your national mapping agency's open lidar and
  orthophotos, or Copernicus GLO-30 and Sentinel-2 at much coarser resolution.
- **Licences.** Keep the package under a licence the repository accepts and credit every source
  in `ATTRIBUTION.md`. OpenStreetMap data is ODbL: use only an insubstantial extract (the OSMF
  guideline is under ~100 features), or the map must be ODbL too.
- **Budgets.** The heightfield can be at most 1025 px and the drape 2048 px. Keep `map.json`
  under 2 MiB, which fits about 20 000 trees, and the package under 16 MiB.
- **Datum.** 3DEP heights are NAVD88. Set `water.level` to where the lidar's water surface lies
  (about 0 here), not to a tide datum.

Respect local rules if you visit the real place. Oregon State Parks restricts drone take-off and
landing in many parks.
