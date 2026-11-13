# Strikeforce

First-person shooter on a rain-soaked container dock at dusk, in three modes
picked on the title screen:

- **Deathmatch** (online, the default) — every player for themselves, up to
  sixteen, topped up with bots while the room is thin. A death lasts three seconds and comes back at the spawn farthest
  from the enemy; first to 25 kills, or the most after ten minutes.
- **Mission** (solo PvE) — the Harbormaster's crew hunts you while you
  cut three uplink relays, then reach the boat.
- **Holdout** (solo PvE) — endless, growing waves of the crew; resupply
  between waves.

Every surface, weapon and sound is generated in the browser; the one thing
downloaded is the soldier (`public/models/soldier.glb`, 566 KB). Deployed at
`strikeforce.vibedgames.com`.

## Develop

```bash
pnpm dev:strikeforce                        # http://localhost:5196
pnpm dev:party                              # the party server, for matches on localhost
pnpm --filter @repo/strikeforce typecheck   # tsc --noEmit
pnpm --filter @repo/strikeforce test        # unit tests: the deathmatch rules, wire narrowing, crew tuning, gait
pnpm --filter @repo/strikeforce test:online # two-client deathmatch smoke (needs dev:party)
pnpm --filter @repo/strikeforce build       # vite build
```

`test:online` drives two headless browsers through one room, with
`?norender=1` so software WebGL keeps up. Point it at a Chromium with
`SMOKE_BROWSER=/path/to/chromium` and at a running dev server with `--url`.

## Routes

| URL              | What                                                            |
| ---------------- | --------------------------------------------------------------- |
| `/`              | the game; quick-matches into the fullest open match             |
| `/?room=dock7`   | a private match: everyone with the same code plays together     |
| `/?offline=1`    | never dials the party server (you and the bots)                 |
| `/?bots=0`       | no bots (alone, warmup); `?bots=4` tops the dock up to four     |
| `/?mode=mission` | start in a mode: `deathmatch` (default), `mission` or `holdout` |
| `/?autostart=1`  | skip the title and deploy at once                               |
| `/?q=low`        | force a quality preset (`low` `medium` `high` `ultra`)          |
| `/?test=1`       | publish the playtest hooks and manifest                         |
| `/?bench=1`      | camera fly-through with a frame-time readout                    |
| `/?norender=1`   | simulate without drawing (the two-client smoke on software GL)  |

## Controls

| Input                                    | Action                     |
| ---------------------------------------- | -------------------------- |
| WASD (left stick, left thumb)            | move                       |
| mouse (right stick, right thumb, arrows) | look                       |
| left click (RT, Enter)                   | fire                       |
| right click (LT)                         | aim down sights            |
| R (X)                                    | reload                     |
| Q / 1 2 / wheel (Y)                      | swap rifle / sidearm       |
| hold E (hold X, USE)                     | cut a relay (Mission)      |
| Space (A)                                | jump                       |
| Shift (L-stick click)                    | sprint                     |
| C / Ctrl (B, LB)                         | crouch                     |
| F                                        | melee                      |
| hold Tab                                 | scoreboard                 |
| Esc / P (Start)                          | pause (the match plays on) |

`src/controls.ts` is the same list for the web app's controls panel.

## The dock

About 140 × 58 m. The original yard — container rows, the shed, the quay
and the boat — and, west of the old gate, the **West Lot**: a haul road down
the middle with freight cover across it, container rows with cut-throughs to
the north and south, fenced at x = -110. The old gate line keeps two runs of
fence with three passages (south end, the open gate, north end). The skyline
stacks and the crane that stood there moved out; everything in the lot is
real, collidable yard built with the level's own `stack`/`place` helpers
(`westLot` in the core).

## The match

`src/net/rules.ts` is the whole rulebook, pure and unit-tested. Anyone may
shoot anyone. A death comes back after 3 s, at the arena spawn (a walkable
grid over the whole dock) farthest from every enemy. First to 25 kills, or
the most kills when ten minutes run out, takes it; then ten seconds of
results and a fresh match on a full dock.

