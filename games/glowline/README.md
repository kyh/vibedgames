# Glowline

Three.js night kart racer where every kart paints the road. Your own colour is a fast lane, anyone else's is slick, and the newest coat wins a cell, so a racing line is something you lay, lose and take back. Six karts, three laps, three circuits in rotation; online through `@vibedgames/multiplayer` with bots filling the grid. Deployed at `glowline.vibedgames.com`.

## Develop

```bash
pnpm dev:glowline                        # http://localhost:5197
pnpm --filter @repo/glowline test        # headless sim: circuits, bots, paint, drift
pnpm --filter @repo/glowline typecheck
pnpm --filter @repo/glowline build
```

## Routes

| URL           | What                                           |
| ------------- | ---------------------------------------------- |
| `/`           | the game                                       |
| `/?offline=1` | never dial the party server: solo against bots |
| `/?test=1`    | playtest manifest + hooks (always offline)     |

## Controls

| Input                                   | Action                        |
| --------------------------------------- | ----------------------------- |
| W / ↑ (pad RT / A)                      | accelerate                    |
| A D / ← → (pad stick, touch drag)       | steer                         |
| S / ↓ (pad LT / B, touch BRAKE)         | brake / reverse               |
| Space / Shift (pad RB / X, touch DRIFT) | drift: hold, release to boost |
| M                                       | mute                          |
| Escape (touch ⏸)                        | pause                         |

Touch drives itself: the left thumb steers, the right holds DRIFT.

## How it plays

- **Paint.** A kart lays a stripe behind it, wider while drifting or boosting. Paint glows for ~34 s and fades. On your own colour you get +16% top speed and harder acceleration; on a rival's you lose grip and a little speed. Stripes are narrow and the road is wide, so the race is as much about lanes as lines.
- **Drift.** Hold drift with some steering lock to slide. The charge bar fills through three tiers; releasing cashes the tier in as a boost. Sliding onto the shoulder fizzles it.
- **Splat pads.** The glowing bars across the road flood the next stretch, full width, in the colour of whoever crosses first, then rest for 7 s.
- **Rails.** The road hangs over the city; rails keep karts on it and ease a nose-in kart round to run along them.

## Multiplayer

Auto-joins the shared `glowline-v1` room (6 players, overflow into sibling rooms), solo fallback when the party server is unreachable.

- Every player simulates their own kart and reports it 20 times a second, stamped in server time; rivals play back through an `Interpolator` on a clock per sender.
- The host owns the round clock (countdown, results, next circuit) and simulates the bots, both in shared state. A new host rebuilds the bots from their last rows and carries on.
- Paint never rides the wire. Each client paints from the karts it sees, so the road is derived from poses everyone already has. Two clients can disagree for a moment about a stripe's edge or who hit a splat pad first.
- Joining mid-race drops you on the grid of the race in progress. The first driver into an empty room gets a fresh countdown.

## Layout

```
src/sim/       pure race core, no three.js: track, kart physics, paint grid, bot driver
src/net/       room session, pose wire format + playback, bots (host sim / guest playback)
src/render/    track + skyline, kart mesh, paint texture, sparks, DOM HUD
src/scenes/    game-scene.ts: race flow, camera, wiring
tools/         sim.test.mts: the headless harness
```

Tuning lives in `src/shared/constants.ts`; circuits are control-point lists in `src/sim/track.ts` (the harness checks each one fits the paint grid, never doubles back within two rails of itself, and is lappable by a bot).
