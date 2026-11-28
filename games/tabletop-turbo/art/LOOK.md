# The look

Cube cars fighting on a game board on a sunlit desk, drawn the way a 16-bit console would: crisp silhouettes, dark ink outlines, eight-tone ramps, dithered shading and checker shadows.

## What makes a frame read right

1. **Hard pixels on a fixed grid.** 450 rows of art pixels, scaled by a whole number. Nothing is drawn at screen resolution over the scene except the HUD.
2. **Real edges.** Everything is a solid with flat faces: a straight edge is straight, a circle is a clean pixel circle. Nothing is lumpy, blurred or anti-aliased.
3. **Ink outlines.** One pixel of dark ink wherever a thing ends against the floor, the air or something behind it. Where two parts of the same thing meet, a softer line two steps down its own ramp. A lit edge that turns away from the sun gets a one-step highlight instead.
4. **Ramps of eight.** `src/pixel/palette.ts` grows every ramp from one seed colour: shadows drift cool and gain colour, highlights drift warm and lose it. A material names a ramp and a step; light moves it up or down the ramp. No colour is ever mixed outside the table.
5. **Dither, sparingly.** A 4x4 ordered dither, fixed to the world so it does not swim, carries half-steps between tones on big surfaces and nothing else.
6. **Checker shadows.** The sun casts real shadows. On the ground they are a checker of shade pixels with a dithered edge; on an object they drop it down its ramp.
7. **Detail is painted, not modelled.** Stripes, grilles, windows, panel lines, chevrons and wear are tones picked per face cell or per board texel, at the art grid's scale.

## The world

- A warm sand desk with plank seams. On it, the board: a pale tiled slab with rounded corners and a hazard-striped rim, standing a few car lengths proud of the desk on banded sides. Two holes are cut through it. Its ends are a darker stone, scored along a red and cream dashed line: that is where they drop off.
- Round the board lies desk clutter (cones, dice, a pencil, cards, paint pots), all north or beside it. Nothing tall stands between the camera and the board.
- Everything that hurts is yellow and black stripes with red ends: the sweeper arm, the piston heads. Their lanes and reach are painted on the board (rails and chevrons, a red ring). Pop bumpers are pink with a cream cap.
- Cars are cubes: a tapered shell with a grille, a lower band and a cream stripe, a cab with glass that catches a glint, four tyres with hubs, lamps front and back, and a bumper plate on the nose. A car is one ramp; the plate goes bright when the bumper is ready.
- Eight car colours, apart in value as well as hue. Yours wears a ring on the floor that fills as the bumper reloads.
- Crates wear the colour of what is inside (red mega, blue spring, green giant, yellow turbo), with a column of that colour before they land.

## Light

- One sun, high and from the north-east. It never moves.
- Every event lights the floor for a moment: a hit, a clash, a landing, a piston firing, a crate.
- A piston's lane pulses, faster as it is about to fire.

## Motion and effects

- The camera never turns. It slides in whole art pixels, and jolts on a hit.
- Effects are pixel discs in ramp tones that step down the ramp as they age: nothing fades.
- A hit is a white ring where the bumper met the car, sparks in the attacker's colour thrown along the blow, a flash on the floor, a few frames of freeze and a camera jolt if you were part of it. The car that was hit goes white for a moment and tumbles.
- Always on: tyre tracks in the car's colour while it boosts, dark skid marks under a thrown car, smoke off a dented one.
- On events: a ring and a thump on landing, puffs along the bumper's stroke, a column of light over a car dropping back in, confetti in the car's colour when it is out, the ends of the board blinking before they fall.
- A shielded car is drawn as every other pixel.
- Words pop where things happen: POW!, SMASH!, the name of a crate.

## HUD

Small ink panels with a one-pixel lip, pixel type, palette tones. Your score and place top left, the clock top centre, the board's standings top right, a knock-off feed under the score, two meters (bumper, boost) bottom centre with the held item beside them.

## Not yet

- No authored models: everything is boxes, wedges, cylinders and balls with painted faces.
- One board. `src/sim/arena.ts` takes more.
- No music.
