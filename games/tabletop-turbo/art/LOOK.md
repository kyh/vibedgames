# The look

Cube cars fighting on a card board at night, as pixel-art gaussian splats.

## What makes a frame read right

1. **Hard pixels on a fixed grid.** About 330 rows of art pixels, scaled by a whole number. Nothing is drawn at screen resolution over the scene except the HUD, and the HUD is square, flat and in palette tones.
2. **Surfaces made of blobs.** A splat is two to three art pixels across. Edges are lumpy at splat scale, never polygon-straight.
3. **One palette, used as ramps.** `src/splat/palette.ts`: ramps of five tones. A material names a ramp and a step.
4. **Light in levels.** Four of them, read from a light map painted each frame: dark blue night, dim, lit, and a warm top level under lamps and flashes. A pool of light has a hard, lumpy edge; nothing fades smoothly.
5. **Self-coloured outlines.** A rim one step darker against empty space or something far behind. No black lines.
6. **Chunky shadows.** Cast by the splats themselves, one flat tone, never a checker.

## The world

- The board is a sheet of card with rounded corners and a cream edge, standing on a table in a dark room. Two square holes are cut in it. Its ends are scored along a dashed line: that is where they drop off.
- Everything that hurts is yellow and black stripes with red ends: the sweeper arm, the piston heads. Their lanes and reach are painted on the board in the same yellow. Pop bumpers are pink with a cream cap.
- Cars are cubes with a cab, four wheels and a cream bumper bar on the nose, drawn larger than they collide. A car is one hue; its windows are that hue at its darkest. They are always drawn at full brightness, whatever the light on the floor.
- Eight car colours, apart in value as well as hue. Yours wears a ring on the floor that fills as the bumper reloads.
- Crates glow in the colour of what is inside (red mega, blue spring, green giant, yellow turbo), with the item's mark on the lid and a beam of the same colour before they land.
- Nothing tall stands between the camera and the board.

## Light

- Lamp posts at the corners throw fixed warm pools. Each car throws a headlight cone ahead of it and a small pool under it.
- Every event lights the floor for a moment: a hit, a clash, a landing, a piston firing, a crate.
- A piston's lane pulses, faster as it is about to fire.

## Motion and effects

- The camera never turns. It slides in whole art pixels, and jolts on a hit.
- Every effect is a round splat in a ramp tone that steps down the ramp as it ages: nothing fades.
- A hit is a white ring where the bumper met the car, sparks in the attacker's colour thrown along the blow, a flash on the floor, a few frames of freeze and a camera jolt if you were part of it. The car that was hit goes white for a moment and tumbles.
- Always on: a glow trail in the car's colour while it boosts, skid marks under a thrown car, smoke off a dented one.
- On events: a ring and a thump on landing, puffs along the bumper's stroke, a column of light under a car dropping back in, confetti in the car's colour when it is out, the ends of the board blinking before they fall.
- Words pop where things happen: POW!, SMASH!, the name of a crate.

## HUD

Small dark panels with a one-pixel border, pixel type, palette tones. Your score and place top left, the clock top centre, the board's standings top right, a knock-off feed under the score, two meters (bumper, boost) bottom centre with the held item beside them.

## Not yet

- No authored models: everything is boxes, cylinders and balls.
- One board. `src/sim/arena.ts` takes more.
- No music.
