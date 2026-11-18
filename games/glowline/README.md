# Glowline

Three.js kart racer where every kart paints the road. Your own colour is a fast lane, anyone else's is slick, and the newest coat wins a cell, so a racing line is something you lay, lose and take back. Eight karts, three laps, three city circuits in rotation, three chassis, items, orbs and a rocket start. Online through `@vibedgames/multiplayer` with bots filling the grid. Deployed at `glowline.vibedgames.com`.

## Develop

```bash
pnpm dev:glowline                        # http://localhost:5197
pnpm --filter @repo/glowline test        # headless: circuits, bots, paint, pickups, items, wire format
pnpm --filter @repo/glowline typecheck
pnpm --filter @repo/glowline build
```

## Routes

| URL           | What                                           |
| ------------- | ---------------------------------------------- |
| `/`           | the game                                       |
| `/?offline=1` | never dial the party server: solo against bots |
| `/?test=1`    | playtest manifest + hooks (always offline)     |

Test states (`__GAME_TEST_HOOKS__.setState`): `active-play` (on the grid, lights green), `garage` (the title screen), `grid` (held on three reds), `overview` (the whole circuit from above). The last three are the framings the visual critic loop captures.

## Controls

| Input                                   | Action                        |
| --------------------------------------- | ----------------------------- |
| W / ↑ (pad RT / A)                      | accelerate                    |
| A D / ← → (pad stick, touch drag)       | steer                         |
| S / ↓ (pad LT / B, touch BRAKE)         | brake / reverse               |
| Space / Shift (pad RB / X, touch DRIFT) | drift: hold, release to boost |
| E / X (pad Y / LB, tap the item slot)   | use item                      |
| M                                       | mute                          |
| Escape (touch ⏸)                        | pause                         |

Touch drives itself: the left thumb steers, the right holds DRIFT.

## How it plays

- **Paint.** A kart lays a stripe behind it, wider while drifting or boosting. Paint lasts ~34 s, then thins away. On your own colour: +16% top speed and harder acceleration. On a rival's: less grip and a little less speed. Stripes are narrow and the road is wide, so the race is about lanes as much as lines, and the kart at the back owns the freshest road.
- **Drift.** Hold drift with some lock to slide. The bar under the speedometer fills through three tiers; releasing cashes the tier in as a boost. Sliding onto the shoulder fizzles it.
- **Rocket start.** Gas pressed in the last beat before the green (on touch, hold DRIFT) launches with a boost.
- **Chassis.** Dart (all-rounder), Anvil (top speed, slow to build it, less grip), Wisp (acceleration and grip, lower top speed). Picked on the title screen.
- **Orbs.** Gold rings in lines of five. Each adds 1.1% top speed, up to ten. A spin-out costs three.
- **Items.** Boxes in rows of four hold one item; the further back you are, the better the roll.
  - _Turbo_: a long boost.
  - _Paint bomb_: lobbed up the road; splats your colour and spins whoever is under it.
  - _Solvent_: strips rival paint in a wide circle and makes you immune to slick for four seconds.
  - _Blot_: a puddle dropped behind you. Whoever hits it spins.
- **Splat pads.** Chevron pads lay three fat stripes of your colour for whoever crosses first, then rest for 7 s.
- **Rails.** Barriers keep karts on the road and ease a nose-in kart round to run along them.

## Multiplayer

Auto-joins the shared `glowline-v2` room (8 players, overflow into sibling rooms), solo fallback when the party server is unreachable.

- Every player simulates their own kart and reports it 20 times a second, stamped in server time; rivals play back through an `Interpolator` on a clock per sender.
- The host owns the round clock (countdown, results, next circuit) and simulates the bots, both in shared state. A new host rebuilds the bots from their last rows and carries on. While everyone is still on the title screen the host holds the grid under the lights.
- Paint never rides the wire. Each client paints from the karts it sees. Two clients can disagree for a moment about a stripe's edge or who hit a pad first.
- Pickups are decided by a kart's owner: it rewards its own kart for what it touched, and every client hides what any kart drove over. Playing an item is an event to the room; everyone applies the same effect to the road, and each owner decides whether its own karts were caught.
- Joining mid-race drops you on the grid of the race in progress.

## Look

A city circuit at golden hour. One low warm sun with soft shadows, cool sky fill. Every surface is drawn on a canvas at boot (`src/render/textures.ts`): asphalt, concrete, grass, painted panels, building facades, signs. Large-scale variation (tar patches, the rubbered-in line, skid marks) is world-space noise in the road shader, because anything large baked into a tiling texture lines up into stripes. Contact shading is built into the scene (strips under barriers, discs under trees, aprons round buildings) rather than a screen-space pass, so phones get it too. Desktop adds bloom and a grade; phones skip shadows and post.

The visual bar this is held to lives in `art/` (`LOOK.md`, `BAR.md`, the critic's verdicts). Reference shots and captures are gitignored.

## Layout

```
src/sim/       pure race core, no three.js: track, kart physics, paint grid, pickups, bot driver
src/net/       room session, pose wire format + playback, bots (host sim / guest playback)
src/render/    textures, sky, road shader, scenery + props, kart mesh, pickups, sparks, post, DOM HUD
src/scenes/    game-scene.ts (race flow, camera, wiring), items.ts (orbs, boxes, the four items)
tools/         the headless harness
art/           the look, the bar, the critic's verdicts
```

Tuning lives in `src/shared/constants.ts`; circuits are control-point lists in `src/sim/track.ts` (the harness checks each one fits the paint grid, never doubles back within two rails of itself, and is lappable by a bot).
