# The look

Toy cars on an orange plastic track, as pixel-art gaussian splats.

## What makes a frame read right

1. **Big hard pixels on a fixed grid.** About 216 rows of art pixels, scaled by a whole number. Nothing is drawn at screen resolution over the scene except the HUD, and the HUD is square, flat and in palette tones.
2. **Surfaces made of blobs.** A splat is two to three art pixels across. Edges are lumpy at splat scale, never polygon-straight.
3. **One palette, used as ramps.** `src/splat/palette.ts`: sixteen ramps of five tones. A material names a ramp and a step. Shade is one step down, a highlight one step up.
4. **Self-coloured outlines.** A rim one step darker against empty space or something far behind. No black lines.
5. **Chunky shadows.** Cast by the splats themselves, one flat tone, never a checker.

## The world

- Scale sells the toy: blocks, books, balls, crayons, mugs and a rubber duck are all several karts tall.
- The track is orange with a lighter edge line, a red and white rumble strip, darker shoulders and raised rails. Bends get red and white rails.
- Each circuit is a room: floorboards and a rug, checkerboard tiles, foam play mats.
- Karts are drawn a third larger than they collide. Three chassis, read by silhouette: a wedge with a wing, a hot rod with an engine, an open-wheeler with a bubble.
- Kart colours stay off the orange family, because their paint has to read on the track.

## Motion

- The tabletop camera never turns. It slides in whole art pixels.
- Item crates turn in steps, not tweens. Sparks are single round splats in a ramp tone.

## Not yet

- Rooms have no walls or furniture: past the floor is the dark.
- No per-kart numbers or decals; at this size they would be noise.
- The chase camera crawls when it turns. That is the cost of a turning camera in this style.
