# Coast, terrain and fog — 2026-09-05

Shore protection follows supported ground and exact bridge/pier footprints. Stone and concrete seawalls have projecting caps; park edges use timber or iron fences; piers and the Golden Gate use open railings. Ocean Beach stays broadly accessible. Stow has an eight-unit west-bank launch. Ordinary controls enter water, float, steer and return to land; spring buoyancy uses the existing Rapier chassis. Wakes, entry splashes, idle ripples, exit droplets and hull-wash audio follow actual water contact. Wet tires stop emitting dust and skid marks.

Stow now has a level water plane and shallow terrain basin. Park tiles and their physical terraces share a footprint exclusion. Local Palace/Sutro water bodies publish their rendered dimensions and receive submerged physics beds. Pier ramps are continuous; exact deck floors keep rail impacts from dropping the chassis through coarse terrain. The baked audit matches every boundary, visible transform and material, and follows actual curved road centerlines through connected junctions.

Terrain uses one 512² RGBA8 semantic weight map (1 MiB), shared across tiles. Turf clumps, soil, aggregate, stone strata and restrained bare-sand ripples follow the same ground classifier as tire effects. Phone shaders omit fine grain and normal relief. Paved contacts keep smoke/skids; loose surfaces emit distinct debris from actual rear-wheel contacts. Reverse travel throws material in the correct direction; airborne wheels emit none. Elevated freeways use their exact deck-top triangles so dirt beneath an overpass cannot change its tire effects.

SF fog forms a low coastal bank across the western neighborhoods and bay. Nearby driving stays clear; bridge towers emerge above the lower Gate bank. The horizon uses one draw and no extra fog textures. Day/night colors follow scene lighting.

## Final world

Revision 95: [26/26 water-driving checks](water-driving.json), 17 actual Rapier trajectories. Both access sites permit entry, stable floating and reverse return. Golden Gate and pier impacts retain supported floors. All five Palace/Sutro pools float without invisible reservation collisions; an actual gravity fall settles at the waterline. No runtime errors.

[Stow fence joints](stow-floating.png), [Wharf railings](wharf-rails.png), [Palace lagoon](palace-floating.png) were visually reviewed after the final bake. Shared posts connect stepped panels and corners. The installed audit finds zero planted roots in Stow or authored landmark water across 18,572 stems. Reservation subtraction preserves 44,087 surrounding architectural probes. Root seating uses decoded source roots rather than mesh origins; [transform audit](tree-seat-audit.json) records the correction.

Revision 96 changes only authored shadow policy: stone, concrete, timber and orange shore pieces keep shadows on native multi-draw renderers and use instancing on fallback drivers. Metal stays shadow-free. [Decoded artifact comparison](world-equivalence.json) confirms every other payload field is identical: all 21,736 solids, 64,049 prop instances, decks and geometry. Revision 95 physics, placement and native Safari acceptance therefore still cover the shipped world.

Water effects reuse the existing particle pool. Buoyancy adds no rigid bodies. Landmark geometry builds once on both cold and cached paths. Shore assemblies share five unit geometries and existing material batches.

## Phone stress comparison

Baseline main `46afff33`, final revision 96. Headed Chrome on M1 Max / ANGLE Metal, coarse pointer, 390×844, DPR 3, fixed tier 4, CPU 4×, multi-draw deliberately unavailable. Same connected Sunset route, three 8-second touch drives; destination parcels settle before each sample. These are desktop stress proxies, not physical-phone GPU or thermal measurements.

| Metric                          | Before                | After                 |
| ------------------------------- | --------------------- | --------------------- |
| Moving-frame median, three runs | 15.8 / 16.1 / 16.1 ms | 15.9 / 16.3 / 16.4 ms |
| Moving-frame p95, three runs    | 25.0 / 25.2 / 24.8 ms | 25.1 / 24.0 / 23.9 ms |
| Moving frames above 50 ms       | 0                     | 0                     |
| Median draw calls, three runs   | 353 / 354 / 354       | 342 / 342 / 342       |
| Render CPU median, three runs   | 7.4 / 7.3 / 8.2 ms    | 7.6 / 7.7 / 7.8 ms    |

