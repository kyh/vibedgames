# Saltline

Rain-soaked first-person shooter on a container terminal at dusk: cut the
security net's three uplink relays, then reach the boat — or hold the berth
against endless waves. Every surface, machine and sound is generated in the
browser; nothing is downloaded. Up to four players share a run in co-op.
Deployed at `saltline.vibedgames.com`.

## Develop

```bash
pnpm dev:saltline                        # http://localhost:5196
pnpm dev:party                           # the party server, for co-op on localhost
pnpm --filter @repo/saltline typecheck   # tsc --noEmit
pnpm --filter @repo/saltline test        # unit tests (wire, squad, puppet poses)
pnpm --filter @repo/saltline test:online # two-client co-op smoke (needs dev:party)
pnpm --filter @repo/saltline build       # vite build
```

`test:online` drives two headless browsers through one room. With only
software WebGL it is slow (minutes); point it at a Chromium with
`SMOKE_BROWSER=/path/to/chromium` and at a running dev server with `--url`.

## Routes

| URL              | What                                                           |
| ---------------- | -------------------------------------------------------------- |
| `/`              | the game; quick-matches into an open public squad              |
| `/?room=dock7`   | a private squad: everyone with the same code plays together    |
| `/?offline=1`    | solo, never dials the party server                             |
| `/?mode=holdout` | start in holdout (waves) instead of the mission                |
| `/?autostart=1`  | skip the title and deploy at once                              |
| `/?q=low`        | force a quality preset (`low` `medium` `high` `ultra`)         |
| `/?test=1`       | publish the playtest hooks and manifest                        |
| `/?bench=1`      | camera fly-through with a frame-time readout                   |
| `/?norender=1`   | simulate without drawing (the two-client smoke on software GL) |

## Controls

| Input                                    | Action               |
| ---------------------------------------- | -------------------- |
| WASD (left stick, left thumb)            | move                 |
| mouse (right stick, right thumb, arrows) | look                 |
| left click (RT, Enter)                   | fire                 |
| right click (LT)                         | aim down sights      |
| R (X)                                    | reload               |
| Q / 1 2 / wheel (Y)                      | swap rifle / sidearm |
| hold E (hold X)                          | cut a relay          |
| Space (A)                                | jump                 |
| Shift (L-stick click)                    | sprint               |
| C / Ctrl (B, LB)                         | crouch               |
| F                                        | melee                |
| Esc / P (Start)                          | pause                |

`src/controls.ts` is the same list for the web app's controls panel.

## Co-op

The first player in a room is the host and runs the original game: the
machines, relays, waves and barrels. It publishes that world at 15 Hz (enemy
poses, run state, which barrels stand) and the machines hunt every squad
member, not just the host. Guests run only their own body and weapon; the
machines on their screen are puppets posed from the host's snapshots, and their
hits, relay cuts and barrel shots are requests the host applies. The host's
hits on a guest arrive as `hurt` events the guest applies to itself. Each
client applies explosion damage to its own body; only the host applies it to
the machines.

- A guest who deploys joins the host's run in the host's mode; one who dies
  respawns into it. A host who dies while the squad is still out respawns too,
  instead of resetting the run for everyone.
- When the host leaves, the server elects a new one and its puppets become real
  machines where they stand. Relays already cut stay cut.
- No party server within six seconds → solo, the original game.

Wire format: `src/net/protocol.ts`. A wire change bumps `ROOM_PREFIX`.

## Layout

| Path                        | What                                                                 |
| --------------------------- | -------------------------------------------------------------------- |
| `src/core/saltline-core.js` | the game: renderer, world, weapons, machines, audio, HUD, menus      |
| `src/core/types.ts`         | the typed slice of the game object the TypeScript layer drives       |
| `src/net/`                  | co-op: session, protocol, host/guest controller, squad, puppets, HUD |
| `src/controls.ts`           | controls manifest for `@repo/embed`                                  |
| `src/playtest.ts`           | `@vibedgames/playtest` diagnostics, hooks and manifest               |

### About the core

Saltline began as a single-file artifact: one minified bundle with three.js
inlined. `saltline-core.js` is that bundle de-minified and formatted, with
three.js swapped for the npm package — pinned to `0.180.0`, the release the
game was written against, because it patches three's shader chunks by exact
text (soft shadows, the sea, the apron) and later releases changed them. The
mangled names are the bundler's; there was no source to recover them from.

The file is excluded from lint and typecheck. Its only hand edits are the
co-op hooks, each marked `[net]` and called through `G.net` (`NetHooks` in
`src/core/types.ts`). Keep new behaviour in TypeScript behind those hooks
rather than in the core.
