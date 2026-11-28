# The look

Toy cars fighting on a game board on a sunlit desk, drawn the way a 16-bit console would: crisp silhouettes, dark ink outlines, eight-tone ramps, dithered shading and checker shadows.

## What makes a frame read right

1. **Hard pixels on a fixed grid.** 360 rows of art pixels, scaled by a whole number. Nothing is drawn at screen resolution over the scene except the HUD.
2. **Real edges.** Everything is a solid with flat faces: a straight edge is straight, a circle is a clean pixel circle. Nothing is lumpy, blurred or anti-aliased.
3. **Ink outlines.** One pixel of dark ink wherever a thing ends against the floor, the air or something behind it. Where two parts of the same thing meet, a softer line two steps down its own ramp. A lit edge that turns away from the sun gets a one-step highlight instead.
4. **Ramps of eight.** `src/pixel/palette.ts` grows every ramp from one seed colour: shadows drift cool and gain colour, highlights drift warm and lose it. A material names a ramp and a step; light moves it up or down the ramp. No colour is ever mixed outside the table.
5. **Flat tones, dither only on the ground.** A face of a car or a hazard is one flat tone; light moves it a whole step. Only the board and the desk blend between tones, in a narrow band of 4x4 ordered dither fixed to the world so it does not swim.
6. **Checker shadows.** The sun casts real shadows. On the board they are a clean checker of shade pixels; on the desk, where they are large, they drop the wood two tones with a dithered edge; on an object they drop it down its ramp.
7. **Detail is painted, not modelled.** Stripes, grilles, windows, panel lines, chevrons and wear are tones picked per face cell or per board texel, at the art grid's scale.

## The world

- A warm sand desk with plank seams. On it, the board: a wide pale tiled slab with rounded corners and a slate kerb, standing proud of the desk on banded sides. A dozen holes are cut through it, square and round, rimmed in hazard stripes and black at the bottom. Its rim is scored off from the middle along a red and cream dashed line: that is where it drops away.
- Round the board lies desk clutter (cones, dice, a pencil, cards, paint pots), all north or beside it. Nothing tall stands on the board's edge, because the camera now comes at it from every side.
- Stripes mean danger and nothing else wears them: the holes' rims, the sweeper arm, the piston heads and their housings. Their lanes and reach are painted on the board (rails and chevrons, a red ring). Pop bumpers are pink with a cream cap.
- Six cars, each a silhouette of its own built from the same parts (a shell with a grille and a lower band, a cab with glass that catches a glint, four tyres with hubs, lamps front and back): the Bumper a square hatch with a spring plate on its nose, the Dart low with a wedge nose and a rear wing, the Brick a tall block with a bull bar and a roof rack, the Popper with a turret and barrel on its roof, the Scoop with a blade on two arms across its nose, the Twister with a round skirt and a beacon on top. A car is one ramp, and its kind fixes the cream livery on its roof and bonnet, so kind reads from shape and paint and player from colour. Whatever the car attacks with goes bright when it is ready. Cars are drawn a fifth larger and taller than they collide.
- Eight car colours, apart in value as well as hue, none of them the board's white or the hazard amber. A player picks theirs; the bots wear what is left. Yours has a cream arrow bobbing over it, pointing the way the car does.
- Power cubes are bright cubes with cream edges and a cream question mark, under a column of light before they land. Their colour says nothing: what is inside is dealt when one is taken. Each of the twelve specials has a colour of its own, which its icon, its name when it pops and everything it puts on the board wear (a red rocket, an orange seeker, a striped mine with a blinking lamp, a purple slick, a blue shield bubble, and so on).
- On the title the camera faces a turntable on the desk, and the car you have picked turns on it and shows its attack.

## Light

- One sun, high and from the north-east. It never moves.
- Every event lights the floor for a moment: a hit, a clash, a landing, a piston firing, a cube, a burst.
- A piston's lane pulses, faster as it is about to fire.

## Motion and effects

- The camera follows your car and eases round to sit behind it, looking a little ahead. It holds still while you are thrown or sliding, and jolts on a hit. Solids turn in 64 steps so their edges land on the same pixels each time.
- Effects are pixel discs in ramp tones that step down the ramp as they age: nothing fades. Smoke and dust carry an ink edge; sparks and confetti do not.
- A hit is a white ring where the blow met the car, sparks in the attacker's colour thrown along the blow, a flash on the floor, a few frames of freeze and a camera jolt if you were part of it. The car that was hit goes white for a moment and tumbles.
- Always on: tyre tracks in the car's colour while it boosts, dark skid marks under a thrown car, smoke off a badly damaged one.
- On events: a ring and a thump on landing, puffs along an attack's stroke, a column of light over a car dropping back in, confetti in the car's colour when it is out or when a bot steps out for a player, the rim of the board blinking before it falls.
- Every attack and every special has its own mark at the moment it goes off: a ring that grows for a slam or a shockwave, an arc for a whirl, a streak for a dash, a bolt for a zap, lines drawn in for a magnet.
- A shielded car flickers between solid and every other pixel, and casts no shadow.
- Words pop where things happen: POW!, SMASH!, BLOCKED, the name of a special as it is used.
- Sounds from the board are only heard near where the camera is looking.

## HUD

Small ink panels with a one-pixel lip, pixel type, palette tones. Your score and place top left with the radar under them, the clock top centre with the knock-off feed under it, the standings top right, and the dash bottom centre: your damage, the attack and boost meters, and the special you hold with its icon. Every other car carries its damage over its roof, going from cream to red as it climbs. On a phone the dash moves up under the clock, out of the way of the thumbs.

## Not yet

- No authored models: everything is boxes, wedges, cylinders and balls with painted faces.
- One board. `src/sim/arena.ts` takes more.
- No music.
