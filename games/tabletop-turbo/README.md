# Tabletop Turbo

A car battle on a table top, in 16-bit pixel art. Pick one of six toy cars, each with its own attack, and knock the others off a big card board full of holes. Every blow adds damage, and a damaged car flies further. Power cubes hand out one of twelve specials, one at a time. The board fights too (a sweeper arm, pistons, pop bumpers), and for the last stretch of a round its rim drops away and every knock-off counts double. Free-for-all, two minute rounds, respawns. Online through `@vibedgames/multiplayer`, with bots that fill the board and step out as players join. Deployed at `tabletop-turbo.vibedgames.com`.

## Develop

```bash
pnpm dev:tabletop-turbo                        # http://localhost:5197
pnpm --filter @repo/tabletop-turbo test        # headless: board, driving, every attack and special, falls, hazards, cubes, bot rounds, balance, wire format
pnpm --filter @repo/tabletop-turbo typecheck
pnpm --filter @repo/tabletop-turbo build
node --import tsx tools/balance.mts 60         # in the game folder: bot rounds, a line of numbers per car
```

## Routes

| URL           | What                                           |
| ------------- | ---------------------------------------------- |
| `/`           | the game                                       |
| `/?offline=1` | never dial the party server: solo against bots |
| `/?test=1`    | playtest manifest + hooks (always offline)     |
| `/?sun=0`     | no shadow pass, for software renderers         |

Test states (`__GAME_TEST_HOOKS__.setState`): `title`, `active-play` (the count before a round), `cubes` (the first cubes are down), `shrink` (just before the rim starts to blink), `finale` (six seconds left), `results`, and `special-<name>` (puts that special in your slot). `sun` and `sun-off` switch the shadow pass.

## Controls

| Input                                        | Action                          |
| -------------------------------------------- | ------------------------------- |
| W S / up down (pad stick, touch drag)        | the pedal: go, and back up      |
| A D / left right (pad stick, touch drag)     | the wheel                       |
| Space / J / X (pad A / X / RT, touch HIT)    | your car's attack               |
| E / L / C (pad Y / LB, touch ITEM)           | use the special you are holding |
| Shift / K / Z (pad B / RB / LT, touch BOOST) | boost, while held               |
| M                                            | mute                            |
| Escape (touch ⏸)                             | pause                           |

The camera sits behind your car and turns with it, so the stick is the car's: up the screen is ahead, across is the wheel, and pulling back backs the car up. On the title, left and right change the car and up and down the colour.

## How it plays

- **Six cars.** Picked on the title with one of eight colours, and kept between visits. Stats and attacks are a table in `src/sim/kinds.ts`.

  | Car     | Attack   | What it does                                                              | Drives               |
  | ------- | -------- | ------------------------------------------------------------------------- | -------------------- |
  | Bumper  | Punch    | a spring bumper straight ahead; kicks back, lunges out of a boost         | even                 |
  | Dart    | Dash     | lunges three car lengths through whoever is in the way                    | fastest, light       |
  | Brick   | Slam     | hops and comes down: everyone round it flies outwards, near ones furthest | slowest, heaviest    |
  | Popper  | Pop shot | fires a puck seven car lengths down the board; quickest to reload         | light                |
  | Scoop   | Flip     | tosses the car in front high over its own roof, the longest throw         | heavy                |
  | Twister | Whirl    | spins and bats away everything close, out and round                       | best steering, light |

- **Damage.** Every blow adds to a car's damage, shown as a percentage on your dash and over every other car, and a car flies 1.15 % further per point: twice as far by 87 %. A heavy car is thrown less. A fall wipes it.
- **Reload.** An attack that touches nobody takes longer to come back than one that lands. The meter on the dash and the light on the car show it.
- **Knock-offs.** Over the edge or into a hole is a fall. Whoever hit the car in the last three and a half seconds scores a point (two once the rim is going) and gets half a boost meter back. A car that falls on its own loses a point (never below zero).
- **Clash.** Two punches that meet nose to nose cancel: both cars bounce back and nobody is thrown.
- **Boost.** A second of 1.5 times speed, five seconds to refill.
- **Ramming.** Only a boosted car rams: it shoves what it drives into and takes the credit. Without boost, cars just push.
- **Back in.** A fallen car drops back onto the middle of the board after a second, on the drop point furthest from everyone, untouchable for 1.5 s, and shoves aside whatever it lands on. Attacking, using a special or driving into a car ends that early.
- **Hazards.** The sweeper turns in the middle and bats what it touches along its swing. Pistons blink their lane for 0.9 s, then fire across it. Pop bumpers kick cars straight back out. A hazard's hit keeps the credit of whoever knocked the car into it.
- **Power cubes.** Sixteen pads, each with a cube every 11 s under a beam that shows where it lands. Drive over one to take it. A car holds one special at a time and cannot pick up another until it has used it. What a cube holds is dealt when it is taken, and the cars at the back of the field are dealt more of the hard hitters.
  - _Rocket_: fast and straight, bursts on the first car and splashes those beside it.
  - _Seeker_: slower, turns after the car it was let go at.
  - _Mine_: dropped behind, arms in a moment, goes off under the next car. Never its owner.
  - _Oil slick_: dropped behind; a car that crosses it slides straight on with no wheel.
  - _Shockwave_: throws everyone round you outwards.
  - _Magnet_: yanks everyone in reach to your nose, ready for your attack.
  - _Zap_: stalls everyone in reach where they stand.
  - _Shield_: takes the next blow, whatever it is.
  - _Giant_: a bigger, far heavier, harder-hitting car for 7 s.
  - _Turbo_: 4 s of boost that does not run down.
  - _Wrench_: mends all your damage.
  - _Spring_: hops you over anything, and stomps where you land.
