# Tabletop Turbo

A car battle on a table top, in pixel-art splats. Eight cube cars, each with a spring-loaded bumper on its nose: fire it to punch whatever is in front of you, and knock the others off the board. The board fights too (a sweeper arm, pistons, pop bumpers, two holes), crates change your bumper or your car, and for the last stretch of a round both ends of the board drop away. Free-for-all, 90 second rounds, respawns. Online through `@vibedgames/multiplayer` with bots filling the board. Deployed at `tabletop-turbo.vibedgames.com`.

## Develop

```bash
pnpm dev:tabletop-turbo                        # http://localhost:5197
pnpm --filter @repo/tabletop-turbo test        # headless: board, driving, punches, falls, hazards, crates, bot rounds, wire format
pnpm --filter @repo/tabletop-turbo typecheck
pnpm --filter @repo/tabletop-turbo build
```

## Routes

| URL           | What                                           |
| ------------- | ---------------------------------------------- |
| `/`           | the game                                       |
| `/?offline=1` | never dial the party server: solo against bots |
| `/?test=1`    | playtest manifest + hooks (always offline)     |
| `/?sun=0`     | no shadow pass, for software renderers         |

Test states (`__GAME_TEST_HOOKS__.setState`): `title`, `active-play` (the count before a round), `crate` (just before the first crate lands), `shrink` (just before the ends start to blink), `finale` (six seconds left), `results`. `sun` and `sun-off` switch the shadow pass.

## Controls

| Input                                    | Action                              |
| ---------------------------------------- | ----------------------------------- |
| W A S D / arrows (pad stick, touch drag) | drive: the car goes where you point |
| Space / J (pad A / X / RT, touch PUNCH)  | fire the bumper                     |
| Shift / K (pad B / RB / LT, touch BOOST) | boost, while held                   |
| M                                        | mute                                |
| Escape (touch ⏸)                         | pause                               |

The stick is the screen's: up is up the board whichever way the car faces. There is no throttle and no brake.

## How it plays

- **The bumper.** One button. It winds back for a blink, fires, and throws any car in its reach about two and a half car lengths, a little more if you were moving. Then it reloads: 2.2 s after a hit, 3 s after a miss. The ring under your car fills as it reloads.
- **Dents.** A car that takes a punch is dented, and a dented car flies further: 1.3 times after one punch, 1.6 after two. Dents pop back out after 8 s without a punch. A dented car smokes.
- **Knock-offs.** Over the edge or into a hole is a fall. Whoever hit the car in the last three seconds scores a point and gets half a boost meter back. A car that falls on its own loses a point (never below zero).
- **Clash.** Two bumpers that meet nose to nose cancel: both cars bounce back and nobody is thrown.
- **Boost.** A second of 1.5 times speed, five seconds to refill. A boosted car rams harder, and a punch thrown mid-boost lunges.
- **Ramming.** A car driven into another at speed shoves it a car length and passes on the credit. It never dents.
- **Back in.** A fallen car drops back onto the middle of the board after 1.5 s, shielded for 1.5 s. Firing the bumper drops the shield.
- **Hazards.** The sweeper turns in the middle and bats what it touches along its swing. Pistons blink their lane for 0.9 s, then fire across it. Pop bumpers kick cars straight back out. A hazard's hit keeps the credit of whoever knocked the car into it.
- **Crates.** One at a time, every 9 s from 0:10, under a beam that shows where it will land. First car to reach it takes it.
  - _Mega bumper_: half as wide again and half as hard again, for two punches.
  - _Long spring_: twice the reach, for two punches.
  - _Giant_: a bigger, heavier car for 6 s: thrown less, slightly slower.
  - _Turbo_: 6 s of boost that does not run down.
- **The squeeze.** With 25 s left the two ends of the board blink for three seconds and drop off the table. Everything left is in reach of the sweeper.

## Multiplayer

Auto-joins the shared `tabletop-turbo-v2` room (8 players, overflow into sibling rooms), solo fallback when the party server is unreachable. Bots make the board up to eight.

- Every player simulates their own car and reports it 20 times a second, stamped in server time; everyone else's plays back through an `Interpolator` on a clock per sender. The host simulates the bots the same way, and owns the round clock and the scores in shared state.
- Hits are the attacker's call. The client whose bumper connected sends the blow to the room; the client that owns the car that was hit applies it (or refuses it: shielded, already hit by that blow, a clash). The attacker shows the throw at once and blends into the reports when they arrive.
- A fall is counted where it happens: each car carries a count of its own falls and who hit it last, and the host turns a count that went up into a point.
- Hazards, crates and the squeeze are functions of the round clock, so every client sees the same board. A crate is a first-come claim on the server.
- A new host adopts the bots from their last reports and carries on. Joining mid-round drops you onto the board of the round in progress.

## Look

Night on a table top: a card board lit by lamps and by the cars' own headlights, drawn as pixel-art splats. `art/LOOK.md` has the rules.

There are no meshes or image files. Every solid is sampled into small opaque discs (`src/splat/builder.ts`), each carrying a palette ramp and a step on it. The stage (`src/splat/stage.ts`) draws them as hard-edged gaussian blobs into a G-buffer at twice the art resolution, from the lamp for shadows and from the camera for the picture; a resolve pass takes a 2x2 vote per art pixel, picks a light level from a light map painted each frame (lamps, headlights, flashes), inks a rim one step darker in the material's own colour, and writes palette tones to a canvas about 330 rows tall, which the browser scales up by a whole number. The technique follows the pixel-art gaussian splat write-up credited in `refs/SOURCES.md`; the code here is this repo's own.

One camera: fixed, from the south, tipped 55 degrees. It never turns, and it slides in whole art pixels so nothing shimmers. On a narrow screen it follows your car; on a wide one it shows the whole board.

## Layout

```
src/sim/       the fight, no three.js: board, car, bumper, hazards, crates, field (hits, falls, credit), bots
src/net/       room session, car wire format, playback of cars simulated elsewhere
src/splat/     the renderer: palette, splat baker, shaders, stage
src/render/    what is drawn: board, cars, hazards and crates, sparks, light map, glow, DOM HUD
src/scenes/    game-scene.ts: rounds, host duties, hit relay, camera, effects, HUD wiring
tools/         headless bot rounds and the tests
art/           the look
```

Tuning lives in `src/shared/constants.ts`; boards are data in `src/sim/arena.ts` (the tests hold each one to having every start, drop and crate pad on the board, and the drops on what is left after the squeeze).