**Bots** (`src/net/bots.ts`): the host tops the dock up to six fighters, and
each player who deploys takes a bot's seat (`botSeats` in `rules.ts`), so a
lone player is in a live match at once and a full room has none. A bot is a
fighter in the rules roster like anyone, named `BOT-n`. The host thinks for
it — roam the nav grid towards somebody, engage whoever it sees, strafe,
fire bursts — and publishes its body under `bots`; every client turns that
into ordinary player reports, so bots are drawn and shot like people. They
are worse shots on purpose: late to react, slower fire, range falloff, 16 a
hit. A promoted host inherits them where they stood. With `?bots=0`, alone
the room sits in warmup.

Damage: the weapon's own numbers, ×4 to the head (a rifle headshot kills).
Everyone wears the same coyote kit and there are no name plates: you have to
find who you are fighting.

## Soldiers

Every computer-played fighter is a soldier: deathmatch bots and the crew in
Mission and Holdout alike.

- **Body** (`src/soldier/soldier-rig.ts`, `public/models/soldier.glb`): one
  skinned, textured mesh (22k triangles, a 1024² WebP atlas, 24 bones, eight
  clips), loaded once before boot; every soldier is a `SkeletonUtils.clone`
  sharing its geometry, materials and clips. The mesh is our own Meshy
  generation, rigged and animated through Meshy's API; `tools/build-soldier.mjs`
  packs what Meshy returned (clips renamed and played on the spot, the bake's
  pink sheen graded out of the atlas, meshopt). It was generated holding its
  carbine at the low ready and rigged in that pose, so carbine, arms and chest
  are one piece: the arms are never animated, and the muzzle is a point on the
  chest bone.
- **Kits** (`soldier-kit.ts`): the mesh wears black gear; a kit dyes its
  fatigues and helmet and paints an armband in the shader. `operator` (coyote,
  orange band; every deathmatch fighter) and `garrison` (urban grey, red band;
  the crew).
- **Movement on screen** (`soldier-model.ts`, `soldier-gait.ts`): a model is
  only ever told where it stands, so it reads its velocity off that. Walk, jog
  and sprint blend by speed over the ready stance, and the stride advances by
  distance covered, so feet do not slide. There are no sideways clips: a
  sidestep turns the hips towards the direction of travel (or away from it,
  on the backpedal clip) and the spine turns back. Standing, the feet stay
  planted until the body has turned ~50°, then step round. On aim the chest
  turns and lifts until the barrel — measured each frame, wherever the clips
  left it — points where the soldier looks, and the head comes back onto the
  target; at a run the carbine stays at the low ready. A shot kicks the
  chest, a hit plays the flinch and twists away from it, death plays a fall.
  Hitboxes (head, torso, legs) and the muzzle ride the bones. Animation thins
  with range (30 Hz past 28 m, 15 Hz past 55 m) and drops to 8 Hz off screen.
- **Brain** (`src/soldier/soldier-brain.ts`): sees 200° ahead to its range,
  patrols (pausing at the end of each leg), goes to look at what it heard,
  fights and goes hunting where it last saw you. It moves with weight: it
  speeds up and brakes at its gait's `accel`, eases into and out of turns,
  all but stops to turn round rather than slide sideways, cuts path corners it
  can see past, brakes into the end of a path, commits to a sidestep — or to
  standing still — for one to two and a half seconds, and slows to under a
  third of its pace to fire a burst. Late to react — later still when you
  catch it calm — and a worse shot with range, your movement and your crouch.
- **The crew** (`src/garrison/`): the core's enemies module, handed to it at
  boot (`CoreModules`), so the core's director still runs patrols, waves,
  pursuit, relays and Holdout scoring. It spawns two kinds by name, "gull"
  and "hound", and tunes them through `TUNE` by machine numbers: the crew
  fields a **rifleman** for a gull and a **heavy** for a hound, and reads the
  core's numbers as ratios over the machines' baseline (`roles.ts`), so
  difficulty and Holdout waves scale a soldier as they scaled a machine. A
  few fire at once (attack tokens); a hit or a death brings squadmates near
  it to look. A rifle headshot drops a rifleman on any difficulty; a heavy's
  helmet takes two.