- **The rim.** With 35 s left the rim of the board blinks for three seconds and drops off the table, taking its pads, pistons and anyone on it, and from the first blink a knock-off is worth two.
- **Radar.** A round map of the board about your car, turned the way the camera is.

Balance is measured, not guessed: `tools/balance.mts` plays bot rounds with every car in every seat. Over 288 rounds the six cars score within 7 % of each other per seat. That is bots; the test suite holds a looser band so a change that breaks it fails.

## Multiplayer

Auto-joins the shared `tabletop-turbo-v3` room (8 players, overflow into sibling rooms), solo fallback when the party server is unreachable. Bots make the board up to eight, and each player who joins takes a bot's seat: the bot steps out in a puff of confetti, mid-round if need be.

- Every player simulates their own car and reports it 20 times a second, stamped in server time; everyone else's plays back through an `Interpolator` on a clock per sender. The host simulates the bots the same way, and owns the round clock and the scores in shared state.
- Hits are the attacker's call. The client whose attack or shot connected sends the blow to the room; the client that owns the car that was hit applies it (or refuses it: just back in, shielded, already hit by that blow, a clash). The attacker shows the throw at once and blends into the reports when they arrive. A blow off the wire is held to what the hardest real one could carry.
- Rockets, seekers, pucks, mines and slicks belong to the client that let them go: it alone decides what they hit, and their rows ride its car's report so everyone else draws them in step. A slick is the one exception: the car that crosses it slips on its own client.
- A fall is counted where it happens: each car carries a count of its own falls and who knocked it off, and the host turns a count that went up into a point. Knock-offs still in the air at the horn count for a moment after it.
- Hazards, cubes and the rim are functions of the round clock, so every client sees the same board. Taking a cube is a first-come claim on the server; what it holds is a function of the round, the cube and the taker's place.
- Cars report their kind and colour. The host gives the bots the colours no player is wearing.
- A new host adopts the bots from their last reports and carries on. Joining mid-round drops you onto the board of the round in progress.
- A host whose tab is hidden keeps the round and its bots going on a timer, and a player who stops reporting has their seat filled by a bot until they are back.

## Look

A game board on a sunlit desk, drawn the way a 16-bit console would: crisp solids, dark ink outlines, eight-tone ramps, dithered shading and checker shadows. `art/LOOK.md` has the rules.

There are no model or image files. Every solid is built in code from boxes, wedges, cylinders and balls (`src/pixel/mesh-builder.ts`), each face carrying a palette ramp and a step on it, with stripes, windows and panel lines picked per face cell. The stage (`src/pixel/stage.ts`) renders them at art resolution (360 rows) into a G-buffer of ramp, step, part id, normal and depth, once from the sun for shadows and once from the camera. A resolve pass then inks an outline wherever the part or the depth changes, highlights lit creases, turns shadows on the board into a checker, and looks every pixel up in the ramp table (`src/pixel/palette.ts`, grown from seed colours in OKLCH). The browser scales the result up by a whole number. The style follows the references credited in `refs/SOURCES.md`; the code is this repo's own.

One camera, tipped 50 degrees. In a round it follows your car, looks a little way ahead of it and eases round to sit behind it; while you are thrown or sliding it holds still. On the title it faces the turntable your car stands on.

## Layout

```
src/sim/       the fight, no three.js: board, car kinds, car, specials and shots, hazards, cubes, field (hits, falls, credit), bots
src/net/       room session, car and blow wire formats, playback of cars simulated elsewhere
src/pixel/     the renderer: palette, mesh builder, shaders, stage
src/render/    what is drawn: board and desk, cars, hazards, cubes and shots, sparks, flashes, glow, radar, DOM HUD
src/scenes/    game-scene.ts: rounds, host duties, hit relay, camera, HUD wiring; effects.ts: what a hit, an attack and a special look and sound like
tools/         headless bot rounds, the balance run and the tests
art/           the look
```

Tuning lives in `src/shared/constants.ts`; boards are data in `src/sim/arena.ts` (the tests hold each one to having every start, drop and cube pad on the board, and the drops on what is left once the rim has gone). Car kinds are in `src/sim/kinds.ts` and specials in `src/sim/specials.ts`.
