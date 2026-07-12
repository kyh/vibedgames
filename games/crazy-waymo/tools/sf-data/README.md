# SF street-map pipeline

Turns the **real San Francisco street network** (OpenStreetMap) into the game's
road grid, so the map matches the actual streets of SF instead of a procedurally
generated lattice.

The coastline, hills and neighborhoods in `src/world/sf-map.ts` were already
traced from real geography. This pipeline replaces the one remaining synthetic
piece — the street layout — with real data, aligned to that same geography.

## How it works

```
fetch-streets.sh   →  sf-streets.raw.json      (real OSM streets, ~15 MB, gitignored)
calibrate.mjs      →  the lon/lat → (u,v) projection, fitted to the game's hills
rasterize.mjs      →  src/world/sf-streets.ts   (baked road mask the game loads)
```

1. **`fetch-streets.sh`** — pulls every drivable `highway=*` way inside the SF
   peninsula bbox from the Overpass API.
2. **`calibrate.mjs`** — recovers the exact linear `lon/lat → (u,v)` map the game
   already uses, by least-squares fitting against 12 hill summits whose `(u,v)`
   are hand-placed in `sf-map.ts` (fit is R² ≈ 0.999). This guarantees the
   streets line up with the existing coastline, hills and districts.
3. **`rasterize.mjs`** — projects each street polyline into `(u,v)`, supercover-
   rasterizes it onto the grid, then **thins** the residential grid (arterials
   are always kept; a connectivity-preserving pass opens building blocks so the
   city isn't wall-to-wall asphalt). Emits `src/world/sf-streets.ts`.

## Production bake (`bake-network.mts`)

`rasterize.mjs` above is the exploratory raster-only path. The shipped world is
baked by **`bake-network.mts`** (`pnpm bake:map`, runs under vite-node), which
builds the VECTOR network (`sf-network.ts`) and derives the raster mask
(`sf-streets.ts`) from the SAME polylines. Car-free-park clipping lives here —
park-interior street sections are cut from the vectors and the mask is
rasterized from the result, so the two can't disagree (the runtime carries no
park filter). Both files get a shared `*_GEN_ID` stamp proving they came from one
run; `pnpm test` asserts it. It also emits `PARK_PATH_MASK` (the removed
park-interior cells) so furniture keeps laying pedestrian paths on the old street
lines. It runs under vite-node so it can import the TS park data
(`landuseGreenAt` / `districtAt`) instead of duplicating the OSM masks.

## Regenerate

```bash
./fetch-streets.sh                 # once, or when you want fresh OSM data
node calibrate.mjs                 # optional: inspect the projection + SF aspect ratio
node rasterize.mjs                 # sweep candidate sizes + print density stats
node rasterize.mjs 244 200         # bake one size -> src/world/sf-streets.ts
```

The baked mask's `gx`/`gz` **must equal `GRID_X`/`GRID_Z`** in
`src/shared/constants.ts` (`generateCity()` throws otherwise). If you change the
grid, re-bake at those dimensions: `node rasterize.mjs <GRID_X> <GRID_Z>`.

## Notes on sizing

- SF's true geographic box is ~14.1 km × 11.6 km — an aspect ratio of **1.219 : 1**
  (wider E–W than N–S). The grid is **rectangular** (`GRID_X × GRID_Z`) to match,
  so the city renders at its real proportions (an earlier square grid compressed
  it ~18% east-west).
- Current setting: **`GRID_X = 244`, `GRID_Z = 200`** (~58 m/cell). `ROAD_TILE`
  (road width) is held fixed, so a higher cell count makes the world physically
  bigger and the car proportionally smaller.
- Density vs. resolution (post-thinning): coarser than ~150 m/cell the downtown
  grid merges into a blob; finer than ~70 m/cell the cell count (and draw calls)
  climb steeply — the chunked streaming in `city.ts` is what keeps the large map
  affordable to render.

## Real-footprint / waterfront / freeway pipeline (2026-07-12)

- **`extract-footprints.mjs <obj>`** — parses the licensed "Downtown San
  Francisco" OBJ into per-building footprint POLYGONS + heights →
  `src/world/sf-footprints.ts` (~21k entries). The model→world transform is
  hardcoded (`CAL`): anchored on Salesforce/Transamerica (identified by the
  1.598 model-h/real-m ratio) and hill-climbed against the street mask with
  INDEPENDENT x/z scales and NO z-flip — the old calibrate-downtown.mjs fit
  (uniform scale, fz=-1; deleted along with extract-downtown.mjs and
  sf-buildings.ts) locked onto a MIRRORED false optimum and shipped an
  upside-down downtown. Anchors are re-verified on every run (aborts >12u).
  The game extrudes these outlines as prisms (`src/world/sf-prisms.ts`),
  replacing the old bbox+kit-model downtown pass.
- **`bake-piers.mjs`** — `sf-piers.raw.json` (Overpass `man_made=pier`, no
  fetch script yet — query in git history; gitignored like the other raws) →
  `src/world/sf-piers.ts`. Piers
  the traced coast swallows slide seaward along their long axis to hang off
  the game's shoreline. Rendered by `src/world/piers.ts`.
- **Freeways** — `bake-network.mts` also emits `src/world/sf-freeways.ts`
  (motorway/trunk mainlines; links dropped). Rendered as ELEVATED viaducts by
  `src/world/freeways.ts` — never part of the drivable network.
- **`EMBARCADERO_SHORE`** — the NE coast is cut to the REAL shoreline in
  `src/world/sf-map.ts` `landFactor` (copies in bake-network.mts +
  bake-piers.mjs must stay in sync) so downtown meets the bay at the seawall.