**Radar** (`src/minimap.ts`, every mode): a round minimap, top-right (under
health on touch), that turns with you. The dock is baked once from the
level's walkable grid. An enemy's shot pings where it was fired from for
2.5 s, so firing gives you away; in Mission the relays still standing show,
pinned to the rim when out of range.

## Multiplayer

Deathmatch is online; Mission and Holdout are the original single-player
game. A tab joins a room only when it deploys into deathmatch, from the
`strikeforce` lobby, so solo PvE never touches a room.

Every fighter has a `life` that goes up whenever the host brings it back (a
match start, a respawn). A client places its body when the life it reads
moves, and its own health reports count only for the life it is playing, so a
report sent before a respawn arrived can never kill the new life.

Host-authoritative on `@vibedgames/multiplayer`. The first player in the room
is the host and runs the rules; it publishes the match (phase, clock, kills,
who is alive, which barrels stand) at 10 Hz. Every client plays its own body,
publishes it at 20 Hz, and follows the published match: it respawns itself
whenever its fighter gets a new life.

- **Hits favour the shooter.** A client tests its shots against the other
  players' hitboxes (head and body) as they stand on its own screen, then
  tells the host, which applies the damage and sends the victim a `hurt`.
- **Area damage** (barrels) each client applies to itself and reports through
  its body's health; the host only ever lowers health from a report, and only
  for the current life.
- **Barrels** belong to the host: a guest's shot is a request, the blast comes
  back to everyone. Every match starts with all of them standing.
- **Host loss.** The server elects a new host, which picks the match up from
  the last state it read.

Wire format: `src/net/protocol.ts`. A wire change bumps `ROOM_PREFIX`.

## Layout

| Path                           | What                                                           |
| ------------------------------ | -------------------------------------------------------------- |
| `src/core/strikeforce-core.js` | the game: renderer, dock, weapons, audio, HUD, menus           |
| `src/core/types.ts`            | the typed slice of the game object the TypeScript layer drives |
| `src/net/rules.ts`             | the deathmatch rules (host)                                    |
| `src/net/match.ts`             | the match controller: `G.net`, host and client                 |
| `src/net/bots.ts`              | bots: the host's brains, and their bodies as player reports    |
| `src/net/players.ts`           | other players: interpolation, avatars, hitboxes                |
| `src/soldier/`                 | the soldier rig, kits, gait, model, brain and tracer           |
| `tools/build-soldier.mjs`      | packs Meshy's rig and clips into `public/models/soldier.glb`   |
| `src/garrison/`                | the crew in Mission and Holdout: the core's enemies module     |
| `src/net/map.ts`               | arena spawns on the dock                                       |
| `src/net/match-hud.ts`         | kills bar, match clock, Tab scoreboard                         |
| `src/minimap.ts`               | the radar                                                      |
| `src/controls.ts`              | controls manifest for `@repo/embed`                            |
| `src/playtest.ts`              | `@vibedgames/playtest` diagnostics, hooks and manifest         |

### About the core

The game began as a single-player artifact ("Saltline") built as one minified
bundle with three.js inlined. `strikeforce-core.js` is that bundle de-minified
and formatted, with three.js swapped for the npm package — pinned to
`0.180.0`, the release it was written against, because it patches three's
shader chunks by exact text (soft shadows, the sea, the apron) and later
releases changed them. The mangled names are the bundler's; there was no
source to recover them from. Its machine enemies (`W5`) remain only for the
`?show` gallery; the game boots the garrison in their place.

The file is excluded from lint and typecheck. Its only hand edits are the
match hooks, each marked `[net]` and called through `G.net` (`NetHooks` in
`src/core/types.ts`); the soldier hooks, marked `[soldiers]` (the boot
takes `CoreModules`; its audio and kill feed treat an enemy with `soldier`
set as a person); and the title and mission copy. Keep new behaviour in TypeScript
behind those hooks rather than in the core.
