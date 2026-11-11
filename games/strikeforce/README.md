# Strikeforce

Round-based 8v8 first-person shooter on a rain-soaked container dock at dusk.
Gold against Steel, no respawns inside a round: the attackers carry a charge
to site A or B and plant it, and the defenders hold the sites or defuse it.
First to five rounds takes the match. Every surface, weapon and sound is
generated in the browser; nothing is downloaded. Deployed at
`strikeforce.vibedgames.com`.

## Develop

```bash
pnpm dev:strikeforce                        # http://localhost:5196
pnpm dev:party                              # the party server, for matches on localhost
pnpm --filter @repo/strikeforce typecheck   # tsc --noEmit
pnpm --filter @repo/strikeforce test        # unit tests: the round rules, wire narrowing
pnpm --filter @repo/strikeforce test:online # two-client match smoke (needs dev:party)
pnpm --filter @repo/strikeforce build       # vite build
```

`test:online` drives two headless browsers through one room, with
`?norender=1` so software WebGL keeps up. Point it at a Chromium with
`SMOKE_BROWSER=/path/to/chromium` and at a running dev server with `--url`.

## Routes

| URL             | What                                                           |
| --------------- | -------------------------------------------------------------- |
| `/`             | the game; quick-matches into the fullest open match            |
| `/?room=dock7`  | a private match: everyone with the same code plays together    |
| `/?offline=1`   | never dials the party server (warmup on your own)              |
| `/?autostart=1` | skip the title and deploy at once                              |
| `/?q=low`       | force a quality preset (`low` `medium` `high` `ultra`)         |
| `/?test=1`      | publish the playtest hooks and manifest                        |
| `/?bench=1`     | camera fly-through with a frame-time readout                   |
| `/?norender=1`  | simulate without drawing (the two-client smoke on software GL) |

## Controls

| Input                                    | Action                     |
| ---------------------------------------- | -------------------------- |
| WASD (left stick, left thumb)            | move                       |
| mouse (right stick, right thumb, arrows) | look                       |
| left click (RT, Enter)                   | fire                       |
| right click (LT)                         | aim down sights            |
| R (X)                                    | reload                     |
| Q / 1 2 / wheel (Y)                      | swap rifle / sidearm       |
| hold E (hold X, USE)                     | plant at a site / defuse   |
| Space (A)                                | jump                       |
| Shift (L-stick click)                    | sprint                     |
| C / Ctrl (B, LB)                         | crouch                     |
| F                                        | melee                      |
| hold Tab                                 | scoreboard                 |
| Esc / P (Start)                          | pause (the round plays on) |

`src/controls.ts` is the same list for the web app's controls panel.

## The match

`src/net/rules.ts` is the whole rulebook, pure and unit-tested:

- **Teams.** Gold and Steel, up to eight each; newcomers join the smaller side.
  With one side empty the match sits in **warmup** (free play, respawn after
  3 s).
- **A round.** 5 s freeze (no moving) → 1:55 live → 5 s result. Attackers
  spawn at the west gate, defenders at the east quay by the boat. One attacker
  carries the charge; it drops where the carrier falls and any attacker can
  pick it up.
- **Plant and defuse.** Hold use for 3 s on site A (the yard) or B (the shed)
  to plant; the fuse is 40 s. A defender holds use for 5 s over the charge to
  defuse.
- **Winning a round.** Attackers win by eliminating the defenders or by the
  detonation. Defenders win by eliminating the attackers before a plant, by
  the defuse, or when time runs out.
- **The match.** First to five; sides swap after round four.

Damage: the weapon's own numbers, ×4 to the head (a rifle headshot kills).
Friendly fire is off.

## Multiplayer

Host-authoritative on `@vibedgames/multiplayer`. The first player in the room
is the host and runs the rules; it publishes the match (phase, clock, score,
who is alive, the charge, which barrels stand) at 10 Hz. Every client plays its
own body, publishes it at 20 Hz, and follows the published match: it respawns
itself at its team's spawn when a round starts, freezes during freeze time,
and watches a living teammate when it is down.

- **Hits favour the shooter.** A client tests its shots against the other
  team's hitboxes (head and body) as they stand on its own screen, then tells
  the host, which applies the damage and sends the victim a `hurt`.
- **Area damage** (barrels, the charge) each client applies to itself and
  reports through its body's health; the host only ever lowers health from a
  report, and only for the current round.
- **Barrels** belong to the host: a guest's shot is a request, the blast comes
  back to everyone.
- **Host loss.** The server elects a new host, which picks the match up from
  the last state it read.

Wire format: `src/net/protocol.ts`. A wire change bumps `ROOM_PREFIX`.

## Layout

| Path                              | What                                                           |
| --------------------------------- | -------------------------------------------------------------- |
| `src/core/strikeforce-core.js`    | the game: renderer, dock, weapons, audio, HUD, menus           |
| `src/core/types.ts`               | the typed slice of the game object the TypeScript layer drives |
| `src/net/rules.ts`                | the round rules (host)                                         |
| `src/net/match.ts`                | the match controller: `G.net`, host and client                 |
| `src/net/players.ts`, `avatar.ts` | other players: interpolation, avatars, hitboxes                |
| `src/net/map.ts`, `charge.ts`     | sites and spawns on the dock; the charge in the world          |
| `src/net/match-hud.ts`            | score bar, round clock, Tab scoreboard                         |
| `src/controls.ts`                 | controls manifest for `@repo/embed`                            |
| `src/playtest.ts`                 | `@vibedgames/playtest` diagnostics, hooks and manifest         |

### About the core

The game began as a single-player artifact ("Saltline") built as one minified
bundle with three.js inlined. `strikeforce-core.js` is that bundle de-minified
and formatted, with three.js swapped for the npm package — pinned to
`0.180.0`, the release it was written against, because it patches three's
shader chunks by exact text (soft shadows, the sea, the apron) and later
releases changed them. The mangled names are the bundler's; there was no
source to recover them from. The original's machine enemies no longer boot.

The file is excluded from lint and typecheck. Its only hand edits are the
match hooks, each marked `[net]` and called through `G.net` (`NetHooks` in
`src/core/types.ts`), plus the title copy. Keep new behaviour in TypeScript
behind those hooks rather than in the core.
