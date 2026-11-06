# Cascadia Coast: Thomas Creek (map "cascadia")

A 1.6 km square of the southern Oregon coast in the Samuel H. Boardman State Scenic Corridor,
Curry County, Oregon, USA, centred on 42.1700 N, 124.3625 W: Thomas Point, its sea stacks and the
Thomas Creek Bridge on US 101. Built by `scripts/build-cascadia-map.mjs` (run it again to rebuild;
the downloads are cached).

## Data and licences

The package is licensed under **CC BY 4.0** (https://creativecommons.org/licenses/by/4.0/):
credit "fpv-sim contributors; USGS 3DEP; USDA NAIP; © OpenStreetMap contributors". The USGS and
USDA data are in the US public domain. The OpenStreetMap data (41 features: the coastline,
the islands, roads and the bridge's line) is © OpenStreetMap contributors under the ODbL 1.0; it
is an insubstantial extract under the OpenStreetMap Foundation's Substantial Guideline
(https://osmfoundation.org/wiki/Licence/Community_Guidelines/Substantial_-_Guideline), used here
to make this map (a Produced Work), and is credited as the ODbL asks.

| Data | Used for | Source | Licence |
|---|---|---|---|
| `heightfield.png` | terrain | USGS 3D Elevation Program (3DEP) bare-earth DEM from 1 m lidar, via the USGS National Map elevation service | public domain (US Government work) |
| `drape.jpg`, forest and rock classification | ground photo, where trees and rocks are | USDA Farm Service Agency, National Agriculture Imagery Program (NAIP), 0.6 m 4-band, via the USGS National Map imagery service | public domain (US Government work) |
| coastline, 23 mapped sea stacks, roads, the bridge's line | land and sea, stack footprints, keeping trees off roads, placing the bridge | © OpenStreetMap contributors, https://www.openstreetmap.org/copyright | ODbL 1.0 (insubstantial extract, credited) |

The map layout, the bridge model, the sea floor, the derived stack heights and the tree placement
are by the fpv-sim contributors.

## What is real and what is modelled

- **Real:** the land's shape (1 m lidar, sampled every 1.56 m), the coastline, the photo, where
  the forest grows, the bridge's position, length, height and spans.
- **Modelled:** the sea floor (the lidar stops at the water; here the bottom shelves about 3.5 cm
  per metre from the shore, to 14 m). Sea stacks the lidar did not keep (35 stacks in all)
  are raised from their mapped or photographed footprint, 4 to 30 m high by size. The 9607
  trees are procedural conifers on the photo's forest, taller inland (to ~42 m) and wind-stunted
  at the cliffs; their heights are not measured. The bridge is a simplified steel Warren deck truss
  on two towers: its member sizes, panel length and tower layout are approximations.
- The water level is 0.5 m above the lidar's datum (NAVD88). Heights in the map are metres above
  that datum.

Not affiliated with or endorsed by the USGS, the USDA, Oregon Parks and Recreation or the
OpenStreetMap Foundation. Respect local rules if you fly the real place: Oregon State Parks
restricts drone take-off and landing in many parks.
