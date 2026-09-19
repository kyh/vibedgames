# Showdown

3D top-down battle royale brawler (Three.js): pick one of nine medieval champions, drop into a
procedurally laid-out arena with seven bots, and be the last one standing while the
sun sets and the poison gas closes in. Solo and online multiplayer. Deployed at
`showdown.vibedgames.com`.

## Champions

Briar (sword and shield), Wren (bow), Ember (fire staff), Rook (hammer),
Rowan (thrown javelins), Nyx (daggers), Moss (thorns), Flint (crossbow), and Pip (potions).
Three melee champions and six ranged champions each have a distinct basic attack and super.
Matches still have eight combatants.

## Develop

```bash
pnpm dev:showdown   # http://localhost:5195
pnpm --filter @repo/showdown typecheck   # tsc --noEmit
pnpm --filter @repo/showdown build       # vite build
pnpm --filter @repo/showdown preview     # vite preview
pnpm --filter @repo/showdown test        # headless config/utils smoke checks (tools/boot-smoke.mts, no three.js)
pnpm --filter @repo/showdown test:seed   # headless Chromium: the same seed replays the same brawl (tools/seed-smoke.mjs; --soak N for balance runs)
```

## Routes

| URL                    | What                                                         |
| ---------------------- | ------------------------------------------------------------ |
| `/`                    | the game (brawler select, then PLAY vs BOTS or PLAY ONLINE)  |
| `/?online[&room=CODE]` | skip the menu and join a room (the public room when no code) |
| `/?auto=<brawler>`     | skip the menu and start a solo brawl                         |

## Options

| Param              | Effect                                                                                                     |
| ------------------ | ---------------------------------------------------------------------------------------------------------- |
| `?q=<quality>`     | `low` / `medium` / `high` / `ultra`; disables the automatic GPU benchmark                                  |
| `?bots=<level>`    | bot difficulty: `easy` / `normal` / `hard`                                                                 |
| `?time=<hour>`     | pin the time of day (0–24, e.g. `19.4` for dusk) instead of following the match                            |
| `?seed=<int>`      | deterministic first match: arena, spawns, bot kits and every bot decision                                  |
| `?auto=<brawler>`  | skip the menu and start as `dusty` / `ace` / `fuse` / `titan` / `rowan` / `nyx` / `moss` / `flint` / `pip` |
| `?zoom=<factor>`   | camera distance multiplier (default `1`)                                                                   |
| `?speed=<n>`       | simulation steps per rendered frame, 1–16 (fast-forward for tests)                                         |
| `?ss=<factor>`     | supersample factor 0–3, overriding the quality tier's pixel ratio                                          |
| `?online`          | instant online match; `&room=CODE` picks a lobby, `&name=NAME` your name                                   |
| `?offline=1`       | never dial the party server — PLAY ONLINE is hidden, `?online` plays solo                                  |
| `?party=PORT\|URL` | dev-only party-server override (ignored in production builds)                                              |

## Controls

| Input                                         | Action                                  |
| --------------------------------------------- | --------------------------------------- |
| WASD (left thumb, pad left stick)             | move                                    |
| Mouse (right thumb drag, pad right stick)     | aim                                     |
| Click (release the right thumb, pad RT / A)   | shoot                                   |
| Tap                                           | auto-aim shot (touch)                   |
| Space / Right-click (SUPER button, pad LT/RB) | hold to aim the super, release to fire  |
| Shift (DODGE button, pad B / LB)              | evade in your movement or aim direction |
| T                                             | cycle time of day (noon → dusk → night) |
| Escape (pause button, pad START)              | pause                                   |
| M                                             | mute (also on the pause overlay)        |
| ⚙ (main menu)                                 | settings: quality, bots, time, effects  |

Evading briefly avoids weapon damage, with a 2.4-second cooldown. Poison gas still hurts.

The manifest in `src/controls.ts` feeds the start-screen legend, the pause overlay
and the web app's controls panel; a pad also walks the brawler cards (d-pad or
stick) and presses PLAY with A / START. Touch keeps its own two-thumb sticks
because the game needs a drag-to-aim, release-to-fire right stick that the
shared virtual pad's single stick cannot express.

Escape, controller START and the shared mobile pause button open the same pause overlay.
Solo freezes; online play continues with your controls released. Resuming clears held and queued
input so dismissing the overlay cannot also attack or dodge.

## Rendering

A custom pipeline on top of three.js: a PCSS soft-shadow patch for the sun and the
street lamps (falling back to PCF on the low tier), GTAO ambient occlusion, bloom, a
grade pass, and a time-of-day lighting rig that drives the sun, sky, fog, lamp
pool and fireflies from afternoon to night as the match progresses. Quality is
picked automatically from a startup benchmark and stepped down in play when the
frame rate drops, unless the player chooses a tier under ⚙.

## Multiplayer

Host-authoritative via `@vibedgames/multiplayer`: the first player in a room runs
the brawl, guests send intents (move axis, attack, super) and render 15 Hz
snapshots with their own body predicted locally. Rooms hold eight seats
(`showdown-<code>`, public room when no code) and bots fill whatever humans
leave empty; a human arriving mid-brawl spectates and is seated for the next
one, which the host starts eight seconds after a result. If the host leaves,
the promoted guest rebuilds the brawl from the last snapshot and the departed
host's seat becomes a bot. Solo play never opens a socket, and `?offline=1`
forces solo.

```bash
pnpm dev:party                                    # party server on :8787
pnpm --filter @repo/showdown test:online  # two headless clients: join, move, shoot, host handoff, late join
```

Presentation (particles, sounds, damage numbers, the kill feed) is replayed on
guests from a compact record the host writes alongside each snapshot
(`src/net/presentation.ts`), so the sim itself never needs to know about the wire.