Frame pacing stays comparable while fallback draw calls fall slightly below the previous release. The intermediate shoreline caster regression was caught before shipping: timber and stone buckets alone submitted 366 calls in a static fallback census. Authored shadow policy now permits their existing instancing path. Native multi-draw renderers retain their shadows. [Before](mobile-before.json), [after](mobile-after.json).

## Driving effects

[Actual surface drives](surface-effects.json): 14/14 checks across grass, gravel, dirt, sand, rock, reverse and airborne motion. Cars use real Rapier contacts and velocity; the harness records actual emitted effects. [Sand driving](sand-driving.png) shows the final compact dust fan and terrain treatment.

### Water effects

[Water VFX](water-effects.json): 26/26 checks using native touch, coarse pointer, DPR 3, CPU 4× and no multi-draw. Entry and exit each emit one paired splash; wet tires emit no dust, sparks, trails or skids. Foam stays at one draw, with peaks of 56 particles and 800 foam triangles. Four day/night portrait/landscape drives remain afloat and steer correctly. [Landscape day](water-landscape-day.png), [portrait night](water-portrait-night.png).

Revision 94 contains the final flotation physics and water FX; revision 95 changes shoreline joints and planting only. Final-world checks are recorded separately. Frame medians span 16.5–16.7 ms and p95 spans 19.9–24.6 ms across four four-second runs. Screenshot time is excluded. These are headed Chrome desktop stress proxies, not physical-phone FPS or thermal measurements.

## Native Safari

[iOS 26.5 simulator](native-safari.json): 11/11 checks. The first native touch starts the countdown immediately; no retry or synthetic click. Portrait day and landscape night driving pass. Five terrain/fog views compile without shader or runtime errors. [Gate day](phone-gate-day.png), [Gate night](phone-gate-night.png), [park](phone-park-day.png). This run uses revision 92 with final shaders and input handling; the later flotation and shoreline changes require the final water and production checks below. The harness deletes its own temporary simulator and preserves existing devices.

[Menu input](menu-input.json): 6/6 checks. First touch release enters countdown before the compatibility click; cancelled gestures and out-and-back drags leave Start available. Enter and Space activate once without opening chat. Native button semantics remain available to keyboard and assistive input.

### Water, revision 95

[Native water](native-water.json): 11/11 checks on an iPhone 17 Pro simulator, iOS 26.5 Safari, coarse pointer and DPR 3. One trusted touch starts the countdown without retry. Held touch drives through Ocean Beach into water; idle buoyancy and day/night steering pass. Foam renders without shader or runtime errors. [Night wake](native-water-night.png).

Entry begins on dry ground; open-water turns use staged positions with native propulsion and steering. This verifies simulator compatibility, not physical-phone performance. The owned temporary simulator was deleted; both original simulators remained Booted, with before/after states preserved in the report.

## Gameplay and production

[Desktop](desktop-final.json): 9/9 checks. [Mobile](mobile-final.json): 18/18, including touch steering/boost, pause/restart, orientation changes, quality tiers, no hidden-button interception and stopped GPU work while paused. Both use revision 95; revision 96 preserves their geometry and dynamics exactly.

[Production bundle](release-build.json) and [production touch smoke](production-touch.json): revision 96, real touch events in portrait and landscape, coarse DPR 3, CPU 2×, no multi-draw, no development hooks. Both drives reach 64 MPH without page errors or overflow. This unisolated cold-route smoke records one browser callback gap above 50 ms per orientation (133/177 ms); its 120 Hz rAF callbacks are not the game's presented frame rate. Use the matched moving-frame comparison above for timing claims.

## Reproduce

Run browser checks serially; keep other rendering browsers and heavy builds idle during timing samples.

```sh
pnpm -F @repo/crazy-waymo test
node tools/verify-water.mjs 'http://localhost:5193/?time=noon&offline=1' /tmp/waymo-water
node tools/verify-menu-keyboard.mjs 'http://localhost:5193/?time=noon&offline=1' /tmp/waymo-menu
node tools/verify-mobile.mjs 'http://localhost:5193/?time=night&offline=1' /tmp/waymo-mobile
node tools/verify-mobile-performance.mjs 'http://localhost:5193/?time=noon&offline=1' /tmp/waymo-performance 4,4,4 8000 --tier=4 --no-multi-draw
```
