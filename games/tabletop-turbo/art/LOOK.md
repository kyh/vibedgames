# The look

Toy cars on an orange plastic track, as pixel-art gaussian splats.

## What makes a frame read right

1. **Big hard pixels on a fixed grid.** About 216 rows of art pixels, scaled by a whole number. Nothing is drawn at screen resolution over the scene except the HUD, and the HUD is square, flat and in palette tones.
2. **Surfaces made of blobs.** A splat is two to three art pixels across. Edges are lumpy at splat scale, never polygon-straight.
3. **One palette, used as ramps.** `src/splat/palette.ts`: sixteen ramps of five tones. A material names a ramp and a step. Shade is one step down, a highlight one step up.
4. **Self-coloured outlines.** A rim one step darker against empty space or something far behind. No black lines.
5. **Chunky shadows.** Cast by the splats themselves, one flat tone, never a checker.

## The world

- Scale sells the toy: a bed leg, a cereal box, a toy chest stand at room scale; blocks, balls, crayons, mugs and a rubber duck are several karts tall.
- Each room has its own two colours for its toys (bedroom red and yellow, kitchen blue and yellow, playroom yellow and pink). Everything else is the floor, white, and the track's orange.
- The track is one colour family: orange with a cream edge line, a cream and brown checker for the rumble strip, darker shoulders and raised rails. Pads and gates are the same cream and brown.
- Each circuit is a room with four papered walls and a skirting board: floorboards and a rug, checkerboard tiles, foam play mats.
- Karts are drawn larger than they collide. Three chassis, read by silhouette: a wedge with a wing, a hot rod with an engine, an open-wheeler with a bubble. A kart is one hue; its windows are that hue at its darkest.
- Eight kart colours, apart in value as well as hue, none an orange: their paint has to read on the track and against each other.
- Nothing tall stands between the tabletop camera and the road.

## Motion and effects

- The tabletop camera never turns. It slides in whole art pixels.
- Every effect is a round splat in a ramp tone that steps down the ramp as it ages: nothing fades.
- Always on: dust off the rear wheels, cream speed streaks at top speed, a glint hopping round each coin, glints in wet paint, light running across pads and pickups.
- On events: tyre smoke in the kart's colour and tier-coloured sparks in a drift, a yellow and red flame on a boost, a ring on a pad, a bomb, a spin and a boost release, a burst where anyone takes a coin or crate, confetti at the flag, a white flash on a hit.
- Words pop where things happen: +1, SPLAT!, MINI / SUPER / ULTRA TURBO.

## HUD

No panels in a race: pixel text with a dark outline straight on the scene. Position, lap, time, coins, item, three rows of standings, a minimap.

## Not yet

- No authored models: everything is boxes, cylinders, balls and cones. A slipper is two squashed balls.
- No per-kart numbers or decals; at this size they would be noise.
- The chase camera crawls when it turns. That is the cost of a turning camera in this style.
- No music.
