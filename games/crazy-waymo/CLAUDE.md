# crazy-waymo — agent notes

3D SF arcade driving game (Three.js + Rapier). Real OSM street network, baked
world, day-night tied to the actual SF clock. Deployed at
crazy-waymo.vibedgames.com via `vg deploy ./dist`.

## Commands (when to run what)

```bash
pnpm dev            # dev server (repo root: pnpm dev:crazy-waymo)
pnpm test           # world-gen invariant harness (~5s, headless, no browser)
pnpm bake:world     # regenerate + install public/world/*.bin (headless chromium)
pnpm bake:world -- 5193   # same, but attach to an already-running dev server
pnpm bake:map       # re-rasterize the OSM street mask (only after tools/sf-data changes)
pnpm lint:streets   # street-mask sanity report
pnpm typecheck
```

**Run `pnpm test` after touching anything in `src/world/`** — it asserts the
invariants between the two street representations (see below) that have
historically caused every "buildings in the road / cars on grass" bug. Two
baselines inside are BY DESIGN, don't "fix" them: ~21% of edge samples land
off road cells (diagonal avenues run straightened spines across their cell
staircases), and worst road-cell→edge distance is ~1.5 tiles (wide junctions).

**Bump `WORLD_REV` (src/world/world-bin.ts) + run `pnpm bake:world` whenever
generation OUTPUT changes** — street geometry/paint, building placement,
furniture, ground colors, terrain. The baked `public/world/*.bin` are the
shipped world; without a rebake, players (and your own dev tab, silently) keep
loading the old world at the same rev. `bake:world` refuses to run without the
rev bump for exactly this reason. Runtime-only changes (shaders, FX, lighting,
materials on shared mats, anything in src/fx/ or src/render/) need NO rebake.
Commit the regenerated bins.

## Architecture in 30 seconds

- **Streets exist twice**: a raster cell grid (`world/grid.ts`, from the baked
  OSM mask) and a vector edge network (`world/network.ts`, from
  `sf-network.ts`, park-filtered by `world/park-clear.ts`). Rendering, traffic
  routing and building setbacks use the VECTOR side; cell queries (furniture,
  fares, editor) use the GRID. Any change to one must keep the other in
  agreement — that is what `pnpm test` checks.
- **Three world sources, one shape**: live gen worker (`gen-worker.ts`) →
  IndexedDB cache (prod revisits) → baked `public/world/*.bin` (first visit).
  Dev bypasses the IDB cache; the bins short-circuit gen when their rev
  matches `WORLD_REV`.
- **The car is physics-native**: a Rapier `RaycastVehicle` attaches after
  load (`vehicle/raycast-vehicle.ts`) — drive-feel work goes there, NOT in
  the kinematic branch of `car.update` (that's only the pre-physics fallback).
- **Drive surface** (`world/surface.ts`): terrain + street-depression offset,
  pier/bridge decks, park-tile terraces — behind `city.heightAt/normalInto`.
- **god objects**: `world/city.ts` (placement + render batching + rest
  capture) and `scenes/game-scene.ts` (loop + modes + loading). Extract seams
  opportunistically (surface.ts and fx/vehicle-fx.ts are the pattern), don't
  big-bang.

## Verifying in a browser (headless)

Dev-only hooks on `window.__taxi`: `game`, `probe()` (pos/speed/state),
`teleport(u, v)` (map fractions, 0-1), `lookFrom(x,y,z, tx,ty,tz)` (freecam),
`setPhase(p)` (0.25 noon, 0.4 golden, 0.7 night — pins the day-night cycle),
`setFreecam(on)`, `pick(nx, ny)` (raycast debug).

Recipe: poll `__taxi.game.isReady`, call `game.handleStartPress()` (synthetic
keydowns do NOT start the game; Enter opens chat), wait ~4s (countdown swoop
owns the camera), then drive via dispatched KeyboardEvents on `window`.

**HMR footgun**: editing world/vehicle modules while a tab is open spawns a
second GameScene in-page; `__taxi` then points at an instance whose physics
world isn't stepped — the car sits at speed 0 and looks broken. Hard-reload
the page after edits before diagnosing any behavior.

## Map editing

`?editor=1` — place props, paint floors, add/remove street cells; export JSON
into `world/custom-props.ts` / `world/custom-map.ts`. `?tune=1` mounts the
vehicle tuning panel. `?bake=1` downloads world bins by hand (prefer
`pnpm bake:world`).
