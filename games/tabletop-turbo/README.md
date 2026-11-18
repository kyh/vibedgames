# Tabletop Turbo

Toy-car racer in pixel-art splats, where every kart paints the track. Your own colour is a fast lane, anyone else's is slick, and the newest coat wins a cell, so a racing line is something you lay, lose and take back. Eight karts, three laps, three toy circuits (bedroom, kitchen, playroom) in rotation, three chassis, items, orbs and a rocket start. Online through `@vibedgames/multiplayer` with bots filling the grid. Deployed at `tabletop-turbo.vibedgames.com`.

## Develop

```bash
pnpm dev:tabletop-turbo                        # http://localhost:5197
pnpm --filter @repo/tabletop-turbo test        # headless: circuits, bots, paint, pickups, items, wire format
pnpm --filter @repo/tabletop-turbo typecheck
pnpm --filter @repo/tabletop-turbo build
```

## Routes

| URL           | What                                           |
| ------------- | ---------------------------------------------- |
| `/`           | the game                                       |
| `/?offline=1` | never dial the party server: solo against bots |
| `/?test=1`    | playtest manifest + hooks (always offline)     |
| `/?cam=chase` | start on the chase camera (C swaps in game)    |
| `/?track=1`   | open on circuit 1 or 2 instead of 0            |
| `/?sun=0`     | no shadow pass, for software renderers         |
| `/?sun=late`  | shadows off until the `sun` test state         |

Test states (`__GAME_TEST_HOOKS__.setState`): `active-play` (on the grid, lights green), `garage` (the title screen), `grid` (held on three reds), `overview` (the whole circuit from above). The last three are fixed framings for captures. `hero` halves the tabletop camera's distance for cover art. `sun` and `sun-off` switch the shadow pass, so a capture can drive without it and light the last frame.

## Controls

| Input                                   | Action                        |
| --------------------------------------- | ----------------------------- |
| W / ↑ (pad RT / A)                      | accelerate                    |
| A D / ← → (pad stick, touch drag)       | steer                         |
| S / ↓ (pad LT / B, touch BRAKE)         | brake / reverse               |
| Space / Shift (pad RB / X, touch DRIFT) | drift: hold, release to boost |
| E / X (pad Y / LB, tap the item slot)   | use item                      |
| C                                       | tabletop / chase camera       |
| M                                       | mute                          |
| Escape (touch ⏸)                        | pause                         |

Touch drives itself: the left thumb steers, the right holds DRIFT.

## How it plays

- **Paint.** A kart lays a stripe behind it, wider while drifting or boosting. Paint lasts ~34 s, then thins away. On your own colour: +16% top speed and harder acceleration. On a rival's: less grip and a little less speed. Stripes are narrow and the road is wide, so the race is about lanes as much as lines, and the kart at the back owns the freshest road.
- **Drift.** Hold drift with some lock to slide. The bar under the speedometer fills through three tiers; releasing cashes the tier in as a boost. Sliding onto the shoulder fizzles it.
- **Rocket start.** Gas pressed in the last beat before the green (on touch, hold DRIFT) launches with a boost.
- **Chassis.** Dart (all-rounder), Anvil (top speed, slow to build it, less grip), Wisp (acceleration and grip, lower top speed). Picked on the title screen.
- **Orbs.** Gold balls in lines of five. Each adds 1.1% top speed, up to ten. A spin-out costs three.
- **Items.** Boxes in rows of four hold one item; the further back you are, the better the roll.
  - _Turbo_: a long boost.
  - _Paint bomb_: lobbed up the road; splats your colour and spins whoever is under it.
  - _Solvent_: strips rival paint in a wide circle and makes you immune to slick for four seconds.
  - _Blot_: a puddle dropped behind you. Whoever hits it spins.
- **Splat pads.** Chevron pads lay three fat stripes of your colour for whoever crosses first, then rest for 7 s.
- **Rails.** Barriers keep karts on the road and ease a nose-in kart round to run along them.

## Multiplayer

Auto-joins the shared `tabletop-turbo-v1` room (8 players, overflow into sibling rooms), solo fallback when the party server is unreachable.

- Every player simulates their own kart and reports it 20 times a second, stamped in server time; rivals play back through an `Interpolator` on a clock per sender.
- The host owns the round clock (countdown, results, next circuit) and simulates the bots, both in shared state. A new host rebuilds the bots from their last rows and carries on. While everyone is still on the title screen the host holds the grid under the lights.
- Paint never rides the wire. Each client paints from the karts it sees. Two clients can disagree for a moment about a stripe's edge or who hit a pad first.
- Pickups are decided by a kart's owner: it rewards its own kart for what it touched, and every client hides what any kart drove over. Playing an item is an event to the room; everyone applies the same effect to the road, and each owner decides whether its own karts were caught.
- Joining mid-race drops you on the grid of the race in progress.

## Look

Die-cast toy cars on an orange plastic track, laid out across a floor and lined with oversized toys, drawn as pixel-art splats. `art/LOOK.md` has the rules.

There are no meshes or image files. Every solid is sampled into small opaque discs (`src/splat/builder.ts`), each carrying a palette ramp and a step on it. The stage (`src/splat/stage.ts`) draws them as hard-edged gaussian blobs into a G-buffer at twice the art resolution, from the sun for shadows and from the camera for the picture; a resolve pass takes a 2x2 vote per art pixel, inks a rim one step darker in the material's own colour, and writes palette tones to a canvas about 216 rows tall, which the browser scales up by a whole number. Paint is the track's own splats switching ramp. The technique follows the pixel-art gaussian splat write-up credited in `refs/SOURCES.md`; the code here is this repo's own.

Two cameras. The default is a fixed three-quarter view that only slides, snapped to the art grid so nothing shimmers. C swaps to a chase camera, which turns with the kart and so crawls a little, the way a low-resolution 3D game does.

## Layout

```
src/sim/       pure race core, no three.js: track, kart physics, paint grid, pickups, bot driver
src/net/       room session, pose wire format + playback, bots (host sim / guest playback)
src/splat/     the renderer: palette, splat baker, shaders, stage
src/render/    what is drawn: the room and track, toys, karts, pickups, sparks, DOM HUD
src/scenes/    game-scene.ts (race flow, camera, wiring), items.ts (orbs, boxes, the four items)
tools/         the headless harness
art/           the look
```

Tuning lives in `src/shared/constants.ts`; circuits are control-point lists in `src/sim/track.ts` (the harness checks each one fits the paint grid, never doubles back within two rails of itself, and is lappable by a bot).
