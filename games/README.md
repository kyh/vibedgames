# Games

Example games, built with the same `vg` CLI + skills a user's agent gets. They
are the platform's dogfood: every one is deployed at `{slug}.vibedgames.com`
and playable, and each has its own README with routes, options and controls.

| Game                               | Engine            | Multiplayer    | Dev                       | Live                            |
| ---------------------------------- | ----------------- | -------------- | ------------------------- | ------------------------------- |
| [Battle Arena](./battle-arena)     | Three.js          | online PvP     | `pnpm dev:battle-arena`   | `battle-arena.vibedgames.com`   |
| [Bomberman](./bomberman)           | Phaser 4          | shared room    | `pnpm dev:bomberman`      | `bomberman.vibedgames.com`      |
| [Crazy Waymo](./crazy-waymo)       | Three.js + Rapier | shared room    | `pnpm dev:crazy-waymo`    | `crazy-waymo.vibedgames.com`    |
| [Farm](./farm)                     | Phaser 4          | shared farm    | `pnpm dev:farm`           | `farm.vibedgames.com`           |
| [Flappy Dragons](./flappy-dragons) | Phaser 4          | shared room    | `pnpm dev:flappy-dragons` | `flappy-dragons.vibedgames.com` |
| [Lunerfall](./lunerfall)           | Phaser 4          | co-op + versus | `pnpm dev:lunerfall`      | `lunerfall.vibedgames.com`      |
| [Ancients of Eldermoor](./moba)    | Phaser 4          | online match   | `pnpm dev:moba`           | `moba.vibedgames.com`           |
| [Pacman](./pacman)                 | Three.js          | shared room    | `pnpm dev:pacman`         | `pacman.vibedgames.com`         |
| [Pong](./pong)                     | Three.js          | 1v1            | `pnpm dev:pong`           | `pong.vibedgames.com`           |
| [Starfall](./starfall)             | Phaser 4          | 32p arena      | `pnpm dev:starfall`       | `starfall.vibedgames.com`       |
| [Tetris](./tetris)                 | Three.js          | —              | `pnpm dev:tetris`         | `tetris.vibedgames.com`         |

Each `pnpm dev:<game>` serves on its own fixed port (see the game's README).
`pnpm dev` deliberately excludes games — run the one you're working on.

## Conventions

Every game is a standalone Vite app (`@repo/<name>`) — no platform code, only
the same packages any user's game can install:

- **`@vibedgames/multiplayer`** — host-authoritative rooms. Games degrade to
  solo/bot play when the party server is unreachable; that fallback is part of
  the game, not an error path.
- **`@vibedgames/gamepad`** — touch overlay + physical controllers. Every game
  ships a `src/controls.ts` manifest so the web app can render its controls.
- **`@repo/embed`** — postMessage bridge used when the game runs inside the web
  app's player chrome (`game-started`, pause/resume).

Shared query-param conventions, where a game implements them:

| Param        | What                                                                   |
| ------------ | ---------------------------------------------------------------------- |
| `?trailer=1` | scripted, self-driving gameplay trailer (`&loop=1` replays, Esc exits) |
| `?viewer=1`  | character / animation viewer                                           |
| `?gallery=…` | asset gallery                                                          |
| `?editor=1`  | map editor                                                             |
| `?offline=1` | never dial the party server                                            |

Games with a deterministic sim core also ship a headless harness under
`tools/` or `scripts/`, wired to `pnpm --filter @repo/<name> test` and picked
up by the repo-wide `pnpm test`.

## Deploying them

```sh
pnpm deploy:games   # builds every game + vg deploy each one
```

Platform workers deploy on push to `main` — never `wrangler deploy` locally.
